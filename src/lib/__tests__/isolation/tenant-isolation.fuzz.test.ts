/**
 * src/lib/__tests__/isolation/tenant-isolation.fuzz.test.ts
 *
 * Tier 1 — tenantPrisma() isolation (โค้ดจริงจาก src/lib/tenant.ts)
 * ----------------------------------------------------------------
 * ทดสอบ axis ที่ enforce ที่ชั้น tenantPrisma extension:
 *   cross-tenant-read / write / delete / tenant-move (B-1) + unhandled-op guard
 *
 * 🎯 harness: mock เฉพาะ @/lib/prisma ด้วย "faithful in-memory engine" (_engine.ts)
 *    ที่โง่เรื่อง tenant — ให้ tenant.ts (โค้ดจริง) เป็นคน inject tenantId.
 *    ➡️ ถ้าลบบรรทัด inject where.tenantId ใน tenant.ts ออก → XT-READ-01 แดงทันที
 *       = หลักฐานว่า suite นี้ทดสอบโค้ดจริง ไม่ใช่ mock ของตัวเอง (ไม่ใช่ tautology).
 *
 * case ที่ fuzzable → fast-check property (สุ่มหลาย tenant/หลาย row ปนกัน) ทุก run.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";
import { RecordNotFoundError, type Store, type LooseClient } from "./_engine";
import { ATTACK_CASES, type AttackCase } from "./threat-model";

// mock boundary = @/lib/prisma เท่านั้น (async factory → กัน TDZ ของ vi.hoisted)
vi.mock("@/lib/prisma", async () => {
  const { createFaithfulPrisma } = await import("./_engine");
  return { prisma: createFaithfulPrisma({}).prisma };
});

import { prisma as mockedPrisma } from "@/lib/prisma";
import { tenantPrisma } from "@/lib/tenant";

// store เดียวกับที่ engine ใช้ (mutate property ได้; ห้าม reassign ตัวแปร)
const store = (mockedPrisma as unknown as { __store: Store }).__store;

// scoped() = tenantPrisma "ตัวจริง" cast เป็น LooseClient เพื่อยิง attacker payload ที่ไม่ผ่าน TS
// (runtime = โค้ด tenantPrisma จริง 100%; ผ่อนเฉพาะ compile-time type)
function scoped(t: string): LooseClient {
  return tenantPrisma(t) as unknown as LooseClient;
}

// ตัวช่วย traceability: ผูก it() กลับ case id ใน contract
function caseOf(id: string): AttackCase {
  const c = ATTACK_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`ATTACK_CASES ไม่มี id: ${id}`);
  return c;
}
function name(id: string): string {
  return `${id} — ${caseOf(id).title}`;
}

const A = "tenant-A";
const B = "tenant-B";
const C = "tenant-C";
const TENANTS = [A, B, C] as const;

function resetStore(): void {
  for (const k of Object.keys(store)) delete store[k];
  store.ticket = [];
  store.contact = [];
  store.ticketMessage = [];
  store.tenantMember = [];
  store.user = [];
}

beforeEach(() => {
  resetStore();
});

// arbitrary: ticket ข้าม tenant ปนกัน
const ticketArb = fc.record({
  id: fc.uuid(),
  tenantId: fc.constantFrom(...TENANTS),
  ticketNumber: fc.integer({ min: 1, max: 9999 }),
  subject: fc.string(),
  status: fc.constantFrom("NEW", "OPEN", "PENDING", "SOLVED", "CLOSED"),
});

function seedTickets(rows: Array<{ id: string; tenantId: string; ticketNumber: number; subject: string; status: string }>): void {
  // uniq id เพื่อเลี่ยง id ชนกัน (fast-check อาจสุ่มซ้ำ)
  const seen = new Set<string>();
  store.ticket = rows
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .map((r) => ({ ...r }));
}

// =============================================================================
// AXIS 1 — cross-tenant-read
// =============================================================================

describe("axis: cross-tenant-read", () => {
  it(name("XT-READ-01"), async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(ticketArb, { minLength: 1, maxLength: 40 }), async (rows) => {
        resetStore();
        seedTickets(rows);
        const db = scoped(A);
        const result = (await db.ticket.findMany()) as Array<{ tenantId: string }>;
        // ทุก row ต้องเป็นของ A; และต้องได้ครบทุก row ของ A (ไม่ตกหล่น)
        expect(result.every((r) => r.tenantId === A)).toBe(true);
        expect(result.length).toBe(store.ticket.filter((r) => r.tenantId === A).length);
      })
    );
  });

  it(name("XT-READ-02"), async () => {
    // suspected: filtered-findUnique — inject tenantId ต้องเป็น filter จริง (คืน null เมื่อไม่ตรง)
    await fc.assert(
      fc.asyncProperty(fc.uuid(), fc.integer({ min: 1, max: 9999 }), async (id, num) => {
        resetStore();
        // record ของ tenant B เท่านั้น
        store.ticket = [{ id, tenantId: B, ticketNumber: num, subject: "secret", status: "OPEN" }];
        const db = scoped(A);
        // attacker รู้ id จริงของ B
        const viaUnique = await db.ticket.findUnique({ where: { id } });
        const viaFirst = await db.ticket.findFirst({ where: { id } });
        expect(viaUnique).toBeNull();
        expect(viaFirst).toBeNull();
        // แต่ tenant เจ้าของเห็นได้
        const owner = await scoped(B).ticket.findUnique({ where: { id } });
        expect(owner).not.toBeNull();
      })
    );
  });

  it(name("XT-READ-03"), async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(ticketArb, { minLength: 1, maxLength: 30 }), async (rows) => {
        resetStore();
        seedTickets(rows);
        const db = scoped(A);
        // where แฝง OR/NOT ที่อ้าง tenant อื่น — extension AND top-level tenantId=A ทับ
        const result = (await db.ticket.findMany({
          where: { OR: [{ tenantId: B }, { NOT: { tenantId: A } }] },
        })) as Array<{ tenantId: string }>;
        expect(result.every((r) => r.tenantId === A)).toBe(true);
      })
    );
  });

  it(name("XT-READ-04"), async () => {
    // nested include: relation ไม่ถูก inject tenantId — isolation อาศัย FK integrity
    // (clean FK) → nested read ต้องไม่หลุด tenant อื่น. ดู XT-WRITE-05 สำหรับกรณี FK ปนเปื้อน
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...TENANTS), { minLength: 2, maxLength: 6 }),
        async (msgTenants) => {
          resetStore();
          // ticket ของ A + messages FK ถูกต้อง (ticketId ชี้ ticket ของ tenant เดียวกันเสมอ)
          store.ticket = [{ id: "tA", tenantId: A, ticketNumber: 1, subject: "s", status: "OPEN" }];
          store.ticketMessage = msgTenants.map((t, i) => ({
            id: `m${i}`,
            tenantId: t,
            // FK ถูกต้อง: message ผูก ticket ของ tenant ตัวเอง (มีเฉพาะ tA สำหรับ A)
            ticketId: t === A ? "tA" : `t-${t}`,
            visibility: "PUBLIC",
            body: "x",
          }));
          const db = scoped(A);
          const ticket = (await db.ticket.findFirst({
            where: { id: "tA" },
            include: { messages: true },
          })) as { messages: Array<{ tenantId: string }> } | null;
          const msgs = ticket?.messages ?? [];
          // ทุก message ที่ traverse ผ่าน include ต้องเป็นของ A (FK สะอาด → ไม่หลุด)
          expect(msgs.every((m) => m.tenantId === A)).toBe(true);
        }
      )
    );
  });

  it(name("XT-READ-05"), async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(ticketArb, { minLength: 1, maxLength: 40 }), async (rows) => {
        resetStore();
        seedTickets(rows);
        const db = scoped(A);
        const expected = store.ticket.filter((r) => r.tenantId === A);

        const count = await db.ticket.count();
        expect(count).toBe(expected.length);

        const agg = (await db.ticket.aggregate({ _sum: { ticketNumber: true } })) as {
          _sum: { ticketNumber: number };
        };
        const sumA = expected.reduce((s, r) => s + (r.ticketNumber as number), 0);
        expect(agg._sum.ticketNumber).toBe(sumA);

        const grouped = (await db.ticket.groupBy({ by: ["status"], _count: true })) as Array<{
          _count: number;
        }>;
        const totalGrouped = grouped.reduce((s, g) => s + g._count, 0);
        // groupBy นับเฉพาะ tenant A (ไม่รวม tenant อื่น)
        expect(totalGrouped).toBe(expected.length);
      })
    );
  });
});

// =============================================================================
// AXIS 2 — cross-tenant-write
// =============================================================================

describe("axis: cross-tenant-write", () => {
  it(name("XT-WRITE-01"), async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(ticketArb, { minLength: 1, maxLength: 30 }), async (rows) => {
        resetStore();
        seedTickets(rows.map((r) => ({ ...r, status: "OPEN", subject: "orig" })));
        const before = store.ticket.map((r) => ({ id: r.id, tenantId: r.tenantId, subject: r.subject }));
        const db = scoped(A);
        await db.ticket.updateMany({ where: { status: "OPEN" }, data: { subject: "HACKED" } });
        for (const row of store.ticket) {
          if (row.tenantId === A) expect(row.subject).toBe("HACKED");
          else {
            const orig = before.find((b) => b.id === row.id)!;
            expect(row.subject).toBe(orig.subject); // tenant อื่นไม่ถูกแตะ
          }
        }
      })
    );
  });

  it(name("XT-WRITE-02"), async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (id) => {
        resetStore();
        store.ticket = [{ id, tenantId: B, ticketNumber: 1, subject: "orig", status: "OPEN" }];
        const db = scoped(A);
        // update by id ของ B → inject tenantId=A → ไม่ match → P2025
        await expect(db.ticket.update({ where: { id }, data: { subject: "HACKED" } })).rejects.toMatchObject(
          { code: "P2025" }
        );
        expect(store.ticket[0].subject).toBe("orig"); // B ไม่ถูกแก้
      })
    );
  });

  it(name("XT-WRITE-03"), async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(B, C, "spoof"), async (spoof) => {
        resetStore();
        const db = scoped(A);
        const created = (await db.ticket.create({
          data: { subject: "s", ticketNumber: 1, tenantId: spoof },
        })) as { tenantId: string };
        // ค่า tenantId ที่ client ยัด ต้องถูก override เป็น ctx
        expect(created.tenantId).toBe(A);
        expect(store.ticket.every((r) => r.tenantId === A)).toBe(true);
      })
    );
  });

  it(name("XT-WRITE-04"), async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(A, B, C, undefined), { minLength: 1, maxLength: 8 }),
        async (spoofTenants) => {
          resetStore();
          const db = scoped(A);
          await db.ticket.createMany({
            data: spoofTenants.map((t, i) => ({
              subject: `s${i}`,
              ticketNumber: i + 1,
              ...(t !== undefined ? { tenantId: t } : {}),
            })),
          });
          // ทุก record ที่สร้างต้องเป็นของ A (ไม่มีหลุดไป tenant อื่น)
          expect(store.ticket.length).toBe(spoofTenants.length);
          expect(store.ticket.every((r) => r.tenantId === A)).toBe(true);
        }
      )
    );
  });

  it(`${name("XT-WRITE-05")}  [CLOSED — composite tenant FK reject cross-tenant connect]`, async () => {
    // ✅ finding XT-WRITE-05 ปิดแล้วทุกชั้น:
    //   DB : migration 20260720000000 เปลี่ยน 4 FK ของ Ticket/TicketMessage เป็น composite
    //        [tenantId, xxxId] -> Target[tenantId, id] → Postgres reject cross-tenant FK (23503 → P2003)
    //        (พิสูจน์ด้วย real-DB: composite-fk.integration.test.ts 7/7)
    //   app: verifyContactBelongsToTenant / verifyAssigneeMembership → 400 ก่อนถึง DB;
    //        residual violation → toAuthErrorResponse map P2003 → 400 INVALID_REFERENCE (ดู route-isolation)
    //   test: engine mirror composite FK (COMPOSITE_TENANT_FKS ใน _engine.ts)
    //
    // invariant: ห้ามสร้าง record ที่ FK ชี้ record ของ tenant อื่น → engine ต้อง throw FK violation.
    // 🔬 regression proof: ลบ entry 'ticket' ออกจาก COMPOSITE_TENANT_FKS ใน _engine.ts → connect สำเร็จ
    //    → assertion "rejects P2003" แดงทันที (หลักฐานว่า test นี้จับ regression จริง เหมือน XT-READ-01).
    resetStore();
    store.contact = [{ id: "contact-B", tenantId: B, email: "b@b.com", isActive: true }];
    const db = scoped(A);

    // (1) cross-tenant connect ต้องถูก reject (FK violation) — ไม่สร้าง ticket ปนเปื้อน
    await expect(
      db.ticket.create({
        data: {
          subject: "s",
          ticketNumber: 1,
          // attacker พยายาม connect requesterContact เป็น contact ของ tenant B
          requesterContact: { connect: { id: "contact-B" } },
        },
      })
    ).rejects.toMatchObject({ code: "P2003" });
    expect(store.ticket.length).toBe(0); // ไม่มี ticket ปนเปื้อนหลุดเข้า store

    // (2) positive control: connect contact ของ tenant เดียวกัน → สร้างได้
    //     (พิสูจน์ว่า engine ไม่ได้ throw มั่ว — FK เขียวเมื่อ tenant ตรง)
    store.contact.push({ id: "contact-A", tenantId: A, email: "a@a.com", isActive: true });
    const created = (await db.ticket.create({
      data: {
        subject: "s2",
        ticketNumber: 2,
        requesterContact: { connect: { id: "contact-A" } },
      },
    })) as { tenantId: string; requesterContactId?: string };
    expect(created.tenantId).toBe(A);
    expect(created.requesterContactId).toBe("contact-A");
  });
});

// =============================================================================
// AXIS 3 — cross-tenant-delete
// =============================================================================

describe("axis: cross-tenant-delete", () => {
  it(name("XT-DEL-01"), async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(ticketArb, { minLength: 1, maxLength: 30 }), async (rows) => {
        resetStore();
        seedTickets(rows.map((r) => ({ ...r, status: "CLOSED" })));
        const otherBefore = store.ticket.filter((r) => r.tenantId !== A).length;
        const db = scoped(A);
        await db.ticket.deleteMany({ where: { status: "CLOSED" } });
        expect(store.ticket.every((r) => r.tenantId !== A)).toBe(true); // A ถูกลบหมด
        expect(store.ticket.length).toBe(otherBefore); // tenant อื่นคงเดิม
      })
    );
  });

  it(name("XT-DEL-02"), async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (id) => {
        resetStore();
        store.ticket = [{ id, tenantId: B, ticketNumber: 1, subject: "s", status: "OPEN" }];
        const db = scoped(A);
        await expect(db.ticket.delete({ where: { id } })).rejects.toBeInstanceOf(RecordNotFoundError);
        expect(store.ticket.length).toBe(1); // B ยังอยู่
      })
    );
  });

  it(name("XT-DEL-03"), async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(ticketArb, { minLength: 1, maxLength: 30 }), async (rows) => {
        resetStore();
        seedTickets(rows);
        const otherBefore = store.ticket.filter((r) => r.tenantId !== A).length;
        const db = scoped(A);
        // deleteMany({}) — ห้ามล้างทั้งตาราง (mass data loss ข้าม tenant)
        await db.ticket.deleteMany({});
        expect(store.ticket.every((r) => r.tenantId !== A)).toBe(true);
        expect(store.ticket.length).toBe(otherBefore);
      })
    );
  });
});

// =============================================================================
// AXIS 4 — tenant-move (B-1)
// =============================================================================

describe("axis: tenant-move (B-1)", () => {
  it(name("B1-MOVE-01"), async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), fc.constantFrom(B, C), async (id, dest) => {
        resetStore();
        store.ticket = [{ id, tenantId: A, ticketNumber: 1, subject: "s", status: "OPEN" }];
        const db = scoped(A);
        await db.ticket.update({ where: { id }, data: { tenantId: dest, subject: "upd" } });
        // data.tenantId ถูก strip → record ยังอยู่ tenant เดิม
        expect(store.ticket[0].tenantId).toBe(A);
        expect(store.ticket[0].subject).toBe("upd");
      })
    );
  });

  it(name("B1-MOVE-02"), async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.uuid(), { minLength: 1, maxLength: 8 }), fc.constantFrom(B, C), async (ids, dest) => {
        resetStore();
        const uniq = [...new Set(ids)];
        store.ticket = uniq.map((id, i) => ({ id, tenantId: A, ticketNumber: i + 1, subject: "s", status: "OPEN" }));
        const db = scoped(A);
        await db.ticket.updateMany({ where: {}, data: { tenantId: dest, subject: "upd" } });
        expect(store.ticket.every((r) => r.tenantId === A)).toBe(true);
      })
    );
  });

  it(name("B1-MOVE-03"), async () => {
    resetStore();
    store.ticket = [{ id: "t1", tenantId: A, ticketNumber: 1, subject: "orig", status: "OPEN" }];
    const db = scoped(A);
    await db.ticket.upsert({
      where: { id: "t1" },
      create: { id: "t1", subject: "new", ticketNumber: 1 },
      update: { subject: "upd", tenantId: B }, // ยัด tenantId ใน update block
    });
    expect(store.ticket[0].tenantId).toBe(A); // strip → อยู่ tenant เดิม
    expect(store.ticket[0].subject).toBe("upd");
  });

  it(name("B1-MOVE-04"), async () => {
    resetStore();
    const db = scoped(A);
    await db.ticket.upsert({
      where: { id: "t-new" },
      create: { id: "t-new", subject: "new", ticketNumber: 1, tenantId: B }, // ยัด tenantId ใน create
      update: { subject: "upd" },
    });
    const created = store.ticket.find((r) => r.id === "t-new")!;
    expect(created.tenantId).toBe(A); // override เป็น ctx
  });
});
