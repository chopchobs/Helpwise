-- Migration: add_csat_response
-- Phase 11 — CSAT Survey: additive only (new table + indexes)
-- Safety class: GREEN — zero-downtime, no data loss, no lock on existing tables
-- Rollback: DROP TABLE "CsatResponse"

-- สร้าง CsatResponse — tenant-scoped, 1 ticket = 1 response (ticketId UNIQUE)
-- submit-once design: ไม่มี updatedAt โดยเจตนา
CREATE TABLE "CsatResponse" (
  "id"        TEXT NOT NULL,
  "tenantId"  TEXT NOT NULL,
  "ticketId"  TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  -- rating 1–5; range validate ที่ app layer (Zod), DB เก็บ Int
  "rating"    INTEGER NOT NULL,
  -- optional free-text comment
  "comment"   TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CsatResponse_pkey" PRIMARY KEY ("id")
);

-- ticketId UNIQUE: บังคับ 1 ticket = 1 CSAT response (one-to-one inverse)
ALTER TABLE "CsatResponse" ADD CONSTRAINT "CsatResponse_ticketId_key" UNIQUE ("ticketId");

-- FK → Tenant (onDelete: Cascade — ลบ tenant ลบ CSAT ด้วย)
ALTER TABLE "CsatResponse" ADD CONSTRAINT "CsatResponse_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK → Ticket (onDelete: Cascade — ลบ ticket ลบ CSAT ด้วย)
ALTER TABLE "CsatResponse" ADD CONSTRAINT "CsatResponse_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK → Contact (onDelete: RESTRICT default — ไม่ cascade เพราะ Contact ไม่ควรถูกลบถ้ายังมี CSAT)
ALTER TABLE "CsatResponse" ADD CONSTRAINT "CsatResponse_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- index[tenantId] — tenant-scoped query ทั่วไป (@@index([tenantId]))
CREATE INDEX "CsatResponse_tenantId_idx" ON "CsatResponse"("tenantId");

-- index[tenantId, createdAt] — aggregate summary (avg rating, count) ต่อ tenant เรียงตามเวลา
-- รองรับ: SELECT AVG(rating), COUNT(*) FROM "CsatResponse" WHERE tenantId = ? ORDER BY createdAt
CREATE INDEX "CsatResponse_tenantId_createdAt_idx" ON "CsatResponse"("tenantId", "createdAt");
