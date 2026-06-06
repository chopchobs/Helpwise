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
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import {
  parseBusinessHours,
  addBusinessMinutes,
  businessMinutesBetween,
  resolveSlaMinutes,
} from "@/lib/sla";
import { prisma } from "@/lib/prisma";

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
    const rawTicket = await db.ticket.findFirst({
      where: { id },
      select: {
        id: true,
        ticketNumber: true,
        subject: true,
        status: true,
        priority: true,
        createdAt: true,
        updatedAt: true,
        // SLA scalar fields — agent-side เท่านั้น
        firstResponseDueAt: true,
        resolutionDueAt: true,
        firstRespondedAt: true,
        resolvedAt: true,
        firstResponseBreached: true,
        resolutionBreached: true,
        slaPausedAt: true,
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

    if (!rawTicket) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ ticket ที่ระบุ" } },
        { status: 404 }
      );
    }

    // group SLA fields เป็น nested object + แปลง Date → ISO string
    // sla = null เมื่อ ticket ไม่มี deadline (firstResponseDueAt และ resolutionDueAt เป็น null ทั้งคู่)
    const hasSla =
      rawTicket.firstResponseDueAt !== null ||
      rawTicket.resolutionDueAt !== null;

    const ticket = {
      ...rawTicket,
      createdAt: rawTicket.createdAt.toISOString(),
      updatedAt: rawTicket.updatedAt.toISOString(),
      // แยก SLA fields ออกจาก root ใส่ใน nested object แทน
      firstResponseDueAt: undefined,
      resolutionDueAt: undefined,
      firstRespondedAt: undefined,
      resolvedAt: undefined,
      firstResponseBreached: undefined,
      resolutionBreached: undefined,
      slaPausedAt: undefined,
      sla: hasSla
        ? {
            firstResponseDueAt: rawTicket.firstResponseDueAt
              ? rawTicket.firstResponseDueAt.toISOString()
              : null,
            resolutionDueAt: rawTicket.resolutionDueAt
              ? rawTicket.resolutionDueAt.toISOString()
              : null,
            firstRespondedAt: rawTicket.firstRespondedAt
              ? rawTicket.firstRespondedAt.toISOString()
              : null,
            resolvedAt: rawTicket.resolvedAt
              ? rawTicket.resolvedAt.toISOString()
              : null,
            firstResponseBreached: rawTicket.firstResponseBreached,
            resolutionBreached: rawTicket.resolutionBreached,
            slaPausedAt: rawTicket.slaPausedAt
              ? rawTicket.slaPausedAt.toISOString()
              : null,
          }
        : null,
    };

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

    // 3. โหลด ticket ปัจจุบัน เพื่อเก็บ before state สำหรับ audit log + SLA fields
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
        // SLA fields สำหรับ pause/resume + priority recompute
        firstResponseDueAt: true,
        resolutionDueAt: true,
        slaPausedAt: true,
        slaPausedDurationMin: true,
        slaPolicyId: true,
        createdAt: true,
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

    // =========================================================================
    // SLA: Pause / Resume / Priority Recompute
    //
    // ตรวจ feature gate ก่อน — ถ้าปิดอยู่ทุก SLA mutation ถูก skip
    // ตรวจว่า ticket มี deadline อยู่ด้วย (null = feature ปิดตอนสร้าง)
    // =========================================================================

    const hasSla =
      existingTicket.firstResponseDueAt !== null ||
      existingTicket.resolutionDueAt !== null;

    if (hasSla && status !== undefined) {
      // ตรวจ sla_policies feature (pass ctx.plan กัน extra query)
      const slaEnabled = await hasFeature(ctx.tenantId, FEATURE_KEYS.SLA_POLICIES, ctx.plan);

      if (slaEnabled) {
        const now = new Date();
        const wasP = existingTicket.status === TicketStatus.PENDING;
        const isP = status === TicketStatus.PENDING;

        // อ่าน business hours ของ tenant (ใช้ prisma โดยตรง — ไม่ใช่ tenantPrisma เพราะ Tenant ไม่มี tenantId scope)
        const tenantRow = await prisma.tenant.findUnique({
          where: { id: ctx.tenantId },
          select: { settings: true },
        });
        const businessHours = parseBusinessHours(tenantRow?.settings ?? null);

        // PAUSE: transition เข้า PENDING (ยังไม่ได้ pause อยู่)
        // ตั้ง slaPausedAt = now เพื่อ mark จุดเริ่ม pause
        if (isP && !wasP && existingTicket.slaPausedAt === null) {
          updateData.slaPausedAt = now;
        }

        // RESUME: transition ออกจาก PENDING (เคย pause อยู่)
        // คำนวณ paused business-minutes แล้ว shift deadline ที่ยัง unmet ไปข้างหน้า
        if (!isP && wasP && existingTicket.slaPausedAt !== null) {
          const pausedMin = businessMinutesBetween(existingTicket.slaPausedAt, now, businessHours);
          const accumulatedPausedMin = existingTicket.slaPausedDurationMin + pausedMin;

          updateData.slaPausedAt = null;
          updateData.slaPausedDurationMin = accumulatedPausedMin;

          // shift firstResponseDueAt ถ้ายัง unmet (firstRespondedAt = null)
          if (
            existingTicket.firstRespondedAt === null &&
            existingTicket.firstResponseDueAt !== null
          ) {
            updateData.firstResponseDueAt = addBusinessMinutes(
              existingTicket.firstResponseDueAt,
              pausedMin,
              businessHours
            );
          }

          // shift resolutionDueAt ถ้ายัง unmet (resolvedAt = null)
          if (
            existingTicket.resolvedAt === null &&
            existingTicket.resolutionDueAt !== null
          ) {
            updateData.resolutionDueAt = addBusinessMinutes(
              existingTicket.resolutionDueAt,
              pausedMin,
              businessHours
            );
          }
        }
      }
    }

    // =========================================================================
    // SLA: Priority Recompute
    // เมื่อ priority เปลี่ยน และ ticket มี SLA deadlines อยู่ (feature เปิด)
    // คำนวณ deadline ใหม่จาก createdAt baseline โดยใช้ priority ใหม่
    // แล้ว shift ด้วย accumulated pausedDurationMin เพื่อ preserve pause history
    // =========================================================================

    if (
      priority !== undefined &&
      priority !== existingTicket.priority &&
      hasSla
    ) {
      const slaEnabled = await hasFeature(ctx.tenantId, FEATURE_KEYS.SLA_POLICIES, ctx.plan);

      if (slaEnabled) {
        // หา SlaPolicy row ที่ผูกกับ ticket นี้ (ถ้ามี)
        let policyRow = null;
        if (existingTicket.slaPolicyId) {
          policyRow = await prisma.slaPolicy.findUnique({
            where: { id: existingTicket.slaPolicyId },
            select: {
              firstResponseLowMin: true,
              firstResponseNormMin: true,
              firstResponseHighMin: true,
              firstResponseUrgMin: true,
              resolutionLowMin: true,
              resolutionNormMin: true,
              resolutionHighMin: true,
              resolutionUrgMin: true,
            },
          });
        }

        // อ่าน business hours (อาจ query ซ้ำถ้า status ไม่เปลี่ยน — acceptable)
        const tenantRow2 = await prisma.tenant.findUnique({
          where: { id: ctx.tenantId },
          select: { settings: true },
        });
        const bh2 = parseBusinessHours(tenantRow2?.settings ?? null);

        // เวลา pause สะสมที่ต้องชดเชย:
        //   - resume เกิดในรอบนี้ → updateData.slaPausedDurationMin รวม segment ล่าสุดแล้ว
        //   - ยัง pause อยู่ (slaPausedAt set, ไม่ได้ resume) → บวก segment ที่ยังค้าง (slaPausedAt→now)
        //     กันไม่ให้เสีย pause credit ที่ค้างเมื่อ recompute ระหว่างยัง PENDING
        //   - กรณีอื่น → ใช้ accumulated เดิม
        let pausedMin = existingTicket.slaPausedDurationMin;
        if (typeof updateData.slaPausedDurationMin === "number") {
          pausedMin = updateData.slaPausedDurationMin;
        } else if (existingTicket.slaPausedAt !== null) {
          pausedMin =
            existingTicket.slaPausedDurationMin +
            businessMinutesBetween(existingTicket.slaPausedAt, new Date(), bh2);
        }

        const { firstResponseMin, resolutionMin } = resolveSlaMinutes(policyRow, priority);

        // คำนวณ deadline ใหม่ใน "pass เดียว": createdAt + (SLA budget + เวลา pause สะสม)
        // ❗ ห้ามเรียก addBusinessMinutes ซ้อน 2 ชั้น — การเดิน business-hours จากขอบ window
        //    จะข้าม closed gap เกินจริง → deadline ถูก shift มากเกินไป (over-shift)
        const newFirstResponseDue = addBusinessMinutes(
          existingTicket.createdAt,
          firstResponseMin + pausedMin,
          bh2
        );
        const newResolutionDue = addBusinessMinutes(
          existingTicket.createdAt,
          resolutionMin + pausedMin,
          bh2
        );

        // recompute เฉพาะ deadline ที่ยัง unmet
        if (existingTicket.firstRespondedAt === null) {
          updateData.firstResponseDueAt = newFirstResponseDue;
        }
        if (existingTicket.resolvedAt === null) {
          updateData.resolutionDueAt = newResolutionDue;
        }
      }
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

    // SLA pause/resume audit — log action สำคัญ (ไม่ log deadline timestamp เพื่อ privacy)
    if (status !== undefined && status !== existingTicket.status && hasSla) {
      const wasP = existingTicket.status === TicketStatus.PENDING;
      const isP = status === TicketStatus.PENDING;

      if (isP && !wasP) {
        auditPromises.push(
          audit.log({
            tenantId: ctx.tenantId,
            actor: { type: "member", memberId: member.id },
            targetType: "ticket",
            targetId: id,
            action: "ticket.sla_paused",
            ticketId: id,
          })
        );
      } else if (!isP && wasP && existingTicket.slaPausedAt !== null) {
        auditPromises.push(
          audit.log({
            tenantId: ctx.tenantId,
            actor: { type: "member", memberId: member.id },
            targetType: "ticket",
            targetId: id,
            action: "ticket.sla_resumed",
            ticketId: id,
          })
        );
      }
    }

    // audit.log เป็น soft-fail — ทำ parallel แล้วไม่ await เพื่อไม่ block response
    // (audit.log ภายในจัดการ error เอง ไม่ throw)
    void Promise.all(auditPromises);

    // group SLA fields เป็น nested object (เหมือน GET) — frontend ต้องใช้ sla ที่ shift แล้ว
    // หลัง pause/resume เพื่ออัปเดต badge ทันที ไม่ stale (กรณีไม่ทำ badge จะค้าง countdown เดิม)
    const hasSlaResp =
      updatedTicket.firstResponseDueAt !== null ||
      updatedTicket.resolutionDueAt !== null;

    const responseTicket = {
      ...updatedTicket,
      createdAt: updatedTicket.createdAt.toISOString(),
      updatedAt: updatedTicket.updatedAt.toISOString(),
      // แยก SLA scalar ออกจาก root ใส่ nested object แทน (ตรงกับ AgentTicketSummary)
      firstResponseDueAt: undefined,
      resolutionDueAt: undefined,
      firstRespondedAt: undefined,
      resolvedAt: undefined,
      firstResponseBreached: undefined,
      resolutionBreached: undefined,
      slaPausedAt: undefined,
      sla: hasSlaResp
        ? {
            firstResponseDueAt: updatedTicket.firstResponseDueAt
              ? updatedTicket.firstResponseDueAt.toISOString()
              : null,
            resolutionDueAt: updatedTicket.resolutionDueAt
              ? updatedTicket.resolutionDueAt.toISOString()
              : null,
            firstRespondedAt: updatedTicket.firstRespondedAt
              ? updatedTicket.firstRespondedAt.toISOString()
              : null,
            resolvedAt: updatedTicket.resolvedAt
              ? updatedTicket.resolvedAt.toISOString()
              : null,
            firstResponseBreached: updatedTicket.firstResponseBreached,
            resolutionBreached: updatedTicket.resolutionBreached,
            slaPausedAt: updatedTicket.slaPausedAt
              ? updatedTicket.slaPausedAt.toISOString()
              : null,
          }
        : null,
    };

    return NextResponse.json({ data: responseTicket, error: null }, { status: 200 });
  } catch (err) {
    console.error("[PATCH /api/tickets/:id] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
