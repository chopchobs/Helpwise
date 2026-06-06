/**
 * src/lib/stripe.ts
 * Stripe client singleton + subscription sync utilities
 *
 * ⚠️ SECURITY / BILLING RULES:
 *   - STRIPE_SECRET_KEY ดึงจาก env เท่านั้น — ห้าม hardcode
 *   - ห้าม query Stripe API นอกจากใน: webhook, checkout, portal
 *   - money เก็บเป็น Int (satang/cents) ห้าม Float ทุกกรณี
 *   - plan เปลี่ยน → update Tenant.planId + ล้าง Redis cache เสมอ
 *   - 1 Tenant = 1 Subscription เสมอ (Subscription.tenantId @unique)
 *   - บันทึก AuditLog ทุก subscription/plan change
 */

import Stripe from "stripe";
import { Prisma, SubscriptionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { redis, tenantSlugCacheKey } from "@/lib/redis";
import { audit } from "@/lib/audit";

// =============================================================================
// STRIPE CLIENT SINGLETON
// =============================================================================

const globalForStripe = global as typeof globalThis & {
  stripe?: Stripe;
};

function createStripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set. กรุณาตั้งค่าใน .env");
  }
  return new Stripe(key, {
    // pin API version เพื่อกันพฤติกรรมเปลี่ยนเมื่อ Stripe ออก version ใหม่
    apiVersion: "2026-05-27.dahlia",
    typescript: true,
  });
}

export const stripe: Stripe =
  globalForStripe.stripe ?? createStripeClient();

if (process.env.NODE_ENV !== "production") {
  globalForStripe.stripe = stripe;
}

// =============================================================================
// STATUS MAPPING
// =============================================================================

/**
 * แปลง Stripe.Subscription.status → SubscriptionStatus enum ใน DB
 *
 * Stripe statuses ที่ต้องพิจารณา:
 *   - trialing        → TRIALING
 *   - active          → ACTIVE
 *   - past_due        → PAST_DUE  (payment ล้มเหลว แต่ยังพยายาม retry)
 *   - canceled        → CANCELLED (ยกเลิกแล้ว)
 *   - unpaid          → UNPAID    (หยุด retry แล้ว ต้องชำระเองใหม่)
 *   - incomplete      → UNPAID    (สร้าง subscription แต่ payment ครั้งแรกยังไม่ผ่าน)
 *   - incomplete_expired → CANCELLED (incomplete ค้างนานเกิน 23 ชม. Stripe ยกเลิกเอง)
 *   - paused          → PAST_DUE  (Stripe รองรับ pause แต่ Helpwise ไม่มี PAUSED status
 *                                   map เป็น PAST_DUE เพราะ feature บาง feature ควรจำกัด)
 */
export function mapStripeStatus(s: Stripe.Subscription["status"]): SubscriptionStatus {
  switch (s) {
    case "trialing":
      return SubscriptionStatus.TRIALING;
    case "active":
      return SubscriptionStatus.ACTIVE;
    case "past_due":
      return SubscriptionStatus.PAST_DUE;
    case "canceled":
      return SubscriptionStatus.CANCELLED;
    case "unpaid":
      return SubscriptionStatus.UNPAID;
    case "incomplete":
      // payment ครั้งแรกยังไม่ผ่าน — ถือเป็น UNPAID (feature ถูกจำกัด)
      return SubscriptionStatus.UNPAID;
    case "incomplete_expired":
      // Stripe ยกเลิก subscription อัตโนมัติ — map เป็น CANCELLED
      return SubscriptionStatus.CANCELLED;
    case "paused":
      // Stripe pause feature — Helpwise ไม่มี PAUSED status
      // map เป็น PAST_DUE เพื่อ gate feature ไว้ก่อน (ดีกว่าปล่อยเต็มสิทธิ์)
      return SubscriptionStatus.PAST_DUE;
    default: {
      // defensive fallback กัน Stripe เพิ่ม status ใหม่ในอนาคต
      const _exhaustive: never = s;
      console.warn("[stripe] Unknown subscription status, defaulting to UNPAID:", _exhaustive);
      return SubscriptionStatus.UNPAID;
    }
  }
}

// =============================================================================
// PLAN RESOLUTION
// =============================================================================

/**
 * lookup Plan จาก Stripe Price ID
 * ค้นหาใน stripePriceIdMonthly หรือ stripePriceIdYearly
 * คืน null ถ้าไม่พบ (plan ยังไม่ผูก Stripe Price ID)
 */
export async function resolvePlanFromPriceId(
  priceId: string
): Promise<{ id: string; name: string } | null> {
  const plan = await prisma.plan.findFirst({
    where: {
      OR: [
        { stripePriceIdMonthly: priceId },
        { stripePriceIdYearly: priceId },
      ],
    },
    select: { id: true, name: true },
  });
  return plan;
}

