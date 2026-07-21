/**
 * src/lib/__tests__/isolation/route-isolation.test.ts
 *
 * Tier 3 — route-level isolation ผ่าน route handler "ตัวจริง"
 * ---------------------------------------------------------
 * ครอบ axis ที่ enforce ที่ระดับ route (ไม่ centralize ใน tenantPrisma):
 *   internal-note-leak (NOTE-LEAK-01..05), contact-own-records (OWN-01..05),
 *   tenantid-from-client (TID-CLIENT-01/03/04)
 *
 * 🎯 harness: route จริง → tenantPrisma "ตัวจริง" → faithful engine.
 *    - visibility=PUBLIC filter, requesterContactId scope = โค้ด route จริง (ไม่ mock)
 *    - engine honor nested where (select.messages.where.visibility) เหมือน DB จริง
 *    ➡️ ถ้า route ลืม where:{visibility:PUBLIC} → INTERNAL note หลุด → test แดง (จับได้จริง)
 *
 * mock boundary: prisma(engine) + auth guards(session) + rate-limit/features/storage/tickets/audit
 *   — ทั้งหมดเป็น boundary นอก isolation logic ที่กำลังทดสอบ
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fc from "fast-check";
import { Prisma } from "@prisma/client";
import type { Store } from "./_engine";
import { ATTACK_CASES, type AttackCase } from "./threat-model";
import { makeNextRequest } from "@/app/api/__tests__/_helpers";

// ---- hoisted mocks (guards / boundaries) ------------------------------------
const {
  requireContactMock,
  requireApiKeyMock,
  createTicketWithNumberMock,
  createTicketMessageMock,
} = vi.hoisted(() => ({
  requireContactMock: vi.fn(),
  requireApiKeyMock: vi.fn(),
  createTicketWithNumberMock: vi.fn(),
  createTicketMessageMock: vi.fn(),
}));

vi.mock("@/lib/prisma", async () => {
  const { createFaithfulPrisma } = await import("./_engine");
  return { prisma: createFaithfulPrisma({}).prisma };
});

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requireContact: requireContactMock };
});

vi.mock("@/lib/api-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-auth")>();
  return { ...actual, requireApiKey: requireApiKeyMock };
});

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 100, retryAfterSeconds: 0 })) };
});

vi.mock("@/lib/features", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/features")>();
  return { ...actual, hasFeature: vi.fn(async () => false) };
});

vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return { ...actual, createSignedDownloadUrl: vi.fn(async () => "https://signed.example/download?token=xyz") };
});

vi.mock("@/lib/tickets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tickets")>();
  return {
    ...actual,
    createTicketWithNumber: createTicketWithNumberMock,
    createTicketMessage: createTicketMessageMock,
  };
});

vi.mock("@/lib/audit", () => ({ audit: { log: vi.fn(async () => undefined) } }));

import { prisma as mockedPrisma } from "@/lib/prisma";
import { GET as portalTicketDetail } from "@/app/api/portal/tickets/[id]/route";
import { GET as portalTicketList, POST as portalTicketCreate } from "@/app/api/portal/tickets/route";
import { POST as portalMessageCreate } from "@/app/api/portal/tickets/[id]/messages/route";
import { GET as portalAttachment } from "@/app/api/portal/attachments/[id]/route";
import { GET as v1TicketDetail } from "@/app/api/v1/tickets/[id]/route";

const store = (mockedPrisma as unknown as { __store: Store }).__store;

function caseOf(id: string): AttackCase {
  const c = ATTACK_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`ATTACK_CASES ไม่มี id: ${id}`);
  return c;
}
function name(id: string): string {
  return `${id} — ${caseOf(id).title}`;
}

const A = "tenant-A";
const B = "tenant-B";

function contactSession(contactId: string, tenantId: string) {
  return {
    contact: { id: contactId, tenantId, name: "C", avatarUrl: null, isActive: true },
    ctx: { tenantId, plan: "pro" },
  };
}

function resetStore(): void {
  for (const k of Object.keys(store)) delete store[k];
  store.ticket = [];
  store.ticketMessage = [];
  store.attachment = [];
  store.contact = [];
  store.tenantMember = [];
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  store.contact = [
    { id: "c1", tenantId: A, email: "c1@a.com", name: "C1", isActive: true },
    { id: "c2", tenantId: A, email: "c2@a.com", name: "C2", isActive: true },
  ];
});

/** seed ticket + messages (PUBLIC/INTERNAL) ให้ contact ใน tenant */
function seedTicket(opts: {
  id: string;
  tenantId: string;
  contactId: string;
  publicBodies: string[];
  internalBodies: string[];
  status?: string;
}): void {
  store.ticket!.push({
    id: opts.id,
    tenantId: opts.tenantId,
    ticketNumber: store.ticket!.length + 1,
    subject: `subj-${opts.id}`,
    status: opts.status ?? "OPEN",
    priority: "NORMAL",
    requesterContactId: opts.contactId,
    assigneeId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    firstRespondedAt: null,
    resolvedAt: null,
    mergedIntoId: null,
  });
  let n = store.ticketMessage!.length;
  for (const body of opts.publicBodies) {
    store.ticketMessage!.push({
      id: `pub-${opts.id}-${n++}`, tenantId: opts.tenantId, ticketId: opts.id,
      visibility: "PUBLIC", body, authorContactId: opts.contactId, authorMemberId: null,
      createdAt: new Date("2026-01-01T00:01:00Z"),
    });
  }
  for (const body of opts.internalBodies) {
    store.ticketMessage!.push({
      id: `int-${opts.id}-${n++}`, tenantId: opts.tenantId, ticketId: opts.id,
      visibility: "INTERNAL", body, authorContactId: null, authorMemberId: "m1",
      createdAt: new Date("2026-01-01T00:02:00Z"),
    });
  }
}

