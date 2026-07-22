-- Migration: add_webhooks_feature_flag
-- Phase 36 — เพิ่ม FeatureFlag "webhooks" สำหรับ gate ฟีเจอร์ outbound webhooks ตาม plan (>= pro)
-- Safety class: GREEN — idempotent INSERT row เดียวลงตาราง global FeatureFlag, zero-downtime
-- Rollback: DELETE FROM "FeatureFlag" WHERE "key" = 'webhooks';

INSERT INTO "FeatureFlag" ("id", "key", "description", "defaultEnabled", "requiredPlan", "createdAt", "updatedAt")
VALUES (
  'cmflag_webhooks_0001',
  'webhooks',
  'Outbound webhooks for ticket events',
  false,
  'pro',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;
