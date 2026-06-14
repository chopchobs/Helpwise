/**
 * src/app/api/__tests__/reports.test.ts
 * Integration tests สำหรับ GET /api/reports (Phase 24 — Reporting/Analytics)
 *
 * P1 invariants:
 *   - feature gate: hasFeature(ANALYTICS) → 403 FEATURE_LOCKED ถ้าปิด
 *   - auth: requireAgent() throw → propagate ผ่าน toAuthErrorResponse
 *   - date range: default 30 วัน, from>to หรือ >366 วัน → 400 VALIDATION_ERROR
 *   - metrics: slaBreachRate, avg minutes, csatAverage, byPriority (4 enum), byChannel, trend
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultCtx, makeNextRequest } from "@/app/api/__tests__/_helpers";

const { fakeDb, requireAgentMock, hasFeatureMock } = vi.hoisted(() => {
  const fakeDb = {
    ticket: {
      count: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
    csatResponse: {
      aggregate: vi.fn(),
    },
  };
  return {
    fakeDb,
    requireAgentMock: vi.fn(),
    hasFeatureMock: vi.fn(),
  };
});

vi.mock("@/lib/tenant", () => ({
  getTenantContext: vi.fn(),
  tenantPrisma: () => fakeDb,
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAgent: (...args: unknown[]) => requireAgentMock(...args),
  };
});

vi.mock("@/lib/features", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/features")>();
  return {
    ...actual,
    hasFeature: (...args: unknown[]) => hasFeatureMock(...args),
  };
});

import { GET } from "@/app/api/reports/route";
import { AuthError } from "@/lib/auth";

const SESSION = {
  user: { id: "user-1", name: "Agent" },
  member: { id: "member-1", role: "AGENT", userId: "user-1" },
  ctx: defaultCtx(),
};

function makeReq(qs = "") {
  return new Request(`https://acme.helpwise.com/api/reports${qs}`);
}

/** default: empty data — ครบทุก query ของ Promise.all (9 element) */
function mockEmptyData() {
  fakeDb.ticket.count.mockResolvedValue(0); // ใช้ทั้ง 3 count call (created/resolved/breached)
  fakeDb.ticket.findMany.mockResolvedValue([]); // ใช้ทั้ง findMany calls
  fakeDb.ticket.groupBy.mockResolvedValue([]); // priority/channel groups
  fakeDb.csatResponse.aggregate.mockResolvedValue({ _avg: { rating: null }, _count: { id: 0 } });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAgentMock.mockResolvedValue(SESSION);
  hasFeatureMock.mockResolvedValue(true);
  mockEmptyData();
});

// =============================================================================
// Feature gate
// =============================================================================

describe("GET /api/reports — feature gate", () => {
  it("hasFeature=false → 403 FEATURE_LOCKED, data null, ไม่ query db", async () => {
    hasFeatureMock.mockResolvedValue(false);

    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.data).toBeNull();
    expect(json.error.code).toBe("FEATURE_LOCKED");
    expect(fakeDb.ticket.count).not.toHaveBeenCalled();

    expect(hasFeatureMock).toHaveBeenCalledWith(
      SESSION.ctx.tenantId,
      "analytics",
      SESSION.ctx.plan
    );
  });

  it("hasFeature=true → ผ่านไป query db ได้ปกติ (200)", async () => {
    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).not.toBeNull();
    expect(fakeDb.ticket.count).toHaveBeenCalled();
  });
});

// =============================================================================
// Auth
// =============================================================================

