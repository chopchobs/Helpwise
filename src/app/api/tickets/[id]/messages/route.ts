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
 * Audience: requireAgent() — เฉพาะ agent ของ tenant นี้เท่านั้น
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { MessageVisibility, Prisma, TicketStatus } from "@prisma/client";
import { createTicketMessage } from "@/lib/tickets";

// =============================================================================
// VALIDATION SCHEMA
// =============================================================================

const createMessageSchema = z.object({
  body: z.string().min(1, "body ห้ามว่าง").max(50000, "body ยาวเกิน 50,000 ตัวอักษร"),
  // agent สามารถเลือก visibility ได้ (PUBLIC หรือ INTERNAL)
  visibility: z.enum(["PUBLIC", "INTERNAL"]).default("PUBLIC"),
});

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

    const { body: messageBody, visibility } = parsed.data;

    // 3. ดึง ticket ปัจจุบัน — tenantPrisma inject tenantId อัตโนมัติ
    const ticket = await db.ticket.findFirst({
      where: { id: ticketId },
      select: {
        id: true,
        status: true,
        firstRespondedAt: true,
      },
    });

    if (!ticket) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ ticket ที่ระบุ" } },
        { status: 404 }
      );
    }

    // 4. สร้าง message — author = agent member ที่ login อยู่
    const message = await createTicketMessage(db, {
      tenantId: ctx.tenantId,
      ticketId,
      body: messageBody,
      visibility: visibility as MessageVisibility,
      authorMemberId: member.id,
    });

    // 5. ตรวจสอบและ update ticket state ตาม business logic
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

    return NextResponse.json({ data: message, error: null }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/tickets/:id/messages] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
