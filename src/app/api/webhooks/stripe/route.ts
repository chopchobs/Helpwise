/**
 * POST /api/webhooks/stripe/ — Stripe webhook receiver
 *
 * ⚠️ SECURITY CRITICAL:
 *   - ต้อง verify STRIPE_WEBHOOK_SECRET ทุกครั้งก่อนแตะ DB ใด ๆ
 *   - อ่าน raw body (req.text()) ไม่ใช่ req.json() — signature verify ต้องการ raw bytes
 *   - ไม่มี tenant context (proxy.ts skip /api/webhooks/ path) — cross-tenant system job
 *   - ห้าม trust tenantId จากใดใดใน Stripe payload โดยตรง
 *     → ใช้แค่เป็น hint เพื่อหา Subscription row ที่เราสร้างเอง
 *   - base prisma (ไม่ใช่ tenantPrisma) — intentional: webhook เป็น cross-tenant system job
 *     เหมือน sla-sweep และ inbound email webhook
 *
 * Idempotency: claim-first ด้วย ProcessedStripeEvent.eventId (@unique)
 *   create status="processing" → P2002 = เคยเห็น event นี้แล้ว → เช็ค status เดิม:
 *     - status="ok"               → process สำเร็จไปแล้วจริง → return 200 (duplicate)
 *     - status="error"/"processing" → รอบก่อน fail หรือ crash ค้าง → reclaim แล้ว reprocess
 *       (กัน "stuck-processing": ไม่งั้น Stripe retry จะเจอ P2002 แล้ว skip ถาวร → ไม่ sync)
 *   → success: update status="ok"
 *   → error: update status="error" + errorDetail แล้ว return 500 (Stripe retry → reprocess)
 *
 * Non-2xx policy:
 *   - 400: signature verify ล้ม / ไม่มี signature / ไม่ได้ตั้ง secret (นอก dev) — Stripe retry ไม่ช่วย
 *   - 200: duplicate event ที่ process สำเร็จแล้ว (status="ok") — ไม่ต้อง retry
 *   - 200: unknown event type (ไม่มีประโยชน์ retry)
 *   - 500: transient error หลัง verify สำเร็จ — Stripe จะ retry (พฤติกรรมถูกต้อง)
 */

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { stripe, syncSubscriptionFromStripe } from "@/lib/stripe";

// =============================================================================
// HELPERS
// =============================================================================

/**
 * ดึง subscriptionId จาก Invoice object
 * Stripe API 2026-05-27.dahlia เก็บ subscription ที่ parent.subscription_details.subscription
 * (ไม่ใช่ invoice.subscription แบบ API เก่า)
 */
function extractSubscriptionIdFromInvoice(invoice: Stripe.Invoice): string | null {
  const subDetails = invoice.parent?.subscription_details;
  if (!subDetails) return null;
  const sub = subDetails.subscription;
  if (typeof sub === "string") return sub;
  if (sub && typeof sub === "object" && "id" in sub) {
    return (sub as { id: string }).id;
  }
  return null;
}