// =============================================================================
// AXIS 5 — internal-note-leak
// =============================================================================

describe("axis: internal-note-leak", () => {
  it(name("NOTE-LEAK-01"), async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { minLength: 1, maxLength: 5 }),
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 5 }),
        async (pub, intl) => {
          resetStore();
          store.contact = [{ id: "c1", tenantId: A, email: "c1@a.com", name: "C1", isActive: true }];
          seedTicket({ id: "t1", tenantId: A, contactId: "c1", publicBodies: pub, internalBodies: intl });
          requireContactMock.mockResolvedValue(contactSession("c1", A));

          const res = await portalTicketDetail(
            makeNextRequest("https://a.gethelpwise.xyz/api/portal/tickets/t1"),
            { params: Promise.resolve({ id: "t1" }) }
          );
          const json = await res.json();
          expect(res.status).toBe(200);
          const bodies = (json.data.messages as Array<{ id: string; body: string }>);
          // ห้ามมี message id/body ที่เป็น INTERNAL หลุด
          expect(bodies.every((m) => !m.id.startsWith("int-"))).toBe(true);
          expect(bodies.length).toBe(pub.length);
        }
      )
    );
  });

  it(name("NOTE-LEAK-02"), async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string(), { minLength: 1, maxLength: 4 }),
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 4 }),
        async (pub, intl) => {
          resetStore();
          seedTicket({ id: "t1", tenantId: A, contactId: "c1", publicBodies: pub, internalBodies: intl });
          requireApiKeyMock.mockResolvedValue({ apiKey: { id: "k1" }, ctx: { tenantId: A, plan: "pro" } });

          const res = await v1TicketDetail(
            makeNextRequest("https://a.gethelpwise.xyz/api/v1/tickets/t1"),
            { params: Promise.resolve({ id: "t1" }) }
          );
          const json = await res.json();
          expect(res.status).toBe(200);
          const msgs = json.data.messages as Array<{ id: string }>;
          expect(msgs.every((m) => !m.id.startsWith("int-"))).toBe(true);
          expect(msgs.length).toBe(pub.length);
        }
      )
    );
  });

  it(name("NOTE-LEAK-03"), async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        async (p, i) => {
          resetStore();
          store.contact = [{ id: "c1", tenantId: A, email: "c1@a.com", name: "C1", isActive: true }];
          seedTicket({
            id: "t1", tenantId: A, contactId: "c1",
            publicBodies: Array.from({ length: p }, (_, k) => `p${k}`),
            internalBodies: Array.from({ length: i }, (_, k) => `i${k}`),
          });
          requireContactMock.mockResolvedValue(contactSession("c1", A));

          const res = await portalTicketList(
            makeNextRequest("https://a.gethelpwise.xyz/api/portal/tickets")
          );
          const json = await res.json();
          const t = json.data.tickets[0];
          // _count.messages ต้องนับเฉพาะ PUBLIC (p) ไม่รวม INTERNAL (i)
          expect(t._count.messages).toBe(p);
        }
      )
    );
  });

  it(name("NOTE-LEAK-04"), async () => {
    resetStore();
    store.contact = [{ id: "c1", tenantId: A, email: "c1@a.com", name: "C1", isActive: true }];
    seedTicket({ id: "t1", tenantId: A, contactId: "c1", publicBodies: ["p"], internalBodies: ["secret"] });
    const internalMsg = store.ticketMessage!.find((m) => m.visibility === "INTERNAL")!;
    store.attachment!.push({
      id: "att-internal", tenantId: A, ticketId: "t1", messageId: internalMsg.id,
      fileName: "secret.pdf", fileSize: 10, mimeType: "application/pdf",
      storageUrl: "s/secret.pdf", createdAt: new Date(),
    });
    requireContactMock.mockResolvedValue(contactSession("c1", A));

    const res = await portalAttachment(
      makeNextRequest("https://a.gethelpwise.xyz/api/portal/attachments/att-internal"),
      { params: Promise.resolve({ id: "att-internal" }) }
    );
    const json = await res.json();
    // attachment ของ INTERNAL message → 404, ไม่คืน signed url
    expect(res.status).toBe(404);
    expect(json.data).toBeNull();
  });

  it(name("NOTE-LEAK-05"), async () => {
    // regression net: ยิงทั้ง portal-detail + v1-detail ด้วย ticket ที่มี INTERNAL note
    // → ไม่มี surface ไหนคืน body/id ของ INTERNAL
    // ใช้ uuid เป็น secret body (distinctive) — กัน false positive จาก substring ชนกับ JSON key
    // (เช่น "ame" ที่บังเอิญเป็น substring ของ "name") ที่ไม่ใช่การรั่วจริง
    await fc.assert(
      fc.asyncProperty(fc.array(fc.uuid(), { minLength: 1, maxLength: 4 }), async (secrets) => {
        resetStore();
        store.contact = [{ id: "c1", tenantId: A, email: "c1@a.com", name: "C1", isActive: true }];
        seedTicket({ id: "t1", tenantId: A, contactId: "c1", publicBodies: ["hello"], internalBodies: secrets });
        requireContactMock.mockResolvedValue(contactSession("c1", A));
        requireApiKeyMock.mockResolvedValue({ apiKey: { id: "k1" }, ctx: { tenantId: A, plan: "pro" } });

        const portalRes = await portalTicketDetail(
          makeNextRequest("https://a.gethelpwise.xyz/api/portal/tickets/t1"),
          { params: Promise.resolve({ id: "t1" }) }
        );
        const v1Res = await v1TicketDetail(
          makeNextRequest("https://a.gethelpwise.xyz/api/v1/tickets/t1"),
          { params: Promise.resolve({ id: "t1" }) }
        );
        const portalJson = JSON.stringify(await portalRes.json());
        const v1Json = JSON.stringify(await v1Res.json());
        for (const secret of secrets) {
          expect(portalJson.includes(secret)).toBe(false);
          expect(v1Json.includes(secret)).toBe(false);
        }
      })
    );
  });
});

