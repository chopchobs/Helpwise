/**
 * GET /api/members — list active TenantMembers (สำหรับ assignee dropdown)
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() → ctx.tenantId เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId) ที่ inject tenantId อัตโนมัติ
 *
 * Audience: requireAgent() — เฉพาะ agent ที่เป็นสมาชิก tenant นี้เท่านั้น
 */

import { NextResponse } from "next/server";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";

// =============================================================================
// GET /api/members — list active members สำหรับ assignee dropdown
// =============================================================================

export async function GET(): Promise<NextResponse> {
  try {
    // 1. ตรวจ auth — ต้องเป็น agent ที่ active ของ tenant นี้
    const session = await requireAgent();
    const { ctx } = session;

    // 2. Query active TenantMembers ของ tenant นี้ — tenantPrisma inject tenantId อัตโนมัติ
    const db = tenantPrisma(ctx.tenantId);

    const members = await db.tenantMember.findMany({
      where: { isActive: true },
      orderBy: { user: { name: "asc" } },
      select: {
        id: true,      // TenantMember.id — assigneeId ชี้ TenantMember ไม่ใช่ User
        role: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
          },
        },
      },
    });

    return NextResponse.json(
      { data: { members }, error: null },
      { status: 200 }
    );
  } catch (err) {
    console.error(
      "[GET /api/members] Unexpected error:",
      err instanceof Error ? err.message : String(err)
    );
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
