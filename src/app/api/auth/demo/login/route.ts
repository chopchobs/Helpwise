/**
 * POST /api/auth/demo/login
 * One-click demo login สำหรับ portfolio demo — visitor login เป็น demo agent ได้ทันที
 * โดยไม่ต้องกรอก credentials (creds เป็น public-by-design ดู src/lib/demo.ts)
 *
 * Route นี้อยู่บน tenant subdomain — ต้องมี tenant context
 *
 * Security / กันการ abuse:
 *   - ⚠️ ทำงาน "เฉพาะ demo tenant" (slug ∈ DEMO_TENANT_SLUGS) เท่านั้น — บน tenant จริง = 404
 *   - ⚠️ Defense-in-depth: ยืนยัน member.role === "AGENT" เสมอ — creds เป็น public
 *     ห้ามให้ session ที่ role สูงกว่า AGENT (OWNER/ADMIN) หลุดออกไป แม้ seed ตั้ง AGENT แล้ว
 *   - ไม่รับ tenantId / credentials จาก client — tenant จาก context, creds จาก src/lib/demo.ts
 *   - Rate limit ตาม IP (fail-open เหมือน agent-login — login ไม่ใช่ cost-bearing)
 *   - reuse login logic เดียวกับ /api/auth/agent/login (verifyPassword, membership, token, cookie)
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { tenantPrisma, getTenantContext } from "@/lib/tenant";
import { verifyPassword } from "@/lib/password";
import { issueAgentToken, setAgentCookie, toAuthErrorResponse } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { checkRateLimit, getClientIp, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { DEMO_AGENTS, DEMO_PASSWORD, DEMO_TENANT_SLUGS } from "@/lib/demo";

// error เดียวสำหรับทุกกรณีที่ login ไม่สำเร็จ (เช่น ยังไม่ seed) — ไม่ leak รายละเอียด
const DEMO_LOGIN_ERROR = "ไม่สามารถเข้าสู่ระบบ demo ได้ในขณะนี้";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // 0. Rate limit ตาม IP — กัน abuse (fail-open: login ไม่ใช่ cost-bearing เหมือน AI)
    const ip = getClientIp(request);
    const rl = await checkRateLimit({
      key: rateLimitKey("demo-login", ip),
      limit: 10,
      windowSeconds: 60,
    });
    if (!rl.allowed) {
      return rateLimitResponse(rl.retryAfterSeconds);
    }

    // 1. ดึง tenant context จาก middleware-injected header (ห้ามรับจาก client)
    const ctx = await getTenantContext();

    // 2. lookup slug ของ tenant ปัจจุบัน (Tenant เป็น tenant model — query โดย id จาก context)
    const tenant = await prisma.tenant.findUnique({
      where: { id: ctx.tenantId },
      select: { slug: true },
    });

    // 3. ⚠️ Demo guard — endpoint นี้ใช้ได้เฉพาะ demo tenant เท่านั้น
    //    บน tenant จริง → 404 (เสมือน route ไม่มีอยู่) กัน abuse one-click login บน tenant จริง
    if (!tenant || !(DEMO_TENANT_SLUGS as readonly string[]).includes(tenant.slug)) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ endpoint ที่ระบุ" } },
        { status: 404 }
      );
    }

    // 4. หา demo agent creds ของ tenant นี้ (จาก single source of truth — ไม่รับจาก client)
    const demoAgent = DEMO_AGENTS.find((a) => a.tenantSlug === tenant.slug);
    if (!demoAgent) {
      console.warn("[demo:login] no demo agent configured for slug", { slug: tenant.slug });
      return NextResponse.json(
        { data: null, error: { code: "DEMO_LOGIN_FAILED", message: DEMO_LOGIN_ERROR } },
        { status: 503 }
      );
    }

    // 5. หา User ของ demo agent (global model — ใช้ prisma ไม่ใช่ tenantPrisma)
    const user = await prisma.user.findUnique({
      where: { email: demoAgent.email },
      select: { id: true, email: true, name: true, passwordHash: true, isActive: true },
    });

    // ยังไม่ seed / ไม่มี passwordHash → ไม่ leak (503 — config/seed ฝั่ง server ไม่พร้อม)
    if (!user || !user.passwordHash) {
      console.warn("[demo:login] fail:no_user_or_no_password_hash", { tenantId: ctx.tenantId });
      return NextResponse.json(
        { data: null, error: { code: "DEMO_LOGIN_FAILED", message: DEMO_LOGIN_ERROR } },
        { status: 503 }
      );
    }

    // 6. ตรวจ password (จาก DEMO_PASSWORD — public-by-design) + User.isActive
    const passwordValid = await verifyPassword(DEMO_PASSWORD, user.passwordHash);
    if (!passwordValid || !user.isActive) {
      console.warn("[demo:login] fail:invalid_password_or_inactive", { tenantId: ctx.tenantId, userId: user.id });
      return NextResponse.json(
        { data: null, error: { code: "DEMO_LOGIN_FAILED", message: DEMO_LOGIN_ERROR } },
        { status: 503 }
      );
    }

    // 7. ตรวจ membership ของ tenant นี้ (tenantPrisma inject tenantId อัตโนมัติ — tenant scope)
    const db = tenantPrisma(ctx.tenantId);
    const member = await db.tenantMember.findFirst({
      where: { userId: user.id, isActive: true },
      select: { id: true, role: true },
    });

    if (!member) {
      console.warn("[demo:login] fail:not_member_or_inactive", { tenantId: ctx.tenantId, userId: user.id });
      return NextResponse.json(
        { data: null, error: { code: "DEMO_LOGIN_FAILED", message: DEMO_LOGIN_ERROR } },
        { status: 503 }
      );
    }

    // 8. ⚠️ Defense-in-depth: ยืนยัน role === "AGENT" เท่านั้น — creds เป็น public
    //    ถ้า seed/DB ผิดพลาดเป็น role สูงกว่า → ปฏิเสธ ไม่ออก session ที่ privilege เกิน
    if (member.role !== "AGENT") {
      console.warn("[demo:login] fail:role_not_agent", { tenantId: ctx.tenantId, userId: user.id, role: member.role });
      return NextResponse.json(
        { data: null, error: { code: "DEMO_LOGIN_FAILED", message: DEMO_LOGIN_ERROR } },
        { status: 403 }
      );
    }

    // 9. ออก JWT + set cookie (เหมือน agent-login)
    const token = await issueAgentToken(user.id);
    await setAgentCookie(token);

    // 10. Audit log (soft-fail — ไม่ block response; ห้าม log password/token)
    try {
      await audit.log({
        tenantId: ctx.tenantId,
        actor: { type: "user", userId: user.id },
        targetType: "user",
        targetId: user.id,
        action: "agent.login",
        metadata: { demo: true, memberId: member.id, role: member.role },
      });
    } catch (auditErr) {
      console.error("[demo:login] audit.log failed:", auditErr instanceof Error ? auditErr.message : String(auditErr));
    }

    // 11. Return user info + role (ไม่ return passwordHash หรือ sensitive fields)
    return NextResponse.json(
      {
        data: {
          user: { id: user.id, email: user.email, name: user.name ?? null },
          role: member.role,
        },
        error: null,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("[demo:login] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
