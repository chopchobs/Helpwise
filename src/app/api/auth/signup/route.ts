/**
 * POST /api/auth/signup
 * Tenant onboarding — สร้าง Tenant + Owner + Subscription ใน transaction เดียว
 *
 * ⚠️ route นี้อยู่บน root domain (ไม่มี tenant context) — ห้ามเรียก getTenantContext()
 *
 * Security:
 *   - ไม่รับ tenantId / planId จาก client — ดึง plan "starter" จาก DB
 *   - กรณี email ซ้ำ: ตรวจ password ตรงหรือไม่ก่อนผูก TenantMember ใหม่
 *     → ถ้าไม่ตรง: return generic error (ไม่เปิดเผยว่า email มีอยู่แล้ว)
 *   - slug: validate regex + reserved list + unique
 *   - Rate limit ตาม IP (5 req/60s) กัน automated signup — ดู step 0
 *
 * TODO (follow-up):
 *   - พิจารณา CAPTCHA สำหรับป้องกัน automated signup ที่ซับซ้อนขึ้น
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword, verifyPassword, DUMMY_HASH } from "@/lib/password";
import { audit } from "@/lib/audit";
import { toAuthErrorResponse, AuthError } from "@/lib/auth";
import { checkRateLimit, getClientIp, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";

// =============================================================================
// VALIDATION SCHEMA
// =============================================================================

/** slug ที่ห้ามใช้ (reserved subdomain) */
const RESERVED_SLUGS = new Set([
  "www", "app", "api", "admin", "mail", "ftp", "smtp",
  "help", "support", "billing", "portal", "status", "blog",
]);

const signupSchema = z.object({
  companyName: z.string().min(1, "ชื่อบริษัทห้ามว่าง").max(100),
  // slug: lowercase alphanumeric + hyphen, 3-50 ตัวอักษร
  slug: z
    .string()
    .min(3, "slug ต้องมีอย่างน้อย 3 ตัวอักษร")
    .max(50, "slug ยาวเกิน 50 ตัวอักษร")
    .regex(/^[a-z0-9-]+$/, "slug ใช้ได้เฉพาะตัวเล็ก, ตัวเลข, และ hyphen"),
  email: z.string().email("รูปแบบ email ไม่ถูกต้อง"),
  password: z
    .string()
    .min(8, "password ต้องมีอย่างน้อย 8 ตัวอักษร")
    .max(128, "password ยาวเกินไป"),
  name: z.string().min(1, "ชื่อผู้ใช้ห้ามว่าง").max(100).optional(),
});

// =============================================================================
// ROUTE HANDLER
// =============================================================================