// =============================================================================
// AXIS 6 — contact-own-records
// =============================================================================

describe("axis: contact-own-records", () => {
  it(name("OWN-01"), async () => {
    seedTicket({ id: "t-c2", tenantId: A, contactId: "c2", publicBodies: ["x"], internalBodies: [] });
    requireContactMock.mockResolvedValue(contactSession("c1", A));
    const res = await portalTicketDetail(
      makeNextRequest("https://a.gethelpwise.xyz/api/portal/tickets/t-c2"),
      { params: Promise.resolve({ id: "t-c2" }) }
    );
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json.data).toBeNull();
  });

  it(name("OWN-02"), async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 4 }), async (mine, others) => {
        resetStore();
        store.contact = [
          { id: "c1", tenantId: A, email: "c1@a.com", name: "C1", isActive: true },
          { id: "c2", tenantId: A, email: "c2@a.com", name: "C2", isActive: true },
        ];
        for (let k = 0; k < mine; k++) seedTicket({ id: `mine-${k}`, tenantId: A, contactId: "c1", publicBodies: [], internalBodies: [] });
        for (let k = 0; k < others; k++) seedTicket({ id: `oth-${k}`, tenantId: A, contactId: "c2", publicBodies: [], internalBodies: [] });
        requireContactMock.mockResolvedValue(contactSession("c1", A));

        const res = await portalTicketList(makeNextRequest("https://a.gethelpwise.xyz/api/portal/tickets"));
        const json = await res.json();
        const tickets = json.data.tickets as Array<{ id: string }>;
        // ทุก ticket ต้องเป็นของ c1 (id ขึ้นต้น mine-)
        expect(tickets.every((t) => t.id.startsWith("mine-"))).toBe(true);
        expect(tickets.length).toBe(mine);
      })
    );
  });

  it(name("OWN-03"), async () => {
    seedTicket({ id: "t-c2", tenantId: A, contactId: "c2", publicBodies: ["x"], internalBodies: [], status: "OPEN" });
    requireContactMock.mockResolvedValue(contactSession("c1", A));
    const res = await portalMessageCreate(
      makeNextRequest("https://a.gethelpwise.xyz/api/portal/tickets/t-c2/messages", {
        method: "POST", body: { body: "hi" },
      }),
      { params: Promise.resolve({ id: "t-c2" }) }
    );
    expect(res.status).toBe(404);
    // ต้องไม่สร้าง message (createTicketMessage ไม่ถูกเรียก)
    expect(createTicketMessageMock).not.toHaveBeenCalled();
  });

  it(name("OWN-04"), async () => {
    // attachment อยู่บน ticket ของ c2 (PUBLIC message) — c1 ขอ → 404
    seedTicket({ id: "t-c2", tenantId: A, contactId: "c2", publicBodies: ["x"], internalBodies: [] });
    const pubMsg = store.ticketMessage!.find((m) => m.ticketId === "t-c2")!;
    store.attachment!.push({
      id: "att-c2", tenantId: A, ticketId: "t-c2", messageId: pubMsg.id,
      fileName: "f.pdf", fileSize: 5, mimeType: "application/pdf", storageUrl: "s/f", createdAt: new Date(),
    });
    requireContactMock.mockResolvedValue(contactSession("c1", A));
    const res = await portalAttachment(
      makeNextRequest("https://a.gethelpwise.xyz/api/portal/attachments/att-c2"),
      { params: Promise.resolve({ id: "att-c2" }) }
    );
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json.data).toBeNull();
  });

  it(name("OWN-05"), async () => {
    // POST create: body ยัด requesterContactId ของ contact อื่น → route ต้องใช้ session.contact.id
    createTicketWithNumberMock.mockImplementation(async (_db: unknown, args: { requesterContactId: string; tenantId: string }) => {
      store.ticket!.push({
        id: "new-t", tenantId: args.tenantId, ticketNumber: 99, subject: "s",
        status: "NEW", priority: "NORMAL", requesterContactId: args.requesterContactId,
        createdAt: new Date(), updatedAt: new Date(),
      });
      return { id: "new-t", ticketNumber: 99, subject: "s", status: "NEW", priority: "NORMAL" };
    });
    requireContactMock.mockResolvedValue(contactSession("c1", A));

    await portalTicketCreate(
      makeNextRequest("https://a.gethelpwise.xyz/api/portal/tickets", {
        method: "POST",
        body: { subject: "hello there", firstMessage: { body: "hi" }, requesterContactId: "c2", tenantId: B },
      })
    );
    // route ต้องส่ง requesterContactId = session.contact.id (c1) และ tenantId = ctx (A) — ไม่ใช่ค่า body
    const callArgs = createTicketWithNumberMock.mock.calls[0][1] as { requesterContactId: string; tenantId: string };
    expect(callArgs.requesterContactId).toBe("c1");
    expect(callArgs.tenantId).toBe(A);
  });
});