describe("GET /api/reports — auth", () => {
  it("requireAgent throw 401 → propagate ผ่าน toAuthErrorResponse", async () => {
    requireAgentMock.mockRejectedValue(new AuthError("Unauthorized", 401));

    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.data).toBeNull();
    expect(json.error.code).toBeDefined();
    expect(fakeDb.ticket.count).not.toHaveBeenCalled();
    expect(hasFeatureMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Date range validation
// =============================================================================

describe("GET /api/reports — date range validation", () => {
  it("ไม่ส่ง from/to → 200, data.range มีค่า (~30 วัน)", async () => {
    const res = await GET(makeReq());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.range.from).toBeDefined();
    expect(json.data.range.to).toBeDefined();

    const fromMs = new Date(json.data.range.from).getTime();
    const toMs = new Date(json.data.range.to).getTime();
    const rangeDays = (toMs - fromMs) / (24 * 60 * 60 * 1000);

    expect(rangeDays).toBeGreaterThan(29.9);
    expect(rangeDays).toBeLessThanOrEqual(31);
  });

  it("from > to → 400 VALIDATION_ERROR", async () => {
    const res = await GET(makeReq("?from=2026-06-10&to=2026-06-01"));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(json.data).toBeNull();
    expect(fakeDb.ticket.count).not.toHaveBeenCalled();
  });

  it("ช่วง > 366 วัน → 400 VALIDATION_ERROR", async () => {
    const res = await GET(makeReq("?from=2025-01-01&to=2026-06-01"));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(fakeDb.ticket.count).not.toHaveBeenCalled();
  });

  it("from/to valid (7 วัน) → 200, range echo ถูกต้อง", async () => {
    const res = await GET(makeReq("?from=2026-06-01&to=2026-06-07"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.range.from).toBe("2026-06-01T00:00:00.000Z");
    expect(json.data.range.to).toBe("2026-06-07T23:59:59.999Z");
  });
});

// =============================================================================
// Metrics correctness
// =============================================================================

describe("GET /api/reports — metrics correctness", () => {
  it("empty data → kpis ทั้งหมดเป็น 0/null, trend ครบทุกวัน, byPriority ครบ 4 enum, byChannel=[]", async () => {
    const res = await GET(makeReq("?from=2026-06-01&to=2026-06-03"));
    const json = await res.json();

    expect(res.status).toBe(200);
    const { data } = json;

    expect(data.kpis).toEqual({
      ticketsCreated: 0,
      ticketsResolved: 0,
      avgFirstResponseMinutes: null,
      avgResolutionMinutes: null,
      slaBreachRate: 0,
      csatAverage: null,
    });

    // trend ครบ 3 วัน (06-01, 06-02, 06-03) ทั้งหมด created/resolved = 0
    expect(data.trend).toEqual([
      { date: "2026-06-01", created: 0, resolved: 0 },
      { date: "2026-06-02", created: 0, resolved: 0 },
      { date: "2026-06-03", created: 0, resolved: 0 },
    ]);

    // byPriority ครบ 4 enum count 0
    expect(data.byPriority).toEqual(
      expect.arrayContaining([
        { key: "LOW", count: 0 },
        { key: "NORMAL", count: 0 },
        { key: "HIGH", count: 0 },
        { key: "URGENT", count: 0 },
      ])
    );
    expect(data.byPriority).toHaveLength(4);

    expect(data.byChannel).toEqual([]);
  });

  it("มี data → slaBreachRate, csatAverage, avg minutes, byPriority/byChannel ถูกต้อง", async () => {
    // 4a: ticketsCreatedCount, 4b: ticketsResolvedCount, 4c: breachedCreatedCount
    fakeDb.ticket.count
      .mockResolvedValueOnce(10) // ticketsCreated
      .mockResolvedValueOnce(8) // ticketsResolved
      .mockResolvedValueOnce(3); // breachedCreated

    // 4d: resolvedTicketsForAvg — 2 tickets: 60 min, 120 min → avg 90
    // 4e: firstRespondedTicketsForAvg — 1 ticket: 30 min → avg 30
    fakeDb.ticket.findMany
      .mockResolvedValueOnce([
        {
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
          resolvedAt: new Date("2026-06-01T01:00:00.000Z"), // +60 min
        },
        {
          createdAt: new Date("2026-06-02T00:00:00.000Z"),
          resolvedAt: new Date("2026-06-02T02:00:00.000Z"), // +120 min
        },
      ])
      .mockResolvedValueOnce([
        {
          createdAt: new Date("2026-06-01T00:00:00.000Z"),
          firstRespondedAt: new Date("2026-06-01T00:30:00.000Z"), // +30 min
        },
      ])
      // 4i: createdDatesRaw
      .mockResolvedValueOnce([
        { createdAt: new Date("2026-06-01T00:00:00.000Z") },
        { createdAt: new Date("2026-06-01T05:00:00.000Z") },
        { createdAt: new Date("2026-06-02T00:00:00.000Z") },
      ])
      // 4j: resolvedDatesRaw
      .mockResolvedValueOnce([
        { resolvedAt: new Date("2026-06-01T01:00:00.000Z") },
        { resolvedAt: new Date("2026-06-02T02:00:00.000Z") },
      ]);

    // 4f: byPriority groupBy
    fakeDb.ticket.groupBy
      .mockResolvedValueOnce([
        { priority: "HIGH", _count: { _all: 6 } },
        { priority: "LOW", _count: { _all: 4 } },
      ])
      // 4g: byChannel groupBy
      .mockResolvedValueOnce([
        { channel: "EMAIL", _count: { _all: 7 } },
        { channel: "WEB", _count: { _all: 3 } },
      ]);

    // 4h: csatAggregate — avg 4.567 → round → 4.57
    fakeDb.csatResponse.aggregate.mockResolvedValue({
      _avg: { rating: 4.567 },
      _count: { id: 5 },
    });

    const res = await GET(makeReq("?from=2026-06-01&to=2026-06-02"));
    const json = await res.json();

    expect(res.status).toBe(200);
    const { data } = json;

    expect(data.kpis.ticketsCreated).toBe(10);
    expect(data.kpis.ticketsResolved).toBe(8);
    expect(data.kpis.slaBreachRate).toBeCloseTo(3 / 10, 5);
    expect(data.kpis.avgResolutionMinutes).toBe(90);
    expect(data.kpis.avgFirstResponseMinutes).toBe(30);
    expect(data.kpis.csatAverage).toBe(4.57);

    // byPriority: ครบ 4 enum, map ค่าตรง
    expect(data.byPriority).toEqual(
      expect.arrayContaining([
        { key: "LOW", count: 4 },
        { key: "NORMAL", count: 0 },
        { key: "HIGH", count: 6 },
        { key: "URGENT", count: 0 },
      ])
    );
    expect(data.byPriority).toHaveLength(4);

    // byChannel: เฉพาะที่มีจริง
    expect(data.byChannel).toEqual(
      expect.arrayContaining([
        { key: "EMAIL", count: 7 },
        { key: "WEB", count: 3 },
      ])
    );
    expect(data.byChannel).toHaveLength(2);

    // trend: 2 วัน, created bucket ตามวันที่ของ createdAt (06-01 มี 2, 06-02 มี 1)
    // resolved bucket ตามวันที่ของ resolvedAt (06-01 มี 1, 06-02 มี 1)
    expect(data.trend).toEqual([
      { date: "2026-06-01", created: 2, resolved: 1 },
      { date: "2026-06-02", created: 1, resolved: 1 },
    ]);
  });
});

// =============================================================================
// Tenant scope
// =============================================================================

describe("GET /api/reports — tenant scope", () => {
  it("เรียก requireAgent() ไม่มี roles arg (ทุก role เห็น report ได้)", async () => {
    await GET(makeReq());

    expect(requireAgentMock).toHaveBeenCalledWith();
  });

  it("queries ทั้งหมดผ่าน tenantPrisma(ctx.tenantId) — ใช้ fakeDb ที่ scope แล้ว", async () => {
    const res = await GET(makeReq());

    expect(res.status).toBe(200);
    // fakeDb ที่ mock ไว้คือ instance ที่ tenantPrisma(ctx.tenantId) คืนมา
    expect(fakeDb.ticket.count).toHaveBeenCalled();
    expect(fakeDb.ticket.findMany).toHaveBeenCalled();
    expect(fakeDb.ticket.groupBy).toHaveBeenCalled();
    expect(fakeDb.csatResponse.aggregate).toHaveBeenCalled();
  });
});
