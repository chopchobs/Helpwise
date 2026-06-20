-- Migration: add_ai_assist_flag
-- Phase 29 — เพิ่ม FeatureFlag "ai_assist" สำหรับ gate ฟีเจอร์ AI summarize ของ agent ตาม plan (>= pro)
-- Safety class: GREEN — idempotent INSERT row เดียวลงตาราง global FeatureFlag, zero-downtime
-- Rollback: DELETE FROM "FeatureFlag" WHERE "key" = 'ai_assist';

INSERT INTO "FeatureFlag" ("id", "key", "description", "defaultEnabled", "requiredPlan", "createdAt", "updatedAt")
VALUES (
  'cmflag_ai_assist_0001',
  'ai_assist',
  'AI-assisted ticket summarization for agents',
  false,
  'pro',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;
