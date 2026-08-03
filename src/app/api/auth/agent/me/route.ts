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
 *
 * demoPersona: บอกว่า session นี้เป็น demo persona ตัวไหน ("primary"/"secondary")
 *   - จำแนกฝั่ง server จาก DEMO_PERSONAS (source เดียวกับ /api/auth/demo/login)
 *   - match ด้วย email ของ session + slug ของ tenant context คู่กันเสมอ (ห้ามข้าม tenant)
 *   - tenant จริง / user ที่ไม่ใช่ persona → null (ไม่ throw, ไม่ 403)
 *   - ไม่มี query DB เพิ่ม — ใช้ข้อมูลที่ query อยู่แล้ว (route นี้ถูกเรียกทุกครั้งที่ mount)
 */

import { NextResponse } from "next/server";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseBranding } from "@/lib/branding";
import { DEMO_PERSONAS, type DemoPersonaKey } from "@/lib/demo-personas";
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
  // demo persona ของ session นี้ (null = ไม่ใช่ demo tenant / ไม่ใช่ persona)
  demoPersona: DemoPersonaKey | null;
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

    // 3. Parse + validate branding จาก settings Json ผ่าน shared helper (https-only, hex-only)
    const { logoUrl, accentColor } = parseBranding(tenant.settings);

    // 4. จำแนก demo persona ฝั่ง server — จับคู่ email ของ session กับ slug ของ tenant นี้
    //    (ห้าม match email อย่างเดียว มิฉะนั้น persona ของ tenant อื่นจะถูกนับข้าม tenant)
    const demoPersona =
      DEMO_PERSONAS.find((p) => p.tenantSlug === tenant.slug && p.email === user.email)?.key ??
      null;

    // 5. Compose response — เลือกเฉพาะ field ที่ nav shell ต้องการ
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
      // คืนแค่ key — ห้าม expose email/password ของ persona
      demoPersona,
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
