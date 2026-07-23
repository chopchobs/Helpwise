/**
 * GET /api/webhook-deliveries?endpointId=&status=&take= — list delivery (DLQ view = status=DEAD)
 *
 * source of truth: docs/webhooks-contract.md § 5 (retry/DLQ) · § 7 (REST API)
 *
 * ⚠️ Tenant Isolation: tenantId จาก requireAgent() เท่านั้น; ทุก query ผ่าน tenantPrisma
 * ⚠️ ไม่ return `payload` (envelope มีเนื้อ message ของ ticket — ไม่จำเป็นต่อ DLQ UI
 *    และเป็น attack surface) และไม่แตะ endpoint.secret เด็ดขาด
 * Feature gate: webhooks — ปิด → 403 FEATURE_LOCKED
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { WebhookDeliveryStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import type { WebhookDeliveryDTO } from "@/types/webhook";

// =============================================================================
// VALIDATION SCHEMA
// =============================================================================

/** take: default 25, clamp เพดาน 50 (ไม่ reject — กัน UI พังเพราะขอเกิน) */
const listQuerySchema = z.object({
  endpointId: z.string().min(1).optional(),
  status: z.nativeEnum(WebhookDeliveryStatus, {
    message: "status ไม่ถูกต้อง",
  }).optional(),
  take: z.coerce
    .number()
    .int("take ต้องเป็นจำนวนเต็ม")
    .min(1, "take ต้องมากกว่า 0")
    .default(25)
    .transform((v) => Math.min(v, 50)),
});

// =============================================================================
// HELPERS
// =============================================================================

/** ⚠️ ห้ามเพิ่ม `payload` หรือ relation `endpoint` (มี secret) เข้ามาใน select นี้ */
const DELIVERY_SELECT = {
  id: true,
  endpointId: true,
  eventType: true,
  eventId: true,
  status: true,
  attemptCount: true,
  lastAttemptAt: true,
  responseStatus: true,
  responseBody: true,
  errorMessage: true,
  createdAt: true,
  updatedAt: true,
} as const;

type DeliveryRow = {
  id: string;
  endpointId: string;
  eventType: WebhookDeliveryDTO["eventType"];
  eventId: string;
  status: WebhookDeliveryStatus;
  attemptCount: number;
  lastAttemptAt: Date | null;
  responseStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toDTO(row: DeliveryRow): WebhookDeliveryDTO {
  return {
    id: row.id,
    endpointId: row.endpointId,
    eventType: row.eventType,
    eventId: row.eventId,
    status: row.status,
    attemptCount: row.attemptCount,
    lastAttemptAt: row.lastAttemptAt ? row.lastAttemptAt.toISOString() : null,
    responseStatus: row.responseStatus,
    responseBody: row.responseBody,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const FEATURE_LOCKED_MESSAGE =
  "Outbound webhooks ไม่รวมอยู่ใน plan ปัจจุบัน กรุณาอัปเกรด plan";

// =============================================================================
// GET /api/webhook-deliveries
// =============================================================================

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAgent({ roles: ["OWNER", "ADMIN"] });
    const { ctx } = session;

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

    const { searchParams } = request.nextUrl;
    const parsed = listQuerySchema.safeParse({
      endpointId: searchParams.get("endpointId") ?? undefined,
      status: searchParams.get("status") ?? undefined,
      take: searchParams.get("take") ?? 25,
    });

    if (!parsed.success) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "VALIDATION_ERROR",
            message: parsed.error.issues[0]?.message ?? "Query parameter ไม่ถูกต้อง",
          },
        },
        { status: 400 }
      );
    }

    const { endpointId, status, take } = parsed.data;

    // tenantPrisma inject tenantId ให้ทุก where — endpointId ที่ client ส่งมาจึงถูก
    // จำกัดอยู่ใน tenant นี้เสมอ (ข้าม tenant = ไม่เจอ ไม่ใช่ leak)
    const where: Prisma.WebhookDeliveryWhereInput = {};
    if (endpointId) where.endpointId = endpointId;
    if (status) where.status = status;

    const db = tenantPrisma(ctx.tenantId);
    const rows: DeliveryRow[] = await db.webhookDelivery.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      select: DELIVERY_SELECT,
    });

    const deliveries: WebhookDeliveryDTO[] = rows.map(toDTO);

    return NextResponse.json({ data: { deliveries }, error: null }, { status: 200 });
  } catch (err) {
    console.error("[GET /api/webhook-deliveries] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
