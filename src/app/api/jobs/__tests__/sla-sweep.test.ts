/**
 * src/app/api/jobs/__tests__/sla-sweep.test.ts
 * Integration tests สำหรับ POST /api/jobs/sla-sweep (QStash schedule worker, Phase 28 Slice 3)
 *
 * P0 invariants:
 *   - signature invalid → 401 (verify ก่อนแตะ DB)
 *   - per-tenant isolation: loop ราย tenant ผ่าน tenantPrisma(tenant.id) — ไม่ query ticket ข้าม tenant
 *     (ไม่เรียก base prisma.ticket.* ตรง ๆ; tenantPrisma ถูกเรียกด้วย tenant.id แต่ละตัว)
 *   - breach: atomic claim count===1 → audit.log(ticket.sla_breached) + createNotification(SLA_BREACH)
 *     claim count===0 (idempotent) → ไม่ notify/audit; assignee=null → audit แต่ไม่ notify
 *   - near-breach: gate ด้วย hasFeature — false → ไม่มี near-breach query/notify;
 *     true + remaining ≤ 20% window → SLA_NEAR_BREACH; remaining > 20% → ไม่ notify
 *   - response = aggregate counts เท่านั้น (ไม่มี ticket id / tenant-specific field)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  tenantFindManyMock,
  tenantPrismaMock,
  verifyMock,
  createNotificationMock,
  auditLogMock,
  hasFeatureMock,
} = vi.hoisted(() => {
  return {
    tenantFindManyMock: vi.fn(),
    tenantPrismaMock: vi.fn(),
    verifyMock: vi.fn(),
    createNotificationMock: vi.fn(),
    auditLogMock: vi.fn(),
    hasFeatureMock: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: { tenant: { findMany: (...a: unknown[]) => tenantFindManyMock(...a) } },
}));

// mock ครบทั้ง tenantPrisma + setRlsBypass + setTenantGuc (ไฟล์อื่นอาจ import; sla-sweep ใช้แค่ tenantPrisma)
vi.mock("@/lib/tenant", () => ({
  tenantPrisma: (tenantId: string) => tenantPrismaMock(tenantId),
  setRlsBypass: vi.fn(),
  setTenantGuc: vi.fn(),
}));

vi.mock("@/lib/queue", () => ({
  verifyQStashSignature: (req: unknown, url?: string) => verifyMock(req, url),
  getJobTargetUrl: (path: string) => `https://acme.helpwise.com${path}`,
  SLA_SWEEP_WORKER_PATH: "/api/jobs/sla-sweep",
}));

vi.mock("@/lib/notifications", () => ({
  createNotification: (...a: unknown[]) => createNotificationMock(...a),
}));

vi.mock("@/lib/audit", () => ({
  audit: { log: (...a: unknown[]) => auditLogMock(...a) },
}));

vi.mock("@/lib/features", () => ({
  hasFeature: (...a: unknown[]) => hasFeatureMock(...a),
  FEATURE_KEYS: { SLA_POLICIES: "sla_policies" },
}));

import { POST } from "@/app/api/jobs/sla-sweep/route";

/**
 * สร้าง fake tenant-scoped db ที่บันทึก call ตาม where clause
 * findMany คืน array ตาม "kind" ของ query (เดาจาก where keys)
 */
interface FakeTicket {
  id: string;
  assigneeId: string | null;
  priority?: string;
  firstResponseDueAt?: Date | null;
  resolutionDueAt?: Date | null;
  slaPolicy?: unknown;
}

interface FakeDbConfig {
  frBreach?: FakeTicket[];
  resBreach?: FakeTicket[];
  frNear?: FakeTicket[];
  resNear?: FakeTicket[];
  /** id ที่ claim จะ "แพ้" (count 0) — จำลอง idempotent/race */
  claimLoses?: Set<string>;
}

function makeFakeDb(cfg: FakeDbConfig) {
  const findMany = vi.fn(async (args: { where: Record<string, unknown> }) => {
    const w = args.where;
    if ("firstResponseNearBreachNotified" in w) return cfg.frNear ?? [];
    if ("resolutionNearBreachNotified" in w) return cfg.resNear ?? [];
    if ("firstResponseBreached" in w && w.firstRespondedAt === null) return cfg.frBreach ?? [];
    if ("resolutionBreached" in w && w.resolvedAt === null) return cfg.resBreach ?? [];
    return [];
  });
  const updateMany = vi.fn(async (args: { where: { id: string } }) => {
    const loses = cfg.claimLoses?.has(args.where.id);
    return { count: loses ? 0 : 1 };
  });
  return {
    ticket: { findMany, updateMany },
    notification: { create: vi.fn() },
  };
}

