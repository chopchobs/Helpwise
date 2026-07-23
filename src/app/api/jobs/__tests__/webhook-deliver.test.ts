/**
 * src/app/api/jobs/__tests__/webhook-deliver.test.ts
 * Integration tests สำหรับ POST /api/jobs/webhook-deliver (QStash worker, Phase 36 Slice 2a)
 *
 * P0 invariants:
 *   - signature invalid → 401 (verify ก่อนทำงานใด ๆ)
 *   - tenant scope: ทุก query ผ่าน tenantPrisma(tenantId จาก verified payload)
 *   - internal-note isolation: payload message ไม่ใช่ PUBLIC → DEAD + ไม่ยิง fetch
 *   - SSRF: assertSafeDestination ไม่ผ่าน → DEAD + ไม่ยิง fetch (ไม่ retry)
 *   - idempotent: SUCCEEDED/DEAD → skip 200
 *   - retry semantics § 5: fail + attempt<MAX → FAILED/500, attempt=MAX → DEAD/200
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { fakeDb, tenantPrismaMock, verifyMock, safeDestinationMock, fetchMock } =
  vi.hoisted(() => {
    const fakeDb = {
      webhookDelivery: { findFirst: vi.fn(), update: vi.fn() },
    };
    return {
      fakeDb,
      tenantPrismaMock: vi.fn((tenantId: string): typeof fakeDb => {
        void tenantId; // บันทึก arg ไว้ assert tenant scope
        return fakeDb;
      }),
      verifyMock: vi.fn(),
      safeDestinationMock: vi.fn(),
      fetchMock: vi.fn(),
    };
  });

vi.mock("@/lib/tenant", () => ({
  tenantPrisma: (tenantId: string) => tenantPrismaMock(tenantId),
}));

vi.mock("@/lib/queue", () => ({
  verifyQStashSignature: (req: unknown, url?: string) => verifyMock(req, url),
  getJobTargetUrl: (path: string) => `https://worker.helpwise.com${path}`,
  WEBHOOK_DELIVER_WORKER_PATH: "/api/jobs/webhook-deliver",
}));

// mock เฉพาะ assertSafeDestination (ต้องคุม DNS ได้) — ที่เหลือใช้ของจริง
// เพื่อให้ signature/serialize ที่ทดสอบเป็น logic จริง
vi.mock("@/lib/webhooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/webhooks")>();
  return {
    ...actual,
    assertSafeDestination: (url: string) => safeDestinationMock(url),
  };
});

import { POST } from "@/app/api/jobs/webhook-deliver/route";
import { verifyWebhookSignature } from "@/lib/webhooks";

const TENANT_ID = "tenant-1";
const DELIVERY_ID = "del-1";
const SECRET = "whsec_test_secret";
const URL_OK = "https://hooks.example.com/helpwise";

function makeRequest(rawBody: string): NextRequest {
  return new NextRequest(
    new Request("https://acme.helpwise.com/api/jobs/webhook-deliver", {
      method: "POST",
      body: rawBody,
      headers: { "content-type": "application/json" },
    })
  );
}

function validPayload(): string {
  return JSON.stringify({ tenantId: TENANT_ID, deliveryId: DELIVERY_ID });
}

function ticketEnvelope() {
  return {
    id: "evt_1",
    type: "ticket.created",
    createdAt: "2026-07-22T10:00:00.000Z",
    tenantId: TENANT_ID,
    data: {
      ticket: {
        id: "tkt-1",
        ticketNumber: 1042,
        subject: "Need help",
        status: "NEW",
        priority: "NORMAL",
        assigneeMemberId: null,
        requesterContactId: "contact-1",
        channel: "portal",
        createdAt: "2026-07-22T10:00:00.000Z",
        updatedAt: "2026-07-22T10:00:00.000Z",
      },
    },
  };
}

function messageEnvelope(visibility: string) {
  return {
    id: "evt_2",
    type: "ticket.message_created",
    createdAt: "2026-07-22T10:00:00.000Z",
    tenantId: TENANT_ID,
    data: {
      ticket: { id: "tkt-1", ticketNumber: 1042, subject: "Need help" },
      message: {
        id: "msg-1",
        visibility,
        authorType: "agent",
        authorId: "member-1",
        body: "secret internal note",
        createdAt: "2026-07-22T10:00:00.000Z",
      },
    },
  };
}

function pendingDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: DELIVERY_ID,
    eventType: "TICKET_CREATED",
    eventId: "evt_1",
    payload: ticketEnvelope(),
    status: "PENDING",
    attemptCount: 0,
    endpoint: { url: URL_OK, secret: SECRET, enabled: true },
    ...overrides,
  };
}

/** ผลลัพธ์ที่บันทึกลง DB ของ update ครั้งแรก */
function updateData(): Record<string, unknown> {
  return (
    fakeDb.webhookDelivery.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    }
  ).data;
}

