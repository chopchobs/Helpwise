/**
 * src/lib/api-auth.ts
 * Auth guard สำหรับ public REST API (/api/v1/...) — ใช้ API key แทน session cookie
 *
 * ⚠️ CRITICAL SECURITY:
 *   - tenantId มาจาก getTenantContext() (proxy header) เท่านั้น — ไม่ใช่จาก key
 *   - tenantPrisma scope ทำให้ key ของ tenant อื่นหา "ไม่เจอ" (ป้องกัน cross-tenant key)
 *   - feature gate "api_access" ต้องผ่านก่อนเช็ค key
 */

import { tenantPrisma, getTenantContext, type TenantContext } from "@/lib/tenant";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import { hashApiKey } from "@/lib/api-key";
import { AuthError } from "@/lib/auth";
import { checkRateLimit, rateLimitKey, getClientIp } from "@/lib/rate-limit";
import type { ApiKey } from "@prisma/client";

export interface ApiKeySession {
  apiKey: ApiKey;
  ctx: TenantContext;
}

/**
 * ตรวจสอบ request ที่เรียก public API ด้วย API key
 *
 * Pipeline:
 *   1. ดึง tenant context จาก proxy header (source of truth)
 *   2. อ่าน Authorization: Bearer <key>
 *   3. pre-auth rate-limit ตาม IP — กัน flood ด้วย token ปลอมก่อนแตะ DB/Redis
 *   4. hash key แล้วหา ApiKey record ที่ active ของ tenant นี้ (ก่อน feature gate)
 *   5. feature gate api_access ตาม plan (หลัง verify key — ไม่ reveal plan ให้ caller ที่ไม่มี key)
 *   6. update lastUsedAt แบบ fire-and-forget (ไม่ block request)
 *
 * @throws AuthError(401) ถ้าไม่มี/ผิดรูป header หรือ key ไม่ valid/ถูก revoke
 * @throws AuthError(403) ถ้า plan ปัจจุบันไม่มี feature api_access
 * @throws AuthError(429) ถ้ายิงเกิน pre-auth rate-limit ต่อ IP
 */
export async function requireApiKey(request: Request): Promise<ApiKeySession> {
  // 1. tenant context จาก proxy header — ห้ามรับจาก client
  const ctx = await getTenantContext();

  // 2. อ่าน Authorization header
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AuthError("API key required", 401);
  }
  const key = authHeader.slice("Bearer ".length).trim();
  if (!key) {
    throw new AuthError("API key required", 401);
  }

  // 3. pre-auth rate-limit ตาม IP — per-key limit ใน route คิดได้หลัง lookup สำเร็จเท่านั้น
  //    ชั้นนี้กัน unauthenticated flood (token ปลอม) ไม่ให้ทุบ hasFeature()/DB lookup แบบไม่จำกัด
  const preAuthRl = await checkRateLimit({
    key: rateLimitKey("api-v1-auth", getClientIp(request)),
    limit: 100,
    windowSeconds: 60,
  });
  if (!preAuthRl.allowed) {
    throw new AuthError("คำขอบ่อยเกินไป กรุณาลองใหม่ภายหลัง", 429);
  }

  // 4. หา ApiKey record ก่อน feature gate — key ไม่ valid → 401 เสมอ (ไม่ reveal plan/feature)
  //    explicit tenantId ใน where เป็น defense-in-depth จุด auth-critical
  //    (ไม่พึ่ง tenantPrisma extension อย่างเดียว — กัน cross-tenant key ถ้า extension regress)
  const keyHash = hashApiKey(key);
  const db = tenantPrisma(ctx.tenantId);
  const apiKey = await db.apiKey.findFirst({
    where: { tenantId: ctx.tenantId, keyHash, revokedAt: null },
  });

  if (!apiKey) {
    throw new AuthError("Invalid or revoked API key", 401);
  }

  // 5. feature gate — ต้องอยู่ใน plan ที่มี api_access (หลัง verify key แล้ว)
  const enabled = await hasFeature(ctx.tenantId, FEATURE_KEYS.API_ACCESS, ctx.plan);
  if (!enabled) {
    throw new AuthError("API access not included in current plan", 403);
  }

  // 6. อัปเดต lastUsedAt แบบ fire-and-forget — error ไม่ควร kill request
  void db.apiKey
    .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    .catch((err) => {
      console.error(
        "[api-auth] Failed to update lastUsedAt:",
        err instanceof Error ? err.message : String(err)
      );
    });

  return { apiKey, ctx };
}
