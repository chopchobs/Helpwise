/**
 * scripts/stripe-smoke.ts
 *
 * Standalone smoke-test script สำหรับ Stripe integration (Phase 18)
 * รันโดย Dev เท่านั้น ด้วย: `npm run smoke:stripe`
 *
 * ⚠️ ใช้ได้กับ Stripe TEST MODE เท่านั้น (sk_test_...) — script จะ refuse ทันที
 *    ถ้าเจอ sk_live_ เพื่อกัน accidental charge บน production account
 *
 * ตรวจ:
 *   1. Safety guard — ปฏิเสธ live key
 *   2. Connectivity — เรียก Stripe จริงเพื่อยืนยัน key ใช้งานได้
 *   3. Plan ↔ Price reconciliation — เทียบ Plan ใน DB กับ Stripe Price จริง
 *   4. Checkout session (ephemeral) — สร้าง session ทดสอบ ไม่ charge จริง
 *
 * Exit code: 0 = ผ่านทั้งหมด, 1 = มี check ที่ fail
 *
 * NOTE: ไฟล์นี้เป็น dev tooling — import @/lib/prisma ได้ (ไม่ดึง next/headers)
 * แต่ใช้ relative import เพื่อกัน path-alias resolution issue ตอนรันด้วย tsx ตรง ๆ
 */

import Stripe from "stripe";
import { prisma } from "../src/lib/prisma";

// =============================================================================
// HELPERS
// =============================================================================

/** mask Stripe key ให้เหลือแค่ prefix สำหรับ log — ห้าม log key เต็ม */
function maskKey(key: string): string {
  if (key.length <= 12) return "***";
  return `${key.slice(0, 11)}...${key.slice(-4)}`;
}

let passCount = 0;
let failCount = 0;

function pass(label: string, detail?: string): void {
  passCount++;
  console.log(`✅ PASS — ${label}${detail ? `: ${detail}` : ""}`);
}

