/**
 * GET   /api/tickets/:id  — agent ดู ticket รายชิ้น (เห็น INTERNAL messages ได้)
 * PATCH /api/tickets/:id  — agent เปลี่ยน status / priority / assigneeId
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId)
 *
 * ⚠️ Audit Log:
 *   - ทุกการเปลี่ยน status / priority / assigneeId ต้องบันทึกผ่าน audit.log()
 *   - เก็บ before/after ห้าม log PII
 *
 * Audience: requireAgent() — เฉพาะ agent ของ tenant นี้เท่านั้น
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { Prisma, TicketPriority, TicketStatus } from "@prisma/client";
import { verifyAssigneeMembership } from "@/lib/tickets";

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const patchTicketSchema = z
  .object({
    status: z.nativeEnum(TicketStatus).optional(),
    priority: z.nativeEnum(TicketPriority).optional(),
    assigneeId: z.string().nullable().optional(), // null = unassign
  })
  .refine(
    (data) => data.status !== undefined || data.priority !== undefined || data.assigneeId !== undefined,
    { message: "ต้องระบุ status, priority หรือ assigneeId อย่างน้อยหนึ่งอย่าง" }
  );

// =============================================================================
// GET /api/tickets/:id — view ticket + ALL messages (agent เห็น INTERNAL ได้)
// =============================================================================

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    // params เป็น Promise ใน Next.js 15+/16 — ต้อง await
    const { id } = await params;

    // 1. ตรวจ auth + tenant context
    const session = await requireAgent();
    const { ctx } = session;
    const db = tenantPrisma(ctx.tenantId);

    // 2. โหลด ticket — tenantPrisma inject tenantId อัตโนมัติ กัน cross-tenant read
    const ticket = await db.ticket.findFirst({
      where: { id },
      include: {
        requesterContact: {
          select: { id: true, name: true, email: true, avatarUrl: true, phone: true },
        },
        assignee: {
          select: {
            id: true,
            role: true,
            user: { select: { id: true, name: true, email: true, avatarUrl: true } },
          },
        },
        slaPolicy: {
          select: { id: true, name: true },
        },
        // agent เห็นทุก visibility (PUBLIC + INTERNAL)
        messages: {
          orderBy: { createdAt: "asc" },
          include: {
            authorMember: {
              select: {
                id: true,
                role: true,
                user: { select: { id: true, name: true, avatarUrl: true } },
              },
            },
            authorContact: {
              select: { id: true, name: true, email: true, avatarUrl: true },
            },
          },
        },
        _count: { select: { messages: true, attachments: true } },
      },
    });

    if (!ticket) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ ticket ที่ระบุ" } },
        { status: 404 }
      );
    }

    return NextResponse.json({ data: ticket, error: null }, { status: 200 });
  } catch (err) {
    console.error("[GET /api/tickets/:id] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}

// =============================================================================
// PATCH /api/tickets/:id — เปลี่ยน status / priority / assigneeId
// =============================================================================

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;

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

    const parsed = patchTicketSchema.safeParse(body);
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

    const { status, priority, assigneeId } = parsed.data;

    // 3. โหลด ticket ปัจจุบัน เพื่อเก็บ before state สำหรับ audit log
    // tenantPrisma inject tenantId อัตโนมัติ กัน cross-tenant update
    const existingTicket = await db.ticket.findFirst({
      where: { id },
      select: {
        id: true,
        status: true,
        priority: true,
        assigneeId: true,
        firstRespondedAt: true,
        resolvedAt: true,
      },
    });

    if (!existingTicket) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ ticket ที่ระบุ" } },
        { status: 404 }
      );
    }

    // 4. ถ้ามี assigneeId — verify ว่าเป็น active TenantMember ของ tenant นี้
    // กัน assign ข้าม tenant
    if (assigneeId !== null && assigneeId !== undefined) {
      const assigneeMember = await verifyAssigneeMembership(db, assigneeId);
      if (!assigneeMember) {
        return NextResponse.json(
          {
            data: null,
            error: {
              code: "ASSIGNEE_NOT_FOUND",
              message: "ไม่พบ agent ที่ระบุ หรือไม่ได้เป็นสมาชิกที่ active ของ workspace นี้",
            },
          },
          { status: 400 }
        );
      }
    }

    // 5. เตรียม update data
    // ใช้ TicketUncheckedUpdateInput เพื่อให้ set scalar FK (assigneeId) ได้โดยตรงแบบ type-safe
    // (TicketUpdateInput บังคับใช้ connect/disconnect สำหรับ relation — ทำให้ต้อง cast any)
    // TicketUncheckedUpdateInput อนุญาต scalar assigneeId/tenantId ตรง ๆ และ compatible กับ extension
    const updateData: Prisma.TicketUncheckedUpdateInput = {};
    if (status !== undefined) updateData.status = status;
    if (priority !== undefined) updateData.priority = priority;
    // assigneeId: null = unassign, string = assign ให้ member ที่ verify แล้ว
    if (assigneeId !== undefined) {
      updateData.assigneeId = assigneeId;
    }

    // ถ้า status เปลี่ยนเป็น SOLVED หรือ CLOSED → set resolvedAt
    if (
      status !== undefined &&
      (status === TicketStatus.SOLVED || status === TicketStatus.CLOSED) &&
      !existingTicket.resolvedAt
    ) {
      updateData.resolvedAt = new Date();
    }

    // FIX-10: clear resolvedAt เฉพาะเมื่อ reopen กลับมา NEW หรือ OPEN จริง ๆ
    // PENDING / ON_HOLD ยังถือว่าอยู่ในสถานะ resolved/รออยู่ — ไม่ clear
    if (
      status !== undefined &&
      (status === TicketStatus.NEW || status === TicketStatus.OPEN) &&
      existingTicket.resolvedAt
    ) {
      updateData.resolvedAt = null;
    }

    // 6. Update ticket — tenantPrisma inject tenantId + strip tenantId จาก data อัตโนมัติ
    const updatedTicket = await db.ticket.update({
      where: { id },
      data: updateData,
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
      },
    });

    // 7. Audit log — บันทึกทุก field ที่เปลี่ยน พร้อม before/after
    // ห้าม log PII (ไม่ log email/ชื่อ/body message)
    const auditPromises: Promise<void>[] = [];

    if (status !== undefined && status !== existingTicket.status) {
      auditPromises.push(
        audit.log({
          tenantId: ctx.tenantId,
          actor: { type: "member", memberId: member.id },
          targetType: "ticket",
          targetId: id,
          action: "ticket.status_changed",
          before: { status: existingTicket.status },
          after: { status },
          ticketId: id,
        })
      );
    }

    if (priority !== undefined && priority !== existingTicket.priority) {
      auditPromises.push(
        audit.log({
          tenantId: ctx.tenantId,
          actor: { type: "member", memberId: member.id },
          targetType: "ticket",
          targetId: id,
          action: "ticket.priority_changed",
          before: { priority: existingTicket.priority },
          after: { priority },
          ticketId: id,
        })
      );
    }

    if (assigneeId !== undefined && assigneeId !== existingTicket.assigneeId) {
      auditPromises.push(
        audit.log({
          tenantId: ctx.tenantId,
          actor: { type: "member", memberId: member.id },
          targetType: "ticket",
          targetId: id,
          action: "ticket.assigned",
          // ไม่ log userId/email — log แค่ memberId ที่ไม่ใช่ PII โดยตรง
          before: { assigneeId: existingTicket.assigneeId },
          after: { assigneeId },
          ticketId: id,
        })
      );
    }

    // audit.log เป็น soft-fail — ทำ parallel แล้วไม่ await เพื่อไม่ block response
    // (audit.log ภายในจัดการ error เอง ไม่ throw)
    void Promise.all(auditPromises);

    return NextResponse.json({ data: updatedTicket, error: null }, { status: 200 });
  } catch (err) {
    console.error("[PATCH /api/tickets/:id] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
