-- Migration: add_tags
-- Phase 26 — Tag + TicketTag: labels จัดหมวด ticket ภายใน (agent-only, tenant-scoped)
-- Safety class: GREEN — additive only (new enum + new tables + indexes), zero-downtime
-- Rollback: DROP TABLE "TicketTag"; DROP TABLE "Tag"; DROP TYPE "TagColor";

-- สร้าง enum TagColor — preset palette (map ไป semantic token ฝั่ง frontend)
CREATE TYPE "TagColor" AS ENUM ('GRAY', 'TERRACOTTA', 'SAGE', 'AMBER', 'SIENNA', 'SAND');

-- สร้าง Tag — catalog ต่อ tenant, name unique ต่อ tenant
CREATE TABLE "Tag" (
  "id"        TEXT NOT NULL,
  "tenantId"  TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "color"     "TagColor" NOT NULL DEFAULT 'GRAY',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- FK → Tenant (onDelete: Cascade — ลบ tenant ลบ Tag ด้วย)
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- unique: tag name ห้ามซ้ำใน tenant เดียวกัน (@@unique([tenantId, name]))
CREATE UNIQUE INDEX "Tag_tenantId_name_key" ON "Tag"("tenantId", "name");

-- index[tenantId] — tenant-scoped query ทั่วไป (@@index([tenantId]))
CREATE INDEX "Tag_tenantId_idx" ON "Tag"("tenantId");

-- สร้าง TicketTag — explicit join model (ticket m-n tag) พร้อม tenantId สำหรับ RLS
-- ใช้ explicit model แทน implicit many-to-many เพื่อให้ join table มี tenantId
CREATE TABLE "TicketTag" (
  "id"        TEXT NOT NULL,
  "tenantId"  TEXT NOT NULL,
  "ticketId"  TEXT NOT NULL,
  "tagId"     TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TicketTag_pkey" PRIMARY KEY ("id")
);

-- FK → Tenant (onDelete: Cascade — ลบ tenant ลบ TicketTag ด้วย)
ALTER TABLE "TicketTag" ADD CONSTRAINT "TicketTag_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK → Ticket (onDelete: Cascade — ลบ ticket ลบ TicketTag ด้วย)
ALTER TABLE "TicketTag" ADD CONSTRAINT "TicketTag_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK → Tag (onDelete: Cascade — ลบ tag ลบ TicketTag ด้วย)
ALTER TABLE "TicketTag" ADD CONSTRAINT "TicketTag_tagId_fkey"
  FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- unique: กัน tag ซ้ำบน ticket เดียว (@@unique([ticketId, tagId]))
CREATE UNIQUE INDEX "TicketTag_ticketId_tagId_key" ON "TicketTag"("ticketId", "tagId");

-- index[tenantId] — tenant-scoped query ทั่วไป (@@index([tenantId]))
CREATE INDEX "TicketTag_tenantId_idx" ON "TicketTag"("tenantId");

-- index[ticketId] — query tags ของ ticket (@@index([ticketId]))
CREATE INDEX "TicketTag_ticketId_idx" ON "TicketTag"("ticketId");

-- index[tagId] — query tickets ของ tag (@@index([tagId]))
CREATE INDEX "TicketTag_tagId_idx" ON "TicketTag"("tagId");
