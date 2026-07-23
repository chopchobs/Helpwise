/**
 * src/app/api/__tests__/webhook-inbound-triggers.test.ts
 * Tests สำหรับ outbound-webhook trigger ที่ producer ฝั่ง inbound email + public API (Phase 36)
 *
 * Producers (contract § 3):
 *   - POST /api/webhooks/email → TICKET_CREATED (ticket ใหม่) / TICKET_MESSAGE_CREATED (append)
 *   - POST /api/v1/tickets     → TICKET_CREATED (API-key audience)
 *
 * ทำไมสองเส้นนี้เสี่ยงกว่าเส้นอื่น:
 *   - inbound email ไม่มี tenant context จาก middleware (tenantId derive จาก recipient)
 *     และเป็นเส้นเดียวที่ dispatch โดยไม่ส่ง tenantPlan → dispatcher ต้อง query plan เอง
 *   - inbound เป็นเส้นเดียวที่ idempotency claim (P2002) ต้องตัด event ซ้ำทิ้ง
 *
 * P0 invariants:
 *   - duplicate delivery → ไม่ dispatch เลย (at-least-once ต้องไม่กลายเป็น event ซ้ำ)
 *   - tenant/recipient routing ไม่ได้ → ไม่ dispatch (fail-closed)
 *   - envelope ไม่มี email ของผู้ส่ง (PII guard)
 *   - request ที่ล้ม (validation / rate limit) → ไม่ dispatch
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  defaultCtx,
  DEFAULT_TENANT_ID,
  makeNextRequest,
} from "@/app/api/__tests__/_helpers";
import { hashApiKey } from "@/lib/api-key";

const {
  fakeDb,
  redisMock,
  prismaMock,
  createTicketWithNumberMock,
  createTicketMessageMock,
  verifyContactBelongsToTenantMock,
  auditLogMock,
  dispatchMock,
  getTenantContextMock,
  hasFeatureMock,
  redisRateCtl,
} = vi.hoisted(() => {
  const fakeDb = {
    contact: { upsert: vi.fn() },
    ticket: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    ticketMessage: { findFirst: vi.fn() },
    apiKey: { findFirst: vi.fn(), update: vi.fn() },
  };

  // rate-limit ของ /api/v1/* ใช้ redis.multi().incr(); inbound route ใช้ get/set
  let incrCount = 1;
  const redisMock = {
    get: vi.fn(),
    set: vi.fn(),
    ttl: vi.fn().mockResolvedValue(60),
    multi: vi.fn(() => ({
      incr: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => [
        [null, incrCount],
        [null, 1],
      ]),
    })),
  };

  return {
    fakeDb,
    redisMock,
    prismaMock: {
      tenant: { findFirst: vi.fn() },
      processedInboundEmail: { create: vi.fn(), update: vi.fn() },
      $transaction: vi.fn(),
    },
    createTicketWithNumberMock: vi.fn(),
    createTicketMessageMock: vi.fn(),
    verifyContactBelongsToTenantMock: vi.fn(),
    auditLogMock: vi.fn(),
    dispatchMock: vi.fn(),
    getTenantContextMock: vi.fn(),
    hasFeatureMock: vi.fn(),
    redisRateCtl: {
      setIncrCount: (n: number) => {
        incrCount = n;
      },
    },
  };
});

vi.mock("@/lib/tenant", () => ({
  getTenantContext: (...args: unknown[]) => getTenantContextMock(...args),
  tenantPrisma: () => fakeDb,
  setTenantGuc: vi.fn(async () => {}),
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("@/lib/redis", () => ({
  redis: redisMock,
  tenantSlugCacheKey: (slug: string) => `tenant:slug:${slug}`,
  TENANT_CACHE_TTL_SECONDS: 300,
}));

vi.mock("@/lib/audit", () => ({
  audit: { log: (...args: unknown[]) => auditLogMock(...args) },
}));

vi.mock("@/lib/tickets", () => ({
  createTicketWithNumber: (...args: unknown[]) =>
    createTicketWithNumberMock(...args),
  createTicketMessage: (...args: unknown[]) => createTicketMessageMock(...args),
  verifyContactBelongsToTenant: (...args: unknown[]) =>
    verifyContactBelongsToTenantMock(...args),
}));

vi.mock("@/lib/features", () => ({
  hasFeature: (...args: unknown[]) => hasFeatureMock(...args),
  FEATURE_KEYS: { API_ACCESS: "api_access" },
}));

// producer ที่กำลังเทส — mock เพื่อดูว่า call site เรียกด้วย input อะไร
vi.mock("@/lib/webhook-dispatch", () => ({
  dispatchWebhookEvent: (...args: unknown[]) => dispatchMock(...args),
}));

import { Prisma } from "@prisma/client";
import { POST as inboundEmail } from "@/app/api/webhooks/email/route";
import { POST as createV1Ticket } from "@/app/api/v1/tickets/route";

const CREATED_AT = new Date("2026-07-22T10:00:00.000Z");

// PII fixture — email ของผู้ส่งต้องไม่โผล่ใน envelope ที่ส่งออกนอกระบบ
const SENDER_EMAIL = "customer@example.com";
const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "gethelpwise.xyz";

/** payload แบบ Postmark inbound (parse ด้วย lib จริง ไม่ mock parser) */
function postmarkPayload(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    MessageID: "msg-inbound-1",
    FromFull: { Email: SENDER_EMAIL, Name: "Customer One" },
    OriginalRecipient: `support@acme.${ROOT_DOMAIN}`,
    Subject: "ล็อกอินไม่ได้",
    TextBody: "เข้าระบบไม่ได้ครับ",
    Headers: [],
    ...overrides,
  };
}