// =============================================================================
// MAIN WEBHOOK HANDLER
// =============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ─── ขั้นที่ 1: อ่าน raw body — ต้อง raw สำหรับ signature verify ─────────
  // ห้ามใช้ req.json() เพราะ JSON.parse แล้ว string ไม่ตรงกับ signature
  const rawBody = await request.text();
  const sig = request.headers.get("stripe-signature");

  // ─── ขั้นที่ 2: verify signature ────────────────────────────────────────
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event: Stripe.Event;
  if (webhookSecret) {
    // SECURITY: secret ตั้งค่าแล้ว → ต้อง verify เสมอ ไม่มี fallback
    // ถ้าไม่มี signature header → reject ทันที (ห้ามตกไป JSON.parse — กัน bypass)
    if (!sig) {
      console.error("[stripe-webhook] Missing stripe-signature header — rejecting");
      return NextResponse.json(
        { data: null, error: "missing_signature" },
        { status: 400 }
      );
    }
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[stripe-webhook] Signature verification failed:", msg);
      return NextResponse.json(
        { data: null, error: "invalid_signature" },
        { status: 400 }
      );
    }
  } else {
    // SECURITY: ไม่มี secret → อนุญาตเฉพาะ NODE_ENV === "development" เป๊ะ
    // (production / staging / undefined ทั้งหมด reject — กัน bypass เงียบ ๆ
    //  เมื่อ NODE_ENV ไม่ได้ถูก set)
    if (process.env.NODE_ENV !== "development") {
      console.error(
        "[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set outside development — rejecting"
      );
      return NextResponse.json(
        { data: null, error: "webhook_not_configured" },
        { status: 400 }
      );
    }
    // dev only: warn แล้ว parse ตรง (สะดวกทดสอบ local ที่ไม่ได้ตั้ง secret)
    console.warn(
      "[stripe-webhook] STRIPE_WEBHOOK_SECRET not set — skipping signature verification (development only)"
    );
    try {
      event = JSON.parse(rawBody) as Stripe.Event;
    } catch {
      return NextResponse.json(
        { data: null, error: "invalid_payload" },
        { status: 400 }
      );
    }
  }

  // ─── ขั้นที่ 3: idempotency claim-first ─────────────────────────────────
  // สร้าง ProcessedStripeEvent status="processing" ก่อน process
  // P2002 (unique constraint บน eventId) = เคยเห็น event นี้แล้ว → เช็ค status เดิม
  // base prisma — ProcessedStripeEvent เป็น global model (ไม่มี tenantId)
  let claimId: string;
  try {
    const claim = await prisma.processedStripeEvent.create({
      data: {
        eventId: event.id,
        type: event.type,
        status: "processing",
      },
    });
    claimId = claim.id;
  } catch (claimErr) {
    if (
      claimErr instanceof Prisma.PrismaClientKnownRequestError &&
      claimErr.code === "P2002"
    ) {
      // เคยเห็น event นี้แล้ว — แยกระหว่าง "สำเร็จไปแล้ว" กับ "fail/ค้างต้อง retry"
      const existing = await prisma.processedStripeEvent.findUnique({
        where: { eventId: event.id },
        select: { id: true, status: true },
      });

      // process สำเร็จไปแล้วจริง → duplicate → skip (200)
      if (existing && existing.status === "ok") {
        return NextResponse.json(
          { data: { received: true, action: "duplicate" }, error: null },
          { status: 200 }
        );
      }

      // status="error"/"processing" (รอบก่อน fail หรือ crash ค้าง)
      // → reclaim slot แล้ว reprocess (กัน stuck-processing block Stripe retry ถาวร)
      if (existing) {
        await prisma.processedStripeEvent.update({
          where: { id: existing.id },
          data: { status: "processing", errorDetail: null },
        });
        claimId = existing.id;
      } else {
        // record หายไประหว่างทาง (rare) → 500 ให้ Stripe retry
        return new NextResponse("Internal Server Error", { status: 500 });
      }
    } else {
      // transient DB error ก่อนเริ่ม process → 500 ให้ Stripe retry
      console.error(
        "[stripe-webhook] Failed to claim idempotency slot:",
        claimErr instanceof Error ? claimErr.message : String(claimErr)
      );
      return new NextResponse("Internal Server Error", { status: 500 });
    }
  }

  // ─── ขั้นที่ 4: handle event ─────────────────────────────────────────────
  try {
    await handleStripeEvent(event);

    // success → update status="ok"
    await prisma.processedStripeEvent.update({
      where: { id: claimId },
      data: { status: "ok" },
    });

    return NextResponse.json(
      { data: { received: true }, error: null },
      { status: 200 }
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[stripe-webhook] Error processing event:", {
      eventId: event.id,
      type: event.type,
      error: errMsg,
    });

    // error detail ที่เก็บ: ห้าม leak sensitive data (Prisma error อาจมี param values)
    const safeErrDetail =
      err instanceof Prisma.PrismaClientKnownRequestError
        ? `PrismaError:${err.code}`
        : errMsg.slice(0, 200);

    try {
      await prisma.processedStripeEvent.update({
        where: { id: claimId },
        data: { status: "error", errorDetail: safeErrDetail },
      });
    } catch (saveErr) {
      console.error(
        "[stripe-webhook] Failed to update error record:",
        saveErr instanceof Error ? saveErr.message : String(saveErr)
      );
    }

    // 500 → Stripe จะ retry (ถูกต้องสำหรับ transient error)
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}

// =============================================================================
// EVENT HANDLER
// =============================================================================

/**
 * handleStripeEvent — dispatch event ตาม type
 * เรียกได้เฉพาะหลัง verify signature สำเร็จแล้ว
 */
async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    // subscription events — sync ตรง ๆ จาก event object
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      await syncSubscriptionFromStripe(sub);
      break;
    }

    // checkout session เสร็จ — ดึง subscription จาก Stripe + sync
    // ใส่ tenantIdHint จาก session.metadata ที่เราใส่ตอนสร้าง checkout
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;

      if (subscriptionId) {
        // retrieve subscription เพื่อให้ได้ข้อมูลครบ (items, status, period)
        const stripeSub = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ["items.data.price"],
        });
        const tenantIdHint = session.metadata?.tenantId ?? undefined;
        await syncSubscriptionFromStripe(stripeSub, { tenantIdHint });
      } else {
        // checkout แบบไม่มี subscription (เช่น one-time payment) — ignore
        console.info("[stripe-webhook] checkout.session.completed without subscription — ignoring");
      }
      break;
    }

    // invoice payment ล้ม → Stripe จะ set status เป็น past_due/unpaid
    // retrieve subscription แล้ว sync เพื่อ reflect สถานะใหม่
    // Stripe API 2026-05-27.dahlia: subscription อยู่ที่ invoice.parent.subscription_details.subscription
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = extractSubscriptionIdFromInvoice(invoice);
      if (subscriptionId) {
        const stripeSub = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ["items.data.price"],
        });
        await syncSubscriptionFromStripe(stripeSub);
      }
      break;
    }

    // invoice ชำระแล้ว → subscription กลับมา active
    // Stripe API 2026-05-27.dahlia: subscription อยู่ที่ invoice.parent.subscription_details.subscription
    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = extractSubscriptionIdFromInvoice(invoice);
      if (subscriptionId) {
        const stripeSub = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ["items.data.price"],
        });
        await syncSubscriptionFromStripe(stripeSub);
      }
      break;
    }

    // event อื่น ๆ ที่ยังไม่ handle — log แล้ว ignore (ยัง return 200)
    default: {
      console.info(`[stripe-webhook] Unhandled event type: ${event.type} — ignoring`);
      break;
    }
  }
}
