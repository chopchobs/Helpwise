-- Migration: add_tenant_ticket_counter
-- Phase 21 — Atomic ticket number counter per tenant: additive only (new column + backfill)
-- Safety class: GREEN — zero-downtime, no lock on existing rows beyond column add + UPDATE
-- Rollback: ALTER TABLE "Tenant" DROP COLUMN "ticketCounter";

-- เพิ่ม counter column (nullable-safe ด้วย DEFAULT 0)
ALTER TABLE "Tenant" ADD COLUMN "ticketCounter" INTEGER NOT NULL DEFAULT 0;

-- BACKFILL: ตั้ง counter = max ticketNumber ปัจจุบันของแต่ละ tenant
-- กัน ticket ใหม่ (counter+1) ชนกับ ticketNumber ที่มีอยู่แล้ว (@@unique([tenantId, ticketNumber]))
UPDATE "Tenant" t
SET "ticketCounter" = COALESCE(
  (SELECT MAX("ticketNumber") FROM "Ticket" WHERE "Ticket"."tenantId" = t."id"),
  0
);
