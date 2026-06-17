-- Phase 27: PostgreSQL Row Level Security (RLS) — defense-in-depth ชั้น DB
-- เสริมจาก app-layer tenant scoping (tenantPrisma) ที่มีอยู่แล้ว ไม่ใช่ตัวแทน
--
-- GUC contract (ฝั่ง backend ตั้งค่าด้วย set_config(key, val, is_local=true) ต่อ transaction):
--   app.current_tenant_id = Tenant.id ของ request ปัจจุบัน
--   app.rls_bypass        = 'on' สำหรับ system job ที่ทำงาน cross-tenant โดยเจตนา (เช่น SLA sweep)
--
-- หมายเหตุสำคัญ:
--   - ไม่มี @@map/@map ใน schema.prisma → table/column เป็น camelCase ต้อง quote เสมอ
--   - Runtime ต่อผ่าน pgbouncer transaction-pooling → ใช้ current_setting(key, true) (missing_ok)
--     ไม่ใช่ SET ระดับ session เพราะไม่ติดข้าม pooled connection
--   - Runtime connect ด้วย owner role ซึ่ง bypass RLS ปกติ → ตาราง sensitive ต้อง FORCE
--     เพื่อให้ policy บังคับแม้กับ owner role ด้วย
--
-- Policy เป็น idempotent: DROP POLICY IF EXISTS ก่อน CREATE เสมอ
-- ห้ามมี DROP TABLE / DELETE / TRUNCATE ใด ๆ ในไฟล์นี้

-- ============================================================================
-- SECTION 1: SENSITIVE TABLES (6 ตาราง) — ENABLE + POLICY + FORCE
-- ตารางเหล่านี้เก็บข้อมูล ticket content / contact PII / attachment / tag
-- จึงบังคับ RLS แม้กับ owner role (FORCE) เพื่อป้องกัน cross-tenant leak สูงสุด
-- ============================================================================

-- ---- Ticket ----
ALTER TABLE "Ticket" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Ticket";
CREATE POLICY tenant_isolation ON "Ticket"
  USING (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on' -- SLA sweep job ต้อง update ticket ข้าม tenant
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  );
ALTER TABLE "Ticket" FORCE ROW LEVEL SECURITY;

-- ---- TicketMessage ----
ALTER TABLE "TicketMessage" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TicketMessage";
CREATE POLICY tenant_isolation ON "TicketMessage"
  USING (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  );
ALTER TABLE "TicketMessage" FORCE ROW LEVEL SECURITY;

-- ---- Contact ----
ALTER TABLE "Contact" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Contact";
CREATE POLICY tenant_isolation ON "Contact"
  USING (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  );
ALTER TABLE "Contact" FORCE ROW LEVEL SECURITY;

-- ---- Attachment ----
ALTER TABLE "Attachment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Attachment";
CREATE POLICY tenant_isolation ON "Attachment"
  USING (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  );
ALTER TABLE "Attachment" FORCE ROW LEVEL SECURITY;

-- ---- Tag ----
ALTER TABLE "Tag" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Tag";
CREATE POLICY tenant_isolation ON "Tag"
  USING (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  );
ALTER TABLE "Tag" FORCE ROW LEVEL SECURITY;

-- ---- TicketTag ----
ALTER TABLE "TicketTag" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TicketTag";
CREATE POLICY tenant_isolation ON "TicketTag"
  USING (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  );
ALTER TABLE "TicketTag" FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- SECTION 2: SCAFFOLD TABLES (10 ตาราง) — ENABLE + POLICY เท่านั้น (ไม่ FORCE)
-- owner role ยัง bypass RLS อยู่จนกว่า Dev จะตัดสินใจ flip เป็น FORCE ทีหลัง
-- (เปิดไว้ก่อนเพื่อให้ non-owner role ในอนาคต / ทดสอบ policy ได้ โดยไม่กระทบ
--  query path ปัจจุบันที่ใช้ owner role อยู่)
-- ============================================================================

-- ---- Subscription ----
ALTER TABLE "Subscription" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Subscription";
CREATE POLICY tenant_isolation ON "Subscription"
  USING (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  );

-- ---- SlaPolicy ----
ALTER TABLE "SlaPolicy" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "SlaPolicy";
CREATE POLICY tenant_isolation ON "SlaPolicy"
  USING (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  );

-- ---- CannedResponse ----
ALTER TABLE "CannedResponse" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CannedResponse";
CREATE POLICY tenant_isolation ON "CannedResponse"
  USING (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  );

-- ---- CsatResponse ----
ALTER TABLE "CsatResponse" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CsatResponse";
CREATE POLICY tenant_isolation ON "CsatResponse"
  USING (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  );

-- ---- ApiKey ----
ALTER TABLE "ApiKey" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ApiKey";
CREATE POLICY tenant_isolation ON "ApiKey"
  USING (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  );

-- ---- ProcessedInboundEmail ----
ALTER TABLE "ProcessedInboundEmail" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ProcessedInboundEmail";
CREATE POLICY tenant_isolation ON "ProcessedInboundEmail"
  USING (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  );

-- ---- TenantMember ----
ALTER TABLE "TenantMember" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TenantMember";
CREATE POLICY tenant_isolation ON "TenantMember"
  USING (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  );

-- ---- TenantFeature ----
ALTER TABLE "TenantFeature" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TenantFeature";
CREATE POLICY tenant_isolation ON "TenantFeature"
  USING (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  );

-- ---- AuditLog ----
-- หมายเหตุ: AuditLog เป็น immutable ใน app layer (ห้าม update/delete จาก backend)
-- แต่ policy นี้ครอบทั้ง USING/WITH CHECK ตามมาตรฐานเดียวกัน — ไม่กระทบ insert-only pattern
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "AuditLog";
CREATE POLICY tenant_isolation ON "AuditLog"
  USING (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  )
  WITH CHECK (
    "tenantId" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  );

-- ---- Tenant (edge case: ไม่มี tenantId, PK "id" คือ tenant id เอง) ----
-- ห้าม FORCE: proxy.ts/middleware ต้อง resolve tenant จาก base prisma (owner role)
-- ก่อนที่จะมี GUC context ตั้งค่า — ถ้า FORCE จะทำ tenant resolution พังตั้งแต่ขั้นแรก
ALTER TABLE "Tenant" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Tenant";
CREATE POLICY tenant_isolation ON "Tenant"
  USING (
    "id" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  )
  WITH CHECK (
    "id" = current_setting('app.current_tenant_id', true)
    OR current_setting('app.rls_bypass', true) = 'on'
  );
