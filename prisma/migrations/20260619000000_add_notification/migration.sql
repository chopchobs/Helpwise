-- Migration: add_notification
-- Phase 28 Slice 2 — Notification: in-app notification สำหรับ agent (agent-audience, tenant-scoped)
-- Safety class: GREEN — additive only (new enum + new table + indexes + RLS policy), zero-downtime
-- Rollback: DROP TABLE "Notification"; DROP TYPE "NotificationType";

-- สร้าง enum NotificationType — Slice 2 ใช้ค่าเดียว (SLA types เพิ่มทีหลังใน Slice 3)
CREATE TYPE "NotificationType" AS ENUM ('TICKET_ASSIGNED');

-- สร้าง Notification — tenant-scoped, recipient = TenantMember (agent)
CREATE TABLE "Notification" (
  "id"        TEXT NOT NULL,
  "tenantId"  TEXT NOT NULL,
  "memberId"  TEXT NOT NULL,
  "type"      "NotificationType" NOT NULL,
  "ticketId"  TEXT,
  "readAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- FK → Tenant (onDelete: Cascade — ลบ tenant ลบ Notification ด้วย)
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK → TenantMember (onDelete: Cascade — ลบ member (recipient) ลบ Notification ด้วย)
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "TenantMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK → Ticket (onDelete: Cascade — ลบ ticket ลบ Notification ที่อ้างถึงด้วย)
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- index[tenantId, memberId] — query notification ของ recipient ใน tenant
CREATE INDEX "Notification_tenantId_memberId_idx" ON "Notification"("tenantId", "memberId");

-- index[tenantId, memberId, readAt] — query unread (readAt IS NULL)
CREATE INDEX "Notification_tenantId_memberId_readAt_idx" ON "Notification"("tenantId", "memberId", "readAt");

-- ============================================================================
-- RLS (Phase 27 precedent): Notification เก็บ agent-audience data ที่ผูกกับ
-- ticket/recipient → จัดอยู่กลุ่ม sensitive เช่นเดียวกับ Tag/TicketTag
-- → ENABLE + POLICY + FORCE (บังคับ RLS แม้กับ owner role)
-- Policy idempotent: DROP POLICY IF EXISTS ก่อน CREATE
-- ============================================================================
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Notification";
CREATE POLICY tenant_isolation ON "Notification"
  USING (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  );
ALTER TABLE "Notification" FORCE ROW LEVEL SECURITY;
