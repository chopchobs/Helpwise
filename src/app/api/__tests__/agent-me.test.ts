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

  // ---- เพิ่มโดย qa-testing (Phase 37 gate) ----

  it("(ช) globex: demo@globex → 'primary', dana@globex → 'secondary'", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue({
      ...ACME_TENANT,
      id: "tenant-2",
      name: "Globex",
      slug: "globex",
    });

    requireAgentMock.mockResolvedValue(session("demo@globex.helpwise.com"));
    expect((await (await getMe()).json()).data.demoPersona).toBe("primary");

    requireAgentMock.mockResolvedValue(session("dana@globex.helpwise.com"));
    expect((await (await getMe()).json()).data.demoPersona).toBe("secondary");
  });

  it("(ซ) cross-tenant ทิศกลับ: dana (globex) บน tenant acme → null", async () => {
    requireAgentMock.mockResolvedValue(session("dana@globex.helpwise.com"));

    const json = await (await getMe()).json();
    expect(json.data.demoPersona).toBeNull();
  });

  it.each([
    ["ตัวพิมพ์ใหญ่", "DEMO@acme.helpwise.com"],
    ["มีช่องว่างท้าย", "demo@acme.helpwise.com "],
    ["subdomain ปลอม", "demo@acme.helpwise.com.evil.com"],
    ["prefix ใกล้เคียง", "xdemo@acme.helpwise.com"],
  ])(
    "(ฌ) email ที่ไม่ตรงเป๊ะ (%s) → null (match แบบ exact เท่านั้น)",
    async (_label, email) => {
      requireAgentMock.mockResolvedValue(session(email));

      const json = await (await getMe()).json();
      expect(json.data.demoPersona).toBeNull();
    }
  );

  it("(ญ) tenant ไม่พบ → 404 และไม่มี demoPersona ใน payload (พฤติกรรมเดิมคงอยู่)", async () => {
    prismaMock.tenant.findUnique.mockResolvedValue(null);

    const res = await getMe();
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("TENANT_NOT_FOUND");
    expect(json.data).toBeNull();
  });

  it("(ฎ) requireAgent throw (ไม่ได้ login) → ไม่ 200 และไม่คืน demoPersona", async () => {
    requireAgentMock.mockRejectedValue(new Error("UNAUTHORIZED"));

    const res = await getMe();
    const json = await res.json();

    expect(res.status).not.toBe(200);
    expect(json.data).toBeNull();
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
