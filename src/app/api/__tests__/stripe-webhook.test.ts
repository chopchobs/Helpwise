/**
 * src/app/api/__tests__/stripe-webhook.test.ts
 * Integration tests สำหรับ POST /api/webhooks/stripe (Phase 18)
 *
 * Invariants ที่ครอบ:
 *   - signature verification (missing header / invalid sig / no secret outside dev / dev bypass)
 *   - idempotency claim-first (P2002 → duplicate / reclaim / record หาย)
 *   - event dispatch (subscription events, checkout.session.completed, invoice.* )
 *   - error handling: 500 + status="error" + errorDetail ไม่ leak (PrismaError:<code>)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { makeNextRequest } from "@/app/api/__tests__/_helpers";

const {
  constructEventMock,
  subscriptionsRetrieveMock,
  syncSubscriptionFromStripeMock,
  processedEventMock,
} = vi.hoisted(() => {
  return {
    constructEventMock: vi.fn(),
    subscriptionsRetrieveMock: vi.fn(),
    syncSubscriptionFromStripeMock: vi.fn(),
    processedEventMock: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
});

vi.mock("@/lib/stripe", () => ({
  stripe: {
    webhooks: { constructEvent: (...args: unknown[]) => constructEventMock(...args) },
    subscriptions: { retrieve: (...args: unknown[]) => subscriptionsRetrieveMock(...args) },
  },
  syncSubscriptionFromStripe: (...args: unknown[]) => syncSubscriptionFromStripeMock(...args),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    processedStripeEvent: processedEventMock,
  },
}));

import { POST } from "@/app/api/webhooks/stripe/route";

const WEBHOOK_SECRET = "whsec_test_secret";
const URL = "https://helpwise.com/api/webhooks/stripe";

function makeEvent(overrides: Partial<{ id: string; type: string; data: { object: unknown } }> = {}) {
  return {
    id: overrides.id ?? "evt_123",
    type: overrides.type ?? "customer.subscription.updated",
    data: overrides.data ?? { object: { id: "sub_123" } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET);
  processedEventMock.create.mockResolvedValue({ id: "claim-1" });
  processedEventMock.update.mockResolvedValue({});
});

describe("POST /api/webhooks/stripe — signature verification", () => {
  it("มี secret แต่ไม่มี stripe-signature header → 400 missing_signature, ไม่แตะ DB", async () => {
    const req = makeNextRequest(URL, {
      method: "POST",
      body: JSON.stringify(makeEvent()),
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("missing_signature");
    expect(processedEventMock.create).not.toHaveBeenCalled();
  });

  it("constructEvent throw (signature ผิด) → 400 invalid_signature, ไม่แตะ DB", async () => {
    constructEventMock.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature");
    });

    const req = makeNextRequest(URL, {
      method: "POST",
      headers: { "stripe-signature": "bad_sig" },
      body: JSON.stringify(makeEvent()),
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("invalid_signature");
    expect(processedEventMock.create).not.toHaveBeenCalled();
  });

  it("ไม่มี secret + NODE_ENV !== development → 400 webhook_not_configured", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");

    const req = makeNextRequest(URL, {
      method: "POST",
      body: JSON.stringify(makeEvent()),
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("webhook_not_configured");
    expect(processedEventMock.create).not.toHaveBeenCalled();
  });

  it("ไม่มี secret + NODE_ENV=development → dev bypass: parse raw JSON + process", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    vi.stubEnv("NODE_ENV", "development");

    const event = makeEvent({ type: "customer.subscription.updated" });
    syncSubscriptionFromStripeMock.mockResolvedValue({});

    const req = makeNextRequest(URL, {
      method: "POST",
      body: JSON.stringify(event),
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.received).toBe(true);
    expect(syncSubscriptionFromStripeMock).toHaveBeenCalledWith(event.data.object);
  });
});

describe("POST /api/webhooks/stripe — idempotency (claim-first)", () => {
  it("create สำเร็จ (event ใหม่) → process → update status=ok → 200", async () => {
    const event = makeEvent({ type: "customer.subscription.updated" });
    constructEventMock.mockReturnValue(event);
    syncSubscriptionFromStripeMock.mockResolvedValue({});

    const req = makeNextRequest(URL, {
      method: "POST",
      headers: { "stripe-signature": "valid_sig" },
      body: JSON.stringify(event),
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ received: true });
    expect(processedEventMock.create).toHaveBeenCalledWith({
      data: { eventId: event.id, type: event.type, status: "processing" },
    });
    expect(processedEventMock.update).toHaveBeenCalledWith({
      where: { id: "claim-1" },
      data: { status: "ok" },
    });
  });

  it("create throw P2002 + existing status=ok → 200 duplicate, ไม่ reprocess", async () => {
    const event = makeEvent();
    constructEventMock.mockReturnValue(event);
    processedEventMock.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      })
    );
    processedEventMock.findUnique.mockResolvedValue({ id: "existing-1", status: "ok" });

    const req = makeNextRequest(URL, {
      method: "POST",
      headers: { "stripe-signature": "valid_sig" },
      body: JSON.stringify(event),
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ received: true, action: "duplicate" });
    expect(syncSubscriptionFromStripeMock).not.toHaveBeenCalled();
    expect(processedEventMock.update).not.toHaveBeenCalled();
  });

  it("create throw P2002 + existing status=error → reclaim (update processing) → reprocess → 200", async () => {
    const event = makeEvent({ type: "customer.subscription.updated" });
    constructEventMock.mockReturnValue(event);
    processedEventMock.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      })
    );
    processedEventMock.findUnique.mockResolvedValue({ id: "existing-1", status: "error" });
    syncSubscriptionFromStripeMock.mockResolvedValue({});

    const req = makeNextRequest(URL, {
      method: "POST",
      headers: { "stripe-signature": "valid_sig" },
      body: JSON.stringify(event),
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ received: true });

    // reclaim: update status="processing" ก่อน reprocess
    expect(processedEventMock.update).toHaveBeenCalledWith({
      where: { id: "existing-1" },
      data: { status: "processing", errorDetail: null },
    });
    // หลัง process สำเร็จ → update status="ok" ด้วย claimId ของ existing record
    expect(processedEventMock.update).toHaveBeenCalledWith({
      where: { id: "existing-1" },
      data: { status: "ok" },
    });
    expect(syncSubscriptionFromStripeMock).toHaveBeenCalledWith(event.data.object);
  });

  it("create throw P2002 + existing status=processing → reclaim → reprocess → 200", async () => {
    const event = makeEvent({ type: "customer.subscription.updated" });
    constructEventMock.mockReturnValue(event);
    processedEventMock.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      })
    );
    processedEventMock.findUnique.mockResolvedValue({ id: "existing-2", status: "processing" });
    syncSubscriptionFromStripeMock.mockResolvedValue({});

    const req = makeNextRequest(URL, {
      method: "POST",
      headers: { "stripe-signature": "valid_sig" },
      body: JSON.stringify(event),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(processedEventMock.update).toHaveBeenCalledWith({
      where: { id: "existing-2" },
      data: { status: "processing", errorDetail: null },
    });
  });

  it("create throw P2002 + findUnique คืน null (record หาย) → 500", async () => {
    const event = makeEvent();
    constructEventMock.mockReturnValue(event);
    processedEventMock.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      })
    );
    processedEventMock.findUnique.mockResolvedValue(null);

    const req = makeNextRequest(URL, {
      method: "POST",
      headers: { "stripe-signature": "valid_sig" },
      body: JSON.stringify(event),
    });
    const res = await POST(req);

    expect(res.status).toBe(500);
    expect(syncSubscriptionFromStripeMock).not.toHaveBeenCalled();
  });

  it("create throw transient (non-P2002) error → 500", async () => {
    const event = makeEvent();
    constructEventMock.mockReturnValue(event);
    processedEventMock.create.mockRejectedValue(new Error("DB connection lost"));

    const req = makeNextRequest(URL, {
      method: "POST",
      headers: { "stripe-signature": "valid_sig" },
      body: JSON.stringify(event),
    });
    const res = await POST(req);

    expect(res.status).toBe(500);
    expect(syncSubscriptionFromStripeMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/stripe — event dispatch", () => {
  beforeEach(() => {
    syncSubscriptionFromStripeMock.mockResolvedValue({});
  });

  it.each([
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
  ])("%s → syncSubscriptionFromStripe(sub) ถูกเรียกด้วย event.data.object", async (type) => {
    const subObject = { id: "sub_abc", object: "subscription" };
    const event = makeEvent({ type, data: { object: subObject } });
    constructEventMock.mockReturnValue(event);

    const req = makeNextRequest(URL, {
      method: "POST",
      headers: { "stripe-signature": "valid_sig" },
      body: JSON.stringify(event),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(syncSubscriptionFromStripeMock).toHaveBeenCalledWith(subObject);
    expect(syncSubscriptionFromStripeMock).toHaveBeenCalledTimes(1);
  });

  it("checkout.session.completed (มี subscription id + metadata.tenantId) → retrieve + sync ด้วย tenantIdHint", async () => {
    const session = {
      object: "checkout.session",
      subscription: "sub_xyz",
      metadata: { tenantId: "tenant-99" },
    };
    const event = makeEvent({ type: "checkout.session.completed", data: { object: session } });
    constructEventMock.mockReturnValue(event);

    const stripeSub = { id: "sub_xyz", object: "subscription" };
    subscriptionsRetrieveMock.mockResolvedValue(stripeSub);

    const req = makeNextRequest(URL, {
      method: "POST",
      headers: { "stripe-signature": "valid_sig" },
      body: JSON.stringify(event),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(subscriptionsRetrieveMock).toHaveBeenCalledWith("sub_xyz", {
      expand: ["items.data.price"],
    });
    expect(syncSubscriptionFromStripeMock).toHaveBeenCalledWith(stripeSub, {
      tenantIdHint: "tenant-99",
    });
  });

  it("checkout.session.completed ไม่มี subscription → ignore, ไม่เรียก retrieve/sync", async () => {
    const session = { object: "checkout.session", subscription: null, metadata: {} };
    const event = makeEvent({ type: "checkout.session.completed", data: { object: session } });
    constructEventMock.mockReturnValue(event);

    const req = makeNextRequest(URL, {
      method: "POST",
      headers: { "stripe-signature": "valid_sig" },
      body: JSON.stringify(event),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(subscriptionsRetrieveMock).not.toHaveBeenCalled();
    expect(syncSubscriptionFromStripeMock).not.toHaveBeenCalled();
  });

  it("invoice.payment_failed (subscription ที่ parent.subscription_details.subscription) → retrieve + sync", async () => {
    const invoice = {
      object: "invoice",
      parent: { subscription_details: { subscription: "sub_failed" } },
    };
    const event = makeEvent({ type: "invoice.payment_failed", data: { object: invoice } });
    constructEventMock.mockReturnValue(event);

    const stripeSub = { id: "sub_failed", object: "subscription" };
    subscriptionsRetrieveMock.mockResolvedValue(stripeSub);

    const req = makeNextRequest(URL, {
      method: "POST",
      headers: { "stripe-signature": "valid_sig" },
      body: JSON.stringify(event),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(subscriptionsRetrieveMock).toHaveBeenCalledWith("sub_failed", {
      expand: ["items.data.price"],
    });
    expect(syncSubscriptionFromStripeMock).toHaveBeenCalledWith(stripeSub);
  });

  it("invoice.paid (subscription object พร้อม .id) → retrieve + sync", async () => {
    const invoice = {
      object: "invoice",
      parent: { subscription_details: { subscription: { id: "sub_paid" } } },
    };
    const event = makeEvent({ type: "invoice.paid", data: { object: invoice } });
    constructEventMock.mockReturnValue(event);

    const stripeSub = { id: "sub_paid", object: "subscription" };
    subscriptionsRetrieveMock.mockResolvedValue(stripeSub);

    const req = makeNextRequest(URL, {
      method: "POST",
      headers: { "stripe-signature": "valid_sig" },
      body: JSON.stringify(event),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(subscriptionsRetrieveMock).toHaveBeenCalledWith("sub_paid", {
      expand: ["items.data.price"],
    });
    expect(syncSubscriptionFromStripeMock).toHaveBeenCalledWith(stripeSub);
  });

  it("invoice.paid ไม่มี subscription_details → ignore, ไม่เรียก retrieve/sync", async () => {
    const invoice = { object: "invoice", parent: {} };
    const event = makeEvent({ type: "invoice.paid", data: { object: invoice } });
    constructEventMock.mockReturnValue(event);

    const req = makeNextRequest(URL, {
      method: "POST",
      headers: { "stripe-signature": "valid_sig" },
      body: JSON.stringify(event),
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(subscriptionsRetrieveMock).not.toHaveBeenCalled();
    expect(syncSubscriptionFromStripeMock).not.toHaveBeenCalled();
  });

  it("unknown event type → 200, ไม่ throw, ไม่เรียก sync", async () => {
    const event = makeEvent({ type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } });
    constructEventMock.mockReturnValue(event);

    const req = makeNextRequest(URL, {
      method: "POST",
      headers: { "stripe-signature": "valid_sig" },
      body: JSON.stringify(event),
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual({ received: true });
    expect(syncSubscriptionFromStripeMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/webhooks/stripe — error handling", () => {
  it("syncSubscriptionFromStripe throw → 500 + update status=error + errorDetail (generic Error, ไม่ leak)", async () => {
    const event = makeEvent({ type: "customer.subscription.updated" });
    constructEventMock.mockReturnValue(event);
    syncSubscriptionFromStripeMock.mockRejectedValue(new Error("boom: sensitive db detail"));

    const req = makeNextRequest(URL, {
      method: "POST",
      headers: { "stripe-signature": "valid_sig" },
      body: JSON.stringify(event),
    });
    const res = await POST(req);

    expect(res.status).toBe(500);
    expect(processedEventMock.update).toHaveBeenCalledWith({
      where: { id: "claim-1" },
      data: { status: "error", errorDetail: "boom: sensitive db detail" },
    });
  });

  it("syncSubscriptionFromStripe throw Prisma error → errorDetail = PrismaError:<code> (ไม่ leak param)", async () => {
    const event = makeEvent({ type: "customer.subscription.updated" });
    constructEventMock.mockReturnValue(event);
    syncSubscriptionFromStripeMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`email`)", {
        code: "P2002",
        clientVersion: "test",
      })
    );

    const req = makeNextRequest(URL, {
      method: "POST",
      headers: { "stripe-signature": "valid_sig" },
      body: JSON.stringify(event),
    });
    const res = await POST(req);

    expect(res.status).toBe(500);
    expect(processedEventMock.update).toHaveBeenCalledWith({
      where: { id: "claim-1" },
      data: { status: "error", errorDetail: "PrismaError:P2002" },
    });
  });
});
