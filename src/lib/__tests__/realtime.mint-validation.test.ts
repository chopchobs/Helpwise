/**
 * realtime.mint-validation.test.ts — QA cross-cutting gate (Phase 35 Slice 3)
 *
 * ปิด coverage gap ด้าน security ที่ implementer ยังไม่ได้ครอบ:
 *   token.test.ts (ของ implementer) ทดสอบ happy path ผ่าน route โดย mockAgent ส่ง tenantId
 *   ที่เป็น cuid valid เสมอ → branch validation reject ที่ mintRealtimePresenceToken()
 *   (realtime.ts: `if (!TENANT_ID_FORMAT.test(tenantId)) throw`) ไม่เคยถูก execute.
 *
 * ⚠️ ทำไมสำคัญ (isolation-critical):
 *   guard นี้คือ "app-layer half" ของ defense-in-depth ที่ RLS migration อ้างถึง —
 *   ถ้า tenantId หลุด `:` / `%` / `_` / whitespace เข้า claim/topic prefix
 *   `tenant:{tenantId}:ticket:` จะเพี้ยน → เสี่ยง cross-tenant presence match.
 *   test นี้ lock invariant ว่า mint ปฏิเสธ injection vector เหล่านี้ (fail-closed).
 *
 * node-mode: validation throw ก่อนแตะ signing key/env → ไม่ต้องมี live Supabase.
 * (positive control 1 เคสยืนยันว่า cuid ปกติ mint ผ่าน)
 */

import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, exportPKCS8 } from "jose";
import { mintRealtimePresenceToken } from "@/lib/realtime";

const BASE_INPUT = { userId: "user-1", memberId: "member-1" };

beforeAll(async () => {
  // env สำหรับ positive control (negative cases throw ก่อนถึง env อยู่แล้ว)
  const kp = await generateKeyPair("ES256", { extractable: true });
  process.env.SUPABASE_REALTIME_JWT_PRIVATE_KEY = await exportPKCS8(kp.privateKey);
  process.env.SUPABASE_REALTIME_JWT_KID = "kid-validation-test";
  process.env.SUPABASE_URL = "https://ref.supabase.co";
});

describe("mintRealtimePresenceToken — tenantId format guard (defense-in-depth)", () => {
  // injection vector ที่ต้อง reject: อักขระที่ทำลายโครงสร้าง topic หรือเป็น LIKE wildcard
  const rejected: Array<[string, string]> = [
    ["`:` (คั่นโครงสร้าง topic — spoof ticket segment)", "acme:ticket:evil"],
    ["`%` (LIKE wildcard — match ทุก tenant ใน RLS)", "acme%"],
    ["`%` ล้วน (catch-all)", "%"],
    ["`_` (LIKE single-char wildcard)", "acme_x"],
    ["whitespace (space)", "acme evil"],
    ["tab/newline", "acme\n"],
    ["empty string", ""],
    ["เกิน 64 อักขระ", "a".repeat(65)],
    ["dot (นอก charset)", "acme.evil"],
    ["slash (นอก charset)", "acme/evil"],
    ["unicode/emoji", "acme😈"],
  ];

  it.each(rejected)(
    "reject tenantId ที่มี %s → throw (fail-closed, ไม่ mint token)",
    async (_label, tenantId) => {
      await expect(
        mintRealtimePresenceToken({ ...BASE_INPUT, tenantId })
      ).rejects.toThrow(/tenantId format/);
    }
  );

  it("positive control: cuid ปกติ ([a-zA-Z0-9-], ≤64) → mint ผ่าน", async () => {
    const res = await mintRealtimePresenceToken({
      ...BASE_INPUT,
      tenantId: "clzabc123def456ghi789jkl0",
    });
    expect(typeof res.token).toBe("string");
    expect(res.token.length).toBeGreaterThan(0);
    expect(typeof res.expiresAt).toBe("number");
  });

  it("boundary: ยาว 64 อักขระพอดี → ผ่าน (ขอบเขตบนไม่ off-by-one)", async () => {
    const res = await mintRealtimePresenceToken({
      ...BASE_INPUT,
      tenantId: "a".repeat(64),
    });
    expect(typeof res.token).toBe("string");
  });
});
