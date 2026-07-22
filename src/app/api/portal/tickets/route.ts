/**
 * GET  /api/portal/tickets — contact list tickets ของตัวเอง
 * POST /api/portal/tickets — contact สร้าง ticket ใหม่
 *
 * ⚠️ CRITICAL — Double Scope Isolation:
 *   1. Tenant scope: tenantPrisma(ctx.tenantId) inject tenantId อัตโนมัติ
 *   2. Own-records scope: query กรอง requesterContactId = session.contact.id เสมอ
 *      contact ห้ามเห็น ticket ของ contact อื่น แม้ใน tenant เดียวกัน
 *
 * ⚠️ Internal Note Isolation:
 *   - portal ไม่ return messages ใน list view (แสดงแค่ ticket metadata)
 *   - ป้องกัน INTERNAL message หลุดออกมาผ่าน count หรือ snippet
 *
 * ⚠️ Security — ห้ามรับจาก body:
 *   - requesterContactId: ดึงจาก session.contact.id เสมอ
 *   - visibility: บังคับ PUBLIC เสมอ
 *   - tenantId: ดึงจาก ctx.tenantId เสมอ
 *
 * Audience: requireContact() — เฉพาะ contact ที่ verified ของ tenant นี้เท่านั้น
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireContact, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { MessageVisibility, Prisma, TicketStatus } from "@prisma/client";
import { createTicketWithNumber } from "@/lib/tickets";
import { dispatchWebhookEvent } from "@/lib/webhook-dispatch";

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const listQuerySchema = z.object({
  status: z.nativeEnum(TicketStatus).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const createPortalTicketSchema = z.object({
  // FIX-9: subject min(3).max(200) — aligned กับ agent + frontend
  subject: z.string().min(3, "subject ต้องมีอย่างน้อย 3 ตัวอักษร").max(200, "subject ยาวเกิน 200 ตัวอักษร"),
  firstMessage: z.object({
    // FIX-8: max(50000) + FIX-9: min(1)
    body: z.string().min(1, "body ของ firstMessage ห้ามว่าง").max(50000, "body ยาวเกิน 50,000 ตัวอักษร"),
  }),
  // ห้ามรับ requesterContactId จาก body — ดึงจาก session เสมอ
  // ห้ามรับ visibility จาก body — บังคับ PUBLIC เสมอ
});

// =============================================================================
// GET /api/portal/tickets — list tickets ของ contact นี้เท่านั้น
// =============================================================================

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    // 1. ตรวจ auth — requireContact แยกขาดจาก requireAgent
    const session = await requireContact();
    const { contact, ctx } = session;

    // 2. Parse query string
    const { searchParams } = request.nextUrl;
    const queryParsed = listQuerySchema.safeParse({
      status: searchParams.get("status") ?? undefined,
      page: searchParams.get("page") ?? 1,
      limit: searchParams.get("limit") ?? 20,
    });

    if (!queryParsed.success) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "VALIDATION_ERROR",
            message: queryParsed.error.issues[0]?.message ?? "Query parameter ไม่ถูกต้อง",
          },
        },
        { status: 400 }
      );
    }

    const { status, page, limit } = queryParsed.data;
    const db = tenantPrisma(ctx.tenantId);

    // 3. Double scope isolation:
    //    - tenantPrisma inject tenantId (layer 1)
    //    - กรอง requesterContactId = session.contact.id (layer 2 — own-records)
    // FIX-6: ใช้ typed Prisma input แทน Record<string, unknown>
    const where: Prisma.TicketWhereInput = {
      requesterContactId: contact.id, // OWN-RECORDS SCOPE: contact เห็นเฉพาะ ticket ของตัวเอง
    };
    if (status) where.status = status;

    const [tickets, total] = await Promise.all([
      db.ticket.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        // portal view: ไม่ include messages (กัน INTERNAL leak ผ่าน inadvertent inclusion)
        // แสดงแค่ count ของ PUBLIC messages เท่านั้น
        select: {
          id: true,
          ticketNumber: true,
          subject: true,
          status: true,
          // FIX-5: เอา priority, channel, assignee ออก — ไม่อยู่ใน PortalTicketSummary type
          createdAt: true,
          updatedAt: true,
          // INTERNAL NOTE ISOLATION: นับเฉพาะ PUBLIC messages — ห้ามให้ count
          // เผยจำนวน INTERNAL note (filtered relation count ที่ระดับ DB)
          _count: {
            select: {
              messages: { where: { visibility: MessageVisibility.PUBLIC } },
            },
          },
        },
      }),
      db.ticket.count({ where }),
    ]);

    return NextResponse.json(
      {
        data: {
          tickets,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
        error: null,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("[GET /api/portal/tickets] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}

// =============================================================================
// POST /api/portal/tickets — contact สร้าง ticket ใหม่
// =============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // 1. ตรวจ auth
    const session = await requireContact();
    const { contact, ctx } = session;

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

    const parsed = createPortalTicketSchema.safeParse(body);
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

    const { subject, firstMessage } = parsed.data;
    const db = tenantPrisma(ctx.tenantId);

    // 3. สร้าง ticket
    // requesterContactId = session.contact.id เสมอ — ห้ามรับจาก body (กัน spoofing)
    // visibility ของ firstMessage = PUBLIC เสมอ — ห้าม contact สร้าง INTERNAL note
    const ticket = await createTicketWithNumber(db, {
      tenantId: ctx.tenantId,
      subject,
      requesterContactId: contact.id, // OWN-RECORDS: ใช้ contact.id จาก session เสมอ
      channel: "portal",
      firstMessage: {
        body: firstMessage.body,
        visibility: MessageVisibility.PUBLIC, // INTERNAL NOTE ISOLATION: บังคับ PUBLIC
        authorContactId: contact.id, // author = contact ที่ submit
      },
    });

    // 4. โหลด ticket พร้อม PUBLIC messages เพื่อ return
    const ticketWithRelations = await db.ticket.findFirst({
      where: { id: ticket.id },
      select: {
        id: true,
        ticketNumber: true,
        subject: true,
        status: true,
        // FIX-5: เอา priority, channel ออก — ไม่อยู่ใน PortalTicketDetail type
        createdAt: true,
        updatedAt: true,
        messages: {
          where: { visibility: MessageVisibility.PUBLIC }, // INTERNAL NOTE ISOLATION
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            body: true,
            // FIX-4: เอา visibility ออก — PortalTicketMessage ไม่มี visibility field
            createdAt: true,
            authorContact: {
              select: { id: true, name: true, avatarUrl: true },
            },
            authorMember: {
              select: {
                user: { select: { name: true, avatarUrl: true } },
              },
            },
          },
        },
      },
    });

    // FIX-11: audit log ticket.created (portal)
    // log แค่ metadata — ห้าม log body ข้อความ (อาจเป็น PII)
    void audit.log({
      tenantId: ctx.tenantId,
      actor: { type: "contact", contactId: contact.id },
      targetType: "ticket",
      targetId: ticket.id,
      action: "ticket.created",
      after: {
        ticketNumber: ticket.ticketNumber,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
      },
      ticketId: ticket.id,
    });

    // Outbound webhook ticket.created (contract § 3 — portal ก็เป็น trigger point)
    // ⚠️ audience: dispatch เป็น tenant-side side-effect (endpoint เป็นของ tenant ไม่ใช่ของ contact)
    //    ไม่ได้ให้สิทธิ์/ข้อมูลอะไรเพิ่มกับ contact — guard ด้านบนคงเดิมทุกประการ
    // await เพื่อกัน serverless ตัดงานกลางคัน (dispatcher ไม่ throw: กัน error ในตัวแล้ว)
    await dispatchWebhookEvent(
      db,
      ctx.tenantId,
      {
        eventType: "TICKET_CREATED",
        occurredAt: ticket.createdAt,
        ticket: {
          id: ticket.id,
          ticketNumber: ticket.ticketNumber,
          subject: ticket.subject,
          status: ticket.status,
          priority: ticket.priority,
          assigneeMemberId: ticket.assigneeId,
          requesterContactId: ticket.requesterContactId,
          channel: ticket.channel,
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt,
        },
      },
      ctx.plan
    );

    return NextResponse.json({ data: ticketWithRelations, error: null }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/portal/tickets] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