// =============================================================================
// AXIS 8 — tenantid-from-client (route-level)
// =============================================================================

describe("axis: tenantid-from-client (route-level)", () => {
  it(name("TID-CLIENT-01"), async () => {
    // body มี tenantId=B → route ใช้ ctx (A) จาก session เท่านั้น (ครอบคู่กับ OWN-05)
    createTicketWithNumberMock.mockImplementation(async (_db: unknown, args: { tenantId: string }) => {
      return { id: "n", ticketNumber: 1, subject: "s", status: "NEW", priority: "NORMAL", tenantId: args.tenantId };
    });
    requireContactMock.mockResolvedValue(contactSession("c1", A));
    await portalTicketCreate(
      makeNextRequest("https://a.gethelpwise.xyz/api/portal/tickets", {
        method: "POST",
        body: { subject: "hello there", firstMessage: { body: "hi" }, tenantId: B },
      })
    );
    const callArgs = createTicketWithNumberMock.mock.calls[0][1] as { tenantId: string };
    expect(callArgs.tenantId).toBe(A);
  });

  it(name("TID-CLIENT-03"), async () => {
    // ?tenantId=B ใน query string → ถูกละเว้น, scope ยังเป็น ctx (A)
    seedTicket({ id: "mine", tenantId: A, contactId: "c1", publicBodies: [], internalBodies: [] });
    seedTicket({ id: "bTicket", tenantId: B, contactId: "cB", publicBodies: [], internalBodies: [] });
    requireContactMock.mockResolvedValue(contactSession("c1", A));
    const res = await portalTicketList(
      makeNextRequest("https://a.gethelpwise.xyz/api/portal/tickets?tenantId=tenant-B")
    );
    const json = await res.json();
    const tickets = json.data.tickets as Array<{ id: string }>;
    expect(tickets.every((t) => t.id === "mine")).toBe(true);
    expect(tickets.some((t) => t.id === "bTicket")).toBe(false);
  });

  it(name("TID-CLIENT-04"), async () => {
    // path id ของ resource tenant B บน subdomain A → tenantPrisma scope A → 404
    seedTicket({ id: "bTicket", tenantId: B, contactId: "cB", publicBodies: ["x"], internalBodies: [] });
    requireContactMock.mockResolvedValue(contactSession("c1", A));
    requireApiKeyMock.mockResolvedValue({ apiKey: { id: "k1" }, ctx: { tenantId: A, plan: "pro" } });

    const portalRes = await portalTicketDetail(
      makeNextRequest("https://a.gethelpwise.xyz/api/portal/tickets/bTicket"),
      { params: Promise.resolve({ id: "bTicket" }) }
    );
    const v1Res = await v1TicketDetail(
      makeNextRequest("https://a.gethelpwise.xyz/api/v1/tickets/bTicket"),
      { params: Promise.resolve({ id: "bTicket" }) }
    );
    expect(portalRes.status).toBe(404);
    expect(v1Res.status).toBe(404);
  });
});

