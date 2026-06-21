/**
 * POST /api/billing/portal — สร้าง Stripe Billing Portal Session
 *
 * ⚠️ SECURITY:
 *   - gate: OWNER หรือ ADMIN เท่านั้น (requireAgent roles check)
 *   - tenantId มาจาก ctx ของ requireAgent เท่านั้น — ห้ามรับจาก client
 *   - stripeCustomerId ค้นหาจาก Subscription row ของ tenant — ไม่รับจาก client
 *
 * Flow:
 *   1. requireAgent (OWNER/ADMIN)
 *   2. หา Subscription.stripeCustomerId ของ tenant (tenantPrisma)
 *   3. สร้าง Stripe Billing Portal Session
 *   4. return { data: { url }, error: null }
 */

import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { tenantPrisma } from "@/lib/tenant";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { stripe } from "@/lib/stripe";

// =============================================================================
// ROUTE HANDLER
// =============================================================================

export async function POST(_request: NextRequest): Promise<NextResponse> {
  // ─── ขั้นที่ 1: auth guard — OWNER/ADMIN เท่านั้น ─────────────────────────
  let agentSession: Awaited<ReturnType<typeof requireAgent>>;
  try {
    agentSession = await requireAgent({ roles: ["OWNER", "ADMIN"] });
  } catch (err) {
    const { data, error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data, error }, { status });
  }

  const { ctx } = agentSession;
  const tenantId = ctx.tenantId; // tenantId มาจาก middleware context เท่านั้น

  try {
    // ─── ขั้นที่ 2: หา stripeCustomerId จาก Subscription row ─────────────────
    // ใช้ tenantPrisma เพื่อ enforce tenant scope — ห้ามหา customer จาก tenant อื่น
    const db = tenantPrisma(tenantId);
    const subscription = await db.subscription.findFirst({
      where: {},
      select: { stripeCustomerId: true },
    });

    if (!subscription?.stripeCustomerId) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "NO_SUBSCRIPTION",
            message:
              "ยังไม่มีข้อมูล subscription สำหรับ workspace นี้ — กรุณาสมัคร plan ก่อน",
          },
        },
        { status: 400 }
      );
    }

    // ─── ขั้นที่ 3: ดึง tenant slug สำหรับ return_url ────────────────────────
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

    const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "gethelpwise.xyz";
    const returnUrl = `https://${tenant.slug}.${rootDomain}/settings/billing`;

    // ─── ขั้นที่ 4: สร้าง Stripe Billing Portal Session ─────────────────────
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: subscription.stripeCustomerId,
      return_url: returnUrl,
    });

    return NextResponse.json(
      { data: { url: portalSession.url }, error: null },
      { status: 200 }
    );
  } catch (err) {
    const isPrismaErr = err instanceof Prisma.PrismaClientKnownRequestError;
    // SECURITY: ไม่ log tenantId เต็ม + ไม่ log Stripe error ดิบ (อาจมี customerId/PII)
    const safeError = isPrismaErr
      ? `PrismaError:${(err as Prisma.PrismaClientKnownRequestError).code}`
      : (err instanceof Error ? err.message : String(err)).slice(0, 120);
    console.error("[billing/portal] Unexpected error:", {
      tenantRef: tenantId.slice(-8),
      error: safeError,
    });

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
