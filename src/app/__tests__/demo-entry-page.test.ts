/**
 * src/app/api/__tests__/demo-entry-page.test.ts
 * Tests สำหรับ server component ของ /demo (Phase 37 slice 2 — เพิ่มโดย qa-testing gate)
 *
 * ทำไมต้องเทสต์ที่นี่: resolveDemoEntryMode() ถูกเทสต์แล้วในระดับ pure function แต่ "ค่า input
 * ที่ป้อนให้มัน" (persona ของ session, hasSession, next) ถูกประกอบในหน้านี้ — ถ้าประกอบผิด
 * ตารางพฤติกรรมที่ผ่านทั้งตารางก็ไม่ช่วยอะไร (P0: ห้าม auto-POST ทับ session ของ agent จริง)
 *
 * เรียก page function ตรง ๆ (async server component) — ไม่ render DOM, ตรวจ props ที่ส่งลง client
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { requireAgentMock, redirectMock, tenantFindUniqueMock } = vi.hoisted(() => ({
  requireAgentMock: vi.fn(),
  redirectMock: vi.fn((url: string) => {
    // จำลองพฤติกรรมจริงของ next: redirect() throw เพื่อหยุด render
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  tenantFindUniqueMock: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireAgent: (...args: unknown[]) => requireAgentMock(...args),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

// lookup slug ของ tenant ปัจจุบัน — persona ต้อง match email + tenantSlug คู่กัน (กัน cross-tenant)
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: {
      findUnique: (...args: unknown[]) => tenantFindUniqueMock(...args),
    },
  },
}));

import DemoEntryPage from "@/app/(agent)/demo/page";

interface ClientProps {
  persona: string;
  nextParam: string | null;
  mode: string;
  currentName: string | null;
  targetName: string | null;
}

type SearchParams = Record<string, string | string[] | undefined>;

async function renderPage(params: SearchParams): Promise<ClientProps> {
  const element = (await DemoEntryPage({
    searchParams: Promise.resolve(params),
  })) as unknown as { props: ClientProps };
  return element.props;
}

function agentSession(email: string, name: string | null = "ชื่อจริง") {
  return {
    user: { id: "u1", email, name },
    member: { id: "m1", role: "AGENT" },
    // tenant ปัจจุบันมาจาก context ที่ middleware verify แล้วเท่านั้น (ไม่ใช่จาก client)
    ctx: { tenantId: "tenant-current", plan: "starter" },
  };
}

/** ตั้ง slug ของ tenant ที่ subdomain ปัจจุบันชี้ไป */
function setCurrentTenant(slug: string): void {
  tenantFindUniqueMock.mockResolvedValue({ slug });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAgentMock.mockRejectedValue(new Error("UNAUTHORIZED"));
  setCurrentTenant("acme");
});

