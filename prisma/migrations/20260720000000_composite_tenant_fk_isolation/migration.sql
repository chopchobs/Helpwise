-- =============================================================================
-- composite_tenant_fk_isolation  (finding XT-WRITE-05, severity HIGH latent)
--
-- ปิดช่อง cross-tenant FK contamination: เดิม Ticket/TicketMessage ผูก FK ด้วย
-- id อย่างเดียว → ชี้ record ของ tenant อื่นได้ (nested/relation write ไม่ถูก scope
-- โดย tenantPrisma). เปลี่ยนเป็น COMPOSITE FK [tenantId, xxxId] -> Target[tenantId, id]
-- ให้ DB บังคับ tenant match เอง (enforcement ทำงานทันที ไม่ขึ้นกับ RLS ที่ยังปิดอยู่).
--
-- referential action: nullable FK เดิม (assignee/authorMember/authorContact) เคยเป็น
-- ON DELETE SET NULL — บน composite FK ทำ SET NULL ไม่ได้ (จะต้อง null tenantId ซึ่ง
-- non-null) → กลายเป็น ON DELETE RESTRICT. app ปัจจุบันไม่ hard-delete TenantMember/
-- Contact (ใช้ soft-delete isActive) จึงกระทบต่ำ — ดูรายงานหัวข้อ RESTRICT ให้ backend.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- PRE-FLIGHT GUARD — abort ทั้ง migration ถ้ามี cross-tenant FK row อยู่จริง
-- (migration รันใน transaction เดียว: RAISE EXCEPTION = rollback ทั้งหมด ไม่ apply)
-- ต้องให้ Dev แก้ข้อมูลก่อน ห้าม apply ทับข้อมูลปนเปื้อน
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_req  bigint;
  v_asg  bigint;
  v_amem bigint;
  v_acon bigint;
  v_total bigint;
BEGIN
  SELECT count(*) INTO v_req
    FROM "Ticket" t
    JOIN "Contact" c ON t."requesterContactId" = c."id"
    WHERE t."tenantId" <> c."tenantId";

  SELECT count(*) INTO v_asg
    FROM "Ticket" t
    JOIN "TenantMember" m ON t."assigneeId" = m."id"
    WHERE t."tenantId" <> m."tenantId";

  SELECT count(*) INTO v_amem
    FROM "TicketMessage" tm
    JOIN "TenantMember" m ON tm."authorMemberId" = m."id"
    WHERE tm."tenantId" <> m."tenantId";

  SELECT count(*) INTO v_acon
    FROM "TicketMessage" tm
    JOIN "Contact" c ON tm."authorContactId" = c."id"
    WHERE tm."tenantId" <> c."tenantId";

  v_total := v_req + v_asg + v_amem + v_acon;

  IF v_total > 0 THEN
    RAISE EXCEPTION 'ABORT composite_tenant_fk_isolation (XT-WRITE-05): cross-tenant FK rows found -> requesterContact=%, assignee=%, authorMember=%, authorContact=%. Clean data before applying.',
      v_req, v_asg, v_amem, v_acon;
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- DropForeignKey — FK เดิม (by id อย่างเดียว, ไม่มี tenant component)
-- -----------------------------------------------------------------------------
ALTER TABLE "Ticket" DROP CONSTRAINT "Ticket_assigneeId_fkey";

ALTER TABLE "Ticket" DROP CONSTRAINT "Ticket_requesterContactId_fkey";

ALTER TABLE "TicketMessage" DROP CONSTRAINT "TicketMessage_authorContactId_fkey";

ALTER TABLE "TicketMessage" DROP CONSTRAINT "TicketMessage_authorMemberId_fkey";

-- -----------------------------------------------------------------------------
-- CreateIndex — composite unique (tenantId, id) เป็น target ของ composite FK
-- (มี @id บน id อยู่แล้ว; unique ซ้อนนี้จำเป็นเพื่อให้ FK reference [tenantId, id] ได้)
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX "Contact_tenantId_id_key" ON "Contact"("tenantId", "id");

CREATE UNIQUE INDEX "TenantMember_tenantId_id_key" ON "TenantMember"("tenantId", "id");

-- -----------------------------------------------------------------------------
-- AddForeignKey — composite FK ผูก tenantId ร่วม (บังคับ tenant match ที่ DB layer)
-- nullable FK: MATCH SIMPLE → id-column null = ไม่เช็ค FK; ถ้า set = tenant ต้องตรง
-- -----------------------------------------------------------------------------
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_tenantId_requesterContactId_fkey" FOREIGN KEY ("tenantId", "requesterContactId") REFERENCES "Contact"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_tenantId_assigneeId_fkey" FOREIGN KEY ("tenantId", "assigneeId") REFERENCES "TenantMember"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_tenantId_authorMemberId_fkey" FOREIGN KEY ("tenantId", "authorMemberId") REFERENCES "TenantMember"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_tenantId_authorContactId_fkey" FOREIGN KEY ("tenantId", "authorContactId") REFERENCES "Contact"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
