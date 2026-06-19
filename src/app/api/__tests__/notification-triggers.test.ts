/**
 * src/app/api/__tests__/notification-triggers.test.ts
 * Tests สำหรับ notification trigger บน assign (Phase 28 Slice 2)
 *
 * Producers:
 *   - POST  /api/tickets         — create พร้อม assigneeId
 *   - PATCH /api/tickets/:id      — reassign assigneeId
 *
 * P0 invariants:
 *   - notify ผู้ถูก assign (createNotification เรียกด้วย memberId = assignee, ticketId)
 *   - skip self-assign (assignee === ผู้ลงมือ → ไม่ notify)
 *   - unassign (assigneeId = null) บน PATCH → ไม่ notify
 *   - recipient = assigneeId ที่ verify แล้วว่าเป็น member ของ tenant นี้
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultCtx, makeNextRequest } from "@/app/api/__tests__/_helpers";

const {
  fakeDb,
  requireAgentMock,
  auditLogMock,
  createNotificationMock,
  createTicketWithNumberMock,
  verifyAssigneeMembershipMock,
  verifyContactMock,
} = vi.hoisted(() => {
  const fakeDb = {
    ticket: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  };
  return {
    fakeDb,
    requireAgentMock: vi.fn(),
    auditLogMock: vi.fn(),
    createNotificationMock: vi.fn(),
    createTicketWithNumberMock: vi.fn(),
    verifyAssigneeMembershipMock: vi.fn(),
    verifyContactMock: vi.fn(),
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
  verifyAssigneeMembership: (...args: unknown[]) => verifyAssigneeMembershipMock(...args),
  verifyContactBelongsToTenant: (...args: unknown[]) => verifyContactMock(...args),
}));

// prisma ใช้เฉพาะ path requesterEmail / SLA — test ใช้ requesterContactId + ticket ไม่มี SLA
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: vi.fn(), tenant: { findUnique: vi.fn() }, slaPolicy: { findUnique: vi.fn() } },
}));

vi.mock("@/lib/features", () => ({
  hasFeature: vi.fn().mockResolvedValue(false),
  FEATURE_KEYS: { SLA_POLICIES: "sla_policies" },
}));

import { POST as createTicket } from "@/app/api/tickets/route";
import { PATCH as patchTicket } from "@/app/api/tickets/[id]/route";

const SESSION = {
  user: { id: "user-1", name: "Agent One" },
  member: { id: "member-1", role: "AGENT", userId: "user-1" },
  ctx: defaultCtx(),
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAgentMock.mockResolvedValue(SESSION);
  auditLogMock.mockResolvedValue(undefined);
  createNotificationMock.mockResolvedValue(undefined);
});

// =============================================================================
// POST /api/tickets — create พร้อม assigneeId
// =============================================================================

describe("POST /api/tickets — notification trigger", () => {
  function makeReq(body: unknown) {
    return makeNextRequest("https://acme.helpwise.com/api/tickets", {
      method: "POST",
      body,
    });
  }

  beforeEach(() => {
    verifyContactMock.mockResolvedValue({ id: "contact-1" });
    verifyAssigneeMembershipMock.mockResolvedValue({ id: "member-2" });
    createTicketWithNumberMock.mockResolvedValue({
      id: "ticket-1",
      ticketNumber: 1,
      status: "NEW",
      priority: "NORMAL",
      channel: "agent",
    });
    fakeDb.ticket.findUnique.mockResolvedValue({ id: "ticket-1" });
  });

  it("assign ให้ member อื่น → createNotification(memberId=assignee, ticketId)", async () => {
    const res = await createTicket(
      makeReq({ subject: "Help me", requesterContactId: "contact-1", assigneeId: "member-2" })
    );

    expect(res.status).toBe(201);
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    expect(createNotificationMock).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        memberId: "member-2",
        type: "TICKET_ASSIGNED",
        ticketId: "ticket-1",
      })
    );
  });

  it("self-assign (assignee = ผู้ลงมือ) → ไม่ notify", async () => {
    verifyAssigneeMembershipMock.mockResolvedValue({ id: "member-1" });

    const res = await createTicket(
      makeReq({ subject: "Help me", requesterContactId: "contact-1", assigneeId: "member-1" })
    );

    expect(res.status).toBe(201);
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it("ไม่มี assignee → ไม่ notify", async () => {
    const res = await createTicket(
      makeReq({ subject: "Help me", requesterContactId: "contact-1" })
    );

    expect(res.status).toBe(201);
    expect(createNotificationMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// PATCH /api/tickets/:id — reassign
// =============================================================================

describe("PATCH /api/tickets/:id — notification trigger", () => {
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
    // existing ticket: ยังไม่มี assignee + ไม่มี SLA deadline (hasSla=false)
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
      createdAt: new Date("2026-06-19T00:00:00.000Z"),
    });
    fakeDb.ticket.update.mockResolvedValue({
      id: "ticket-1",
      status: "OPEN",
      priority: "NORMAL",
      createdAt: new Date("2026-06-19T00:00:00.000Z"),
      updatedAt: new Date("2026-06-19T01:00:00.000Z"),
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

  it("reassign ให้ member อื่น → createNotification(memberId=assignee, ticketId)", async () => {
    const { req, params } = makeReq("ticket-1", { assigneeId: "member-2" });
    const res = await patchTicket(req, { params });

    expect(res.status).toBe(200);
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    expect(createNotificationMock).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        memberId: "member-2",
        type: "TICKET_ASSIGNED",
        ticketId: "ticket-1",
      })
    );
  });

  it("self-assign → ไม่ notify", async () => {
    verifyAssigneeMembershipMock.mockResolvedValue({ id: "member-1" });

    const { req, params } = makeReq("ticket-1", { assigneeId: "member-1" });
    const res = await patchTicket(req, { params });

    expect(res.status).toBe(200);
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it("unassign (assigneeId = null) → ไม่ notify", async () => {
    // existing มี assignee อยู่แล้ว เพื่อให้ assigneeId !== existing (trigger audit branch)
    fakeDb.ticket.findFirst.mockResolvedValue({
      id: "ticket-1",
      status: "OPEN",
      priority: "NORMAL",
      assigneeId: "member-2",
      firstRespondedAt: null,
      resolvedAt: null,
      firstResponseDueAt: null,
      resolutionDueAt: null,
      slaPausedAt: null,
      slaPausedDurationMin: 0,
      slaPolicyId: null,
      createdAt: new Date("2026-06-19T00:00:00.000Z"),
    });

    const { req, params } = makeReq("ticket-1", { assigneeId: null });
    const res = await patchTicket(req, { params });

    expect(res.status).toBe(200);
    expect(createNotificationMock).not.toHaveBeenCalled();
  });
});
