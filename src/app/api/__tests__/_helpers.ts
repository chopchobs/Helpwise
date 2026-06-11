/**
 * src/app/api/__tests__/_helpers.ts
 * Helper กลางสำหรับ integration test ของ API routes (Phase 15)
 *
 * รวมเฉพาะ helper ที่ "ใช้ได้นอก vi.mock factory" — สร้าง request + default tenant context
 *
 * ⚠️ fake db (tenantPrisma) + fake redis ต้องประกาศ inline ผ่าน `vi.hoisted()` ในแต่ละ
 *    test file เอง เพราะ vi.mock hoisting: factory ของ vi.mock("@/lib/redis", ...) อ้าง
 *    import จากไฟล์นี้ไม่ได้ (ReferenceError: Cannot access before initialization)
 *    จึงไม่รวม createFakeDb/createFakeRedis ไว้ที่นี่ (จะกลายเป็น dead export)
 *
 * ⚠️ ไฟล์นี้ "ไม่ใช่" test file — ไม่มี describe/it
 */

import { NextRequest } from "next/server";

// =============================================================================
// makeNextRequest — สร้าง NextRequest สำหรับ route handler
// =============================================================================

export interface MakeRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export function makeNextRequest(
  url: string,
  opts: MakeRequestOptions = {}
): NextRequest {
  const { method = "GET", headers = {}, body } = opts;
  const init: RequestInit = {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
  };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new NextRequest(new Request(url, init));
}

// =============================================================================
// DEFAULT TENANT CONTEXT
// =============================================================================

export const DEFAULT_TENANT_ID = "tenant-1";
export const DEFAULT_PLAN = "pro";

export function defaultCtx(
  overrides: Partial<{ tenantId: string; plan: string }> = {}
) {
  return {
    tenantId: overrides.tenantId ?? DEFAULT_TENANT_ID,
    plan: overrides.plan ?? DEFAULT_PLAN,
  };
}
