/**
 * src/app/api/__tests__/v1-tickets.test.ts
 * Integration tests สำหรับ GET/POST /api/v1/tickets (public REST API)
 *
 * P1 invariants:
 *   GET: validation (limit>100/page<1 → 400), pagination shape, rate-limit per-key → 429
 *   POST: validation (subject<3, ไม่มี requester → 400), visibility ของ firstMessage
 *         ถูก force เป็น PUBLIC เสมอ (ไม่รับจาก client), audit log actor=system
 *         + metadata {apiKeyId, requesterContactId, via:"api"}
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultCtx, DEFAULT_TENANT_ID, makeNextRequest } from "@/app/api/__tests__/_helpers";
import { hashApiKey } from "@/lib/api-key";

const {
  fakeDb,
  getTenantContextMock,
  hasFeatureMock,
  redisCtl,
  createTicketWithNumberMock,
  verifyContactBelongsToTenantMock,
  auditLogMock,
  prismaTransactionMock,
} = vi.hoisted(() => {
  const fakeDb = {
    ticket: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
    apiKey: { findFirst: vi.fn(), update: vi.fn() },
  };

  let incrCount = 1;
  const multiMock = vi.fn(() => ({
    incr: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn(async () => [
      [null, incrCount],
      [null, 1],
    ]),
  }));
  const redis = { multi: multiMock, ttl: vi.fn().mockResolvedValue(60) };

  return {
    fakeDb,
    getTenantContextMock: vi.fn(),
    hasFeatureMock: vi.fn(),
    redisCtl: {
      redis,
      setIncrCount: (n: number) => {
        incrCount = n;
      },
    },
    createTicketWithNumberMock: vi.fn(),
    verifyContactBelongsToTenantMock: vi.fn(),
    auditLogMock: vi.fn(),
    prismaTransactionMock: vi.fn(),
  };
});

vi.mock("@/lib/tenant", () => ({
  getTenantContext: (...args: unknown[]) => getTenantContextMock(...args),
  tenantPrisma: () => fakeDb,
  // Phase 27 RLS: route เรียก setTenantGuc ใน tx — mock เป็น no-op (พฤติกรรมเดียวกับ RLS ปิด)
  setTenantGuc: vi.fn(async () => {}),
}));

vi.mock("@/lib/features", () => ({
  hasFeature: (...args: unknown[]) => hasFeatureMock(...args),
  FEATURE_KEYS: { API_ACCESS: "api_access" },
}));

vi.mock("@/lib/redis", () => ({
  redis: redisCtl.redis,
}));

vi.mock("@/lib/tickets", () => ({
  createTicketWithNumber: (...args: unknown[]) => createTicketWithNumberMock(...args),
  verifyContactBelongsToTenant: (...args: unknown[]) =>
    verifyContactBelongsToTenantMock(...args),
}));

vi.mock("@/lib/audit", () => ({
  audit: { log: (...args: unknown[]) => auditLogMock(...args) },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...args: unknown[]) => prismaTransactionMock(...args),
  },
}));

import { GET, POST } from "@/app/api/v1/tickets/route";
import { NextRequest } from "next/server";

const PLAINTEXT_KEY = "hw_live_validkeyvalue1234567890";
const KEY_HASH = hashApiKey(PLAINTEXT_KEY);

const AUTH_HEADERS = { authorization: `Bearer ${PLAINTEXT_KEY}` };

beforeEach(() => {
  vi.clearAllMocks();
  getTenantContextMock.mockResolvedValue(defaultCtx());
  hasFeatureMock.mockResolvedValue(true);
  redisCtl.setIncrCount(1);
  fakeDb.apiKey.findFirst.mockResolvedValue({
    id: "key-1",
    tenantId: DEFAULT_TENANT_ID,
    keyHash: KEY_HASH,
    revokedAt: null,
  });
  fakeDb.apiKey.update.mockResolvedValue({});
});

describe("GET /api/v1/tickets", () => {
  it("limit > 100 → 400 VALIDATION_ERROR", async () => {
    const req = makeNextRequest(
      "https://acme.helpwise.com/api/v1/tickets?limit=101",
      { headers: AUTH_HEADERS }
    );
    const res = await GET(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  it("page < 1 → 400 VALIDATION_ERROR", async () => {
    const req = makeNextRequest(
      "https://acme.helpwise.com/api/v1/tickets?page=0",
      { headers: AUTH_HEADERS }
    );
    const res = await GET(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  it("success → pagination shape ถูกต้อง", async () => {
    fakeDb.ticket.findMany.mockResolvedValue([
      {
        id: "t1",
        ticketNumber: 1,
        subject: "Issue",
        status: "OPEN",
        priority: "NORMAL",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        requesterContact: { email: "a@b.com", name: "Alice" },
      },
    ]);
    fakeDb.ticket.count.mockResolvedValue(1);

    const req = makeNextRequest("https://acme.helpwise.com/api/v1/tickets", {
      headers: AUTH_HEADERS,
    });
    const res = await GET(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 1,
      totalPages: 1,
    });
    expect(json.data.tickets[0].id).toBe("t1");
  });

  it("rate limit เกิน (per apiKey) → 429", async () => {
    redisCtl.setIncrCount(121);
    const req = makeNextRequest("https://acme.helpwise.com/api/v1/tickets", {
      headers: AUTH_HEADERS,
    });
    const res = await GET(req);
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(fakeDb.ticket.findMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/tickets", () => {
  function ticketResult(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "ticket-1",
      ticketNumber: 100,
      subject: "New issue",
      status: "NEW",
      priority: "NORMAL",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      ...overrides,
    };
  }

  it("subject < 3 ตัวอักษร → 400 VALIDATION_ERROR", async () => {
    const req = makeNextRequest("https://acme.helpwise.com/api/v1/tickets", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: { subject: "ab", requesterEmail: "a@b.com" },
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(createTicketWithNumberMock).not.toHaveBeenCalled();
  });

  it("ไม่มี requesterContactId และ requesterEmail → 400 VALIDATION_ERROR", async () => {
    const req = makeNextRequest("https://acme.helpwise.com/api/v1/tickets", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: { subject: "Valid subject" },
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  it("body ไม่ใช่ JSON → 400 INVALID_JSON", async () => {
    const rawReq = new NextRequest(
      new Request("https://acme.helpwise.com/api/v1/tickets", {
        method: "POST",
        headers: { ...AUTH_HEADERS, "content-type": "application/json" },
        body: "not-json{{{",
      })
    );
    const res = await POST(rawReq);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("INVALID_JSON");
  });

  it("success ด้วย requesterContactId + message → firstMessage.visibility ถูก force เป็น PUBLIC เสมอ", async () => {
    verifyContactBelongsToTenantMock.mockResolvedValue({ id: "contact-1" });
    createTicketWithNumberMock.mockResolvedValue(ticketResult());
    fakeDb.ticket.findUnique.mockResolvedValue(
      ticketResult({ requesterContact: { email: "a@b.com", name: "Alice" } })
    );

    const req = makeNextRequest("https://acme.helpwise.com/api/v1/tickets", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: {
        subject: "Valid subject here",
        requesterContactId: "contact-1",
        // ลองส่ง visibility: INTERNAL จาก client — ต้องไม่ถูกใช้
        message: { body: "Hello, I need help", visibility: "INTERNAL" },
      },
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(201);

    // assert createTicketWithNumber ได้ firstMessage.visibility = PUBLIC เสมอ
    const callArg = createTicketWithNumberMock.mock.calls[0][1];
    expect(callArg.firstMessage.visibility).toBe("PUBLIC");
    expect(callArg.channel).toBe("api");

    // audit log: actor=system + metadata
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: DEFAULT_TENANT_ID,
        actor: { type: "system" },
        action: "ticket.created",
        metadata: {
          apiKeyId: "key-1",
          via: "api",
          requesterContactId: "contact-1",
        },
      })
    );

    expect(json.data.id).toBe("ticket-1");
  });

  it("requesterContactId ไม่อยู่ใน tenant นี้ → 400 CONTACT_NOT_FOUND", async () => {
    verifyContactBelongsToTenantMock.mockResolvedValue(null);

    const req = makeNextRequest("https://acme.helpwise.com/api/v1/tickets", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: {
        subject: "Valid subject here",
        requesterContactId: "contact-other-tenant",
      },
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("CONTACT_NOT_FOUND");
    expect(createTicketWithNumberMock).not.toHaveBeenCalled();
  });

  it("requesterEmail (ไม่มี contactId) → upsert contact ผ่าน $transaction แล้วสร้าง ticket", async () => {
    prismaTransactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        // Phase 27 RLS: route ตั้ง tenant GUC ผ่าน tx.$executeRaw ก่อน upsert
        $executeRaw: vi.fn().mockResolvedValue(1),
        contact: {
          findFirst: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockResolvedValue({ id: "contact-new", name: null, email: "new@b.com" }),
        },
      };
      return cb(tx);
    });
    createTicketWithNumberMock.mockResolvedValue(ticketResult());
    fakeDb.ticket.findUnique.mockResolvedValue(null);

    const req = makeNextRequest("https://acme.helpwise.com/api/v1/tickets", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: {
        subject: "Valid subject here",
        requesterEmail: "new@b.com",
      },
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(201);
    const callArg = createTicketWithNumberMock.mock.calls[0][1];
    expect(callArg.requesterContactId).toBe("contact-new");
    expect(json.data.id).toBe("ticket-1");
  });

  it("rate limit เกิน → 429, ไม่เรียก createTicketWithNumber", async () => {
    redisCtl.setIncrCount(121);
    const req = makeNextRequest("https://acme.helpwise.com/api/v1/tickets", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: { subject: "Valid subject here", requesterEmail: "a@b.com" },
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(createTicketWithNumberMock).not.toHaveBeenCalled();
  });
});