function inboundRequest(payload: Record<string, unknown>) {
  return makeNextRequest("https://acme.gethelpwise.xyz/api/webhooks/email", {
    method: "POST",
    body: payload,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dispatchMock.mockResolvedValue(undefined);
  auditLogMock.mockResolvedValue(undefined);

  // tenant lookup: ข้าม Redis cache (get → null) ไป DB
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockResolvedValue("OK");
  prismaMock.tenant.findFirst.mockResolvedValue({
    id: DEFAULT_TENANT_ID,
    plan: { name: "pro" },
  });

  // idempotency claim สำเร็จเป็นค่า default
  prismaMock.processedInboundEmail.create.mockResolvedValue({ id: "claim-1" });
  prismaMock.processedInboundEmail.update.mockResolvedValue({});

  fakeDb.contact.upsert.mockResolvedValue({
    id: "contact-1",
    email: SENDER_EMAIL,
    name: "Customer One",
  });
  fakeDb.ticketMessage.findFirst.mockResolvedValue(null);
  fakeDb.ticket.findFirst.mockResolvedValue(null);
});

// =============================================================================
// POST /api/webhooks/email — ticket ใหม่ (TICKET_CREATED)
// =============================================================================

describe("POST /api/webhooks/email — webhook trigger (ticket ใหม่)", () => {
  beforeEach(() => {
    createTicketWithNumberMock.mockResolvedValue({
      id: "ticket-9",
      ticketNumber: 1050,
      subject: "ล็อกอินไม่ได้",
      status: "NEW",
      priority: "NORMAL",
      assigneeId: null,
      requesterContactId: "contact-1",
      channel: "email",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
  });

  it("inbound สร้าง ticket ใหม่ → dispatch TICKET_CREATED (channel=email, ไม่ส่ง tenantPlan)", async () => {
    const res = await inboundEmail(inboundRequest(postmarkPayload()));

    expect(res.status).toBe(200);
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    const [db, tenantId, input, plan] = dispatchMock.mock.calls[0];
    // tenant-scoped client + tenantId ที่ derive จาก recipient (ไม่ใช่จาก payload)
    expect(db).toBe(fakeDb);
    expect(tenantId).toBe(DEFAULT_TENANT_ID);
    // เส้นนี้ไม่มี tenant context จาก middleware → ไม่ส่ง plan, dispatcher query เอง
    expect(plan).toBeUndefined();
    expect(input).toEqual({
      eventType: "TICKET_CREATED",
      occurredAt: CREATED_AT,
      ticket: {
        id: "ticket-9",
        ticketNumber: 1050,
        subject: "ล็อกอินไม่ได้",
        status: "NEW",
        priority: "NORMAL",
        assigneeMemberId: null,
        requesterContactId: "contact-1",
        channel: "email",
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    });
  });

  it("PII guard: envelope ของ inbound ไม่มีอีเมลผู้ส่ง", async () => {
    await inboundEmail(inboundRequest(postmarkPayload()));

    const input = dispatchMock.mock.calls[0][2];
    expect(JSON.stringify(input)).not.toContain(SENDER_EMAIL);
  });

  it("duplicate delivery (claim ชน P2002) → ไม่ dispatch เลย", async () => {
    prismaMock.processedInboundEmail.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      })
    );

    const res = await inboundEmail(inboundRequest(postmarkPayload()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.action).toBe("duplicate");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("tenant ไม่พบ → ไม่ dispatch (fail-closed)", async () => {
    prismaMock.tenant.findFirst.mockResolvedValue(null);

    const res = await inboundEmail(inboundRequest(postmarkPayload()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.error).toBe("tenant_not_found");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("recipient routing ไม่ได้ (ไม่ตรง root domain) → ไม่ dispatch", async () => {
    const res = await inboundEmail(
      inboundRequest(
        postmarkPayload({ OriginalRecipient: "support@not-our-domain.com" })
      )
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.error).toBe("unroutable_recipient");
    expect(dispatchMock).not.toHaveBeenCalled();
    // fail-closed ก่อนแตะ DB — ไม่มีการ claim idempotency slot
    expect(prismaMock.processedInboundEmail.create).not.toHaveBeenCalled();
  });
});

// =============================================================================
// POST /api/webhooks/email — append เข้า ticket เดิม (TICKET_MESSAGE_CREATED)
// =============================================================================

describe("POST /api/webhooks/email — webhook trigger (append ticket เดิม)", () => {
  beforeEach(() => {
    // threading: In-Reply-To ตรงกับ message เดิมของ ticket-8
    fakeDb.ticketMessage.findFirst.mockResolvedValue({ ticketId: "ticket-8" });
    fakeDb.ticket.findFirst.mockResolvedValue({
      id: "ticket-8",
      status: "OPEN",
      ticketNumber: 1042,
      subject: "ล็อกอินไม่ได้",
    });
    createTicketMessageMock.mockResolvedValue({
      id: "msg-inbound-1",
      body: "ยังเข้าไม่ได้เลยครับ",
      visibility: "PUBLIC",
      createdAt: CREATED_AT,
    });
  });

  function replyPayload() {
    return postmarkPayload({
      TextBody: "ยังเข้าไม่ได้เลยครับ",
      Headers: [{ Name: "In-Reply-To", Value: "<parent@mail>" }],
    });
  }

  it("append เข้า ticket เดิม → dispatch TICKET_MESSAGE_CREATED (contact / PUBLIC)", async () => {
    const res = await inboundEmail(inboundRequest(replyPayload()));

    expect(res.status).toBe(200);
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    const [db, tenantId, input, plan] = dispatchMock.mock.calls[0];
    expect(db).toBe(fakeDb);
    expect(tenantId).toBe(DEFAULT_TENANT_ID);
    expect(plan).toBeUndefined();
    expect(input).toEqual({
      eventType: "TICKET_MESSAGE_CREATED",
      occurredAt: CREATED_AT,
      ticket: { id: "ticket-8", ticketNumber: 1042, subject: "ล็อกอินไม่ได้" },
      message: {
        id: "msg-inbound-1",
        visibility: "PUBLIC",
        // author = Contact ของ tenant นี้ (ไม่ใช่ agent)
        authorType: "contact",
        authorId: "contact-1",
        body: "ยังเข้าไม่ได้เลยครับ",
        createdAt: CREATED_AT,
      },
    });
    // PII guard: envelope ห้ามมีอีเมลผู้ส่ง
    expect(JSON.stringify(input)).not.toContain(SENDER_EMAIL);
  });

  it("duplicate ของ reply (claim ชน P2002) → ไม่ dispatch + ไม่สร้าง message ซ้ำ", async () => {
    prismaMock.processedInboundEmail.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      })
    );

    await inboundEmail(inboundRequest(replyPayload()));

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(createTicketMessageMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// POST /api/v1/tickets — public REST API (API-key audience)
// =============================================================================

describe("POST /api/v1/tickets — webhook trigger", () => {
  const PLAINTEXT_KEY = "hw_live_validkeyvalue1234567890";
  const AUTH_HEADERS = { authorization: `Bearer ${PLAINTEXT_KEY}` };

  function apiRequest(body: unknown) {
    return makeNextRequest("https://acme.gethelpwise.xyz/api/v1/tickets", {
      method: "POST",
      headers: AUTH_HEADERS,
      body,
    });
  }

  beforeEach(() => {
    getTenantContextMock.mockResolvedValue(defaultCtx());
    hasFeatureMock.mockResolvedValue(true);
    redisRateCtl.setIncrCount(1);
    fakeDb.apiKey.findFirst.mockResolvedValue({
      id: "key-1",
      tenantId: DEFAULT_TENANT_ID,
      keyHash: hashApiKey(PLAINTEXT_KEY),
      revokedAt: null,
    });
    fakeDb.apiKey.update.mockResolvedValue({});
    verifyContactBelongsToTenantMock.mockResolvedValue({ id: "contact-1" });
    createTicketWithNumberMock.mockResolvedValue({
      id: "ticket-7",
      ticketNumber: 1060,
      subject: "API created ticket",
      status: "NEW",
      priority: "NORMAL",
      assigneeId: null,
      requesterContactId: "contact-1",
      channel: "api",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    fakeDb.ticket.findUnique.mockResolvedValue({
      id: "ticket-7",
      ticketNumber: 1060,
      subject: "API created ticket",
      status: "NEW",
      priority: "NORMAL",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      requesterContact: { email: SENDER_EMAIL, name: "Customer One" },
    });
  });

  it("สร้าง ticket ผ่าน API key สำเร็จ → dispatch TICKET_CREATED (channel=api, tenantId/plan จาก ctx)", async () => {
    const res = await createV1Ticket(
      apiRequest({
        subject: "API created ticket",
        requesterContactId: "contact-1",
      })
    );

    expect(res.status).toBe(201);
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    const [db, tenantId, input, plan] = dispatchMock.mock.calls[0];
    expect(db).toBe(fakeDb);
    // tenantId/plan มาจาก ctx ของ API key ไม่ใช่จาก body
    expect(tenantId).toBe(DEFAULT_TENANT_ID);
    expect(plan).toBe("pro");
    expect(input).toEqual({
      eventType: "TICKET_CREATED",
      occurredAt: CREATED_AT,
      ticket: {
        id: "ticket-7",
        ticketNumber: 1060,
        subject: "API created ticket",
        status: "NEW",
        priority: "NORMAL",
        assigneeMemberId: null,
        requesterContactId: "contact-1",
        // channel ตรงกับที่ route สร้างจริง (createTicketWithNumber ได้ channel="api")
        channel: "api",
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    });
    expect(createTicketWithNumberMock.mock.calls[0][1].channel).toBe("api");
    // PII guard: envelope ห้ามมี email ของ requester
    expect(JSON.stringify(input)).not.toContain(SENDER_EMAIL);
  });

  it("validation fail (subject สั้นเกิน) → ไม่ dispatch", async () => {
    const res = await createV1Ticket(
      apiRequest({ subject: "ab", requesterContactId: "contact-1" })
    );

    expect(res.status).toBe(400);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("rate limit เกิน → ไม่ dispatch", async () => {
    redisRateCtl.setIncrCount(121);

    const res = await createV1Ticket(
      apiRequest({
        subject: "API created ticket",
        requesterContactId: "contact-1",
      })
    );

    expect(res.status).toBe(429);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});
