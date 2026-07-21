-- Phase 35 / Slice 1: RLS สำหรับ Supabase Realtime presence/broadcast channel
-- Authorize การ join real-time channel แบบ tenant-isolated บนตาราง `realtime.messages`
--
-- ⚠️ อิสระจาก app RLS โดยเจตนา:
--   Policy ชุดนี้ scope ด้วย JWT claim (`request.jwt.claims ->> 'tenantId'`) + `realtime.topic()` ล้วน
--   ไม่ subquery ไปตาราง app (Ticket/TicketMessage/…) เด็ดขาด. เหตุผล: app RLS ถูกปิดใช้งานอยู่
--   (runtime connect ด้วย role BYPASSRLS, kill-switch RLS_ENABLED=false) — ถ้า subquery ไปตาราง app
--   ใต้ role `authenticated` (ที่ Supabase Realtime ใช้) พฤติกรรมจะไม่แน่นอน. scope ด้วย claim ล้วน
--   = แยกขาดจาก app RLS 100% และไม่พึ่งพา state ของ RLS_ENABLED.
--
-- ⚠️ งานนี้ไม่แตะตาราง app และไม่เปลี่ยน RLS_ENABLED — จำกัดขอบเขตเฉพาะ schema `realtime` ของ Supabase.
--
-- กันข้าม tenant (cross-tenant): topic ต้องขึ้นต้น 'tenant:{claimTenantId}:ticket:' เป๊ะ โดย claimTenantId
--   มาจาก JWT ที่ backend mint จาก server context เท่านั้น (client ตั้งเองไม่ได้). ดังนั้น tenant A
--   join channel ของ tenant B ไม่ได้แม้จะเดา ticketId ถูก เพราะ prefix ไม่ match claim ของตัวเอง.
--
-- ⚠️ ใช้ starts_with() ไม่ใช้ LIKE โดยเจตนา (defense-in-depth — ไม่พึ่ง app validation ด่านเดียว):
--   LIKE ตีความ `%`/`_` เป็น pattern → ถ้ามี mint path ในอนาคตลืม validate แล้วปล่อย tenantId='%'
--   prefix จะกลายเป็น 'tenant:%:ticket:%' = match ทุก tenant = cross-tenant presence leak (Critical).
--   starts_with(str, prefix) เป็น plain function — `%`/`_`/`:` เป็น literal ล้วน ไม่มี pattern semantics
--   → security boundary ไม่แขวนกับ regex ใน app คนละชั้น. ป้อง defense ซ้อนด้วย regex guard บน claim
--   (format cuid/[a-zA-Z0-9-]) ที่ DB layer เพื่อกัน `:` injection ใน prefix โดยตรง.
--   starts_with เป็น STRICT: claim NULL → prefix NULL → ผลลัพธ์ NULL → RLS deny (fail-closed).
--
-- Idempotent-safe: ENABLE ROW LEVEL SECURITY ซ้ำเป็น no-op; DROP POLICY IF EXISTS ก่อน CREATE เสมอ.
-- ไม่มี DROP TABLE / DELETE / TRUNCATE ใด ๆ ในไฟล์นี้.

-- Supabase Realtime Authorization: RLS บน realtime.messages เป็นตัวตัดสินสิทธิ์ join channel
alter table realtime.messages enable row level security;

-- SELECT = สิทธิ์ "รับ" presence/broadcast ของ channel (join + receive)
drop policy if exists "agent receive own-tenant ticket presence" on realtime.messages;
create policy "agent receive own-tenant ticket presence"
  on realtime.messages for select to authenticated
  using (
    (realtime.messages.extension in ('presence','broadcast'))
    -- defense ซ้อน: claim tenantId ต้องเป็น format ปลอดภัย (กัน `:`/wildcard injection ที่ DB layer)
    and (current_setting('request.jwt.claims', true)::json ->> 'tenantId') ~ '^[a-zA-Z0-9-]+$'
    -- starts_with = literal prefix match (ไม่ใช่ LIKE) → `%`/`_` ใน claim ไม่มีผลเป็น wildcard
    and starts_with(
      realtime.topic(),
      'tenant:' || (current_setting('request.jwt.claims', true)::json ->> 'tenantId') || ':ticket:'
    )
  );

-- INSERT = สิทธิ์ "ส่ง" presence.track / typing broadcast เข้า channel
drop policy if exists "agent send own-tenant ticket presence" on realtime.messages;
create policy "agent send own-tenant ticket presence"
  on realtime.messages for insert to authenticated
  with check (
    (realtime.messages.extension in ('presence','broadcast'))
    -- defense ซ้อน: claim tenantId ต้องเป็น format ปลอดภัย (กัน `:`/wildcard injection ที่ DB layer)
    and (current_setting('request.jwt.claims', true)::json ->> 'tenantId') ~ '^[a-zA-Z0-9-]+$'
    -- starts_with = literal prefix match (ไม่ใช่ LIKE) → `%`/`_` ใน claim ไม่มีผลเป็น wildcard
    and starts_with(
      realtime.topic(),
      'tenant:' || (current_setting('request.jwt.claims', true)::json ->> 'tenantId') || ':ticket:'
    )
  );
