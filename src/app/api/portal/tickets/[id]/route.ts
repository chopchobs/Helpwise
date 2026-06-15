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
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import { MessageVisibility, TicketStatus } from "@prisma/client";
import type { CsatResponseDTO, PortalCsatState } from "@/types/csat";

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

    // 2. ตรวจ feature gate CSAT_SURVEY สำหรับคำนวณ eligibility (ไม่ block ถ้าปิด — แค่ eligible = false)
    const csatEnabled = await hasFeature(ctx.tenantId, FEATURE_KEYS.CSAT_SURVEY, ctx.plan);

    // 3. OWN-RECORDS SCOPE: กรอง requesterContactId = session.contact.id
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
            // INTERNAL NOTE ISOLATION: message ถูกกรอง visibility=PUBLIC ที่ where ด้านบนแล้ว
            // → attachments ที่ได้จึงเป็นของ PUBLIC message เท่านั้น (INTERNAL ไม่หลุด)
            // ห้าม return storageUrl/path — client เรียก download endpoint (portal) ด้วย id
            attachments: {
              select: {
                id: true,
                fileName: true,
                fileSize: true,
                mimeType: true,
                createdAt: true,
              },
            },
          },
        },
        // ❌ ไม่ select _count.attachments — Prisma นับ attachment ทุก message (รวม INTERNAL)
        //    ไม่กรอง visibility ได้ → existence leak ของ internal attachment ฝั่ง contact
        //    ถ้าต้องการ count ให้ derive จาก messages[].attachments ที่กรอง PUBLIC แล้ว
        // CSAT: โหลด response ที่มีอยู่ (one-to-one optional)
        // tenant-scoped ผ่าน tenantPrisma; own-records scope ผ่าน ticket ownership ด้านบน
        csat: {
          select: {
            rating: true,
            comment: true,
            createdAt: true,
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

    // คำนวณ PortalCsatState:
    //   eligible = feature เปิด + ticket ถูกปิด + ยังไม่มี response
    //   response = existing CsatResponseDTO หรือ null
    const resolvedStatuses: TicketStatus[] = [TicketStatus.SOLVED, TicketStatus.CLOSED];
    const isResolved = resolvedStatuses.includes(ticket.status);
    const hasExistingResponse = ticket.csat !== null;

    const csatResponse: CsatResponseDTO | null = ticket.csat
      ? {
          rating: ticket.csat.rating,
          comment: ticket.csat.comment,
          createdAt: ticket.csat.createdAt.toISOString(),
        }
      : null;

    const csatState: PortalCsatState = {
      // eligible เมื่อ: feature เปิด + ticket ถูกปิดแล้ว + ยังไม่เคยตอบ
      eligible: csatEnabled && isResolved && !hasExistingResponse,
      response: csatResponse,
    };

    // destructure ออก csat (Date object) แล้วใส่ csatState (DTO) แทน
    const { csat: _rawCsat, ...ticketRest } = ticket;

    return NextResponse.json({ data: { ...ticketRest, csat: csatState }, error: null }, { status: 200 });
  } catch (err) {
    console.error("[GET /api/portal/tickets/:id] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
