/**
 * src/app/api/__tests__/webhook-deliveries.test.ts
 * Integration tests สำหรับ /api/webhook-deliveries (GET) และ /:id/replay (POST)
 *
 * P1 invariants (docs/webhooks-contract.md § 5, § 7):
 *   - agent-only OWNER/ADMIN — ไม่ใช่ agent → 401, role ไม่พอ → 403
 *   - feature webhooks ปิด → 403 FEATURE_LOCKED (ไม่แตะ DB / ไม่ publish job)
 *   - list: ไม่ return `payload` และไม่แตะ endpoint.secret · take clamp ≤ 50 · status นอก enum → 400
 *   - replay: delivery ต่าง tenant → 404 · SUCCEEDED → 409 ALREADY_SUCCEEDED
 *     · rate-limit ต่อ tenant เกิน → 429 RATE_LIMITED (ไม่ publish job)
 *     · success → reset สถานะ + publish job + audit
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import { defaultCtx, makeNextRequest } from "@/app/api/__tests__/_helpers";

const {
  fakeDb,
  requireAgentMock,
  hasFeatureMock,
  auditLogMock,
  publishJobMock,
  checkRateLimitMock,
} = vi.hoisted(() => {
  const fakeDb = {
    webhookDelivery: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  };
  return {
    fakeDb,
    requireAgentMock: vi.fn(),
    hasFeatureMock: vi.fn(),
    auditLogMock: vi.fn(),
    publishJobMock: vi.fn(),
    checkRateLimitMock: vi.fn(),
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

vi.mock("@/lib/queue", () => ({
  publishWebhookDeliveryJob: (...args: unknown[]) => publishJobMock(...args),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  rateLimitKey: (scope: string, id: string) => `ratelimit:${scope}:${id}`,
  rateLimitResponse: (retryAfterSeconds: number) =>
    NextResponse.json(
      { data: null, error: { code: "RATE_LIMITED", message: "คำขอบ่อยเกินไป" } },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
    ),
}));

// mock เฉพาะ requireAgent — ใช้ toAuthErrorResponse จริงจาก @/lib/auth
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAgent: (...args: unknown[]) => requireAgentMock(...args),
  };
});

import { GET } from "@/app/api/webhook-deliveries/route";
import { POST as REPLAY } from "@/app/api/webhook-deliveries/[id]/replay/route";
import { AuthError } from "@/lib/auth";

const SESSION = {
  user: { id: "user-1", name: "Owner" },
  member: { id: "member-1", role: "OWNER", userId: "user-1" },
  ctx: defaultCtx(),
};

const DELIVERY_ROW = {
  id: "dlv-1",
  endpointId: "wh-1",
  eventType: "TICKET_CREATED",
  eventId: "evt-1",
  status: "DEAD",
  attemptCount: 5,
  lastAttemptAt: new Date("2026-01-02T00:00:00Z"),
  responseStatus: 500,
  responseBody: "upstream error",
  errorMessage: "http_500",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  requireAgentMock.mockResolvedValue(SESSION);
  hasFeatureMock.mockResolvedValue(true);
  checkRateLimitMock.mockResolvedValue({ allowed: true, remaining: 29, retryAfterSeconds: 0 });
});

describe("GET /api/webhook-deliveries", () => {
  function call(query = "") {
    return GET(
      makeNextRequest(`https://acme.helpwise.com/api/webhook-deliveries${query}`)
    );
  }

  it("ไม่ได้ login เป็น agent (contact/anon) → 401", async () => {
    requireAgentMock.mockRejectedValue(new AuthError("ต้อง login เป็น agent", 401));

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe("UNAUTHORIZED");
  });

  it("role AGENT/VIEWER → 403", async () => {
    requireAgentMock.mockRejectedValue(
      new AuthError("ต้องการสิทธิ์ OWNER หรือ ADMIN เพื่อดำเนินการนี้", 403)
    );

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe("FORBIDDEN");
    expect(fakeDb.webhookDelivery.findMany).not.toHaveBeenCalled();
  });

  it("feature webhooks ปิด → 403 FEATURE_LOCKED", async () => {
    hasFeatureMock.mockResolvedValue(false);

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe("FEATURE_LOCKED");
    expect(fakeDb.webhookDelivery.findMany).not.toHaveBeenCalled();
  });

  it("status นอก enum → 400 VALIDATION_ERROR", async () => {
    const res = await call("?status=EXPLODED");
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("VALIDATION_ERROR");
    expect(fakeDb.webhookDelivery.findMany).not.toHaveBeenCalled();
  });

  it("default take = 25 และไม่มี filter เมื่อไม่ส่ง query", async () => {
    fakeDb.webhookDelivery.findMany.mockResolvedValue([]);

    const res = await call();

    expect(res.status).toBe(200);
    const arg = fakeDb.webhookDelivery.findMany.mock.calls[0][0];
    expect(arg.take).toBe(25);
    expect(arg.where).toEqual({});
    expect(arg.orderBy).toEqual({ createdAt: "desc" });
  });

  it("take เกิน 50 → clamp เหลือ 50", async () => {
    fakeDb.webhookDelivery.findMany.mockResolvedValue([]);

    await call("?take=500");

    expect(fakeDb.webhookDelivery.findMany.mock.calls[0][0].take).toBe(50);
  });

  it("filter endpointId + status=DEAD (DLQ view) ถูกส่งเข้า where", async () => {
    fakeDb.webhookDelivery.findMany.mockResolvedValue([]);

    await call("?endpointId=wh-1&status=DEAD");

    expect(fakeDb.webhookDelivery.findMany.mock.calls[0][0].where).toEqual({
      endpointId: "wh-1",
      status: "DEAD",
    });
  });

  it("success → DTO ไม่มี payload / secret และ select ไม่ดึง payload หรือ endpoint", async () => {
    // จำลอง db ที่คืน payload/secret ติดมา — DTO ต้องไม่ปล่อยผ่าน
    fakeDb.webhookDelivery.findMany.mockResolvedValue([
      {
        ...DELIVERY_ROW,
        payload: { id: "evt-1", data: { message: { body: "ความลับของลูกค้า" } } },
        endpoint: { secret: "whsec_LEAKED" },
      },
    ]);

    const res = await call();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.deliveries).toHaveLength(1);
    expect(json.data.deliveries[0]).not.toHaveProperty("payload");
    expect(json.data.deliveries[0]).not.toHaveProperty("endpoint");
    expect(JSON.stringify(json)).not.toContain("whsec_");
    expect(JSON.stringify(json)).not.toContain("ความลับของลูกค้า");
    expect(json.data.deliveries[0].status).toBe("DEAD");
    expect(json.data.deliveries[0].attemptCount).toBe(5);

    const selectArg = fakeDb.webhookDelivery.findMany.mock.calls[0][0].select;
    expect(selectArg).not.toHaveProperty("payload");
    expect(selectArg).not.toHaveProperty("endpoint");
    expect(selectArg).not.toHaveProperty("secret");
  });
});

describe("POST /api/webhook-deliveries/:id/replay", () => {
  function call(id: string) {
    return REPLAY(
      makeNextRequest(
        `https://acme.helpwise.com/api/webhook-deliveries/${id}/replay`,
        { method: "POST" }
      ),
      { params: Promise.resolve({ id }) }
    );
  }

  it("role ไม่พอ → 403 และไม่ publish job", async () => {
    requireAgentMock.mockRejectedValue(new AuthError("ต้องการสิทธิ์ OWNER หรือ ADMIN", 403));

    const res = await call("dlv-1");

    expect(res.status).toBe(403);
    expect(publishJobMock).not.toHaveBeenCalled();
  });

  it("feature ปิด → 403 FEATURE_LOCKED และไม่ publish job", async () => {
    hasFeatureMock.mockResolvedValue(false);

    const res = await call("dlv-1");
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error.code).toBe("FEATURE_LOCKED");
    expect(fakeDb.webhookDelivery.update).not.toHaveBeenCalled();
    expect(publishJobMock).not.toHaveBeenCalled();
  });

  it("rate-limit เกิน → 429 RATE_LIMITED, ไม่ update และไม่ publish job", async () => {
    checkRateLimitMock.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 120 });
    fakeDb.webhookDelivery.findFirst.mockResolvedValue({ id: "dlv-1", status: "DEAD" });

    const res = await call("dlv-1");
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(fakeDb.webhookDelivery.update).not.toHaveBeenCalled();
    expect(publishJobMock).not.toHaveBeenCalled();
    // key ต้อง scope ด้วย tenantId (ไม่ใช่ global counter)
    expect(checkRateLimitMock.mock.calls[0][0].key).toContain(SESSION.ctx.tenantId);
  });

  it("delivery ของ tenant อื่น (scope ไม่เจอ) → 404", async () => {
    fakeDb.webhookDelivery.findFirst.mockResolvedValue(null);

    const res = await call("dlv-other-tenant");
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(json.error.message).not.toContain("tenant");
    expect(publishJobMock).not.toHaveBeenCalled();
  });

  it("delivery ที่ SUCCEEDED แล้ว → 409 ALREADY_SUCCEEDED (ไม่ยิงซ้ำ)", async () => {
    fakeDb.webhookDelivery.findFirst.mockResolvedValue({
      id: "dlv-1",
      status: "SUCCEEDED",
    });

    const res = await call("dlv-1");
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe("ALREADY_SUCCEEDED");
    expect(fakeDb.webhookDelivery.update).not.toHaveBeenCalled();
    expect(publishJobMock).not.toHaveBeenCalled();
  });

  it("success (DEAD → replay) → reset สถานะ + publish job + audit + 200", async () => {
    fakeDb.webhookDelivery.findFirst.mockResolvedValue({ id: "dlv-1", status: "DEAD" });
    fakeDb.webhookDelivery.update.mockResolvedValue({ id: "dlv-1" });

    const res = await call("dlv-1");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ replayed: true });

    const updateArg = fakeDb.webhookDelivery.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: "dlv-1" });
    expect(updateArg.data).toEqual({
      status: "PENDING",
      attemptCount: 0,
      errorMessage: null,
      responseStatus: null,
      responseBody: null,
    });

    // tenantId มาจาก session context เท่านั้น (ไม่ใช่ client)
    expect(publishJobMock).toHaveBeenCalledWith({
      tenantId: SESSION.ctx.tenantId,
      deliveryId: "dlv-1",
    });

    expect(auditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "webhook.delivery_replayed",
        targetId: "dlv-1",
      })
    );
  });
});
