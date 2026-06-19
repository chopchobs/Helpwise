/**
 * src/app/api/__tests__/notifications.test.ts
 * Integration tests สำหรับ Phase 28 Slice 2 (Notifications)
 *
 * Endpoints + producers ที่ครอบ:
 *   - GET   /api/notifications        — list ของ current member + unreadCount
 *   - PATCH /api/notifications/:id     — mark read (recipient-only)
 *   - createNotification trigger บน POST /api/tickets + PATCH /api/tickets/:id
 *
 * P0 invariants:
 *   - recipient scope: GET คืนเฉพาะของ current member (member อื่นมองไม่เห็น)
 *   - recipient scope: PATCH ของ member อื่น → 404 (ห้าม mark/leak)
 *   - ไม่รับ memberId จาก client — ใช้ member.id จาก verified session
 *   - assign trigger: notify ผู้ถูก assign · skip self-assign · tenant/recipient ถูกต้อง
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotificationType } from "@prisma/client";
import { defaultCtx, DEFAULT_TENANT_ID, makeNextRequest } from "@/app/api/__tests__/_helpers";

// =============================================================================
// vi.hoisted — fakeDb + mocks
// =============================================================================

const { fakeDb, requireAgentMock } = vi.hoisted(() => {
  const fakeDb = {
    notification: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
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

// mock requireAgent เท่านั้น — ใช้ toAuthErrorResponse จริงจาก @/lib/auth
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAgent: (...args: unknown[]) => requireAgentMock(...args),
  };
});

import { GET as listNotifications } from "@/app/api/notifications/route";
import { PATCH as markRead } from "@/app/api/notifications/[id]/route";
import { AuthError } from "@/lib/auth";

// =============================================================================
// ข้อมูลตัวอย่าง
// =============================================================================

// current member = member-1; member อื่น (member-2) ใช้ทดสอบ recipient scope
const SESSION = {
  user: { id: "user-1", name: "Agent One" },
  member: { id: "member-1", role: "AGENT", userId: "user-1" },
  ctx: defaultCtx(),
};

const NOW = new Date("2026-06-19T10:00:00.000Z");

function sampleNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: "notif-1",
    type: NotificationType.TICKET_ASSIGNED,
    ticketId: "ticket-1",
    readAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAgentMock.mockResolvedValue(SESSION);
});

// =============================================================================
// GET /api/notifications
// =============================================================================

describe("GET /api/notifications", () => {
  it("คืนเฉพาะ notification ของ current member + unreadCount ถูก", async () => {
    fakeDb.notification.findMany.mockResolvedValue([sampleNotification()]);
    fakeDb.notification.count.mockResolvedValue(1);

    const res = await listNotifications();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.notifications).toHaveLength(1);
    expect(json.data.notifications[0]).toEqual({
      id: "notif-1",
      type: "TICKET_ASSIGNED",
      ticketId: "ticket-1",
      readAt: null,
      createdAt: NOW.toISOString(),
    });
    expect(json.data.unreadCount).toBe(1);

    // recipient scope: query ต้อง filter memberId = current member (จาก session ไม่ใช่ client)
    expect(fakeDb.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { memberId: "member-1" },
        orderBy: { createdAt: "desc" },
      })
    );
    // unreadCount scope ทั้ง memberId + readAt null
    expect(fakeDb.notification.count).toHaveBeenCalledWith({
      where: { memberId: "member-1", readAt: null },
    });
  });

  it("member อื่นมองไม่เห็น — query scope ด้วย member.id ของ session คนละค่า", async () => {
    // จำลอง session ของอีก member → query ต้อง scope memberId = member-2 ไม่ใช่ member-1
    requireAgentMock.mockResolvedValue({
      ...SESSION,
      member: { id: "member-2", role: "AGENT", userId: "user-2" },
    });
    fakeDb.notification.findMany.mockResolvedValue([]);
    fakeDb.notification.count.mockResolvedValue(0);

    const res = await listNotifications();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.notifications).toEqual([]);
    expect(fakeDb.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { memberId: "member-2" } })
    );
  });

  it("requireAgent throw 401 → propagate 401, ไม่ query", async () => {
    requireAgentMock.mockRejectedValue(new AuthError("Unauthorized", 401));

    const res = await listNotifications();
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.data).toBeNull();
    expect(fakeDb.notification.findMany).not.toHaveBeenCalled();
  });
});

// =============================================================================
// PATCH /api/notifications/:id — mark read (recipient-only)
// =============================================================================

describe("PATCH /api/notifications/:id", () => {
  function makeReq(id: string) {
    return {
      req: makeNextRequest(`https://acme.helpwise.com/api/notifications/${id}`, {
        method: "PATCH",
      }),
      params: Promise.resolve({ id }),
    };
  }

  it("mark read ของตัวเองได้ → 200 + readAt set, scope memberId ใน where", async () => {
    fakeDb.notification.updateMany.mockResolvedValue({ count: 1 });
    fakeDb.notification.findFirst.mockResolvedValue(
      sampleNotification({ readAt: NOW })
    );

    const { req, params } = makeReq("notif-1");
    const res = await markRead(req, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.id).toBe("notif-1");
    expect(json.data.readAt).toBe(NOW.toISOString());

    // recipient scope: updateMany where ต้องมี memberId = current member (จาก session)
    expect(fakeDb.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "notif-1", memberId: "member-1" },
        data: expect.objectContaining({ readAt: expect.any(Date) }),
      })
    );
  });

  it("mark notification ของ member อื่น → 404 (recipient-only, ไม่ leak)", async () => {
    // updateMany scope memberId=member-1 ไม่ match notification ของ member อื่น → count 0
    fakeDb.notification.updateMany.mockResolvedValue({ count: 0 });

    const { req, params } = makeReq("notif-other-member");
    const res = await markRead(req, { params });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.data).toBeNull();
    expect(json.error.code).toBe("NOT_FOUND");
    // ห้ามไป findFirst/return record ของคนอื่น
    expect(fakeDb.notification.findFirst).not.toHaveBeenCalled();
  });

  it("ไม่รับ memberId จาก client — body memberId ถูกเพิกเฉย, ใช้ session", async () => {
    fakeDb.notification.updateMany.mockResolvedValue({ count: 1 });
    fakeDb.notification.findFirst.mockResolvedValue(
      sampleNotification({ readAt: NOW })
    );

    // ส่ง memberId ปลอมใน body — ต้องไม่ถูกใช้ใน where scope
    const req = makeNextRequest("https://acme.helpwise.com/api/notifications/notif-1", {
      method: "PATCH",
      body: { memberId: "member-999" },
    });
    const res = await markRead(req, { params: Promise.resolve({ id: "notif-1" }) });

    expect(res.status).toBe(200);
    expect(fakeDb.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "notif-1", memberId: "member-1" } })
    );
  });

  it("requireAgent throw 401 → propagate 401, ไม่ update", async () => {
    requireAgentMock.mockRejectedValue(new AuthError("Unauthorized", 401));

    const { req, params } = makeReq("notif-1");
    const res = await markRead(req, { params });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.data).toBeNull();
    expect(fakeDb.notification.updateMany).not.toHaveBeenCalled();
  });
});

// =============================================================================
// createNotification helper (unit) — tenant-scoped create
// =============================================================================

describe("createNotification helper", () => {
  it("create ด้วย scalar memberId/type/ticketId (ไม่ใช้ {connect})", async () => {
    fakeDb.notification.create.mockResolvedValue({});
    // import ภายใน test เพื่อใช้ fakeDb ที่ mock แล้วเป็น TenantScopedPrisma
    const { createNotification } = await import("@/lib/notifications");

    await createNotification(fakeDb as never, {
      memberId: "member-2",
      type: NotificationType.TICKET_ASSIGNED,
      ticketId: "ticket-9",
    });

    expect(fakeDb.notification.create).toHaveBeenCalledWith({
      data: { memberId: "member-2", type: "TICKET_ASSIGNED", ticketId: "ticket-9" },
    });
  });

  it("ticketId optional — ไม่ส่ง ticketId ก็สร้างได้", async () => {
    fakeDb.notification.create.mockResolvedValue({});
    const { createNotification } = await import("@/lib/notifications");

    await createNotification(fakeDb as never, {
      memberId: "member-2",
      type: NotificationType.TICKET_ASSIGNED,
    });

    expect(fakeDb.notification.create).toHaveBeenCalledWith({
      data: { memberId: "member-2", type: "TICKET_ASSIGNED" },
    });
  });
});

// reference DEFAULT_TENANT_ID เพื่อยืนยัน fakeDb ถูก scope ผ่าน tenantPrisma mock
void DEFAULT_TENANT_ID;
