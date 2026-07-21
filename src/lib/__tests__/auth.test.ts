/**
 * src/lib/__tests__/auth.test.ts
 * Integration tests สำหรับ JWT auth pipeline (Phase 19)
 *
 * Security invariants ที่ต้อง prove:
 *   - requireAgent / requireContact ตรวจ type field (type-confusion guard)
 *   - requireContact ตรวจ payload.tenantId === ctx.tenantId (cross-tenant token reuse)
 *   - requireAgent ใช้ tenantPrisma(ctx.tenantId).tenantMember.findFirst({where:{userId, isActive:true}})
 *   - role check / isActive check ทำงานถูกต้อง
 *   - token issuance + secret validation + error mapping + cookie helpers
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultCtx, DEFAULT_TENANT_ID } from "@/app/api/__tests__/_helpers";

// =============================================================================
// MOCKS
// =============================================================================

const { fakeDb, getTenantContextMock, cookieStoreMock, cookiesMock } = vi.hoisted(() => {
  const fakeDb: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {
    tenantMember: { findFirst: vi.fn() },
    contact: { findUnique: vi.fn() },
  };

  const cookieStoreMock = {
    get: vi.fn(),
    set: vi.fn(),
  };

  return {
    fakeDb,
    getTenantContextMock: vi.fn(),
    cookieStoreMock,
    cookiesMock: vi.fn(async () => cookieStoreMock),
  };
});

vi.mock("@/lib/tenant", () => ({
  getTenantContext: (...args: unknown[]) => getTenantContextMock(...args),
  tenantPrisma: () => fakeDb,
}));

vi.mock("next/headers", () => ({
  cookies: () => cookiesMock(),
}));

import {
  requireAgent,
  requireContact,
  issueAgentToken,
  issueContactToken,
  AuthError,
  toAuthErrorResponse,
  setAgentCookie,
  setContactCookie,
  clearAgentCookie,
  clearContactCookie,
  AGENT_COOKIE_NAME,
  CONTACT_COOKIE_NAME,
} from "@/lib/auth";
import { SignJWT, jwtVerify } from "jose";
import { Prisma } from "@prisma/client";

const AUTH_SECRET = "a".repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AUTH_SECRET", AUTH_SECRET);
  vi.stubEnv("NODE_ENV", "test");
  getTenantContextMock.mockResolvedValue(defaultCtx());
  cookieStoreMock.get.mockReturnValue(undefined);
  fakeDb.tenantMember.findFirst.mockResolvedValue(null);
  fakeDb.contact.findUnique.mockResolvedValue(null);
});

// =============================================================================
// requireAgent
// =============================================================================

describe("requireAgent", () => {
  it("ไม่มี cookie → AuthError 401", async () => {
    cookieStoreMock.get.mockReturnValue(undefined);
    await expect(requireAgent()).rejects.toMatchObject({ statusCode: 401 });
    await expect(requireAgent()).rejects.toBeInstanceOf(AuthError);
  });

  it("token เน่า/แก้ตัวอักษร → 401", async () => {
    const token = await issueAgentToken("user-1");
    const tampered = token.slice(0, -2) + "xx";
    cookieStoreMock.get.mockReturnValue({ value: tampered });

    await expect(requireAgent()).rejects.toMatchObject({ statusCode: 401 });
  });

  it("contact token ใช้กับ requireAgent → 401 (type-confusion guard)", async () => {
    const contactToken = await issueContactToken("contact-1", DEFAULT_TENANT_ID);
    cookieStoreMock.get.mockReturnValue({ value: contactToken });

    await expect(requireAgent()).rejects.toMatchObject({ statusCode: 401 });
  });

  it("valid agent token แต่ tenantMember.findFirst คืน null → 403", async () => {
    const token = await issueAgentToken("user-1");
    cookieStoreMock.get.mockReturnValue({ value: token });
    fakeDb.tenantMember.findFirst.mockResolvedValue(null);

    await expect(requireAgent()).rejects.toMatchObject({ statusCode: 403 });
  });

  it("member แต่ member.user.isActive===false → 403", async () => {
    const token = await issueAgentToken("user-1");
    cookieStoreMock.get.mockReturnValue({ value: token });
    fakeDb.tenantMember.findFirst.mockResolvedValue({
      role: "AGENT",
      user: { id: "user-1", isActive: false },
    });

    await expect(requireAgent()).rejects.toMatchObject({ statusCode: 403 });
  });

  it("role check: opts.roles=[OWNER,ADMIN] แต่ member.role=AGENT → 403", async () => {
    const token = await issueAgentToken("user-1");
    cookieStoreMock.get.mockReturnValue({ value: token });
    fakeDb.tenantMember.findFirst.mockResolvedValue({
      role: "AGENT",
      user: { id: "user-1", isActive: true },
    });

    await expect(
      requireAgent({ roles: ["OWNER", "ADMIN"] })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("role check: member.role ตรง opts.roles → ผ่าน", async () => {
    const token = await issueAgentToken("user-1");
    cookieStoreMock.get.mockReturnValue({ value: token });
    const member = { role: "ADMIN", user: { id: "user-1", isActive: true } };
    fakeDb.tenantMember.findFirst.mockResolvedValue(member);

    const result = await requireAgent({ roles: ["OWNER", "ADMIN"] });
    expect(result.member).toEqual(member);
    expect(result.user).toEqual(member.user);
  });

  it("success → คืน {user, member, ctx} ถูกต้อง + tenantMember.findFirst ถูกเรียกด้วย where:{userId, isActive:true}", async () => {
    const token = await issueAgentToken("user-1");
    cookieStoreMock.get.mockReturnValue({ value: token });
    const member = { role: "OWNER", user: { id: "user-1", isActive: true } };
    fakeDb.tenantMember.findFirst.mockResolvedValue(member);
    const ctx = defaultCtx();
    getTenantContextMock.mockResolvedValue(ctx);

    const result = await requireAgent();

    expect(result).toEqual({ user: member.user, member, ctx });
    expect(fakeDb.tenantMember.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", isActive: true },
      include: { user: true },
    });
  });

  it("token หมดอายุ → 401", async () => {
    // mint token ที่ exp ผ่านไปแล้ว ด้วย jose ตรง
    const expiredToken = await new SignJWT({ type: "agent" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-1")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 100)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(new TextEncoder().encode(AUTH_SECRET));

    cookieStoreMock.get.mockReturnValue({ value: expiredToken });

    await expect(requireAgent()).rejects.toMatchObject({ statusCode: 401 });
  });
});

// =============================================================================
// requireContact
// =============================================================================

describe("requireContact", () => {
  it("ไม่มี cookie → 401", async () => {
    cookieStoreMock.get.mockReturnValue(undefined);
    await expect(requireContact()).rejects.toMatchObject({ statusCode: 401 });
  });

  it("agent token ใช้กับ requireContact → 401 (type-confusion guard)", async () => {
    const agentToken = await issueAgentToken("user-1");
    cookieStoreMock.get.mockReturnValue({ value: agentToken });

    await expect(requireContact()).rejects.toMatchObject({ statusCode: 401 });
  });

  it("payload.tenantId !== ctx.tenantId → 401 (cross-tenant token reuse)", async () => {
    const tokenForTenantA = await issueContactToken("contact-1", "tenant-A");
    cookieStoreMock.get.mockReturnValue({ value: tokenForTenantA });
    getTenantContextMock.mockResolvedValue(defaultCtx({ tenantId: "tenant-B" }));

    await expect(requireContact()).rejects.toMatchObject({ statusCode: 401 });
    // ห้ามไป query DB เลย ถ้า tenant ไม่ตรงตั้งแต่ token check
    expect(fakeDb.contact.findUnique).not.toHaveBeenCalled();
  });

  it("contact.findUnique คืน null → 401", async () => {
    const token = await issueContactToken("contact-1", DEFAULT_TENANT_ID);
    cookieStoreMock.get.mockReturnValue({ value: token });
    fakeDb.contact.findUnique.mockResolvedValue(null);

    await expect(requireContact()).rejects.toMatchObject({ statusCode: 401 });
  });

  it("contact.isActive===false → 401", async () => {
    const token = await issueContactToken("contact-1", DEFAULT_TENANT_ID);
    cookieStoreMock.get.mockReturnValue({ value: token });
    fakeDb.contact.findUnique.mockResolvedValue({
      id: "contact-1",
      tenantId: DEFAULT_TENANT_ID,
      isActive: false,
    });

    await expect(requireContact()).rejects.toMatchObject({ statusCode: 401 });
  });

  it("contact.tenantId !== ctx.tenantId → 403 (defense-in-depth)", async () => {
    const token = await issueContactToken("contact-1", DEFAULT_TENANT_ID);
    cookieStoreMock.get.mockReturnValue({ value: token });
    fakeDb.contact.findUnique.mockResolvedValue({
      id: "contact-1",
      tenantId: "some-other-tenant",
      isActive: true,
    });

    await expect(requireContact()).rejects.toMatchObject({ statusCode: 403 });
  });

  it("success → คืน {contact, ctx}", async () => {
    const token = await issueContactToken("contact-1", DEFAULT_TENANT_ID);
    cookieStoreMock.get.mockReturnValue({ value: token });
    const contact = { id: "contact-1", tenantId: DEFAULT_TENANT_ID, isActive: true };
    fakeDb.contact.findUnique.mockResolvedValue(contact);
    const ctx = defaultCtx();
    getTenantContextMock.mockResolvedValue(ctx);

    const result = await requireContact();
    expect(result).toEqual({ contact, ctx });
    expect(fakeDb.contact.findUnique).toHaveBeenCalledWith({ where: { id: "contact-1" } });
  });
});

// =============================================================================
// Token issuance
// =============================================================================

describe("token issuance", () => {
  it("issueAgentToken: claim ถูก (sub, type) และ verify ผ่านด้วย AUTH_SECRET เดียวกัน", async () => {
    const token = await issueAgentToken("user-42");
    const { payload } = await jwtVerify(token, new TextEncoder().encode(AUTH_SECRET));
    expect(payload.sub).toBe("user-42");
    expect(payload.type).toBe("agent");
    expect(payload.exp).toBeDefined();
  });

  it("issueContactToken: claim ถูก (sub, type, tenantId)", async () => {
    const token = await issueContactToken("contact-99", "tenant-xyz");
    const { payload } = await jwtVerify(token, new TextEncoder().encode(AUTH_SECRET));
    expect(payload.sub).toBe("contact-99");
    expect(payload.type).toBe("contact");
    expect(payload.tenantId).toBe("tenant-xyz");
  });

  it("verify ไม่ผ่านถ้า secret ต่าง", async () => {
    const token = await issueAgentToken("user-1");
    await expect(
      jwtVerify(token, new TextEncoder().encode("b".repeat(32)))
    ).rejects.toThrow();
  });
});

// =============================================================================
// getJwtSecret (ผ่าน issueAgentToken เพื่อ exercise getJwtSecret)
// =============================================================================

describe("getJwtSecret (ผ่าน token issuance)", () => {
  it("AUTH_SECRET ขาด → throw", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    await expect(issueAgentToken("user-1")).rejects.toThrow(/AUTH_SECRET is not set/);
  });

  it("AUTH_SECRET < 32 ตัว → throw", async () => {
    vi.stubEnv("AUTH_SECRET", "short-secret");
    await expect(issueAgentToken("user-1")).rejects.toThrow(/at least 32 characters/);
  });
});

// =============================================================================
// toAuthErrorResponse
// =============================================================================

describe("toAuthErrorResponse", () => {
  it("AuthError(401) → UNAUTHORIZED/401", () => {
    const res = toAuthErrorResponse(new AuthError("no auth", 401));
    expect(res).toEqual({
      data: null,
      error: { code: "UNAUTHORIZED", message: "no auth" },
      status: 401,
    });
  });

  it("AuthError(403) → FORBIDDEN/403", () => {
    const res = toAuthErrorResponse(new AuthError("forbidden", 403));
    expect(res).toEqual({
      data: null,
      error: { code: "FORBIDDEN", message: "forbidden" },
      status: 403,
    });
  });

  it("AuthError(429) → RATE_LIMITED/429", () => {
    const res = toAuthErrorResponse(new AuthError("rate limited", 429));
    expect(res).toEqual({
      data: null,
      error: { code: "RATE_LIMITED", message: "rate limited" },
      status: 429,
    });
  });

  it("Error ทั่วไป → INTERNAL_ERROR/500 และไม่ leak message", () => {
    const res = toAuthErrorResponse(new Error("db connection string leaked!"));
    expect(res).toEqual({
      data: null,
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
      status: 500,
    });
  });

  // XT-WRITE-05: composite tenant FK → cross-tenant FK ถูก reject ที่ DB (PG 23503 / P2003)
  // ต้อง map เป็น 400 สะอาด และห้าม echo ชื่อ constraint/field จาก Prisma
  it("Prisma P2003 (FK constraint / 23503) → INVALID_REFERENCE/400 และไม่ leak constraint name", () => {
    const fkError = new Prisma.PrismaClientKnownRequestError(
      "Foreign key constraint failed on the field: `Ticket_tenantId_requesterContactId_fkey`",
      { code: "P2003", clientVersion: "test" }
    );
    const res = toAuthErrorResponse(fkError);
    expect(res).toEqual({
      data: null,
      error: {
        code: "INVALID_REFERENCE",
        message: "ข้อมูลอ้างอิงไม่ถูกต้องสำหรับ workspace นี้",
      },
      status: 400,
    });
    // ห้าม leak constraint/field name จาก Prisma error ออกไปหา client
    expect(res.error.message).not.toContain("fkey");
    expect(res.error.message).not.toContain("requesterContactId");
  });

  it("Prisma error code อื่น (เช่น P2002 unique) → ตกไป INTERNAL_ERROR/500 (ไม่ถูก map เป็น 400)", () => {
    const uniqueError = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "test" }
    );
    const res = toAuthErrorResponse(uniqueError);
    expect(res.status).toBe(500);
    expect(res.error.code).toBe("INTERNAL_ERROR");
  });
});

// =============================================================================
// Cookie helpers
// =============================================================================

describe("cookie helpers", () => {
  it("setAgentCookie → cookies().set ถูกเรียกด้วย name hw_agent_session + attrs ถูกต้อง (non-prod)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await setAgentCookie("token-value");

    expect(cookieStoreMock.set).toHaveBeenCalledWith(
      AGENT_COOKIE_NAME,
      "token-value",
      expect.objectContaining({
        httpOnly: true,
        secure: false,
        sameSite: "strict",
        path: "/",
        maxAge: 8 * 60 * 60,
      })
    );
  });

  it("setAgentCookie → secure:true เมื่อ NODE_ENV=production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await setAgentCookie("token-value");

    expect(cookieStoreMock.set).toHaveBeenCalledWith(
      AGENT_COOKIE_NAME,
      "token-value",
      expect.objectContaining({ secure: true })
    );
  });

  it("setContactCookie → name hw_contact_session + maxAge > 0", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await setContactCookie("token-value");

    expect(cookieStoreMock.set).toHaveBeenCalledWith(
      CONTACT_COOKIE_NAME,
      "token-value",
      expect.objectContaining({ maxAge: 8 * 60 * 60, secure: false })
    );
  });

  it("clearAgentCookie → maxAge:0", async () => {
    await clearAgentCookie();
    expect(cookieStoreMock.set).toHaveBeenCalledWith(
      AGENT_COOKIE_NAME,
      "",
      expect.objectContaining({ maxAge: 0 })
    );
  });

  it("clearContactCookie → maxAge:0", async () => {
    await clearContactCookie();
    expect(cookieStoreMock.set).toHaveBeenCalledWith(
      CONTACT_COOKIE_NAME,
      "",
      expect.objectContaining({ maxAge: 0 })
    );
  });
});
