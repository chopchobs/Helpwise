/**
 * POST /api/tickets/:id/messages — agent ตอบ ticket หรือเพิ่ม internal note
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() เท่านั้น
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId)
 *
 * Business Logic:
 *   - ถ้า message visibility=PUBLIC + ticket.firstRespondedAt เป็น null → set firstRespondedAt
 *   - ถ้า ticket.status = NEW และ agent ส่ง PUBLIC message → เปลี่ยนเป็น OPEN
 *   - visibility=INTERNAL = internal note ระหว่าง agent เท่านั้น (ไม่ส่ง email ออก)
 *
 * Outbound Email (visibility=PUBLIC เท่านั้น):
 *   - fetch requesterContact + ticket details สำหรับ threading
 *   - generate Message-ID สำหรับ reply
 *   - เก็บ threading fields บน TicketMessage ก่อน send
 *   - send email ผ่าน sendEmail() — ถ้า send ล้ม log แต่ไม่ fail request
 *     (emailSentAt จะเป็น null ไว้สำหรับ retry ในอนาคต ผ่าน BullMQ)
 *
 * Audience: requireAgent() — เฉพาะ agent ของ tenant นี้เท่านั้น
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { MessageVisibility, Prisma, TicketStatus } from "@prisma/client";
import { createTicketMessage } from "@/lib/tickets";
import { sendEmail } from "@/lib/email";

// =============================================================================
// VALIDATION SCHEMA
// =============================================================================

// attachment ที่ client อ้างถึง (upload แล้วผ่าน signed URL)
// fileSize/mimeType ที่ส่งมาเป็น hint — backend re-verify ด้วยค่า authoritative จาก storage
const attachmentInputSchema = z.object({
  path: z.string().min(1),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1),
  fileSize: z.number().int().positive(),
});

const createMessageSchema = z.object({
  body: z.string().min(1, "body ห้ามว่าง").max(50000, "body ยาวเกิน 50,000 ตัวอักษร"),
  // agent สามารถเลือก visibility ได้ (PUBLIC หรือ INTERNAL)
  visibility: z.enum(["PUBLIC", "INTERNAL"]).default("PUBLIC"),
  // attachment ที่แนบ (optional) — verify ตอน createTicketMessage
  attachments: z.array(attachmentInputSchema).max(10).optional(),
});

// =============================================================================
// HELPERS
// =============================================================================

/**
 * generate RFC 5322 Message-ID สำหรับ outbound email
 * รูปแบบ: <{ticketId}-{timestamp}-{random}@{slug}.{rootDomain}>
 * ไม่รวม angle brackets ใน value — caller เพิ่มเองเมื่อใส่ใน header
 */
