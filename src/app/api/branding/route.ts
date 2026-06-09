/**
 * GET  /api/branding — ดึงการตั้งค่า branding ปัจจุบันของ tenant (สำหรับหน้า settings)
 * PATCH /api/branding — อัปเดต logoUrl และ/หรือ accentColor
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() → ctx.tenantId เท่านั้น ห้ามรับจาก client
 *   - Tenant query ใช้ base prisma (Tenant ไม่มีคอลัมน์ tenantId — PK คือ id)
 *     แต่ where: { id: ctx.tenantId } เสมอ — tenant-scoped via verified context
 *
 * ⚠️ Feature Gate:
 *   - PATCH ต้องผ่าน hasFeature(CUSTOM_BRANDING) → 403 FEATURE_LOCKED ถ้าปิด
 *   - GET ไม่ gate feature (ต้องโชว์สถานะ brandingEnabled บนหน้า settings ได้เสมอ)
 *
 * ⚠️ Security:
 *   - logoUrl: https-only (กัน SSRF + XSS ผ่าน <img src>)
 *   - accentColor: 6-digit hex only (กัน CSS injection ผ่าน CSS custom property)
 *   - PATCH: ค่าที่ส่งมาแต่ invalid → 400 VALIDATION_ERROR (ไม่ silent null)
 *   - null ที่ส่งมาใน PATCH = ลบค่าออก (clear field)
 *
 * ⚠️ Merge-safe:
 *   - PATCH อ่าน settings เดิม → spread → เปลี่ยนเฉพาะ branding key
 *   - businessHours และ key อื่น ๆ ใน Tenant.settings ไม่ถูกแตะ
 *
 * Audience: requireAgent({ roles: ["OWNER","ADMIN"] }) — admin-only
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import {
  parseBranding,
  validateLogoUrl,
  validateAccentColor,
} from "@/lib/branding";

// =============================================================================
// ZOD SCHEMA — ใช้ validators จาก lib/branding เพื่อไม่ duplicate logic
// =============================================================================

/**
 * PATCH body schema:
 *   - logoUrl และ accentColor เป็น optional (ไม่ต้องส่งทั้งคู่)
 *   - null = ลบค่าออกจาก branding
 *   - string ที่ไม่ผ่าน validation → 400 (ไม่ silent null เหมือน read path)
 */
const patchBrandingSchema = z.object({
  logoUrl: z
    .union([
      z
        .string()
        .refine(
          (v) => validateLogoUrl(v) !== null,
          "logoUrl ต้องเป็น URL https:// ที่ valid และยาวไม่เกิน 2048 ตัวอักษร"
        ),
      z.null(),
    ])
    .optional(),
  accentColor: z
    .union([
      z
        .string()
        .refine(
          (v) => validateAccentColor(v) !== null,
          "accentColor ต้องเป็น hex color 6 หลัก เช่น #C4652A"
        ),
      z.null(),
    ])
    .optional(),
});

type PatchBrandingInput = z.infer<typeof patchBrandingSchema>;

// =============================================================================
// GET /api/branding — ดึง branding ปัจจุบัน + สถานะ feature
// =============================================================================

