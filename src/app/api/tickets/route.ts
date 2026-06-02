/**
 * GET  /api/tickets  — list tickets (agent view, ทุก visibility)
 * POST /api/tickets  — agent สร้าง ticket ใหม่
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() → ctx.tenantId เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId) ที่ inject tenantId อัตโนมัติ
 *
 * Audience: requireAgent() — เฉพาะ agent ที่เป็นสมาชิก tenant นี้เท่านั้น
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { MessageVisibility, Prisma, TicketPriority, TicketStatus } from "@prisma/client";
import {
  createTicketWithNumber,
  verifyContactBelongsToTenant,
} from "@/lib/tickets";

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

// schema สำหรับ query string ของ GET (filter แบบ optional ทุก field)
const listQuerySchema = z.object({
  status: z.nativeEnum(TicketStatus).optional(),
  priority: z.nativeEnum(TicketPriority).optional(),
  assigneeId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// schema สำหรับ POST body
const createTicketSchema = z.object({
  // FIX-9: subject min(3).max(200) — aligned กับ portal + frontend
  subject: z.string().min(3, "subject ต้องมีอย่างน้อย 3 ตัวอักษร").max(200, "subject ยาวเกิน 200 ตัวอักษร"),
  requesterContactId: z.string().min(1, "requesterContactId ห้ามว่าง"),
  priority: z.nativeEnum(TicketPriority).optional(),
  firstMessage: z
    .object({
      // FIX-8: max(50000) + FIX-9: min(1) (ไม่บังคับ 10)
      body: z.string().min(1, "body ของ firstMessage ห้ามว่าง").max(50000, "body ยาวเกิน 50,000 ตัวอักษร"),
      // FIX-7: ใช้ z.nativeEnum(MessageVisibility) แทน inline object literal
      visibility: z.nativeEnum(MessageVisibility).optional(),
    })
    .optional(),
});

// =============================================================================
// GET /api/tickets — list tickets (agent view)
// =============================================================================

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    // 1. ตรวจ auth + ดึง tenant context จาก middleware header
    const session = await requireAgent();
    const { ctx } = session;

    // 2. Parse query string
    const { searchParams } = request.nextUrl;
    const queryParsed = listQuerySchema.safeParse({
      status: searchParams.get("status") ?? undefined,
      priority: searchParams.get("priority") ?? undefined,
      assigneeId: searchParams.get("assigneeId") ?? undefined,
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

    const { status, priority, assigneeId, page, limit } = queryParsed.data;

    // 3. สร้าง where clause — tenantPrisma inject tenantId อัตโนมัติ
    const db = tenantPrisma(ctx.tenantId);

    // FIX-6: ใช้ typed Prisma input แทน Record<string, unknown>
    // tenantPrisma inject tenantId อัตโนมัติ — ไม่ต้องใส่ tenantId ใน where
    const where: Prisma.TicketWhereInput = {};
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (assigneeId) where.assigneeId = assigneeId;

    // 4. Query tickets พร้อม pagination + relations
    const [tickets, total] = await Promise.all([
      db.ticket.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          requesterContact: {
            select: { id: true, name: true, email: true, avatarUrl: true },
          },
          assignee: {
            select: {
              id: true,
              role: true,
              user: { select: { id: true, name: true, avatarUrl: true } },
            },
          },
          // FIX-3: นับเฉพาะ PUBLIC messages ใน list view
          // กัน internal-note count รั่วผ่าน list API + ตรงกับ list view ที่ลูกค้าเห็น
          _count: { select: { messages: { where: { visibility: MessageVisibility.PUBLIC } } } },
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
    console.error("[GET /api/tickets] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}

// =============================================================================
// POST /api/tickets — agent สร้าง ticket ใหม่
// =============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // 1. ตรวจ auth — ต้องเป็น agent ที่ active ของ tenant นี้
    const session = await requireAgent();
    const { ctx, member } = session;

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

    const parsed = createTicketSchema.safeParse(body);
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

    const { subject, requesterContactId, priority, firstMessage } = parsed.data;
    const db = tenantPrisma(ctx.tenantId);

    // 3. verify requesterContact เป็น Contact ของ tenant นี้จริง
    // กัน agent ระบุ contactId ของ tenant อื่น (cross-tenant spoofing)
    const contact = await verifyContactBelongsToTenant(db, requesterContactId);
    if (!contact) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "CONTACT_NOT_FOUND",
            message: "ไม่พบ contact ที่ระบุใน workspace นี้",
          },
        },
        { status: 400 }
      );
    }

    // 4. สร้าง ticket พร้อม ticketNumber แบบ atomic + retry
    const ticket = await createTicketWithNumber(db, {
      tenantId: ctx.tenantId,
      subject,
      requesterContactId,
      priority,
      channel: "agent", // agent สร้างเอง
      firstMessage: firstMessage
        ? {
            body: firstMessage.body,
            // FIX-7: z.nativeEnum(MessageVisibility) ทำให้ type ถูกต้องแล้ว — ไม่ต้องใช้ triple ternary
            visibility: firstMessage.visibility ?? MessageVisibility.PUBLIC,
            authorMemberId: member.id, // author = agent ที่สร้าง
          }
        : undefined,
    });

    // 5. โหลด ticket พร้อม relations เพื่อ return
    const ticketWithRelations = await db.ticket.findFirst({
      where: { id: ticket.id },
      include: {
        requesterContact: {
          select: { id: true, name: true, email: true, avatarUrl: true },
        },
        assignee: {
          select: {
            id: true,
            role: true,
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
        messages: {
          orderBy: { createdAt: "asc" },
          include: {
            authorMember: {
              select: { id: true, role: true, user: { select: { id: true, name: true, avatarUrl: true } } },
            },
            authorContact: {
              select: { id: true, name: true, email: true, avatarUrl: true },
            },
          },
        },
      },
    });

    // FIX-11: audit log ticket.created
    // log แค่ metadata ไม่ log body ข้อความ (อาจเป็น PII)
    void audit.log({
      tenantId: ctx.tenantId,
      actor: { type: "member", memberId: member.id },
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

    return NextResponse.json({ data: ticketWithRelations, error: null }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/tickets] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