// =============================================================================
// XT-WRITE-05 (route layer) — residual composite-FK violation → 400 INVALID_REFERENCE
// -----------------------------------------------------------------------------
// finding XT-WRITE-05 ปิดที่ DB (composite tenant FK) + app (verify ก่อน write). ชั้นสุดท้าย
// ของ defense-in-depth: ถ้ามี residual FK violation หลุดถึง DB (เช่น TOCTOU verify→write, หรือ
// write path ใหม่ที่ลืม verify) Postgres reject → Prisma P2003. route ต้อง map เป็น 400 สะอาด
// (code INVALID_REFERENCE) — ไม่ใช่ 500 opaque และห้าม leak ชื่อ constraint/field ให้ client.
// (map logic = toAuthErrorResponse ใน src/lib/auth.ts — production code จริง, ไม่ mock)
// =============================================================================

describe("XT-WRITE-05 (route): residual FK violation → 400 INVALID_REFERENCE", () => {
  /** สร้าง Prisma P2003 error (mirror Postgres 23503) ที่มีชื่อ constraint ใน message (ต้องไม่ leak) */
  function makeP2003(): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError(
      "Foreign key constraint violated on the constraint: `Ticket_tenantId_requesterContactId_fkey`",
      { code: "P2003", clientVersion: "test", meta: { field_name: "Ticket_tenantId_requesterContactId_fkey" } }
    );
  }

  it(`${name("XT-WRITE-05")} — write path ที่ FK violation หลุดถึง DB → 400 INVALID_REFERENCE (ไม่ leak constraint)`, async () => {
    requireContactMock.mockResolvedValue(contactSession("c1", A));
    // จำลอง: verify หลุด → write ถึง DB → Postgres reject composite tenant FK → Prisma P2003
    createTicketWithNumberMock.mockRejectedValue(makeP2003());

    const res = await portalTicketCreate(
      makeNextRequest("https://a.gethelpwise.xyz/api/portal/tickets", {
        method: "POST",
        body: { subject: "hello there", firstMessage: { body: "hi" } },
      })
    );
    const json = await res.json();

    // ต้องเป็น 400 สะอาด (ไม่ใช่ 500 opaque)
    expect(res.status).toBe(400);
    expect(json.error.code).toBe("INVALID_REFERENCE");
    expect(json.data).toBeNull();

    // ต้องไม่ leak ชื่อ constraint / field / คำว่า foreign key ให้ client
    const payload = JSON.stringify(json);
    expect(payload).not.toContain("fkey");
    expect(payload).not.toContain("requesterContact");
    expect(payload.toLowerCase()).not.toContain("foreign key");
    expect(payload.toLowerCase()).not.toContain("constraint");
  });
});