function makeRequest(): NextRequest {
  return new NextRequest(
    new Request("https://acme.helpwise.com/api/jobs/sla-sweep", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    })
  );
}

const PLAN = { name: "pro" };

beforeEach(() => {
  vi.clearAllMocks();
  verifyMock.mockResolvedValue({ valid: true, rawBody: "{}" });
  hasFeatureMock.mockResolvedValue(false);
  createNotificationMock.mockResolvedValue(undefined);
  auditLogMock.mockResolvedValue(undefined);
});

describe("POST /api/jobs/sla-sweep", () => {
  it("signature invalid → 401, ไม่แตะ DB", async () => {
    verifyMock.mockResolvedValue({ valid: false, rawBody: "{}" });

    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    expect(tenantFindManyMock).not.toHaveBeenCalled();
    expect(tenantPrismaMock).not.toHaveBeenCalled();
  });

  it("first-response breach: claim 1 → audit + createNotification(SLA_BREACH)", async () => {
    tenantFindManyMock.mockResolvedValue([{ id: "tenant-1", plan: PLAN, settings: {} }]);
    const db = makeFakeDb({
      frBreach: [{ id: "ticket-1", assigneeId: "member-1" }],
    });
    tenantPrismaMock.mockReturnValue(db);

    const res = await POST(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.firstResponseBreached).toBe(1);
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        actor: { type: "system" },
        action: "ticket.sla_breached",
        ticketId: "ticket-1",
      })
    );
    expect(createNotificationMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ memberId: "member-1", type: "SLA_BREACH", ticketId: "ticket-1" })
    );
  });

  it("breach claim count 0 (idempotent) → ไม่ notify/audit", async () => {
    tenantFindManyMock.mockResolvedValue([{ id: "tenant-1", plan: PLAN, settings: {} }]);
    const db = makeFakeDb({
      frBreach: [{ id: "ticket-1", assigneeId: "member-1" }],
      claimLoses: new Set(["ticket-1"]),
    });
    tenantPrismaMock.mockReturnValue(db);

    const res = await POST(makeRequest());
    const json = await res.json();

    expect(json.data.firstResponseBreached).toBe(0);
    expect(auditLogMock).not.toHaveBeenCalled();
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it("breach แต่ assigneeId=null → audit เรียก แต่ createNotification ไม่เรียก", async () => {
    tenantFindManyMock.mockResolvedValue([{ id: "tenant-1", plan: PLAN, settings: {} }]);
    const db = makeFakeDb({
      frBreach: [{ id: "ticket-1", assigneeId: null }],
    });
    tenantPrismaMock.mockReturnValue(db);

    const res = await POST(makeRequest());

    expect(res.status).toBe(200);
    expect(auditLogMock).toHaveBeenCalledTimes(1);
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it("near-breach: hasFeature=false → ไม่มี near-breach query/notify", async () => {
    hasFeatureMock.mockResolvedValue(false);
    tenantFindManyMock.mockResolvedValue([{ id: "tenant-1", plan: PLAN, settings: {} }]);
    const db = makeFakeDb({
      frNear: [
        {
          id: "ticket-9",
          assigneeId: "member-1",
          priority: "NORMAL",
          firstResponseDueAt: new Date(Date.now() + 60_000),
          slaPolicy: null,
        },
      ],
    });
    tenantPrismaMock.mockReturnValue(db);

    const res = await POST(makeRequest());
    const json = await res.json();

    expect(json.data.firstResponseNearBreach).toBe(0);
    expect(createNotificationMock).not.toHaveBeenCalled();
    // near-breach query (where มี firstResponseNearBreachNotified) ต้องไม่ถูกเรียก
    const calledNearQuery = db.ticket.findMany.mock.calls.some(
      (c) => "firstResponseNearBreachNotified" in (c[0] as { where: object }).where
    );
    expect(calledNearQuery).toBe(false);
  });

  it("near-breach: hasFeature=true + remaining ≤ 20% window → SLA_NEAR_BREACH", async () => {
    hasFeatureMock.mockResolvedValue(true);
    tenantFindManyMock.mockResolvedValue([{ id: "tenant-1", plan: PLAN, settings: {} }]);
    // NORMAL firstResponse default = 240 นาที → 20% = 48 นาที. due ในอีก 10 นาที (24/7) → near
    const db = makeFakeDb({
      frNear: [
        {
          id: "ticket-9",
          assigneeId: "member-1",
          priority: "NORMAL",
          firstResponseDueAt: new Date(Date.now() + 10 * 60_000),
          slaPolicy: null,
        },
      ],
    });
    tenantPrismaMock.mockReturnValue(db);

    const res = await POST(makeRequest());
    const json = await res.json();

    expect(json.data.firstResponseNearBreach).toBe(1);
    expect(createNotificationMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ memberId: "member-1", type: "SLA_NEAR_BREACH", ticketId: "ticket-9" })
    );
  });

  it("near-breach: remaining > 20% window → ไม่ notify", async () => {
    hasFeatureMock.mockResolvedValue(true);
    tenantFindManyMock.mockResolvedValue([{ id: "tenant-1", plan: PLAN, settings: {} }]);
    // NORMAL 240 นาที → 20% = 48 นาที. due ในอีก 120 นาที → ยังไม่ near
    const db = makeFakeDb({
      frNear: [
        {
          id: "ticket-9",
          assigneeId: "member-1",
          priority: "NORMAL",
          firstResponseDueAt: new Date(Date.now() + 120 * 60_000),
          slaPolicy: null,
        },
      ],
    });
    tenantPrismaMock.mockReturnValue(db);

    const res = await POST(makeRequest());
    const json = await res.json();

    expect(json.data.firstResponseNearBreach).toBe(0);
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it("per-tenant isolation: 2 tenant → tenantPrisma เรียกด้วย id แต่ละตัว, ไม่ใช้ base prisma.ticket", async () => {
    tenantFindManyMock.mockResolvedValue([
      { id: "tenant-A", plan: PLAN, settings: {} },
      { id: "tenant-B", plan: PLAN, settings: {} },
    ]);
    const dbA = makeFakeDb({ frBreach: [{ id: "a-1", assigneeId: "m-a" }] });
    const dbB = makeFakeDb({ frBreach: [{ id: "b-1", assigneeId: "m-b" }] });
    tenantPrismaMock.mockImplementation((id: string) => (id === "tenant-A" ? dbA : dbB));

    const res = await POST(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(tenantPrismaMock).toHaveBeenCalledWith("tenant-A");
    expect(tenantPrismaMock).toHaveBeenCalledWith("tenant-B");
    // ticket ของ A claim ผ่าน dbA, ของ B ผ่าน dbB — ไม่ปนกัน
    expect(dbA.ticket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "a-1" }) })
    );
    expect(dbB.ticket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "b-1" }) })
    );
    expect(json.data.firstResponseBreached).toBe(2);
  });

  it("response = aggregate counts เท่านั้น (ไม่มี ticket id / tenant field)", async () => {
    tenantFindManyMock.mockResolvedValue([{ id: "tenant-1", plan: PLAN, settings: {} }]);
    tenantPrismaMock.mockReturnValue(makeFakeDb({ frBreach: [{ id: "ticket-1", assigneeId: "m-1" }] }));

    const res = await POST(makeRequest());
    const json = await res.json();

    expect(Object.keys(json.data).sort()).toEqual(
      [
        "firstResponseBreached",
        "firstResponseNearBreach",
        "resolutionBreached",
        "resolutionNearBreach",
        "scannedAt",
      ].sort()
    );
  });

  // ---------------------------------------------------------------------------
  // เพิ่มโดย qa-testing (final gate) — ปิด gap ที่ implementer ยังไม่ครอบ:
  //   resolution-breach path, near-breach idempotency, per-tenant gate isolation,
  //   และ business-hours wiring (parse จาก tenant.settings → inject businessMinutesBetween)
  // ---------------------------------------------------------------------------

  it("resolution breach: claim 1 → audit + createNotification(SLA_BREACH) (path แยกจาก first-response)", async () => {
    tenantFindManyMock.mockResolvedValue([{ id: "tenant-1", plan: PLAN, settings: {} }]);
    const db = makeFakeDb({
      resBreach: [{ id: "ticket-res", assigneeId: "member-r" }],
    });
    tenantPrismaMock.mockReturnValue(db);

    const res = await POST(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.resolutionBreached).toBe(1);
    expect(json.data.firstResponseBreached).toBe(0);
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        actor: { type: "system" },
        action: "ticket.sla_breached",
        ticketId: "ticket-res",
        after: { resolutionBreached: true },
      })
    );
    expect(createNotificationMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ memberId: "member-r", type: "SLA_BREACH", ticketId: "ticket-res" })
    );
  });

  it("near-breach claim count 0 (idempotent/race) → ไม่ notify, count 0", async () => {
    hasFeatureMock.mockResolvedValue(true);
    tenantFindManyMock.mockResolvedValue([{ id: "tenant-1", plan: PLAN, settings: {} }]);
    // due ในอีก 10 นาที (NORMAL 240→20%=48) → เข้าเงื่อนไข near แต่ claim แพ้ (อีก worker คว้าไปก่อน)
    const db = makeFakeDb({
      frNear: [
        {
          id: "ticket-9",
          assigneeId: "member-1",
          priority: "NORMAL",
          firstResponseDueAt: new Date(Date.now() + 10 * 60_000),
          slaPolicy: null,
        },
      ],
      claimLoses: new Set(["ticket-9"]),
    });
    tenantPrismaMock.mockReturnValue(db);

    const res = await POST(makeRequest());
    const json = await res.json();

    expect(json.data.firstResponseNearBreach).toBe(0);
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it("per-tenant gate isolation: tenant A มี sla_policies → near-breach วิ่ง; tenant B ไม่มี → ข้าม near-breach", async () => {
    // gate ราย tenant: A=true, B=false (hasFeature ถูกเรียกด้วย planName ของแต่ละ tenant)
    hasFeatureMock.mockImplementation(async (tenantId: string) => tenantId === "tenant-A");
    tenantFindManyMock.mockResolvedValue([
      { id: "tenant-A", plan: PLAN, settings: {} },
      { id: "tenant-B", plan: PLAN, settings: {} },
    ]);
    const nearTicket = (id: string) => ({
      id,
      assigneeId: "m",
      priority: "NORMAL",
      firstResponseDueAt: new Date(Date.now() + 10 * 60_000), // < 20% window → near
      slaPolicy: null,
    });
    const dbA = makeFakeDb({ frNear: [nearTicket("a-near")] });
    const dbB = makeFakeDb({ frNear: [nearTicket("b-near")] });
    tenantPrismaMock.mockImplementation((id: string) => (id === "tenant-A" ? dbA : dbB));

    const res = await POST(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    // A: gate เปิด → near-breach query + claim + notify
    expect(json.data.firstResponseNearBreach).toBe(1);
    expect(dbA.ticket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "a-near" }) })
    );
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    expect(createNotificationMock).toHaveBeenCalledWith(
      dbA,
      expect.objectContaining({ ticketId: "a-near", type: "SLA_NEAR_BREACH" })
    );
    // B: gate ปิด → ไม่มี near-breach query เลย (ไม่หลุดข้าม gate)
    const bRanNearQuery = dbB.ticket.findMany.mock.calls.some(
      (c) => "firstResponseNearBreachNotified" in (c[0] as { where: object }).where
    );
    expect(bRanNearQuery).toBe(false);
  });

  it("business-hours wiring: parseBusinessHours จาก tenant.settings ถูก inject เข้าการตัดสิน near-breach", async () => {
    // ตั้ง bh จริงเปิดทุกวัน 00:00–23:59 (เทียบเท่า 24/7, deterministic ทุก now) —
    // พิสูจน์ว่า route อ่าน settings.businessHours → parse → ใช้คำนวณ remaining ได้จริง
    // (business-hours math เฉพาะทาง = sla.test.ts เป็นเจ้าของ; ที่นี่ทดสอบ wiring)
    hasFeatureMock.mockResolvedValue(true);
    const businessHours = {
      timezone: "Asia/Bangkok",
      days: (["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const).map((day) => ({
        day,
        start: "00:00",
        end: "23:59",
      })),
    };
    tenantFindManyMock.mockResolvedValue([
      { id: "tenant-1", plan: PLAN, settings: { businessHours } },
    ]);
    const db = makeFakeDb({
      frNear: [
        {
          id: "tk-near",
          assigneeId: "m-1",
          priority: "NORMAL",
          firstResponseDueAt: new Date(Date.now() + 10 * 60_000), // 10 นาที < 48 (20% of 240)
          slaPolicy: null,
        },
      ],
    });
    tenantPrismaMock.mockReturnValue(db);

    const res = await POST(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    // bh ถูก parse + inject สำเร็จ → remaining คำนวณได้ → near-breach trigger
    expect(json.data.firstResponseNearBreach).toBe(1);
    expect(createNotificationMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ ticketId: "tk-near", type: "SLA_NEAR_BREACH" })
    );
  });
});
