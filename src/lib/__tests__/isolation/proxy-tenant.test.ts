/**
 * src/lib/__tests__/isolation/proxy-tenant.test.ts
 *
 * TID-CLIENT-02 — proxy (src/proxy.ts) ต้อง "เขียนทับ" x-tenant-id จาก client เสมอ
 * -----------------------------------------------------------------------------
 * รากฐานของ "ห้าม tenantId จาก client" คือ proxy resolve tenant จาก subdomain แล้ว
 * set x-tenant-id ทับค่าที่ client แนบมา. test นี้ยิง proxy "ตัวจริง" ด้วย client ที่
 * แอบ set x-tenant-id=B บน subdomain ของ A → ต้องได้ header ที่ resolve = A (ไม่ใช่ B).
 *
 * mock boundary: @/lib/prisma (engine) + @/lib/redis (cache miss → DB lookup)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Store } from "./_engine";
import { SUSPECTED_WEAKNESSES } from "./threat-model";
import { makeNextRequest } from "@/app/api/__tests__/_helpers";

vi.mock("@/lib/prisma", async () => {
  const { createFaithfulPrisma } = await import("./_engine");
  return { prisma: createFaithfulPrisma({}).prisma };
});

vi.mock("@/lib/redis", () => ({
  redis: { get: vi.fn(async () => null), set: vi.fn(async () => "OK") },
  tenantSlugCacheKey: (slug: string) => `tenant:slug:${slug}`,
  TENANT_CACHE_TTL_SECONDS: 300,
}));

import { prisma as mockedPrisma } from "@/lib/prisma";
import { proxy } from "@/proxy";

const store = (mockedPrisma as unknown as { __store: Store }).__store;

const note = SUSPECTED_WEAKNESSES.find((w) => w.caseId === "TID-CLIENT-02");

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  // tenant "acme" → id tenant-A. seed plan เป็น nested object (proxy select plan.name)
  store.tenant = [{ id: "tenant-A", slug: "acme", isActive: true, plan: { name: "pro" } }];
  process.env.NEXT_PUBLIC_ROOT_DOMAIN = "gethelpwise.xyz";
});

describe("TID-CLIENT-02 — proxy เขียนทับ x-tenant-id จาก client", () => {
  it(`TID-CLIENT-02 — client แนบ x-tenant-id=B บน subdomain A → proxy override เป็น A (${note?.caseId})`, async () => {
    // client พยายาม spoof: set x-tenant-id=tenant-B เอง บน subdomain acme (=tenant-A)
    const req = makeNextRequest("https://acme.gethelpwise.xyz/api/portal/tickets", {
      headers: { "x-tenant-id": "tenant-B" },
    });
    const res = await proxy(req);

    // NextResponse.next({request:{headers}}) เก็บ overridden request header ไว้ที่
    // x-middleware-request-<name> — proxy ต้อง set = tenant ที่ resolve จาก subdomain
    const overridden = res.headers.get("x-middleware-request-x-tenant-id");
    expect(overridden).toBe("tenant-A"); // ไม่ใช่ค่า tenant-B ที่ client ยัด
  });

  it("TID-CLIENT-02 — subdomain ไม่พบ tenant → 404 (ไม่ส่งต่อ header ของ client)", async () => {
    const req = makeNextRequest("https://ghost.gethelpwise.xyz/api/portal/tickets", {
      headers: { "x-tenant-id": "tenant-B" },
    });
    const res = await proxy(req);
    expect(res.status).toBe(404);
  });
});