export async function GET(): Promise<NextResponse> {
  try {
    // 1. Auth gate — OWNER/ADMIN เท่านั้น
    const session = await requireAgent({ roles: ["OWNER", "ADMIN"] });
    const { ctx } = session;
    const tenantId = ctx.tenantId; // ห้ามรับ tenantId จาก client

    // 2. ตรวจ feature — GET ไม่ block แต่ต้อง return brandingEnabled ด้วย
    const brandingEnabled = await hasFeature(
      tenantId,
      FEATURE_KEYS.CUSTOM_BRANDING,
      ctx.plan
    );

    // 3. Query Tenant settings — ใช้ base prisma เพราะ Tenant ไม่มี tenantId column
    //    แต่ where: { id: tenantId } ที่มาจาก verified context — tenant-scoped เสมอ
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });

    if (!tenant) {
      return NextResponse.json(
        {
          data: null,
          error: { code: "TENANT_NOT_FOUND", message: "ไม่พบข้อมูล workspace" },
        },
        { status: 404 }
      );
    }

    // 4. Parse branding ผ่าน shared helper (https-only, hex-only)
    const { logoUrl, accentColor } = parseBranding(tenant.settings);

    return NextResponse.json(
      {
        data: { logoUrl, accentColor, brandingEnabled },
        error: null,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error(
      "[GET /api/branding] Unexpected error:",
      err instanceof Error ? err.message : String(err)
    );
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}

// =============================================================================
// PATCH /api/branding — อัปเดต branding (merge-safe, feature-gated, audited)
// =============================================================================

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    // 1. Auth gate — OWNER/ADMIN เท่านั้น
    const session = await requireAgent({ roles: ["OWNER", "ADMIN"] });
    const { ctx, member } = session;
    const tenantId = ctx.tenantId; // ห้ามรับ tenantId จาก client

    // 2. Feature gate — custom_branding ต้องเปิด (ห้าม hardcode plan check)
    const brandingEnabled = await hasFeature(
      tenantId,
      FEATURE_KEYS.CUSTOM_BRANDING,
      ctx.plan
    );
    if (!brandingEnabled) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "FEATURE_LOCKED",
            message:
              "Custom Branding ไม่รวมอยู่ใน plan ปัจจุบัน กรุณา upgrade เพื่อใช้งาน",
          },
        },
        { status: 403 }
      );
    }

    // 3. Parse request body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        {
          data: null,
          error: { code: "INVALID_JSON", message: "Request body ต้องเป็น JSON" },
        },
        { status: 400 }
      );
    }

    // 4. Validate input — invalid value → 400 (ไม่ silent null เหมือน read path)
    //    null ที่ส่งมา = ต้องการลบค่านั้นออก
    const parsed = patchBrandingSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "VALIDATION_ERROR",
            message:
              parsed.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง",
          },
        },
        { status: 400 }
      );
    }

    const input: PatchBrandingInput = parsed.data;

    // ถ้าไม่มี field ใดส่งมาเลย → ไม่มีอะไรจะ update
    if (input.logoUrl === undefined && input.accentColor === undefined) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "VALIDATION_ERROR",
            message: "ต้องระบุ logoUrl หรือ accentColor อย่างน้อย 1 field",
          },
        },
        { status: 400 }
      );
    }

    // 5. Read current settings — ต้องทำก่อนเสมอเพื่อ merge-safe write
    //    ป้องกันการเขียนทับ businessHours หรือ key อื่น ๆ ใน settings
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });

    if (!tenant) {
      return NextResponse.json(
        {
          data: null,
          error: { code: "TENANT_NOT_FOUND", message: "ไม่พบข้อมูล workspace" },
        },
        { status: 404 }
      );
    }

    // 6. Merge branding เข้า settings เดิมอย่าง safe
    //    อ่าน branding เดิมผ่าน parseBranding ก่อน (สำหรับ audit before)
    const currentBranding = parseBranding(tenant.settings);

    // อ่าน settings raw เพื่อ preserve key อื่น ๆ (เช่น businessHours)
    const existingSettings =
      typeof tenant.settings === "object" &&
      tenant.settings !== null &&
      !Array.isArray(tenant.settings)
        ? (tenant.settings as Record<string, unknown>)
        : {};

    // อ่าน branding เดิม (raw object — ไม่ผ่าน validator เพื่อ preserve ทุก field)
    const existingBranding =
      typeof existingSettings["branding"] === "object" &&
      existingSettings["branding"] !== null &&
      !Array.isArray(existingSettings["branding"])
        ? (existingSettings["branding"] as Record<string, unknown>)
        : {};

    // สร้าง branding object ใหม่ — merge-safe:
    //   - spread existingBranding ก่อน (preserve field ที่ไม่ได้ส่งมา)
    //   - override เฉพาะ field ที่ส่งมาใน input
    //   - undefined = ไม่ได้ส่งมา (ไม่แตะ), null = ลบค่า
    const newBranding: Record<string, unknown> = { ...existingBranding };

    if (input.logoUrl !== undefined) {
      if (input.logoUrl === null) {
        delete newBranding["logoUrl"];
      } else {
        newBranding["logoUrl"] = input.logoUrl;
      }
    }

    if (input.accentColor !== undefined) {
      if (input.accentColor === null) {
        delete newBranding["accentColor"];
      } else {
        newBranding["accentColor"] = input.accentColor;
      }
    }

    // merge กลับเข้า settings — เขียนทับเฉพาะ branding key, key อื่นยังอยู่ครบ
    // cast เป็น Prisma.InputJsonValue เพื่อให้ TypeScript ยอมรับ (Prisma Json field)
    const newSettings = {
      ...existingSettings,
      branding: newBranding,
    } as Prisma.InputJsonValue;

    // 7. Write back — single row update ไม่ต้องการ transaction
    //    select settings กลับมาเพื่อ parse จากค่าที่ DB เขียนจริง (กัน drift จาก Prisma normalize)
    const updated = await prisma.tenant.update({
      where: { id: tenantId },
      data: { settings: newSettings },
      select: { settings: true },
    });

    // 8. Parse ค่าใหม่ผ่าน validator จาก row ที่ persist จริง — return ค่าที่ validated
    const updatedBranding = parseBranding(updated.settings);

    // 9. Audit log — บันทึก tenant.branding_updated
    //    log เฉพาะ logoUrl + accentColor — ไม่ log ข้อมูล sensitive / PII
    //    .catch เพื่อให้ audit ที่ล้มเหลวเห็นใน log (ไม่กลืนเงียบ) แต่ไม่ block response
    void audit.log({
      tenantId,
      actor: { type: "member", memberId: member.id },
      targetType: "tenant",
      targetId: tenantId,
      action: "tenant.branding_updated",
      before: {
        logoUrl: currentBranding.logoUrl,
        accentColor: currentBranding.accentColor,
      },
      after: {
        logoUrl: updatedBranding.logoUrl,
        accentColor: updatedBranding.accentColor,
      },
    }).catch((auditErr: unknown) => {
      console.error(
        "[PATCH /api/branding] audit.log failed:",
        auditErr instanceof Error ? auditErr.message : String(auditErr)
      );
    });

    return NextResponse.json(
      {
        data: {
          logoUrl: updatedBranding.logoUrl,
          accentColor: updatedBranding.accentColor,
        },
        error: null,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error(
      "[PATCH /api/branding] Unexpected error:",
      err instanceof Error ? err.message : String(err)
    );
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
