/**
 * POST /api/tickets/:id/merge — agent รวม source ticket เข้า target ticket
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId); ใน $transaction ใช้ prisma ตรง + ใส่ tenantId เอง
 *
 * ⚠️ Privacy Guard:
 *   - merge ได้เฉพาะ ticket ที่ requesterContactId ตรงกัน เท่านั้น
 *     (ป้องกัน message ของ contact A หลุดไปอยู่ใต้ ticket ของ contact B → cross-contact leak)
 *
 * ⚠️ Role:
 *   - เฉพาะ OWNER/ADMIN เท่านั้นที่ merge ได้ (destructive action)
 *
 * Behavior:
 *   - ย้าย messages + attachments ของ source → target
 *   - ใส่ internal note บน target อ้างอิง source
 *   - ปิด source เป็น CLOSED + ตั้ง mergedIntoId = target.id
 *   - บันทึก AuditLog
 *
 * Audience: requireAgent({ roles: ["OWNER", "ADMIN"] })
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma, setTenantGuc } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { MessageVisibility, TicketStatus } from "@prisma/client";

// =============================================================================
// VALIDATION SCHEMA
// =============================================================================

const mergeTicketSchema = z.object({
  targetTicketNumber: z.number().int().positive(),
});

// =============================================================================
// POST /api/tickets/:id/merge
// =============================================================================

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    // params เป็น Promise ใน Next.js 15+/16 — ต้อง await
    const { id } = await params;

    // 1. ตรวจ auth — merge เป็น destructive action จำกัดเฉพาะ OWNER/ADMIN
    const session = await requireAgent({ roles: ["OWNER", "ADMIN"] });
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

    const parsed = mergeTicketSchema.safeParse(body);
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

    const { targetTicketNumber } = parsed.data;

    // 3. โหลด source ticket — tenantPrisma inject tenantId กัน cross-tenant
    const source = await db.ticket.findFirst({
      where: { id },
      select: {
        id: true,
        ticketNumber: true,
        requesterContactId: true,
        mergedIntoId: true,
        status: true,
      },
    });

    if (!source) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ ticket ที่ระบุ" } },
        { status: 404 }
      );
    }

    // 4. resolve target จาก ticketNumber — ภายใน tenant scope เดียวกัน
    const target = await db.ticket.findFirst({
      where: { ticketNumber: targetTicketNumber },
      select: {
        id: true,
        ticketNumber: true,
        requesterContactId: true,
        mergedIntoId: true,
      },
    });

    if (!target) {
      return NextResponse.json(
        { data: null, error: { code: "TARGET_NOT_FOUND", message: "ไม่พบ ticket ปลายทางที่ระบุ" } },
        { status: 404 }
      );
    }

    // 5. Validations ก่อน mutate

    // ห้าม merge เข้าตัวเอง
    if (source.id === target.id) {
      return NextResponse.json(
        { data: null, error: { code: "CANNOT_MERGE_SELF", message: "ไม่สามารถ merge ticket เข้ากับตัวเองได้" } },
        { status: 400 }
      );
    }

    // 🔒 PRIVACY GUARD: requester ต้องตรงกัน — กัน message ของลูกค้าคนหนึ่งหลุดไปอยู่
    // ใต้ ticket ของลูกค้าอีกคน (cross-contact data exposure ผ่านการ re-parent)
    if (source.requesterContactId !== target.requesterContactId) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "CANNOT_MERGE_DIFFERENT_REQUESTER",
            message: "ไม่สามารถ merge ticket ของลูกค้าคนละคนได้",
          },
        },
        { status: 400 }
      );
    }

    // source ถูก merge ไปแล้ว — merge ซ้ำไม่ได้
    if (source.mergedIntoId !== null) {
      return NextResponse.json(
        { data: null, error: { code: "ALREADY_MERGED", message: "ticket นี้ถูกรวมไปแล้ว" } },
        { status: 409 }
      );
    }

    // target ถูก merge ไปแล้ว — กัน merge chain/loop
    if (target.mergedIntoId !== null) {
      return NextResponse.json(
        {
          data: null,
          error: { code: "TARGET_ALREADY_MERGED", message: "ไม่สามารถ merge เข้า ticket ที่ถูกรวมไปแล้ว" },
        },
        { status: 409 }
      );
    }

    // 6. Transaction — re-parent messages/attachments, internal note, ปิด source
    // ⚠️ ใน $transaction ใช้ base prisma (tenantPrisma ไม่ compose กับ $transaction)
    // ต้องใส่ tenantId เองทุก where/data
    await prisma.$transaction(async (tx) => {
      // Phase 27 RLS: ตั้ง tenant GUC ใน tx นี้ (Ticket/TicketMessage/Attachment ถูก FORCE RLS)
      await setTenantGuc(tx, ctx.tenantId);
      // 6.1 re-parent messages → target
      await tx.ticketMessage.updateMany({
        where: { tenantId: ctx.tenantId, ticketId: source.id },
        data: { ticketId: target.id },
      });

      // 6.2 re-parent attachments → target
      await tx.attachment.updateMany({
        where: { tenantId: ctx.tenantId, ticketId: source.id },
        data: { ticketId: target.id },
      });

      // 6.3 internal note บน target อ้างอิง source — visibility=INTERNAL ห้ามหลุด portal
      await tx.ticketMessage.create({
        data: {
          tenantId: ctx.tenantId,
          ticketId: target.id,
          body: `รวมจาก ticket #${source.ticketNumber}`,
          visibility: MessageVisibility.INTERNAL,
          authorMemberId: member.id,
        },
      });

      // 6.4 ปิด source + ตั้ง mergedIntoId
      await tx.ticket.update({
        where: { id: source.id },
        data: {
          status: TicketStatus.CLOSED,
          mergedIntoId: target.id,
          resolvedAt: new Date(),
        },
      });
    });

    // 7. Audit log — บันทึกหลัง transaction สำเร็จ
    void audit.log({
      tenantId: ctx.tenantId,
      actor: { type: "member", memberId: member.id },
      targetType: "ticket",
      targetId: source.id,
      action: "ticket.merged",
      before: { status: source.status, mergedIntoId: null },
      after: { status: TicketStatus.CLOSED, mergedIntoId: target.id },
      metadata: {
        sourceTicketNumber: source.ticketNumber,
        targetTicketNumber: target.ticketNumber,
      },
      ticketId: source.id,
    });

    return NextResponse.json(
      {
        data: {
          source: {
            id: source.id,
            ticketNumber: source.ticketNumber,
            status: TicketStatus.CLOSED,
            mergedInto: { id: target.id, ticketNumber: target.ticketNumber },
          },
          target: { id: target.id, ticketNumber: target.ticketNumber },
        },
        error: null,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("[POST /api/tickets/:id/merge] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
