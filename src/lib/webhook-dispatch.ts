/**
 * src/lib/webhook-dispatch.ts
 * Producer ของ Outbound Webhooks (Phase 36) — จุดเดียวที่ ticket route เรียกเพื่อยิง event
 *
 * source of truth: docs/webhooks-contract.md § 2 (envelope) · § 3 (event mapping) · § 5 (queue)
 *
 * ⚠️ CRITICAL — Tenant Isolation:
 *   - รับ `db = tenantPrisma(tenantId)` เป็น argument (เหมือน lib/notifications.ts)
 *   - ไม่ resolve tenant context เอง — caller รับผิดชอบส่ง scoped client + tenantId ที่ verify แล้ว
 *   - ทุก query ในไฟล์นี้ผ่าน `db` เท่านั้น (ห้ามแตะ base prisma)
 *
 * ⚠️ Internal-note isolation:
 *   - TICKET_MESSAGE_CREATED ที่ visibility ≠ PUBLIC → return ทันที ไม่สร้าง delivery ใด ๆ
 *     (buildMessageEventPayload throw เป็นชั้นสุดท้าย แต่ต้องไม่ปล่อยให้ไปถึงตรงนั้น)
 */

import { randomUUID } from "crypto";
import { WebhookDeliveryStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import type { TenantScopedPrisma } from "@/lib/tenant";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import { publishWebhookDeliveryJob } from "@/lib/queue";
import {
  buildMessageEventPayload,
  buildTicketEventPayload,
  type MessageEventInput,
  type TicketEventInput,
} from "@/lib/webhooks";
import type { WebhookEnvelope } from "@/types/webhook";

// =============================================================================
// INPUT TYPES — eventId/tenantId เป็นของ dispatcher ไม่ใช่ของ caller
// =============================================================================

/** event ticket.* (created / status_changed / assigned / priority_changed) */
export type DispatchTicketEventInput = Omit<
  TicketEventInput,
  "eventId" | "tenantId"
>;

/** event ticket.message_created — `eventType` เป็น discriminant ของ union */
export type DispatchMessageEventInput = Omit<
  MessageEventInput,
  "eventId" | "tenantId"
> & {
  eventType: "TICKET_MESSAGE_CREATED";
};

export type DispatchWebhookEventInput =
  | DispatchTicketEventInput
  | DispatchMessageEventInput;

// =============================================================================
// dispatchWebhookEvent
// =============================================================================

/**
 * fan-out event หนึ่งตัวไปยังทุก endpoint ของ tenant ที่ subscribe event นั้น
 *
 * flow: หา endpoint → build envelope ครั้งเดียว (eventId เดียว) →
 *       สร้าง WebhookDelivery ต่อ endpoint → publish QStash job ต่อ delivery
 *
 * @param db       tenant-scoped Prisma client (tenantId inject อัตโนมัติผ่าน extension)
 * @param tenantId tenant เจ้าของ event — ต้องมาจาก context ที่ verify แล้วเท่านั้น
 *                 (ใส่ลง envelope + job payload ที่ worker จะใช้ scope ต่อ)
 * @param tenantPlan plan ปัจจุบันของ tenant (ctx.plan) — ส่งมาเพื่อกัน query plan ซ้ำใน
 *                 hasFeature(); ไม่ส่ง = hasFeature query DB เอง (route ที่ไม่มี tenant context)
 */
export async function dispatchWebhookEvent(
  db: TenantScopedPrisma,
  tenantId: string,
  input: DispatchWebhookEventInput,
  tenantPlan?: string
): Promise<void> {
  try {
    // 1. Internal-note isolation — กันตั้งแต่ก่อนแตะ DB
    //    INTERNAL note ห้ามออกนอกระบบทุกช่องทาง รวมถึง webhook
    if (
      input.eventType === "TICKET_MESSAGE_CREATED" &&
      input.message.visibility !== "PUBLIC"
    ) {
      return;
    }

    // 2. Feature gate — จุดเดียวของทั้งระบบ (ไม่กระจายไป call site)
    //    เหตุผล: call site ลืมเช็คไม่ได้ + tenant ที่ plan ตกชั้นหยุดส่งทันที
    //    โดยไม่ต้องไล่แก้ทุก route. ปิด = เงียบ ๆ (ไม่สร้าง delivery ไม่ publish)
    if (!(await hasFeature(tenantId, FEATURE_KEYS.WEBHOOKS, tenantPlan))) {
      return;
    }

    // 3. endpoint ที่เปิดอยู่ + subscribe event นี้ (tenant-scoped ผ่าน db)
    const endpoints = await db.webhookEndpoint.findMany({
      where: { enabled: true, events: { has: input.eventType } },
      select: { id: true },
    });
    // ไม่มีใคร subscribe → ไม่สร้าง delivery, ไม่ publish
    if (endpoints.length === 0) return;

    // 4. eventId ตัวเดียวต่อ event แล้ว build envelope ครั้งเดียวใช้ร่วมทุก endpoint
    //    (receiver ที่ subscribe หลาย endpoint dedupe ด้วย id เดียวกันได้ — § 2)
    const eventId = `evt_${randomUUID()}`;
    const envelope: WebhookEnvelope =
      input.eventType === "TICKET_MESSAGE_CREATED"
        ? buildMessageEventPayload({ ...input, eventId, tenantId })
        : buildTicketEventPayload({ ...input, eventId, tenantId });

    // 5. delivery หนึ่งแถวต่อ endpoint — payload เป็น snapshot (retry ไม่ re-query)
    //    fan-out ขนาน (dispatcher อยู่ใน critical path ของ request แล้ว → ไม่จ่าย
    //    round-trip QStash เรียงกัน). allSettled ไม่ใช่ all: endpoint หนึ่งล้ม
    //    ต้องไม่ทำให้ตัวที่เหลือถูกข้าม (partial fan-out ของ loop เดิม)
    const results = await Promise.allSettled(
      endpoints.map(async (endpoint) => {
        // tenantId ถูก inject โดย extension → cast ผ่าน Omit; ใช้ scalar endpointId
        // ห้าม { endpoint: { connect } } (extension reject relation-connect)
        const data: Omit<
          Prisma.WebhookDeliveryUncheckedCreateInput,
          "tenantId"
        > = {
          endpointId: endpoint.id,
          eventType: input.eventType,
          eventId,
          payload: envelope as unknown as Prisma.InputJsonValue,
          status: WebhookDeliveryStatus.PENDING,
          attemptCount: 0,
        };
        const delivery = await db.webhookDelivery.create({
          data: data as Prisma.WebhookDeliveryUncheckedCreateInput,
          select: { id: true },
        });

        // 6. ส่งต่อให้ worker ยิงจริง (job ผอม — worker โหลดจาก DB เอง)
        await publishWebhookDeliveryJob({ tenantId, deliveryId: delivery.id });
      })
    );

    // 7. log เฉพาะตัวที่ล้ม — ระบุ endpoint.id เท่านั้น (ห้าม url/secret/payload)
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        console.error(
          `[webhook-dispatch] endpoint ${endpoints[i].id} failed:`,
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
        );
      }
    });
  } catch (err) {
    // ⚠️ Tradeoff โดยเจตนา: webhook เป็น side-effect ไม่ใช่ critical path ของการสร้าง/แก้ ticket
    //    → dispatch ล้มต้องไม่ทำให้ request ของ agent พัง (swallow + log)
    //    ผลข้างเคียงที่ยอมรับ: event อาจ "หาย" เงียบเมื่อ DB/QStash ล่ม จึงต้อง log ไว้ให้ตามได้
    //    ห้าม log secret/payload ลงตรงนี้ (log เฉพาะ message ของ error)
    console.error(
      "[webhook-dispatch] dispatch failed:",
      err instanceof Error ? err.message : String(err)
    );
  }
}