describe("/demo (server component) — การประกอบ input ให้ resolveDemoEntryMode", () => {
  it("ไม่มี session → mode=auto, persona=primary (พฤติกรรมเดิม 0 คลิก)", async () => {
    const props = await renderPage({});

    expect(props.mode).toBe("auto");
    expect(props.persona).toBe("primary");
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("ไม่มี session + persona=secondary&next → mode=auto และส่ง nextParam ดิบลง client", async () => {
    const props = await renderPage({ persona: "secondary", next: "/tickets/T1" });

    expect(props).toMatchObject({
      mode: "auto",
      persona: "secondary",
      nextParam: "/tickets/T1",
    });
  });

  it.each([
    ["ค่ามั่ว", "admin"],
    ["ตัวพิมพ์ใหญ่", "Secondary"],
    ["ว่าง", ""],
    ["ตัวเลข", "1"],
  ])("persona ที่ไม่รู้จัก (%s) → ตกเป็น primary ไม่ error", async (_label, raw) => {
    const props = await renderPage({ persona: raw });
    expect(props.persona).toBe("primary");
  });

  it("searchParam ซ้ำ (?persona=a&persona=b) → ใช้ค่าแรกเสมอ", async () => {
    const props = await renderPage({
      persona: ["secondary", "primary"],
      next: ["/tickets/T1", "/tickets/T2"],
    });

    expect(props.persona).toBe("secondary");
    expect(props.nextParam).toBe("/tickets/T1");
  });

  it("P0: agent จริง (ไม่ใช่ demo persona) → mode=confirm ห้าม auto-POST ทับ session", async () => {
    requireAgentMock.mockResolvedValue(agentSession("real.agent@company.com", "ของจริง"));

    const props = await renderPage({});

    expect(props.mode).toBe("confirm");
    expect(props.currentName).toBe("ของจริง");
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("primary อยู่แล้ว + ขอ primary → redirect เงียบ (ไม่ POST, ไม่ render client)", async () => {
    requireAgentMock.mockResolvedValue(agentSession("demo@acme.helpwise.com", "Demo Agent"));

    await expect(renderPage({})).rejects.toThrow("NEXT_REDIRECT:/dashboard");
    expect(redirectMock).toHaveBeenCalledWith("/dashboard");
  });

  it("secondary อยู่แล้ว + paste ลิงก์ banner ซ้ำ → redirect ไป ticket ใบเดิม (ไม่ POST)", async () => {
    requireAgentMock.mockResolvedValue(agentSession("alex@acme.helpwise.com", "Alex Rivera"));

    await expect(
      renderPage({ persona: "secondary", next: "/tickets/T1" })
    ).rejects.toThrow("NEXT_REDIRECT:/tickets/T1");
  });

  it("เส้น redirect ต้อง validate next (ค่าอันตราย → /dashboard)", async () => {
    requireAgentMock.mockResolvedValue(agentSession("alex@acme.helpwise.com"));

    await expect(
      renderPage({ persona: "secondary", next: "https://evil.com" })
    ).rejects.toThrow("NEXT_REDIRECT:/dashboard");
  });

  it("primary อยู่แล้ว + ขอ secondary → confirm พร้อมชื่อ persona ปลายทางของ tenant เดียวกัน", async () => {
    requireAgentMock.mockResolvedValue(agentSession("demo@acme.helpwise.com", "Demo Agent"));

    const props = await renderPage({ persona: "secondary", next: "/tickets/T1" });

    expect(props.mode).toBe("confirm");
    expect(props.currentName).toBe("Demo Agent");
    expect(props.targetName).toBe("Alex Rivera");
  });

  it("globex: primary อยู่แล้ว + ขอ secondary → targetName = Dana Wu (ไม่ใช่ Alex ของ acme)", async () => {
    setCurrentTenant("globex");
    requireAgentMock.mockResolvedValue(agentSession("demo@globex.helpwise.com", "Demo Agent"));

    const props = await renderPage({ persona: "secondary" });

    expect(props.mode).toBe("confirm");
    expect(props.targetName).toBe("Dana Wu");
  });

  it("session ที่ไม่มี name → ใช้ email เป็น currentName (ไม่ปล่อยว่าง)", async () => {
    requireAgentMock.mockResolvedValue(agentSession("real.agent@company.com", null));

    const props = await renderPage({});

    expect(props.currentName).toBe("real.agent@company.com");
  });

  it("cookie พัง/หมดอายุ (requireAgent throw) → กลับไป auto (fail-open พฤติกรรมเดิม)", async () => {
    requireAgentMock.mockRejectedValue(new Error("TOKEN_EXPIRED"));

    const props = await renderPage({ persona: "secondary", next: "/tickets/T1" });

    expect(props.mode).toBe("auto");
  });

  // ── L-1 / BUG-37-1: persona ต้องผูก tenant เสมอ (email อย่างเดียวไม่พอ) ─────────────
  // repro: demo@acme เป็น member ของ globex ด้วย → เปิด globex/demo ต้องไม่ถูกมองว่าเป็น
  // persona ของ globex (ไม่งั้นจะ redirect โดยไม่เคย login เป็น demo agent ของ globex)

  it("L-1: cross-membership (persona ของ acme บน tenant globex) → confirm ไม่ redirect", async () => {
    setCurrentTenant("globex");
    requireAgentMock.mockResolvedValue(agentSession("demo@acme.helpwise.com", "Demo Agent"));

    const props = await renderPage({});

    expect(props.mode).toBe("confirm");
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("L-1: cross-membership + next → ห้ามพาไป ticket ของอีก tenant", async () => {
    setCurrentTenant("globex");
    requireAgentMock.mockResolvedValue(agentSession("alex@acme.helpwise.com", "Alex Rivera"));

    const props = await renderPage({ persona: "secondary", next: "/tickets/T1" });

    expect(props.mode).toBe("confirm");
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("L-1: targetName อิง tenant ปัจจุบัน — persona acme บน globex ขอ secondary → Dana Wu", async () => {
    setCurrentTenant("globex");
    requireAgentMock.mockResolvedValue(agentSession("demo@acme.helpwise.com", "Demo Agent"));

    const props = await renderPage({ persona: "secondary" });

    expect(props.targetName).toBe("Dana Wu");
  });

  it("L-1: tenantId ที่ใช้ lookup มาจาก context ที่ verify แล้ว (ไม่ใช่จาก client)", async () => {
    requireAgentMock.mockResolvedValue(agentSession("demo@acme.helpwise.com"));

    await expect(renderPage({})).rejects.toThrow("NEXT_REDIRECT:/dashboard");
    expect(tenantFindUniqueMock).toHaveBeenCalledWith({
      where: { id: "tenant-current" },
      select: { slug: true },
    });
  });

  it("lookup tenant ล้มเหลว (throw) → confirm (ปลอดภัยไว้ก่อน ห้าม redirect/auto)", async () => {
    tenantFindUniqueMock.mockRejectedValue(new Error("DB_DOWN"));
    requireAgentMock.mockResolvedValue(agentSession("demo@acme.helpwise.com", "Demo Agent"));

    const props = await renderPage({});

    expect(props.mode).toBe("confirm");
    expect(props.targetName).toBeNull();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("ไม่พบ tenant (null) → confirm ไม่ใช่ redirect", async () => {
    tenantFindUniqueMock.mockResolvedValue(null);
    requireAgentMock.mockResolvedValue(agentSession("demo@acme.helpwise.com", "Demo Agent"));

    const props = await renderPage({});

    expect(props.mode).toBe("confirm");
    expect(redirectMock).not.toHaveBeenCalled();
  });

  // OBS-37-2: agent จริงบน demo tenant เคยเห็นปุ่ม "สลับเป็นบัญชี demo อีกคน" (targetName=null)
  // เพราะเดิม targetName อิง persona ของ session ซึ่ง agent จริงไม่มี — พอผูกกับ tenant ปัจจุบัน
  // จะได้ชื่อจริงของ persona ปลายทางแทน (ชัดกว่าเดิมว่ากำลังจะสลับเป็นใคร)
  it("OBS-37-2: agent จริงบน demo tenant → targetName เป็นชื่อ persona ปลายทางของ tenant นั้น", async () => {
    requireAgentMock.mockResolvedValue(agentSession("real.agent@company.com", "ของจริง"));

    const props = await renderPage({ persona: "secondary" });

    expect(props.mode).toBe("confirm");
    expect(props.targetName).toBe("Alex Rivera");
  });

  it("ไม่ส่ง credential ใด ๆ ลง client props", async () => {
    requireAgentMock.mockResolvedValue(agentSession("demo@acme.helpwise.com"));

    const props = await renderPage({ persona: "secondary" });
    const serialized = JSON.stringify(props);

    expect(serialized).not.toContain("demo-helpwise-2026");
    expect(serialized).not.toContain("@acme.helpwise.com");
  });
});
