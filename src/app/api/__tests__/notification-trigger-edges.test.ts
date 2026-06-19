/**
 * src/app/api/__tests__/notification-trigger-edges.test.ts
 * Integration tests — assign-notification trigger edge cases (Phase 28 Slice 2)
 *
 * เสริมจาก notification-triggers.test.ts (backend unit: happy path + self-assign + unassign
 * โดย existing.assigneeId = null เสมอ). ไฟล์นี้ครอบ edge ที่ unit เดิมยังไม่แตะ:
 *   - reassign จาก member อื่น → member อื่นอีกคน (non-self → non-self) → notify ปลายทางใหม่
 *   - reassign ให้ member เดิมซ้ำ (assigneeId === existing) → no-op → ไม่ notify (ลด noise)
 *   - notify เกิดครั้งเดียวต่อการ reassign (ไม่ซ้ำ)
 *   - ไม่รับ memberId recipient จาก client — recipient = assigneeId ที่ verify แล้วเท่านั้น
 *
 * อ้างเงื่อนไข source: src/app/api/tickets/[id]/route.ts L561 (assigneeId !== existing)
 * + L579 (assigneeId !== null && !== member.id)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultCtx, makeNextRequest } from "@/app/api/__tests__/_helpers";

const {
  fakeDb,
  requireAgentMock,
  auditLogMock,
  createNotificationMock,
  verifyAssigneeMembershipMock,
} = vi.hoisted(() => {
  const fakeDb = {
    ticket: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  };
  return {
    fakeDb,
    requireAgentMock: vi.fn(),
    auditLogMock: vi.fn(),
    createNotificationMock: vi.fn(),
    verifyAssigneeMembershipMock: vi.fn(),
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
  createTicketWithNumber: vi.fn(),
  verifyAssigneeMembership: (...args: unknown[]) => verifyAssigneeMembershipMock(...args),
  verifyContactBelongsToTenant: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: vi.fn(), tenant: { findUnique: vi.fn() }, slaPolicy: { findUnique: vi.fn() } },
}));

vi.mock("@/lib/features", () => ({
  hasFeature: vi.fn().mockResolvedValue(false),
  FEATURE_KEYS: { SLA_POLICIES: "sla_policies" },
}));

import { PATCH as patchTicket } from "@/app/api/tickets/[id]/route";

// ผู้ลงมือ = member-1
const SESSION = {
  user: { id: "user-1", name: "Agent One" },
  member: { id: "member-1", role: "AGENT", userId: "user-1" },
  ctx: defaultCtx(),
};

const BASE_DATE = new Date("2026-06-19T00:00:00.000Z");

function existingTicket(assigneeId: string | null) {
  return {
    id: "ticket-1",
    status: "OPEN",
    priority: "NORMAL",
    assigneeId,
    firstRespondedAt: null,
    resolvedAt: null,
    firstResponseDueAt: null,
    resolutionDueAt: null,
    slaPausedAt: null,
    slaPausedDurationMin: 0,
    slaPolicyId: null,
    createdAt: BASE_DATE,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAgentMock.mockResolvedValue(SESSION);
  auditLogMock.mockResolvedValue(undefined);
  createNotificationMock.mockResolvedValue(undefined);
  fakeDb.ticket.update.mockResolvedValue({
    id: "ticket-1",
    status: "OPEN",
    priority: "NORMAL",
    createdAt: BASE_DATE,
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

function makeReq(body: unknown) {
  return {
    req: makeNextRequest("https://acme.helpwise.com/api/tickets/ticket-1", {
      method: "PATCH",
      body,
    }),
    params: Promise.resolve({ id: "ticket-1" }),
  };
}

describe("reassign trigger edge cases", () => {
  it("reassign จาก member-2 → member-3 (non-self → non-self) → notify เฉพาะ member-3 ใหม่", async () => {
    fakeDb.ticket.findFirst.mockResolvedValue(existingTicket("member-2"));
    verifyAssigneeMembershipMock.mockResolvedValue({ id: "member-3" });

    const { req, params } = makeReq({ assigneeId: "member-3" });
    const res = await patchTicket(req, { params });

    expect(res.status).toBe(200);
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    expect(createNotificationMock).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        memberId: "member-3",
        type: "TICKET_ASSIGNED",
        ticketId: "ticket-1",
      })
    );
    // ไม่ notify member-2 (ผู้ถูกปลด)
    expect(createNotificationMock).not.toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ memberId: "member-2" })
    );
  });

  it("reassign ให้ member เดิมซ้ำ (assigneeId === existing) → no-op → ไม่ notify", async () => {
    // existing assignee = member-2; ส่ง assigneeId = member-2 อีกครั้ง
    fakeDb.ticket.findFirst.mockResolvedValue(existingTicket("member-2"));
    verifyAssigneeMembershipMock.mockResolvedValue({ id: "member-2" });

    const { req, params } = makeReq({ assigneeId: "member-2" });
    const res = await patchTicket(req, { params });

    expect(res.status).toBe(200);
    // assigneeId ไม่เปลี่ยน → ไม่เข้า trigger branch → ไม่ notify (กัน notification ซ้ำซ้อน)
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it("reassign ให้คนอื่น → createNotification ถูกเรียกครั้งเดียว (ไม่ซ้ำ)", async () => {
    fakeDb.ticket.findFirst.mockResolvedValue(existingTicket(null));
    verifyAssigneeMembershipMock.mockResolvedValue({ id: "member-2" });

    const { req, params } = makeReq({ assigneeId: "member-2" });
    await patchTicket(req, { params });

    expect(createNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("recipient = assigneeId ที่ verify แล้ว — ไม่ใช่ค่า recipient จาก client body", async () => {
    fakeDb.ticket.findFirst.mockResolvedValue(existingTicket(null));
    verifyAssigneeMembershipMock.mockResolvedValue({ id: "member-2" });

    // body ใส่ memberId/recipientId ปลอม — route ต้องเพิกเฉย, ใช้ assigneeId ที่ verify
    const { req, params } = makeReq({
      assigneeId: "member-2",
      memberId: "member-999",
      recipientId: "member-999",
    });
    const res = await patchTicket(req, { params });

    expect(res.status).toBe(200);
    expect(createNotificationMock).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ memberId: "member-2" })
    );
    expect(createNotificationMock).not.toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ memberId: "member-999" })
    );
  });

  it("assign ให้ตัวเอง (member-1) ในขณะที่ existing เป็นคนอื่น → reassign-to-self ไม่ notify", async () => {
    // existing = member-2, reassign มาที่ผู้ลงมือเอง (member-1) → skip self-assign
    fakeDb.ticket.findFirst.mockResolvedValue(existingTicket("member-2"));
    verifyAssigneeMembershipMock.mockResolvedValue({ id: "member-1" });

    const { req, params } = makeReq({ assigneeId: "member-1" });
    const res = await patchTicket(req, { params });

    expect(res.status).toBe(200);
    expect(createNotificationMock).not.toHaveBeenCalled();
  });
});
