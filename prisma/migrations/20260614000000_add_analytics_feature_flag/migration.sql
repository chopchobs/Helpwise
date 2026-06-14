-- Migration: add_analytics_feature_flag
-- Phase 24 — เพิ่ม FeatureFlag "analytics" สำหรับ gate reporting/analytics dashboard ตาม plan (>= pro)
-- Safety class: GREEN — idempotent INSERT row เดียวลงตาราง global FeatureFlag, zero-downtime
-- Rollback: DELETE FROM "FeatureFlag" WHERE "key" = 'analytics';

INSERT INTO "FeatureFlag" ("id", "key", "description", "defaultEnabled", "requiredPlan", "createdAt", "updatedAt")
VALUES (
  'cmflag_analytics_0001',
  'analytics',
  'Reporting and analytics dashboard with KPIs, trends, and breakdowns',
  false,
  'pro',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;
