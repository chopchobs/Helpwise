/**
 * src/app/api/__tests__/demo-login.test.ts
 * Integration tests สำหรับ POST /api/auth/demo/login (Phase 30 Slice D)
 *
 * P0 invariants:
 *   - demo guard: tenant ที่ slug ไม่ใช่ demo → 404 (ไม่ login, ไม่ออก token)
 *   - role guard (defense-in-depth): member.role !== AGENT → 403 (ไม่ออก token/cookie)
 *   - happy: demo tenant + role AGENT → 200 + setCookie + audit(demo:true) + ไม่ leak token/password
 *   - ไม่รับ tenantId/credentials จาก client (ดึงจาก context + src/lib/demo)
 *   - rate-limit เกิน → 429
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { DEFAULT_TENANT_ID } from "@/app/api/__tests__/_helpers";

const {
  fakeDb,
  prismaMock,
  getTenantContextMock,
  verifyPasswordMock,
  issueAgentTokenMock,
  setAgentCookieMock,
  auditLogMock,
  checkRateLimitMock,
} = vi.hoisted(() => {
  const fakeDb = {
    tenantMember: { findFirst: vi.fn() },
  };
  return {
    fakeDb,
    prismaMock: {
      tenant: { findUnique: vi.fn() },
      user: { findUnique: vi.fn() },
    },
    getTenantContextMock: vi.fn(),
    verifyPasswordMock: vi.fn(),
    issueAgentTokenMock: vi.fn(),
    setAgentCookieMock: vi.fn(),
    auditLogMock: vi.fn(),
    checkRateLimitMock: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("@/lib/tenant", () => ({
  getTenantContext: (...args: unknown[]) => getTenantContextMock(...args),
  tenantPrisma: () => fakeDb,
}));

vi.mock("@/lib/password", () => ({
  verifyPassword: (...args: unknown[]) => verifyPasswordMock(...args),
}));

vi.mock("@/lib/auth", () => ({
  issueAgentToken: (...args: unknown[]) => issueAgentTokenMock(...args),
  setAgentCookie: (...args: unknown[]) => setAgentCookieMock(...args),
  toAuthErrorResponse: () => ({ error: { code: "INTERNAL", message: "err" }, status: 500 }),
}));

vi.mock("@/lib/audit", () => ({
  audit: { log: (...args: unknown[]) => auditLogMock(...args) },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  getClientIp: () => "1.2.3.4",
  rateLimitKey: (scope: string, id: string) => `ratelimit:${scope}:${id}`,
  rateLimitResponse: (retryAfterSeconds: number) =>
    NextResponse.json(
      { data: null, error: { code: "RATE_LIMITED", message: "คำขอบ่อยเกินไป" } },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
    ),
}));

// ใช้ค่าจริงจาก src/lib/demo (single source of truth — acme/globex)
vi.mock("@/lib/demo", () => ({
  DEMO_TENANT_SLUGS: ["acme", "globex"],
  DEMO_PASSWORD: "demo-helpwise-2026",
  DEMO_AGENTS: [
    { tenantSlug: "acme", email: "demo@acme.helpwise.com", password: "demo-helpwise-2026", name: "Demo Agent" },
    { tenantSlug: "globex", email: "demo@globex.helpwise.com", password: "demo-helpwise-2026", name: "Demo Agent" },
  ],
}));

import { POST as demoLogin } from "@/app/api/auth/demo/login/route";

function makeReq() {
  return new Request("https://acme.helpwise.com/api/auth/demo/login", { method: "POST" });
}

const DEMO_USER = {
  id: "user-demo",
  email: "demo@acme.helpwise.com",
  name: "Demo Agent",
  passwordHash: "$2a$12$hash",
  isActive: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  getTenantContextMock.mockResolvedValue({ tenantId: DEFAULT_TENANT_ID, plan: "pro" });
  checkRateLimitMock.mockResolvedValue({ allowed: true, remaining: 9, retryAfterSeconds: 0 });
  prismaMock.tenant.findUnique.mockResolvedValue({ slug: "acme" });
  prismaMock.user.findUnique.mockResolvedValue(DEMO_USER);
  verifyPasswordMock.mockResolvedValue(true);
  fakeDb.tenantMember.findFirst.mockResolvedValue({ id: "member-demo", role: "AGENT" });
  issueAgentTokenMock.mockResolvedValue("jwt-token-xyz");
  setAgentCookieMock.mockResolvedValue(undefined);
});

describe("POST /api/auth/demo/login", () => {
  it("(ก) tenant ไม่ใช่ demo (slug=realcorp) → 404, ไม่ login/ออก token", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue({ slug: "realcorp" });

    const res = await demoLogin(makeReq());
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
    expect(issueAgentTokenMock).not.toHaveBeenCalled();
    expect(setAgentCookieMock).not.toHaveBeenCalled();
  });

  it("(ก2) tenant ไม่พบ → 404", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue(null);

    const res = await demoLogin(makeReq());
    expect(res.status).toBe(404);
    expect(issueAgentTokenMock).not.toHaveBeenCalled();
  });

  it("(ข) defense-in-depth: member.role !== AGENT → 403, ไม่ออก token/cookie", async () => {
    fakeDb.tenantMember.findFirst.mockResolvedValue({ id: "member-demo", role: "OWNER" });

    const res = await demoLogin(makeReq());
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe("DEMO_LOGIN_FAILED");
    expect(issueAgentTokenMock).not.toHaveBeenCalled();
    expect(setAgentCookieMock).not.toHaveBeenCalled();
    expect(auditLogMock).not.toHaveBeenCalled();
  });

  it("(ค) happy path → 200 + token/cookie + audit(demo:true), role=AGENT", async () => {
    const res = await demoLogin(makeReq());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({
      user: { id: "user-demo", email: "demo@acme.helpwise.com", name: "Demo Agent" },
      role: "AGENT",
    });
    expect(json.error).toBeNull();

    expect(issueAgentTokenMock).toHaveBeenCalledWith("user-demo");
    expect(setAgentCookieMock).toHaveBeenCalledWith("jwt-token-xyz");

    // membership query ผ่าน tenantPrisma (tenant-scoped) — ไม่รับ tenantId จาก client
    expect(fakeDb.tenantMember.findFirst).toHaveBeenCalled();

    // audit ต้องมี demo:true + ไม่ leak token/password
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agent.login",
        tenantId: DEFAULT_TENANT_ID,
        metadata: expect.objectContaining({ demo: true, role: "AGENT" }),
      })
    );
    const auditArg = JSON.stringify(auditLogMock.mock.calls[0][0]);
    expect(auditArg).not.toContain("jwt-token-xyz");
    expect(auditArg).not.toContain("demo-helpwise-2026");
  });

  it("(ง) password ผิด / user inactive → 503 (ไม่ leak), ไม่ออก token", async () => {
    verifyPasswordMock.mockResolvedValue(false);

    const res = await demoLogin(makeReq());
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(json.error.code).toBe("DEMO_LOGIN_FAILED");
    expect(issueAgentTokenMock).not.toHaveBeenCalled();
  });

  it("(จ) ยังไม่ seed (user ไม่พบ) → 503, ไม่ออก token", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    const res = await demoLogin(makeReq());
    expect(res.status).toBe(503);
    expect(issueAgentTokenMock).not.toHaveBeenCalled();
  });

  it("(ฉ) rate-limit เกิน → 429, ไม่แตะ tenant lookup/login", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 60 });

    const res = await demoLogin(makeReq());
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(prismaMock.tenant.findUnique).not.toHaveBeenCalled();
    expect(issueAgentTokenMock).not.toHaveBeenCalled();
  });
});
