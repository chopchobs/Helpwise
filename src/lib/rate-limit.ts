/**
 * src/lib/rate-limit.ts
 * Fixed-window rate limiter ด้วย Redis (INCR + EXPIRE)
 *
 * ⚠️ FAIL-OPEN: ถ้า Redis throw/down → allowed: true เสมอ (rate-limit ไม่ใช่
 * correctness-critical, ไม่ควร lock ผู้ใช้ออกจากระบบเมื่อ Redis ล่ม)
 */

import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";

// =============================================================================
// TYPES
// =============================================================================

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface CheckRateLimitOptions {
  /** redis key เต็ม (ใช้ rateLimitKey() เพื่อสร้าง) */
  key: string;
  /** จำนวนครั้งสูงสุดต่อ window */
  limit: number;
  /** ความยาว window เป็นวินาที */
  windowSeconds: number;
  /**
   * เมื่อ Redis ล่ม จะ deny (true) หรือ allow (false) — default false (fail-open เดิม)
   * ตั้ง true สำหรับ endpoint ที่มี cost จริงต่อ request (เช่น AI call) เพื่อกัน
   * unbounded cost abuse ตอน Redis ล่มแล้ว rate-limit หายไป
   */
  failClosed?: boolean;
}

// =============================================================================
// CORE
// =============================================================================

/**
 * fixed-window rate limit ด้วย atomic INCR
 * ตั้ง TTL เฉพาะตอนนับครั้งแรก (count === 1) เพื่อกัน race ที่ทำให้ key ไม่มี TTL เลย
 */
export async function checkRateLimit(
  opts: CheckRateLimitOptions
): Promise<RateLimitResult> {
  const { key, limit, windowSeconds, failClosed = false } = opts;

  try {
    // atomic INCR + EXPIRE ใน MULTI/EXEC เดียว — กัน race ที่ incr สำเร็จแต่ expire fail
    // แล้ว key ค้างถาวรไม่มี TTL (window ไม่ reset → user โดน block ตลอด)
    // EXPIRE ... NX ตั้ง TTL เฉพาะตอน key ยังไม่มี TTL (ครั้งแรก หรือ recover ถ้าเคย fail)
    const results = await redis
      .multi()
      .incr(key)
      .expire(key, windowSeconds, "NX")
      .exec();

    // results = [[err, count], [err, 0|1]] — ถ้า null หรือ incr error → fail-open ผ่าน catch
    if (!results || results[0]?.[0]) {
      throw results?.[0]?.[0] ?? new Error("redis multi returned null");
    }
    const count = Number(results[0][1]);

    if (count > limit) {
      // ดึง TTL ปัจจุบันเพื่อบอก client ว่าต้องรอกี่วินาที
      // TTL=-1 (ไม่มี expire) / -2 (key หาย) → fallback เป็น windowSeconds เต็ม (defensive)
      const ttl = await redis.ttl(key);
      const retryAfterSeconds = ttl > 0 ? ttl : windowSeconds;
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    return {
      allowed: true,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds: 0,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (failClosed) {
      // FAIL-CLOSED: Redis ล่ม → deny เพื่อกัน cost abuse (endpoint ที่มี cost จริงต่อ request)
      console.error("[rate-limit] Redis error (fail-closed, denying):", errMsg);
      return { allowed: false, remaining: 0, retryAfterSeconds: windowSeconds };
    }
    // FAIL-OPEN (default): Redis ล่ม → ปล่อยผ่าน ไม่ block ผู้ใช้
    console.error("[rate-limit] Redis error (fail-open):", errMsg);
    return { allowed: true, remaining: limit, retryAfterSeconds: 0 };
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/** สร้าง redis key สำหรับ rate limit: ratelimit:{scope}:{identifier} */
export function rateLimitKey(scope: string, identifier: string): string {
  return `ratelimit:${scope}:${identifier}`;
}

/**
 * อ่าน client IP จาก header
 * x-forwarded-for อาจมีหลาย IP คั่นด้วย comma — เอาตัวแรก (client จริง)
 * fallback x-real-ip → "unknown"
 *
 * ⚠️ assumption: รันหลัง trusted edge/proxy (เช่น Vercel) ที่ "เขียนทับ" x-forwarded-for
 *    จาก client เสมอ. ถ้า self-host ต้อง strip/overwrite header นี้ที่ proxy layer
 *    มิฉะนั้น client ปลอม IP เพื่อ bypass IP-keyed rate-limit ได้ (กระทบแค่ rate-limit
 *    ไม่ใช่ authz — login ยังมี generic error + password hash cost + audit log ป้องกันอยู่)
 */
export function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  return "unknown";
}

/** สร้าง 429 response มาตรฐาน { data: null, error } + Retry-After header */
export function rateLimitResponse(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    {
      data: null,
      error: {
        code: "RATE_LIMITED",
        message: "คำขอบ่อยเกินไป กรุณาลองใหม่ภายหลัง",
      },
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSeconds),
      },
    }
  );
}
