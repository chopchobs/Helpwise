/**
 * src/app/api/__tests__/notification-isolation.test.ts
 * Integration tests (cross-cutting) สำหรับ Phase 28 Slice 2 — Notification isolation
 *
 * ต่างจาก notifications.test.ts (ตรวจ where-clause ของ single call แบบ stateless):
 * ไฟล์นี้ใช้ "stateful in-memory store" ที่จำลอง tenantPrisma scope จริง
 *   (filter ทั้ง tenantId ของ scoped client + where clause ของ query)
 * เพื่อพิสูจน์ end-to-end ว่า isolation ทำงานจริงเมื่อมีข้อมูลหลาย member / หลาย tenant ปนกัน
 *
 * DoD ที่ครอบ:
 *   1. Cross-member isolation — A เห็น/แก้เฉพาะของ A; A mark ของ B → 404 + ของ B ยัง unread
 *   2. Tenant isolation — notification ของ tenant อื่นไม่หลุด (แม้ memberId ตรงกัน)
 *   3. unreadCount lifecycle — นับ readAt null ของ member นั้น; mark read แล้ว count ลด
 *   4. ไม่รับ tenantId/memberId จาก client — scope ใช้ session/ctx เสมอ
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotificationType } from "@prisma/client";
import { defaultCtx, makeNextRequest } from "@/app/api/__tests__/_helpers";

// =============================================================================
// Stateful in-memory store + tenant-scoped fake prisma
// =============================================================================

interface NotifRow {
  id: string;
  tenantId: string;
  memberId: string;
  type: NotificationType;
  ticketId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

const { store, tenantPrismaMock, requireAgentMock } = vi.hoisted(() => {
  // store ส่วนกลาง — เก็บทุก row ของทุก tenant/member ปนกัน
  const store: { rows: Array<Record<string, unknown>> } = { rows: [] };

  // จำลอง tenantPrisma(tenantId): ทุก op ถูก scope ด้วย tenantId นี้ก่อนเสมอ
  // (เลียนแบบพฤติกรรม extension จริงที่ inject tenantId ลง where/data)
  function makeScoped(tenantId: string) {
    function matchWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
      // tenant scope บังคับเสมอ (เหมือน extension inject where.tenantId)
      if (row.tenantId !== tenantId) return false;
      for (const [k, v] of Object.entries(where)) {
        if (k === "readAt") {
          // รองรับ readAt: null (unread filter)
          if (v === null && row.readAt !== null) return false;
          if (v !== null && row.readAt === null) return false;
        } else if (row[k] !== v) {
          return false;
        }
      }
      return true;
    }

    return {
      notification: {
        findMany: vi.fn(async (q: { where: Record<string, unknown>; orderBy?: { createdAt: "asc" | "desc" } }) => {
          let result = store.rows.filter((r) => matchWhere(r, q.where ?? {}));
          if (q.orderBy?.createdAt === "desc") {
            result = [...result].sort(
              (a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime()
            );
          }
          // จำลอง select: route map ฟิลด์เองอยู่แล้ว — คืน row ครบ
          return result.map((r) => ({ ...r }));
        }),
        findFirst: vi.fn(async (q: { where: Record<string, unknown> }) => {
          const r = store.rows.find((row) => matchWhere(row, q.where ?? {}));
          return r ? { ...r } : null;
        }),
        count: vi.fn(async (q: { where: Record<string, unknown> }) => {
          return store.rows.filter((r) => matchWhere(r, q.where ?? {})).length;
        }),
        updateMany: vi.fn(async (q: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const matched = store.rows.filter((r) => matchWhere(r, q.where ?? {}));
          for (const r of matched) Object.assign(r, q.data);
          return { count: matched.length };
        }),
        create: vi.fn(async (q: { data: Record<string, unknown> }) => {
          // extension จริง inject tenantId — จำลองด้วย tenantId ของ scoped client
          const row = {
            id: `notif-${store.rows.length + 1}`,
            tenantId,
            ticketId: null,
            readAt: null,
            createdAt: new Date(),
            ...q.data,
          };
          store.rows.push(row);
          return { ...row };
        }),
      },
    };
  }

  return {
    store,
    tenantPrismaMock: vi.fn((tenantId: string) => makeScoped(tenantId)),
    requireAgentMock: vi.fn(),
  };
});

vi.mock("@/lib/tenant", () => ({
  getTenantContext: vi.fn(),
  tenantPrisma: (tenantId: string) => tenantPrismaMock(tenantId),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireAgent: (...args: unknown[]) => requireAgentMock(...args),
  };
});

import { GET as listNotifications } from "@/app/api/notifications/route";
import { PATCH as markRead } from "@/app/api/notifications/[id]/route";

// =============================================================================
// Fixtures — สอง tenant, แต่ละ tenant มีหลาย member
// =============================================================================

const TENANT_A = "tenant-A";
const TENANT_B = "tenant-B";

function sessionFor(tenantId: string, memberId: string) {
  return {
    user: { id: `user-${memberId}`, name: `Agent ${memberId}` },
    member: { id: memberId, role: "AGENT", userId: `user-${memberId}` },
    ctx: defaultCtx({ tenantId }),
  };
}

function seed() {
  const t0 = new Date("2026-06-19T08:00:00.000Z");
  const t1 = new Date("2026-06-19T09:00:00.000Z");
  const t2 = new Date("2026-06-19T10:00:00.000Z");
  store.rows = [
    // tenant A — member-A1: 2 unread
    { id: "nA1-a", tenantId: TENANT_A, memberId: "member-A1", type: NotificationType.TICKET_ASSIGNED, ticketId: "tkt-1", readAt: null, createdAt: t0 },
    { id: "nA1-b", tenantId: TENANT_A, memberId: "member-A1", type: NotificationType.TICKET_ASSIGNED, ticketId: "tkt-2", readAt: null, createdAt: t2 },
    // tenant A — member-A2: 1 unread + 1 read
    { id: "nA2-a", tenantId: TENANT_A, memberId: "member-A2", type: NotificationType.TICKET_ASSIGNED, ticketId: "tkt-3", readAt: null, createdAt: t1 },
    { id: "nA2-b", tenantId: TENANT_A, memberId: "member-A2", type: NotificationType.TICKET_ASSIGNED, ticketId: "tkt-4", readAt: t1, createdAt: t0 },
    // tenant B — member-B1: ใช้ "member-A1" ที่ tenant อื่นก็มี id ชนกันได้ (ทดสอบ tenant scope)
    { id: "nB1-a", tenantId: TENANT_B, memberId: "member-A1", type: NotificationType.TICKET_ASSIGNED, ticketId: "tkt-9", readAt: null, createdAt: t2 },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

function patchReq(id: string, body?: unknown) {
  return {
    req: makeNextRequest(`https://acme.helpwise.com/api/notifications/${id}`, {
      method: "PATCH",
      ...(body !== undefined ? { body } : {}),
    }),
    params: Promise.resolve({ id }),
  };
}

// =============================================================================
// 1. Cross-member isolation (stateful)
// =============================================================================

describe("cross-member isolation (stateful store)", () => {
  it("A1 เห็นเฉพาะ notification ของตัวเอง (ไม่เห็นของ A2 ใน tenant เดียวกัน)", async () => {
    requireAgentMock.mockResolvedValue(sessionFor(TENANT_A, "member-A1"));

    const res = await listNotifications();
    const json = await res.json();

    expect(res.status).toBe(200);
    const ids = json.data.notifications.map((n: { id: string }) => n.id);
    expect(ids.sort()).toEqual(["nA1-a", "nA1-b"]);
    expect(ids).not.toContain("nA2-a");
    expect(ids).not.toContain("nA2-b");
    expect(json.data.unreadCount).toBe(2);
    // ordering desc (newest แรก)
    expect(json.data.notifications[0].id).toBe("nA1-b");
  });

  it("A2 เห็นเฉพาะของตัวเอง + unreadCount นับเฉพาะ readAt null", async () => {
    requireAgentMock.mockResolvedValue(sessionFor(TENANT_A, "member-A2"));

    const res = await listNotifications();
    const json = await res.json();

    const ids = json.data.notifications.map((n: { id: string }) => n.id);
    expect(ids.sort()).toEqual(["nA2-a", "nA2-b"]);
    // 1 unread (nA2-a) + 1 read (nA2-b) → count = 1
    expect(json.data.unreadCount).toBe(1);
  });

  it("A1 mark notification ของ A2 → 404 และของ A2 ยัง unread (ไม่ถูกแตะ)", async () => {
    requireAgentMock.mockResolvedValue(sessionFor(TENANT_A, "member-A1"));

    const { req, params } = patchReq("nA2-a"); // ของ member-A2
    const res = await markRead(req, { params });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.data).toBeNull();
    expect(json.error.code).toBe("NOT_FOUND");

    // ยืนยัน state: nA2-a ยัง readAt null (A1 แตะไม่ได้)
    const row = store.rows.find((r) => r.id === "nA2-a")!;
    expect(row.readAt).toBeNull();

    // และ unreadCount ของ A2 ยังเท่าเดิม
    requireAgentMock.mockResolvedValue(sessionFor(TENANT_A, "member-A2"));
    const res2 = await listNotifications();
    const json2 = await res2.json();
    expect(json2.data.unreadCount).toBe(1);
  });

  it("A1 mark ของตัวเอง → 200, readAt set, unreadCount ลดจาก 2 → 1", async () => {
    requireAgentMock.mockResolvedValue(sessionFor(TENANT_A, "member-A1"));

    // before
    const before = await (await listNotifications()).json();
    expect(before.data.unreadCount).toBe(2);

    const { req, params } = patchReq("nA1-a");
    const res = await markRead(req, { params });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.id).toBe("nA1-a");
    expect(json.data.readAt).not.toBeNull();

    // after — count ลด
    const after = await (await listNotifications()).json();
    expect(after.data.unreadCount).toBe(1);
  });
});

// =============================================================================
// 2. Tenant isolation (stateful)
// =============================================================================

describe("tenant isolation (stateful store)", () => {
  it("member-A1 ใน tenant A ไม่เห็น notification ที่ memberId เดียวกันแต่อยู่ tenant B", async () => {
    requireAgentMock.mockResolvedValue(sessionFor(TENANT_A, "member-A1"));

    const res = await listNotifications();
    const json = await res.json();

    const ids = json.data.notifications.map((n: { id: string }) => n.id);
    // nB1-a มี memberId=member-A1 เหมือนกัน แต่ tenantId=B → ต้องไม่หลุด
    expect(ids).not.toContain("nB1-a");
    expect(ids.sort()).toEqual(["nA1-a", "nA1-b"]);
  });

  it("session ของ tenant B (memberId ชนกัน) เห็นเฉพาะ row ของ tenant B", async () => {
    requireAgentMock.mockResolvedValue(sessionFor(TENANT_B, "member-A1"));

    const res = await listNotifications();
    const json = await res.json();

    const ids = json.data.notifications.map((n: { id: string }) => n.id);
    expect(ids).toEqual(["nB1-a"]);
    expect(json.data.unreadCount).toBe(1);
    // ยืนยัน tenantPrisma ถูกเรียกด้วย tenantId ของ context (B) ไม่ใช่ค่าจาก client
    expect(tenantPrismaMock).toHaveBeenCalledWith(TENANT_B);
  });

  it("A1 mark notification id ของ tenant B (nB1-a) → 404 (cross-tenant ไม่หลุด)", async () => {
    requireAgentMock.mockResolvedValue(sessionFor(TENANT_A, "member-A1"));

    const { req, params } = patchReq("nB1-a");
    const res = await markRead(req, { params });
    const json = await res.json();

    expect(res.status).toBe(404);
    // row tenant B ยัง unread (A แตะข้าม tenant ไม่ได้)
    const row = store.rows.find((r) => r.id === "nB1-a")!;
    expect(row.readAt).toBeNull();
  });
});

// =============================================================================
// 3. ไม่รับ tenantId / memberId จาก client
// =============================================================================

describe("ไม่ trust tenantId/memberId จาก client", () => {
  it("GET: tenantPrisma ถูก scope ด้วย ctx.tenantId เสมอ (ค่าจาก session)", async () => {
    requireAgentMock.mockResolvedValue(sessionFor(TENANT_A, "member-A1"));
    await listNotifications();
    expect(tenantPrismaMock).toHaveBeenCalledWith(TENANT_A);
    expect(tenantPrismaMock).not.toHaveBeenCalledWith(TENANT_B);
  });

  it("PATCH: ส่ง tenantId+memberId ปลอมใน body → ถูกเพิกเฉย, scope ใช้ session", async () => {
    requireAgentMock.mockResolvedValue(sessionFor(TENANT_A, "member-A1"));

    // พยายาม spoof: ขอ mark nA1-a แต่ปลอม tenant=B + member=A2 ใน body
    const { req, params } = patchReq("nA1-a", {
      tenantId: TENANT_B,
      memberId: "member-A2",
    });
    const res = await markRead(req, { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.id).toBe("nA1-a");
    // scope ใช้ session: tenantPrisma(A) เท่านั้น, ไม่เคยเรียกด้วย B
    expect(tenantPrismaMock).toHaveBeenCalledWith(TENANT_A);
    expect(tenantPrismaMock).not.toHaveBeenCalledWith(TENANT_B);

    // row ที่ถูกแก้คือของ member-A1 จริง — ไม่ใช่ A2
    const rowA1 = store.rows.find((r) => r.id === "nA1-a")!;
    expect(rowA1.readAt).not.toBeNull();
    // ของ A2 ไม่ถูกแตะ
    const rowA2 = store.rows.find((r) => r.id === "nA2-a")!;
    expect(rowA2.readAt).toBeNull();
  });

  it("PATCH ซ้ำ (mark read ของที่อ่านแล้ว) → ยัง 200 (idempotent), count คงที่", async () => {
    requireAgentMock.mockResolvedValue(sessionFor(TENANT_A, "member-A2"));

    // nA2-b อ่านแล้ว — mark ซ้ำ
    const { req, params } = patchReq("nA2-b");
    const res = await markRead(req, { params });
    expect(res.status).toBe(200);

    const after = await (await listNotifications()).json();
    // ยังมี 1 unread (nA2-a) เหมือนเดิม
    expect(after.data.unreadCount).toBe(1);
  });
});
