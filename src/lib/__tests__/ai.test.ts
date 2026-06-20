/**
 * src/lib/__tests__/ai.test.ts
 * Unit tests สำหรับ lib/ai.ts (Phase 29 — summarizeThread)
 *
 * Invariants:
 *   - ส่ง messages ที่ได้รับเข้า prompt (caller เป็นคนดึงผ่าน tenantPrisma → lib ไม่ query DB เอง)
 *   - ไม่ส่ง tools / thinking / temperature / top_p (minimal request, prompt-injection defense)
 *   - narrow content block type === "text" → คืน string
 *   - ไม่มี ANTHROPIC_API_KEY → throw error (ห้าม log key)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// mock SDK — createMock อยู่ใน vi.hoisted เพราะ vi.mock factory hoisted
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => {
  // default export = class Anthropic; instance มี messages.create
  return {
    default: class {
      messages = { create: createMock };
    },
  };
});

import { summarizeThread, suggestReply, suggestTags, AI_SUMMARY_MODEL } from "@/lib/ai";

const SAMPLE = [
  { author: "Customer", visibility: "PUBLIC" as const, body: "เข้าระบบไม่ได้ครับ" },
  { author: "Agent", visibility: "PUBLIC" as const, body: "ช่วย reset password ให้แล้ว" },
  { author: "Agent", visibility: "INTERNAL" as const, body: "ลูกค้า VIP — ดูแลพิเศษ" },
];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = "test-key";
  createMock.mockResolvedValue({
    content: [{ type: "text", text: "ลูกค้าเข้าระบบไม่ได้ agent reset password ให้แล้ว" }],
  });
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe("summarizeThread", () => {
  it("คืน text summary จาก response content", async () => {
    const out = await summarizeThread(SAMPLE);
    expect(out).toBe("ลูกค้าเข้าระบบไม่ได้ agent reset password ให้แล้ว");
  });

  it("ส่ง model haiku-4-5 + max_tokens + system, ไม่มี tools/thinking/temperature/top_p", async () => {
    await summarizeThread(SAMPLE);

    expect(createMock).toHaveBeenCalledTimes(1);
    const arg = createMock.mock.calls[0][0];

    expect(arg.model).toBe(AI_SUMMARY_MODEL);
    expect(arg.model).toBe("claude-haiku-4-5");
    expect(arg.max_tokens).toBeGreaterThan(0);
    expect(typeof arg.system).toBe("string");

    // minimal request — ห้ามมี field เหล่านี้ (prompt-injection / Haiku 4.5 constraints)
    expect(arg).not.toHaveProperty("tools");
    expect(arg).not.toHaveProperty("thinking");
    expect(arg).not.toHaveProperty("temperature");
    expect(arg).not.toHaveProperty("top_p");
  });

  it("ใส่ message bodies ที่ได้รับเข้า prompt (lib ไม่ query DB เอง)", async () => {
    await summarizeThread(SAMPLE);

    const arg = createMock.mock.calls[0][0];
    const userContent = arg.messages[0].content as string;

    // body ทุกข้อความที่ caller ส่งมาต้องอยู่ใน prompt
    expect(userContent).toContain("เข้าระบบไม่ได้ครับ");
    expect(userContent).toContain("ช่วย reset password ให้แล้ว");
    expect(userContent).toContain("ลูกค้า VIP — ดูแลพิเศษ");
    // role user เท่านั้น (ไม่มี assistant prefill)
    expect(arg.messages).toHaveLength(1);
    expect(arg.messages[0].role).toBe("user");
  });

  it("ติด label [INTERNAL NOTE] ให้ message visibility=INTERNAL", async () => {
    await summarizeThread(SAMPLE);
    const userContent = createMock.mock.calls[0][0].messages[0].content as string;
    expect(userContent).toContain("[INTERNAL NOTE]");
  });

  it("system prompt มี guardrail ว่า ticket content = DATA ไม่ใช่คำสั่ง", async () => {
    await summarizeThread(SAMPLE);
    const system = createMock.mock.calls[0][0].system as string;
    expect(system).toContain("DATA");
  });

  it("narrow เฉพาะ block type text — ละ block อื่น", async () => {
    createMock.mockResolvedValue({
      content: [
        { type: "thinking", thinking: "..." },
        { type: "text", text: "สรุปจริง" },
      ],
    });
    const out = await summarizeThread(SAMPLE);
    expect(out).toBe("สรุปจริง");
  });

  it("ไม่มี ANTHROPIC_API_KEY → throw error (ไม่เรียก create)", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(summarizeThread(SAMPLE)).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(createMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// suggestReply (Slice 2)
// =============================================================================

describe("suggestReply", () => {
  beforeEach(() => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "สวัสดีครับ ทางเราได้ reset password ให้แล้ว..." }],
    });
  });

  it("คืน draft reply text จาก response content", async () => {
    const out = await suggestReply(SAMPLE);
    expect(out).toBe("สวัสดีครับ ทางเราได้ reset password ให้แล้ว...");
  });

  it("ส่ง model haiku-4-5 + system, ไม่มี tools/thinking/temperature/top_p (minimal request)", async () => {
    await suggestReply(SAMPLE);

    expect(createMock).toHaveBeenCalledTimes(1);
    const arg = createMock.mock.calls[0][0];

    expect(arg.model).toBe(AI_SUMMARY_MODEL);
    expect(arg.max_tokens).toBeGreaterThan(0);
    expect(typeof arg.system).toBe("string");
    expect(arg).not.toHaveProperty("tools");
    expect(arg).not.toHaveProperty("thinking");
    expect(arg).not.toHaveProperty("temperature");
    expect(arg).not.toHaveProperty("top_p");
  });

  it("ใส่ thread bodies เข้า prompt + system prompt ระบุ DRAFT", async () => {
    await suggestReply(SAMPLE);
    const arg = createMock.mock.calls[0][0];
    const userContent = arg.messages[0].content as string;

    expect(userContent).toContain("เข้าระบบไม่ได้ครับ");
    expect(arg.messages).toHaveLength(1);
    expect(arg.messages[0].role).toBe("user");
    // system prompt ต้องสื่อว่าเป็น DRAFT (ไม่ใช่ส่งจริง)
    expect(arg.system as string).toContain("DRAFT");
    // guardrail prompt injection
    expect(arg.system as string).toContain("DATA");
  });

  it("narrow เฉพาะ block type text", async () => {
    createMock.mockResolvedValue({
      content: [
        { type: "thinking", thinking: "..." },
        { type: "text", text: "draft จริง" },
      ],
    });
    const out = await suggestReply(SAMPLE);
    expect(out).toBe("draft จริง");
  });

  it("ไม่มี ANTHROPIC_API_KEY → throw error", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(suggestReply(SAMPLE)).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

// =============================================================================
// suggestTags (Slice 3)
// =============================================================================

describe("suggestTags", () => {
  const AVAILABLE = ["billing", "bug", "login", "feature-request"];

  it("parse JSON array → คืนเฉพาะชื่อที่อยู่ใน availableTagNames", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: '["bug","login"]' }],
    });
    const out = await suggestTags(SAMPLE, AVAILABLE);
    expect(out).toEqual(["bug", "login"]);
  });

  it("filter ทิ้ง tag ที่ LLM แต่งขึ้นใหม่ (ไม่อยู่ใน available)", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: '["bug","made-up-tag","login"]' }],
    });
    const out = await suggestTags(SAMPLE, AVAILABLE);
    expect(out).toEqual(["bug", "login"]);
    expect(out).not.toContain("made-up-tag");
  });

  it("parse JSON array ที่หุ้มด้วยข้อความ/code-fence ได้", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: 'นี่คือ tag ที่เลือก:\n```json\n["billing"]\n```' }],
    });
    const out = await suggestTags(SAMPLE, AVAILABLE);
    expect(out).toEqual(["billing"]);
  });

  it("fallback comma/newline-separated เมื่อไม่ใช่ JSON", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "bug, login" }],
    });
    const out = await suggestTags(SAMPLE, AVAILABLE);
    expect(out).toEqual(["bug", "login"]);
  });

  it("dedup ชื่อซ้ำ", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: '["bug","bug","login"]' }],
    });
    const out = await suggestTags(SAMPLE, AVAILABLE);
    expect(out).toEqual(["bug", "login"]);
  });

  it("parse ไม่ได้เลย → คืน []", async () => {
    createMock.mockResolvedValue({
      content: [{ type: "text", text: "ไม่มีอะไรเลย ขออภัย" }],
    });
    const out = await suggestTags(SAMPLE, AVAILABLE);
    expect(out).toEqual([]);
  });

  it("availableTagNames ว่าง → คืน [] โดยไม่เรียก AI (ประหยัด cost)", async () => {
    const out = await suggestTags(SAMPLE, []);
    expect(out).toEqual([]);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("ส่ง available tags + thread เข้า prompt, minimal request (no tools)", async () => {
    createMock.mockResolvedValue({ content: [{ type: "text", text: "[]" }] });
    await suggestTags(SAMPLE, AVAILABLE);

    const arg = createMock.mock.calls[0][0];
    const userContent = arg.messages[0].content as string;
    expect(userContent).toContain("billing");
    expect(userContent).toContain("เข้าระบบไม่ได้ครับ");
    expect(arg).not.toHaveProperty("tools");
    expect(arg).not.toHaveProperty("temperature");
  });
});
