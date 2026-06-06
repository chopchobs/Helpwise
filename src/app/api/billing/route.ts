/**
 * GET /api/billing — ดึงข้อมูล subscription + plan สำหรับ Billing UI
 *
 * ⚠️ SECURITY:
 *   - gate: OWNER หรือ ADMIN เท่านั้น (billing เป็น admin-only)
 *   - tenantId มาจาก ctx ของ requireAgent เท่านั้น — ห้ามรับจาก client
 *   - ห้าม expose stripeCustomerId, stripeSubscriptionId, stripePriceId ออก client
 *   - money ส่งเป็น Int (satang/cents) — frontend format เอง
 *
 * Response:
 *   { data: { subscription, currentPlanName, plans, entitlements }, error }
 *   subscription = null ถ้า tenant ยังไม่มี Subscription row
 */

import { NextResponse } from "next/server";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import type { BillingData, BillingPlan, BillingSubscription } from "@/types/billing";

// =============================================================================
// GET /api/billing — Billing summary สำหรับ admin UI
// =============================================================================

export async function GET(): Promise<NextResponse> {
  try {
    // ─── 1. Auth guard — OWNER/ADMIN เท่านั้น ─────────────────────────────
    const session = await requireAgent({ roles: ["OWNER", "ADMIN"] });
    const { ctx } = session;
    const tenantId = ctx.tenantId; // tenantId มาจาก middleware context — ไม่รับจาก client

    const db = tenantPrisma(tenantId);

    // ─── 2. Query parallel: subscription (tenant-scoped) + tenant plan + active plans ─
    // subscription และ tenant plan query ผ่าน tenantPrisma (tenant-scoped)
    // active plans query ผ่าน base prisma (Plan เป็น global model — ไม่มี tenantId)
    const [subscriptionRow, tenantRow, activePlans] = await Promise.all([
      // subscription ของ tenant นี้ — tenant-scoped
      // select เฉพาะ field ที่จำเป็นต่อ UI ห้าม select stripe* id
      db.subscription.findFirst({
        where: {},
        select: {
          status: true,
          planName: true,
          currentPriceAmount: true,
          currency: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          trialEndAt: true,
          // ไม่ select: stripeCustomerId, stripeSubscriptionId, stripePriceId
        },
      }),

      // tenant plan ปัจจุบัน — ใช้ base prisma เพราะ Tenant ไม่มี tenantId scope
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          plan: {
            select: {
              displayName: true,
            },
          },
        },
      }),

      // รายการ plan ที่ active ทั้งหมด — global model ใช้ base prisma
      // select boolean ของ stripe price id แทน id จริง (security: ไม่ leak priceId)
      prisma.plan.findMany({
        where: { isActive: true },
        orderBy: { pricePerMonth: "asc" },
        select: {
          name: true,
          displayName: true,
          pricePerMonth: true,
          pricePerYear: true,
          maxAgents: true,
          maxSlaPolicies: true,
          features: true,
          // ส่งแค่ boolean ว่ามี priceId ไหม — ไม่ส่ง priceId เอง
          stripePriceIdMonthly: true,
          stripePriceIdYearly: true,
        },
      }),
    ]);

    // ─── 3. คำนวณ entitlements ────────────────────────────────────────────
    // pass ctx.plan เพื่อกัน extra query ใน hasFeature()
    const slaPoliciesEnabled = await hasFeature(
      tenantId,
      FEATURE_KEYS.SLA_POLICIES,
      ctx.plan
    );

    // ─── 4. Build subscription shape (sanitized) ──────────────────────────
    let subscription: BillingSubscription | null = null;

    if (subscriptionRow) {
      subscription = {
        status: subscriptionRow.status,
        planName: subscriptionRow.planName,
        currentPriceAmount: subscriptionRow.currentPriceAmount,
        currency: subscriptionRow.currency,
        // แปลง Date → ISO string; null คงไว้
        currentPeriodEnd: subscriptionRow.currentPeriodEnd
          ? subscriptionRow.currentPeriodEnd.toISOString()
          : null,
        cancelAtPeriodEnd: subscriptionRow.cancelAtPeriodEnd,
        trialEndAt: subscriptionRow.trialEndAt
          ? subscriptionRow.trialEndAt.toISOString()
          : null,
      };
    }

    // ─── 5. Build plans array (sanitized) ────────────────────────────────
    // แปลง stripePriceId* เป็น boolean — ไม่ expose id จริงออก client
    const plans: BillingPlan[] = activePlans.map((plan) => ({
      name: plan.name,
      displayName: plan.displayName,
      pricePerMonth: plan.pricePerMonth,
      pricePerYear: plan.pricePerYear,
      maxAgents: plan.maxAgents,
      maxSlaPolicies: plan.maxSlaPolicies,
      features: plan.features,
      hasMonthlyPrice: plan.stripePriceIdMonthly !== null,
      hasYearlyPrice: plan.stripePriceIdYearly !== null,
    }));

    // ─── 6. Build response ────────────────────────────────────────────────
    const data: BillingData = {
      subscription,
      // fallback ถ้า tenant.plan หายไป (defensive) ไม่ควรเกิดใน production
      currentPlanName: tenantRow?.plan.displayName ?? "Unknown",
      plans,
      entitlements: {
        slaPoliciesEnabled,
      },
    };

    return NextResponse.json({ data, error: null }, { status: 200 });
  } catch (err) {
    // toAuthErrorResponse จัดการ AuthError (401/403) + fallback 500 สำหรับ error อื่น
    // ไม่ expose stack trace หรือ detail ภายในสู่ client
    console.error(
      "[GET /api/billing] Unexpected error:",
      err instanceof Error ? err.message : String(err)
    );
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
