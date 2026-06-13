/**
 * src/app/api/__tests__/canned-responses.test.ts
 * Integration tests สำหรับ /api/canned-responses (GET, POST)
 * และ /api/canned-responses/:id (PATCH, DELETE)
 *
 * P1 invariants:
 *   - tenant isolation: cross-tenant (findFirst → null) → 404 NOT_FOUND, ไม่ update/delete
 *   - role gate: VIEWER (requireAgent throw 403) → 403, ไม่ create/update/delete
 *   - POST create ใช้ scalar tenantId: ctx.tenantId + createdByMemberId: member.id
 *   - GET ไม่มี roles arg (member ใดก็อ่านได้), mutations ต้อง roles: ["OWNER","ADMIN","AGENT"]
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultCtx, makeNextRequest } from "@/app/api/__tests__/_helpers";

const { fakeDb, requireAgentMock } = vi.hoisted(() => {
  const fakeDb = {
    cannedResponse: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
  return {
    fakeDb,
    requireAgentMock: vi.fn(),
  };
});

vi.mock("@/lib/tenant", () => ({
  getTenantContext: vi.fn(),
  tenantPrisma: () => fakeDb,
}));

// mock เฉพาะ requireAgent — ใช้ toAuthErrorResponse จริงจาก @/lib/auth
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAgent: (...args: unknown[]) => requireAgentMock(...args),
  };
});

import { GET, POST } from "@/app/api/canned-responses/route";
import { PATCH, DELETE } from "@/app/api/canned-responses/[id]/route";
import { AuthError } from "@/lib/auth";

const SESSION = {
  user: { id: "user-1", name: "Agent" },
  member: { id: "member-1", role: "AGENT", userId: "user-1" },
  ctx: defaultCtx(),
};

const FORBIDDEN = new AuthError("ต้องการสิทธิ์ OWNER, ADMIN หรือ AGENT เพื่อดำเนินการนี้", 403);

beforeEach(() => {
  vi.clearAllMocks();
  requireAgentMock.mockResolvedValue(SESSION);
});

// =============================================================================
// GET /api/canned-responses
// =============================================================================

describe("GET /api/canned-responses", () => {
  it("success → 200 + คืน list, orderBy title, DTO map createdAt → ISO string", async () => {
    fakeDb.cannedResponse.findMany.mockResolvedValue([
      {
        id: "cr-1",
        title: "Welcome",
        body: "Hello there!",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.cannedResponses).toHaveLength(1);
    expect(json.data.cannedResponses[0]).toEqual({
      id: "cr-1",
      title: "Welcome",
      body: "Hello there!",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(fakeDb.cannedResponse.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { title: "asc" } })
    );

    // GET ใช้ requireAgent() ไม่มี roles — member ใดก็อ่านได้
    expect(requireAgentMock).toHaveBeenCalledWith();
  });

  it("requireAgent throw (เช่น ไม่ได้ login) → propagate error code/status", async () => {
    requireAgentMock.mockRejectedValue(new AuthError("Unauthorized", 401));

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.data).toBeNull();
    expect(fakeDb.cannedResponse.findMany).not.toHaveBeenCalled();
  });
});

// =============================================================================
// POST /api/canned-responses
// =============================================================================

describe("POST /api/canned-responses", () => {
  function makeReq(body: unknown) {
    return makeNextRequest("https://acme.helpwise.com/api/canned-responses", {
      method: "POST",
      body,
    });
  }

  it("VIEWER (requireAgent throw 403) → 403, ไม่เรียก create", async () => {
    requireAgentMock.mockRejectedValue(FORBIDDEN);

    const res = await POST(makeReq({ title: "Greeting", body: "Hello" }));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(fakeDb.cannedResponse.create).not.toHaveBeenCalled();

    // assert mutation route เรียก requireAgent ด้วย roles ที่ถูกต้อง
    expect(requireAgentMock).toHaveBeenCalledWith({ roles: ["OWNER", "ADMIN", "AGENT"] });
    expect(json.error.code).toBeDefined();
  });

  it("title ว่าง → 400 VALIDATION_ERROR", async () => {
    const res = await POST(makeReq({ title: "", body: "Hello" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(fakeDb.cannedResponse.create).not.toHaveBeenCalled();
  });

  it("title เกิน 120 ตัวอักษร → 400 VALIDATION_ERROR", async () => {
    const res = await POST(makeReq({ title: "a".repeat(121), body: "Hello" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  it("body ว่าง → 400 VALIDATION_ERROR", async () => {
    const res = await POST(makeReq({ title: "Greeting", body: "" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  it("body เกิน 10000 ตัวอักษร → 400 VALIDATION_ERROR", async () => {
    const res = await POST(makeReq({ title: "Greeting", body: "a".repeat(10001) }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  it("non-JSON body → 400 INVALID_JSON", async () => {
    const rawReq = makeNextRequest("https://acme.helpwise.com/api/canned-responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json{{{",
    });

    const res = await POST(rawReq);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("INVALID_JSON");
  });

  it("success → 201 + create เรียกด้วย scalar tenantId + createdByMemberId, DTO ถูกต้อง", async () => {
    fakeDb.cannedResponse.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "cr-new",
      title: data.title,
      body: data.body,
      createdAt: new Date("2026-02-01T00:00:00Z"),
    }));

    const res = await POST(makeReq({ title: "  Greeting  ", body: "  Hello there  " }));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data.cannedResponse).toEqual({
      id: "cr-new",
      title: "Greeting",
      body: "Hello there",
      createdAt: "2026-02-01T00:00:00.000Z",
    });

    const createArg = fakeDb.cannedResponse.create.mock.calls[0][0];
    expect(createArg.data).toEqual(
      expect.objectContaining({
        tenantId: SESSION.ctx.tenantId,
        createdByMemberId: SESSION.member.id,
        title: "Greeting",
        body: "Hello there",
      })
    );
  });
});

// =============================================================================
// PATCH /api/canned-responses/:id
// =============================================================================

describe("PATCH /api/canned-responses/:id", () => {
  function makeReq(id: string, body: unknown) {
    return {
      req: makeNextRequest(`https://acme.helpwise.com/api/canned-responses/${id}`, {
        method: "PATCH",
        body,
      }),
      params: Promise.resolve({ id }),
    };
  }

  it("cross-tenant: findFirst คืน null → 404 NOT_FOUND, ไม่เรียก update", async () => {
    fakeDb.cannedResponse.findFirst.mockResolvedValue(null);

    const { req, params } = makeReq("cr-other-tenant", { title: "New Title" });
    const res = await PATCH(req, { params });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(fakeDb.cannedResponse.update).not.toHaveBeenCalled();
  });

  it("VIEWER (requireAgent throw 403) → 403", async () => {
    requireAgentMock.mockRejectedValue(FORBIDDEN);

    const { req, params } = makeReq("cr-1", { title: "New Title" });
    const res = await PATCH(req, { params });

    expect(res.status).toBe(403);
    expect(fakeDb.cannedResponse.update).not.toHaveBeenCalled();
    expect(requireAgentMock).toHaveBeenCalledWith({ roles: ["OWNER", "ADMIN", "AGENT"] });
  });

  it("ไม่มี field เลย → 400 VALIDATION_ERROR", async () => {
    fakeDb.cannedResponse.findFirst.mockResolvedValue({
      id: "cr-1",
      title: "Old",
      body: "Old body",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    const { req, params } = makeReq("cr-1", {});
    const res = await PATCH(req, { params });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(fakeDb.cannedResponse.update).not.toHaveBeenCalled();
  });

  it("non-JSON body → 400 INVALID_JSON", async () => {
    const rawReq = makeNextRequest("https://acme.helpwise.com/api/canned-responses/cr-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "not-json{{{",
    });

    const res = await PATCH(rawReq, { params: Promise.resolve({ id: "cr-1" }) });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("INVALID_JSON");
  });

  it("success → 200 + update tenant-scoped, DTO ถูกต้อง", async () => {
    fakeDb.cannedResponse.findFirst.mockResolvedValue({
      id: "cr-1",
      title: "Old",
      body: "Old body",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    fakeDb.cannedResponse.update.mockResolvedValue({
      id: "cr-1",
      title: "New Title",
      body: "Old body",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    const { req, params } = makeReq("cr-1", { title: "New Title" });
    const res = await PATCH(req, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.cannedResponse).toEqual({
      id: "cr-1",
      title: "New Title",
      body: "Old body",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(fakeDb.cannedResponse.findFirst).toHaveBeenCalledWith({ where: { id: "cr-1" } });

    const updateArg = fakeDb.cannedResponse.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: "cr-1" });
    expect(updateArg.data).toEqual({ title: "New Title" });
  });
});

// =============================================================================
// DELETE /api/canned-responses/:id
// =============================================================================

describe("DELETE /api/canned-responses/:id", () => {
  function call(id: string) {
    return DELETE(
      new Request(`https://acme.helpwise.com/api/canned-responses/${id}`) as unknown as Parameters<typeof DELETE>[0],
      { params: Promise.resolve({ id }) }
    );
  }

  it("cross-tenant: findFirst คืน null → 404 NOT_FOUND, ไม่เรียก delete", async () => {
    fakeDb.cannedResponse.findFirst.mockResolvedValue(null);

    const res = await call("cr-other-tenant");
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(fakeDb.cannedResponse.delete).not.toHaveBeenCalled();
  });

  it("VIEWER (requireAgent throw 403) → 403, ไม่เรียก delete", async () => {
    requireAgentMock.mockRejectedValue(FORBIDDEN);

    const res = await call("cr-1");

    expect(res.status).toBe(403);
    expect(fakeDb.cannedResponse.delete).not.toHaveBeenCalled();
    expect(requireAgentMock).toHaveBeenCalledWith({ roles: ["OWNER", "ADMIN", "AGENT"] });
  });

  it("success → 200 { data: { id } }, delete tenant-scoped", async () => {
    fakeDb.cannedResponse.findFirst.mockResolvedValue({
      id: "cr-1",
      title: "Welcome",
      body: "Hello",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    fakeDb.cannedResponse.delete.mockResolvedValue({});

    const res = await call("cr-1");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ id: "cr-1" });

    expect(fakeDb.cannedResponse.findFirst).toHaveBeenCalledWith({ where: { id: "cr-1" } });
    expect(fakeDb.cannedResponse.delete).toHaveBeenCalledWith({ where: { id: "cr-1" } });
  });
});
