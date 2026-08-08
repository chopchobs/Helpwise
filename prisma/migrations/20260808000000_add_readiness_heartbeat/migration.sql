-- Migration: add_readiness_heartbeat
-- Phase 39 ลำดับ 4 — heartbeat ระดับ mechanism + snapshot ของ readiness probe (P2)
-- Safety class: GREEN — CREATE TABLE ล้วน ไม่แตะตาราง/คอลัมน์เดิม zero-downtime
--   · ไม่มี FK ไปตารางใด ⇒ ไม่มี lock ข้ามตาราง
--   · ทั้งสองตารางเป็น GLOBAL โดยตั้งใจ (ไม่มี tenantId) — เฝ้ากลไกระดับระบบ
--     ไม่ใช่ข้อมูลของ tenant · heartbeat ราย tenant เป็นงาน Phase 40
--   ⛔ ห้ามใส่ข้อมูลที่ระบุ tenant ลงสองตารางนี้ — shape ที่ไม่ auth ของ
--      /api/health/readiness เสิร์ฟค่าจากตารางนี้ต่อสาธารณะ
-- Rollback:
--   DROP TABLE IF EXISTS "ReadinessState";
--   DROP TABLE IF EXISTS "MechanismHeartbeat";

-- MechanismHeartbeat — "กลไกนี้ทำงานล่าสุดเมื่อไร"
-- ด้านที่สองของ corroboration ใน erratum §C
CREATE TABLE IF NOT EXISTS "MechanismHeartbeat" (
    "mechanism" TEXT NOT NULL,
    "lastBeatAt" TIMESTAMP(3) NOT NULL,
    -- null = event-driven (ตัดสิน stale ไม่ได้โดยธรรมชาติ)
    "expectedIntervalSeconds" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MechanismHeartbeat_pkey" PRIMARY KEY ("mechanism")
);

CREATE INDEX IF NOT EXISTS "MechanismHeartbeat_lastBeatAt_idx"
    ON "MechanismHeartbeat"("lastBeatAt");

-- ReadinessState — snapshot ผลตรวจล่าสุดของ P2 (แถวเดียวทั้งระบบ)
-- ย้ายมาจาก Redis ตาม erratum §H-1
CREATE TABLE IF NOT EXISTS "ReadinessState" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    -- lastCheckAt ของ P2 เอง — external pinger (ลำดับ 6) เฝ้า field นี้
    "lastCheckAt" TIMESTAMP(3) NOT NULL,
    "reasons" JSONB NOT NULL,
    "components" JSONB NOT NULL,
    "counters" JSONB,
    "deploymentId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReadinessState_pkey" PRIMARY KEY ("id")
);
