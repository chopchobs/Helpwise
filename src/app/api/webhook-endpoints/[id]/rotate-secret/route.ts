/**
 * POST /api/webhook-endpoints/:id/rotate-secret — หมุน HMAC signing secret
 *
 * source of truth: docs/webhooks-contract.md § 7 (REST API + audit actions)
 *
 * ⚠️ Tenant Isolation: tenantId จาก requireAgent() เท่านั้น; endpoint ของ tenant อื่น → 404
 * ⚠️ Secret: plaintext ใหม่ return ครั้งเดียว — ห้าม log / ห้ามใส่ใน AuditLog
 *    (delivery ที่ยัง retry ค้างจะถูกเซ็นด้วย secret ใหม่ — receiver ต้องอัปเดตทันที)
 * Feature gate: webhooks — ปิด → 403 FEATURE_LOCKED
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import { audit } from "@/lib/audit";
import { generateWebhookSecret } from "@/lib/webhooks";

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

    // tenant-scoped — endpoint ของ tenant อื่น → 404 (ห้าม leak ว่ามีอยู่ที่อื่น)
    // ⚠️ select แค่ id — ไม่ดึง secret เดิมออกมาโดยไม่จำเป็น
    const existing = await db.webhookEndpoint.findFirst({
      where: { id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ webhook endpoint ที่ต้องการหมุน secret" } },
        { status: 404 }
      );
    }

    const plaintextSecret = generateWebhookSecret();

    await db.webhookEndpoint.update({
      where: { id },
      data: { secret: plaintextSecret },
      select: { id: true },
    });

    // audit — บันทึกแค่ว่า rotate แล้ว ห้ามมี secret (ทั้งเก่าและใหม่)
    void audit.log({
      tenantId: ctx.tenantId,
      actor: { type: "member", memberId: member.id },
      targetType: "webhook_endpoint",
      targetId: id,
      action: "webhook.secret_rotated",
      after: { rotated: true },
    });

    return NextResponse.json({ data: { plaintextSecret }, error: null }, { status: 200 });
  } catch (err) {
    console.error("[POST /api/webhook-endpoints/:id/rotate-secret] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
