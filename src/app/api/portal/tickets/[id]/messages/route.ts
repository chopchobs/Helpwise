/**
 * POST /api/portal/tickets/:id/messages — contact reply กลับใน ticket ของตัวเอง
 *
 * ⚠️ CRITICAL — Internal Note Isolation:
 *   - visibility บังคับเป็น PUBLIC เสมอ — ห้ามรับจาก body
 *   - contact ไม่สามารถสร้าง INTERNAL message ได้เด็ดขาด
 *
 * ⚠️ CRITICAL — Own-Records Scope:
 *   - verify ticket.requesterContactId === session.contact.id ก่อน
 *   - ถ้าไม่ตรง → 404 (ห้าม reveal ว่า ticket มีอยู่จริง)
 *
 * Business Logic:
 *   - ถ้า ticket status = PENDING หรือ SOLVED → reopen เป็น OPEN
 *     (contact reply หมายความว่ามีข้อมูลใหม่ ควรเปิด ticket ต่อ)
 *
 * Audience: requireContact() — เฉพาะ contact ที่ verified ของ tenant นี้เท่านั้น
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireContact, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { MessageVisibility, TicketStatus } from "@prisma/client";
import { createTicketMessage } from "@/lib/tickets";

// =============================================================================
// VALIDATION SCHEMA
// =============================================================================

// attachment ที่ contact อ้างถึง (upload แล้วผ่าน signed URL)
// fileSize/mimeType เป็น hint — backend re-verify ด้วยค่า authoritative จาก storage
const portalAttachmentInputSchema = z.object({
  path: z.string().min(1),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1),
  fileSize: z.number().int().positive(),
});

const createPortalMessageSchema = z.object({
  body: z.string().min(1, "body ห้ามว่าง").max(50000, "body ยาวเกิน 50,000 ตัวอักษร"),
  // ห้ามรับ visibility จาก body — บังคับ PUBLIC เสมอ (INTERNAL NOTE ISOLATION)
  // ไม่มี field visibility ใน schema เลย เพื่อป้องกัน bypass
  // attachments แนบได้ — visibility ของ message ยังบังคับ PUBLIC เสมอ
  attachments: z.array(portalAttachmentInputSchema).max(10).optional(),
});

// =============================================================================
// POST /api/portal/tickets/:id/messages
// =============================================================================

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    // params เป็น Promise ใน Next.js 15+/16 — ต้อง await
    const { id: ticketId } = await params;

    // 1. ตรวจ auth — requireContact แยกขาดจาก requireAgent
    const session = await requireContact();
    const { contact, ctx } = session;
    const db = tenantPrisma(ctx.tenantId);

    // 2. Parse + validate body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { data: null, error: { code: "INVALID_JSON", message: "Request body ต้องเป็น JSON" } },
        { status: 400 }
      );
    }

    const parsed = createPortalMessageSchema.safeParse(body);
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

    const { body: messageBody, attachments } = parsed.data;

    // 3. OWN-RECORDS SCOPE: ดึง ticket + verify ownership ก่อนทำอะไรทั้งนั้น
    //    tenantPrisma inject tenantId (layer 1)
    //    requesterContactId filter (layer 2 — own-records)
    const ticket = await db.ticket.findFirst({
      where: {
        id: ticketId,
        requesterContactId: contact.id, // OWN-RECORDS SCOPE
      },
      select: {
        id: true,
        status: true,
        mergedIntoId: true,
      },
    });

    // ถ้าไม่พบ → 404 เสมอ (ไม่ reveal ว่ามีอยู่จริงแต่ไม่มีสิทธิ์)
    if (!ticket) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ ticket ที่ระบุ" } },
        { status: 404 }
      );
    }

    // ticket ที่ถูก merge แล้วเป็น read-only — ห้ามตอบกลับเพิ่ม
    if (ticket.mergedIntoId !== null) {
      return NextResponse.json(
        { data: null, error: { code: "TICKET_MERGED", message: "ticket นี้ถูกรวมไปแล้ว ไม่สามารถตอบกลับได้" } },
        { status: 409 }
      );
    }

    // 4. สร้าง message
    // visibility = PUBLIC เสมอ — ห้ามรับจาก body (INTERNAL NOTE ISOLATION)
    // author = contact จาก session (ห้ามรับ contactId จาก body)
    const message = await createTicketMessage(db, {
      tenantId: ctx.tenantId,
      ticketId,
      body: messageBody,
      visibility: MessageVisibility.PUBLIC, // INTERNAL NOTE ISOLATION: hardcode PUBLIC เสมอ
      authorContactId: contact.id,          // OWN-RECORDS: ใช้ contact.id จาก session เสมอ
      // attachments verify (path prefix ของ ticket นี้ + authoritative size/mime) ใน createTicketMessage
      attachments,
    });

    // 5. Reopen ticket ถ้า contact reply มา (business logic)
    // PENDING = รอ contact ตอบ → contact ตอบแล้ว → OPEN
    // SOLVED = ปิดไปแล้ว แต่ contact มีข้อมูลเพิ่ม → reopen เป็น OPEN
    const shouldReopen =
      ticket.status === TicketStatus.PENDING ||
      ticket.status === TicketStatus.SOLVED;
    if (shouldReopen) {
      await db.ticket.update({
        where: { id: ticketId },
        data: { status: TicketStatus.OPEN },
      });

      // FIX-2: audit log สำหรับ contact reopen
      // fire-and-forget — ไม่ block response
      void audit.log({
        tenantId: ctx.tenantId,
        actor: { type: "contact", contactId: contact.id },
        targetType: "ticket",
        targetId: ticketId,
        action: "ticket.status_changed",
        before: { status: ticket.status },
        after: { status: TicketStatus.OPEN },
        ticketId,
      });
    }

    // 6. Return message พร้อม author info
    // ไม่ return visibility field เพื่อ minimization (มันจะเป็น PUBLIC เสมออยู่แล้ว)
    // สร้าง authorContact จากข้อมูล session.contact ที่รู้อยู่แล้ว
    // (หลีกเลี่ยง type inference ซับซ้อนจาก TenantScopedPrisma extension return type)
    return NextResponse.json(
      {
        data: {
          id: message.id,
          ticketId,
          body: message.body,
          createdAt: message.createdAt,
          authorContact: {
            id: contact.id,
            name: contact.name ?? null,
            avatarUrl: contact.avatarUrl ?? null,
          },
          // attachment metadata (ไม่ return storageUrl/path) — client เรียก download endpoint ด้วย id
          attachments: message.attachments.map((a) => ({
            id: a.id,
            fileName: a.fileName,
            fileSize: a.fileSize,
            mimeType: a.mimeType,
            createdAt: a.createdAt,
          })),
        },
        error: null,
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("[POST /api/portal/tickets/:id/messages] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
