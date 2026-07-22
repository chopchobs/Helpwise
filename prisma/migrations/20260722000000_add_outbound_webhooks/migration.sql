-- Migration: add_outbound_webhooks
-- Phase 36 — Outbound Webhooks: WebhookEndpoint + WebhookDelivery (agent-only, tenant-scoped)
-- Safety class: GREEN — additive only (new enums + new tables + FK + indexes), zero-downtime
--   ไม่แตะตาราง/คอลัมน์เดิม ไม่ backfill ไม่ lock ตารางที่มีข้อมูลอยู่
-- Rollback: DROP TABLE "WebhookDelivery"; DROP TABLE "WebhookEndpoint";
--           DROP TYPE "WebhookDeliveryStatus"; DROP TYPE "WebhookEventType";

-- สร้าง enum WebhookEventType — ค่า = event ที่ subscribe ได้ (wire name อยู่ใน docs/webhooks-contract.md § 3)
-- TICKET_MESSAGE_CREATED ยิงเฉพาะ message ที่ visibility = PUBLIC (INTERNAL note ห้ามออกนอกระบบ)
CREATE TYPE "WebhookEventType" AS ENUM ('TICKET_CREATED', 'TICKET_STATUS_CHANGED', 'TICKET_ASSIGNED', 'TICKET_PRIORITY_CHANGED', 'TICKET_MESSAGE_CREATED');

-- สร้าง enum WebhookDeliveryStatus — PENDING/FAILED = ยัง retry ได้, DEAD = DLQ (replay ด้วยมือ)
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'DEAD');

-- สร้าง WebhookEndpoint — ปลายทาง webhook ต่อ tenant (secret เป็น plaintext ห้าม log/return ซ้ำ)
CREATE TABLE "WebhookEndpoint" (
    "id"                TEXT NOT NULL,
    "tenantId"          TEXT NOT NULL,
    "description"       TEXT NOT NULL,
    "url"               TEXT NOT NULL,
    "secret"            TEXT NOT NULL,
    "events"            "WebhookEventType"[],
    "enabled"           BOOLEAN NOT NULL DEFAULT true,
    "createdByMemberId" TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- สร้าง WebhookDelivery — 1 แถว = 1 event ที่ต้องส่งไป endpoint หนึ่ง (payload = snapshot ตอน enqueue)
CREATE TABLE "WebhookDelivery" (
    "id"             TEXT NOT NULL,
    "tenantId"       TEXT NOT NULL,
    "endpointId"     TEXT NOT NULL,
    "eventType"      "WebhookEventType" NOT NULL,
    "eventId"        TEXT NOT NULL,
    "payload"        JSONB NOT NULL,
    "status"         "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount"   INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt"  TIMESTAMP(3),
    "responseStatus" INTEGER,
    "responseBody"   TEXT,
    "errorMessage"   TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- index[tenantId] — tenant-scoped query ทั่วไป (@@index([tenantId]))
CREATE INDEX "WebhookEndpoint_tenantId_idx" ON "WebhookEndpoint"("tenantId");

-- unique (tenantId, id) — target ของ composite FK จาก WebhookDelivery (@@unique([tenantId, id]))
CREATE UNIQUE INDEX "WebhookEndpoint_tenantId_id_key" ON "WebhookEndpoint"("tenantId", "id");

-- index[tenantId] — tenant-scoped query ทั่วไป (@@index([tenantId]))
CREATE INDEX "WebhookDelivery_tenantId_idx" ON "WebhookDelivery"("tenantId");

-- index[tenantId, endpointId] — list delivery ของ endpoint หนึ่งใน tenant
CREATE INDEX "WebhookDelivery_tenantId_endpointId_idx" ON "WebhookDelivery"("tenantId", "endpointId");

-- index[tenantId, status] — DLQ view: WHERE tenantId = ? AND status = 'DEAD'
CREATE INDEX "WebhookDelivery_tenantId_status_idx" ON "WebhookDelivery"("tenantId", "status");

-- index[tenantId, eventId] — trace ทุก delivery ของ event เดียวกัน (1 event → หลาย endpoint)
CREATE INDEX "WebhookDelivery_tenantId_eventId_idx" ON "WebhookDelivery"("tenantId", "eventId");

-- FK → Tenant (onDelete: Cascade — ลบ tenant ลบ endpoint ด้วย)
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK → TenantMember (onDelete: SetNull — ลบ member ผู้สร้าง endpoint ยังอยู่, ผู้สร้างเป็น null)
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_createdByMemberId_fkey"
  FOREIGN KEY ("createdByMemberId") REFERENCES "TenantMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- FK → Tenant (onDelete: Cascade — ลบ tenant ลบ delivery ด้วย)
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite FK [tenantId, endpointId] → WebhookEndpoint[tenantId, id] (Phase 34 pattern):
--   DB บังคับว่า delivery ต้องอยู่ tenant เดียวกับ endpoint — สร้าง delivery ข้าม tenant ไม่ได้แม้ app พลาด
--   onDelete: Cascade — ลบ endpoint ลบ delivery history ของ endpoint นั้นด้วย
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_tenantId_endpointId_fkey"
  FOREIGN KEY ("tenantId", "endpointId") REFERENCES "WebhookEndpoint"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
