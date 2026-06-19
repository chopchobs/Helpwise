/**
 * src/lib/__tests__/queue.test.ts
 * Unit tests สำหรับ src/lib/queue.ts (Phase 28 Slice 1 — QStash foundation)
 *
 * ครอบ invariant สำคัญของ slice นี้:
 *   (a) verifyQStashSignature reject เมื่อ signature invalid
 *   (b) fail-closed บน production เมื่อไม่มี signing key
 *   (c) dev fallback: ไม่มี signing key + NODE_ENV!=production → allow + warn
 *
 * Mock boundary: mock "@upstash/qstash" Receiver/Client เพราะ verify จริงต้องมี
 * signing key + network — unit test ทดสอบ branch logic ของ wrapper เราเอง
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { receiverVerifyMock, ReceiverMock, ClientMock } = vi.hoisted(() => {
  const receiverVerifyMock = vi.fn();
  // ใช้ function constructor (ไม่ใช่ arrow) — verifyQStashSignature เรียก `new Receiver(...)`
  const ReceiverMock = vi.fn(function () {
    return { verify: receiverVerifyMock };
  });
  const ClientMock = vi.fn(function () {
    return { publishJSON: vi.fn() };
  });
  return { receiverVerifyMock, ReceiverMock, ClientMock };
});

vi.mock("@upstash/qstash", () => ({
  Receiver: ReceiverMock,
  Client: ClientMock,
}));

import { verifyQStashSignature } from "@/lib/queue";

/** สร้าง SignedRequest stub — body อ่านครั้งเดียวผ่าน text() */
function makeRequest(opts: {
  body?: string;
  signature?: string;
}) {
  const headers = new Map<string, string>();
  if (opts.signature !== undefined) headers.set("upstash-signature", opts.signature);
  return {
    headers: { get: (name: string) => headers.get(name) ?? null },
    text: async () => opts.body ?? "{}",
  };
}

describe("verifyQStashSignature", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("(a) reject เมื่อ signature invalid (Receiver.verify คืน false)", async () => {
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "cur");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "next");
    vi.stubEnv("QSTASH_TARGET_BASE_URL", "https://acme.helpwise.com");
    receiverVerifyMock.mockResolvedValue(false);

    const res = await verifyQStashSignature(makeRequest({ body: "{}", signature: "bad" }));

    expect(res.valid).toBe(false);
    expect(res.rawBody).toBe("{}");
    expect(receiverVerifyMock).toHaveBeenCalledTimes(1);
  });

  it("(a) reject เมื่อ Receiver.verify throw (SignatureError) — fail-closed", async () => {
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "cur");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "next");
    vi.stubEnv("QSTASH_TARGET_BASE_URL", "https://acme.helpwise.com");
    receiverVerifyMock.mockRejectedValue(new Error("invalid signature"));

    const res = await verifyQStashSignature(makeRequest({ body: "{}", signature: "bad" }));

    expect(res.valid).toBe(false);
  });

  it("(a) reject เมื่อไม่มี signature header แม้มี signing key", async () => {
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "cur");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "next");

    const res = await verifyQStashSignature(makeRequest({ body: "{}" }));

    expect(res.valid).toBe(false);
    expect(receiverVerifyMock).not.toHaveBeenCalled();
  });

  it("valid เมื่อ signature ถูกต้อง (Receiver.verify คืน true)", async () => {
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "cur");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "next");
    vi.stubEnv("QSTASH_TARGET_BASE_URL", "https://acme.helpwise.com");
    receiverVerifyMock.mockResolvedValue(true);

    const res = await verifyQStashSignature(
      makeRequest({ body: '{"tenantId":"t1","messageId":"m1"}', signature: "good" })
    );

    expect(res.valid).toBe(true);
    expect(res.rawBody).toBe('{"tenantId":"t1","messageId":"m1"}');
  });

  it("verify ผ่านด้วย pinned getWorkerTargetUrl() ไม่ใช่ request.url (กัน Vercel proxy mismatch)", async () => {
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "cur");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "next");
    // target base ต่างจาก host ที่ proxy เห็น (acme.helpwise.com) → ถ้าใช้ request.url จะ mismatch
    vi.stubEnv("QSTASH_TARGET_BASE_URL", "https://worker.helpwise.com");
    receiverVerifyMock.mockResolvedValue(true);

    const res = await verifyQStashSignature(
      makeRequest({ body: '{"tenantId":"t1","messageId":"m1"}', signature: "good" })
    );

    expect(res.valid).toBe(true);
    // verify ต้องถูกเรียกด้วย url = pinned target (base + worker path) ไม่ใช่ค่าจาก request
    expect(receiverVerifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://worker.helpwise.com/api/jobs/send-email",
        body: '{"tenantId":"t1","messageId":"m1"}',
        signature: "good",
      })
    );
  });

  it("(b) fail-closed บน production เมื่อไม่มี signing key → reject", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "");

    const res = await verifyQStashSignature(makeRequest({ body: "{}", signature: "x" }));

    expect(res.valid).toBe(false);
    // ห้ามแตะ Receiver เลยบน prod เมื่อไม่มี key
    expect(receiverVerifyMock).not.toHaveBeenCalled();
  });

  it("(c) dev fallback: ไม่มี signing key + NODE_ENV!=production → allow + warn", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await verifyQStashSignature(makeRequest({ body: "{}" }));

    expect(res.valid).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