function generateOutboundMessageId(ticketId: string, slug: string, rootDomain: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ticketId}-${ts}-${rand}@${slug}.${rootDomain}`;
}

/**
 * escape HTML special chars กัน HTML injection ในกล่องเมลลูกค้า
 * agent อาจพิมพ์ '<', '>', '&', quote — ต้อง escape ก่อน interpolate เข้า outbound HTML
 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * สร้าง References header ใหม่โดยรวม references เดิม + inReplyTo
 * RFC 5322: References ประกอบด้วย thread ทั้งหมด (previous refs + message ที่ reply)
 */
function buildReferences(existingRefs: string | null, inReplyToId: string | null): string | undefined {
  const parts: string[] = [];
  if (existingRefs) {
    parts.push(...existingRefs.split(/\s+/).filter(Boolean));
  }
  if (inReplyToId && !parts.includes(inReplyToId)) {
    parts.push(inReplyToId);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

// =============================================================================
// POST /api/tickets/:id/messages
// =============================================================================

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    // params เป็น Promise ใน Next.js 15+/16 — ต้อง await
    const { id: ticketId } = await params;

    // 1. ตรวจ auth
    const session = await requireAgent();
    const { ctx, member } = session;
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

    const parsed = createMessageSchema.safeParse(body);
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

    const { body: messageBody, visibility, attachments } = parsed.data;

    // 3. ดึง ticket ปัจจุบัน — tenantPrisma inject tenantId อัตโนมัติ
    // ดึง fields สำหรับ business logic + outbound email threading
    const ticket = await db.ticket.findFirst({
      where: { id: ticketId },
      select: {
        id: true,
        status: true,
        firstRespondedAt: true,
        subject: true,
        ticketNumber: true,
        emailMessageId: true, // Message-ID ของ inbound email แรก
        mergedIntoId: true,
        requesterContact: {
          select: { id: true, email: true, name: true },
        },
      },
    });

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

    // 4. เตรียม threading fields สำหรับ outbound email (เฉพาะ PUBLIC)
    // INTERNAL note ห้ามส่ง email เด็ดขาด — ตรวจที่นี่ก่อน
    let outboundMessageId: string | undefined;
    let outboundInReplyTo: string | undefined;
    let outboundReferences: string | undefined;

    if (visibility === "PUBLIC") {
      // หา Message-ID ล่าสุดของ thread สำหรับ In-Reply-To
      // ลำดับ: หา emailMessageId ของ message ล่าสุด → fallback ไป ticket.emailMessageId
      const lastEmailMsg = await db.ticketMessage.findFirst({
        where: {
          ticketId,
          visibility: MessageVisibility.PUBLIC,
          emailMessageId: { not: null },
        },
        orderBy: { createdAt: "desc" },
        select: {
          emailMessageId: true,
          emailReferences: true,
        },
      });

      const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "helpwise.com";
      // ใช้ slug จาก tenant ถ้ามี — fallback ใช้ tenantId เพื่อ unique
      // Note: ctx ไม่มี slug โดยตรง — ดึง subdomain จาก tenant record ถ้าต้องการ
      // สำหรับ Message-ID ใช้ tenantId แทน slug ก็พอ (ไม่จำเป็นต้อง valid subdomain)
      const slugForId = ctx.tenantId.slice(0, 8); // ใช้ prefix ของ tenantId

      outboundMessageId = generateOutboundMessageId(ticketId, slugForId, rootDomain);

      // In-Reply-To = emailMessageId ของ message ล่าสุด หรือ ticket.emailMessageId
      outboundInReplyTo =
        lastEmailMsg?.emailMessageId ??
        ticket.emailMessageId ??
        undefined;

      // References = รวม references เดิม + in-reply-to ใหม่
      outboundReferences = buildReferences(
        lastEmailMsg?.emailReferences ?? null,
        outboundInReplyTo ?? null
      );
    }

    // 5. สร้าง message — author = agent member ที่ login อยู่
    // บันทึก threading fields พร้อมกัน (emailSentAt = null ก่อนส่ง)
    const message = await createTicketMessage(db, {
      tenantId: ctx.tenantId,
      ticketId,
      body: messageBody,
      visibility: visibility as MessageVisibility,
      authorMemberId: member.id,
      // threading fields — ใส่เฉพาะ PUBLIC message
      emailMessageId: outboundMessageId,
      emailInReplyTo: outboundInReplyTo,
      emailReferences: outboundReferences,
      // emailSentAt = null ก่อนส่ง — set หลังส่งสำเร็จ
      // attachments verify (path prefix + authoritative size/mime) ใน createTicketMessage
      attachments,
    });

    // 6. ตรวจสอบและ update ticket state ตาม business logic
    const ticketUpdate: Prisma.TicketUpdateInput = {};

    // ถ้า agent ส่ง PUBLIC message และ ticket ยังไม่เคยมี first response → set firstRespondedAt
    if (visibility === "PUBLIC" && !ticket.firstRespondedAt) {
      ticketUpdate.firstRespondedAt = new Date();
    }

    // ถ้า ticket status = NEW และ agent ส่ง PUBLIC message → เปลี่ยนเป็น OPEN
    // (INTERNAL note ไม่นับว่าได้รับงานแล้ว)
    const statusChangedFromNew =
      visibility === "PUBLIC" && ticket.status === TicketStatus.NEW;
    if (statusChangedFromNew) {
      ticketUpdate.status = TicketStatus.OPEN;
    }

    // update เฉพาะเมื่อมีอะไรต้อง update
    if (Object.keys(ticketUpdate).length > 0) {
      await db.ticket.update({
        where: { id: ticketId },
        data: ticketUpdate,
      });
    }

    // FIX-1: audit log สำหรับ auto NEW→OPEN
    // fire-and-forget — ไม่ block response ถ้า audit.log ล้ม
    if (statusChangedFromNew) {
      void audit.log({
        tenantId: ctx.tenantId,
        actor: { type: "member", memberId: member.id },
        targetType: "ticket",
        targetId: ticketId,
        action: "ticket.status_changed",
        before: { status: TicketStatus.NEW },
        after: { status: TicketStatus.OPEN },
        ticketId,
      });
    }

    // 7. ส่ง outbound email เฉพาะ PUBLIC message ที่มี email ของ requester
    // INTERNAL note ห้ามส่ง email เด็ดขาด (กฎ CLAUDE.md verbatim)
    // ส่ง AFTER persist message — ถ้าส่งล้ม message ยังอยู่ใน DB (ไม่สูญหาย)
    if (visibility === "PUBLIC" && ticket.requesterContact?.email && outboundMessageId) {
      const contactEmail = ticket.requesterContact.email;
      // สร้าง subject ที่มี ticket number prefix (กัน duplicate ถ้า subject มีอยู่แล้ว)
      const replySubjectPrefix = `[#${ticket.ticketNumber}]`;
      const emailSubject = ticket.subject.startsWith(replySubjectPrefix)
        ? ticket.subject
        : `${replySubjectPrefix} ${ticket.subject}`;

      try {
        await sendEmail({
          to: contactEmail,
          subject: emailSubject,
          html: `<p>${escapeHtml(messageBody).replace(/\n/g, "<br>")}</p>`,
          text: messageBody,
          headers: {
            messageId: outboundMessageId,
            inReplyTo: outboundInReplyTo,
            references: outboundReferences,
          },
        });

        // update emailSentAt หลังส่งสำเร็จ
        // ใช้ raw prisma เพราะ tenantPrisma strip updatedAt fields บาง operation
        // แต่ inject tenantId เองเพื่อ tenant safety
        await db.ticketMessage.update({
          where: { id: message.id },
          data: { emailSentAt: new Date() },
        });
      } catch (sendErr) {
        // ส่ง email ล้ม — log แต่ไม่ fail request
        // emailSentAt ยัง null → สามารถ retry ผ่าน BullMQ ในอนาคต
        console.error("[POST /api/tickets/:id/messages] sendEmail failed:", {
          ticketId,
          messageId: message.id,
          error: sendErr instanceof Error ? sendErr.message : String(sendErr),
        });
        // ไม่ return error — message บันทึกแล้ว ลูกค้าอาจไม่ได้รับ email แต่ agent action ไม่สูญ
      }
    }

    return NextResponse.json({ data: message, error: null }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/tickets/:id/messages] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
