/**
 * GET /api/auth/agent/me — ข้อมูล agent ที่ login อยู่ + tenant + branding
 * ใช้แสดงบน nav shell: ชื่อ, รูป, role, logo, accent color ของ tenant
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() → ctx.tenantId เท่านั้น ห้ามรับจาก client
 *   - Tenant query ใช้ base prisma (ไม่ใช่ tenantPrisma) เพราะ Tenant ไม่มีคอลัมน์ tenantId
 *     (PK คือ id) — แต่ tenantId ที่ใช้ query มาจาก middleware context ที่ verify แล้ว ปลอดภัย
 *
 * Audience: requireAgent() — เฉพาะ agent ที่เป็นสมาชิก tenant นี้เท่านั้น
 */

import { NextResponse } from "next/server";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { MemberRole } from "@prisma/client";

// =============================================================================
// RESPONSE TYPES
// =============================================================================

interface AgentMeUser {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
}

interface AgentMeMember {
  id: string;
  role: MemberRole;
}

interface AgentMeTenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
  logoUrl: string | null;
  accentColor: string | null;
}

interface AgentMeData {
  user: AgentMeUser;
  member: AgentMeMember;
  tenant: AgentMeTenant;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * อ่าน logoUrl + accentColor จาก tenant.settings (Json)
 * parse อย่างปลอดภัยด้วย type guard — settings อาจ shape ไม่ตรงในข้อมูลเก่า
 */
function extractBranding(settings: unknown): {
  logoUrl: string | null;
  accentColor: string | null;
} {
  // guard: settings ต้องเป็น object
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return { logoUrl: null, accentColor: null };
  }

  const raw = settings as Record<string, unknown>;
  const branding = raw["branding"];

  // guard: branding ต้องเป็น object ไม่ใช่ array หรือ null
  if (typeof branding !== "object" || branding === null || Array.isArray(branding)) {
    return { logoUrl: null, accentColor: null };
  }

  const b = branding as Record<string, unknown>;

  // คืน string หรือ null — ไม่ cast ดิบ
  const logoUrl = typeof b["logoUrl"] === "string" ? b["logoUrl"] : null;
  const accentColor = typeof b["accentColor"] === "string" ? b["accentColor"] : null;

  return { logoUrl, accentColor };
}

// =============================================================================
// GET /api/auth/agent/me
// =============================================================================

export async function GET(): Promise<NextResponse> {
  try {
    // 1. ตรวจ auth — ดึง user, member, ctx จาก cookie + middleware header
    const session = await requireAgent();
    const { user, member, ctx } = session;

    // 2. Query Tenant record ด้วย base prisma (Tenant ไม่มี tenantId — PK คือ id)
    //    tenantId ที่ใช้ filter มาจาก ctx ที่ middleware verify แล้ว ไม่ใช่จาก client
    const tenant = await prisma.tenant.findUnique({
      where: { id: ctx.tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        settings: true,
        // ไม่ select plan relation — ใช้ ctx.plan จาก middleware (cache Redis) แทน
        // เพื่อไม่ต้องทำ join Plan และ consistent กับ header ที่ middleware ส่งมา
      },
    });

    // ถ้าหา tenant ไม่เจอ = ข้อมูลใน header กับ DB ไม่ตรงกัน (ผิดปกติมาก)
    // ไม่ expose tenantId ใน error message (กัน info leak)
    if (!tenant) {
      return NextResponse.json(
        {
          data: null,
          error: { code: "TENANT_NOT_FOUND", message: "ไม่พบข้อมูล workspace" },
        },
        { status: 404 }
      );
    }

    // 3. Parse branding จาก settings Json อย่างปลอดภัย
    const { logoUrl, accentColor } = extractBranding(tenant.settings);

    // 4. Compose response — เลือกเฉพาะ field ที่ nav shell ต้องการ
    //    ไม่ return passwordHash, isActive, createdAt หรือ field sensitive อื่น ๆ
    const data: AgentMeData = {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatarUrl,
      },
      member: {
        id: member.id,
        role: member.role,
      },
      tenant: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        plan: ctx.plan, // ดึงจาก middleware context (Redis cache) ไม่ต้อง join Plan
        logoUrl,
        accentColor,
      },
    };

    return NextResponse.json({ data, error: null }, { status: 200 });
  } catch (err) {
    console.error(
      "[GET /api/auth/agent/me] Unexpected error:",
      err instanceof Error ? err.message : String(err)
    );
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
