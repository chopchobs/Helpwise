/**
 * src/lib/__tests__/proxy-skip-readiness.test.ts
 *
 * Phase 39 ลำดับ 1 (erratum §E) — ยืนยันว่า `/api/health/readiness` ถูกครอบโดย
 * `SKIP_TENANT_PATH_PREFIXES` จริง โดย **ไม่แก้โค้ด proxy สักบรรทัด**
 * -----------------------------------------------------------------------------
 * ทั้งดีไซน์ของ probe endpoint แขวนอยู่กับข้อเท็จจริงเดียว: path นี้เดินผ่าน proxy
 * โดยไม่ resolve tenant — ได้มาฟรีจาก `"/api/health"` ใน `SKIP_TENANT_PATH_PREFIXES`
 * (`src/proxy.ts:84`) + เงื่อนไข prefix match (`src/proxy.ts:207-209`)
 *
 * ⚠️ ข้อเท็จจริงนี้ไม่มีอะไรค้ำนอกจาก test ไฟล์นี้ — ถ้ามีคนลบ `"/api/health"`
 *    ออกจากลิสต์ probe จะกลายเป็น endpoint ที่ต้องมี tenant ทันที และ
 *    cron/pinger ที่ยิงเข้ามาจะได้ 404 แทน (เงียบ ไม่มี type error ให้จับ)
 *    ⇒ test นี้ต้อง **fail ได้จริง** ในกรณีนั้น (ดู case "regression guard")
 *
 * mock boundary: @/lib/prisma (engine) + @/lib/redis — เหมือน proxy-tenant.test.ts
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Store } from "./isolation/_engine";
import { makeNextRequest } from "@/app/api/__tests__/_helpers";

vi.mock("@/lib/prisma", async () => {
  const { createFaithfulPrisma } = await import("./isolation/_engine");
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

/** path ของ probe ตาม erratum §B(ข) — ตัดสินแล้วว่าใช้ตัวนี้ ไม่ใช่ /api/ops/readiness */
const READINESS_PATH = "/api/health/readiness";

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  store.tenant = [
    { id: "tenant-A", slug: "acme", isActive: true, plan: { name: "pro" } },
  ];
  process.env.NEXT_PUBLIC_ROOT_DOMAIN = "gethelpwise.xyz";
});

describe("Phase 39 ลำดับ 1 — /api/health/readiness ข้าม tenant resolution", () => {
  it("บน tenant subdomain: ผ่านไปโดยไม่ resolve tenant (ไม่มี x-tenant-id ถูก set)", async () => {
    const req = makeNextRequest(`https://acme.gethelpwise.xyz${READINESS_PATH}`);
    const res = await proxy(req);

    // skip path → nextWithoutTenantHeaders() → ไม่ set tenant header ใด ๆ
    // (ถ้า "/api/health" หลุดจากลิสต์ ค่านี้จะกลายเป็น "tenant-A")
    expect(res.headers.get("x-middleware-request-x-tenant-id")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-tenant-plan")).toBeNull();
  });

  it("REGRESSION GUARD: host ที่ไม่มี tenant ต้องไม่ได้ 404 — ต้องผ่านไปถึง route handler", async () => {
    // 🔴 นี่คือเคสที่ทำให้ test นี้ fail จริงถ้ามีคนลบ "/api/health" ออกจาก
    //    SKIP_TENANT_PATH_PREFIXES: slug "ghost" ไม่มีใน store ⇒ proxy จะตอบ 404
    //    (src/proxy.ts:258) แทนที่จะปล่อยผ่าน ⇒ cron/external pinger อ่าน marker ไม่ได้
    const req = makeNextRequest(`https://ghost.gethelpwise.xyz${READINESS_PATH}`);
    const res = await proxy(req);

    expect(res.status).not.toBe(404);
    expect(res.status).toBe(200); // NextResponse.next() = pass-through
  });

  it("บน root domain: ผ่านไปเฉย ๆ (ทางที่ cron + external pinger ใช้จริง)", async () => {
    // ลำดับ 5/6 ยิงที่โดเมน production ตาม erratum §B(ค) — ต้องไม่ถูกกัน
    const req = makeNextRequest(`https://gethelpwise.xyz${READINESS_PATH}`);
    const res = await proxy(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-tenant-id")).toBeNull();
  });

  it("proxy strip x-tenant-id ที่ client ยัดมาบน probe path (H-1 ยังบังคับใช้)", async () => {
    const req = makeNextRequest(`https://acme.gethelpwise.xyz${READINESS_PATH}`, {
      headers: { "x-tenant-id": "tenant-B" },
    });
    const res = await proxy(req);

    // nextWithoutTenantHeaders() ลบ header ของ client ทิ้ง — ไม่ส่งต่อค่า spoof
    expect(res.headers.get("x-middleware-request-x-tenant-id")).not.toBe("tenant-B");
  });

  it("ขอบเขต prefix ถูกต้อง: /api/healthz ต้อง NOT skip (ยืนยันเงื่อนไข src/proxy.ts:207-209)", async () => {
    // "/api/health" ไม่ลงท้าย "/" ⇒ match = pathname === p || startsWith(p + "/")
    // ⇒ "/api/healthz" ต้องไม่ถูกครอบ (กันการ match แบบ substring ที่กว้างเกินไป)
    const req = makeNextRequest("https://ghost.gethelpwise.xyz/api/healthz");
    const res = await proxy(req);

    expect(res.status).toBe(404); // resolve tenant "ghost" ไม่เจอ → 404
  });
});
