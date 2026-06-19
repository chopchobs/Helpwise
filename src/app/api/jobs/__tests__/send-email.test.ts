/**
 * src/app/api/jobs/__tests__/send-email.test.ts
 * Integration tests สำหรับ POST /api/jobs/send-email (QStash worker route, Phase 28 Slice 1)
 *
 * P0 invariants:
 *   - signature invalid → 401 (verify ก่อนทำงานใด ๆ)
 *   - idempotent: emailSentAt ถูก set แล้ว → skip ไม่ส่งซ้ำ (QStash retry-safe)
 *   - internal-note isolation: visibility=INTERNAL → ไม่ส่ง email (re-check ที่ worker)
 *   - tenant scope: query message ผ่าน tenantPrisma(tenantId จาก verified payload)
 *   - success path: ส่ง + set emailSentAt
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  fakeDb,
  tenantPrismaMock,
  verifyMock,
  sendEmailMock,
} = vi.hoisted(() => {
  const fakeDb = {
    ticketMessage: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  };
  return {
    fakeDb,
    tenantPrismaMock: vi.fn((tenantId: string): typeof fakeDb => {
      void tenantId; // ใช้เพื่อให้ mock บันทึก arg (assert tenant scope) โดยไม่ trigger unused-var
      return fakeDb;
    }),
    verifyMock: vi.fn(),
    sendEmailMock: vi.fn(),
  };
});

vi.mock("@/lib/tenant", () => ({
  tenantPrisma: (tenantId: string) => tenantPrismaMock(tenantId),
}));

vi.mock("@/lib/queue", () => ({
  verifyQStashSignature: (req: unknown) => verifyMock(req),
}));

vi.mock("@/lib/email", () => ({
  sendEmail: (msg: unknown) => sendEmailMock(msg),
}));

import { POST } from "@/app/api/jobs/send-email/route";

const TENANT_ID = "tenant-1";
const MESSAGE_ID = "msg-1";

/** สร้าง request — body จริงไม่สำคัญเพราะ verifyMock คืน rawBody เอง */
function makeRequest(rawBody: string): NextRequest {
  return new NextRequest(
    new Request("https://acme.helpwise.com/api/jobs/send-email", {
      method: "POST",
      body: rawBody,
      headers: { "content-type": "application/json" },
    })
  );
}

/** verified payload ปกติ */
function validPayload() {
  return JSON.stringify({ tenantId: TENANT_ID, messageId: MESSAGE_ID });
}

function publicUnsentMessage() {
  return {
    id: MESSAGE_ID,
    body: "hello <there>",
    visibility: "PUBLIC",
    emailSentAt: null,
    emailMessageId: "mid-1",
    emailInReplyTo: "in-reply-1",
    emailReferences: "ref-1",
    ticket: {
      subject: "Need help",
      ticketNumber: 42,
      requesterContact: { email: "customer@example.com" },
    },
  };
}

