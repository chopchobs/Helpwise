/**
 * webhook.ts — Type definitions สำหรับ Outbound Webhooks (Phase 36)
 * shared ระหว่าง backend (lib/route/worker) และ frontend settings UI
 *
 * source of truth: docs/webhooks-contract.md § 2 (envelope), § 3 (event mapping), § 7 (DTO)
 *
 * ⚠️ WebhookEndpointDTO **ห้ามมี field `secret`** — plaintext secret return ออก API
 *    ครั้งเดียวตอน create/rotate เท่านั้น (ห้ามอยู่ใน list/get DTO, ห้าม log)
 */

import type {
  MessageVisibility,
  TicketPriority,
  TicketStatus,
  WebhookDeliveryStatus,
  WebhookEventType,
} from "@prisma/client";
import type { ApiError } from "@/types/ticket";

// re-export enum type จาก Prisma — ให้ lib/webhooks.ts (pure lib, ไม่แตะ prisma client)
// อ้าง type เดียวกับ schema ได้จากที่เดียว โดยไม่ต้อง import "@prisma/client" เอง
export type { WebhookDeliveryStatus, WebhookEventType };

// =============================================================================
// EVENT NAMES (§ 3)
// =============================================================================

/** wire name ที่ส่งใน envelope field `type` — ตรงกับตาราง § 3 */
export type WebhookWireEventName =
  | "ticket.created"
  | "ticket.status_changed"
  | "ticket.assigned"
  | "ticket.priority_changed"
  | "ticket.message_created";

/** event ฝั่ง ticket.* (ทุกตัวยกเว้น message_created ซึ่งมี data shape คนละแบบ) */
export type TicketWebhookEventType = Exclude<
  WebhookEventType,
  "TICKET_MESSAGE_CREATED"
>;

// =============================================================================
// PAYLOAD ENVELOPE (§ 2)
// =============================================================================

/** ticket snapshot ที่ส่งใน event ticket.* — เฉพาะ field ที่ contract ระบุ (ห้ามใส่ PII เกินนี้) */
export interface WebhookTicketSnapshot {
  id: string;
  ticketNumber: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  assigneeMemberId: string | null;
  requesterContactId: string;
  channel: string;
  createdAt: string;
  updatedAt: string;
}

/** field ที่เปลี่ยน — มีเฉพาะ status_changed / assigned / priority_changed */
export interface WebhookTicketChanges {
  status?: { from: TicketStatus; to: TicketStatus };
  assigneeMemberId?: { from: string | null; to: string | null };
  priority?: { from: TicketPriority; to: TicketPriority };
}

export interface WebhookTicketEventData {
  ticket: WebhookTicketSnapshot;
  changes?: WebhookTicketChanges;
}

/** ticket แบบย่อที่แนบไปกับ event message_created */
export interface WebhookMessageTicketRef {
  id: string;
  ticketNumber: number;
  subject: string;
}

export interface WebhookMessageEventData {
  ticket: WebhookMessageTicketRef;
  message: {
    id: string;
    /** ต้องเป็น "PUBLIC" เสมอ — INTERNAL note ห้ามออกนอกระบบทุกช่องทาง */
    visibility: Extract<MessageVisibility, "PUBLIC">;
    authorType: "agent" | "contact";
    /** TenantMember.id หรือ Contact.id ตาม authorType */
    authorId: string;
    body: string;
    createdAt: string;
  };
}

/** envelope ที่ส่งเป็น request body จริง (raw body ที่ใช้เซ็น signature) */
export interface WebhookEnvelope<
  TData = WebhookTicketEventData | WebhookMessageEventData,
> {
  /** = WebhookDelivery.eventId — receiver ใช้ dedupe */
  id: string;
  type: WebhookWireEventName;
  /** ISO8601 UTC — เวลาที่ event เกิด */
  createdAt: string;
  tenantId: string;
  data: TData;
}

// =============================================================================
// DTO (§ 7) — date เป็น ISO string เสมอ (serialize ผ่าน JSON)
// =============================================================================

/** ⚠️ ห้ามเพิ่ม field `secret` เข้ามาใน DTO นี้เด็ดขาด */
export interface WebhookEndpointDTO {
  id: string;
  description: string;
  url: string;
  events: WebhookEventType[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDeliveryDTO {
  id: string;
  endpointId: string;
  eventType: WebhookEventType;
  eventId: string;
  status: WebhookDeliveryStatus;
  attemptCount: number;
  lastAttemptAt: string | null;
  responseStatus: number | null;
  /** truncate 500 ตัวแล้วจาก backend — กัน SSRF ใช้ระบบเป็น proxy อ่านข้อมูลภายใน */
  responseBody: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Response shape: GET /api/webhook-endpoints */
export interface WebhookEndpointListResponse {
  data: { endpoints: WebhookEndpointDTO[] } | null;
  error: ApiError | null;
}

/** Response shape: POST /api/webhook-endpoints และ POST /api/webhook-endpoints/:id/rotate-secret
 *  plaintextSecret เห็นได้ครั้งเดียว */
export interface WebhookEndpointCreateResponse {
  data: { endpoint: WebhookEndpointDTO; plaintextSecret: string } | null;
  error: ApiError | null;
}

/** Response shape: GET /api/webhook-deliveries */
export interface WebhookDeliveryListResponse {
  data: { deliveries: WebhookDeliveryDTO[] } | null;
  error: ApiError | null;
}