export async function POST(request: Request): Promise<NextResponse> {
  try {
    // 0. Rate limit ตาม IP — กัน automated signup spam
    const ip = getClientIp(request);
    const rl = await checkRateLimit({
      key: rateLimitKey("signup", ip),
      limit: 5,
      windowSeconds: 60,
    });
    if (!rl.allowed) {
      return rateLimitResponse(rl.retryAfterSeconds);
    }

    // 1. Parse + validate input
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { data: null, error: { code: "INVALID_JSON", message: "Request body ต้องเป็น JSON" } },
        { status: 400 }
      );
    }

    const parsed = signupSchema.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues;
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "VALIDATION_ERROR",
            message: issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง",
            details: issues,
          },
        },
        { status: 400 }
      );
    }

    const { companyName, slug, email, password, name } = parsed.data;

    // 2. ตรวจ reserved slug
    if (RESERVED_SLUGS.has(slug)) {
      return NextResponse.json(
        { data: null, error: { code: "SLUG_RESERVED", message: "slug นี้ไม่สามารถใช้ได้" } },
        { status: 400 }
      );
    }

    // 3. ตรวจ slug unique — query ก่อน transaction เพื่อ error ที่ชัดเจน
    const existingTenant = await prisma.tenant.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (existingTenant) {
      return NextResponse.json(
        { data: null, error: { code: "SLUG_TAKEN", message: "slug นี้ถูกใช้ไปแล้ว กรุณาเลือก slug อื่น" } },
        { status: 409 }
      );
    }

    // 4. หา default plan "starter" — ไม่รับ planId จาก client
    const starterPlan = await prisma.plan.findFirst({
      where: { name: "starter", isActive: true },
      select: { id: true },
    });

    // handle gracefully: ถ้าไม่มี plan "starter" ใน DB ให้แจ้ง error ที่ชัดเจน (config ผิด)
    if (!starterPlan) {
      console.error("[signup] Plan 'starter' not found in database — please seed the plans table");
      return NextResponse.json(
        { data: null, error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
        { status: 500 }
      );
    }

    // 5. Transaction: สร้าง Tenant + Subscription + User/TenantMember atomically
    const result = await prisma.$transaction(async (tx) => {
      // --- User: find or create ---
      let user = await tx.user.findUnique({
        where: { email },
        select: { id: true, passwordHash: true, isActive: true },
      });

      if (user) {
        // email ซ้ำ: ตรวจ password ก่อนผูก TenantMember ใหม่
        // ถ้า password ไม่ตรง → generic error (ไม่เปิดเผยว่า email มีอยู่แล้ว)
        //
        // MEDIUM-2: ถ้า passwordHash เป็น null (OAuth-only account) ให้รัน dummy verify
        // เพื่อ normalize เวลา ~250ms — กัน timing leak ว่าบัญชีเป็น OAuth-only
        let passwordValid: boolean;
        if (user.passwordHash !== null) {
          passwordValid = await verifyPassword(password, user.passwordHash);
        } else {
          await verifyPassword(password, DUMMY_HASH); // normalize timing
          passwordValid = false;
        }

        if (!passwordValid) {
          // ส่ง generic error — ไม่บอกว่า email มีอยู่หรือ password ผิด
          // ใช้ 401 เพราะ AuthError รับเฉพาะ 401 | 403
          throw new AuthError("ไม่สามารถสร้างบัญชีได้ กรุณาตรวจสอบข้อมูล", 401);
        }
      } else {
        // สร้าง User ใหม่
        const passwordHash = await hashPassword(password);
        user = await tx.user.create({
          data: {
            email,
            name: name ?? null,
            passwordHash,
          },
          select: { id: true, passwordHash: true, isActive: true },
        });
      }

      // --- Tenant ---
      const tenant = await tx.tenant.create({
        data: {
          slug,
          name: companyName,
          planId: starterPlan.id,
        },
        select: { id: true, slug: true },
      });

      // --- Subscription (TRIALING) ---
      await tx.subscription.create({
        data: {
          tenantId: tenant.id,
          status: "TRIALING",
        },
      });

      // --- TenantMember (OWNER) ---
      const member = await tx.tenantMember.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          role: "OWNER",
          isActive: true,
        },
        select: { id: true },
      });

      // --- Default SlaPolicy ---
      // สร้าง policy ค่า default ให้ tenant ใหม่ทุกราย (isDefault: true)
      // column minutes ปล่อยเป็น @default ใน schema — ไม่ต้อง hardcode ค่า
      // feature gate จะตรวจ sla_policies ตาม plan ก่อนใช้ policy นี้
      await tx.slaPolicy.create({
        data: {
          tenantId: tenant.id,
          name: "Standard SLA",
          isDefault: true,
        },
      });

      return { tenant, userId: user.id, memberId: member.id };
    });

    // 6. AuditLog หลัง transaction สำเร็จ
    //    LOW-3: ห่อด้วย try/catch เพื่อ soft-fail — ถ้า log ล้มเหลวไม่ควร return 500
    //    เพราะ signup สำเร็จแล้ว (transaction commit แล้ว)
    try {
      await audit.log({
        tenantId: result.tenant.id,
        actor: { type: "user", userId: result.userId },
        targetType: "tenant",
        targetId: result.tenant.id,
        action: "tenant.created",
        after: { slug: result.tenant.slug, companyName },
      });
    } catch (auditErr) {
      console.error("[signup] audit.log failed:", auditErr instanceof Error ? auditErr.message : String(auditErr));
    }

    // 7. Return slug เพื่อให้ frontend redirect ไป {slug}.helpwise.com/login
    //    ไม่ auto-login เพราะ cookie คนละ domain (root vs subdomain)
    return NextResponse.json(
      { data: { slug: result.tenant.slug }, error: null },
      { status: 201 }
    );
  } catch (err) {
    // AuthError ที่ throw ออกมาจาก transaction (เช่น email ซ้ำ + password ไม่ตรง)
    if (err instanceof AuthError) {
      // email ซ้ำ + password ไม่ตรง → return 400 (ไม่ใช่ 401) ที่ HTTP level แม้ AuthError เก็บ 401
      return NextResponse.json(
        { data: null, error: { code: "SIGNUP_FAILED", message: err.message } },
        { status: 400 }
      );
    }

    // Prisma unique constraint violation (race condition บน slug)
    if (
      err instanceof Error &&
      err.message.includes("Unique constraint") &&
      err.message.includes("slug")
    ) {
      return NextResponse.json(
        { data: null, error: { code: "SLUG_TAKEN", message: "slug นี้ถูกใช้ไปแล้ว กรุณาเลือก slug อื่น" } },
        { status: 409 }
      );
    }

    // error อื่น ๆ — ไม่ expose detail
    console.error("[signup] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
