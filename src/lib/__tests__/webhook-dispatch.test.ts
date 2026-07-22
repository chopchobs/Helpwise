/**
 * src/lib/__tests__/webhook-dispatch.test.ts
 * Unit tests สำหรับ src/lib/webhook-dispatch.ts (Phase 36 Slice 2a — producer)
 *
 * P0 invariants:
 *   - internal-note isolation: message ที่ไม่ใช่ PUBLIC → ไม่แตะ DB, ไม่ publish
 *   - ไม่มี endpoint ที่ subscribe → ไม่สร้าง delivery, ไม่ publish
 *   - 1 event → หลาย delivery แต่ eventId เดียวกัน (receiver dedupe ได้)
 *   - query endpoint ผ่าน tenant-scoped db เท่านั้น + enabled:true + events has eventType
 *   - dispatch ล้ม → ไม่ throw ออกไป caller (ticket route ต้องไม่พัง)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { publishMock } = vi.hoisted(() => ({ publishMock: vi.fn() }));

vi.mock("@/lib/queue", () => ({
  publishWebhookDeliveryJob: (job: unknown) => publishMock(job),
}));

import {
  dispatchWebhookEvent,
  type DispatchWebhookEventInput,
} from "@/lib/webhook-dispatch";
import type { TenantScopedPrisma } from "@/lib/tenant";
import type { WebhookEnvelope } from "@/types/webhook";

const TENANT_ID = "tenant-1";

/** fake tenant-scoped client — cast เป็น TenantScopedPrisma เฉพาะ 2 model ที่ใช้ */
function makeDb() {
  return {
    webhookEndpoint: { findMany: vi.fn() },
    webhookDelivery: { create: vi.fn() },
  };
}

type FakeDb = ReturnType<typeof makeDb>;

function asScoped(db: FakeDb): TenantScopedPrisma {
  return db as unknown as TenantScopedPrisma;
}

function ticketInput(): DispatchWebhookEventInput {
  return {
    eventType: "TICKET_CREATED",
    occurredAt: new Date("2026-07-22T10:00:00.000Z"),
    ticket: {
      id: "tkt-1",
      ticketNumber: 1042,
      subject: "Need help",
      status: "NEW",
      priority: "NORMAL",
      assigneeMemberId: null,
      requesterContactId: "contact-1",
      channel: "portal",
      createdAt: new Date("2026-07-22T10:00:00.000Z"),
      updatedAt: new Date("2026-07-22T10:00:00.000Z"),
    },
  };
}

function messageInput(visibility: string): DispatchWebhookEventInput {
  return {
    eventType: "TICKET_MESSAGE_CREATED",
    occurredAt: new Date("2026-07-22T10:00:00.000Z"),
    ticket: { id: "tkt-1", ticketNumber: 1042, subject: "Need help" },
    message: {
      id: "msg-1",
      visibility,
      authorType: "agent",
      authorId: "member-1",
      body: "hello",
      createdAt: new Date("2026-07-22T10:00:00.000Z"),
    },
  };
}

