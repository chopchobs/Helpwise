/**
 * src/app/api/__tests__/tags.test.ts
 * Integration tests สำหรับ Phase 26 (Tags/Labels)
 *
 * Endpoints ที่ครอบ:
 *   - GET  /api/tags                       — list catalog (ทุก role)
 *   - POST /api/tags                       — สร้าง tag (OWNER/ADMIN เท่านั้น)
 *   - PATCH  /api/tags/:id                 — แก้ไข tag (OWNER/ADMIN เท่านั้น)
 *   - DELETE /api/tags/:id                 — ลบ tag   (OWNER/ADMIN เท่านั้น)
 *   - POST /api/tickets/:id/tags           — apply tag บน ticket (OWNER/ADMIN/AGENT)
 *   - DELETE /api/tickets/:id/tags/:tagId  — remove tag ออกจาก ticket
 *   - GET /api/tickets?tagId=...           — tag filter (match-any)
 *
 * P0 invariants:
 *   - tenant isolation: tag ของ tenant อื่น (findFirst → null) → 404 TAG_NOT_FOUND (cross-tenant spoof)
 *   - role gate: POST/PATCH/DELETE /api/tags → OWNER/ADMIN เท่านั้น
 *   - internal-note isolation: tag เป็น agent-only ห้ามหลุด portal
 *   - idempotent: apply tag P2002 → 200 (ไม่ 500); remove tag count 0 → 200
 *   - audit: apply + remove → audit.log ถูกเรียก
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { defaultCtx, DEFAULT_TENANT_ID, makeNextRequest } from "@/app/api/__tests__/_helpers";

// =============================================================================
// vi.hoisted — ต้องประกาศ fakeDb + mocks ที่นี่เพราะ vi.mock factory hoisted
// =============================================================================

const { fakeDb, requireAgentMock, auditLogMock } = vi.hoisted(() => {
  const fakeDb = {
    tag: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    ticketTag: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    ticket: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  };

  return {
    fakeDb,
    requireAgentMock: vi.fn(),
    auditLogMock: vi.fn(),
  };
});

vi.mock("@/lib/tenant", () => ({
  getTenantContext: vi.fn(),
  tenantPrisma: () => fakeDb,
}));

// mock requireAgent เท่านั้น — ใช้ toAuthErrorResponse จริงจาก @/lib/auth
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

// =============================================================================
// imports — หลัง mock declarations
// =============================================================================

import { GET as listTags, POST as createTag } from "@/app/api/tags/route";
import { PATCH as patchTag, DELETE as deleteTag } from "@/app/api/tags/[id]/route";
import { POST as applyTag } from "@/app/api/tickets/[id]/tags/route";
import { DELETE as removeTag } from "@/app/api/tickets/[id]/tags/[tagId]/route";
import { GET as listTickets } from "@/app/api/tickets/route";
import { AuthError } from "@/lib/auth";

// =============================================================================
// ข้อมูลตัวอย่าง
// =============================================================================

const SESSION_OWNER = {
  user: { id: "user-1", name: "Owner" },
  member: { id: "member-1", role: "OWNER", userId: "user-1" },
  ctx: defaultCtx(),
};

const SESSION_AGENT = {
  user: { id: "user-2", name: "Agent" },
  member: { id: "member-2", role: "AGENT", userId: "user-2" },
  ctx: defaultCtx(),
};

const FORBIDDEN_VIEWER = new AuthError(
  "ต้องการสิทธิ์ OWNER หรือ ADMIN เพื่อดำเนินการนี้",
  403
);

const FORBIDDEN_AGENT = new AuthError(
  "ต้องการสิทธิ์ OWNER, ADMIN หรือ AGENT เพื่อดำเนินการนี้",
  403
);

const SAMPLE_TAG = {
  id: "tag-1",
  name: "Billing",
  color: "TERRACOTTA" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAgentMock.mockResolvedValue(SESSION_OWNER);
});

// =============================================================================
// GET /api/tags — list tag catalog
// =============================================================================

describe("GET /api/tags", () => {
  it("success → 200 + คืน list เรียง name asc, DTO ถูกต้อง", async () => {
    fakeDb.tag.findMany.mockResolvedValue([SAMPLE_TAG]);

    const res = await listTags();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.tags).toHaveLength(1);
    expect(json.data.tags[0]).toEqual({
      id: "tag-1",
      name: "Billing",
      color: "TERRACOTTA",
    });
    expect(fakeDb.tag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { name: "asc" } })
    );
    // GET ทุก role อ่านได้ — requireAgent() ไม่มี roles arg
    expect(requireAgentMock).toHaveBeenCalledWith();
  });

  it("คืน list ว่าง → 200 + tags = []", async () => {
    fakeDb.tag.findMany.mockResolvedValue([]);

    const res = await listTags();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.tags).toEqual([]);
  });

  it("requireAgent throw 401 (ไม่ได้ login) → propagate 401", async () => {
    requireAgentMock.mockRejectedValue(new AuthError("Unauthorized", 401));

    const res = await listTags();
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.data).toBeNull();
    expect(fakeDb.tag.findMany).not.toHaveBeenCalled();
  });
});

// =============================================================================
// POST /api/tags — สร้าง tag ใหม่
// =============================================================================

describe("POST /api/tags", () => {
  function makeReq(body: unknown) {
    return makeNextRequest("https://acme.helpwise.com/api/tags", {
      method: "POST",
      body,
    });
  }

  it("AGENT/VIEWER → 403 (OWNER/ADMIN เท่านั้น)", async () => {
    requireAgentMock.mockRejectedValue(FORBIDDEN_VIEWER);

    const res = await createTag(makeReq({ name: "Bug", color: "SIENNA" }));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(fakeDb.tag.create).not.toHaveBeenCalled();
    expect(requireAgentMock).toHaveBeenCalledWith({ roles: ["OWNER", "ADMIN"] });
    expect(json.error.code).toBeDefined();
  });

  it("OWNER POST tag สำเร็จ → 201 + DTO ถูกต้อง + scalar tenantId", async () => {
    fakeDb.tag.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "tag-new",
      name: data.name,
      color: data.color,
    }));

    const res = await createTag(makeReq({ name: "  Billing  ", color: "TERRACOTTA" }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data.tag).toEqual({
      id: "tag-new",
      name: "Billing",
      color: "TERRACOTTA",
    });

    const createArg = fakeDb.tag.create.mock.calls[0][0];
    expect(createArg.data).toEqual(
      expect.objectContaining({
        tenantId: DEFAULT_TENANT_ID,
        name: "Billing",
        color: "TERRACOTTA",
      })
    );
  });

  it("name ซ้ำใน tenant (P2002) → 409 TAG_NAME_EXISTS", async () => {
    fakeDb.tag.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "x",
      })
    );

    const res = await createTag(makeReq({ name: "Billing", color: "TERRACOTTA" }));
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe("TAG_NAME_EXISTS");
  });

  it("name ว่าง → 400 VALIDATION_ERROR", async () => {
    const res = await createTag(makeReq({ name: "", color: "GRAY" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(fakeDb.tag.create).not.toHaveBeenCalled();
  });

  it("name เกิน 50 ตัวอักษร → 400 VALIDATION_ERROR", async () => {
    const res = await createTag(makeReq({ name: "a".repeat(51), color: "GRAY" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  it("color ไม่ใช่ enum ที่รองรับ → 400 VALIDATION_ERROR", async () => {
    const res = await createTag(makeReq({ name: "Bug", color: "PURPLE" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(fakeDb.tag.create).not.toHaveBeenCalled();
  });

  it("non-JSON body → 400 INVALID_JSON", async () => {
    const rawReq = makeNextRequest("https://acme.helpwise.com/api/tags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json{{{",
    });

    const res = await createTag(rawReq);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("INVALID_JSON");
  });
});

// =============================================================================
// PATCH /api/tags/:id — แก้ไข tag
// =============================================================================

describe("PATCH /api/tags/:id", () => {
  function makeReq(id: string, body: unknown) {
    return {
      req: makeNextRequest(`https://acme.helpwise.com/api/tags/${id}`, {
        method: "PATCH",
        body,
      }),
      params: Promise.resolve({ id }),
    };
  }

  it("AGENT/VIEWER → 403, ไม่เรียก update", async () => {
    requireAgentMock.mockRejectedValue(FORBIDDEN_VIEWER);

    const { req, params } = makeReq("tag-1", { name: "Renamed" });
    const res = await patchTag(req, { params });

    expect(res.status).toBe(403);
    expect(fakeDb.tag.update).not.toHaveBeenCalled();
    expect(requireAgentMock).toHaveBeenCalledWith({ roles: ["OWNER", "ADMIN"] });
  });

  it("tag ไม่พบ (findFirst null) → 404 NOT_FOUND, ไม่เรียก update", async () => {
    fakeDb.tag.findFirst.mockResolvedValue(null);

    const { req, params } = makeReq("tag-ghost", { name: "Ghost" });
    const res = await patchTag(req, { params });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(fakeDb.tag.update).not.toHaveBeenCalled();
  });

  it("cross-tenant: tag ของ tenant อื่น (findFirst null) → 404 NOT_FOUND", async () => {
    // tenantPrisma inject tenantId อัตโนมัติ → ค้นหา tag ของ tenant อื่นเจอ null เสมอ
    fakeDb.tag.findFirst.mockResolvedValue(null);

    const { req, params } = makeReq("tag-other-tenant", { color: "SAGE" });
    const res = await patchTag(req, { params });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(fakeDb.tag.update).not.toHaveBeenCalled();
  });

  it("body ว่าง (ไม่มี field) → 400 VALIDATION_ERROR", async () => {
    fakeDb.tag.findFirst.mockResolvedValue(SAMPLE_TAG);

    const { req, params } = makeReq("tag-1", {});
    const res = await patchTag(req, { params });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(fakeDb.tag.update).not.toHaveBeenCalled();
  });

  it("non-JSON body → 400 INVALID_JSON", async () => {
    const rawReq = makeNextRequest("https://acme.helpwise.com/api/tags/tag-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not-json{{{",
    });

    const res = await patchTag(rawReq, { params: Promise.resolve({ id: "tag-1" }) });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("INVALID_JSON");
  });

  it("success update name → 200 + DTO ถูกต้อง", async () => {
    fakeDb.tag.findFirst.mockResolvedValue(SAMPLE_TAG);
    fakeDb.tag.update.mockResolvedValue({ id: "tag-1", name: "Payments", color: "TERRACOTTA" });

    const { req, params } = makeReq("tag-1", { name: "Payments" });
    const res = await patchTag(req, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.tag).toEqual({ id: "tag-1", name: "Payments", color: "TERRACOTTA" });

    expect(fakeDb.tag.findFirst).toHaveBeenCalledWith({ where: { id: "tag-1" } });
    const updateArg = fakeDb.tag.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: "tag-1" });
    expect(updateArg.data).toEqual({ name: "Payments" });
  });

  it("success update color เท่านั้น → 200", async () => {
    fakeDb.tag.findFirst.mockResolvedValue(SAMPLE_TAG);
    fakeDb.tag.update.mockResolvedValue({ id: "tag-1", name: "Billing", color: "SAGE" });

    const { req, params } = makeReq("tag-1", { color: "SAGE" });
    const res = await patchTag(req, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.tag.color).toBe("SAGE");

    const updateArg = fakeDb.tag.update.mock.calls[0][0];
    expect(updateArg.data).toEqual({ color: "SAGE" });
  });

  it("name ซ้ำ (PATCH throw P2002) → 409 TAG_NAME_EXISTS", async () => {
    fakeDb.tag.findFirst.mockResolvedValue(SAMPLE_TAG);
    fakeDb.tag.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "x",
      })
    );

    const { req, params } = makeReq("tag-1", { name: "Existing Name" });
    const res = await patchTag(req, { params });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe("TAG_NAME_EXISTS");
  });
});

// =============================================================================
// DELETE /api/tags/:id — ลบ tag
// =============================================================================

describe("DELETE /api/tags/:id", () => {
  function call(id: string) {
    return deleteTag(
      new Request(`https://acme.helpwise.com/api/tags/${id}`) as unknown as Parameters<typeof deleteTag>[0],
      { params: Promise.resolve({ id }) }
    );
  }

  it("AGENT/VIEWER → 403, ไม่เรียก delete", async () => {
    requireAgentMock.mockRejectedValue(FORBIDDEN_VIEWER);

    const res = await call("tag-1");

    expect(res.status).toBe(403);
    expect(fakeDb.tag.delete).not.toHaveBeenCalled();
    expect(requireAgentMock).toHaveBeenCalledWith({ roles: ["OWNER", "ADMIN"] });
  });

  it("tag ไม่พบ (findFirst null) → 404 NOT_FOUND, ไม่เรียก delete", async () => {
    fakeDb.tag.findFirst.mockResolvedValue(null);

    const res = await call("tag-ghost");
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(fakeDb.tag.delete).not.toHaveBeenCalled();
  });

  it("cross-tenant: tag ของ tenant อื่น (findFirst null) → 404 NOT_FOUND", async () => {
    fakeDb.tag.findFirst.mockResolvedValue(null);

    const res = await call("tag-other-tenant");
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(fakeDb.tag.delete).not.toHaveBeenCalled();
  });

  it("success → 200 + { data: { id } } + delete tenant-scoped", async () => {
    fakeDb.tag.findFirst.mockResolvedValue(SAMPLE_TAG);
    fakeDb.tag.delete.mockResolvedValue({});

    const res = await call("tag-1");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ id: "tag-1" });

    expect(fakeDb.tag.findFirst).toHaveBeenCalledWith({ where: { id: "tag-1" } });
    expect(fakeDb.tag.delete).toHaveBeenCalledWith({ where: { id: "tag-1" } });
  });
});

// =============================================================================
// POST /api/tickets/:id/tags — apply tag บน ticket
// =============================================================================

describe("POST /api/tickets/:id/tags — apply tag", () => {
  function makeReq(ticketId: string, body: unknown) {
    return {
      req: makeNextRequest(`https://acme.helpwise.com/api/tickets/${ticketId}/tags`, {
        method: "POST",
        body,
      }),
      params: Promise.resolve({ id: ticketId }),
    };
  }

  it("VIEWER → 403, ไม่เรียก ticket/tag lookup", async () => {
    requireAgentMock.mockRejectedValue(FORBIDDEN_AGENT);

    const { req, params } = makeReq("ticket-1", { tagId: "tag-1" });
    const res = await applyTag(req, { params });

    expect(res.status).toBe(403);
    expect(fakeDb.ticket.findFirst).not.toHaveBeenCalled();
    expect(fakeDb.ticketTag.create).not.toHaveBeenCalled();
    expect(requireAgentMock).toHaveBeenCalledWith({ roles: ["OWNER", "ADMIN", "AGENT"] });
  });

  it("ticket ไม่พบใน tenant → 404 NOT_FOUND", async () => {
    requireAgentMock.mockResolvedValue(SESSION_AGENT);
    fakeDb.ticket.findFirst.mockResolvedValue(null);

    const { req, params } = makeReq("ticket-ghost", { tagId: "tag-1" });
    const res = await applyTag(req, { params });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(fakeDb.ticketTag.create).not.toHaveBeenCalled();
  });

  it("🔴 cross-tenant tag spoof: tagId ของ tenant อื่น (tag.findFirst null) → 404 TAG_NOT_FOUND", async () => {
    // นี่คือ invariant สำคัญที่สุด:
    // tenant-A ส่ง tagId ที่เป็นของ tenant-B → tenantPrisma inject tenantId → tag.findFirst คืน null
    // ห้ามสร้าง TicketTag ที่เชื่อม cross-tenant tag โดยเด็ดขาด
    requireAgentMock.mockResolvedValue(SESSION_AGENT);
    fakeDb.ticket.findFirst.mockResolvedValue({ id: "ticket-1" });
    fakeDb.tag.findFirst.mockResolvedValue(null); // tag ไม่อยู่ใน tenant นี้

    const { req, params } = makeReq("ticket-1", { tagId: "tag-from-other-tenant" });
    const res = await applyTag(req, { params });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("TAG_NOT_FOUND");
    expect(fakeDb.ticketTag.create).not.toHaveBeenCalled();
    expect(auditLogMock).not.toHaveBeenCalled();
  });

  it("happy path → 201 + DTO + audit.log(ticket.tag_added) ถูกเรียก", async () => {
    requireAgentMock.mockResolvedValue(SESSION_AGENT);
    fakeDb.ticket.findFirst.mockResolvedValue({ id: "ticket-1" });
    fakeDb.tag.findFirst.mockResolvedValue(SAMPLE_TAG);
    fakeDb.ticketTag.create.mockResolvedValue({});

    const { req, params } = makeReq("ticket-1", { tagId: "tag-1" });
    const res = await applyTag(req, { params });
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data.tag).toEqual({
      id: "tag-1",
      name: "Billing",
      color: "TERRACOTTA",
    });

    // ตรวจ ticketTag.create เรียกด้วย scalar fields (ห้าม connect)
    expect(fakeDb.ticketTag.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: DEFAULT_TENANT_ID,
          ticketId: "ticket-1",
          tagId: "tag-1",
        }),
      })
    );

    // ตรวจ audit.log ถูกเรียกด้วย action ถูกต้อง
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ticket.tag_added",
        tenantId: DEFAULT_TENANT_ID,
        targetId: "ticket-1",
        metadata: expect.objectContaining({ tagId: "tag-1", tagName: "Billing" }),
      })
    );
  });

  it("idempotent: ticketTag.create throw P2002 (tag ติดอยู่แล้ว) → 200 ไม่ใช่ 500", async () => {
    requireAgentMock.mockResolvedValue(SESSION_AGENT);
    fakeDb.ticket.findFirst.mockResolvedValue({ id: "ticket-1" });
    fakeDb.tag.findFirst.mockResolvedValue(SAMPLE_TAG);
    fakeDb.ticketTag.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "x",
      })
    );

    const { req, params } = makeReq("ticket-1", { tagId: "tag-1" });
    const res = await applyTag(req, { params });
    const json = await res.json();

    // idempotent — คืน 200 พร้อม tag DTO ปกติ (ไม่ 500)
    expect(res.status).toBe(200);
    expect(json.data.tag).toEqual({
      id: "tag-1",
      name: "Billing",
      color: "TERRACOTTA",
    });
  });

  it("tagId ว่าง → 400 VALIDATION_ERROR", async () => {
    requireAgentMock.mockResolvedValue(SESSION_AGENT);

    const { req, params } = makeReq("ticket-1", { tagId: "" });
    const res = await applyTag(req, { params });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(fakeDb.ticket.findFirst).not.toHaveBeenCalled();
  });

  it("non-JSON body → 400 INVALID_JSON", async () => {
    const rawReq = makeNextRequest("https://acme.helpwise.com/api/tickets/ticket-1/tags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json{{{",
    });

    const res = await applyTag(rawReq, { params: Promise.resolve({ id: "ticket-1" }) });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("INVALID_JSON");
  });
});

// =============================================================================
// DELETE /api/tickets/:id/tags/:tagId — remove tag ออกจาก ticket
// =============================================================================

describe("DELETE /api/tickets/:id/tags/:tagId — remove tag", () => {
  function call(ticketId: string, tagId: string) {
    return removeTag(
      new Request(
        `https://acme.helpwise.com/api/tickets/${ticketId}/tags/${tagId}`
      ) as unknown as Parameters<typeof removeTag>[0],
      { params: Promise.resolve({ id: ticketId, tagId }) }
    );
  }

  it("VIEWER → 403, ไม่เรียก deleteMany", async () => {
    requireAgentMock.mockRejectedValue(FORBIDDEN_AGENT);

    const res = await call("ticket-1", "tag-1");

    expect(res.status).toBe(403);
    expect(fakeDb.ticketTag.deleteMany).not.toHaveBeenCalled();
  });

  it("ticket ไม่พบใน tenant → 404 NOT_FOUND", async () => {
    fakeDb.ticket.findFirst.mockResolvedValue(null);

    const res = await call("ticket-ghost", "tag-1");
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(fakeDb.ticketTag.deleteMany).not.toHaveBeenCalled();
  });

  it("happy path: tag ติดอยู่ → 200 + { data: { tagId } } + audit.log(ticket.tag_removed)", async () => {
    fakeDb.ticket.findFirst.mockResolvedValue({ id: "ticket-1" });
    fakeDb.tag.findFirst.mockResolvedValue({ id: "tag-1", name: "Billing" });
    fakeDb.ticketTag.deleteMany.mockResolvedValue({ count: 1 });

    const res = await call("ticket-1", "tag-1");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ tagId: "tag-1" });

    expect(fakeDb.ticketTag.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ticketId: "ticket-1", tagId: "tag-1" }),
      })
    );

    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ticket.tag_removed",
        tenantId: DEFAULT_TENANT_ID,
        targetId: "ticket-1",
        metadata: expect.objectContaining({ tagId: "tag-1", tagName: "Billing" }),
      })
    );
  });

  it("idempotent: TicketTag ไม่มีอยู่ (deleteMany count 0) → 200 (ไม่ error)", async () => {
    fakeDb.ticket.findFirst.mockResolvedValue({ id: "ticket-1" });
    fakeDb.tag.findFirst.mockResolvedValue(null); // tag อาจถูกลบออกจาก catalog แล้ว
    fakeDb.ticketTag.deleteMany.mockResolvedValue({ count: 0 });

    const res = await call("ticket-1", "tag-already-removed");
    const json = await res.json();

    // idempotent — 200 เสมอ แม้ tag ไม่ได้ติดอยู่
    expect(res.status).toBe(200);
    expect(json.data.tagId).toBe("tag-already-removed");

    // tag ไม่มีอยู่ → audit.log ไม่ถูกเรียก (route เช็ค if(tag) ก่อน log)
    expect(auditLogMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// GET /api/tickets — tag filter (multi-value tagId, match-any)
// =============================================================================

describe("GET /api/tickets — tag filter", () => {
  const TICKET_WITH_TAGS = {
    id: "ticket-1",
    ticketNumber: 1,
    subject: "Help needed",
    status: "OPEN",
    priority: "NORMAL",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    firstResponseDueAt: null,
    resolutionDueAt: null,
    firstRespondedAt: null,
    resolvedAt: null,
    firstResponseBreached: false,
    resolutionBreached: false,
    slaPausedAt: null,
    requesterContact: { id: "contact-1", name: "Alice", email: "alice@example.com", avatarUrl: null },
    assignee: null,
    _count: { messages: 0 },
    csat: null,
    ticketTags: [
      { tag: { id: "tag-1", name: "Billing", color: "TERRACOTTA" } },
    ],
  };

  beforeEach(() => {
    requireAgentMock.mockResolvedValue(SESSION_OWNER);
    fakeDb.ticket.findMany.mockResolvedValue([TICKET_WITH_TAGS]);
    fakeDb.ticket.count.mockResolvedValue(1);
  });

  it("?tagId=a&tagId=b → where มี ticketTags.some.tagId.in = [a,b] (match-any)", async () => {
    // ใช้ makeNextRequest เพราะ GET /api/tickets เข้าถึง request.nextUrl.searchParams
    const req = makeNextRequest(
      "https://acme.helpwise.com/api/tickets?tagId=tag-1&tagId=tag-2"
    );

    const res = await listTickets(req);
    const json = await res.json();

    expect(res.status).toBe(200);

    // ตรวจ where ที่ส่งเข้า ticket.findMany มี ticketTags filter
    const findManyCall = fakeDb.ticket.findMany.mock.calls[0][0];
    expect(findManyCall.where).toMatchObject({
      ticketTags: { some: { tagId: { in: ["tag-1", "tag-2"] } } },
    });
  });

  it("?tagId=tag-1 (single) → where มี ticketTags.some.tagId.in = ['tag-1']", async () => {
    const req = makeNextRequest("https://acme.helpwise.com/api/tickets?tagId=tag-1");

    const res = await listTickets(req);

    expect(res.status).toBe(200);

    const findManyCall = fakeDb.ticket.findMany.mock.calls[0][0];
    expect(findManyCall.where).toMatchObject({
      ticketTags: { some: { tagId: { in: ["tag-1"] } } },
    });
  });

  it("ไม่ส่ง tagId → where ไม่มี ticketTags filter", async () => {
    const req = makeNextRequest("https://acme.helpwise.com/api/tickets");

    const res = await listTickets(req);
    const json = await res.json();

    expect(res.status).toBe(200);

    const findManyCall = fakeDb.ticket.findMany.mock.calls[0][0];
    expect(findManyCall.where).not.toHaveProperty("ticketTags");
  });

  it("response DTO มี tags array จาก ticketTags relation", async () => {
    const req = makeNextRequest("https://acme.helpwise.com/api/tickets?tagId=tag-1");

    const res = await listTickets(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    const ticket = json.data.tickets[0];
    expect(ticket.tags).toEqual([
      { id: "tag-1", name: "Billing", color: "TERRACOTTA" },
    ]);
  });

  it("?tagId=a,b (comma-separated) — split ถูกต้องเป็น ['tag-1','tag-2']", async () => {
    // transform flatMap split comma ทุก element → getAll คืน ["tag-1,tag-2"] ก็ split ได้
    const req = makeNextRequest("https://acme.helpwise.com/api/tickets?tagId=tag-1,tag-2");

    const res = await listTickets(req);

    expect(res.status).toBe(200);

    const findManyCall = fakeDb.ticket.findMany.mock.calls[0][0];
    expect(findManyCall.where).toMatchObject({
      ticketTags: { some: { tagId: { in: ["tag-1", "tag-2"] } } },
    });
  });
});
