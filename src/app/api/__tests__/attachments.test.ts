/**
 * src/app/api/__tests__/attachments.test.ts
 * Integration tests สำหรับ Phase 25 (File Attachments)
 *
 * Endpoints/logic ที่ test:
 *   - POST /api/tickets/:id/attachments/sign (agent)
 *   - POST /api/portal/tickets/:id/attachments/sign (portal — own-records)
 *   - GET /api/attachments/:id (agent download)
 *   - GET /api/portal/attachments/:id (portal download — triple scope)
 *   - createTicketMessage attachment verify logic (src/lib/tickets.ts)
 *
 * 🔴 Critical invariants:
 *   - portal sign/download: own-records scope (requesterContactId === ctx.contactId) → ไม่ตรง = 404
 *   - portal download: internal-note isolation — attachment ของ message visibility=INTERNAL → 404
 *   - createTicketMessage: attachment path ต้องขึ้นต้น `{tenantId}/{ticketId}/` กัน cross-tenant/ticket inject
 *   - createTicketMessage: size/mimeType ที่บันทึกจริงมาจาก getObjectInfo (authoritative) ไม่ใช่จาก client
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultCtx, makeNextRequest } from "@/app/api/__tests__/_helpers";

const {
  fakeDb,
  requireAgentMock,
  requireContactMock,
  storageMock,
} = vi.hoisted(() => {
  const fakeDb = {
    ticket: { findFirst: vi.fn() },
    attachment: { findFirst: vi.fn() },
    ticketMessage: { create: vi.fn() },
  };

  const storageMock = {
    createSignedUploadUrl: vi.fn(),
    createSignedDownloadUrl: vi.fn(),
    getObjectInfo: vi.fn(),
    isAllowedMimeType: vi.fn(),
    buildAttachmentPath: vi.fn(),
    MAX_FILE_BYTES: 25 * 1024 * 1024,
    MAX_ATTACHMENTS_PER_MESSAGE: 10,
    ALLOWED_MIME_TYPES: ["image/png", "application/pdf"],
    sanitizeFileName: (s: string) => s,
  };

  return {
    fakeDb,
    requireAgentMock: vi.fn(),
    requireContactMock: vi.fn(),
    storageMock,
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
    requireContact: (...args: unknown[]) => requireContactMock(...args),
  };
});

vi.mock("@/lib/storage", () => storageMock);

import { POST as agentSign } from "@/app/api/tickets/[id]/attachments/sign/route";
import { POST as portalSign } from "@/app/api/portal/tickets/[id]/attachments/sign/route";
import { GET as agentDownload } from "@/app/api/attachments/[id]/route";
import { GET as portalDownload } from "@/app/api/portal/attachments/[id]/route";
import { createTicketMessage } from "@/lib/tickets";
import { AuthError } from "@/lib/auth";

const AGENT_SESSION = {
  user: { id: "user-1", name: "Agent" },
  member: { id: "member-1", role: "AGENT", userId: "user-1" },
  ctx: defaultCtx(),
};

const CONTACT_SESSION = {
  contact: { id: "contact-1", name: "Test Contact", avatarUrl: null },
  ctx: defaultCtx(),
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAgentMock.mockResolvedValue(AGENT_SESSION);
  requireContactMock.mockResolvedValue(CONTACT_SESSION);
  // default: allow everything unless overridden ใน test
  storageMock.isAllowedMimeType.mockReturnValue(true);
  storageMock.buildAttachmentPath.mockReturnValue({
    path: "tenant-1/ticket-1/obj-1/file.png",
    objectId: "obj-1",
  });
});

// =============================================================================
// POST /api/tickets/:id/attachments/sign (agent)
// =============================================================================

describe("POST /api/tickets/:id/attachments/sign (agent)", () => {
  function makeReq(id: string, body: unknown) {
    return {
      req: makeNextRequest(`https://acme.helpwise.com/api/tickets/${id}/attachments/sign`, {
        method: "POST",
        body,
      }),
      params: Promise.resolve({ id }),
    };
  }

  const VALID_BODY = { fileName: "doc.pdf", mimeType: "application/pdf", fileSize: 1024 };

  it("ticket ไม่พบ → 404 NOT_FOUND", async () => {
    fakeDb.ticket.findFirst.mockResolvedValue(null);

    const { req, params } = makeReq("ticket-x", VALID_BODY);
    const res = await agentSign(req, { params });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(storageMock.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("ticket mergedIntoId != null → 409 TICKET_MERGED", async () => {
    fakeDb.ticket.findFirst.mockResolvedValue({ id: "ticket-1", mergedIntoId: "ticket-target" });

    const { req, params } = makeReq("ticket-1", VALID_BODY);
    const res = await agentSign(req, { params });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe("TICKET_MERGED");
    expect(storageMock.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("mimeType ไม่อยู่ allowlist → 400 UNSUPPORTED_MEDIA_TYPE", async () => {
    fakeDb.ticket.findFirst.mockResolvedValue({ id: "ticket-1", mergedIntoId: null });
    storageMock.isAllowedMimeType.mockReturnValue(false);

    const { req, params } = makeReq("ticket-1", { ...VALID_BODY, mimeType: "application/x-evil" });
    const res = await agentSign(req, { params });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(storageMock.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("fileSize > maxBytes → 400 FILE_TOO_LARGE", async () => {
    fakeDb.ticket.findFirst.mockResolvedValue({ id: "ticket-1", mergedIntoId: null });

    const { req, params } = makeReq("ticket-1", { ...VALID_BODY, fileSize: 26 * 1024 * 1024 });
    const res = await agentSign(req, { params });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("FILE_TOO_LARGE");
    expect(storageMock.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("happy path → 200 + data มี uploadUrl/token/path/maxBytes", async () => {
    fakeDb.ticket.findFirst.mockResolvedValue({ id: "ticket-1", mergedIntoId: null });
    storageMock.createSignedUploadUrl.mockResolvedValue({
      uploadUrl: "https://storage.example/upload",
      token: "signed-token",
      path: "tenant-1/ticket-1/obj-1/file.png",
    });

    const { req, params } = makeReq("ticket-1", VALID_BODY);
    const res = await agentSign(req, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({
      uploadUrl: "https://storage.example/upload",
      token: "signed-token",
      path: "tenant-1/ticket-1/obj-1/file.png",
      maxBytes: storageMock.MAX_FILE_BYTES,
    });
  });
});

// =============================================================================
// POST /api/portal/tickets/:id/attachments/sign (portal)
// =============================================================================

describe("POST /api/portal/tickets/:id/attachments/sign (portal)", () => {
  function makeReq(id: string, body: unknown) {
    return {
      req: makeNextRequest(`https://acme.helpwise.com/api/portal/tickets/${id}/attachments/sign`, {
        method: "POST",
        body,
      }),
      params: Promise.resolve({ id }),
    };
  }

  const VALID_BODY = { fileName: "doc.pdf", mimeType: "application/pdf", fileSize: 1024 };

  it("ticket ที่ requesterContactId != ctx.contactId → 404 (own-records, ไม่ reveal)", async () => {
    // tenantPrisma findFirst ถูก call ด้วย requesterContactId filter — fake db คืน null
    // เพราะ ticket ไม่ใช่ของ contact นี้ (simulate ผ่านการคืน null)
    fakeDb.ticket.findFirst.mockResolvedValue(null);

    const { req, params } = makeReq("ticket-other", VALID_BODY);
    const res = await portalSign(req, { params });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(storageMock.createSignedUploadUrl).not.toHaveBeenCalled();

    // assert query filter ใช้ requesterContactId = contact.id (own-records scope)
    expect(fakeDb.ticket.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "ticket-other",
          requesterContactId: CONTACT_SESSION.contact.id,
        }),
      })
    );
  });

  it("happy path (ticket ของ contact ตัวเอง) → 200", async () => {
    fakeDb.ticket.findFirst.mockResolvedValue({ id: "ticket-1", mergedIntoId: null });
    storageMock.createSignedUploadUrl.mockResolvedValue({
      uploadUrl: "https://storage.example/upload",
      token: "signed-token",
      path: "tenant-1/ticket-1/obj-1/file.png",
    });

    const { req, params } = makeReq("ticket-1", VALID_BODY);
    const res = await portalSign(req, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.uploadUrl).toBe("https://storage.example/upload");
    expect(json.data.token).toBe("signed-token");
    expect(json.data.path).toBe("tenant-1/ticket-1/obj-1/file.png");
    expect(json.data.maxBytes).toBe(storageMock.MAX_FILE_BYTES);
  });

  it("requireContact throw (เช่นไม่ได้ login) → propagate error", async () => {
    requireContactMock.mockRejectedValue(new AuthError("Unauthorized", 401));

    const { req, params } = makeReq("ticket-1", VALID_BODY);
    const res = await portalSign(req, { params });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.data).toBeNull();
    expect(fakeDb.ticket.findFirst).not.toHaveBeenCalled();
  });
});

// =============================================================================
// GET /api/attachments/:id (agent download)
// =============================================================================

describe("GET /api/attachments/:id (agent)", () => {
  function call(id: string) {
    return agentDownload(
      new Request(`https://acme.helpwise.com/api/attachments/${id}`) as unknown as Parameters<typeof agentDownload>[0],
      { params: Promise.resolve({ id }) }
    );
  }

  it("attachment ไม่พบ → 404 NOT_FOUND", async () => {
    fakeDb.attachment.findFirst.mockResolvedValue(null);

    const res = await call("att-x");
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(storageMock.createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("happy path → 200 + data.url", async () => {
    fakeDb.attachment.findFirst.mockResolvedValue({ id: "att-1", storageUrl: "tenant-1/ticket-1/obj-1/file.png" });
    storageMock.createSignedDownloadUrl.mockResolvedValue("https://storage.example/signed-download");

    const res = await call("att-1");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ url: "https://storage.example/signed-download" });
    expect(storageMock.createSignedDownloadUrl).toHaveBeenCalledWith("tenant-1/ticket-1/obj-1/file.png", 60);
  });

  it("requireAgent throw → propagate error code/status", async () => {
    requireAgentMock.mockRejectedValue(new AuthError("Unauthorized", 401));

    const res = await call("att-1");
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.data).toBeNull();
    expect(fakeDb.attachment.findFirst).not.toHaveBeenCalled();
  });
});

// =============================================================================
// GET /api/portal/attachments/:id (portal download — 🔴 triple scope)
// =============================================================================

describe("GET /api/portal/attachments/:id (portal — triple scope)", () => {
  function call(id: string) {
    return portalDownload(
      new Request(`https://acme.helpwise.com/api/portal/attachments/${id}`) as unknown as Parameters<typeof portalDownload>[0],
      { params: Promise.resolve({ id }) }
    );
  }

  it("attachment ไม่พบ → 404 NOT_FOUND", async () => {
    fakeDb.attachment.findFirst.mockResolvedValue(null);

    const res = await call("att-x");
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(storageMock.createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("🔴 attachment.ticket.requesterContactId != ctx.contactId → 404 (own-records, ไม่ reveal)", async () => {
    fakeDb.attachment.findFirst.mockResolvedValue({
      id: "att-1",
      storageUrl: "tenant-1/ticket-1/obj-1/file.png",
      message: { visibility: "PUBLIC" },
      ticket: { requesterContactId: "contact-other" },
    });

    const res = await call("att-1");
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(storageMock.createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("🔴 attachment.message.visibility = INTERNAL → 404 (internal-note isolation)", async () => {
    fakeDb.attachment.findFirst.mockResolvedValue({
      id: "att-1",
      storageUrl: "tenant-1/ticket-1/obj-1/internal-file.png",
      message: { visibility: "INTERNAL" },
      ticket: { requesterContactId: CONTACT_SESSION.contact.id },
    });

    const res = await call("att-1");
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(storageMock.createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("happy path (own + PUBLIC) → 200 + data.url", async () => {
    fakeDb.attachment.findFirst.mockResolvedValue({
      id: "att-1",
      storageUrl: "tenant-1/ticket-1/obj-1/file.png",
      message: { visibility: "PUBLIC" },
      ticket: { requesterContactId: CONTACT_SESSION.contact.id },
    });
    storageMock.createSignedDownloadUrl.mockResolvedValue("https://storage.example/signed-download");

    const res = await call("att-1");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ url: "https://storage.example/signed-download" });
    expect(storageMock.createSignedDownloadUrl).toHaveBeenCalledWith("tenant-1/ticket-1/obj-1/file.png", 60);
  });
});

// =============================================================================
// createTicketMessage — attachment verify logic (src/lib/tickets.ts)
// =============================================================================

describe("createTicketMessage — attachment verify", () => {
  const TENANT_ID = "tenant-1";
  const TICKET_ID = "ticket-1";

  function baseInput(attachments: { path: string; fileName: string }[]) {
    return {
      tenantId: TENANT_ID,
      ticketId: TICKET_ID,
      body: "Hello with attachment",
      visibility: "PUBLIC" as const,
      authorMemberId: "member-1",
      // client ส่ง mimeType/fileSize มาเป็น hint เท่านั้น — backend override ด้วย getObjectInfo
      // ใส่ค่า dummy ให้ครบ type MessageAttachmentInput (ค่าจริงมาจาก storage)
      attachments: attachments.map((a) => ({
        ...a,
        mimeType: "image/png",
        fileSize: 1024,
      })),
    };
  }

  it("path ไม่ขึ้นต้น `{tenantId}/{ticketId}/` → throw (cross-tenant/ticket inject)", async () => {
    const input = baseInput([{ path: "tenant-evil/ticket-evil/obj-1/file.png", fileName: "file.png" }]);

    await expect(createTicketMessage(fakeDb as never, input)).rejects.toThrow(
      /path ไม่ถูกต้อง/
    );
    expect(fakeDb.ticketMessage.create).not.toHaveBeenCalled();
  });

  it("getObjectInfo คืน null (ไฟล์ไม่มีจริง) → throw", async () => {
    storageMock.getObjectInfo.mockResolvedValue(null);
    const input = baseInput([{ path: `${TENANT_ID}/${TICKET_ID}/obj-1/file.png`, fileName: "file.png" }]);

    await expect(createTicketMessage(fakeDb as never, input)).rejects.toThrow(
      /ไม่พบไฟล์ที่ upload/
    );
    expect(fakeDb.ticketMessage.create).not.toHaveBeenCalled();
  });

  it("getObjectInfo คืน mime ไม่ allowlist → throw", async () => {
    storageMock.getObjectInfo.mockResolvedValue({ size: 1024, mimeType: "application/x-evil" });
    storageMock.isAllowedMimeType.mockReturnValue(false);
    const input = baseInput([{ path: `${TENANT_ID}/${TICKET_ID}/obj-1/file.exe`, fileName: "file.exe" }]);

    await expect(createTicketMessage(fakeDb as never, input)).rejects.toThrow(
      /ชนิดไฟล์ไม่รองรับ/
    );
    expect(fakeDb.ticketMessage.create).not.toHaveBeenCalled();
  });

  it("getObjectInfo คืน size เกิน cap → throw", async () => {
    storageMock.getObjectInfo.mockResolvedValue({
      size: storageMock.MAX_FILE_BYTES + 1,
      mimeType: "image/png",
    });
    storageMock.isAllowedMimeType.mockReturnValue(true);
    const input = baseInput([{ path: `${TENANT_ID}/${TICKET_ID}/obj-1/big.png`, fileName: "big.png" }]);

    await expect(createTicketMessage(fakeDb as never, input)).rejects.toThrow(
      /ขนาดใหญ่เกินกำหนด/
    );
    expect(fakeDb.ticketMessage.create).not.toHaveBeenCalled();
  });

  it("attachments เกิน MAX_ATTACHMENTS_PER_MESSAGE → throw", async () => {
    const attachments = Array.from({ length: storageMock.MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, i) => ({
      path: `${TENANT_ID}/${TICKET_ID}/obj-${i}/file.png`,
      fileName: `file-${i}.png`,
    }));
    const input = baseInput(attachments);

    await expect(createTicketMessage(fakeDb as never, input)).rejects.toThrow(
      /แนบไฟล์ได้สูงสุด/
    );
    expect(fakeDb.ticketMessage.create).not.toHaveBeenCalled();
    // ไม่ควรเรียก getObjectInfo เลย ถ้าเกิน limit ตั้งแต่ก่อนเช็คไฟล์
    expect(storageMock.getObjectInfo).not.toHaveBeenCalled();
  });

  it("happy path: ใช้ size/mimeType จาก getObjectInfo (authoritative) ไม่ใช่จาก client", async () => {
    // client ส่ง path มาเฉยๆ — fileName เป็น display name; size/mime มาจาก storage เท่านั้น
    storageMock.getObjectInfo.mockResolvedValue({ size: 2048, mimeType: "image/png" });
    storageMock.isAllowedMimeType.mockReturnValue(true);

    fakeDb.ticketMessage.create.mockResolvedValue({
      id: "msg-1",
      tenantId: TENANT_ID,
      ticketId: TICKET_ID,
      body: "Hello with attachment",
      visibility: "PUBLIC",
      attachments: [{ id: "att-1", fileName: "photo.png", fileSize: 2048, mimeType: "image/png", createdAt: new Date() }],
    });

    const path = `${TENANT_ID}/${TICKET_ID}/obj-1/photo.png`;
    const input = baseInput([{ path, fileName: "photo.png" }]);

    await createTicketMessage(fakeDb as never, input);

    expect(fakeDb.ticketMessage.create).toHaveBeenCalledTimes(1);
    const createArg = fakeDb.ticketMessage.create.mock.calls[0][0];

    expect(createArg.data.attachments.create).toEqual([
      {
        tenantId: TENANT_ID,
        ticketId: TICKET_ID,
        fileName: "photo.png",
        fileSize: 2048, // จาก getObjectInfo ไม่ใช่จาก client
        mimeType: "image/png", // จาก getObjectInfo ไม่ใช่จาก client
        storageUrl: path,
      },
    ]);
  });
});
