/**
 * PATCH  /api/webhook-endpoints/:id — แก้ description/url/events/enabled
 * DELETE /api/webhook-endpoints/:id — ลบ endpoint (delivery cascade ตาม FK)
 *
 * source of truth: docs/webhooks-contract.md § 6 (SSRF) · § 7 (REST API + audit actions)
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId จาก requireAgent() เท่านั้น ห้ามรับจาก client
 *   - tenantPrisma scope ทำให้ endpoint ของ tenant อื่น → 404 (ห้ามบอกว่ามีอยู่ที่อื่น)
 * ⚠️ Secret: ห้าม select / return / audit field `secret`
 * Feature gate: webhooks — ปิด → 403 FEATURE_LOCKED
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { WebhookEventType } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import { audit } from "@/lib/audit";
import { validateWebhookUrl } from "@/lib/webhooks";
import type { WebhookEndpointDTO } from "@/types/webhook";

// =============================================================================
// VALIDATION SCHEMA
// =============================================================================

const patchEndpointSchema = z
  .object({
    description: z
      .string()
      .min(1, "description ห้ามว่าง")
      .max(80, "description ยาวเกิน 80 ตัวอักษร")
      .optional(),
    url: z.string().min(1, "url ห้ามว่าง").optional(),
    events: z
      .array(z.nativeEnum(WebhookEventType))
      .min(1, "ต้องเลือก event อย่างน้อย 1 รายการ")
      .optional(),
    enabled: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "ต้องระบุ field อย่างน้อยหนึ่งอย่างที่ต้องการเปลี่ยน",
  });

// =============================================================================
// HELPERS
// =============================================================================

/** select ที่ปลอดภัย — ⚠️ ห้ามเพิ่ม `secret` เข้ามาเด็ดขาด */
const ENDPOINT_SELECT = {
  id: true,
  description: true,
  url: true,
  events: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface EndpointRow {
  id: string;
  description: string;
  url: string;
  events: WebhookEventType[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toDTO(row: EndpointRow): WebhookEndpointDTO {
  return {
    id: row.id,
    description: row.description,
    url: row.url,
    events: row.events,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const INVALID_URL_MESSAGE =
  "URL ปลายทางไม่ได้รับอนุญาต — ต้องเป็น https ที่เข้าถึงได้จากอินเทอร์เน็ตสาธารณะ";

const FEATURE_LOCKED_MESSAGE =
  "Outbound webhooks ไม่รวมอยู่ใน plan ปัจจุบัน กรุณาอัปเกรด plan";

function sameEvents(a: WebhookEventType[], b: WebhookEventType[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

// =============================================================================
// PATCH /api/webhook-endpoints/:id
// =============================================================================

export async function PATCH(
  request: NextRequest,
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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { data: null, error: { code: "INVALID_JSON", message: "Request body ต้องเป็น JSON" } },
        { status: 400 }
      );
    }

    const parsed = patchEndpointSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "VALIDATION_ERROR",
            message: parsed.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง",
          },
        },
        { status: 400 }
      );
    }

    const input = parsed.data;

    // url ที่แก้ต้องผ่าน SSRF guard ซ้ำ (§ 6) — reason log ฝั่ง server เท่านั้น
    if (input.url !== undefined) {
      const validation = validateWebhookUrl(input.url);
      if (!validation.ok) {
        console.warn("[PATCH /api/webhook-endpoints/:id] rejected url:", validation.reason);
        return NextResponse.json(
          {
            data: null,
            error: { code: "INVALID_WEBHOOK_URL", message: INVALID_URL_MESSAGE },
          },
          { status: 400 }
        );
      }
    }

    const db = tenantPrisma(ctx.tenantId);

    // endpoint ของ tenant อื่น → findFirst ไม่เจอ → 404 (ห้าม leak ว่ามีอยู่ที่อื่น)
    const existing: EndpointRow | null = await db.webhookEndpoint.findFirst({
      where: { id },
      select: ENDPOINT_SELECT,
    });
    if (!existing) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ webhook endpoint ที่ต้องการแก้ไข" } },
        { status: 404 }
      );
    }

    const updated: EndpointRow = await db.webhookEndpoint.update({
      where: { id },
      data: {
        ...(input.description !== undefined && { description: input.description }),
        ...(input.url !== undefined && { url: input.url }),
        ...(input.events !== undefined && { events: input.events }),
        ...(input.enabled !== undefined && { enabled: input.enabled }),
      },
      select: ENDPOINT_SELECT,
    });

    // audit — เก็บเฉพาะ field ที่เปลี่ยนจริง, ไม่มี secret
    const before: Record<string, Prisma.InputJsonValue> = {};
    const after: Record<string, Prisma.InputJsonValue> = {};
    if (input.description !== undefined && input.description !== existing.description) {
      before.description = existing.description;
      after.description = input.description;
    }
    if (input.url !== undefined && input.url !== existing.url) {
      before.url = existing.url;
      after.url = input.url;
    }
    if (input.events !== undefined && !sameEvents(input.events, existing.events)) {
      before.events = existing.events;
      after.events = input.events;
    }
    if (input.enabled !== undefined && input.enabled !== existing.enabled) {
      before.enabled = existing.enabled;
      after.enabled = input.enabled;
    }

    void audit.log({
      tenantId: ctx.tenantId,
      actor: { type: "member", memberId: member.id },
      targetType: "webhook_endpoint",
      targetId: id,
      action: "webhook.endpoint_updated",
      before,
      after,
    });

    return NextResponse.json(
      { data: { endpoint: toDTO(updated) }, error: null },
      { status: 200 }
    );
  } catch (err) {
    console.error("[PATCH /api/webhook-endpoints/:id] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}

// =============================================================================
// DELETE /api/webhook-endpoints/:id
// =============================================================================

export async function DELETE(
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

    // tenant-scoped ก่อนลบ — endpoint ของ tenant อื่น → 404
    const existing: EndpointRow | null = await db.webhookEndpoint.findFirst({
      where: { id },
      select: ENDPOINT_SELECT,
    });
    if (!existing) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ webhook endpoint ที่ต้องการลบ" } },
        { status: 404 }
      );
    }

    // WebhookDelivery cascade ตาม composite FK ที่ database กำหนด
    await db.webhookEndpoint.delete({ where: { id } });

    // audit — snapshot ก่อนลบ (ไม่มี secret)
    void audit.log({
      tenantId: ctx.tenantId,
      actor: { type: "member", memberId: member.id },
      targetType: "webhook_endpoint",
      targetId: id,
      action: "webhook.endpoint_deleted",
      before: {
        description: existing.description,
        url: existing.url,
        events: existing.events,
      },
    });

    return NextResponse.json({ data: { deleted: true }, error: null }, { status: 200 });
  } catch (err) {
    console.error("[DELETE /api/webhook-endpoints/:id] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
