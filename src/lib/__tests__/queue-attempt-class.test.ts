/**
 * src/lib/__tests__/queue-attempt-class.test.ts
 *
 * Phase 39 ลำดับ 3 — §C ข้อบังคับที่ 1 และ 3
 *   · ชื่อ header ต้องมาจาก source of truth เดียวกับที่ verify อ่าน
 *   · จำแนกคลาสด้วยการอ่าน header เอง **ห้ามอนุมานจาก `valid === false`**
 *     ซึ่งค่าเหมือนกันหมดทั้งสามกรณีที่ verify ปฏิเสธ
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { verifyQStashSignature, QSTASH_SIGNATURE_HEADER } from "@/lib/queue";

/** request ขั้นต่ำที่ verify ต้องการ */
function makeSignedRequest(headers: Record<string, string>, body = "{}") {
  return {
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => body,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("§C — ชื่อ header เป็น source of truth เดียว", () => {
  it("constant ที่ export ตรงกับชื่อที่ verify ใช้อ่านจริง", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "k1");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "k2");

    // ส่ง header ด้วยชื่อจาก constant → ต้องถูกมองว่า "มีลายเซ็น" (คลาส signed_invalid
    // เพราะค่ามั่ว) ไม่ใช่ unsigned. ถ้า constant กับที่ verify อ่านไม่ตรงกัน
    // เคสนี้จะได้ unsigned แทน = การจำแนกเพี้ยนเงียบ ๆ ทั้งระบบ
    const res = await verifyQStashSignature(
      makeSignedRequest({ [QSTASH_SIGNATURE_HEADER]: "garbage" })
    );
    expect(res.valid).toBe(false);
    expect(res.attemptClass).toBe("signed_invalid");
  });
});

describe("§C — สามกรณีที่ valid===false ต้องแยกคลาสได้", () => {
  it("(1) ไม่มี header เลย + มี signing key → unsigned", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "k1");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "k2");

    const res = await verifyQStashSignature(makeSignedRequest({}));
    expect(res.valid).toBe(false);
    expect(res.attemptClass).toBe("unsigned");
  });

  it("(2) มี header แต่ signature ผิด → signed_invalid", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "k1");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "k2");

    const res = await verifyQStashSignature(
      makeSignedRequest({ [QSTASH_SIGNATURE_HEADER]: "not-a-real-signature" })
    );
    expect(res.valid).toBe(false);
    expect(res.attemptClass).toBe("signed_invalid");
  });

  it("(3) signing key ฝั่งเราไม่ได้ตั้ง (prod) + QStash แนบ header มา → signed_invalid", async () => {
    // 🔴 เคสสำคัญที่สุดของ §C: QStash แนบ header มาทุก attempt เสมอ
    //    ⇒ เคสนี้ต้องตกคลาส (1) ไม่ใช่ (2) ไม่งั้น corroboration กับ heartbeat
    //    จะไม่ทำงาน และ "signing key rotate แล้วไม่ตรง" จะจับไม่ได้เลย
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "");

    const res = await verifyQStashSignature(
      makeSignedRequest({ [QSTASH_SIGNATURE_HEADER]: "sig-from-qstash" })
    );
    expect(res.valid).toBe(false);
    expect(res.attemptClass).toBe("signed_invalid");
  });

  it("ทั้งสามกรณี valid เท่ากันหมด — พิสูจน์ว่าอนุมานจาก valid ไม่ได้จริง", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "k1");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "k2");
    const a = await verifyQStashSignature(makeSignedRequest({}));
    const b = await verifyQStashSignature(
      makeSignedRequest({ [QSTASH_SIGNATURE_HEADER]: "bad" })
    );
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "");
    const c = await verifyQStashSignature(
      makeSignedRequest({ [QSTASH_SIGNATURE_HEADER]: "sig" })
    );

    expect([a.valid, b.valid, c.valid]).toEqual([false, false, false]);
    expect([a.attemptClass, b.attemptClass, c.attemptClass]).toEqual([
      "unsigned",
      "signed_invalid",
      "signed_invalid",
    ]);
  });
});
