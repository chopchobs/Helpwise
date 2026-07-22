/**
 * POST /api/webhook-deliveries/:id/replay — re-enqueue delivery ที่ยังไม่สำเร็จ (DLQ)
 *
 * source of truth: docs/webhooks-contract.md § 5 (replay semantics) · § 7 (REST API)
 *
 * ⚠️ Tenant Isolation: tenantId จาก requireAgent() เท่านั้น; delivery ของ tenant อื่น → 404
 * replay ใช้ payload snapshot เดิม (ไม่ re-query) — receiver dedupe ด้วย eventId
 * Feature gate: webhooks — ปิด → 403 FEATURE_LOCKED
 */

import { NextRequest, NextResponse } from "next/server";
import { WebhookDeliveryStatus } from "@prisma/client";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import { audit } from "@/lib/audit";
import { publishWebhookDeliveryJob } from "@/lib/queue";

const FEATURE_LOCKED_MESSAGE =
  "Outbound webhooks ไม่รวมอยู่ใน plan ปัจจุบัน กรุณาอัปเกรด plan";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;

    const session = await requireAgent({ roles: ["OWNER", "ADMIN"] });
    const { ctx, member } = session;

    const featureEnabled = await hasFeature(
      ctx.tenantId,
      FEATURE_KEYS.WEBHOOKS,
      ctx.plan
    );
    if (!featureEnabled) {
      return NextResponse.json(
        {
          data: null,
          error: { code: "FEATURE_LOCKED", message: FEATURE_LOCKED_MESSAGE },
        },
        { status: 403 }
      );
    }

    const db = tenantPrisma(ctx.tenantId);

    // tenant-scoped — delivery ของ tenant อื่น → 404 (ห้าม leak ว่ามีอยู่ที่อื่น)
    // ⚠️ ไม่ select payload — replay ใช้ snapshot ใน DB โดยตรง ไม่ต้องอ่านออกมา
    const existing = await db.webhookDelivery.findFirst({
      where: { id },
      select: { id: true, status: true },
    });
    if (!existing) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ webhook delivery ที่ต้องการ replay" } },
        { status: 404 }
      );
    }

    // สำเร็จไปแล้ว → ไม่ยิงซ้ำ (§ 5)
    if (existing.status === WebhookDeliveryStatus.SUCCEEDED) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "ALREADY_SUCCEEDED",
            message: "delivery นี้ส่งสำเร็จไปแล้ว ไม่สามารถ replay ได้",
          },
        },
        { status: 409 }
      );
    }

    // reset สถานะกลับเป็น PENDING แล้วค่อย enqueue ใหม่ (payload เดิม ไม่ re-query)
    await db.webhookDelivery.update({
      where: { id },
      data: {
        status: WebhookDeliveryStatus.PENDING,
        attemptCount: 0,
        errorMessage: null,
        responseStatus: null,
        responseBody: null,
      },
      select: { id: true },
    });

    await publishWebhookDeliveryJob({ tenantId: ctx.tenantId, deliveryId: id });

    void audit.log({
      tenantId: ctx.tenantId,
      actor: { type: "member", memberId: member.id },
      targetType: "webhook_delivery",
      targetId: id,
      action: "webhook.delivery_replayed",
      before: { status: existing.status },
      after: { status: WebhookDeliveryStatus.PENDING },
    });

    return NextResponse.json({ data: { replayed: true }, error: null }, { status: 200 });
  } catch (err) {
    console.error("[POST /api/webhook-deliveries/:id/replay] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
