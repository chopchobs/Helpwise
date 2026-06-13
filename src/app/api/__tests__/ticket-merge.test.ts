/**
 * src/app/api/__tests__/ticket-merge.test.ts
 * Integration tests สำหรับ POST /api/tickets/:id/merge + read-only guard
 * (TICKET_MERGED) ใน /api/tickets/:id/messages และ /api/portal/tickets/:id/messages
 *
 * P0 invariants:
 *   - role gate (OWNER/ADMIN เท่านั้น)
 *   - 🔒 privacy guard: source.requesterContactId !== target.requesterContactId
 *     → 400 CANNOT_MERGE_DIFFERENT_REQUESTER ก่อน mutate ใดๆ (assert $transaction ไม่ถูกเรียก)
 *   - re-parent direction ถูกทิศ (source → target) ใน $transaction
 *   - success path: internal note (INTERNAL) + source ปิด CLOSED + mergedIntoId + audit log
 *
 * P1 invariants:
 *   - ticket ที่ mergedIntoId != null เป็น read-only — POST messages → 409 TICKET_MERGED
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultCtx, DEFAULT_TENANT_ID, makeNextRequest } from "@/app/api/__tests__/_helpers";
import { AuthError } from "@/lib/auth";

const {
  fakeDb,
  requireAgentMock,
  requireContactMock,
  auditLogMock,
  txMock,
  prismaTransactionMock,
  createTicketMessageMock,
} = vi.hoisted(() => {
  const fakeDb = {
    ticket: { findFirst: vi.fn(), update: vi.fn() },
    ticketMessage: { findFirst: vi.fn() },
  };

  const txMock = {
    ticketMessage: { updateMany: vi.fn(), create: vi.fn() },
    attachment: { updateMany: vi.fn() },
    ticket: { update: vi.fn() },
  };

  return {
    fakeDb,
    requireAgentMock: vi.fn(),
    requireContactMock: vi.fn(),
    auditLogMock: vi.fn(),
    txMock,
    prismaTransactionMock: vi.fn(async (cb: (tx: typeof txMock) => Promise<void>) => cb(txMock)),
    createTicketMessageMock: vi.fn(),
  };
});

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    requireAgent: (...args: unknown[]) => requireAgentMock(...args),
    requireContact: (...args: unknown[]) => requireContactMock(...args),
  };
});

vi.mock("@/lib/tenant", () => ({
  tenantPrisma: () => fakeDb,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (cb: (tx: typeof txMock) => Promise<void>) => prismaTransactionMock(cb),
  },
}));

vi.mock("@/lib/audit", () => ({
  audit: { log: (...args: unknown[]) => auditLogMock(...args) },
}));

vi.mock("@/lib/tickets", () => ({
  createTicketMessage: (...args: unknown[]) => createTicketMessageMock(...args),
}));

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(),
}));

import { POST as mergePOST } from "@/app/api/tickets/[id]/merge/route";
import { POST as agentMessagesPOST } from "@/app/api/tickets/[id]/messages/route";
import { POST as portalMessagesPOST } from "@/app/api/portal/tickets/[id]/messages/route";

const DEFAULT_MEMBER = { id: "member-1", role: "OWNER" };

function defaultSession() {
  return { ctx: defaultCtx(), member: DEFAULT_MEMBER };
}

const SOURCE_ID = "ticket-source";
const TARGET_ID = "ticket-target";
const REQUESTER_A = "contact-A";
const REQUESTER_B = "contact-B";

function baseSource(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SOURCE_ID,
    ticketNumber: 100,
    requesterContactId: REQUESTER_A,
    mergedIntoId: null,
    status: "OPEN",
    ...overrides,
  };
}

function baseTarget(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: TARGET_ID,
    ticketNumber: 200,
    requesterContactId: REQUESTER_A,
    mergedIntoId: null,
    ...overrides,
  };
}

function mergeRequest(targetTicketNumber: unknown = 200) {
  return makeNextRequest("https://acme.helpwise.com/api/tickets/ticket-source/merge", {
    method: "POST",
    body: { targetTicketNumber },
  });
}

function mergeParams(id = SOURCE_ID) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAgentMock.mockResolvedValue(defaultSession());
  requireContactMock.mockResolvedValue({
    ctx: defaultCtx(),
    contact: { id: REQUESTER_A, name: "Test Contact", avatarUrl: null },
  });
  prismaTransactionMock.mockImplementation(async (cb: (tx: typeof txMock) => Promise<void>) => cb(txMock));
});

// =============================================================================
// MERGE — role gate
// =============================================================================

describe("POST /api/tickets/:id/merge — role gate", () => {
  it("requireAgent throw 403 → response 403, ไม่แตะ DB", async () => {
    requireAgentMock.mockRejectedValueOnce(new AuthError("Forbidden", 403));

    const res = await mergePOST(mergeRequest(), mergeParams());
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe("FORBIDDEN");
    expect(fakeDb.ticket.findFirst).not.toHaveBeenCalled();
    expect(prismaTransactionMock).not.toHaveBeenCalled();
  });

  it("เรียก requireAgent ด้วย roles: OWNER/ADMIN", async () => {
    fakeDb.ticket.findFirst
      .mockResolvedValueOnce(baseSource())
      .mockResolvedValueOnce(baseTarget());

    await mergePOST(mergeRequest(), mergeParams());

    expect(requireAgentMock).toHaveBeenCalledWith({ roles: ["OWNER", "ADMIN"] });
  });
});

// =============================================================================
// MERGE — validation / not found
// =============================================================================

describe("POST /api/tickets/:id/merge — validation & not found", () => {
  it("source ไม่เจอ → 404 NOT_FOUND", async () => {
    fakeDb.ticket.findFirst.mockResolvedValueOnce(null);

    const res = await mergePOST(mergeRequest(), mergeParams());
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(prismaTransactionMock).not.toHaveBeenCalled();
  });

  it("target ไม่เจอ → 404 TARGET_NOT_FOUND", async () => {
    fakeDb.ticket.findFirst
      .mockResolvedValueOnce(baseSource())
      .mockResolvedValueOnce(null);

    const res = await mergePOST(mergeRequest(), mergeParams());
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("TARGET_NOT_FOUND");
    expect(prismaTransactionMock).not.toHaveBeenCalled();
  });

  it("body invalid (targetTicketNumber ไม่ใช่ number บวก) → 400 VALIDATION_ERROR", async () => {
    const res = await mergePOST(mergeRequest(-1), mergeParams());
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(fakeDb.ticket.findFirst).not.toHaveBeenCalled();
  });

  it("body ไม่ใช่ JSON → 400 INVALID_JSON", async () => {
    const req = makeNextRequest("https://acme.helpwise.com/api/tickets/ticket-source/merge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json{{{",
    });

    const res = await mergePOST(req, mergeParams());
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("INVALID_JSON");
  });
});

// =============================================================================
// MERGE — self / privacy / already-merged guards
// =============================================================================

describe("POST /api/tickets/:id/merge — guards before mutation", () => {
  it("source.id === target.id → 400 CANNOT_MERGE_SELF", async () => {
    const sameTicket = baseSource({ ticketNumber: 100 });
    fakeDb.ticket.findFirst
      .mockResolvedValueOnce(sameTicket)
      .mockResolvedValueOnce({ ...sameTicket, id: SOURCE_ID });

    const res = await mergePOST(mergeRequest(100), mergeParams());
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("CANNOT_MERGE_SELF");
    expect(prismaTransactionMock).not.toHaveBeenCalled();
  });

  it("🔒 privacy guard: requesterContactId ต่างกัน → 400 CANNOT_MERGE_DIFFERENT_REQUESTER, $transaction ไม่ถูกเรียก", async () => {
    fakeDb.ticket.findFirst
      .mockResolvedValueOnce(baseSource({ requesterContactId: REQUESTER_A }))
      .mockResolvedValueOnce(baseTarget({ requesterContactId: REQUESTER_B }));

    const res = await mergePOST(mergeRequest(), mergeParams());
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("CANNOT_MERGE_DIFFERENT_REQUESTER");
    expect(prismaTransactionMock).not.toHaveBeenCalled();
    expect(auditLogMock).not.toHaveBeenCalled();
  });

  it("source.mergedIntoId != null → 409 ALREADY_MERGED", async () => {
    fakeDb.ticket.findFirst
      .mockResolvedValueOnce(baseSource({ mergedIntoId: "some-other-ticket" }))
      .mockResolvedValueOnce(baseTarget());

    const res = await mergePOST(mergeRequest(), mergeParams());
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe("ALREADY_MERGED");
    expect(prismaTransactionMock).not.toHaveBeenCalled();
  });

  it("target.mergedIntoId != null → 409 TARGET_ALREADY_MERGED", async () => {
    fakeDb.ticket.findFirst
      .mockResolvedValueOnce(baseSource())
      .mockResolvedValueOnce(baseTarget({ mergedIntoId: "yet-another-ticket" }));

    const res = await mergePOST(mergeRequest(), mergeParams());
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe("TARGET_ALREADY_MERGED");
    expect(prismaTransactionMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// MERGE — success path
// =============================================================================

describe("POST /api/tickets/:id/merge — success", () => {
  it("merge สำเร็จ: re-parent ถูกทิศ, internal note INTERNAL, source CLOSED+mergedIntoId, audit log, response shape", async () => {
    const source = baseSource();
    const target = baseTarget();
    fakeDb.ticket.findFirst
      .mockResolvedValueOnce(source)
      .mockResolvedValueOnce(target);

    const res = await mergePOST(mergeRequest(target.ticketNumber), mergeParams());
    const json = await res.json();

    expect(res.status).toBe(200);

    // $transaction ถูกเรียก
    expect(prismaTransactionMock).toHaveBeenCalledTimes(1);

    // 1. re-parent messages: source → target
    expect(txMock.ticketMessage.updateMany).toHaveBeenCalledWith({
      where: { tenantId: DEFAULT_TENANT_ID, ticketId: source.id },
      data: { ticketId: target.id },
    });

    // 2. re-parent attachments: source → target
    expect(txMock.attachment.updateMany).toHaveBeenCalledWith({
      where: { tenantId: DEFAULT_TENANT_ID, ticketId: source.id },
      data: { ticketId: target.id },
    });

    // 3. internal note บน target, visibility INTERNAL, อ้าง source ticketNumber
    expect(txMock.ticketMessage.create).toHaveBeenCalledTimes(1);
    const createArg = txMock.ticketMessage.create.mock.calls[0][0];
    expect(createArg.data.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(createArg.data.ticketId).toBe(target.id);
    expect(createArg.data.visibility).toBe("INTERNAL");
    expect(createArg.data.body).toContain(String(source.ticketNumber));
    expect(createArg.data.authorMemberId).toBe(DEFAULT_MEMBER.id);

    // 4. source ปิด CLOSED + mergedIntoId = target.id
    expect(txMock.ticket.update).toHaveBeenCalledTimes(1);
    const updateArg = txMock.ticket.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: source.id });
    expect(updateArg.data.status).toBe("CLOSED");
    expect(updateArg.data.mergedIntoId).toBe(target.id);

    // 5. audit log ticket.merged
    expect(auditLogMock).toHaveBeenCalledTimes(1);
    const auditArg = auditLogMock.mock.calls[0][0];
    expect(auditArg.action).toBe("ticket.merged");
    expect(auditArg.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(auditArg.targetId).toBe(source.id);
    expect(auditArg.after).toMatchObject({ status: "CLOSED", mergedIntoId: target.id });

    // 6. response shape
    expect(json.error).toBeNull();
    expect(json.data.source).toMatchObject({
      id: source.id,
      ticketNumber: source.ticketNumber,
      status: "CLOSED",
      mergedInto: { id: target.id, ticketNumber: target.ticketNumber },
    });
    expect(json.data.target).toMatchObject({ id: target.id, ticketNumber: target.ticketNumber });
  });
});

// =============================================================================
// READ-ONLY GUARD — agent messages route
// =============================================================================

describe("POST /api/tickets/:id/messages — read-only guard (merged ticket)", () => {
  it("ticket.mergedIntoId != null → 409 TICKET_MERGED, ไม่ create message", async () => {
    fakeDb.ticket.findFirst.mockResolvedValueOnce({
      id: SOURCE_ID,
      status: "CLOSED",
      firstRespondedAt: new Date(),
      subject: "test",
      ticketNumber: 100,
      emailMessageId: null,
      mergedIntoId: TARGET_ID,
      requesterContact: { id: REQUESTER_A, email: "a@example.com", name: "A" },
    });

    const req = makeNextRequest("https://acme.helpwise.com/api/tickets/ticket-source/messages", {
      method: "POST",
      body: { body: "hello", visibility: "PUBLIC" },
    });

    const res = await agentMessagesPOST(req, mergeParams());
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe("TICKET_MERGED");
    expect(createTicketMessageMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// READ-ONLY GUARD — portal messages route
// =============================================================================

describe("POST /api/portal/tickets/:id/messages — read-only guard (merged ticket)", () => {
  it("own ticket แต่ mergedIntoId != null → 409 TICKET_MERGED, ไม่ create message", async () => {
    // own-records check ผ่าน (requesterContactId === contact.id) แต่ mergedIntoId != null
    fakeDb.ticket.findFirst.mockResolvedValueOnce({
      id: SOURCE_ID,
      status: "CLOSED",
      mergedIntoId: TARGET_ID,
    });

    const req = makeNextRequest("https://portal.helpwise.com/api/portal/tickets/ticket-source/messages", {
      method: "POST",
      body: { body: "hello from contact" },
    });

    const res = await portalMessagesPOST(req, mergeParams());
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe("TICKET_MERGED");
    expect(createTicketMessageMock).not.toHaveBeenCalled();

    // assert own-records scope ถูกใช้ใน query
    expect(fakeDb.ticket.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: SOURCE_ID, requesterContactId: REQUESTER_A }),
      })
    );
  });

  it("ticket ของ contact อื่น (ไม่ผ่าน own-records) → 404 NOT_FOUND ไม่ใช่ 409", async () => {
    // findFirst คืน null เพราะ where มี requesterContactId ของ contact ปัจจุบันแล้วไม่ match
    fakeDb.ticket.findFirst.mockResolvedValueOnce(null);

    const req = makeNextRequest("https://portal.helpwise.com/api/portal/tickets/ticket-other/messages", {
      method: "POST",
      body: { body: "hello" },
    });

    const res = await portalMessagesPOST(req, mergeParams("ticket-other"));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(createTicketMessageMock).not.toHaveBeenCalled();
  });
});
