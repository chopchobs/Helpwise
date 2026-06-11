/**
 * src/app/api/__tests__/v1-tickets-id.test.ts
 * Integration tests สำหรับ GET /api/v1/tickets/:id
 *
 * Security invariants ที่ต้อง prove:
 *   - query messages ต้องมี where: { visibility: "PUBLIC" } เสมอ (internal note ห้ามหลุด)
 *   - ticket ไม่เจอ (tenant scope ไม่ match) → 404
 *   - success → DTO map ถูกต้อง (author agent/contact, ISO date)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultCtx, DEFAULT_TENANT_ID } from "@/app/api/__tests__/_helpers";

const { fakeDb, getTenantContextMock, hasFeatureMock, redisCtl } = vi.hoisted(() => {
  const fakeDb = {
    ticket: { findFirst: vi.fn() },
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
  };
});

vi.mock("@/lib/tenant", () => ({
  getTenantContext: (...args: unknown[]) => getTenantContextMock(...args),
  tenantPrisma: () => fakeDb,
}));

vi.mock("@/lib/features", () => ({
  hasFeature: (...args: unknown[]) => hasFeatureMock(...args),
  FEATURE_KEYS: { API_ACCESS: "api_access" },
}));

vi.mock("@/lib/redis", () => ({
  redis: redisCtl.redis,
}));

import { GET } from "@/app/api/v1/tickets/[id]/route";
import { hashApiKey } from "@/lib/api-key";
import { NextRequest } from "next/server";

const PLAINTEXT_KEY = "hw_live_validkeyvalue1234567890";
const KEY_HASH = hashApiKey(PLAINTEXT_KEY);

function makeRequest(id: string) {
  return new NextRequest(
    new Request(`https://acme.helpwise.com/api/v1/tickets/${id}`, {
      headers: { authorization: `Bearer ${PLAINTEXT_KEY}` },
    })
  );
}

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

describe("GET /api/v1/tickets/:id", () => {
  it("query messages ต้องกรอง visibility = PUBLIC เสมอ (internal note isolation)", async () => {
    fakeDb.ticket.findFirst.mockResolvedValue({
      id: "ticket-1",
      ticketNumber: 1,
      subject: "Test",
      status: "OPEN",
      priority: "NORMAL",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
      requesterContact: { email: "a@b.com", name: "Alice" },
      messages: [],
    });

    const res = await GET(makeRequest("ticket-1"), {
      params: Promise.resolve({ id: "ticket-1" }),
    });

    expect(res.status).toBe(200);

    const callArgs = fakeDb.ticket.findFirst.mock.calls[0][0];
    expect(callArgs.select.messages.where).toEqual({ visibility: "PUBLIC" });
  });

  it("ticket ไม่เจอ (tenant scope ไม่ match หรือไม่มีจริง) → 404", async () => {
    fakeDb.ticket.findFirst.mockResolvedValue(null);

    const res = await GET(makeRequest("nonexistent"), {
      params: Promise.resolve({ id: "nonexistent" }),
    });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(json.data).toBeNull();
  });

  it("success → DTO map author agent/contact + ISO date ถูกต้อง", async () => {
    fakeDb.ticket.findFirst.mockResolvedValue({
      id: "ticket-1",
      ticketNumber: 42,
      subject: "Help me",
      status: "OPEN",
      priority: "HIGH",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
      requesterContact: { email: "customer@b.com", name: "Bob" },
      messages: [
        {
          id: "msg-1",
          body: "From agent",
          createdAt: new Date("2026-01-01T01:00:00Z"),
          authorMember: { user: { name: "Agent Smith" } },
          authorContact: null,
        },
        {
          id: "msg-2",
          body: "From customer",
          createdAt: new Date("2026-01-01T02:00:00Z"),
          authorMember: null,
          authorContact: { name: "Bob" },
        },
      ],
    });

    const res = await GET(makeRequest("ticket-1"), {
      params: Promise.resolve({ id: "ticket-1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.id).toBe("ticket-1");
    expect(json.data.ticketNumber).toBe(42);
    expect(json.data.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(json.data.requester).toEqual({ email: "customer@b.com", name: "Bob" });

    expect(json.data.messages[0]).toEqual({
      id: "msg-1",
      body: "From agent",
      createdAt: "2026-01-01T01:00:00.000Z",
      author: { type: "agent", name: "Agent Smith" },
    });
    expect(json.data.messages[1]).toEqual({
      id: "msg-2",
      body: "From customer",
      createdAt: "2026-01-01T02:00:00.000Z",
      author: { type: "contact", name: "Bob" },
    });
  });

  it("rate limit เกิน → 429 พร้อม Retry-After header", async () => {
    redisCtl.setIncrCount(121); // limit 120

    const res = await GET(makeRequest("ticket-1"), {
      params: Promise.resolve({ id: "ticket-1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(res.headers.get("Retry-After")).toBeDefined();
    expect(fakeDb.ticket.findFirst).not.toHaveBeenCalled();
  });

  it("ไม่มี Authorization header → 401, ticket.findFirst ไม่ถูกเรียก", async () => {
    const req = new NextRequest(
      new Request("https://acme.helpwise.com/api/v1/tickets/ticket-1")
    );

    const res = await GET(req, { params: Promise.resolve({ id: "ticket-1" }) });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe("UNAUTHORIZED");
    expect(fakeDb.ticket.findFirst).not.toHaveBeenCalled();
  });
});
