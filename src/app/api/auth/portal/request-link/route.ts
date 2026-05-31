/**
 * POST /api/auth/portal/request-link
 * Contact magic-link: ขอ link สำหรับ login ไปยัง email ของ contact
 *
 * Route นี้อยู่บน tenant subdomain — ต้องมี tenant context
 *
 * Security:
 *   - Anti-enumeration: คืน { data: { sent: true } } เสมอ ไม่ว่าจะเจอ email หรือไม่
 *   - Magic-link token = opaque random 32 bytes (256 bit) — ไม่ใช่ JWT
 *   - เก็บ sha256(token) ลง Redis (ไม่เก็บ raw token) + TTL 15 นาที + one-time
 *   - ตัว token ดิบส่งใน URL เท่านั้น ไม่เก็บ raw ใน server
 *
 * TODO (Phase: Rate Limiting):
 *   - ใส่ rate limit: เช่น 3 req/email/15 นาที เพื่อกัน magic-link spam
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import { getTenantContext, tenantPrisma } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/redis";
import { sendMagicLink } from "@/lib/email";
import { toAuthErrorResponse } from "@/lib/auth";
// LOW-1: import shared helpers แทนการ define ซ้ำ (กัน key drift ระหว่าง request-link และ verify)
import { hashToken, magicLinkKey } from "@/lib/magic-link";

// =============================================================================
// CONSTANTS
// =============================================================================

/** TTL ของ magic-link token (วินาที) — 15 นาที */
const MAGIC_LINK_TTL_SECONDS = 15 * 60;

// =============================================================================
// VALIDATION SCHEMA
// =============================================================================

const requestLinkSchema = z.object({
  email: z.string().email("รูปแบบ email ไม่ถูกต้อง"),
});

// =============================================================================
// ROUTE HANDLER
// =============================================================================

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // 1. ดึง tenant context (tenantId + plan) จาก middleware header
    const ctx = await getTenantContext();

    // 2. Parse + validate
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      // anti-enumeration: ไม่เปิดเผยว่า request ผิดรูปแบบ — คืน sent: true เสมอ
      return NextResponse.json({ data: { sent: true }, error: null }, { status: 200 });
    }

    const parsed = requestLinkSchema.safeParse(body);
    if (!parsed.success) {
      // anti-enumeration: ไม่บอกว่า email format ผิด
      return NextResponse.json({ data: { sent: true }, error: null }, { status: 200 });
    }

    const { email } = parsed.data;

    // 3. ดึง slug ของ tenant เพื่อสร้าง magic-link URL
    //    slug อยู่ใน Tenant model — query จาก prisma โดยตรง (Tenant ไม่ใช่ tenant-scoped model ของ tenantPrisma)
    const tenant = await prisma.tenant.findUnique({
      where: { id: ctx.tenantId },
      select: { slug: true },
    });

    if (!tenant) {
      // tenant ไม่ควรไม่เจอ ณ จุดนี้ (middleware ผ่านแล้ว) — log + return generic
      console.error("[portal:request-link] Tenant not found for tenantId:", ctx.tenantId);
      return NextResponse.json({ data: { sent: true }, error: null }, { status: 200 });
    }

    // 4. Find-or-create Contact แบบ atomic ด้วย upsert
    //    HIGH-2: findFirst+create แยกกัน → race condition ถ้า 2 request พร้อมกัน
    //    ทำให้เกิด unique constraint violation บน (tenantId, email)
    //    upsert atomic กว่า: where ใช้ composite unique key ชื่อ tenantId_email
    const db = tenantPrisma(ctx.tenantId);
    const contact = await db.contact.upsert({
      where: { tenantId_email: { tenantId: ctx.tenantId, email } },
      create: { email, tenantId: ctx.tenantId },
      update: {},
      select: { id: true, isActive: true },
    });

    // ตรวจ contact ที่ถูก deactivate — ไม่ส่ง link แต่ response เหมือนกัน (anti-enumeration)
    if (!contact.isActive) {
      console.warn("[portal:request-link] contact inactive", { tenantId: ctx.tenantId });
      return NextResponse.json({ data: { sent: true }, error: null }, { status: 200 });
    }

    // 5. สร้าง opaque token 32 bytes (256 bit) random
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(rawToken);

    // 6. เก็บ hash ลง Redis พร้อม TTL 15 นาที
    //    value = contactId เพื่อ lookup หลัง verify
    await redis.set(
      magicLinkKey(ctx.tenantId, tokenHash),
      contact.id,
      "EX",
      MAGIC_LINK_TTL_SECONDS
    );

    // 7. สร้าง magic-link URL (slug มาจาก DB, ROOT_DOMAIN มาจาก env)
    //    HIGH-3: ใช้ fragment (#token=) แทน query string (?token=)
    //    → fragment ไม่ถูกส่งไปยัง server ดังนั้นไม่ปรากฏใน access log / Referrer header
    //    → frontend อ่าน token จาก location.hash แล้ว POST เข้า /api/auth/portal/verify ใน body
    const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "helpwise.com";
    const magicLinkUrl = `https://${tenant.slug}.${rootDomain}/portal/verify#token=${rawToken}`;

    // 8. ส่ง email (stub ใน dev — log URL ออก console)
    // ⚠️ ไม่ await throw ถ้า email ล้มเหลว — log แล้วดำเนินต่อ (anti-enumeration)
    try {
      await sendMagicLink(email, magicLinkUrl);
    } catch (emailErr) {
      console.error("[portal:request-link] sendMagicLink failed:", emailErr instanceof Error ? emailErr.message : String(emailErr));
    }

    // 9. Anti-enumeration: คืน sent: true เสมอไม่ว่าจะเกิดอะไร
    return NextResponse.json({ data: { sent: true }, error: null }, { status: 200 });
  } catch (err) {
    console.error("[portal:request-link] Unexpected error:", err instanceof Error ? err.message : String(err));
    // anti-enumeration: ไม่ expose error ใด ๆ
    return NextResponse.json({ data: { sent: true }, error: null }, { status: 200 });
  }
}
