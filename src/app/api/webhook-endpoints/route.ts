/**
 * GET  /api/webhook-endpoints — list outbound webhook endpoints ของ tenant
 * POST /api/webhook-endpoints — สร้าง endpoint ใหม่ (plaintext secret เห็นครั้งเดียว)
 *
 * source of truth: docs/webhooks-contract.md § 6 (SSRF) · § 7 (REST API + audit actions)
 *
 * ⚠️ Tenant Isolation: tenantId จาก requireAgent() เท่านั้น ห้ามรับจาก client
 * ⚠️ Secret: `secret` ห้ามอยู่ใน select ของ list / DTO / audit / log เด็ดขาด
 * Feature gate: webhooks — ปิด → 403 FEATURE_LOCKED
 * Audience: requireAgent({ roles: ["OWNER","ADMIN"] }) — agent-only, portal ห้ามแตะ
 *
 * ⚠️ ไฟล์ route ของ Next ห้าม export อย่างอื่นนอกจาก HTTP method → helper เป็น local
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { WebhookEventType } from "@prisma/client";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import { audit } from "@/lib/audit";
import { generateWebhookSecret, validateWebhookUrl } from "@/lib/webhooks";
import type { WebhookEndpointDTO } from "@/types/webhook";

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const createEndpointSchema = z.object({
  description: z
    .string()
    .min(1, "description ห้ามว่าง")
    .max(80, "description ยาวเกิน 80 ตัวอักษร"),
  url: z.string().min(1, "url ห้ามว่าง"),
  events: z
    .array(z.nativeEnum(WebhookEventType))
    .min(1, "ต้องเลือก event อย่างน้อย 1 รายการ"),
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

function toDTO(row: {
  id: string;
  description: string;
  url: string;
  events: WebhookEventType[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}): WebhookEndpointDTO {
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

/** ข้อความ URL ที่ไม่ผ่าน SSRF guard — รวม ๆ ไม่บอกใบ้โครงสร้างเครือข่ายภายใน */
const INVALID_URL_MESSAGE =
  "URL ปลายทางไม่ได้รับอนุญาต — ต้องเป็น https ที่เข้าถึงได้จากอินเทอร์เน็ตสาธารณะ";

const FEATURE_LOCKED_MESSAGE =
  "Outbound webhooks ไม่รวมอยู่ใน plan ปัจจุบัน กรุณาอัปเกรด plan";

// =============================================================================
// GET /api/webhook-endpoints — list
// =============================================================================

export async function GET(): Promise<NextResponse> {
  try {
    const session = await requireAgent({ roles: ["OWNER", "ADMIN"] });
    const { ctx } = session;

    // feature gate: webhooks ต้องเปิดอยู่ตาม plan ของ tenant
    const enabled = await hasFeature(ctx.tenantId, FEATURE_KEYS.WEBHOOKS, ctx.plan);
    if (!enabled) {
      return NextResponse.json(
        {
          data: null,
          error: { code: "FEATURE_LOCKED", message: FEATURE_LOCKED_MESSAGE },
        },
        { status: 403 }
      );
    }

    const db = tenantPrisma(ctx.tenantId);
    const rows = await db.webhookEndpoint.findMany({
      orderBy: { createdAt: "desc" },
      // ⚠️ ไม่ดึง secret — plaintext เห็นได้เฉพาะตอน create/rotate
      select: ENDPOINT_SELECT,
    });

    const endpoints: WebhookEndpointDTO[] = rows.map(toDTO);

    return NextResponse.json({ data: { endpoints }, error: null }, { status: 200 });
  } catch (err) {
    console.error("[GET /api/webhook-endpoints] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}

// =============================================================================
// POST /api/webhook-endpoints — สร้าง endpoint ใหม่
// =============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAgent({ roles: ["OWNER", "ADMIN"] });
    const { ctx, member } = session;

    const enabled = await hasFeature(ctx.tenantId, FEATURE_KEYS.WEBHOOKS, ctx.plan);
    if (!enabled) {
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

    const parsed = createEndpointSchema.safeParse(body);
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

    // SSRF guard ชั้น create-time (§ 6) — reason ละเอียด log ฝั่ง server เท่านั้น
    // ห้ามส่ง reason กลับ client เพราะบอกใบ้โครงสร้างเครือข่ายภายใน
    const validation = validateWebhookUrl(input.url);
    if (!validation.ok) {
      console.warn("[POST /api/webhook-endpoints] rejected url:", validation.reason);
      return NextResponse.json(
        {
          data: null,
          error: { code: "INVALID_WEBHOOK_URL", message: INVALID_URL_MESSAGE },
        },
        { status: 400 }
      );
    }

    // secret plaintext เก็บลง DB + return ครั้งเดียว — ห้าม log / audit
    const plaintextSecret = generateWebhookSecret();

    const db = tenantPrisma(ctx.tenantId);
    const created = await db.webhookEndpoint.create({
      // create ผ่าน tenantPrisma ใช้ scalar tenantId (ห้าม tenant:{connect})
      data: {
        tenantId: ctx.tenantId,
        description: input.description,
        url: input.url,
        secret: plaintextSecret,
        events: input.events,
        createdByMemberId: member.id,
      },
      select: ENDPOINT_SELECT,
    });

    const endpoint = toDTO(created);

    // audit — after ห้ามมี secret
    void audit.log({
      tenantId: ctx.tenantId,
      actor: { type: "member", memberId: member.id },
      targetType: "webhook_endpoint",
      targetId: endpoint.id,
      action: "webhook.endpoint_created",
      after: {
        description: endpoint.description,
        url: endpoint.url,
        events: endpoint.events,
      },
    });

    return NextResponse.json(
      { data: { endpoint, plaintextSecret }, error: null },
      { status: 201 }
    );
  } catch (err) {
    console.error("[POST /api/webhook-endpoints] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
