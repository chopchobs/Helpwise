/**
 * POST /api/billing/checkout — สร้าง Stripe Checkout Session
 *
 * ⚠️ SECURITY:
 *   - gate: OWNER หรือ ADMIN เท่านั้น (requireAgent roles check)
 *   - ห้ามรับ priceId หรือ tenantId จาก client
 *     → priceId ค้นหาจาก Plan ใน DB ตาม planName+interval ที่ client ส่งมา
 *     → tenantId มาจาก ctx ของ requireAgent เท่านั้น
 *   - stripeCustomerId เก็บใน DB (Subscription row) ไม่ใช่ client
 *   - ใส่ tenantId ใน session.metadata + subscription_data.metadata เพื่อให้ webhook resolve ได้
 *
 * Flow:
 *   1. requireAgent (OWNER/ADMIN)
 *   2. validate body: { planName, interval }
 *   3. lookup Plan → priceId ตาม interval
 *   4. get-or-create Stripe Customer (stripeCustomerId ใน Subscription row)
 *   5. สร้าง Checkout Session
 *   6. return { data: { url }, error: null }
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { tenantPrisma } from "@/lib/tenant";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { stripe } from "@/lib/stripe";
import { checkRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";

// =============================================================================
// REQUEST SCHEMA
// =============================================================================

const CheckoutBodySchema = z.object({
  // รับ planName + interval — ไม่รับ priceId/tenantId จาก client
  planName: z.string().min(1, "planName ต้องไม่ว่าง"),
  interval: z.enum(["monthly", "yearly"]),
});

// =============================================================================
// ROUTE HANDLER
// =============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ─── ขั้นที่ 1: auth guard — OWNER/ADMIN เท่านั้น ─────────────────────────
  let agentSession: Awaited<ReturnType<typeof requireAgent>>;
  try {
    agentSession = await requireAgent({ roles: ["OWNER", "ADMIN"] });
  } catch (err) {
    const { data, error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data, error }, { status });
  }

  const { ctx, member } = agentSession;
  const tenantId = ctx.tenantId; // tenantId มาจาก middleware context เท่านั้น

  // ─── ขั้นที่ 1.5: rate limit ตาม tenantId ────────────────────────────────
  const rl = await checkRateLimit({
    key: rateLimitKey("billing-checkout", tenantId),
    limit: 10,
    windowSeconds: 60,
  });
  if (!rl.allowed) {
    return rateLimitResponse(rl.retryAfterSeconds);
  }

  // ─── ขั้นที่ 2: validate body ─────────────────────────────────────────────
  let body: z.infer<typeof CheckoutBodySchema>;
  try {
    const raw = await request.json();
    body = CheckoutBodySchema.parse(raw);
  } catch (err) {
    const msg = err instanceof z.ZodError
      ? err.issues.map((e) => e.message).join("; ")
      : "Invalid request body";
    return NextResponse.json(
      { data: null, error: { code: "VALIDATION_ERROR", message: msg } },
      { status: 400 }
    );
  }

  const { planName, interval } = body;

  try {
    // ─── ขั้นที่ 3: lookup Plan ตาม planName ─────────────────────────────────
    // Plan เป็น global model — ใช้ base prisma (ไม่ใช่ tenantPrisma)
    const plan = await prisma.plan.findFirst({
      where: { name: planName, isActive: true },
      select: {
        id: true,
        name: true,
        displayName: true,
        stripePriceIdMonthly: true,
        stripePriceIdYearly: true,
      },
    });

    if (!plan) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "PLAN_NOT_FOUND",
            message: `ไม่พบ plan "${planName}" หรือ plan ถูก deactivate`,
          },
        },
        { status: 400 }
      );
    }

    // เลือก priceId ตาม interval
    const priceId =
      interval === "monthly"
        ? plan.stripePriceIdMonthly
        : plan.stripePriceIdYearly;

    if (!priceId) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "PLAN_PRICE_NOT_CONFIGURED",
            message: `Plan "${planName}" ยังไม่มี Stripe Price ID สำหรับ interval "${interval}" — กรุณาติดต่อ admin`,
          },
        },
        { status: 400 }
      );
    }

    // ─── ขั้นที่ 4: get-or-create Stripe Customer ────────────────────────────
    // ตรวจ Subscription row ของ tenant นี้ก่อน
    const db = tenantPrisma(tenantId);
    const existingSub = await db.subscription.findFirst({
      where: {},
      select: { stripeCustomerId: true },
    });

    let customerId: string;

    if (existingSub?.stripeCustomerId) {
      // มี customer แล้ว — ใช้เลย (ไม่สร้างซ้ำ)
      customerId = existingSub.stripeCustomerId;
    } else {
      // สร้าง Stripe Customer ใหม่ + ใส่ tenantId ใน metadata เพื่อ trace ได้
      const customer = await stripe.customers.create({
        metadata: { tenantId }, // เราใส่เองตอน checkout — ไม่ได้รับจาก client
      });
      customerId = customer.id;

      // upsert Subscription row เพื่อเก็บ stripeCustomerId
      // ใช้ scalar tenantId ใน create (ห้าม tenant:{connect} — tenantPrisma extension)
      await db.subscription.upsert({
        where: { tenantId },
        create: {
          tenantId, // scalar tenantId — ไม่ใช่ tenant:{connect}
          stripeCustomerId: customerId,
        },
        update: {
          stripeCustomerId: customerId,
        },
      });
    }

    // ─── ขั้นที่ 5: ดึง tenant slug สำหรับ success/cancel URL ───────────────
    // query tenant slug จาก tenantId (ctx ไม่มี slug โดยตรง)
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true },
    });

    if (!tenant) {
      return NextResponse.json(
        {
          data: null,
          error: { code: "TENANT_NOT_FOUND", message: "ไม่พบ tenant" },
        },
        { status: 400 }
      );
    }

    const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "helpwise.com";
    const baseUrl = `https://${tenant.slug}.${rootDomain}`;
    const successUrl = `${baseUrl}/settings/billing?status=success`;
    const cancelUrl = `${baseUrl}/settings/billing?status=cancel`;

    // ─── ขั้นที่ 6: สร้าง Checkout Session ───────────────────────────────────
    // ใส่ tenantId ใน metadata ทั้ง session และ subscription_data
    // เพื่อให้ webhook (checkout.session.completed) resolve tenant ได้แม้ stripeCustomerId ยังไม่ถูกเก็บ
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        tenantId, // ห้ามรับจาก client — ใส่ตอนนี้เองจาก ctx
        planName,
        interval,
        memberId: member.id, // audit trail: ใครกด checkout
      },
      subscription_data: {
        metadata: {
          tenantId, // ซ้ำที่ subscription level เพื่อให้ syncSubscriptionFromStripe resolve ได้
        },
      },
    });

    return NextResponse.json(
      { data: { url: session.url }, error: null },
      { status: 200 }
    );
  } catch (err) {
    // Stripe API error หรือ DB error ที่ไม่คาดหมาย
    const isPrismaErr = err instanceof Prisma.PrismaClientKnownRequestError;
    // SECURITY: ไม่ log tenantId/planName เต็ม + ไม่ log Stripe error message ดิบ
    // (อาจมี customerId/priceId/PII) — เก็บแค่ tenant ref ท้าย 8 ตัว + error code/ตัดสั้น
    const safeError = isPrismaErr
      ? `PrismaError:${(err as Prisma.PrismaClientKnownRequestError).code}`
      : (err instanceof Error ? err.message : String(err)).slice(0, 120);
    console.error("[billing/checkout] Unexpected error:", {
      tenantRef: tenantId.slice(-8),
      error: safeError,
    });

    // ไม่ expose internal error detail สู่ client
    return NextResponse.json(
      {
        data: null,
        error: {
          code: "INTERNAL_ERROR",
          message: isPrismaErr ? "Database error" : "Internal server error",
        },
      },
      { status: 500 }
    );
  }
}