function httpResponse(status: number, body = "ok"): Response {
  return new Response(body, { status });
}

describe("POST /api/jobs/webhook-deliver — QStash worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    verifyMock.mockResolvedValue({ valid: true, rawBody: validPayload() });
    safeDestinationMock.mockResolvedValue({ ok: true });
    fakeDb.webhookDelivery.update.mockResolvedValue({});
    fetchMock.mockResolvedValue(httpResponse(200));
  });

  it("signature invalid → 401, ไม่ query/ไม่ยิงอะไร", async () => {
    verifyMock.mockResolvedValue({ valid: false, rawBody: validPayload() });

    const res = await POST(makeRequest(validPayload()));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error.code).toBe("UNAUTHORIZED");
    expect(tenantPrismaMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("payload ขาด tenantId/deliveryId → 400", async () => {
    verifyMock.mockResolvedValue({
      valid: true,
      rawBody: JSON.stringify({ foo: "bar" }),
    });

    const res = await POST(makeRequest("{}"));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("INVALID_PAYLOAD");
    expect(tenantPrismaMock).not.toHaveBeenCalled();
  });

  it("delivery ไม่พบใน tenant → skip not_found", async () => {
    fakeDb.webhookDelivery.findFirst.mockResolvedValue(null);

    const res = await POST(makeRequest(validPayload()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.skipped).toBe("not_found");
    // tenantId มาจาก verified payload เท่านั้น
    expect(tenantPrismaMock).toHaveBeenCalledWith(TENANT_ID);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("idempotent: status SUCCEEDED → skip already_succeeded", async () => {
    fakeDb.webhookDelivery.findFirst.mockResolvedValue(
      pendingDelivery({ status: "SUCCEEDED" })
    );

    const res = await POST(makeRequest(validPayload()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.skipped).toBe("already_succeeded");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fakeDb.webhookDelivery.update).not.toHaveBeenCalled();
  });

  it("status DEAD → skip dead (ต้อง replay ด้วยมือเท่านั้น)", async () => {
    fakeDb.webhookDelivery.findFirst.mockResolvedValue(
      pendingDelivery({ status: "DEAD" })
    );

    const res = await POST(makeRequest(validPayload()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.skipped).toBe("dead");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("endpoint ถูกปิด (enabled=false) → skip endpoint_disabled", async () => {
    fakeDb.webhookDelivery.findFirst.mockResolvedValue(
      pendingDelivery({ endpoint: { url: URL_OK, secret: SECRET, enabled: false } })
    );

    const res = await POST(makeRequest(validPayload()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.skipped).toBe("endpoint_disabled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("⭐ internal-note isolation: payload message INTERNAL → DEAD + ไม่ยิง fetch", async () => {
    fakeDb.webhookDelivery.findFirst.mockResolvedValue(
      pendingDelivery({
        eventType: "TICKET_MESSAGE_CREATED",
        payload: messageEnvelope("INTERNAL"),
      })
    );

    const res = await POST(makeRequest(validPayload()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.skipped).toBe("internal_note_blocked");
    // ⭐ invariant สูงสุด: internal note ห้ามออกนอกระบบ
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateData().status).toBe("DEAD");
    expect(updateData().errorMessage).toBe("internal_note_blocked");
  });

  it("⭐ SSRF: assertSafeDestination ไม่ผ่าน → DEAD + ไม่ยิง fetch (ไม่ retry)", async () => {
    fakeDb.webhookDelivery.findFirst.mockResolvedValue(pendingDelivery());
    safeDestinationMock.mockResolvedValue({ ok: false, reason: "blocked_ip" });

    const res = await POST(makeRequest(validPayload()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.skipped).toBe("blocked_destination");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(updateData().status).toBe("DEAD");
    expect(updateData().errorMessage).toBe("blocked_destination:blocked_ip");
    // SSRF guard ถูกเรียกด้วย url ของ endpoint ทุก attempt (กัน DNS rebinding)
    expect(safeDestinationMock).toHaveBeenCalledWith(URL_OK);
  });

  it("2xx → SUCCEEDED + header ครบตาม § 4 + signature verify ผ่านด้วย raw body ที่ส่งจริง", async () => {
    fakeDb.webhookDelivery.findFirst.mockResolvedValue(pendingDelivery());
    fetchMock.mockResolvedValue(httpResponse(202, "accepted"));

    const res = await POST(makeRequest(validPayload()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.delivered).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      {
        method: string;
        headers: Record<string, string>;
        body: string;
        redirect: string;
      },
    ];
    expect(url).toBe(URL_OK);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual"); // ห้าม follow redirect (SSRF)
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["User-Agent"]).toBe("Helpwise-Webhooks/1.0");
    expect(init.headers["X-Helpwise-Event"]).toBe("ticket.created");
    expect(init.headers["X-Helpwise-Event-Id"]).toBe("evt_1");
    expect(init.headers["X-Helpwise-Delivery-Id"]).toBe(DELIVERY_ID);
    expect(init.headers["X-Helpwise-Attempt"]).toBe("1");
    // signature ต้องเซ็นจาก raw body ตัวเดียวกับที่ส่ง (byte-per-byte)
    expect(
      verifyWebhookSignature(
        SECRET,
        init.body,
        init.headers["X-Helpwise-Signature"]
      )
    ).toBe(true);
    expect(JSON.parse(init.body).id).toBe("evt_1");

    expect(updateData().status).toBe("SUCCEEDED");
    expect(updateData().attemptCount).toBe(1);
    expect(updateData().responseStatus).toBe(202);
    expect(updateData().errorMessage).toBeNull();
  });

  it("receiver 500 + attempt < MAX → FAILED + return 500 (ให้ QStash retry)", async () => {
    fakeDb.webhookDelivery.findFirst.mockResolvedValue(
      pendingDelivery({ attemptCount: 1 })
    );
    fetchMock.mockResolvedValue(httpResponse(500, "boom"));

    const res = await POST(makeRequest(validPayload()));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error.code).toBe("DELIVERY_FAILED");
    expect(updateData().status).toBe("FAILED");
    expect(updateData().attemptCount).toBe(2);
    expect(updateData().responseStatus).toBe(500);
    expect(updateData().errorMessage).toBe("http_500");
  });

  it("attempt ที่ 5 (MAX) ล้ม → DEAD + return 200 (หยุด retry, เข้า DLQ)", async () => {
    fakeDb.webhookDelivery.findFirst.mockResolvedValue(
      pendingDelivery({ attemptCount: 4, status: "FAILED" })
    );
    fetchMock.mockResolvedValue(httpResponse(503));

    const res = await POST(makeRequest(validPayload()));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.deadLettered).toBe(true);
    expect(updateData().status).toBe("DEAD");
    expect(updateData().attemptCount).toBe(5);
  });

  it("3xx (redirect manual) → ถือว่าล้มเหลว ไม่ตาม redirect", async () => {
    fakeDb.webhookDelivery.findFirst.mockResolvedValue(pendingDelivery());
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })
    );

    const res = await POST(makeRequest(validPayload()));

    expect(res.status).toBe(500);
    expect(updateData().status).toBe("FAILED");
    expect(updateData().responseStatus).toBe(302);
    expect(updateData().errorMessage).toBe("http_302");
  });

  it("network error/timeout → FAILED + errorMessage ถูกบันทึก", async () => {
    fakeDb.webhookDelivery.findFirst.mockResolvedValue(pendingDelivery());
    fetchMock.mockRejectedValue(new Error("The operation was aborted"));

    const res = await POST(makeRequest(validPayload()));

    expect(res.status).toBe(500);
    expect(updateData().status).toBe("FAILED");
    expect(updateData().responseStatus).toBeNull();
    expect(updateData().errorMessage).toBe("The operation was aborted");
  });

  it("responseBody ยาวเกิน 500 ตัว → ถูก truncate ก่อนเก็บ", async () => {
    fakeDb.webhookDelivery.findFirst.mockResolvedValue(pendingDelivery());
    fetchMock.mockResolvedValue(httpResponse(200, "x".repeat(2000)));

    await POST(makeRequest(validPayload()));

    expect((updateData().responseBody as string).length).toBe(500);
  });
});
