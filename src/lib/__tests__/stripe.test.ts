/**
 * src/lib/__tests__/stripe.test.ts
 * Unit tests สำหรับ mapStripeStatus — pure status mapper
 *
 * ⚠️ STRIPE TRAP: stripe.ts เรียก createStripeClient() ที่ module load
 * แก้ด้วย STRIPE_SECRET_KEY dummy ใน vitest.config.ts > test.env
 *
 * ทดสอบเฉพาะ mapStripeStatus — ไม่ test resolvePlanFromPriceId หรือ syncSubscriptionFromStripe
 * เพราะฟังก์ชันเหล่านั้น async + query DB (ไม่ใช่ pure logic)
 */

import { describe, it, expect } from "vitest";
import { mapStripeStatus } from "@/lib/stripe";
import { SubscriptionStatus } from "@prisma/client";
import type Stripe from "stripe";

// type alias ให้ชัดเจน
type StripeStatus = Stripe.Subscription["status"];

describe("mapStripeStatus", () => {
  it("'trialing' → TRIALING", () => {
    expect(mapStripeStatus("trialing")).toBe(SubscriptionStatus.TRIALING);
  });

  it("'active' → ACTIVE", () => {
    expect(mapStripeStatus("active")).toBe(SubscriptionStatus.ACTIVE);
  });

  it("'past_due' → PAST_DUE", () => {
    expect(mapStripeStatus("past_due")).toBe(SubscriptionStatus.PAST_DUE);
  });

  it("'canceled' → CANCELLED", () => {
    // หมายเหตุ: Stripe ใช้ 'canceled' (1 L), Helpwise DB ใช้ 'CANCELLED' (2 L)
    expect(mapStripeStatus("canceled")).toBe(SubscriptionStatus.CANCELLED);
  });

  it("'unpaid' → UNPAID", () => {
    expect(mapStripeStatus("unpaid")).toBe(SubscriptionStatus.UNPAID);
  });

  it("'incomplete' → UNPAID (payment ครั้งแรกยังไม่ผ่าน)", () => {
    expect(mapStripeStatus("incomplete")).toBe(SubscriptionStatus.UNPAID);
  });

  it("'incomplete_expired' → CANCELLED (Stripe ยกเลิกอัตโนมัติหลัง 23 ชม.)", () => {
    expect(mapStripeStatus("incomplete_expired")).toBe(SubscriptionStatus.CANCELLED);
  });

  it("'paused' → PAST_DUE (Helpwise ไม่มี PAUSED status — gate feature ไว้ก่อน)", () => {
    expect(mapStripeStatus("paused")).toBe(SubscriptionStatus.PAST_DUE);
  });

  // --- exhaustive coverage: ตรวจให้ครบทุก case เพื่อให้ remap ในอนาคตทำให้ test พัง ---

  it("ครอบคลุมทุก Stripe status ที่รู้จัก (no regression coverage)", () => {
    const knownMappings: Array<[StripeStatus, SubscriptionStatus]> = [
      ["trialing",           SubscriptionStatus.TRIALING],
      ["active",             SubscriptionStatus.ACTIVE],
      ["past_due",           SubscriptionStatus.PAST_DUE],
      ["canceled",           SubscriptionStatus.CANCELLED],
      ["unpaid",             SubscriptionStatus.UNPAID],
      ["incomplete",         SubscriptionStatus.UNPAID],
      ["incomplete_expired", SubscriptionStatus.CANCELLED],
      ["paused",             SubscriptionStatus.PAST_DUE],
    ];

    for (const [stripeStatus, expectedDb] of knownMappings) {
      expect(
        mapStripeStatus(stripeStatus),
        `mapStripeStatus('${stripeStatus}') ควรได้ ${expectedDb}`
      ).toBe(expectedDb);
    }
  });

  // --- security-minded tests: ตรวจว่า "danger" statuses ไม่ map เป็น ACTIVE ---

  it("incomplete ต้องไม่ map เป็น ACTIVE (feature ต้องถูกจำกัด)", () => {
    expect(mapStripeStatus("incomplete")).not.toBe(SubscriptionStatus.ACTIVE);
  });

  it("past_due ต้องไม่ map เป็น ACTIVE", () => {
    expect(mapStripeStatus("past_due")).not.toBe(SubscriptionStatus.ACTIVE);
  });

  it("canceled ต้องไม่ map เป็น ACTIVE", () => {
    expect(mapStripeStatus("canceled")).not.toBe(SubscriptionStatus.ACTIVE);
  });

  it("paused ต้องไม่ map เป็น ACTIVE (ควร gate feature)", () => {
    expect(mapStripeStatus("paused")).not.toBe(SubscriptionStatus.ACTIVE);
  });

  // --- ตรวจว่า active/trialing map ถูก (ไม่หลุดเป็น restricted status) ---

  it("active ต้องไม่ map เป็น CANCELLED หรือ UNPAID", () => {
    const result = mapStripeStatus("active");
    expect(result).not.toBe(SubscriptionStatus.CANCELLED);
    expect(result).not.toBe(SubscriptionStatus.UNPAID);
  });
});
