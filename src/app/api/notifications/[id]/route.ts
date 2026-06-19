/**
 * PATCH /api/notifications/:id — mark notification เป็น read (set readAt)
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() → ctx.tenantId เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId) ที่ inject tenantId อัตโนมัติ
 *
 * ⚠️ Recipient scope (สองชั้น):
 *   - mark read ได้เฉพาะ notification ที่ memberId = current member เท่านั้น
 *   - notification ของ member อื่น → 404 (ห้าม mark ของคนอื่น / ห้าม leak ว่ามีอยู่)
 *
 * Audience: requireAgent() — agent เท่านั้น (ห้าม contact/portal เข้าถึง)
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";

export async function PATCH(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    // params เป็น Promise ใน Next.js 15+/16 — ต้อง await
    const { id } = await params;

    // 1. ตรวจ auth + ดึง tenant context + current member จาก verified session
    const session = await requireAgent();
    const { ctx, member } = session;
    const db = tenantPrisma(ctx.tenantId);

    // 2. updateMany scope ทั้ง id + memberId (own-records) — tenantPrisma inject tenantId อัตโนมัติ
    //    ใช้ updateMany เพื่อ scope memberId ใน where ได้ (update by id เดี่ยวไม่รับ non-unique field)
    //    count === 0 = ไม่มี notification id นี้ของ member นี้ → 404 (ของคนอื่น/ไม่มีจริง แยกไม่ได้ = ไม่ leak)
    const result = await db.notification.updateMany({
      where: { id, memberId: member.id },
      data: { readAt: new Date() },
    });

    if (result.count === 0) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ notification ที่ระบุ" } },
        { status: 404 }
      );
    }

    // 3. โหลด record ที่ update แล้ว เพื่อ return (scope memberId อีกชั้นกัน leak)
    const updated = await db.notification.findFirst({
      where: { id, memberId: member.id },
      select: {
        id: true,
        type: true,
        ticketId: true,
        readAt: true,
        createdAt: true,
      },
    });

    return NextResponse.json(
      {
        data: updated
          ? {
              id: updated.id,
              type: updated.type,
              ticketId: updated.ticketId,
              readAt: updated.readAt ? updated.readAt.toISOString() : null,
              createdAt: updated.createdAt.toISOString(),
            }
          : null,
        error: null,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error(
      "[PATCH /api/notifications/:id] Unexpected error:",
      err instanceof Error ? err.message : String(err)
    );
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
