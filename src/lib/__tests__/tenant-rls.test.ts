/**
 * src/lib/__tests__/tenant-rls.test.ts
 * Unit tests สำหรับ Phase 27 (RLS GUC injection) ใน tenantPrisma()
 *
 * ยืนยัน 3 พฤติกรรมหลัก:
 * 1. operation บน tenant model ปกติ → ต้อง wrap ผ่าน prisma.$transaction และตั้ง
 *    set_config('app.current_tenant_id', ...) ก่อน dispatch ไปยัง delegate ที่ถูกตัว
 *    พร้อม args ที่ inject tenantId แล้ว
 * 2. GLOBAL_MODELS (user/plan/featureFlag) → ไม่ wrap transaction, ไม่ตั้ง GUC,
 *    เรียก query() ตรง
 * 3. raw operation (queryRaw/executeRaw) → throw error เหมือนเดิม (ไม่ regress)
 *
 * Mock boundary: mock เฉพาะ "@/lib/prisma" ด้วย stub ที่มี $extends แบบจำลอง
 * (จับ config object ที่ tenantPrisma ส่งเข้ามา แล้วเรียก $allOperations callback
 * ตรง ๆ — เพราะ Prisma runtime จริงของ $extends ทำงานเฉพาะกับ PrismaClient instance
 * ที่ต่อ DB จริง ใช้ใน unit test ไม่ได้) ดู pattern เดียวกับ
 * src/app/api/__tests__/ticket-merge.test.ts สำหรับการ mock @/lib/prisma
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface AllOperationsArgs {
  model?: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
}

interface ExtendConfig {
  query: {
    $allModels: {
      $allOperations: (a: AllOperationsArgs) => Promise<unknown>;
    };
  };
}

const { txClient, transactionMock, baseDelegateSpy, queryFnMock, prismaStub } = vi.hoisted(
  () => {
    // fake delegate ของ tx (base, un-extended) — แทน tx.ticket / tx.user เป็นต้น
    const baseDelegateSpy = vi.fn(async (args: unknown) => ({ ok: true, args }));

    const txClient = {
      $executeRaw: vi.fn(async () => 1),
      ticket: {
        findMany: baseDelegateSpy,
        create: baseDelegateSpy,
        update: baseDelegateSpy,
        upsert: baseDelegateSpy,
      },
    };

    const transactionMock = vi.fn(
      async (cb: (tx: typeof txClient) => Promise<unknown>) => cb(txClient)
    );

    // stand-in สำหรับ original prisma method ("query" ที่ extension รับเข้ามา)
    // — ใช้แทน path ของ GLOBAL_MODELS ที่เรียก query(args) ตรง ๆ ไม่ผ่าน tx
    const queryFnMock = vi.fn(async (args: unknown) => ({ ok: true, args }));

    const prismaStub = {
      $transaction: (cb: (tx: typeof txClient) => Promise<unknown>) => transactionMock(cb),
      // จำลอง $extends ของ Prisma — เก็บ config ไว้ไม่ต้อง wrap runtime จริง
      // เพราะ unit test นี้ทดสอบ "การเรียก" ของ $allOperations callback ตรง ๆ
      $extends: vi.fn((config: unknown) => config),
    };

    return { txClient, transactionMock, baseDelegateSpy, queryFnMock, prismaStub };
  }
);

vi.mock("@/lib/prisma", () => ({
  prisma: prismaStub,
}));

import { tenantPrisma } from "@/lib/tenant";

const TENANT_ID = "tenant-rls-test";

/** เรียก tenantPrisma(tenantId) แล้วดึง $allOperations callback ที่ส่งเข้า $extends ออกมา */
function getAllOperations(tenantId: string) {
  tenantPrisma(tenantId);
  const config = prismaStub.$extends.mock.calls.at(-1)?.[0] as ExtendConfig;
  return config.query.$allModels.$allOperations;
}

