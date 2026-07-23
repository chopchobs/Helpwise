/**
 * src/app/api/__tests__/webhook-triggers.test.ts
 * Tests สำหรับ outbound-webhook trigger ที่ call site (Phase 36 Slice 2b)
 *
 * Producers (contract § 3):
 *   - POST  /api/tickets              → TICKET_CREATED
 *   - PATCH /api/tickets/:id          → TICKET_STATUS_CHANGED / TICKET_ASSIGNED / TICKET_PRIORITY_CHANGED
 *   - POST  /api/tickets/:id/messages → TICKET_MESSAGE_CREATED (PUBLIC เท่านั้น)
 *
 * P0 invariants:
 *   - INTERNAL note → ไม่เรียก dispatch เลย (internal note ห้ามออกนอกระบบทุกช่องทาง)
 *   - ยิงเฉพาะฟิลด์ที่เปลี่ยนจริง — ส่งค่าเดิมมา = ไม่ยิง
 *   - เปลี่ยนหลายฟิลด์ใน PATCH เดียว = หลาย event แยกกัน
 *   - envelope input ครบตาม § 2 + ไม่มี PII เกิน (ไม่มี email ของ contact)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultCtx, makeNextRequest } from "@/app/api/__tests__/_helpers";

const {
  fakeDb,
  requireAgentMock,
  requireContactMock,
  auditLogMock,
  createNotificationMock,
  createTicketWithNumberMock,
  createTicketMessageMock,
  verifyAssigneeMembershipMock,
  verifyContactMock,
  dispatchMock,
  publishSendEmailMock,
} = vi.hoisted(() => {
  const fakeDb = {
    ticket: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    ticketMessage: { findFirst: vi.fn() },
  };
  return {
    fakeDb,
    requireAgentMock: vi.fn(),
    requireContactMock: vi.fn(),
    auditLogMock: vi.fn(),
    createNotificationMock: vi.fn(),
    createTicketWithNumberMock: vi.fn(),
    createTicketMessageMock: vi.fn(),
    verifyAssigneeMembershipMock: vi.fn(),
    verifyContactMock: vi.fn(),
    dispatchMock: vi.fn(),
    publishSendEmailMock: vi.fn(),
  };
});

vi.mock("@/lib/tenant", () => ({
  getTenantContext: vi.fn(),
  tenantPrisma: () => fakeDb,
  setTenantGuc: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAgent: (...args: unknown[]) => requireAgentMock(...args),
    requireContact: (...args: unknown[]) => requireContactMock(...args),
  };
});

vi.mock("@/lib/audit", () => ({
  audit: { log: (...args: unknown[]) => auditLogMock(...args) },
}));

vi.mock("@/lib/notifications", () => ({
  createNotification: (...args: unknown[]) => createNotificationMock(...args),
}));

vi.mock("@/lib/tickets", () => ({
  createTicketWithNumber: (...args: unknown[]) => createTicketWithNumberMock(...args),
  createTicketMessage: (...args: unknown[]) => createTicketMessageMock(...args),
  verifyAssigneeMembership: (...args: unknown[]) => verifyAssigneeMembershipMock(...args),
  verifyContactBelongsToTenant: (...args: unknown[]) => verifyContactMock(...args),
}));

vi.mock("@/lib/queue", () => ({
  publishSendEmailJob: (...args: unknown[]) => publishSendEmailMock(...args),
}));

// producer ที่กำลังเทส — mock เพื่อดูว่า call site เรียกด้วย input อะไร
vi.mock("@/lib/webhook-dispatch", () => ({
  dispatchWebhookEvent: (...args: unknown[]) => dispatchMock(...args),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: vi.fn(), tenant: { findUnique: vi.fn() }, slaPolicy: { findUnique: vi.fn() } },
}));

// ticket ในเทสไม่มี SLA deadline → gate นี้ไม่ถูกใช้ แต่ต้อง mock กัน route แตะ DB จริง
vi.mock("@/lib/features", () => ({
  hasFeature: vi.fn().mockResolvedValue(false),
  FEATURE_KEYS: { SLA_POLICIES: "sla_policies" },
}));

import { POST as createTicket } from "@/app/api/tickets/route";
import { PATCH as patchTicket } from "@/app/api/tickets/[id]/route";
import { POST as createMessage } from "@/app/api/tickets/[id]/messages/route";
import { POST as createPortalTicket } from "@/app/api/portal/tickets/route";
import { POST as createPortalMessage } from "@/app/api/portal/tickets/[id]/messages/route";

const SESSION = {
  user: { id: "user-1", name: "Agent One" },
  member: { id: "member-1", role: "AGENT", userId: "user-1" },
  ctx: defaultCtx(),
};

// portal audience — contact ที่ verified ของ tenant นี้ (แยกขาดจาก agent session)
const CONTACT_EMAIL = "portal-user@example.com";
const CONTACT_SESSION = {
  contact: { id: "contact-1", name: "Portal User", email: CONTACT_EMAIL, avatarUrl: null },
  ctx: defaultCtx(),
};

const CREATED_AT = new Date("2026-07-22T10:00:00.000Z");
const UPDATED_AT = new Date("2026-07-22T11:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  requireAgentMock.mockResolvedValue(SESSION);
  requireContactMock.mockResolvedValue(CONTACT_SESSION);
  auditLogMock.mockResolvedValue(undefined);
  createNotificationMock.mockResolvedValue(undefined);
  dispatchMock.mockResolvedValue(undefined);
});

/** ดึง input ของ dispatch call ที่ n (0-based) */
function dispatchInput(n: number) {
  return dispatchMock.mock.calls[n][2] as {
    eventType: string;
    changes?: Record<string, { from: unknown; to: unknown }>;
  };
}

