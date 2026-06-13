-- Migration: add_canned_response
-- Phase 23 — CannedResponse: ข้อความตอบสำเร็จรูป tenant-scoped สำหรับ agent (v1, ไม่มี placeholder)
-- Safety class: GREEN — additive only (new table + indexes), zero-downtime
-- Rollback: DROP TABLE "CannedResponse"

-- สร้าง CannedResponse — tenant-scoped, title + body plain text
CREATE TABLE "CannedResponse" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "title"             TEXT NOT NULL,
  "body"              TEXT NOT NULL,
  "createdByMemberId" TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CannedResponse_pkey" PRIMARY KEY ("id")
);

-- FK → Tenant (onDelete: Cascade — ลบ tenant ลบ CannedResponse ด้วย)
ALTER TABLE "CannedResponse" ADD CONSTRAINT "CannedResponse_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK → TenantMember (onDelete: SetNull — ลบ member แล้ว template ยังอยู่)
ALTER TABLE "CannedResponse" ADD CONSTRAINT "CannedResponse_createdByMemberId_fkey"
  FOREIGN KEY ("createdByMemberId") REFERENCES "TenantMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- index[tenantId] — tenant-scoped query ทั่วไป (@@index([tenantId]))
CREATE INDEX "CannedResponse_tenantId_idx" ON "CannedResponse"("tenantId");
