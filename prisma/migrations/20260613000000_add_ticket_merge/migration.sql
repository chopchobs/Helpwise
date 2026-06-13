-- Migration: add_ticket_merge
-- Phase 22 — Ticket merge: self-relation Ticket.mergedIntoId -> Ticket.id
-- Safety class: GREEN — additive, nullable column, no backfill needed (existing rows = NULL)

-- เพิ่มคอลัมน์ mergedIntoId (nullable, ticket เดิมทั้งหมด = ยังไม่ถูก merge)
ALTER TABLE "Ticket" ADD COLUMN "mergedIntoId" TEXT;

-- FK self-reference: source ticket ชี้ target ticket; ลบ target -> set null (ป้องกัน orphan FK)
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- index สำหรับ query "ticket ที่ถูก merge เข้า target นี้" ใน tenant
CREATE INDEX "Ticket_tenantId_mergedIntoId_idx" ON "Ticket"("tenantId", "mergedIntoId");
