/**
 * src/app/api/__tests__/agent-me.test.ts
 * Integration tests สำหรับ GET /api/auth/agent/me (Phase 37 Slice 1b)
 *
 * P0 invariants:
 *   - demoPersona จำแนกฝั่ง server จาก DEMO_PERSONAS (source เดียวกับ demo-login)
 *   - tenant จริง (ไม่ใช่ demo) → demoPersona = null (ไม่ throw / ไม่ 403)
 *   - cross-tenant: email persona ของ acme บน tenant globex → null
 *   - ไม่ leak email/password ของ persona (คืนแค่ key)
 *   - response shape เดิมไม่เปลี่ยน (additive field เท่านั้น)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultCtx } from "@/app/api/__tests__/_helpers";

const { prismaMock, requireAgentMock } = vi.hoisted(() => ({
  prismaMock: { tenant: { findUnique: vi.fn() } },
  requireAgentMock: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// mock requireAgent เท่านั้น — ใช้ toAuthErrorResponse จริงจาก @/lib/auth
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAgent: (...args: unknown[]) => requireAgentMock(...args),
  };
});

// ไม่ mock @/lib/demo-personas — ใช้ค่าจริงจาก single source of truth

import { GET as getMe } from "@/app/api/auth/agent/me/route";

function session(email: string) {
  return {
    user: { id: "user-1", name: "Demo Agent", email, avatarUrl: null },
    member: { id: "member-1", role: "AGENT", userId: "user-1" },
    ctx: defaultCtx(),
  };
}

const ACME_TENANT = { id: "tenant-1", name: "Acme Inc", slug: "acme", settings: null };

beforeEach(() => {
  vi.clearAllMocks();
  requireAgentMock.mockResolvedValue(session("demo@acme.helpwise.com"));
  prismaMock.tenant.findUnique.mockResolvedValue(ACME_TENANT);
});

describe("GET /api/auth/agent/me — demoPersona", () => {
  it("(ก) demo tenant + persona primary → demoPersona = 'primary' (shape เดิมครบ)", async () => {
    const res = await getMe();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.demoPersona).toBe("primary");
    // shape เดิมต้องไม่เปลี่ยน (additive field เท่านั้น)
    expect(json.data.user).toEqual({
      id: "user-1",
      name: "Demo Agent",
      email: "demo@acme.helpwise.com",
      avatarUrl: null,
    });
    expect(json.data.member).toEqual({ id: "member-1", role: "AGENT" });
    expect(json.data.tenant).toEqual({
      id: "tenant-1",
      name: "Acme Inc",
      slug: "acme",
      plan: "pro",
      logoUrl: null,
      accentColor: null,
    });
    expect(json.error).toBeNull();
  });

  it("(ข) demo tenant + persona secondary (Alex) → 'secondary'", async () => {
    requireAgentMock.mockResolvedValue(session("alex@acme.helpwise.com"));

    const res = await getMe();
    const json = await res.json();

    expect(json.data.demoPersona).toBe("secondary");
  });

  it("(ค) tenant จริง (slug=realcorp) → demoPersona = null, ไม่ throw/ไม่ 403", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue({ ...ACME_TENANT, slug: "realcorp" });

    const res = await getMe();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.demoPersona).toBeNull();
  });

  it("(ง) session ที่ไม่ใช่ persona แต่อยู่ใน demo tenant → null", async () => {
    requireAgentMock.mockResolvedValue(session("someone.else@acme.helpwise.com"));

    const res = await getMe();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.demoPersona).toBeNull();
  });

  it("(จ) cross-tenant: email persona ของ acme บน tenant globex → null", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue({ ...ACME_TENANT, slug: "globex" });
    requireAgentMock.mockResolvedValue(session("alex@acme.helpwise.com"));

    const res = await getMe();
    const json = await res.json();

    expect(json.data.demoPersona).toBeNull();
  });

  it("(ฉ) ไม่ leak email/password ของ persona ตัวอื่น + ไม่มี DB query เพิ่ม", async () => {
    const res = await getMe();
    const body = JSON.stringify(await res.json());

    expect(body).not.toContain("alex@acme.helpwise.com");
    expect(body).not.toContain("demo-helpwise-2026");
    // query DB ครั้งเดียวเหมือนเดิม (route นี้ถูกเรียกทุกครั้งที่ mount workspace)
    expect(prismaMock.tenant.findUnique).toHaveBeenCalledTimes(1);
  });
});
