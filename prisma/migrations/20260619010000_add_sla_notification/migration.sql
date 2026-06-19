-- Migration: add_sla_notification
-- Phase 28 Slice 3 — SLA notifications: near-breach warning + breach (agent-audience, tenant-scoped)
-- Safety class: GREEN — additive only (new enum values + new nullable-default columns), zero-downtime
-- Rollback note: enum values ลบไม่ได้ใน Postgres (ALTER TYPE ... DROP VALUE ไม่รองรับ) —
--   ปล่อยค่าค้างไว้ได้ไม่กระทบ; columns rollback ด้วย
--   ALTER TABLE "Ticket" DROP COLUMN "firstResponseNearBreachNotified", DROP COLUMN "resolutionNearBreachNotified";

-- เพิ่มค่า enum สำหรับ SLA notification (idempotent — IF NOT EXISTS กัน re-run ชน)
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SLA_NEAR_BREACH';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SLA_BREACH';

-- idempotency flags ของ near-breach warning — กันยิง notification ซ้ำเมื่อ sweep วนหลายรอบ
-- NOT NULL DEFAULT false → backfill อัตโนมัติ ไม่ต้องแตะข้อมูลเก่า (zero-downtime)
ALTER TABLE "Ticket" ADD COLUMN "firstResponseNearBreachNotified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Ticket" ADD COLUMN "resolutionNearBreachNotified" BOOLEAN NOT NULL DEFAULT false;
