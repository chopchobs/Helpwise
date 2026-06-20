/**
 * src/lib/__tests__/rate-limit.test.ts
 * Unit tests สำหรับ rate-limit.ts (Phase 13)
 *
 * Invariants:
 *   - checkRateLimit: allowed เมื่อ count<=limit, blocked เมื่อ count>limit (+retryAfter)
 *   - fail-open: redis throw → allowed=true
 *   - TTL ตั้งผ่าน expire(key, windowSeconds, "NX") ใน multi
 *   - getClientIp: x-forwarded-for เอาตัวแรก, fallback x-real-ip, "unknown"
 *   - rateLimitResponse: 429 + Retry-After header + {data:null,error:{code:"RATE_LIMITED"}}
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { redisMock } = vi.hoisted(() => {
  const incr = vi.fn();
  const expire = vi.fn();
  const exec = vi.fn();
  const ttl = vi.fn();
  const multi = vi.fn(() => ({ incr, expire, exec }));
  return { redisMock: { multi, incr, expire, exec, ttl } };
});

vi.mock("@/lib/redis", () => ({
  redis: redisMock,
}));

import {
  checkRateLimit,
  getClientIp,
  rateLimitKey,
  rateLimitResponse,
} from "@/lib/rate-limit";

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.incr.mockReturnThis();
  redisMock.expire.mockReturnThis();
});

describe("checkRateLimit", () => {
  it("count <= limit → allowed=true, remaining = limit - count", async () => {
    redisMock.exec.mockResolvedValue([
      [null, 5],
      [null, 1],
    ]);

    const result = await checkRateLimit({ key: "k", limit: 10, windowSeconds: 60 });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5);
    expect(result.retryAfterSeconds).toBe(0);
  });

  it("count == limit → ยัง allowed (boundary)", async () => {
    redisMock.exec.mockResolvedValue([
      [null, 10],
      [null, 1],
    ]);

    const result = await checkRateLimit({ key: "k", limit: 10, windowSeconds: 60 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("count > limit → allowed=false, retryAfterSeconds จาก ttl", async () => {
    redisMock.exec.mockResolvedValue([
      [null, 11],
      [null, 0],
    ]);
    redisMock.ttl.mockResolvedValue(45);

    const result = await checkRateLimit({ key: "k", limit: 10, windowSeconds: 60 });

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterSeconds).toBe(45);
  });

  it("count > limit แต่ ttl = -1 (no expire) → fallback retryAfterSeconds = windowSeconds", async () => {
    redisMock.exec.mockResolvedValue([
      [null, 11],
      [null, 0],
    ]);
    redisMock.ttl.mockResolvedValue(-1);

    const result = await checkRateLimit({ key: "k", limit: 10, windowSeconds: 60 });
    expect(result.retryAfterSeconds).toBe(60);
  });

  it("count > limit แต่ ttl = -2 (key หาย) → fallback retryAfterSeconds = windowSeconds", async () => {
    redisMock.exec.mockResolvedValue([
      [null, 11],
      [null, 0],
    ]);
    redisMock.ttl.mockResolvedValue(-2);

    const result = await checkRateLimit({ key: "k", limit: 10, windowSeconds: 60 });
    expect(result.retryAfterSeconds).toBe(60);
  });

  it("redis multi().exec() throw → fail-open (allowed=true, remaining=limit)", async () => {
    redisMock.exec.mockRejectedValue(new Error("redis down"));

    const result = await checkRateLimit({ key: "k", limit: 10, windowSeconds: 60 });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(10);
    expect(result.retryAfterSeconds).toBe(0);
  });

  it("redis exec คืน null → fail-open", async () => {
    redisMock.exec.mockResolvedValue(null);

    const result = await checkRateLimit({ key: "k", limit: 10, windowSeconds: 60 });
    expect(result.allowed).toBe(true);
  });

  it("redis throw + failClosed:true → fail-closed (allowed=false, retryAfter=windowSeconds)", async () => {
    redisMock.exec.mockRejectedValue(new Error("redis down"));

    const result = await checkRateLimit({
      key: "k",
      limit: 10,
      windowSeconds: 60,
      failClosed: true,
    });

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterSeconds).toBe(60);
  });

  it("redis throw + failClosed:false (explicit) → fail-open เหมือนเดิม", async () => {
    redisMock.exec.mockRejectedValue(new Error("redis down"));

    const result = await checkRateLimit({
      key: "k",
      limit: 10,
      windowSeconds: 60,
      failClosed: false,
    });

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(10);
  });

  it("redis exec คืน [[err,...],...] (incr error) → fail-open", async () => {
    redisMock.exec.mockResolvedValue([
      [new Error("incr failed"), null],
      [null, 1],
    ]);

    const result = await checkRateLimit({ key: "k", limit: 10, windowSeconds: 60 });
    expect(result.allowed).toBe(true);
  });

  it("ตั้ง TTL ผ่าน expire(key, windowSeconds, 'NX') ใน multi chain", async () => {
    redisMock.exec.mockResolvedValue([
      [null, 1],
      [null, 1],
    ]);

    await checkRateLimit({ key: "ratelimit:test:abc", limit: 10, windowSeconds: 60 });

    expect(redisMock.incr).toHaveBeenCalledWith("ratelimit:test:abc");
    expect(redisMock.expire).toHaveBeenCalledWith("ratelimit:test:abc", 60, "NX");
  });
});

describe("rateLimitKey", () => {
  it("สร้าง key รูปแบบ ratelimit:{scope}:{identifier}", () => {
    expect(rateLimitKey("api-v1", "key-123")).toBe("ratelimit:api-v1:key-123");
  });
});

describe("getClientIp", () => {
  it("x-forwarded-for เดี่ยว → คืน IP นั้น", () => {
    const req = new Request("https://x.com", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(getClientIp(req)).toBe("1.2.3.4");
  });

  it("x-forwarded-for หลาย IP คั่น comma → เอาตัวแรก (trim whitespace)", () => {
    const req = new Request("https://x.com", {
      headers: { "x-forwarded-for": "1.2.3.4,  5.6.7.8" },
    });
    expect(getClientIp(req)).toBe("1.2.3.4");
  });

  it("ไม่มี x-forwarded-for → fallback x-real-ip", () => {
    const req = new Request("https://x.com", {
      headers: { "x-real-ip": "9.8.7.6" },
    });
    expect(getClientIp(req)).toBe("9.8.7.6");
  });

  it("ไม่มี header ใดเลย → 'unknown'", () => {
    const req = new Request("https://x.com");
    expect(getClientIp(req)).toBe("unknown");
  });

  it("x-forwarded-for เป็น string ว่าง → fallback ไป x-real-ip", () => {
    const req = new Request("https://x.com", {
      headers: { "x-forwarded-for": "", "x-real-ip": "9.8.7.6" },
    });
    expect(getClientIp(req)).toBe("9.8.7.6");
  });
});

describe("rateLimitResponse", () => {
  it("status 429 + Retry-After header + body shape", async () => {
    const res = rateLimitResponse(30);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");

    const json = await res.json();
    expect(json).toEqual({
      data: null,
      error: {
        code: "RATE_LIMITED",
        message: expect.any(String),
      },
    });
  });
});
