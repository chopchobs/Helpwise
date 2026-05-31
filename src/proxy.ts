/**
 * src/proxy.ts  — Tenant Resolution (Node.js runtime)
 *
 * ทำไมใช้ proxy.ts แทน middleware.ts:
 *   Next.js 16.2 แยก "middleware" (Edge runtime) กับ "proxy" (Node.js runtime)
 *   Edge runtime ไม่รองรับ ioredis (TCP socket) หรือ Prisma adapter-pg (node-postgres)
 *   Proxy "always runs on Node.js runtime" (ดู next/dist/build/analysis/get-page-static-info.js)
 *   จึงใช้ proxy.ts เพื่อให้ใช้ Redis + Prisma ได้โดยตรง โดยไม่ต้องแยก API route
 *
 * ข้อจำกัดของ proxy.ts:
 *   - ไม่รองรับ request rewrite/redirect แบบ edge granularity (ไม่มี NextResponse.rewrite)
 *   - ต้องอยู่ที่ src/ หรือ root ของ project (ไม่ใช่ app/)
 *   - export ฟังก์ชันชื่อ "proxy" หรือ default export
 *
 * Security: middleware/proxy **เขียนทับ** x-tenant-id และ x-tenant-plan เสมอ
 *           กัน client ส่ง header ปลอมเพื่อ tenant spoofing
 *
 * Flow:
 *   1. แยก slug จาก host (เทียบ ROOT_DOMAIN)
 *   2. validate slug regex /^[a-z0-9-]+$/
 *   3. ข้าม reserved subdomains + marketing/admin paths
 *   4. lookup tenant: Redis cache ก่อน → DB miss → cache ผล
 *   5. inject x-tenant-id + x-tenant-plan (เขียนทับค่าจาก client)
 *   6. ไม่พบ tenant → 404
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  redis,
  tenantSlugCacheKey,
  TENANT_CACHE_TTL_SECONDS,
} from "@/lib/redis";

// =============================================================================
// CONSTANTS
// =============================================================================

/** validate slug: lowercase, alphanumeric, hyphen เท่านั้น */
const SLUG_REGEX = /^[a-z0-9-]+$/;

/**
 * L-1: sentinel string สำหรับ negative cache — แทน JSON.stringify(null) = "null"
 * ป้องกัน ambiguity ระหว่าง "ไม่พบ tenant" กับ cache miss (ยังไม่ได้ set)
 */
const NOT_FOUND_SENTINEL = "__NOT_FOUND__";

/**
 * Reserved subdomains ที่ไม่ใช่ tenant
 * www, app, api, admin ไม่ควร route ไป tenant
 */
const RESERVED_SUBDOMAINS = new Set([
  "www",
  "app",
  "api",
  "admin",
  "mail",
  "ftp",
  "smtp",
]);

/**
 * Path prefixes ที่เป็น marketing/admin — ไม่ต้อง tenant context
 * (ใช้บน root domain: helpwise.com/pricing, helpwise.com/login ฯลฯ)
 *
 * H-2: ต้องลงท้ายด้วย "/" เพื่อ exact-prefix match ที่ถูกต้อง
 * (กัน "/admin_panel" match "/admin", "/api/webhooks/stripe_bypass" match "/api/webhooks/stripe")
 */
const SKIP_TENANT_PATH_PREFIXES = [
  "/_next/",
  "/favicon",
  "/api/webhooks/stripe/",
  "/api/webhooks/email/",
  "/admin/",
  "/marketing/",
  // MEDIUM-3: signup อยู่บน root domain (ไม่มี tenant context) — เพิ่มเป็น defense-in-depth
  // กัน getTenantContext() ถูกเรียกโดยไม่ตั้งใจในอนาคต (เช่น middleware ที่เพิ่มทีหลัง)
  "/api/auth/signup",
];

// =============================================================================
// CACHED TENANT DATA (เก็บเฉพาะ field ที่ middleware ต้องการ)
// =============================================================================

interface CachedTenant {
  id: string;
  plan: string; // plan name เช่น "starter", "pro"
}

// =============================================================================
// SECURITY HELPERS
// =============================================================================

/**
 * H-1: ลบ x-tenant-id และ x-tenant-plan ที่อาจส่งมาจาก client ออกก่อน pass ต่อ
 * ใช้แทน bare NextResponse.next() ทุกจุดที่ไม่ได้ผูก tenant context
 * กัน client แนบ header ปลอมผ่าน skip/unknown paths
 */
function nextWithoutTenantHeaders(request: NextRequest): NextResponse {
  const cleaned = new Headers(request.headers);
  cleaned.delete("x-tenant-id");
  cleaned.delete("x-tenant-plan");
  return NextResponse.next({ request: { headers: cleaned } });
}

// =============================================================================
// TENANT LOOKUP
// =============================================================================

/**
 * ค้นหา tenant จาก slug: Redis cache → DB → cache ผล
 * คืน null ถ้าไม่พบหรือ tenant ถูก deactivate
 */
