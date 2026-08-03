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

const { requireAgentMock, redirectMock } = vi.hoisted(() => ({
  requireAgentMock: vi.fn(),
  redirectMock: vi.fn((url: string) => {
    // จำลองพฤติกรรมจริงของ next: redirect() throw เพื่อหยุด render
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/auth", () => ({
  requireAgent: (...args: unknown[]) => requireAgentMock(...args),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
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
  return { user: { id: "u1", email, name }, member: { id: "m1", role: "AGENT" } };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAgentMock.mockRejectedValue(new Error("UNAUTHORIZED"));
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

  it("ไม่ส่ง credential ใด ๆ ลง client props", async () => {
    requireAgentMock.mockResolvedValue(agentSession("demo@acme.helpwise.com"));

    const props = await renderPage({ persona: "secondary" });
    const serialized = JSON.stringify(props);

    expect(serialized).not.toContain("demo-helpwise-2026");
    expect(serialized).not.toContain("@acme.helpwise.com");
  });
});
