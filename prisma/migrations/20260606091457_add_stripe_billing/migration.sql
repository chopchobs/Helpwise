-- Migration: add_stripe_billing
-- Phase 6 — Stripe Billing: additive only (nullable columns + new table)
-- Safety class: GREEN — zero-downtime, no data loss
-- Rollback: DROP COLUMN stripePriceIdMonthly, DROP COLUMN stripePriceIdYearly, DROP TABLE "ProcessedStripeEvent"

-- 1. เพิ่ม Stripe Price ID fields บน Plan (nullable → ไม่ lock table, ไม่ data loss)
ALTER TABLE "Plan"
  ADD COLUMN "stripePriceIdMonthly" TEXT,
  ADD COLUMN "stripePriceIdYearly"  TEXT;

-- 2. unique constraints — Postgres อนุญาต multiple NULL ใน unique index (ปลอดภัย)
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_stripePriceIdMonthly_key" UNIQUE ("stripePriceIdMonthly");
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_stripePriceIdYearly_key"  UNIQUE ("stripePriceIdYearly");

-- 3. สร้าง ProcessedStripeEvent — global idempotency guard สำหรับ Stripe webhook
--    ไม่มี tenantId โดยเจตนา: Stripe event เป็น account-level
--    ต้อง resolve tenant ก่อน แต่ idempotency check ต้องทำได้ก่อน resolve tenant
CREATE TABLE "ProcessedStripeEvent" (
  "id"          TEXT NOT NULL,
  "eventId"     TEXT NOT NULL,
  "type"        TEXT NOT NULL,
  "status"      TEXT NOT NULL DEFAULT 'ok',
  "errorDetail" TEXT,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProcessedStripeEvent_pkey" PRIMARY KEY ("id")
);

-- unique บน eventId — กัน process Stripe event เดียวกันซ้ำ
ALTER TABLE "ProcessedStripeEvent" ADD CONSTRAINT "ProcessedStripeEvent_eventId_key" UNIQUE ("eventId");

-- index เสริม (@@index([eventId]) ใน schema)
CREATE INDEX "ProcessedStripeEvent_eventId_idx" ON "ProcessedStripeEvent"("eventId");
