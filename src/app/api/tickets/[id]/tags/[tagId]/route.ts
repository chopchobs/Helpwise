/**
 * DELETE /api/tickets/:id/tags/:tagId — remove tag ออกจาก ticket
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId) ที่ inject tenantId อัตโนมัติ
 *
 * ⚠️ Agent-Only: tag เป็น internal — ห้าม expose ฝั่ง portal เด็ดขาด
 *
 * Audience: requireAgent() — OWNER/ADMIN/AGENT (ทุก active agent ที่มีสิทธิ์แก้ ticket)
 *
 * Idempotent: ถ้า TicketTag ไม่มีอยู่ → deleteMany คืน count 0 → 200 เช่นกัน
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { audit } from "@/lib/audit";

// =============================================================================
// DELETE /api/tickets/:id/tags/:tagId — remove tag ออกจาก ticket
// =============================================================================

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; tagId: string }> }
): Promise<NextResponse> {
  try {
    const { id: ticketId, tagId } = await params;

    // 1. Auth gate — OWNER/ADMIN/AGENT (ทุก active agent)
    const session = await requireAgent({ roles: ["OWNER", "ADMIN", "AGENT"] });
    const { ctx, member } = session;
    const tenantId = ctx.tenantId; // ห้ามรับ tenantId จาก client
    const db = tenantPrisma(tenantId);

    // 2. ตรวจว่า ticket อยู่ใน tenant นี้ (tenantPrisma inject tenantId กัน cross-tenant)
    const ticket = await db.ticket.findFirst({
      where: { id: ticketId },
      select: { id: true },
    });
    if (!ticket) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ ticket ที่ระบุ" } },
        { status: 404 }
      );
    }

    // 3. ดึง tag name สำหรับ audit log ก่อน delete (ถ้ามีอยู่)
    //    tenantPrisma inject tenantId อัตโนมัติ กัน cross-tenant tag lookup
    const tag = await db.tag.findFirst({
      where: { id: tagId },
      select: { id: true, name: true },
    });

    // 4. deleteMany idempotent — ถ้า TicketTag ไม่มีอยู่ count = 0 → 200 เช่นกัน
    //    tenantPrisma inject tenantId เข้า where อัตโนมัติ (tenant isolation)
    await db.ticketTag.deleteMany({
      where: {
        ticketId,
        tagId,
      },
    });

    // 5. Audit log — ticket.tag_removed (fire-and-forget; ข้ามถ้า tag ไม่เคยมีอยู่)
    if (tag) {
      void audit.log({
        tenantId,
        actor: { type: "member", memberId: member.id },
        targetType: "ticket",
        targetId: ticketId,
        action: "ticket.tag_removed",
        metadata: { tagId, tagName: tag.name },
        ticketId,
      });
    }

    return NextResponse.json({ data: { tagId }, error: null }, { status: 200 });
  } catch (err) {
    console.error("[DELETE /api/tickets/:id/tags/:tagId] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
