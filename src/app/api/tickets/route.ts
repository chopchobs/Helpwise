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
import { prisma } from "@/lib/prisma";
import { MessageVisibility, Prisma, TicketPriority, TicketStatus } from "@prisma/client";
import {
  createTicketWithNumber,
  verifyAssigneeMembership,
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
  // tagId รองรับหลายค่า (match-any) — ส่งได้เป็น ?tagId=x&tagId=y หรือ ?tagId=x,y
  tagId: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (!v) return undefined;
      // รองรับทั้ง ?tagId=a,b (comma-separated) และ ?tagId=a&tagId=b (multi-value)
      // flatMap split comma ทุก element — กันเคส array ที่ element มี comma (เช่น ["a,b"])
      const arr = Array.isArray(v) ? v : [v];
      const filtered = arr.flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
      return filtered.length > 0 ? filtered : undefined;
    }),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// schema สำหรับ POST body
// requester รับได้ 2 แบบ: requesterContactId (id โดยตรง) หรือ requesterEmail (upsert)
// Zod refine บังคับให้มีอย่างน้อยหนึ่งในสองแบบ
const createTicketSchema = z
  .object({
    // FIX-9: subject min(3).max(200) — aligned กับ portal + frontend
    subject: z.string().min(3, "subject ต้องมีอย่างน้อย 3 ตัวอักษร").max(200, "subject ยาวเกิน 200 ตัวอักษร"),
    // requester แบบที่ 1: ส่ง contactId โดยตรง
    requesterContactId: z.string().min(1).optional(),
    // requester แบบที่ 2: ส่ง email (+ name เพิ่มเติม) แล้ว upsert contact
    requesterEmail: z.string().email("รูปแบบ requesterEmail ไม่ถูกต้อง").optional(),
    requesterName: z.string().min(1).optional(),
    // assigneeId = TenantMember.id (optional)
    assigneeId: z.string().min(1).optional(),
    priority: z.nativeEnum(TicketPriority).optional(),
    firstMessage: z
      .object({
        // FIX-8: max(50000) + FIX-9: min(1) (ไม่บังคับ 10)
        body: z.string().min(1, "body ของ firstMessage ห้ามว่าง").max(50000, "body ยาวเกิน 50,000 ตัวอักษร"),
        // FIX-7: ใช้ z.nativeEnum(MessageVisibility) แทน inline object literal
        visibility: z.nativeEnum(MessageVisibility).optional(),
      })
      .optional(),
  })
  .refine(
    (data) => !!data.requesterContactId || !!data.requesterEmail,
    {
      message: "ต้องระบุ requesterContactId หรือ requesterEmail อย่างใดอย่างหนึ่ง",
      path: ["requesterContactId"],
    }
  );

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
    // tagId รองรับ multi-value: ?tagId=a&tagId=b หรือ ?tagId=a,b
    const rawTagIds = searchParams.getAll("tagId");
    const tagIdParam = rawTagIds.length > 0 ? rawTagIds : (searchParams.get("tagId") ?? undefined);

    const queryParsed = listQuerySchema.safeParse({
      status: searchParams.get("status") ?? undefined,
      priority: searchParams.get("priority") ?? undefined,
      assigneeId: searchParams.get("assigneeId") ?? undefined,
      tagId: tagIdParam,
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

    const { status, priority, assigneeId, tagId, page, limit } = queryParsed.data;

    // 3. สร้าง where clause — tenantPrisma inject tenantId อัตโนมัติ
    const db = tenantPrisma(ctx.tenantId);

    // FIX-6: ใช้ typed Prisma input แทน Record<string, unknown>
    // tenantPrisma inject tenantId อัตโนมัติ — ไม่ต้องใส่ tenantId ใน where
    const where: Prisma.TicketWhereInput = {};
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (assigneeId) where.assigneeId = assigneeId;
    // filter by tag — match-any: ticket ที่มี tag ใดใดใน list (tenantPrisma scope กัน cross-tenant)
    if (tagId && tagId.length > 0) {
      where.ticketTags = { some: { tagId: { in: tagId } } };
    }

    // 4. Query tickets พร้อม pagination + relations
    const [rawTickets, total] = await Promise.all([
      db.ticket.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          ticketNumber: true,
          subject: true,
          status: true,
          priority: true,
          createdAt: true,
          updatedAt: true,
          // SLA scalar fields — agent-side เท่านั้น (portal route ไม่ select field เหล่านี้)
          firstResponseDueAt: true,
          resolutionDueAt: true,
          firstRespondedAt: true,
          resolvedAt: true,
          firstResponseBreached: true,
          resolutionBreached: true,
          slaPausedAt: true,
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
          // CSAT: agent เห็น rating ของแต่ละ ticket ใน list (one-to-one optional)
          csat: {
            select: {
              rating: true,
              comment: true,
              createdAt: true,
            },
          },
          // TAGS (agent-only): ห้าม include ใน portal route เด็ดขาด
          ticketTags: {
            select: {
              tag: {
                select: { id: true, name: true, color: true },
              },
            },
          },
        },
      }),
      db.ticket.count({ where }),
    ]);

    // แปลง Date → ISO string และ group SLA fields เป็น nested object
    // sla = null เมื่อ ticket ไม่มี deadline (firstResponseDueAt และ resolutionDueAt เป็น null ทั้งคู่)
    const tickets = rawTickets.map((t) => {
      const hasSla =
        t.firstResponseDueAt !== null || t.resolutionDueAt !== null;

      // แปลง csat Date → ISO string; null ถ้ายังไม่มี response
      const csatDTO = t.csat
        ? {
            rating: t.csat.rating,
            comment: t.csat.comment,
            createdAt: t.csat.createdAt.toISOString(),
          }
        : null;

      // map ticketTags → tags: TagDTO[] (agent-only)
      const tags = t.ticketTags.map((tt) => ({
        id: tt.tag.id,
        name: tt.tag.name,
        color: tt.tag.color,
      }));

      return {
        id: t.id,
        ticketNumber: t.ticketNumber,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
        requesterContact: t.requesterContact,
        assignee: t.assignee,
        _count: t._count,
        sla: hasSla
          ? {
              firstResponseDueAt: t.firstResponseDueAt
                ? t.firstResponseDueAt.toISOString()
                : null,
              resolutionDueAt: t.resolutionDueAt
                ? t.resolutionDueAt.toISOString()
                : null,
              firstRespondedAt: t.firstRespondedAt
                ? t.firstRespondedAt.toISOString()
                : null,
              resolvedAt: t.resolvedAt
                ? t.resolvedAt.toISOString()
                : null,
              firstResponseBreached: t.firstResponseBreached,
              resolutionBreached: t.resolutionBreached,
              slaPausedAt: t.slaPausedAt
                ? t.slaPausedAt.toISOString()
                : null,
            }
          : null,
        csat: csatDTO,
        // tags: agent-only — ห้ามส่งใน portal response
        tags,
      };
    });

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

    const {
      subject,
      requesterContactId: rawContactId,
      requesterEmail,
      requesterName,
      assigneeId,
      priority,
      firstMessage,
    } = parsed.data;

    const db = tenantPrisma(ctx.tenantId);

    // 3. Resolve requesterContactId — รับ 2 แบบ:
    //    แบบที่ 1: requesterContactId โดยตรง → verify เป็น contact ของ tenant นี้
    //    แบบที่ 2: requesterEmail → upsert contact by tenantId_email แล้วใช้ id ที่ได้
    let resolvedContactId: string;

    if (rawContactId) {
      // verify ว่า contactId เป็น contact ที่ active ของ tenant นี้จริง
      // กัน agent ระบุ contactId ของ tenant อื่น (cross-tenant spoofing)
      const contact = await verifyContactBelongsToTenant(db, rawContactId);
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
      resolvedContactId = contact.id;
    } else {
      // requesterEmail path: upsert contact by composite unique key tenantId_email
      // ห่อ read + upsert ใน interactive transaction เพื่อให้ atomic
      // กัน race condition เมื่อ agent 2 คน submit email เดิมพร้อมกัน — name-update logic จะถูกต้องเสมอ
      // tx ไม่มี extension → ต้องใส่ tenantId เองใน where/create/update ทุกจุด
      const upserted = await prisma.$transaction(async (tx) => {
        // อ่าน contact เดิมภายใน transaction เดียวกับ upsert
        const existingContact = await tx.contact.findFirst({
          where: { tenantId: ctx.tenantId, email: requesterEmail! },
          select: { id: true, name: true },
        });

        return tx.contact.upsert({
          where: {
            tenantId_email: {
              tenantId: ctx.tenantId,
              email: requesterEmail!,
            },
          },
          create: {
            email: requesterEmail!,
            tenantId: ctx.tenantId,
            ...(requesterName ? { name: requesterName } : {}),
          },
          update: {
            // อัปเดต name เฉพาะเมื่อ requesterName ให้มาและ contact เดิมยังไม่มีชื่อ
            ...(requesterName && !existingContact?.name ? { name: requesterName } : {}),
          },
          select: { id: true, name: true },
        });
      });
      resolvedContactId = upserted.id;
    }

    // 4. ตรวจ assigneeId (ถ้ามี) — ต้องเป็น active TenantMember ของ tenant นี้
    // กัน cross-tenant assignment (agent tenant A ไม่ควร assign ให้ member tenant B)
    if (assigneeId) {
      const assignee = await verifyAssigneeMembership(db, assigneeId);
      if (!assignee) {
        return NextResponse.json(
          {
            data: null,
            error: {
              code: "ASSIGNEE_NOT_FOUND",
              message: "ไม่พบ assignee ที่ระบุ หรือไม่ใช่สมาชิกที่ active ของ workspace นี้",
            },
          },
          { status: 400 }
        );
      }
    }

    // 5. สร้าง ticket พร้อม ticketNumber แบบ atomic + retry
    const ticket = await createTicketWithNumber(db, {
      tenantId: ctx.tenantId,
      subject,
      requesterContactId: resolvedContactId,
      assigneeId,
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

    // 6. โหลด ticket พร้อม relations เพื่อ return
    // หมายเหตุ: agent เห็น messages ทุก visibility (PUBLIC + INTERNAL) ได้ — จงใจไม่กรอง visibility ที่นี่
    // (portal route เท่านั้นที่กรอง visibility = PUBLIC เพื่อซ่อน internal note จากลูกค้า)
    const ticketWithRelations = await db.ticket.findUnique({
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
    // log แค่ metadata ไม่ log subject (อาจมี PII) หรือ body ข้อความ
    // subject ดึงได้จาก Ticket record โดยตรงถ้าต้องการ — AuditLog immutable ลบไม่ได้
    void audit.log({
      tenantId: ctx.tenantId,
      actor: { type: "member", memberId: member.id },
      targetType: "ticket",
      targetId: ticket.id,
      action: "ticket.created",
      after: {
        ticketNumber: ticket.ticketNumber,
        status: ticket.status,
        priority: ticket.priority,
        requesterContactId: resolvedContactId,
        channel: ticket.channel,
      },
      ticketId: ticket.id,
    });

    // ถ้า create พร้อม assignee ให้ log ticket.assigned เพิ่มด้วย
    // before: null เพราะ ticket เพิ่งสร้าง ยังไม่มี assignee มาก่อน
    if (assigneeId) {
      void audit.log({
        tenantId: ctx.tenantId,
        actor: { type: "member", memberId: member.id },
        targetType: "ticket",
        targetId: ticket.id,
        action: "ticket.assigned",
        before: { assigneeId: null },
        after: { assigneeId },
        ticketId: ticket.id,
      });
    }

    return NextResponse.json({ data: ticketWithRelations, error: null }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/tickets] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
