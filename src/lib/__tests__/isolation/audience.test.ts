/**
 * src/lib/__tests__/isolation/audience.test.ts
 *
 * Tier 2 — audience-confusion (AUD-01..06) ผ่าน guard "ตัวจริง" src/lib/auth.ts
 * ---------------------------------------------------------------------------
 * ทดสอบ requireAgent() / requireContact() จริง + token ที่ sign ด้วย jose จริง
 * (issueAgentToken/issueContactToken เป็น production fn) → พิสูจน์ว่า audience
 * แยกขาด + membership/double-check tenant ทำงานจริง.
 *
 * mock boundary:
 *   - @/lib/prisma  → faithful engine (tenantMember/contact lookup ของ guard)
 *   - next/headers  → cookies() + headers() ควบคุมได้ต่อ test (แทน request จริง)
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import fc from "fast-check";
import { SignJWT } from "jose";
import type { Store } from "./_engine";
import { ATTACK_CASES, type AttackCase } from "./threat-model";

// AUTH_SECRET ต้อง ≥ 32 ตัว (L-2 ใน auth.ts) — ตั้งก่อน import auth
const SECRET = "test-secret-at-least-32-chars-long-000";
process.env.AUTH_SECRET = SECRET;

// ควบคุม cookie/header ต่อ test
const cookieJar = new Map<string, string>();
const headerJar = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
  headers: async () => ({
    get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
  }),
}));

vi.mock("@/lib/prisma", async () => {
  const { createFaithfulPrisma } = await import("./_engine");
  return { prisma: createFaithfulPrisma({}).prisma };
});

import { prisma as mockedPrisma } from "@/lib/prisma";
import {
  requireAgent,
  requireContact,
  issueAgentToken,
  issueContactToken,
  AGENT_COOKIE_NAME,
  CONTACT_COOKIE_NAME,
  AuthError,
} from "@/lib/auth";

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

function setCtx(tenantId: string): void {
  headerJar.clear();
  headerJar.set("x-tenant-id", tenantId);
  headerJar.set("x-tenant-plan", "pro");
}

async function expectAuthStatus(fn: () => Promise<unknown>, status: number): Promise<void> {
  try {
    await fn();
    throw new Error("expected AuthError but none thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(AuthError);
    expect((e as AuthError).statusCode).toBe(status);
  }
}

beforeAll(() => {
  process.env.AUTH_SECRET = SECRET;
});

beforeEach(() => {
  cookieJar.clear();
  headerJar.clear();
  for (const k of Object.keys(store)) delete store[k];
  // seed: user + active member ใน tenant A + active contact ใน tenant A
  store.user = [{ id: "user-1", email: "a@a.com", name: "Agent", isActive: true }];
  store.tenantMember = [
    { id: "mem-1", tenantId: A, userId: "user-1", role: "AGENT", isActive: true },
  ];
  store.contact = [{ id: "contact-1", tenantId: A, email: "c@c.com", name: "C", isActive: true }];
});

describe("axis: audience-confusion (guards ตัวจริง)", () => {
  it(name("AUD-01"), async () => {
    // agent token ยัดใน contact cookie → requireContact ต้อง 401 (type mismatch)
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 12 }), async (uid) => {
        cookieJar.clear();
        setCtx(A);
        const agentToken = await issueAgentToken(`user-${uid}`);
        cookieJar.set(CONTACT_COOKIE_NAME, agentToken);
        await expectAuthStatus(() => requireContact(), 401);
      }),
      { numRuns: 15 }
    );
  });

  it(name("AUD-02"), async () => {
    // contact token ยัดใน agent cookie → requireAgent ต้อง 401
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 12 }), async (cid) => {
        cookieJar.clear();
        setCtx(A);
        const contactToken = await issueContactToken(`contact-${cid}`, A);
        cookieJar.set(AGENT_COOKIE_NAME, contactToken);
        await expectAuthStatus(() => requireAgent(), 401);
      }),
      { numRuns: 15 }
    );
  });

  it(name("AUD-03"), async () => {
    // contact token ของ tenant A replay บน subdomain B → 401 (payload.tenantId !== ctx)
    setCtx(B);
    const token = await issueContactToken("contact-1", A);
    cookieJar.set(CONTACT_COOKIE_NAME, token);
    await expectAuthStatus(() => requireContact(), 401);
  });

  it(name("AUD-04"), async () => {
    // agent token ของ user ที่เป็น member เฉพาะ A แต่ยิงบน subdomain B → 403 (ไม่มี membership)
    setCtx(B);
    const token = await issueAgentToken("user-1");
    cookieJar.set(AGENT_COOKIE_NAME, token);
    await expectAuthStatus(() => requireAgent(), 403);
  });

  it(name("AUD-05"), async () => {
    // member ที่ isActive=false → 403 (deactivated ยังถือ token เก่า)
    store.tenantMember = [
      { id: "mem-1", tenantId: A, userId: "user-1", role: "AGENT", isActive: false },
    ];
    setCtx(A);
    const token = await issueAgentToken("user-1");
    cookieJar.set(AGENT_COOKIE_NAME, token);
    await expectAuthStatus(() => requireAgent(), 403);
  });

  it(name("AUD-06"), async () => {
    // token integrity เสีย (garbage / sign ผิด secret / expired) → 401 ทุกกรณี
    setCtx(A);

    // (a) garbage tokens แบบสุ่ม
    await fc.assert(
      fc.asyncProperty(fc.string(), async (garbage) => {
        cookieJar.set(AGENT_COOKIE_NAME, garbage);
        await expectAuthStatus(() => requireAgent(), 401);
      }),
      { numRuns: 20 }
    );

    // (b) valid structure แต่ sign ด้วย secret อื่น
    const wrongSig = await new SignJWT({ type: "agent" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-1")
      .setIssuedAt()
      .setExpirationTime("8h")
      .sign(new TextEncoder().encode("some-other-secret-that-is-32-chars-xx"));
    cookieJar.set(AGENT_COOKIE_NAME, wrongSig);
    await expectAuthStatus(() => requireAgent(), 401);

    // (c) expired token (exp ในอดีต) — signature ถูกแต่หมดอายุ
    const expired = await new SignJWT({ type: "agent" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user-1")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 100000)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(new TextEncoder().encode(SECRET));
    cookieJar.set(AGENT_COOKIE_NAME, expired);
    await expectAuthStatus(() => requireAgent(), 401);
  });
});
