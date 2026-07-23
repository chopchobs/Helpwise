-- Migration: webhooks_rls
-- Phase 36 (security MEDIUM-2) — RLS ให้ตารางใหม่ของ Outbound Webhooks
-- Safety class: GREEN — ไม่แตะ schema/ข้อมูล (ENABLE + POLICY + FORCE เท่านั้น), zero-downtime
-- Rollback: ALTER TABLE "WebhookEndpoint" NO FORCE ROW LEVEL SECURITY;
--           ALTER TABLE "WebhookEndpoint" DISABLE ROW LEVEL SECURITY;
--           ALTER TABLE "WebhookDelivery" NO FORCE ROW LEVEL SECURITY;
--           ALTER TABLE "WebhookDelivery" DISABLE ROW LEVEL SECURITY;
--
-- แยกเป็น migration ของตัวเองแทนการแก้ 20260722000000_add_outbound_webhooks
-- เพราะไฟล์นั้น apply ไปแล้วในบาง environment (แก้ = checksum mismatch)
--
-- ============================================================================
-- RLS (Phase 27 precedent): ทั้งสองตารางจัดอยู่กลุ่ม sensitive
--   - WebhookEndpoint.secret = signing secret แบบ plaintext
--   - WebhookDelivery.payload = snapshot เนื้อ ticket/message ของลูกค้า
-- → ENABLE + POLICY + FORCE (บังคับ RLS แม้กับ owner role ที่ปกติ bypass)
-- GUC contract เดิม (ตั้งโดย tenantPrisma ผ่าน set_config(..., is_local=true) ต่อ transaction):
--   app.current_tenant_id = Tenant.id ของ request ปัจจุบัน
--   app.rls_bypass        = 'on' สำหรับ system job ที่ทำงาน cross-tenant โดยเจตนา
-- ใช้ current_setting(key, true) (missing_ok) เพราะ runtime ต่อผ่าน pgbouncer transaction-pooling
-- Policy idempotent: DROP POLICY IF EXISTS ก่อน CREATE
-- ห้ามมี DROP TABLE / DELETE / TRUNCATE ใด ๆ ในไฟล์นี้
-- ============================================================================

-- ---- WebhookEndpoint ----
ALTER TABLE "WebhookEndpoint" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "WebhookEndpoint";
CREATE POLICY tenant_isolation ON "WebhookEndpoint"
  USING (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  );
ALTER TABLE "WebhookEndpoint" FORCE ROW LEVEL SECURITY;

-- ---- WebhookDelivery ----
-- worker /api/jobs/webhook-deliver ใช้ tenantPrisma(job.tenantId) → GUC ถูกตั้งครบทุก query
-- ไม่ต้องพึ่ง rls_bypass (คงเงื่อนไข bypass ไว้ตามมาตรฐานเดียวกับตารางอื่น)
ALTER TABLE "WebhookDelivery" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "WebhookDelivery";
CREATE POLICY tenant_isolation ON "WebhookDelivery"
  USING (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  );
ALTER TABLE "WebhookDelivery" FORCE ROW LEVEL SECURITY;
