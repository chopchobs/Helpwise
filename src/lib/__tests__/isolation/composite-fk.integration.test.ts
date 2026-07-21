/**
 * src/lib/__tests__/isolation/composite-fk.integration.test.ts
 *
 * Integration test (REAL Postgres) — พิสูจน์ว่า composite tenant FK ที่ migration
 * `20260720000000_composite_tenant_fk_isolation` เพิ่มเข้ามา บังคับ tenant match
 * ที่ DB layer จริง (finding XT-WRITE-05 / cross-tenant FK contamination).
 *
 * ทดสอบ constraint 4 ตัว โดยพยายาม insert row ของ tenant A ที่ FK ชี้ record ของ
 * tenant B → DB ต้อง reject ด้วย FK violation (PG error code 23503):
 *   - Ticket.requesterContactId  -> Contact (tenantId, id)
 *   - Ticket.assigneeId          -> TenantMember (tenantId, id)
 *   - TicketMessage.authorContactId -> Contact (tenantId, id)
 *   - TicketMessage.authorMemberId  -> TenantMember (tenantId, id)
 * และ positive control: FK ที่อยู่ใน tenant เดียวกัน insert ได้ปกติ
 *
 * ใช้ `pg` ตรง (autocommit) เพื่ออ่าน SQLSTATE จริง — ไม่ mock/จำลอง constraint.
 *
 * SKIP อย่างสุภาพเมื่อ: ไม่มี real DB URL (DIRECT_URL) หรือชี้ localhost/dummy
 * (vitest.config.ts inject DATABASE_URL=...@localhost/dummy จึงต้องใช้ DIRECT_URL
 * จาก .env แทน) หรือ DB ต่อไม่ติด — เพื่อไม่ให้ CI ที่ไม่มี DB แดง.
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

// ใช้ DIRECT_URL (direct :5432) — vitest override เฉพาะ DATABASE_URL เป็น dummy
const RAW_URL = process.env.DIRECT_URL ?? process.env.TEST_DATABASE_URL ?? "";
const IS_DUMMY = /localhost|127\.0\.0\.1|dummy/i.test(RAW_URL);

/** ตรวจ reachability แบบ sync-friendly ด้วย top-level await (vitest ESM รองรับ) */
async function canConnect(url: string): Promise<boolean> {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await c.connect();
    await c.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => {});
  }
}

const DB_REACHABLE = RAW_URL !== "" && !IS_DUMMY && (await canConnect(RAW_URL));

if (!DB_REACHABLE) {
  // ให้ Dev เห็นเหตุผลที่ skip (ไม่ทำ CI แดง)
  // eslint-disable-next-line no-console
  console.warn(
    `[composite-fk.integration] SKIP — ${
      RAW_URL === "" ? "ไม่มี DIRECT_URL" : IS_DUMMY ? "URL เป็น localhost/dummy" : "DB ต่อไม่ติด"
    }`
  );
}

// unique suffix กัน collision กับข้อมูลจริงใน dev DB
const SFX = randomUUID().slice(0, 8);
const id = (p: string) => `xtfk_${p}_${SFX}`;

const TENANT_A = id("tA");
const TENANT_B = id("tB");
const CONTACT_A = id("cA");
const CONTACT_B = id("cB");
const USER_A = id("uA");
const USER_B = id("uB");
const MEMBER_A = id("mA");
const MEMBER_B = id("mB");
const TICKET_A = id("kA"); // ticket ที่ถูกต้องใน tenant A (สำหรับ message tests)

const PG_FK_VIOLATION = "23503";