describe("POST /api/jobs/send-email — QStash worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeDb.ticketMessage.update.mockResolvedValue({});
    // default: claim ชนะ (count===1) — เคส race override เป็น count===0 เอง
    fakeDb.ticketMessage.updateMany.mockResolvedValue({ count: 1 });
  });

  it("signature invalid → 401, ไม่ query/ส่งใด ๆ", async () => {
    verifyMock.mockResolvedValue({ valid: false, rawBody: validPayload() });

    const res = await POST(makeRequest(validPayload()));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe("UNAUTHORIZED");
    expect(tenantPrismaMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("success path → tenant-scoped query, ส่ง email, set emailSentAt", async () => {
    verifyMock.mockResolvedValue({ valid: true, rawBody: validPayload() });
    fakeDb.ticketMessage.findFirst.mockResolvedValue(publicUnsentMessage());

    const res = await POST(makeRequest(validPayload()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.sent).toBe(true);
    // tenantId มาจาก verified payload เท่านั้น
    expect(tenantPrismaMock).toHaveBeenCalledWith(TENANT_ID);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    // subject มี ticket number prefix + threading headers ส่งครบ
    const emailArg = sendEmailMock.mock.calls[0][0] as {
      to: string;
      subject: string;
      headers: Record<string, string | undefined>;
    };
    expect(emailArg.to).toBe("customer@example.com");
    expect(emailArg.subject).toBe("[#42] Need help");
    expect(emailArg.headers.messageId).toBe("mid-1");
    // claim atomic ก่อนส่ง — conditional updateMany (PUBLIC + emailSentAt:null)
    expect(fakeDb.ticketMessage.updateMany).toHaveBeenCalledTimes(1);
    const claimArg = fakeDb.ticketMessage.updateMany.mock.calls[0][0] as {
      where: { id: string; visibility: string; emailSentAt: null };
      data: { emailSentAt: Date };
    };
    expect(claimArg.where.id).toBe(MESSAGE_ID);
    expect(claimArg.where.visibility).toBe("PUBLIC");
    expect(claimArg.where.emailSentAt).toBeNull();
    expect(claimArg.data.emailSentAt).toBeInstanceOf(Date);
  });

  it("idempotent: emailSentAt ถูก set แล้ว → skip ไม่ส่งซ้ำ", async () => {
    verifyMock.mockResolvedValue({ valid: true, rawBody: validPayload() });
    fakeDb.ticketMessage.findFirst.mockResolvedValue({
      ...publicUnsentMessage(),
      emailSentAt: new Date("2026-01-01T00:00:00Z"),
    });

    const res = await POST(makeRequest(validPayload()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.skipped).toBe("already_sent");
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(fakeDb.ticketMessage.updateMany).not.toHaveBeenCalled();
  });

  it("internal-note isolation: visibility=INTERNAL → ไม่ส่ง email", async () => {
    verifyMock.mockResolvedValue({ valid: true, rawBody: validPayload() });
    fakeDb.ticketMessage.findFirst.mockResolvedValue({
      ...publicUnsentMessage(),
      visibility: "INTERNAL",
    });

    const res = await POST(makeRequest(validPayload()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.skipped).toBe("not_public");
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(fakeDb.ticketMessage.updateMany).not.toHaveBeenCalled();
  });

  it("ไม่มี requester email → skip no_recipient", async () => {
    verifyMock.mockResolvedValue({ valid: true, rawBody: validPayload() });
    fakeDb.ticketMessage.findFirst.mockResolvedValue({
      ...publicUnsentMessage(),
      ticket: { subject: "x", ticketNumber: 1, requesterContact: null },
    });

    const res = await POST(makeRequest(validPayload()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.skipped).toBe("no_recipient");
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("claim ชนะ (updateMany count===1) → ส่ง email + claim emailSentAt atomic", async () => {
    verifyMock.mockResolvedValue({ valid: true, rawBody: validPayload() });
    fakeDb.ticketMessage.findFirst.mockResolvedValue(publicUnsentMessage());
    fakeDb.ticketMessage.updateMany.mockResolvedValue({ count: 1 });

    const res = await POST(makeRequest(validPayload()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.sent).toBe(true);
    // claim ก่อนส่ง: updateMany ถูกเรียกก่อน sendEmail (atomic guard)
    expect(fakeDb.ticketMessage.updateMany).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    // ไม่มี rollback (ส่งสำเร็จ) → updateMany เรียกครั้งเดียวเท่านั้น
    expect(fakeDb.ticketMessage.updateMany).toHaveBeenCalledTimes(1);
  });

  it("claim แพ้ (updateMany count===0, worker คู่แข่ง claim ไปแล้ว) → ไม่ส่ง email", async () => {
    verifyMock.mockResolvedValue({ valid: true, rawBody: validPayload() });
    fakeDb.ticketMessage.findFirst.mockResolvedValue(publicUnsentMessage());
    // จำลอง: ระหว่าง check กับ claim มี worker อื่น set emailSentAt ไปแล้ว → count===0
    fakeDb.ticketMessage.updateMany.mockResolvedValue({ count: 0 });

    const res = await POST(makeRequest(validPayload()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.skipped).toBe("already_claimed");
    // ⭐ invariant สำคัญสุด: claim แพ้ → ห้ามส่ง email (กัน double-send)
    expect(sendEmailMock).not.toHaveBeenCalled();
    // claim เรียกครั้งเดียว (ไม่มี rollback เพราะไม่ได้ claim/ไม่ได้ส่ง)
    expect(fakeDb.ticketMessage.updateMany).toHaveBeenCalledTimes(1);
  });

  it("sendEmail throw หลัง claim → rollback emailSentAt=null + 500 (ให้ QStash retry)", async () => {
    verifyMock.mockResolvedValue({ valid: true, rawBody: validPayload() });
    fakeDb.ticketMessage.findFirst.mockResolvedValue(publicUnsentMessage());
    fakeDb.ticketMessage.updateMany.mockResolvedValue({ count: 1 });
    sendEmailMock.mockRejectedValue(new Error("provider down"));

    const res = await POST(makeRequest(validPayload()));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe("SEND_FAILED");
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    // updateMany ถูกเรียก 2 ครั้ง: claim (count===1) + rollback
    expect(fakeDb.ticketMessage.updateMany).toHaveBeenCalledTimes(2);
    // ครั้งที่ 2 = rollback: set emailSentAt=null ให้ retry รอบหน้าส่งใหม่ได้
    const rollbackArg = fakeDb.ticketMessage.updateMany.mock.calls[1][0] as {
      data: { emailSentAt: Date | null };
    };
    expect(rollbackArg.data.emailSentAt).toBeNull();
  });

  it("payload ขาด tenantId/messageId → 400", async () => {
    verifyMock.mockResolvedValue({ valid: true, rawBody: JSON.stringify({ foo: "bar" }) });

    const res = await POST(makeRequest("{}"));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("INVALID_PAYLOAD");
    expect(tenantPrismaMock).not.toHaveBeenCalled();
  });
});