describe("dispatchWebhookEvent", () => {
  let db: FakeDb;

  beforeEach(() => {
    vi.clearAllMocks();
    db = makeDb();
    let seq = 0;
    db.webhookDelivery.create.mockImplementation(async () => ({
      id: `del-${++seq}`,
    }));
  });

  it("ไม่มี endpoint ที่ subscribe → ไม่สร้าง delivery, ไม่ publish", async () => {
    db.webhookEndpoint.findMany.mockResolvedValue([]);

    await dispatchWebhookEvent(asScoped(db), TENANT_ID, ticketInput());

    expect(db.webhookDelivery.create).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("query endpoint ด้วย enabled:true + events has eventType (ผ่าน scoped db)", async () => {
    db.webhookEndpoint.findMany.mockResolvedValue([]);

    await dispatchWebhookEvent(asScoped(db), TENANT_ID, ticketInput());

    expect(db.webhookEndpoint.findMany).toHaveBeenCalledTimes(1);
    const arg = db.webhookEndpoint.findMany.mock.calls[0][0] as {
      where: { enabled: boolean; events: { has: string } };
    };
    expect(arg.where.enabled).toBe(true);
    expect(arg.where.events.has).toBe("TICKET_CREATED");
  });

  it("endpoint 2 ตัว → 2 delivery + publish 2 job แต่ eventId เดียวกัน", async () => {
    db.webhookEndpoint.findMany.mockResolvedValue([
      { id: "ep-1" },
      { id: "ep-2" },
    ]);

    await dispatchWebhookEvent(asScoped(db), TENANT_ID, ticketInput());

    expect(db.webhookDelivery.create).toHaveBeenCalledTimes(2);
    const calls = db.webhookDelivery.create.mock.calls.map(
      (c) =>
        (
          c[0] as {
            data: {
              endpointId: string;
              eventId: string;
              eventType: string;
              status: string;
              attemptCount: number;
              payload: WebhookEnvelope;
            };
          }
        ).data
    );

    // scalar FK เท่านั้น (ห้าม relation-connect — extension reject)
    expect(calls[0].endpointId).toBe("ep-1");
    expect(calls[1].endpointId).toBe("ep-2");
    expect(calls.every((d) => !("endpoint" in d))).toBe(true);

    // ⭐ invariant: 1 event → eventId เดียวกันทุก delivery
    expect(calls[0].eventId).toBe(calls[1].eventId);
    expect(calls[0].eventId).toMatch(/^evt_/);
    // envelope.id ต้องตรงกับ eventId ที่เก็บลงแถว
    expect(calls[0].payload.id).toBe(calls[0].eventId);
    expect(calls[0].payload.type).toBe("ticket.created");
    expect(calls[0].payload.tenantId).toBe(TENANT_ID);
    expect(calls[0].status).toBe("PENDING");
    expect(calls[0].attemptCount).toBe(0);

    // publish job ผอม: tenantId + deliveryId ของแถวที่เพิ่งสร้าง
    expect(publishMock).toHaveBeenCalledTimes(2);
    expect(publishMock).toHaveBeenNthCalledWith(1, {
      tenantId: TENANT_ID,
      deliveryId: "del-1",
    });
    expect(publishMock).toHaveBeenNthCalledWith(2, {
      tenantId: TENANT_ID,
      deliveryId: "del-2",
    });
  });

  it("internal-note isolation: message INTERNAL → ไม่แตะ DB, ไม่ publish", async () => {
    db.webhookEndpoint.findMany.mockResolvedValue([{ id: "ep-1" }]);

    await dispatchWebhookEvent(
      asScoped(db),
      TENANT_ID,
      messageInput("INTERNAL")
    );

    // ⭐ ต้องกันตั้งแต่ก่อนถึง DB — ไม่มีแม้แต่ query endpoint
    expect(db.webhookEndpoint.findMany).not.toHaveBeenCalled();
    expect(db.webhookDelivery.create).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("message PUBLIC → สร้าง delivery ด้วย envelope ticket.message_created", async () => {
    db.webhookEndpoint.findMany.mockResolvedValue([{ id: "ep-1" }]);

    await dispatchWebhookEvent(asScoped(db), TENANT_ID, messageInput("PUBLIC"));

    expect(db.webhookDelivery.create).toHaveBeenCalledTimes(1);
    const data = (
      db.webhookDelivery.create.mock.calls[0][0] as {
        data: { eventType: string; payload: WebhookEnvelope };
      }
    ).data;
    expect(data.eventType).toBe("TICKET_MESSAGE_CREATED");
    expect(data.payload.type).toBe("ticket.message_created");
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it("create ล้ม → ไม่ throw ออกไป caller (ticket route ต้องไม่พัง)", async () => {
    db.webhookEndpoint.findMany.mockResolvedValue([{ id: "ep-1" }]);
    db.webhookDelivery.create.mockRejectedValue(new Error("db down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      dispatchWebhookEvent(asScoped(db), TENANT_ID, ticketInput())
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("publish ล้ม → ไม่ throw ออกไป caller", async () => {
    db.webhookEndpoint.findMany.mockResolvedValue([{ id: "ep-1" }]);
    publishMock.mockRejectedValue(new Error("qstash down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      dispatchWebhookEvent(asScoped(db), TENANT_ID, ticketInput())
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
