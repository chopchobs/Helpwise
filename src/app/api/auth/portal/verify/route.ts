/**
 * POST /api/auth/portal/verify
 * Contact magic-link verify — แลก one-time token เป็น session cookie
 *
 * Route นี้อยู่บน tenant subdomain — ต้องมี tenant context
 *
 * Security:
 *   - Token one-time: ใช้ GETDEL (atomic get+delete) → ใช้ซ้ำไม่ได้
 *   - hash token ก่อน lookup (ไม่เก็บ raw token ใน Redis)
 *   - ตรวจ tenantId ของ Contact ตรงกับ tenant context (defense in depth)
 *   - token หมดอายุ / ไม่พบ → 401 generic error
 *
 * TODO (Phase: Rate Limiting):
 *   - ใส่ rate limit: เช่น 10 req/IP/5 นาที เพื่อกัน token brute force
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantContext, tenantPrisma } from "@/lib/tenant";
import { redis } from "@/lib/redis";
import { issueContactToken, setContactCookie, toAuthErrorResponse } from "@/lib/auth";
import { audit } from "@/lib/audit";
// LOW-1: import shared helpers แทนการ define ซ้ำ (กัน key drift ระหว่าง request-link และ verify)
import { hashToken, magicLinkKey } from "@/lib/magic-link";

// =============================================================================
// VALIDATION SCHEMA
// =============================================================================

const verifySchema = z.object({
  token: z.string().min(1, "token ห้ามว่าง"),
});

// =============================================================================
// ROUTE HANDLER
// =============================================================================

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // 1. ดึง tenant context จาก middleware header
    const ctx = await getTenantContext();

    // 2. Parse + validate
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { data: null, error: { code: "UNAUTHORIZED", message: "Token ไม่ถูกต้องหรือหมดอายุ" } },
        { status: 401 }
      );
    }

    const parsed = verifySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { data: null, error: { code: "UNAUTHORIZED", message: "Token ไม่ถูกต้องหรือหมดอายุ" } },
        { status: 401 }
      );
    }

    const { token } = parsed.data;

    // 3. hash token + lookup + consume แบบ atomic (GETDEL)
    //    GETDEL: อ่านและลบใน operation เดียว → one-time guarantee
    const tokenHash = hashToken(token);
    const redisKey = magicLinkKey(ctx.tenantId, tokenHash);

    // ioredis ไม่มี method getdel โดยตรงก่อน Redis 6.2 — ใช้ pipeline แทน
    // getdel: atomic บน Redis single-threaded
    const contactId = await redis.getdel(redisKey);

    if (!contactId) {
      // token หมดอายุ หรือ ถูกใช้ไปแล้ว หรือ ไม่เคยมีอยู่
      return NextResponse.json(
        { data: null, error: { code: "UNAUTHORIZED", message: "Token ไม่ถูกต้องหรือหมดอายุ" } },
        { status: 401 }
      );
    }

    // 4. โหลด Contact จาก DB — ตรวจ tenant scope + isActive
    const db = tenantPrisma(ctx.tenantId);
    const contact = await db.contact.findUnique({
      where: { id: contactId },
      select: { id: true, tenantId: true, isActive: true },
    });

    if (!contact || !contact.isActive) {
      return NextResponse.json(
        { data: null, error: { code: "UNAUTHORIZED", message: "Token ไม่ถูกต้องหรือหมดอายุ" } },
        { status: 401 }
      );
    }

    // Defense in depth: tenantId ของ Contact ต้องตรงกับ tenant context
    // tenantPrisma inject tenantId ไว้แล้ว แต่ตรวจซ้ำเพื่อความชัดเจน
    if (contact.tenantId !== ctx.tenantId) {
      console.error("[portal:verify] tenant mismatch — contact.tenantId !== ctx.tenantId", {
        contactTenantId: contact.tenantId,
        ctxTenantId: ctx.tenantId,
      });
      return NextResponse.json(
        { data: null, error: { code: "UNAUTHORIZED", message: "Token ไม่ถูกต้องหรือหมดอายุ" } },
        { status: 401 }
      );
    }

    // 5. ออก JWT session token + set cookie
    const sessionToken = await issueContactToken(contact.id, ctx.tenantId);
    await setContactCookie(sessionToken);

    // HIGH-1: บันทึก audit log หลัง contact login สำเร็จ (soft-fail — ไม่ block response)
    // ห้าม log token หรือ sensitive fields
    try {
      await audit.log({
        tenantId: ctx.tenantId,
        actor: { type: "contact", contactId: contact.id },
        targetType: "contact",
        targetId: contact.id,
        action: "contact.login",
      });
    } catch (auditErr) {
      console.error("[portal:verify] audit.log failed:", auditErr instanceof Error ? auditErr.message : String(auditErr));
    }

    return NextResponse.json({ data: { ok: true }, error: null }, { status: 200 });
  } catch (err) {
    console.error("[portal:verify] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
