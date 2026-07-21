/**
 * src/lib/__tests__/isolation/op-coverage.test.ts
 *
 * UNHANDLED-OP guard (SUSPECTED_WEAKNESSES) — extension ครอบ operation ที่ codebase ใช้จริงครบไหม
 * ---------------------------------------------------------------------------------------------
 * ช่องโหว่ที่ security สงสัย: op ที่ไม่อยู่ใน branch ของ tenantPrisma ไม่ถูก inject tenantId
 * (แค่ console.warn + พึ่ง RLS ที่ "ปิดอยู่") → op หลุด branch = ไม่มี tenant scope เลย.
 *
 * harness: mock @/lib/prisma ด้วย "spy" ที่บันทึก args สุดท้ายที่ tenant.ts dispatch
 *   → ยืนยันตรง ๆ ว่าแต่ละ op ถูก inject tenantId เข้า where/data จริง (ไม่พึ่งผล engine).
 *
 * ครอบ 2 อย่าง:
 *   1. ทุก op ที่ codebase ใช้จริง → inject tenantId (where หรือ data)
 *   2. op นอก branch (สมมติ Prisma เพิ่มใหม่) → "ไม่" ถูก inject + warn = documenting gap
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SUSPECTED_WEAKNESSES } from "./threat-model";

vi.mock("@/lib/prisma", async () => {
  const { createSpyPrisma } = await import("./_engine");
  return { prisma: createSpyPrisma().prisma };
});

import { prisma as mockedPrisma } from "@/lib/prisma";
import { tenantPrisma } from "@/lib/tenant";
import type { SpyRecord, LooseClient } from "./_engine";

const records = (mockedPrisma as unknown as { __records: SpyRecord[] }).__records;
const TENANT = "tenant-A";

// tenantPrisma "ตัวจริง" cast เป็น LooseClient (ยิง payload attacker ที่ไม่ผ่าน TS)
function scoped(t: string): LooseClient {
  return tenantPrisma(t) as unknown as LooseClient;
}

const note = SUSPECTED_WEAKNESSES.find((w) => w.caseId === "UNHANDLED-OP");

beforeEach(() => {
  records.length = 0;
});

/** ทุก where-scoped op ที่ codebase ใช้จริง (find / count / aggregate / groupBy / delete / update) */
const WHERE_SCOPED_OPS = [
  "findUnique",
  "findFirst",
  "findMany",
  "findUniqueOrThrow",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "delete",
  "deleteMany",
  "update",
  "updateMany",
] as const;

describe(`UNHANDLED-OP — extension ครอบ op ที่ใช้จริงครบ (${note?.caseId})`, () => {
  it("ทุก where-scoped op → inject where.tenantId", async () => {
    const db = scoped(TENANT);
    for (const op of WHERE_SCOPED_OPS) {
      records.length = 0;
      const call = (db as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>)
        .ticket[op];
      const args = op.startsWith("update")
        ? { where: {}, data: { subject: "x" } }
        : { where: {} };
      await call(args);
      const rec = records.find((r) => r.operation === op);
      expect(rec, `op ${op} ต้อง dispatch`).toBeDefined();
      const where = rec!.args.where as Record<string, unknown>;
      expect(where?.tenantId, `op ${op} ต้อง inject where.tenantId`).toBe(TENANT);
    }
  });

  it("create/createMany/upsert → inject data/create.tenantId", async () => {
    const db = scoped(TENANT);

    records.length = 0;
    await db.ticket.create({ data: { subject: "x" } });
    expect((records[0].args.data as Record<string, unknown>).tenantId).toBe(TENANT);

    records.length = 0;
    await db.ticket.createMany({ data: [{ subject: "a" }, { subject: "b" }] });
    const many = records[0].args.data as Array<Record<string, unknown>>;
    expect(many.every((r) => r.tenantId === TENANT)).toBe(true);

    records.length = 0;
    await db.ticket.upsert({ where: {}, create: { subject: "c" }, update: { subject: "d" } });
    expect((records[0].args.create as Record<string, unknown>).tenantId).toBe(TENANT);
    expect((records[0].args.where as Record<string, unknown>).tenantId).toBe(TENANT);
  });

  it("update/updateMany/upsert.update → strip tenantId ออกจาก data (B-1, ห้ามย้าย tenant)", async () => {
    const db = scoped(TENANT);

    records.length = 0;
    await db.ticket.update({ where: { id: "t1" }, data: { tenantId: "evil", subject: "x" } });
    expect((records[0].args.data as Record<string, unknown>).tenantId).toBeUndefined();

    records.length = 0;
    await db.ticket.upsert({ where: {}, create: { subject: "c" }, update: { tenantId: "evil", subject: "d" } });
    expect((records[0].args.update as Record<string, unknown>).tenantId).toBeUndefined();
  });

  it("op นอก branch (unknown) → 'ไม่' ถูก inject tenantId (documenting gap ที่พึ่ง RLS ปิดอยู่)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = scoped(TENANT);
    // จำลอง Prisma op ในอนาคตที่ extension ไม่มี branch รองรับ
    const unknownOp = (db as unknown as Record<string, Record<string, (a: unknown) => Promise<unknown>>>)
      .ticket["findRaw"];
    await unknownOp({ filter: {} });
    const rec = records.find((r) => r.operation === "findRaw");
    expect(rec).toBeDefined();
    // ⚠️ gap: args ไม่ถูกเติม tenantId — พึ่ง RLS เป็น backstop ซึ่งปิดอยู่ (RLS_ENABLED=off)
    expect((rec!.args as Record<string, unknown>).tenantId).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled(); // extension เตือนไว้ (ไม่ silent)
    warnSpy.mockRestore();
  });

  it("GLOBAL_MODELS (user) → ไม่ inject tenantId (ไม่มีคอลัมน์ tenantId)", async () => {
    const db = scoped(TENANT);
    records.length = 0;
    await db.user.findMany({ where: { email: "a@a.com" } });
    const where = records[0].args.where as Record<string, unknown>;
    expect(where.tenantId).toBeUndefined();
  });
});