// =============================================================================
// POST /api/tickets — TICKET_CREATED
// =============================================================================

describe("POST /api/tickets — webhook trigger", () => {
  beforeEach(() => {
    verifyContactMock.mockResolvedValue({ id: "contact-1" });
    createTicketWithNumberMock.mockResolvedValue({
      id: "ticket-1",
      ticketNumber: 1042,
      subject: "Need help",
      status: "NEW",
      priority: "NORMAL",
      assigneeId: null,
      requesterContactId: "contact-1",
      channel: "agent",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    fakeDb.ticket.findUnique.mockResolvedValue({ id: "ticket-1" });
  });

  it("สร้าง ticket สำเร็จ → dispatch TICKET_CREATED พร้อม envelope input ครบ § 2", async () => {
    const res = await createTicket(
      makeNextRequest("https://acme.helpwise.com/api/tickets", {
        method: "POST",
        body: { subject: "Need help", requesterContactId: "contact-1" },
      })
    );

    expect(res.status).toBe(201);
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    const [db, tenantId, input, plan] = dispatchMock.mock.calls[0];
    // tenant-scoped client + tenantId จาก ctx (ไม่ใช่จาก client) + plan จาก ctx
    expect(db).toBe(fakeDb);
    expect(tenantId).toBe("tenant-1");
    expect(plan).toBe("pro");
    expect(input).toEqual({
      eventType: "TICKET_CREATED",
      occurredAt: CREATED_AT,
      ticket: {
        id: "ticket-1",
        ticketNumber: 1042,
        subject: "Need help",
        status: "NEW",
        priority: "NORMAL",
        assigneeMemberId: null,
        requesterContactId: "contact-1",
        channel: "agent",
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    });
  });
});

// =============================================================================
// PATCH /api/tickets/:id — status / assignee / priority
// =============================================================================

describe("PATCH /api/tickets/:id — webhook trigger", () => {
  function makeReq(id: string, body: unknown) {
    return {
      req: makeNextRequest(`https://acme.helpwise.com/api/tickets/${id}`, {
        method: "PATCH",
        body,
      }),
      params: Promise.resolve({ id }),
    };
  }

  beforeEach(() => {
    verifyAssigneeMembershipMock.mockResolvedValue({ id: "member-2" });
    // ticket เดิม: OPEN / NORMAL / ยังไม่ assign และไม่มี SLA deadline
    fakeDb.ticket.findFirst.mockResolvedValue({
      id: "ticket-1",
      status: "OPEN",
      priority: "NORMAL",
      assigneeId: null,
      firstRespondedAt: null,
      resolvedAt: null,
      firstResponseDueAt: null,
      resolutionDueAt: null,
      slaPausedAt: null,
      slaPausedDurationMin: 0,
      slaPolicyId: null,
      createdAt: CREATED_AT,
    });
    fakeDb.ticket.update.mockResolvedValue({
      id: "ticket-1",
      ticketNumber: 1042,
      subject: "Need help",
      status: "PENDING",
      priority: "HIGH",
      assigneeId: "member-2",
      requesterContactId: "contact-1",
      channel: "agent",
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      firstResponseDueAt: null,
      resolutionDueAt: null,
      firstRespondedAt: null,
      resolvedAt: null,
      firstResponseBreached: false,
      resolutionBreached: false,
      slaPausedAt: null,
      csat: null,
    });
  });

  it("เปลี่ยน status อย่างเดียว → ยิง event เดียว (ไม่มี assigned/priority)", async () => {
    const { req, params } = makeReq("ticket-1", { status: "PENDING" });
    const res = await patchTicket(req, { params });

    expect(res.status).toBe(200);
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    const input = dispatchInput(0);
    expect(input.eventType).toBe("TICKET_STATUS_CHANGED");
    expect(input.changes).toEqual({ status: { from: "OPEN", to: "PENDING" } });
    // snapshot ticket = ค่าหลัง update (contract § 2)
    expect(dispatchMock.mock.calls[0][2]).toMatchObject({
      ticket: { id: "ticket-1", ticketNumber: 1042, assigneeMemberId: "member-2" },
    });
  });

  it("เปลี่ยน status + priority พร้อมกัน → ยิง 2 event แยกกัน", async () => {
    const { req, params } = makeReq("ticket-1", { status: "PENDING", priority: "HIGH" });
    const res = await patchTicket(req, { params });

    expect(res.status).toBe(200);
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(dispatchInput(0).eventType).toBe("TICKET_STATUS_CHANGED");
    expect(dispatchInput(1).eventType).toBe("TICKET_PRIORITY_CHANGED");
    expect(dispatchInput(1).changes).toEqual({
      priority: { from: "NORMAL", to: "HIGH" },
    });
  });

  it("assign ให้ member → ยิง TICKET_ASSIGNED พร้อม from/to", async () => {
    const { req, params } = makeReq("ticket-1", { assigneeId: "member-2" });
    const res = await patchTicket(req, { params });

    expect(res.status).toBe(200);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchInput(0).eventType).toBe("TICKET_ASSIGNED");
    expect(dispatchInput(0).changes).toEqual({
      assigneeMemberId: { from: null, to: "member-2" },
    });
  });

  it("ส่งค่าเดิม (ไม่เปลี่ยนจริง) → ไม่ยิง event", async () => {
    const { req, params } = makeReq("ticket-1", {
      status: "OPEN",
      priority: "NORMAL",
      assigneeId: null,
    });
    const res = await patchTicket(req, { params });

    expect(res.status).toBe(200);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// POST /api/tickets/:id/messages — TICKET_MESSAGE_CREATED (PUBLIC เท่านั้น)
// =============================================================================

describe("POST /api/tickets/:id/messages — webhook trigger", () => {
  function makeReq(id: string, body: unknown) {
    return {
      req: makeNextRequest(`https://acme.helpwise.com/api/tickets/${id}/messages`, {
        method: "POST",
        body,
      }),
      params: Promise.resolve({ id }),
    };
  }

  beforeEach(() => {
    fakeDb.ticket.findFirst.mockResolvedValue({
      id: "ticket-1",
      status: "OPEN",
      firstRespondedAt: CREATED_AT,
      subject: "Need help",
      ticketNumber: 1042,
      emailMessageId: null,
      mergedIntoId: null,
      requesterContact: { id: "contact-1", email: "user@example.com", name: "User" },
    });
    fakeDb.ticketMessage.findFirst.mockResolvedValue(null);
    fakeDb.ticket.update.mockResolvedValue({ id: "ticket-1" });
    publishSendEmailMock.mockResolvedValue(undefined);
  });

  it("visibility=INTERNAL → ไม่เรียก dispatch เลย (internal note ห้ามออกนอกระบบ)", async () => {
    createTicketMessageMock.mockResolvedValue({
      id: "msg-1",
      body: "internal note",
      visibility: "INTERNAL",
      createdAt: CREATED_AT,
    });

    const { req, params } = makeReq("ticket-1", {
      body: "internal note",
      visibility: "INTERNAL",
    });
    const res = await createMessage(req, { params });

    expect(res.status).toBe(201);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("visibility=PUBLIC → ยิง TICKET_MESSAGE_CREATED (author = agent, ไม่มี email ของ contact)", async () => {
    createTicketMessageMock.mockResolvedValue({
      id: "msg-2",
      body: "ตอบกลับแล้วครับ",
      visibility: "PUBLIC",
      createdAt: CREATED_AT,
    });

    const { req, params } = makeReq("ticket-1", { body: "ตอบกลับแล้วครับ" });
    const res = await createMessage(req, { params });

    expect(res.status).toBe(201);
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    const [db, tenantId, input, plan] = dispatchMock.mock.calls[0];
    expect(db).toBe(fakeDb);
    expect(tenantId).toBe("tenant-1");
    expect(plan).toBe("pro");
    expect(input).toEqual({
      eventType: "TICKET_MESSAGE_CREATED",
      occurredAt: CREATED_AT,
      ticket: { id: "ticket-1", ticketNumber: 1042, subject: "Need help" },
      message: {
        id: "msg-2",
        visibility: "PUBLIC",
        authorType: "agent",
        authorId: "member-1",
        body: "ตอบกลับแล้วครับ",
        createdAt: CREATED_AT,
      },
    });
    // PII guard: envelope ห้ามมี email ของ contact
    expect(JSON.stringify(input)).not.toContain("user@example.com");
  });
});

// =============================================================================
// PORTAL (contact audience) — เส้นทางที่ integrator เจอบ่อยที่สุด
// dispatch เป็น tenant-side side-effect: ไม่ได้ให้สิทธิ์อะไรเพิ่มกับ contact
// =============================================================================

describe("POST /api/portal/tickets — webhook trigger", () => {
  beforeEach(() => {
    createTicketWithNumberMock.mockResolvedValue({
      id: "ticket-2",
      ticketNumber: 1043,
      subject: "ล็อกอินไม่ได้",
      status: "NEW",
      priority: "NORMAL",
      assigneeId: null,
      requesterContactId: "contact-1",
      channel: "portal",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    fakeDb.ticket.findFirst.mockResolvedValue({ id: "ticket-2" });
  });

  it("contact สร้าง ticket → dispatch TICKET_CREATED พร้อม envelope input ครบ § 2", async () => {
    const res = await createPortalTicket(
      makeNextRequest("https://acme.helpwise.com/api/portal/tickets", {
        method: "POST",
        body: { subject: "ล็อกอินไม่ได้", firstMessage: { body: "เข้าระบบไม่ได้ครับ" } },
      })
    );

    expect(res.status).toBe(201);
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    const [db, tenantId, input, plan] = dispatchMock.mock.calls[0];
    expect(db).toBe(fakeDb);
    expect(tenantId).toBe("tenant-1");
    expect(plan).toBe("pro");
    expect(input).toEqual({
      eventType: "TICKET_CREATED",
      occurredAt: CREATED_AT,
      ticket: {
        id: "ticket-2",
        ticketNumber: 1043,
        subject: "ล็อกอินไม่ได้",
        status: "NEW",
        priority: "NORMAL",
        assigneeMemberId: null,
        requesterContactId: "contact-1",
        channel: "portal",
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    });
    // PII guard: envelope ห้ามมี email ของ contact
    expect(JSON.stringify(input)).not.toContain(CONTACT_EMAIL);
  });
});

describe("POST /api/portal/tickets/:id/messages — webhook trigger", () => {
  function makeReq(id: string, body: unknown) {
    return {
      req: makeNextRequest(`https://acme.helpwise.com/api/portal/tickets/${id}/messages`, {
        method: "POST",
        body,
      }),
      params: Promise.resolve({ id }),
    };
  }

  beforeEach(() => {
    fakeDb.ticket.findFirst.mockResolvedValue({
      id: "ticket-2",
      status: "OPEN",
      mergedIntoId: null,
      ticketNumber: 1043,
      subject: "ล็อกอินไม่ได้",
    });
    createTicketMessageMock.mockResolvedValue({
      id: "msg-3",
      body: "ยังเข้าไม่ได้เลยครับ",
      visibility: "PUBLIC",
      createdAt: CREATED_AT,
      attachments: [],
    });
  });

  it("contact ตอบกลับ → ยิง TICKET_MESSAGE_CREATED (authorType = contact, ไม่มี email ของ contact)", async () => {
    const { req, params } = makeReq("ticket-2", { body: "ยังเข้าไม่ได้เลยครับ" });
    const res = await createPortalMessage(req, { params });

    expect(res.status).toBe(201);
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    const [db, tenantId, input, plan] = dispatchMock.mock.calls[0];
    expect(db).toBe(fakeDb);
    expect(tenantId).toBe("tenant-1");
    expect(plan).toBe("pro");
    expect(input).toEqual({
      eventType: "TICKET_MESSAGE_CREATED",
      occurredAt: CREATED_AT,
      ticket: { id: "ticket-2", ticketNumber: 1043, subject: "ล็อกอินไม่ได้" },
      message: {
        id: "msg-3",
        visibility: "PUBLIC",
        authorType: "contact",
        authorId: "contact-1",
        body: "ยังเข้าไม่ได้เลยครับ",
        createdAt: CREATED_AT,
      },
    });
    // PII guard: envelope ห้ามมี email ของ contact
    expect(JSON.stringify(input)).not.toContain(CONTACT_EMAIL);
  });
});
