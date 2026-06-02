/**
 * GET /api/portal/tickets/:id — contact ดู ticket ของตัวเอง + PUBLIC messages เท่านั้น
 *
 * ⚠️ CRITICAL — Internal Note Isolation:
 *   - messages query กรอง visibility = PUBLIC เสมอ ที่ระดับ backend
 *   - ห้ามพึ่งการซ่อนใน UI — กรองที่ query ก่อน
 *
 * ⚠️ CRITICAL — Own-Records Scope:
 *   - verify ticket.requesterContactId === session.contact.id
 *   - ถ้าไม่ตรง → 404 (ห้าม reveal ว่า ticket มีอยู่จริงหรือเปล่า)
 *
 * ⚠️ Double Scope Isolation:
 *   1. Tenant scope: tenantPrisma(ctx.tenantId)
 *   2. Own-records scope: requesterContactId = session.contact.id
 *
 * Audience: requireContact() — เฉพาะ contact ที่ verified ของ tenant นี้เท่านั้น
 */

import { NextRequest, NextResponse } from "next/server";
import { requireContact, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { MessageVisibility } from "@prisma/client";

// =============================================================================
// GET /api/portal/tickets/:id
// =============================================================================

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    // params เป็น Promise ใน Next.js 15+/16 — ต้อง await
    const { id } = await params;

    // 1. ตรวจ auth — requireContact แยกขาดจาก requireAgent
    const session = await requireContact();
    const { contact, ctx } = session;
    const db = tenantPrisma(ctx.tenantId);

    // 2. OWN-RECORDS SCOPE: กรอง requesterContactId = session.contact.id
    //    tenantPrisma inject tenantId (layer 1)
    //    requesterContactId filter (layer 2 — own-records)
    //    ถ้า ticket ไม่ใช่ของ contact นี้ → findFirst คืน null → 404
    //    ห้าม reveal ว่า ticket ID นั้นมีอยู่จริง (information leakage)
    const ticket = await db.ticket.findFirst({
      where: {
        id,
        requesterContactId: contact.id, // OWN-RECORDS SCOPE
      },
      select: {
        id: true,
        ticketNumber: true,
        subject: true,
        status: true,
        // FIX-5: เอา priority, channel ออก — ไม่อยู่ใน PortalTicketDetail type
        createdAt: true,
        updatedAt: true,
        firstRespondedAt: true,
        resolvedAt: true,
        // assignee info แสดงชื่อ agent (ไม่เปิดเผย internal role/email)
        assignee: {
          select: {
            user: { select: { name: true, avatarUrl: true } },
          },
        },
        // INTERNAL NOTE ISOLATION: กรอง visibility = PUBLIC ที่ระดับ query (ไม่ใช่แค่ UI)
        messages: {
          where: { visibility: MessageVisibility.PUBLIC }, // กรองที่ backend เสมอ
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            body: true,
            // FIX-4: เอา visibility ออก — PortalTicketMessage ไม่มี visibility field
            // (มีการกรอง visibility = PUBLIC แล้วที่ where clause ด้านบน)
            createdAt: true,
            authorContact: {
              select: { id: true, name: true, avatarUrl: true },
            },
            authorMember: {
              // แสดงชื่อ agent แต่ไม่เปิดเผย role/email (information minimization)
              select: {
                user: { select: { name: true, avatarUrl: true } },
              },
            },
          },
        },
        _count: {
          select: {
            // นับเฉพาะ PUBLIC — contact ไม่ควรรู้ว่ามี INTERNAL note กี่อัน
            attachments: true,
          },
        },
      },
    });

    // ถ้า null → ticket ไม่พบ หรือไม่ใช่ของ contact นี้ → 404 เสมอ
    // ห้าม 403 (จะ reveal ว่า ticket มีอยู่จริงแต่ไม่มีสิทธิ์)
    if (!ticket) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ ticket ที่ระบุ" } },
        { status: 404 }
      );
    }

    return NextResponse.json({ data: ticket, error: null }, { status: 200 });
  } catch (err) {
    console.error("[GET /api/portal/tickets/:id] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