describe.skipIf(!DB_REACHABLE)("composite tenant FK isolation (XT-WRITE-05)", () => {
  let db: Client;

  beforeAll(async () => {
    db = new Client({ connectionString: RAW_URL });
    await db.connect();

    // ใช้ Plan ที่ seed ไว้แล้ว (Tenant.planId เป็น required FK) — ไม่สร้าง/ลบ Plan เอง
    const plan = await db.query('SELECT id FROM "Plan" ORDER BY "createdAt" ASC LIMIT 1');
    if (plan.rowCount === 0) {
      throw new Error("ไม่มี Plan ใน DB — seed ก่อนรัน integration test นี้");
    }
    const planId: string = plan.rows[0].id;

    // สอง tenant แยกกัน
    for (const [tid, slug] of [
      [TENANT_A, `xtfk-a-${SFX}`],
      [TENANT_B, `xtfk-b-${SFX}`],
    ] as const) {
      await db.query(
        `INSERT INTO "Tenant" ("id","slug","name","planId","settings","isActive","ticketCounter","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,'{}',true,0,now(),now())`,
        [tid, slug, `XTFK ${tid}`, planId]
      );
    }

    // Contact ในแต่ละ tenant
    for (const [cid, tid, email] of [
      [CONTACT_A, TENANT_A, `a-${SFX}@xtfk.test`],
      [CONTACT_B, TENANT_B, `b-${SFX}@xtfk.test`],
    ] as const) {
      await db.query(
        `INSERT INTO "Contact" ("id","tenantId","email","metadata","isActive","createdAt","updatedAt")
         VALUES ($1,$2,$3,'{}',true,now(),now())`,
        [cid, tid, email]
      );
    }

    // User (global) + TenantMember ในแต่ละ tenant
    for (const [uid, email] of [
      [USER_A, `ua-${SFX}@xtfk.test`],
      [USER_B, `ub-${SFX}@xtfk.test`],
    ] as const) {
      await db.query(
        `INSERT INTO "User" ("id","email","isActive","createdAt","updatedAt")
         VALUES ($1,$2,true,now(),now())`,
        [uid, email]
      );
    }
    for (const [mid, tid, uid] of [
      [MEMBER_A, TENANT_A, USER_A],
      [MEMBER_B, TENANT_B, USER_B],
    ] as const) {
      await db.query(
        `INSERT INTO "TenantMember" ("id","tenantId","userId","role","isActive","createdAt","updatedAt")
         VALUES ($1,$2,$3,'AGENT',true,now(),now())`,
        [mid, tid, uid]
      );
    }

    // Ticket ที่ถูกต้องใน tenant A (requester = Contact A) — ใช้เป็นแม่ของ message tests
    await db.query(
      `INSERT INTO "Ticket" ("id","tenantId","ticketNumber","subject","status","priority","requesterContactId","channel","createdAt","updatedAt","metadata","slaPausedDurationMin","firstResponseBreached","resolutionBreached","firstResponseNearBreachNotified","resolutionNearBreachNotified")
       VALUES ($1,$2,1,'seed','NEW','NORMAL',$3,'portal',now(),now(),'{}',0,false,false,false,false)`,
      [TICKET_A, TENANT_A, CONTACT_A]
    );
  }, 30000);

  afterAll(async () => {
    if (!db) return;
    // ลบตามลำดับ dependency (เลี่ยงพึ่ง cascade+RESTRICT interaction)
    await db.query(`DELETE FROM "TicketMessage" WHERE "tenantId" = ANY($1)`, [[TENANT_A, TENANT_B]]).catch(() => {});
    await db.query(`DELETE FROM "Ticket" WHERE "tenantId" = ANY($1)`, [[TENANT_A, TENANT_B]]).catch(() => {});
    await db.query(`DELETE FROM "Contact" WHERE "tenantId" = ANY($1)`, [[TENANT_A, TENANT_B]]).catch(() => {});
    await db.query(`DELETE FROM "TenantMember" WHERE "tenantId" = ANY($1)`, [[TENANT_A, TENANT_B]]).catch(() => {});
    await db.query(`DELETE FROM "Tenant" WHERE "id" = ANY($1)`, [[TENANT_A, TENANT_B]]).catch(() => {});
    await db.query(`DELETE FROM "User" WHERE "id" = ANY($1)`, [[USER_A, USER_B]]).catch(() => {});
    await db.end().catch(() => {});
  });

  /** helper: insert Ticket ของ tenant A แล้วคืน error (หรือ null ถ้าสำเร็จ) */
  async function insertTicketA(opts: {
    ticketNumber: number;
    requesterContactId: string;
    assigneeId?: string | null;
  }): Promise<{ code?: string } | null> {
    try {
      await db.query(
        `INSERT INTO "Ticket" ("id","tenantId","ticketNumber","subject","status","priority","requesterContactId","assigneeId","channel","createdAt","updatedAt","metadata","slaPausedDurationMin","firstResponseBreached","resolutionBreached","firstResponseNearBreachNotified","resolutionNearBreachNotified")
         VALUES ($1,$2,$3,'t','NEW','NORMAL',$4,$5,'portal',now(),now(),'{}',0,false,false,false,false)`,
        [id(`k${opts.ticketNumber}`), TENANT_A, opts.ticketNumber, opts.requesterContactId, opts.assigneeId ?? null]
      );
      return null;
    } catch (e) {
      return e as { code?: string };
    }
  }

  /** helper: insert TicketMessage ใต้ TICKET_A (tenant A) */
  async function insertMessageA(opts: {
    authorMemberId?: string | null;
    authorContactId?: string | null;
  }): Promise<{ code?: string } | null> {
    try {
      await db.query(
        `INSERT INTO "TicketMessage" ("id","tenantId","ticketId","authorMemberId","authorContactId","visibility","body","bodyFormat","createdAt")
         VALUES ($1,$2,$3,$4,$5,'PUBLIC','hi','text',now())`,
        [id(`msg${randomUUID().slice(0, 4)}`), TENANT_A, TICKET_A, opts.authorMemberId ?? null, opts.authorContactId ?? null]
      );
      return null;
    } catch (e) {
      return e as { code?: string };
    }
  }

  it("POSITIVE CONTROL: requesterContact ใน tenant เดียวกัน insert ได้", async () => {
    const err = await insertTicketA({ ticketNumber: 100, requesterContactId: CONTACT_A });
    expect(err).toBeNull();
  });

  it("Ticket.requesterContact ข้าม tenant → FK violation (23503)", async () => {
    // ticket ของ A ชี้ contact ของ B → ต้องถูก reject
    const err = await insertTicketA({ ticketNumber: 101, requesterContactId: CONTACT_B });
    expect(err?.code).toBe(PG_FK_VIOLATION);
  });

  it("Ticket.assignee ข้าม tenant → FK violation (23503)", async () => {
    // requester ถูกต้อง (A) แต่ assignee เป็น member ของ B → ต้องถูก reject
    const err = await insertTicketA({ ticketNumber: 102, requesterContactId: CONTACT_A, assigneeId: MEMBER_B });
    expect(err?.code).toBe(PG_FK_VIOLATION);
  });

  it("POSITIVE CONTROL: assignee ใน tenant เดียวกัน insert ได้", async () => {
    const err = await insertTicketA({ ticketNumber: 103, requesterContactId: CONTACT_A, assigneeId: MEMBER_A });
    expect(err).toBeNull();
  });

  it("TicketMessage.authorContact ข้าม tenant → FK violation (23503)", async () => {
    const err = await insertMessageA({ authorContactId: CONTACT_B });
    expect(err?.code).toBe(PG_FK_VIOLATION);
  });

  it("TicketMessage.authorMember ข้าม tenant → FK violation (23503)", async () => {
    const err = await insertMessageA({ authorMemberId: MEMBER_B });
    expect(err?.code).toBe(PG_FK_VIOLATION);
  });

  it("POSITIVE CONTROL: message author ใน tenant เดียวกัน insert ได้", async () => {
    const errMember = await insertMessageA({ authorMemberId: MEMBER_A });
    expect(errMember).toBeNull();
    const errContact = await insertMessageA({ authorContactId: CONTACT_A });
    expect(errContact).toBeNull();
  });
});
