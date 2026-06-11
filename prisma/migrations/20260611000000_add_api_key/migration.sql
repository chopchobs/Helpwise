-- Migration: add_api_key
-- Phase 14 — API Key (enterprise feature: api_access): additive only (new table + indexes)
-- Safety class: GREEN — zero-downtime, no data loss, no lock on existing tables
-- Rollback: DROP TABLE "ApiKey"

-- สร้าง ApiKey — tenant-scoped, เก็บเฉพาะ hash ของ key (sha256 hex), ไม่เก็บ plaintext
CREATE TABLE "ApiKey" (
  "id"                TEXT NOT NULL,
  "tenantId"          TEXT NOT NULL,
  "name"              TEXT NOT NULL,
  "keyPrefix"         TEXT NOT NULL,
  "keyHash"           TEXT NOT NULL,
  "lastUsedAt"        TIMESTAMP(3),
  "revokedAt"         TIMESTAMP(3),
  "createdByMemberId" TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- keyHash UNIQUE: ใช้ lookup ตอน verify request, กัน hash ชนกัน
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_keyHash_key" UNIQUE ("keyHash");

-- FK → Tenant (onDelete: Cascade — ลบ tenant ลบ ApiKey ด้วย)
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK → TenantMember (onDelete: SetNull — ลบ member แล้ว key ยังอยู่เพื่อ audit trail)
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_createdByMemberId_fkey"
  FOREIGN KEY ("createdByMemberId") REFERENCES "TenantMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- index[tenantId] — tenant-scoped query ทั่วไป (@@index([tenantId]))
CREATE INDEX "ApiKey_tenantId_idx" ON "ApiKey"("tenantId");
