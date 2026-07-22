/**
 * src/app/api/__tests__/webhook-endpoints.test.ts
 * Integration tests สำหรับ /api/webhook-endpoints (GET, POST),
 * /api/webhook-endpoints/:id (PATCH, DELETE) และ /:id/rotate-secret (POST)
 *
 * P1 invariants (docs/webhooks-contract.md § 6, § 7):
 *   - agent-only OWNER/ADMIN — role อื่น/ไม่ใช่ agent → 401/403
 *   - feature webhooks ปิด → 403 FEATURE_LOCKED (และไม่แตะ DB)
 *   - SSRF guard: url ปลายทางต้องห้าม (169.254.169.254 = cloud metadata) → 400 INVALID_WEBHOOK_URL
 *     + message ห้าม leak reason ที่บอกโครงสร้างเครือข่ายภายใน
 *   - `secret` ห้ามหลุด: ไม่อยู่ใน select ของ list, ไม่อยู่ใน response DTO, ไม่อยู่ใน audit
 *   - plaintextSecret คืนครั้งเดียวตอน create/rotate
 *   - endpoint ของ tenant อื่น (tenantPrisma scope → findFirst null) → 404
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { defaultCtx, makeNextRequest } from "@/app/api/__tests__/_helpers";

const { fakeDb, requireAgentMock, hasFeatureMock, auditLogMock } = vi.hoisted(() => {
  const fakeDb = {
    webhookEndpoint: {
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
    hasFeatureMock: vi.fn(),
    auditLogMock: vi.fn(),
  };
});

vi.mock("@/lib/tenant", () => ({
  getTenantContext: vi.fn(),
  tenantPrisma: () => fakeDb,
}));

vi.mock("@/lib/features", () => ({
  hasFeature: (...args: unknown[]) => hasFeatureMock(...args),
  FEATURE_KEYS: { WEBHOOKS: "webhooks" },
}));

vi.mock("@/lib/audit", () => ({
  audit: { log: (...args: unknown[]) => auditLogMock(...args) },
}));

// mock เฉพาะ requireAgent — ใช้ toAuthErrorResponse จริงจาก @/lib/auth
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAgent: (...args: unknown[]) => requireAgentMock(...args),
  };
});

import { GET, POST } from "@/app/api/webhook-endpoints/route";
import { PATCH, DELETE } from "@/app/api/webhook-endpoints/[id]/route";
import { POST as ROTATE } from "@/app/api/webhook-endpoints/[id]/rotate-secret/route";
import { AuthError } from "@/lib/auth";

const SESSION = {
  user: { id: "user-1", name: "Owner" },
  member: { id: "member-1", role: "OWNER", userId: "user-1" },
  ctx: defaultCtx(),
};

const ENDPOINT_ROW = {
  id: "wh-1",
  description: "Ops bot",
  url: "https://hooks.example.com/helpwise",
  events: ["TICKET_CREATED"],
  enabled: true,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAgentMock.mockResolvedValue(SESSION);
  hasFeatureMock.mockResolvedValue(true);
});

describe("GET /api/webhook-endpoints", () => {
  it("ไม่ได้ login เป็น agent (contact/anon) → 401", async () => {
    requireAgentMock.mockRejectedValue(new AuthError("ต้อง login เป็น agent", 401));

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("role AGENT/VIEWER → requireAgent throws 403", async () => {
    requireAgentMock.mockRejectedValue(
      new AuthError("ต้องการสิทธิ์ OWNER หรือ ADMIN เพื่อดำเนินการนี้", 403)
    );

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe("FORBIDDEN");
    expect(fakeDb.webhookEndpoint.findMany).not.toHaveBeenCalled();
  });

  it("feature webhooks ปิด → 403 FEATURE_LOCKED", async () => {
    hasFeatureMock.mockResolvedValue(false);

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe("FEATURE_LOCKED");
    expect(fakeDb.webhookEndpoint.findMany).not.toHaveBeenCalled();
  });

  it("success → คืน endpoints DTO; select ไม่มี secret และ response ไม่มี secret", async () => {
    // จำลอง db ที่ (ถ้าโค้ดพลาด) จะคืน secret ติดมาด้วย — DTO ต้องไม่ปล่อยผ่าน
    fakeDb.webhookEndpoint.findMany.mockResolvedValue([
      { ...ENDPOINT_ROW, secret: "whsec_LEAKED" },
    ]);

    const res = await GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.endpoints).toHaveLength(1);
    expect(json.data.endpoints[0]).not.toHaveProperty("secret");
    expect(JSON.stringify(json)).not.toContain("whsec_");
    expect(json.data.endpoints[0].url).toBe(ENDPOINT_ROW.url);

    const findArg = fakeDb.webhookEndpoint.findMany.mock.calls[0][0];
    expect(findArg.select).not.toHaveProperty("secret");
    expect(findArg.orderBy).toEqual({ createdAt: "desc" });
  });
});

describe("POST /api/webhook-endpoints", () => {
  function makeReq(body: unknown) {
    return makeNextRequest("https://acme.helpwise.com/api/webhook-endpoints", {
      method: "POST",
      body,
    });
  }

  const VALID_BODY = {
    description: "Ops bot",
    url: "https://hooks.example.com/helpwise",
    events: ["TICKET_CREATED"],
  };

  it("role ไม่พอ → 403 และไม่ create", async () => {
    requireAgentMock.mockRejectedValue(new AuthError("ต้องการสิทธิ์ OWNER หรือ ADMIN", 403));

    const res = await POST(makeReq(VALID_BODY));

    expect(res.status).toBe(403);
    expect(fakeDb.webhookEndpoint.create).not.toHaveBeenCalled();
  });

  it("feature ปิด → 403 FEATURE_LOCKED, ไม่ create", async () => {
    hasFeatureMock.mockResolvedValue(false);

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe("FEATURE_LOCKED");
    expect(fakeDb.webhookEndpoint.create).not.toHaveBeenCalled();
  });

  it("events ว่าง → 400 VALIDATION_ERROR", async () => {
    const res = await POST(makeReq({ ...VALID_BODY, events: [] }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  it("event นอก enum → 400 VALIDATION_ERROR", async () => {
    const res = await POST(makeReq({ ...VALID_BODY, events: ["TICKET_EXPLODED"] }));

    expect(res.status).toBe(400);
    expect(fakeDb.webhookEndpoint.create).not.toHaveBeenCalled();
  });

  it("url = cloud metadata (169.254.169.254) → 400 INVALID_WEBHOOK_URL, message ไม่ leak reason", async () => {
    const res = await POST(makeReq({ ...VALID_BODY, url: "https://169.254.169.254/" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("INVALID_WEBHOOK_URL");
    expect(json.error.message).not.toContain("blocked_ip");
    expect(json.error.message).not.toContain("169.254");
    expect(fakeDb.webhookEndpoint.create).not.toHaveBeenCalled();
  });

  it("success → 201 + plaintextSecret ครั้งเดียว; endpoint DTO ไม่มี secret; audit ไม่มี secret", async () => {
    fakeDb.webhookEndpoint.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        ...ENDPOINT_ROW,
        description: data.description,
        url: data.url,
        events: data.events,
      })
    );

    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(typeof json.data.plaintextSecret).toBe("string");
    expect(json.data.plaintextSecret.startsWith("whsec_")).toBe(true);
    expect(json.data.endpoint).not.toHaveProperty("secret");

    // create ต้องเก็บ secret ลง DB + scalar tenantId (ห้าม tenant:{connect})
    const createArg = fakeDb.webhookEndpoint.create.mock.calls[0][0];
    expect(createArg.data.secret).toBe(json.data.plaintextSecret);
    expect(createArg.data.tenantId).toBe(SESSION.ctx.tenantId);
    expect(createArg.data).not.toHaveProperty("tenant");
    expect(createArg.select).not.toHaveProperty("secret");

    // audit after = {description, url, events} เท่านั้น
    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "webhook.endpoint_created",
        after: {
          description: VALID_BODY.description,
          url: VALID_BODY.url,
          events: VALID_BODY.events,
        },
      })
    );
    const auditArg = auditLogMock.mock.calls[0][0];
    expect(JSON.stringify(auditArg)).not.toContain("whsec_");
  });
});

describe("PATCH /api/webhook-endpoints/:id", () => {
  function call(id: string, body: unknown) {
    return PATCH(
      makeNextRequest(`https://acme.helpwise.com/api/webhook-endpoints/${id}`, {
        method: "PATCH",
        body,
      }),
      { params: Promise.resolve({ id }) }
    );
  }

  it("feature ปิด → 403 FEATURE_LOCKED", async () => {
    hasFeatureMock.mockResolvedValue(false);

    const res = await call("wh-1", { enabled: false });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe("FEATURE_LOCKED");
    expect(fakeDb.webhookEndpoint.update).not.toHaveBeenCalled();
  });

  it("body ว่าง (ไม่ระบุ field) → 400 VALIDATION_ERROR", async () => {
    const res = await call("wh-1", {});
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  it("endpoint ของ tenant อื่น (scope ไม่เจอ) → 404 และไม่ update", async () => {
    fakeDb.webhookEndpoint.findFirst.mockResolvedValue(null);

    const res = await call("wh-other-tenant", { enabled: false });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    // ห้ามบอกใบ้ว่ามีอยู่ใน tenant อื่น
    expect(json.error.message).not.toContain("tenant");
    expect(fakeDb.webhookEndpoint.update).not.toHaveBeenCalled();
  });

  it("แก้ url เป็นปลายทางต้องห้าม → 400 INVALID_WEBHOOK_URL (ไม่แตะ DB)", async () => {
    const res = await call("wh-1", { url: "https://169.254.169.254/hook" });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("INVALID_WEBHOOK_URL");
    expect(fakeDb.webhookEndpoint.findFirst).not.toHaveBeenCalled();
    expect(fakeDb.webhookEndpoint.update).not.toHaveBeenCalled();
  });

  it("success → 200 + DTO ไม่มี secret; audit before/after เฉพาะ field ที่เปลี่ยน", async () => {
    fakeDb.webhookEndpoint.findFirst.mockResolvedValue(ENDPOINT_ROW);
    fakeDb.webhookEndpoint.update.mockResolvedValue({
      ...ENDPOINT_ROW,
      description: "Ops bot v2",
      enabled: false,
    });

    const res = await call("wh-1", { description: "Ops bot v2", enabled: false });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.endpoint).not.toHaveProperty("secret");
    expect(json.data.endpoint.description).toBe("Ops bot v2");

    const updateArg = fakeDb.webhookEndpoint.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: "wh-1" });
    expect(updateArg.data).toEqual({ description: "Ops bot v2", enabled: false });
    expect(updateArg.select).not.toHaveProperty("secret");

    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "webhook.endpoint_updated",
        before: { description: ENDPOINT_ROW.description, enabled: true },
        after: { description: "Ops bot v2", enabled: false },
      })
    );
  });
});

describe("DELETE /api/webhook-endpoints/:id", () => {
  function call(id: string) {
    return DELETE(
      makeNextRequest(`https://acme.helpwise.com/api/webhook-endpoints/${id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id }) }
    );
  }

  it("role ไม่พอ → 403", async () => {
    requireAgentMock.mockRejectedValue(new AuthError("ต้องการสิทธิ์ OWNER หรือ ADMIN", 403));

    const res = await call("wh-1");

    expect(res.status).toBe(403);
    expect(fakeDb.webhookEndpoint.delete).not.toHaveBeenCalled();
  });

  it("ไม่เจอใน tenant นี้ → 404 และไม่ลบ", async () => {
    fakeDb.webhookEndpoint.findFirst.mockResolvedValue(null);

    const res = await call("wh-missing");
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(fakeDb.webhookEndpoint.delete).not.toHaveBeenCalled();
  });

  it("success → 200 { deleted: true } + audit (before ไม่มี secret)", async () => {
    fakeDb.webhookEndpoint.findFirst.mockResolvedValue(ENDPOINT_ROW);
    fakeDb.webhookEndpoint.delete.mockResolvedValue({});

    const res = await call("wh-1");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ deleted: true });
    expect(fakeDb.webhookEndpoint.delete.mock.calls[0][0].where).toEqual({ id: "wh-1" });

    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "webhook.endpoint_deleted",
        targetId: "wh-1",
      })
    );
    expect(JSON.stringify(auditLogMock.mock.calls[0][0])).not.toContain("secret");
  });
});

describe("POST /api/webhook-endpoints/:id/rotate-secret", () => {
  function call(id: string) {
    return ROTATE(
      makeNextRequest(
        `https://acme.helpwise.com/api/webhook-endpoints/${id}/rotate-secret`,
        { method: "POST" }
      ),
      { params: Promise.resolve({ id }) }
    );
  }

  it("feature ปิด → 403 FEATURE_LOCKED", async () => {
    hasFeatureMock.mockResolvedValue(false);

    const res = await call("wh-1");
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe("FEATURE_LOCKED");
    expect(fakeDb.webhookEndpoint.update).not.toHaveBeenCalled();
  });

  it("ไม่เจอใน tenant นี้ → 404", async () => {
    fakeDb.webhookEndpoint.findFirst.mockResolvedValue(null);

    const res = await call("wh-other-tenant");
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(fakeDb.webhookEndpoint.update).not.toHaveBeenCalled();
  });

  it("success → 200 + plaintextSecret ใหม่ (เขียนลง DB) แต่ audit ไม่มี secret", async () => {
    fakeDb.webhookEndpoint.findFirst.mockResolvedValue({ id: "wh-1" });
    fakeDb.webhookEndpoint.update.mockResolvedValue({ id: "wh-1" });

    const res = await call("wh-1");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.plaintextSecret.startsWith("whsec_")).toBe(true);

    const updateArg = fakeDb.webhookEndpoint.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: "wh-1" });
    expect(updateArg.data.secret).toBe(json.data.plaintextSecret);

    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "webhook.secret_rotated", targetId: "wh-1" })
    );
    expect(JSON.stringify(auditLogMock.mock.calls[0][0])).not.toContain("whsec_");
  });
});