// =============================================================================
// SYNC RESULT TYPE
// =============================================================================

export interface SyncSubscriptionSummary {
  tenantId: string;
  status: SubscriptionStatus;
  planName: string | null;
}

// =============================================================================
// CORE SYNC FUNCTION
// =============================================================================

/**
 * syncSubscriptionFromStripe — หัวใจของ Stripe → DB sync
 *
 * เรียกจาก webhook handler เมื่อมี subscription event
 * ไม่เรียกจากที่อื่น (ห้าม query Stripe API นอกจาก webhook/checkout/portal)
 *
 * Flow:
 *   1. resolve tenantId จาก stripeCustomerId บน Subscription row
 *      → fallback: opts.tenantIdHint หรือ stripeSub.metadata.tenantId
 *   2. resolve plan จาก price.id
 *   3. upsert Subscription row (scalar tenantId, ห้าม tenant:{connect})
 *   4. ถ้า plan เปลี่ยน → update Tenant.planId + ล้าง Redis cache + audit
 *   5. audit subscription.created / updated / canceled
 *
 * @param stripeSub Stripe.Subscription object (จาก event.data.object หรือ retrieve)
 * @param opts.tenantIdHint tenantId จาก session/subscription metadata (เป็น hint เท่านั้น)
 */
export async function syncSubscriptionFromStripe(
  stripeSub: Stripe.Subscription,
  opts?: { tenantIdHint?: string }
): Promise<SyncSubscriptionSummary> {
  const customerId =
    typeof stripeSub.customer === "string"
      ? stripeSub.customer
      : stripeSub.customer?.id;

  // ─── ขั้นที่ 1: resolve tenantId ─────────────────────────────────────────
  // ลำดับ: ค้นหา stripeCustomerId ใน Subscription row ก่อน
  // → fallback: hint จาก metadata ที่เราใส่ตอน checkout (session.metadata.tenantId)
  // ห้ามรับ tenantId จาก client หรือ payload ที่ไม่ได้ verify — tenant ต้องมาจาก DB เสมอ
  let tenantId: string | null = null;

  // หา owner ของ stripeCustomerId จาก DB (source of truth ที่ trust ได้)
  let ownerTenantIdByCustomer: string | null = null;
  if (customerId) {
    const existingSub = await prisma.subscription.findFirst({
      where: { stripeCustomerId: customerId },
      select: { tenantId: true },
    });
    if (existingSub) {
      ownerTenantIdByCustomer = existingSub.tenantId;
      tenantId = existingSub.tenantId;
    }
  }

  // fallback 1: hint จาก opts (ส่งมาจาก checkout.session.completed)
  if (!tenantId && opts?.tenantIdHint) {
    tenantId = opts.tenantIdHint;
  }

  // fallback 2: metadata บน subscription เอง (เราใส่ตอน checkout)
  if (!tenantId && stripeSub.metadata?.tenantId) {
    tenantId = stripeSub.metadata.tenantId;
  }

  if (!tenantId) {
    throw new Error(
      `[stripe] Cannot resolve tenantId for subscription ${stripeSub.id} / customer ${customerId}`
    );
  }

  // SECURITY (defense-in-depth): ถ้า DB มี owner ของ stripeCustomerId นี้อยู่แล้ว
  // tenantId ที่ได้ต้องตรงกับ owner เสมอ — กัน forged metadata/hint ชี้ subscription
  // ไป tenant อื่น (มีผลเฉพาะถ้า signature ถูก bypass แต่กันไว้เป็นชั้นสุดท้าย)
  if (ownerTenantIdByCustomer && ownerTenantIdByCustomer !== tenantId) {
    throw new Error(
      `[stripe] tenantId mismatch for customer ${customerId}: resolved ${tenantId} but customer is owned by another tenant`
    );
  }

  // ─── ขั้นที่ 2: resolve plan จาก priceId ─────────────────────────────────
  const priceItem = stripeSub.items.data[0];
  const priceId = priceItem?.price?.id ?? null;
  const priceAmount = priceItem?.price?.unit_amount ?? 0; // Int (satang/cents) อยู่แล้ว
  const currency = priceItem?.price?.currency ?? "thb";

  let newPlanId: string | null = null;
  let newPlanName: string | null = null;

  if (priceId) {
    const plan = await resolvePlanFromPriceId(priceId);
    if (plan) {
      newPlanId = plan.id;
      newPlanName = plan.name;
    }
  }

  const newStatus = mapStripeStatus(stripeSub.status);

  // unix timestamp → Date (Stripe ส่ง seconds)
  // Stripe API 2026-05-27.dahlia: current_period_start/end ย้ายไปอยู่บน SubscriptionItem
  // (items.data[0]) ไม่ใช่ top-level Subscription อีกต่อไป
  const periodStart = priceItem?.current_period_start
    ? new Date(priceItem.current_period_start * 1000)
    : null;
  const periodEnd = priceItem?.current_period_end
    ? new Date(priceItem.current_period_end * 1000)
    : null;
  const canceledAt = stripeSub.canceled_at
    ? new Date(stripeSub.canceled_at * 1000)
    : null;
  const trialEnd = stripeSub.trial_end
    ? new Date(stripeSub.trial_end * 1000)
    : null;

  // ─── ขั้นที่ 3: อ่าน subscription เดิม (เพื่อเปรียบ before/after) ─────────
  const existingSubRow = await prisma.subscription.findUnique({
    where: { tenantId },
    select: { status: true, planName: true },
  });

  const isNew = !existingSubRow;

  // ─── ขั้นที่ 4: upsert Subscription row ──────────────────────────────────
  // ใช้ scalar tenantId ใน create (ห้าม tenant: { connect } เพราะ Prisma reject)
  // currentPriceAmount เป็น Int (ห้าม Float) — Stripe ส่งมาเป็น smallest-unit integer
  const upsertData: Prisma.SubscriptionUncheckedCreateInput = {
    tenantId,
    status: newStatus,
    stripeSubscriptionId: stripeSub.id,
    stripeCustomerId: customerId ?? undefined,
    stripePriceId: priceId ?? undefined,
    currentPriceAmount: priceAmount ?? 0, // Int เสมอ ห้าม Float
    currency,
    currentPeriodStart: periodStart ?? undefined,
    currentPeriodEnd: periodEnd ?? undefined,
    cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
    canceledAt: canceledAt ?? undefined,
    trialEndAt: trialEnd ?? undefined,
    planName: newPlanName ?? undefined,
  };

  await prisma.subscription.upsert({
    where: { tenantId },
    create: upsertData,
    update: {
      status: newStatus,
      stripeSubscriptionId: stripeSub.id,
      stripeCustomerId: customerId ?? undefined,
      stripePriceId: priceId ?? undefined,
      currentPriceAmount: priceAmount ?? 0,
      currency,
      currentPeriodStart: periodStart ?? undefined,
      currentPeriodEnd: periodEnd ?? undefined,
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
      canceledAt: canceledAt ?? undefined,
      trialEndAt: trialEnd ?? undefined,
      planName: newPlanName ?? undefined,
    },
  });

  // ─── ขั้นที่ 5: ถ้า plan เปลี่ยน → update Tenant.planId + ล้าง Redis cache ─
  if (newPlanId) {
    // ดึง tenant ปัจจุบันเพื่อเปรียบ planId + เอา slug มาล้าง cache
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true, planId: true },
    });

    if (tenant && tenant.planId !== newPlanId) {
      const oldPlanId = tenant.planId;

      // update Tenant.planId ให้ตรงกับ subscription ปัจจุบัน
      await prisma.tenant.update({
        where: { id: tenantId },
        data: { planId: newPlanId },
      });

      // ล้าง Redis cache เพราะ middleware/proxy cache plan ไว้ใน blob tenant:slug:{slug}
      // cache error ไม่ควร fail request — wrap try/catch
      try {
        await redis.del(tenantSlugCacheKey(tenant.slug));
      } catch (cacheErr) {
        console.warn(
          "[stripe] Redis cache invalidation failed (non-fatal):",
          cacheErr instanceof Error ? cacheErr.message : String(cacheErr)
        );
      }

      // audit: plan เปลี่ยน
      void audit.log({
        tenantId,
        actor: { type: "system" },
        targetType: "tenant",
        targetId: tenantId,
        action: "tenant.plan_changed",
        before: { planId: oldPlanId },
        after: { planId: newPlanId, planName: newPlanName },
      });
    }
  }

  // ─── ขั้นที่ 6: audit subscription event ──────────────────────────────────
  // ห้าม log PII/sensitive — เก็บแค่ status/planName/priceId/amount
  const auditAfter = {
    status: newStatus,
    planName: newPlanName,
    stripePriceId: priceId,
    currentPriceAmount: priceAmount, // Int
  };
  const auditBefore = existingSubRow
    ? { status: existingSubRow.status, planName: existingSubRow.planName }
    : undefined;

  if (isNew) {
    void audit.log({
      tenantId,
      actor: { type: "system" },
      targetType: "subscription",
      targetId: tenantId,
      action: "subscription.created",
      after: auditAfter,
    });
  } else if (newStatus === SubscriptionStatus.CANCELLED) {
    void audit.log({
      tenantId,
      actor: { type: "system" },
      targetType: "subscription",
      targetId: tenantId,
      action: "subscription.canceled",
      before: auditBefore,
      after: auditAfter,
    });
  } else {
    void audit.log({
      tenantId,
      actor: { type: "system" },
      targetType: "subscription",
      targetId: tenantId,
      action: "subscription.updated",
      before: auditBefore,
      after: auditAfter,
    });
  }

  return { tenantId, status: newStatus, planName: newPlanName };
}