describe("tenantPrisma — Phase 27 RLS GUC injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // ทดสอบพฤติกรรม wrap-tx/ตั้ง GUC → ต้องเปิด kill-switch
    vi.stubEnv("RLS_ENABLED", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normal model (ticket.findMany) → wrap ผ่าน prisma.$transaction และตั้ง GUC ก่อน dispatch", async () => {
    const allOperations = getAllOperations(TENANT_ID);

    await allOperations({
      model: "Ticket",
      operation: "findMany",
      args: { where: { status: "OPEN" } },
      query: queryFnMock,
    });

    // ต้องเรียก $transaction ของ base prisma — ไม่ใช่ query() ตรง
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(queryFnMock).not.toHaveBeenCalled();

    // ต้องตั้ง GUC ก่อน dispatch ไปยัง delegate จริง
    expect(txClient.$executeRaw).toHaveBeenCalledTimes(1);
    const executeRawCall = txClient.$executeRaw.mock.calls[0] as unknown as unknown[];
    const sqlFragments = executeRawCall[0] as unknown as string[];
    expect(sqlFragments.join("")).toContain("set_config");
    expect(sqlFragments.join("")).toContain("app.current_tenant_id");
    expect(executeRawCall).toContain(TENANT_ID);

    // ต้อง dispatch ไปยัง delegate ที่ถูกตัว (ticket.findMany) พร้อม args ที่ inject tenantId แล้ว
    expect(baseDelegateSpy).toHaveBeenCalledTimes(1);
    const dispatchedArgs = baseDelegateSpy.mock.calls[0][0] as {
      where: Record<string, unknown>;
    };
    expect(dispatchedArgs.where).toMatchObject({ status: "OPEN", tenantId: TENANT_ID });
  });

  it("create operation → inject tenantId ใน data และยัง wrap tx + ตั้ง GUC", async () => {
    const allOperations = getAllOperations(TENANT_ID);

    await allOperations({
      model: "Ticket",
      operation: "create",
      args: { data: { subject: "test" } },
      query: queryFnMock,
    });

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(txClient.$executeRaw).toHaveBeenCalledTimes(1);
    expect(queryFnMock).not.toHaveBeenCalled();

    const dispatchedArgs = baseDelegateSpy.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(dispatchedArgs.data).toMatchObject({ subject: "test", tenantId: TENANT_ID });
  });

  it("update operation → inject where.tenantId และ strip tenantId ออกจาก data (B-1)", async () => {
    const allOperations = getAllOperations(TENANT_ID);

    await allOperations({
      model: "Ticket",
      operation: "update",
      // caller แอบส่ง data.tenantId เป็น tenant อื่น — ต้องถูก strip กันย้าย record ข้าม tenant
      args: { where: { id: "t1" }, data: { subject: "x", tenantId: "evil-tenant" } },
      query: queryFnMock,
    });

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(txClient.$executeRaw).toHaveBeenCalledTimes(1);

    const dispatched = baseDelegateSpy.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // where ถูก scope ด้วย tenantId ของ context
    expect(dispatched.where).toMatchObject({ id: "t1", tenantId: TENANT_ID });
    // data.tenantId (evil) ถูก strip ทิ้ง
    expect(dispatched.data).not.toHaveProperty("tenantId");
    expect(dispatched.data).toMatchObject({ subject: "x" });
  });

  it("upsert operation → inject where+create tenantId และ strip tenantId ออกจาก update (B-1)", async () => {
    const allOperations = getAllOperations(TENANT_ID);

    await allOperations({
      model: "Ticket",
      operation: "upsert",
      args: {
        where: { id: "t1" },
        create: { subject: "new" },
        update: { subject: "upd", tenantId: "evil-tenant" },
      },
      query: queryFnMock,
    });

    const dispatched = baseDelegateSpy.mock.calls[0][0] as {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(dispatched.where).toMatchObject({ id: "t1", tenantId: TENANT_ID });
    expect(dispatched.create).toMatchObject({ subject: "new", tenantId: TENANT_ID });
    // update block ห้ามมี tenantId (กัน update ย้าย tenant)
    expect(dispatched.update).not.toHaveProperty("tenantId");
    expect(dispatched.update).toMatchObject({ subject: "upd" });
  });

  it("GLOBAL_MODELS (user) → ไม่ wrap transaction, ไม่ตั้ง GUC, เรียก query() ตรง", async () => {
    const allOperations = getAllOperations(TENANT_ID);

    const args = { where: { email: "a@b.com" } };
    await allOperations({
      model: "User",
      operation: "findMany",
      args,
      query: queryFnMock,
    });

    // ไม่ควรเรียก $transaction หรือตั้ง GUC สำหรับ global model
    expect(transactionMock).not.toHaveBeenCalled();
    expect(txClient.$executeRaw).not.toHaveBeenCalled();

    // ต้องเรียก query() เดิมตรง ๆ โดยไม่ inject tenantId เข้า where
    expect(queryFnMock).toHaveBeenCalledTimes(1);
    expect(queryFnMock).toHaveBeenCalledWith(args);
  });

  it("RLS_ENABLED ปิด → ไม่ wrap tx, ไม่ตั้ง GUC, เรียก query() ตรง (kill-switch)", async () => {
    vi.stubEnv("RLS_ENABLED", "false");
    const allOperations = getAllOperations(TENANT_ID);

    await allOperations({
      model: "Ticket",
      operation: "findMany",
      args: { where: { status: "OPEN" } },
      query: queryFnMock,
    });

    // flag ปิด → พฤติกรรมเดิม: ไม่ wrap transaction, ไม่ตั้ง GUC
    expect(transactionMock).not.toHaveBeenCalled();
    expect(txClient.$executeRaw).not.toHaveBeenCalled();

    // ยังต้องเรียก query() เดิม พร้อม args ที่ inject tenantId แล้ว (app-layer ยังกัน cross-tenant)
    expect(queryFnMock).toHaveBeenCalledTimes(1);
    const calledArgs = queryFnMock.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(calledArgs.where).toMatchObject({ status: "OPEN", tenantId: TENANT_ID });
  });

  it("raw operation (queryRaw/executeRaw) → throw error เหมือนเดิม (ไม่ regress)", async () => {
    const allOperations = getAllOperations(TENANT_ID);

    await expect(
      allOperations({
        model: "Ticket",
        operation: "queryRaw",
        args: {},
        query: queryFnMock,
      })
    ).rejects.toThrow(/Raw SQL via tenantPrisma is not allowed/);

    expect(transactionMock).not.toHaveBeenCalled();
    expect(queryFnMock).not.toHaveBeenCalled();
  });
});
