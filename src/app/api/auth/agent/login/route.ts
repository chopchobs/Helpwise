/**
 * POST /api/auth/agent/login
 * Agent (พนักงาน support) login ด้วย email + password
 *
 * Route นี้อยู่บน tenant subdomain — ต้องมี tenant context
 *
 * Security:
 *   - ทุกกรณีที่ fail (ไม่มี user / password ผิด / ไม่ใช่ member / deactivated)
 *     → return error เหมือนกัน "อีเมลหรือรหัสผ่านไม่ถูกต้อง" (กัน account/membership enumeration)
 *   - ภายใน log แยกได้สำหรับ security monitoring (log code แทน message)
 *
 * TODO (Phase: Rate Limiting):
 *   - ใส่ rate limit บน endpoint นี้ (เช่น 10 req/IP/5 นาที) ก่อน production
 *   - พิจารณา account lockout หลังล้มเกิน N ครั้ง
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { tenantPrisma, getTenantContext } from "@/lib/tenant";
import { verifyPassword, DUMMY_HASH } from "@/lib/password";
import { issueAgentToken, setAgentCookie, toAuthErrorResponse } from "@/lib/auth";
import { audit } from "@/lib/audit";

// =============================================================================
// VALIDATION SCHEMA
// =============================================================================

const loginSchema = z.object({
  email: z.string().email("รูปแบบ email ไม่ถูกต้อง"),
  password: z.string().min(1, "กรุณากรอก password"),
});

// error message เดียวสำหรับทุกกรณีที่ fail — กัน enumeration
const GENERIC_LOGIN_ERROR = "อีเมลหรือรหัสผ่านไม่ถูกต้อง";

// BLOCKER-1: DUMMY_HASH import จาก @/lib/password เพื่อใช้ constant เดียวกับ signup route

// =============================================================================
// ROUTE HANDLER
// =============================================================================

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // 1. ดึง tenant context จาก middleware-injected header (ห้ามรับจาก client)
    const ctx = await getTenantContext();

    // 2. Parse + validate input
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { data: null, error: { code: "INVALID_JSON", message: "Request body ต้องเป็น JSON" } },
        { status: 400 }
      );
    }

    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "VALIDATION_ERROR",
            message: parsed.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง",
          },
        },
        { status: 400 }
      );
    }

    const { email, password } = parsed.data;

    // 3. หา User จาก email (global model — ใช้ prisma ไม่ใช่ tenantPrisma)
    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        passwordHash: true,
        isActive: true,
      },
    });

    // กรณี: ไม่พบ user หรือ passwordHash เป็น null (OAuth-only account) —
    // รัน dummy verify ด้วย DUMMY_HASH เพื่อ normalize เวลา ~250ms กัน timing oracle
    if (!user || !user.passwordHash) {
      await verifyPassword(password, DUMMY_HASH);
      console.warn("[agent:login] fail:no_user_or_no_password_hash", { tenantId: ctx.tenantId });
      return NextResponse.json(
        { data: null, error: { code: "LOGIN_FAILED", message: GENERIC_LOGIN_ERROR } },
        { status: 401 }
      );
    }

    // 4. ตรวจ password
    const passwordValid = await verifyPassword(password, user.passwordHash);
    if (!passwordValid) {
      console.warn("[agent:login] fail:invalid_password", { tenantId: ctx.tenantId, userId: user.id });
      return NextResponse.json(
        { data: null, error: { code: "LOGIN_FAILED", message: GENERIC_LOGIN_ERROR } },
        { status: 401 }
      );
    }

    // 5. ตรวจ User.isActive
    if (!user.isActive) {
      console.warn("[agent:login] fail:user_inactive", { tenantId: ctx.tenantId, userId: user.id });
      return NextResponse.json(
        { data: null, error: { code: "LOGIN_FAILED", message: GENERIC_LOGIN_ERROR } },
        { status: 401 }
      );
    }

    // 6. ตรวจว่า User เป็น TenantMember ของ tenant นี้ + isActive
    //    ใช้ tenantPrisma เพื่อ enforce tenant scope (tenantId inject อัตโนมัติ)
    const db = tenantPrisma(ctx.tenantId);
    const member = await db.tenantMember.findFirst({
      where: { userId: user.id, isActive: true },
      select: { id: true, role: true },
    });

    if (!member) {
      console.warn("[agent:login] fail:not_member_or_inactive", { tenantId: ctx.tenantId, userId: user.id });
      return NextResponse.json(
        { data: null, error: { code: "LOGIN_FAILED", message: GENERIC_LOGIN_ERROR } },
        { status: 401 }
      );
    }

    // 7. ออก JWT + set cookie
    const token = await issueAgentToken(user.id);
    await setAgentCookie(token);

    // HIGH-1: บันทึก audit log หลัง login สำเร็จ (soft-fail — ไม่ block response)
    // ห้าม log password, JWT, หรือ sensitive fields
    try {
      await audit.log({
        tenantId: ctx.tenantId,
        actor: { type: "user", userId: user.id },
        targetType: "user",
        targetId: user.id,
        action: "agent.login",
        metadata: { memberId: member.id, role: member.role },
      });
    } catch (auditErr) {
      console.error("[agent:login] audit.log failed:", auditErr instanceof Error ? auditErr.message : String(auditErr));
    }

    // 8. Return user info + role (ไม่ return passwordHash หรือ sensitive fields)
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
    console.error("[agent:login] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
