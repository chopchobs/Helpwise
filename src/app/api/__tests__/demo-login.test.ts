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

// ไม่ mock @/lib/demo — ใช้ค่าจริงจาก single source of truth (persona acme/globex)

import { POST as demoLogin } from "@/app/api/auth/demo/login/route";

// body = undefined → POST โดยไม่มี body เลย (เคสเดิมของ demo page — ต้องเป็น primary)
function makeReq(body?: unknown) {
  return new Request("https://acme.helpwise.com/api/auth/demo/login", {
    method: "POST",
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
}

const DEMO_USER = {
  id: "user-demo",
  email: "demo@acme.helpwise.com",
  name: "Demo Agent",
  passwordHash: "$2a$12$hash",
  isActive: true,
};

// persona secondary ของแต่ละ tenant (ค่าตรงกับ src/lib/demo-personas.ts)
const ALEX_USER = {
  id: "user-alex",
  email: "alex@acme.helpwise.com",
  name: "Alex Rivera",
  passwordHash: "$2a$12$random-nobody-knows",
  isActive: true,
};
const DANA_USER = {
  id: "user-dana",
  email: "dana@globex.helpwise.com",
  name: "Dana Wu",
  passwordHash: "$2a$12$random-nobody-knows",
  isActive: true,
};

// จำลอง DB: หา User ตาม email (persona resolve → email → user)
function mockUsersByEmail(users: Array<typeof DEMO_USER>) {
  prismaMock.user.findUnique.mockImplementation(
    (args: { where: { email: string } }) => users.find((u) => u.email === args.where.email) ?? null
  );
}

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
        metadata: expect.objectContaining({ demo: true, persona: "primary", role: "AGENT" }),
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

  it("(ช) body ว่าง {} (ไม่ส่ง persona) → login เป็น primary", async () => {
    mockUsersByEmail([DEMO_USER, ALEX_USER]);

    const res = await demoLogin(makeReq({}));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.user.email).toBe("demo@acme.helpwise.com");
    expect(verifyPasswordMock).toHaveBeenCalled();
  });

  it("(ซ) persona=secondary บน acme → 200 เป็น Alex, ข้าม verifyPassword แต่ด่านอื่นครบ", async () => {
    mockUsersByEmail([DEMO_USER, ALEX_USER]);

    const res = await demoLogin(makeReq({ persona: "secondary" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({
      user: { id: "user-alex", email: "alex@acme.helpwise.com", name: "Alex Rivera" },
      role: "AGENT",
    });
    expect(verifyPasswordMock).not.toHaveBeenCalled();
    expect(fakeDb.tenantMember.findFirst).toHaveBeenCalled();
    expect(issueAgentTokenMock).toHaveBeenCalledWith("user-alex");
    expect(setAgentCookieMock).toHaveBeenCalledWith("jwt-token-xyz");
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ demo: true, persona: "secondary", role: "AGENT" }),
      })
    );
  });

  it("(ฌ) cross-tenant: context=globex + persona=secondary → ได้ Dana เท่านั้น (Alex ต้องไม่หลุดข้าม tenant)", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue({ slug: "globex" });
    mockUsersByEmail([DEMO_USER, ALEX_USER, DANA_USER]);

    const res = await demoLogin(makeReq({ persona: "secondary" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.user.email).toBe("dana@globex.helpwise.com");
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "dana@globex.helpwise.com" } })
    );
  });

  it("(ญ) persona=secondary แต่ tenant ไม่ใช่ demo tenant → 404", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue({ slug: "realcorp" });
    mockUsersByEmail([DEMO_USER, ALEX_USER]);

    const res = await demoLogin(makeReq({ persona: "secondary" }));

    expect(res.status).toBe(404);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
    expect(issueAgentTokenMock).not.toHaveBeenCalled();
    expect(setAgentCookieMock).not.toHaveBeenCalled();
  });

  it.each([["admin"], ["__proto__"], ["primary "], [0], [1], [["secondary"]], [{ key: "secondary" }], [null]])(
    "(ฎ) persona ค่าไม่รู้จัก (%j) → 400 และไม่ออก session",
    async (persona) => {
      mockUsersByEmail([DEMO_USER, ALEX_USER]);

      const res = await demoLogin(makeReq({ persona }));
      const json = await res.json();

      expect(res.status).toBe(400);
      expect(json.error.code).toBe("INVALID_PERSONA");
      expect(json.data).toBeNull();
      expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
      expect(issueAgentTokenMock).not.toHaveBeenCalled();
      expect(setAgentCookieMock).not.toHaveBeenCalled();
      expect(auditLogMock).not.toHaveBeenCalled();
    }
  );

  it("(ฏ) secondary ที่ role !== AGENT → 403, ไม่ออก token", async () => {
    mockUsersByEmail([DEMO_USER, ALEX_USER]);
    fakeDb.tenantMember.findFirst.mockResolvedValue({ id: "member-alex", role: "ADMIN" });

    const res = await demoLogin(makeReq({ persona: "secondary" }));

    expect(res.status).toBe(403);
    expect(issueAgentTokenMock).not.toHaveBeenCalled();
    expect(setAgentCookieMock).not.toHaveBeenCalled();
  });

  it("(ฐ) secondary ที่ไม่มี TenantMember active → 503, ไม่ออก token", async () => {
    mockUsersByEmail([DEMO_USER, ALEX_USER]);
    fakeDb.tenantMember.findFirst.mockResolvedValue(null);

    const res = await demoLogin(makeReq({ persona: "secondary" }));

    expect(res.status).toBe(503);
    expect(issueAgentTokenMock).not.toHaveBeenCalled();
  });

  it("(ฑ) secondary ที่ user.isActive = false → 503, ไม่ออก token", async () => {
    mockUsersByEmail([DEMO_USER, { ...ALEX_USER, isActive: false }]);

    const res = await demoLogin(makeReq({ persona: "secondary" }));

    expect(res.status).toBe(503);
    expect(issueAgentTokenMock).not.toHaveBeenCalled();
  });

  it("(ฒ) secondary ที่ยังไม่ seed (User ไม่มีใน DB) → 503, ไม่ออก token", async () => {
    mockUsersByEmail([DEMO_USER]);

    const res = await demoLogin(makeReq({ persona: "secondary" }));

    expect(res.status).toBe(503);
    expect(issueAgentTokenMock).not.toHaveBeenCalled();
  });

  // ---- เพิ่มโดย qa-testing (Phase 37 gate) ----

  it("(ณ) cross-tenant: context=globex + persona=primary → demo@globex เท่านั้น (ไม่ใช่ demo@acme)", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue({ slug: "globex" });
    mockUsersByEmail([
      DEMO_USER,
      ALEX_USER,
      DANA_USER,
      {
        id: "user-demo-globex",
        email: "demo@globex.helpwise.com",
        name: "Demo Agent",
        passwordHash: "$2a$12$hash",
        isActive: true,
      },
    ]);

    const res = await demoLogin(makeReq({ persona: "primary" }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.user.email).toBe("demo@globex.helpwise.com");
    expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "demo@globex.helpwise.com" } })
    );
    expect(issueAgentTokenMock).toHaveBeenCalledWith("user-demo-globex");
  });

  it("(ด) ไม่รับ tenantId/email/password จาก client — body ที่แนบมาต้องถูกเมินทั้งหมด", async () => {
    mockUsersByEmail([DEMO_USER, ALEX_USER, DANA_USER]);

    const res = await demoLogin(
      makeReq({
        persona: "secondary",
        tenantId: "tenant-ของคนอื่น",
        email: "dana@globex.helpwise.com",
        password: "อะไรก็ได้",
        role: "OWNER",
      })
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    // ใช้ tenant จาก context (acme) → ได้ Alex ไม่ใช่ Dana; role มาจาก DB ไม่ใช่ body
    expect(json.data.user.email).toBe("alex@acme.helpwise.com");
    expect(json.data.role).toBe("AGENT");
    expect(getTenantContextMock).toHaveBeenCalled();
    expect(prismaMock.tenant.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: DEFAULT_TENANT_ID } })
    );
  });

  it.each([
    ["array body", [1, 2, 3]],
    ["string body", "secondary"],
    ["number body", 42],
    ["null body", null],
    ["boolean body", true],
  ])("(ต) body ที่ไม่ใช่ JSON object (%s) → fallback เป็น primary", async (_label, body) => {
    mockUsersByEmail([DEMO_USER, ALEX_USER]);

    const res = await demoLogin(makeReq(body));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.user.email).toBe("demo@acme.helpwise.com");
    expect(verifyPasswordMock).toHaveBeenCalled();
  });

  it("(ถ) body เป็น JSON พัง (ไม่ใช่ JSON เลย) → fallback เป็น primary ไม่ throw", async () => {
    mockUsersByEmail([DEMO_USER, ALEX_USER]);

    const req = new Request("https://acme.helpwise.com/api/auth/demo/login", {
      method: "POST",
      body: "{ ไม่ใช่ json",
      headers: { "content-type": "application/json" },
    });
    const res = await demoLogin(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.user.email).toBe("demo@acme.helpwise.com");
  });

  it("(ท) primary ที่ user ไม่มี passwordHash → 503 (ห้าม bypass password ผ่าน hash ว่าง)", async () => {
    mockUsersByEmail([{ ...DEMO_USER, passwordHash: null } as unknown as typeof DEMO_USER]);

    const res = await demoLogin(makeReq({ persona: "primary" }));

    expect(res.status).toBe(503);
    expect(verifyPasswordMock).not.toHaveBeenCalled();
    expect(issueAgentTokenMock).not.toHaveBeenCalled();
  });

  it("(ธ) secondary: membership query ต้องผ่าน tenantPrisma และกรอง isActive", async () => {
    mockUsersByEmail([DEMO_USER, ALEX_USER]);

    await demoLogin(makeReq({ persona: "secondary" }));

    expect(fakeDb.tenantMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-alex", isActive: true }),
      })
    );
  });

  it("(น) audit.log พังไม่ทำให้ login พัง (soft-fail) — ยังได้ 200 + cookie", async () => {
    mockUsersByEmail([DEMO_USER, ALEX_USER]);
    auditLogMock.mockRejectedValue(new Error("audit ล่ม"));

    const res = await demoLogin(makeReq({ persona: "secondary" }));

    expect(res.status).toBe(200);
    expect(setAgentCookieMock).toHaveBeenCalledWith("jwt-token-xyz");
  });

  it("(บ) ไม่มี response ไหน leak passwordHash / DEMO_PASSWORD", async () => {
    mockUsersByEmail([DEMO_USER, ALEX_USER]);

    for (const body of [undefined, { persona: "primary" }, { persona: "secondary" }]) {
      const res = await demoLogin(makeReq(body));
      const text = JSON.stringify(await res.json());
      expect(text).not.toContain("$2a$12$");
      expect(text).not.toContain("demo-helpwise-2026");
    }
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
