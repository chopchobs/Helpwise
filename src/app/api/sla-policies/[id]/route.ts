/**
 * GET    /api/sla-policies/:id — ดู SLA policy รายชิ้น
 * PATCH  /api/sla-policies/:id — แก้ไข name/minutes/isDefault
 * DELETE /api/sla-policies/:id — ลบ SLA policy
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId)
 *   - ถ้า policy ไม่พบในเฉพาะ tenant นี้ → 404 (ห้าม leak ว่ามีอยู่ใน tenant อื่น)
 *
 * ⚠️ Default Invariant:
 *   - set isDefault: true ต้องทำใน transaction (unset อื่น → set ใหม่)
 *
 * ⚠️ DELETE Guards:
 *   - ห้ามลบ isDefault policy → 409 CANNOT_DELETE_DEFAULT
 *   - ห้ามลบ policy ตัวสุดท้าย → 409 CANNOT_DELETE_LAST
 *   - ถ้ามี ticket ผูกอยู่ → reassign ไป default policy ใน transaction เดียวกับ delete
 *
 * Audience: requireAgent({ roles: ["OWNER","ADMIN"] }) — admin-only
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { toDTO } from "../_dto";

// =============================================================================
// ZOD SCHEMA
// =============================================================================

const minuteField = z
  .number()
  .int("ต้องเป็นจำนวนเต็ม")
  .positive("ต้องมากกว่า 0")
  .max(100000, "ต้องไม่เกิน 100000 นาที");

const patchSlaPolicySchema = z
  .object({
    name: z
      .string()
      .min(1, "ชื่อ policy ต้องไม่ว่าง")
      .max(80, "ชื่อ policy ต้องไม่เกิน 80 ตัวอักษร")
      .transform((v) => v.trim())
      .optional(),
    isDefault: z.boolean().optional(),
    firstResponseLowMin: minuteField.optional(),
    firstResponseNormMin: minuteField.optional(),
    firstResponseHighMin: minuteField.optional(),
    firstResponseUrgMin: minuteField.optional(),
    resolutionLowMin: minuteField.optional(),
    resolutionNormMin: minuteField.optional(),
    resolutionHighMin: minuteField.optional(),
    resolutionUrgMin: minuteField.optional(),
  })
  .refine(
    (data) => Object.keys(data).length > 0,
    { message: "ต้องระบุ field อย่างน้อยหนึ่งอย่างที่ต้องการเปลี่ยน" }
  );

// =============================================================================
// GET /api/sla-policies/:id — ดู policy รายชิ้น
// =============================================================================

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    // params เป็น Promise ใน Next.js 16 — ต้อง await
    const { id } = await params;

    // 1. Auth gate — OWNER/ADMIN เท่านั้น
    const session = await requireAgent({ roles: ["OWNER", "ADMIN"] });
    const { ctx } = session;
    const tenantId = ctx.tenantId; // ห้ามรับ tenantId จาก client

    // 2. Feature gate
    const featureEnabled = await hasFeature(tenantId, FEATURE_KEYS.SLA_POLICIES, ctx.plan);
    if (!featureEnabled) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "FEATURE_LOCKED",
            message: "SLA Policies ไม่รวมอยู่ใน plan ปัจจุบัน กรุณา upgrade เพื่อใช้งาน",
          },
        },
        { status: 403 }
      );
    }

    // 3. ดึง policy — tenantPrisma inject tenantId อัตโนมัติ กัน cross-tenant read
    const db = tenantPrisma(tenantId);
    const policy = await db.slaPolicy.findFirst({
      where: { id },
      include: { _count: { select: { tickets: true } } },
    });

    // ถ้าไม่พบใน tenant นี้ → 404 (ไม่ leak ว่ามีอยู่ใน tenant อื่น)
    if (!policy) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ SLA Policy ที่ระบุ" } },
        { status: 404 }
      );
    }

    return NextResponse.json({ data: toDTO(policy), error: null }, { status: 200 });
  } catch (err) {
    console.error("[GET /api/sla-policies/:id] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}

// =============================================================================
// PATCH /api/sla-policies/:id — แก้ไข policy
// =============================================================================

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;

    // 1. Auth gate — OWNER/ADMIN เท่านั้น
    const session = await requireAgent({ roles: ["OWNER", "ADMIN"] });
    const { ctx, member } = session;
    const tenantId = ctx.tenantId;

    // 2. Feature gate
    const featureEnabled = await hasFeature(tenantId, FEATURE_KEYS.SLA_POLICIES, ctx.plan);
    if (!featureEnabled) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "FEATURE_LOCKED",
            message: "SLA Policies ไม่รวมอยู่ใน plan ปัจจุบัน กรุณา upgrade เพื่อใช้งาน",
          },
        },
        { status: 403 }
      );
    }

    // 3. Parse + validate body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { data: null, error: { code: "INVALID_JSON", message: "Request body ต้องเป็น JSON" } },
        { status: 400 }
      );
    }

    const parsed = patchSlaPolicySchema.safeParse(body);
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

    const input = parsed.data;

    // 4. โหลด policy ปัจจุบัน — เพื่อ before snapshot + verify ownership
    const db = tenantPrisma(tenantId);
    const existing = await db.slaPolicy.findFirst({
      where: { id },
    });

    if (!existing) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ SLA Policy ที่ระบุ" } },
        { status: 404 }
      );
    }

    // 4a. Default invariant guard: ห้าม unset default โดยตรง (จะทำให้ tenant เหลือ 0 default)
    //     การเปลี่ยน default ต้องทำผ่านการ set isDefault=true บน policy อื่นแทน
    if (input.isDefault === false && existing.isDefault === true) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "CANNOT_UNSET_DEFAULT",
            message: "ไม่สามารถยกเลิก default ได้โดยตรง กรุณาตั้ง policy อื่นเป็น default แทน",
          },
        },
        { status: 409 }
      );
    }

    // 5. Update ใน transaction — ถ้า set isDefault: true ต้อง unset อื่นก่อน (default invariant)
    const updatedPolicy = await prisma.$transaction(async (tx) => {
      if (input.isDefault === true) {
        // unset isDefault ของ policy อื่น ๆ ใน tenant นี้ก่อน
        await tx.slaPolicy.updateMany({
          where: { tenantId, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }

      return tx.slaPolicy.update({
        where: { id, tenantId }, // scope ด้วย tenantId เพื่อ guard cross-tenant write
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
          ...(input.firstResponseLowMin !== undefined && { firstResponseLowMin: input.firstResponseLowMin }),
          ...(input.firstResponseNormMin !== undefined && { firstResponseNormMin: input.firstResponseNormMin }),
          ...(input.firstResponseHighMin !== undefined && { firstResponseHighMin: input.firstResponseHighMin }),
          ...(input.firstResponseUrgMin !== undefined && { firstResponseUrgMin: input.firstResponseUrgMin }),
          ...(input.resolutionLowMin !== undefined && { resolutionLowMin: input.resolutionLowMin }),
          ...(input.resolutionNormMin !== undefined && { resolutionNormMin: input.resolutionNormMin }),
          ...(input.resolutionHighMin !== undefined && { resolutionHighMin: input.resolutionHighMin }),
          ...(input.resolutionUrgMin !== undefined && { resolutionUrgMin: input.resolutionUrgMin }),
        },
        include: { _count: { select: { tickets: true } } },
      });
    });

    // 6. Audit log — บันทึก sla_policy.updated พร้อม before/after snapshot
    //    ห้าม log PII — minute fields + name + isDefault ปลอดภัย
    void audit.log({
      tenantId,
      actor: { type: "member", memberId: member.id },
      targetType: "sla_policy",
      targetId: id,
      action: "sla_policy.updated",
      before: {
        name: existing.name,
        isDefault: existing.isDefault,
        firstResponseLowMin: existing.firstResponseLowMin,
        firstResponseNormMin: existing.firstResponseNormMin,
        firstResponseHighMin: existing.firstResponseHighMin,
        firstResponseUrgMin: existing.firstResponseUrgMin,
        resolutionLowMin: existing.resolutionLowMin,
        resolutionNormMin: existing.resolutionNormMin,
        resolutionHighMin: existing.resolutionHighMin,
        resolutionUrgMin: existing.resolutionUrgMin,
      },
      after: {
        name: updatedPolicy.name,
        isDefault: updatedPolicy.isDefault,
        firstResponseLowMin: updatedPolicy.firstResponseLowMin,
        firstResponseNormMin: updatedPolicy.firstResponseNormMin,
        firstResponseHighMin: updatedPolicy.firstResponseHighMin,
        firstResponseUrgMin: updatedPolicy.firstResponseUrgMin,
        resolutionLowMin: updatedPolicy.resolutionLowMin,
        resolutionNormMin: updatedPolicy.resolutionNormMin,
        resolutionHighMin: updatedPolicy.resolutionHighMin,
        resolutionUrgMin: updatedPolicy.resolutionUrgMin,
      },
    });

    // ถ้า default เปลี่ยน → log เพิ่ม
    if (input.isDefault !== undefined && input.isDefault !== existing.isDefault) {
      void audit.log({
        tenantId,
        actor: { type: "member", memberId: member.id },
        targetType: "sla_policy",
        targetId: id,
        action: "sla_policy.default_changed",
        before: { isDefault: existing.isDefault },
        after: { isDefault: updatedPolicy.isDefault, defaultPolicyId: updatedPolicy.isDefault ? id : null },
      });
    }

    return NextResponse.json({ data: toDTO(updatedPolicy), error: null }, { status: 200 });
  } catch (err) {
    console.error("[PATCH /api/sla-policies/:id] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}

// =============================================================================
// DELETE /api/sla-policies/:id — ลบ SLA policy
// =============================================================================

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;

    // 1. Auth gate — OWNER/ADMIN เท่านั้น
    const session = await requireAgent({ roles: ["OWNER", "ADMIN"] });
    const { ctx, member } = session;
    const tenantId = ctx.tenantId;

    // 2. Feature gate
    const featureEnabled = await hasFeature(tenantId, FEATURE_KEYS.SLA_POLICIES, ctx.plan);
    if (!featureEnabled) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "FEATURE_LOCKED",
            message: "SLA Policies ไม่รวมอยู่ใน plan ปัจจุบัน กรุณา upgrade เพื่อใช้งาน",
          },
        },
        { status: 403 }
      );
    }

    const db = tenantPrisma(tenantId);

    // 3. โหลด policy ปัจจุบัน + count ทั้งหมด ของ tenant ใน parallel
    const [policy, totalCount] = await Promise.all([
      db.slaPolicy.findFirst({
        where: { id },
        include: { _count: { select: { tickets: true } } },
      }),
      db.slaPolicy.count({}),
    ]);

    if (!policy) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ SLA Policy ที่ระบุ" } },
        { status: 404 }
      );
    }

    // 4. Guard: ห้ามลบ policy ตัวสุดท้าย
    if (totalCount <= 1) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "CANNOT_DELETE_LAST",
            message: "ไม่สามารถลบ SLA Policy ตัวเดียวที่เหลืออยู่ได้",
          },
        },
        { status: 409 }
      );
    }

    // 5. Guard: ห้ามลบ policy ที่เป็น default (ต้องตั้ง default ตัวอื่นก่อน)
    if (policy.isDefault) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "CANNOT_DELETE_DEFAULT",
            message: "ไม่สามารถลบ SLA Policy ที่เป็น default ได้ กรุณาตั้ง policy อื่นเป็น default ก่อน",
          },
        },
        { status: 409 }
      );
    }

    // 6. ทำใน transaction:
    //    - reassign tickets ที่ผูกกับ policy นี้ไป default ก่อน (กัน orphan FK)
    //    - แล้วค่อย delete policy
    await prisma.$transaction(async (tx) => {
      // หา policy ปลายทางสำหรับ reassign: default ก่อน, fallback เป็น policy อื่นใด ๆ
      const defaultPolicy = await tx.slaPolicy.findFirst({
        where: { tenantId, isDefault: true, id: { not: id } },
        select: { id: true },
      });
      const targetPolicy =
        defaultPolicy ??
        (await tx.slaPolicy.findFirst({
          where: { tenantId, id: { not: id } },
          select: { id: true },
        }));

      if (!targetPolicy) {
        // ไม่ควรเกิด — guard ตัวสุดท้ายผ่านแล้ว แต่ป้องกัน orphan ไว้
        throw new Error("ไม่พบ policy สำรองสำหรับ reassign tickets");
      }

      // reassign แบบ unconditional — no-op ถ้าไม่มี ticket ผูกอยู่
      // (กัน stale-count: ถ้ามี ticket ถูก assign เพิ่มหลังอ่าน snapshot ก็ยังถูกย้าย)
      await tx.ticket.updateMany({
        where: { tenantId, slaPolicyId: id },
        data: { slaPolicyId: targetPolicy.id },
      });

      // ลบ policy (tenantId ใน where กัน cross-tenant delete)
      await tx.slaPolicy.delete({
        where: { id, tenantId },
      });
    });

    // 7. Audit log — บันทึก sla_policy.deleted
    void audit.log({
      tenantId,
      actor: { type: "member", memberId: member.id },
      targetType: "sla_policy",
      targetId: id,
      action: "sla_policy.deleted",
      before: {
        name: policy.name,
        isDefault: policy.isDefault,
        firstResponseLowMin: policy.firstResponseLowMin,
        firstResponseNormMin: policy.firstResponseNormMin,
        firstResponseHighMin: policy.firstResponseHighMin,
        firstResponseUrgMin: policy.firstResponseUrgMin,
        resolutionLowMin: policy.resolutionLowMin,
        resolutionNormMin: policy.resolutionNormMin,
        resolutionHighMin: policy.resolutionHighMin,
        resolutionUrgMin: policy.resolutionUrgMin,
        ticketCount: policy._count.tickets,
      },
    });

    return NextResponse.json({ data: { deleted: true }, error: null }, { status: 200 });
  } catch (err) {
    console.error("[DELETE /api/sla-policies/:id] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