function fail(label: string, detail?: string): void {
  failCount++;
  console.error(`❌ FAIL — ${label}${detail ? `: ${detail}` : ""}`);
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log("=== Stripe Live Smoke Test (TEST MODE ONLY) ===\n");

  // ─── ขั้นที่ 1: Safety guard ──────────────────────────────────────────────
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error("❌ STRIPE_SECRET_KEY is not set. กรุณาตั้งค่าใน .env ก่อนรัน smoke test");
    process.exit(1);
  }
  if (key.startsWith("sk_live_")) {
    console.error(
      "❌ STRIPE_SECRET_KEY ขึ้นต้นด้วย sk_live_ — smoke test ต้องใช้ test mode เท่านั้น (sk_test_)"
    );
    console.error("   refuse เพื่อกัน accidental charge บน production Stripe account");
    process.exit(1);
  }
  if (!key.startsWith("sk_test_")) {
    console.error(
      `❌ STRIPE_SECRET_KEY ไม่ใช่รูปแบบ sk_test_ ที่คาดไว้ (prefix: ${maskKey(key)}) — refuse`
    );
    process.exit(1);
  }
  console.log(`Using key: ${maskKey(key)} (test mode)\n`);

  const stripe = new Stripe(key, {
    apiVersion: "2026-05-27.dahlia",
    typescript: true,
  });

  // ─── ขั้นที่ 2: Connectivity + livemode check ────────────────────────────
  // balance.retrieve() คือ self-account call (ไม่ต้องใส่ account id) + มี field
  // livemode ตรง ๆ ใช้ยืนยันทั้ง connectivity และ test-mode ในครั้งเดียว
  try {
    const balance = await stripe.balance.retrieve();
    if (balance.livemode) {
      fail("Connectivity / Livemode check", "Stripe account อยู่ใน live mode ทั้งที่ key เป็น sk_test_ — ผิดปกติ, หยุด");
      printSummary();
      process.exit(1);
    }
    pass("Connectivity / Livemode check", "livemode=false (test mode confirmed)");
  } catch (err) {
    fail("Connectivity", err instanceof Error ? err.message : String(err));
    // ถ้า connectivity fail ทำขั้นต่อไปไม่ได้ — สรุปแล้วจบ
    printSummary();
    process.exit(1);
  }

  // ─── ขั้นที่ 3: Plan ↔ Price reconciliation ──────────────────────────────
  console.log("\n--- Plan ↔ Stripe Price reconciliation ---");

  const plans = await prisma.plan.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      displayName: true,
      pricePerMonth: true,
      pricePerYear: true,
      stripePriceIdMonthly: true,
      stripePriceIdYearly: true,
    },
  });

  if (plans.length === 0) {
    fail("Plan reconciliation", "ไม่พบ active plan ใน DB — รัน seed ก่อน");
  }

  // เก็บ priceId แรกที่ผ่านทุกเช็ค ไว้ใช้สร้าง checkout session ในขั้นที่ 4
  let checkoutPriceId: string | null = null;
  let checkoutPlanName: string | null = null;

  for (const plan of plans) {
    const checks: Array<{ interval: "monthly" | "yearly"; priceId: string | null; expectedAmount: number }> = [
      { interval: "monthly", priceId: plan.stripePriceIdMonthly, expectedAmount: plan.pricePerMonth },
      { interval: "yearly", priceId: plan.stripePriceIdYearly, expectedAmount: plan.pricePerYear },
    ];

    for (const check of checks) {
      if (!check.priceId) {
        console.log(`  (skip) ${plan.name} ${check.interval}: ไม่มี stripePriceId`);
        continue;
      }

      const label = `Plan "${plan.name}" (${plan.displayName}) ${check.interval} → ${check.priceId}`;

      try {
        const price = await stripe.prices.retrieve(check.priceId);

        // เช็ค active
        if (!price.active) {
          fail(label, "Price ไม่ active บน Stripe");
          continue;
        }

        // เช็ค unit_amount ตรงกับ DB (Int เทียบ Int ห้าม Float)
        if (price.unit_amount !== check.expectedAmount) {
          fail(
            label,
            `unit_amount mismatch: Stripe=${price.unit_amount} DB=${check.expectedAmount}`
          );
          continue;
        }

        // เช็ค recurring interval ถูก (month/year)
        const expectedInterval = check.interval === "monthly" ? "month" : "year";
        if (price.recurring?.interval !== expectedInterval) {
          fail(
            label,
            `recurring.interval mismatch: Stripe=${price.recurring?.interval ?? "none"} expected=${expectedInterval}`
          );
          continue;
        }

        pass(label, `active, unit_amount=${price.unit_amount}, interval=${price.recurring.interval}`);

        // เก็บ priceId แรกที่ผ่านไว้ใช้ checkout test
        if (!checkoutPriceId) {
          checkoutPriceId = check.priceId;
          checkoutPlanName = `${plan.name} (${check.interval})`;
        }
      } catch (err) {
        fail(label, err instanceof Error ? err.message : String(err));
      }
    }
  }

  // ─── ขั้นที่ 4: Checkout session (ephemeral, ไม่ charge) ──────────────────
  console.log("\n--- Ephemeral checkout session ---");

  if (!checkoutPriceId) {
    fail("Checkout session", "ไม่มี priceId ที่ reconcile ผ่าน — ข้าม checkout test");
  } else {
    const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "gethelpwise.xyz";
    const successUrl = `https://${rootDomain}/settings/billing?status=success`;
    const cancelUrl = `https://${rootDomain}/settings/billing?status=cancel`;

    try {
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: checkoutPriceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          tenantId: "smoke-test", // dummy — session นี้ไม่ถูก complete จริง
          source: "stripe-smoke-script",
        },
      });

      pass(
        "Checkout session",
        `plan=${checkoutPlanName} session.id=${session.id}`
      );
      console.log(`  session.url = ${session.url}`);
      console.log("  (session จะหมดอายุเองตาม Stripe default — ไม่ต้อง cleanup)");
    } catch (err) {
      fail("Checkout session", err instanceof Error ? err.message : String(err));
    }
  }

  printSummary();
  process.exit(failCount > 0 ? 1 : 0);
}

function printSummary(): void {
  console.log("\n=== Summary ===");
  console.log(`Passed: ${passCount}`);
  console.log(`Failed: ${failCount}`);
  if (failCount > 0) {
    console.log("\n❌ Smoke test FAILED — ดู FAIL entries ด้านบน");
  } else {
    console.log("\n✅ Smoke test PASSED");
  }
}

main()
  .catch((err) => {
    console.error("\n💥 Unexpected error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