async function lookupTenant(slug: string): Promise<CachedTenant | null> {
  const cacheKey = tenantSlugCacheKey(slug);

  // ลอง read จาก Redis cache ก่อน (เร็วกว่า DB query มาก)
  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) {
      // L-1: ใช้ sentinel แทน JSON.stringify(null) เพื่อแยก "not found" กับ cache miss
      if (cached === NOT_FOUND_SENTINEL) {
        return null;
      }
      return JSON.parse(cached) as CachedTenant;
    }
  } catch (redisErr) {
    // Redis ล่มไม่ควร block request — fallthrough ไป DB
    console.error("[proxy] Redis cache read error:", (redisErr as Error).message);
  }

  // Cache miss → query DB
  try {
    const tenant = await prisma.tenant.findFirst({
      where: { slug, isActive: true },
      select: {
        id: true,
        plan: { select: { name: true } },
      },
    });

    if (!tenant) {
      // ไม่พบ — cache sentinel สั้น ๆ เพื่อกัน DB flood (negative cache)
      // L-1: ใช้ NOT_FOUND_SENTINEL แทน "null" string
      try {
        await redis.set(cacheKey, NOT_FOUND_SENTINEL, "EX", 30);
      } catch {
        // ignore cache write error
      }
      return null;
    }

    const result: CachedTenant = {
      id: tenant.id,
      plan: tenant.plan.name,
    };

    // cache ผลสำเร็จ
    try {
      await redis.set(
        cacheKey,
        JSON.stringify(result),
        "EX",
        TENANT_CACHE_TTL_SECONDS
      );
    } catch {
      // ignore cache write error — ยังคืนผลได้
    }

    return result;
  } catch (dbErr) {
    // DB error — log แล้ว fail safe เป็น 500
    console.error("[proxy] DB lookup error:", (dbErr as Error).message);
    throw dbErr;
  }
}

// =============================================================================
// MAIN PROXY FUNCTION
// =============================================================================

/**
 * proxy function — Next.js 16.2 รัน function นี้ทุก request (Node.js runtime)
 * ชื่อ export ต้องเป็น "proxy" (ตาม Next.js proxy file convention)
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, hostname } = new URL(request.url);
  const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "helpwise.com";

  // H-2: ข้าม path ที่ไม่ต้องการ tenant context (assets, webhooks, admin)
  // match exact หรือมี "/" ตามหลัง prefix — กัน "/admin_panel" match "/admin/"
  const shouldSkip = SKIP_TENANT_PATH_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : p + "/")
  );
  if (shouldSkip) {
    // H-1: ลบ tenant headers ที่อาจส่งมาจาก client ก่อน pass ต่อ
    return nextWithoutTenantHeaders(request);
  }

  // แยก slug จาก hostname
  // รูปแบบ: {slug}.helpwise.com หรือ {slug}.localhost สำหรับ dev
  let slug: string | null = null;

  if (hostname === rootDomain || hostname === "localhost") {
    // root domain — ไม่มี tenant (marketing/landing page)
    // H-1: strip tenant headers จาก client
    return nextWithoutTenantHeaders(request);
  }

  if (hostname.endsWith(`.${rootDomain}`)) {
    slug = hostname.slice(0, -(rootDomain.length + 1));
  } else if (hostname.endsWith(".localhost")) {
    // development: acme.localhost
    slug = hostname.slice(0, -(".localhost".length));
  }

  // ไม่ใช่ subdomain ที่รู้จัก — ผ่านไป (อาจเป็น custom domain, Phase ถัดไป)
  // H-1: strip tenant headers จาก client
  if (!slug) {
    return nextWithoutTenantHeaders(request);
  }

  // validate slug format — กัน path traversal / injection
  if (!SLUG_REGEX.test(slug)) {
    return new NextResponse("Invalid tenant identifier", { status: 400 });
  }

  // ข้าม reserved subdomains
  // H-1: strip tenant headers จาก client
  if (RESERVED_SUBDOMAINS.has(slug)) {
    return nextWithoutTenantHeaders(request);
  }

  // Lookup tenant (Redis → DB)
  let tenant: CachedTenant | null;
  try {
    tenant = await lookupTenant(slug);
  } catch {
    return new NextResponse("Internal Server Error", { status: 500 });
  }

  if (!tenant) {
    return new NextResponse(`Tenant "${slug}" not found`, { status: 404 });
  }

  // ⚠️ SECURITY: เขียนทับ x-tenant-id + x-tenant-plan เสมอ
  // กัน client ส่ง header ปลอมเพื่อ tenant spoofing
  // Next.js NextResponse.next() + headers() เขียนทับ incoming request headers
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-tenant-id", tenant.id);
  requestHeaders.set("x-tenant-plan", tenant.plan);

  return NextResponse.next({
    request: { headers: requestHeaders },
  });
}

// =============================================================================
// PROXY CONFIG — matcher บอก Next.js ว่า path ไหนให้วิ่งผ่าน proxy
// =============================================================================

export const config = {
  // รัน proxy ทุก path ยกเว้น static files และ _next internals
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
