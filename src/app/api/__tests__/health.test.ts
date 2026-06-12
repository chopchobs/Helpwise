/**
 * src/app/api/__tests__/health.test.ts
 * Integration tests สำหรับ GET /api/health (Phase 19)
 *
 * Invariants:
 *   - DB + Redis ok → 200 {data:{status:"ok", checks:{db:"ok", redis:"ok"}}}
 *   - DB down → 503 + checks.db==="error"
 *   - Redis down/timeout → 503 + checks.redis==="error"
 *   - ทั้งคู่ down → 503; ห้าม leak error detail (connection string ฯลฯ) ใน response
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { queryRawMock, pingMock } = vi.hoisted(() => ({
  queryRawMock: vi.fn(),
  pingMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $queryRaw: (...args: unknown[]) => queryRawMock(...args) },
}));

vi.mock("@/lib/redis", () => ({
  redis: { ping: (...args: unknown[]) => pingMock(...args) },
}));

import { GET } from "@/app/api/health/route";

beforeEach(() => {
  vi.clearAllMocks();
  queryRawMock.mockResolvedValue([{ "?column?": 1 }]);
  pingMock.mockResolvedValue("PONG");
});

describe("GET /api/health", () => {
  it("DB + Redis ok → 200 {data:{status:ok, checks:{db:ok, redis:ok}}}", async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      data: { status: "ok", checks: { db: "ok", redis: "ok" } },
      error: null,
    });
  });

  it("DB $queryRaw reject → 503 + checks.db===error, redis ok", async () => {
    queryRawMock.mockRejectedValue(new Error("connection to postgres://user:pass@host failed"));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.data.status).toBe("error");
    expect(body.data.checks).toEqual({ db: "error", redis: "ok" });
  });

  it("Redis ping reject → 503 + checks.redis===error, db ok", async () => {
    pingMock.mockRejectedValue(new Error("redis connection refused at redis://secret@host"));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.data.checks).toEqual({ db: "ok", redis: "error" });
  });

  it("ทั้งคู่ down → 503 และไม่ leak error detail ใน response", async () => {
    queryRawMock.mockRejectedValue(new Error("postgresql://admin:s3cr3t@db.internal:5432/prod"));
    pingMock.mockRejectedValue(new Error("redis://default:s3cr3t@redis.internal:6379"));

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.data.checks).toEqual({ db: "error", redis: "error" });
    expect(body.error).toBe("dependency check failed");

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("s3cr3t");
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("redis://");
  });
});
