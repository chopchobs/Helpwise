/**
 * GET  /api/sla-policies — list SLA policies ของ tenant
 * POST /api/sla-policies — สร้าง SLA policy ใหม่
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId)
 *
 * ⚠️ Feature Gate:
 *   - ทุก endpoint เช็ค hasFeature(SLA_POLICIES) ก่อน → 403 FEATURE_LOCKED ถ้าปิด
 *   - POST เพิ่มตรวจ plan limit (maxSlaPolicies) + MULTIPLE_SLA_POLICIES
 *
 * ⚠️ Default Invariant:
 *   - 1 tenant มี isDefault: true ได้แค่ 1 policy เสมอ
 *   - การ set isDefault: true ต้องทำใน transaction (unset อื่น → set ใหม่)
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
import { toDTO } from "./_dto";

/** Sentinel error: ใช้โยนใน transaction เมื่อ re-count ทะลุ plan cap (TOCTOU guard) */
class PlanLimitError extends Error {
  constructor() {
    super("PLAN_LIMIT_REACHED");
    this.name = "PlanLimitError";
  }
}

// =============================================================================
// ZOD SCHEMA — minute fields (ใช้ร่วมกันทั้ง create และ update)
// =============================================================================

/** Zod refinement สำหรับ minute field: ต้องเป็น Int บวก ≤ 100000 */
const minuteField = z
  .number()
  .int("ต้องเป็นจำนวนเต็ม")
  .positive("ต้องมากกว่า 0")
  .max(100000, "ต้องไม่เกิน 100000 นาที");

const createSlaPolicySchema = z.object({
  name: z
    .string()
    .min(1, "ชื่อ policy ต้องไม่ว่าง")
    .max(80, "ชื่อ policy ต้องไม่เกิน 80 ตัวอักษร")
    .transform((v) => v.trim()),
  isDefault: z.boolean().optional(),
  firstResponseLowMin: minuteField,
  firstResponseNormMin: minuteField,
  firstResponseHighMin: minuteField,
  firstResponseUrgMin: minuteField,
  resolutionLowMin: minuteField,
  resolutionNormMin: minuteField,
  resolutionHighMin: minuteField,
  resolutionUrgMin: minuteField,
});

// =============================================================================
// GET /api/sla-policies — list all policies ของ tenant
// =============================================================================

export async function GET(): Promise<NextResponse> {
  try {
    // 1. Auth gate — OWNER/ADMIN เท่านั้น
    const session = await requireAgent({ roles: ["OWNER", "ADMIN"] });
    const { ctx } = session; // GET ไม่ mutate → ไม่ต้องใช้ member (audit)
    const tenantId = ctx.tenantId; // ห้ามรับ tenantId จาก client

    // 2. Feature gate — sla_policies ต้องเปิด (pass ctx.plan กัน extra query)
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

    // 3. ดึง maxSlaPolicies ของ plan ปัจจุบัน + list policies ใน parallel
    //    plan เป็น global model ดึงผ่าน prisma โดยตรง (ไม่มี tenantId)
    const [planRow, policies] = await Promise.all([
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { plan: { select: { maxSlaPolicies: true } } },
      }),
      // tenantPrisma inject tenantId ใน where อัตโนมัติ — tenant-scoped เสมอ
      db.slaPolicy.findMany({
        orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
        include: { _count: { select: { tickets: true } } },
      }),
    ]);

    const maxPolicies = planRow?.plan.maxSlaPolicies ?? 1;
    const currentCount = policies.length;

    // คำนวณ canCreateMore:
    //   - ยังไม่เกิน maxSlaPolicies (หรือ 0 = unlimited)
    //   - ถ้าจะสร้าง policy ที่ 2+ ต้องมี MULTIPLE_SLA_POLICIES feature ด้วย
    let canCreateMore = maxPolicies === 0 || currentCount < maxPolicies;
    if (canCreateMore && currentCount >= 1) {
      const hasMultiple = await hasFeature(tenantId, FEATURE_KEYS.MULTIPLE_SLA_POLICIES, ctx.plan);
      if (!hasMultiple) canCreateMore = false;
    }

    return NextResponse.json(
      {
        data: {
          policies: policies.map(toDTO),
          canCreateMore,
          maxPolicies,
        },
        error: null,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("[GET /api/sla-policies] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}

// =============================================================================
// POST /api/sla-policies — สร้าง SLA policy ใหม่
// =============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // 1. Auth gate — OWNER/ADMIN เท่านั้น
    const session = await requireAgent({ roles: ["OWNER", "ADMIN"] });
    const { ctx, member } = session;
    const tenantId = ctx.tenantId; // ห้ามรับ tenantId จาก client

    // 2. Feature gate — sla_policies ต้องเปิด
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

    const parsed = createSlaPolicySchema.safeParse(body);
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

    // 4. Plan limit gate — นับ policy ปัจจุบันของ tenant
    //    ดึง plan + count ใน parallel เพื่อลด latency
    const db = tenantPrisma(tenantId);
    const [planRow, currentCount] = await Promise.all([
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { plan: { select: { maxSlaPolicies: true } } },
      }),
      db.slaPolicy.count({}),
    ]);

    const maxPolicies = planRow?.plan.maxSlaPolicies ?? 1;

    // 4a. ตรวจ plan cap (maxSlaPolicies > 0 = จำกัด, 0 = unlimited)
    if (maxPolicies > 0 && currentCount >= maxPolicies) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "PLAN_LIMIT_REACHED",
            message: `Plan ปัจจุบันสามารถมี SLA policy ได้สูงสุด ${maxPolicies} รายการ กรุณา upgrade เพื่อเพิ่ม`,
          },
        },
        { status: 403 }
      );
    }

    // 4b. ถ้ากำลังสร้าง policy ที่ 2+ ต้องมี MULTIPLE_SLA_POLICIES feature
    if (currentCount >= 1) {
      const hasMultiple = await hasFeature(tenantId, FEATURE_KEYS.MULTIPLE_SLA_POLICIES, ctx.plan);
      if (!hasMultiple) {
        return NextResponse.json(
          {
            data: null,
            error: {
              code: "FEATURE_LOCKED",
              message: "การสร้าง SLA Policy หลายรายการต้องการ feature multiple_sla_policies กรุณา upgrade",
            },
          },
          { status: 403 }
        );
      }
    }

    // 5. สร้าง policy ใน transaction
    //    ถ้า isDefault: true ต้อง unset isDefault ของ policy อื่นก่อน (default invariant)
    const newPolicy = await prisma.$transaction(async (tx) => {
      // กัน TOCTOU: re-count ภายใน transaction อีกครั้ง — สอง POST พร้อมกันจะไม่ทะลุ plan cap
      // (count ก่อน tx เป็นแค่ fast-feedback; การตัดสินจริงต้องเกิดใน tx)
      if (maxPolicies > 0) {
        const countInTx = await tx.slaPolicy.count({ where: { tenantId } });
        if (countInTx >= maxPolicies) {
          throw new PlanLimitError();
        }
      }

      // default invariant: ถ้า set isDefault=true ต้อง unset policy อื่นก่อน
      if (input.isDefault) {
        // unset isDefault ของ policy อื่น ๆ ใน tenant นี้
        await tx.slaPolicy.updateMany({
          where: { tenantId, isDefault: true },
          data: { isDefault: false },
        });
      }

      // สร้าง policy ใหม่ — ใช้ scalar tenantId ตาม project gotcha
      // (tenantPrisma ใน transaction ไม่ทำงาน — ต้องส่ง tenantId เอง)
      return tx.slaPolicy.create({
        data: {
          tenantId,
          name: input.name,
          isDefault: input.isDefault ?? false,
          firstResponseLowMin: input.firstResponseLowMin,
          firstResponseNormMin: input.firstResponseNormMin,
          firstResponseHighMin: input.firstResponseHighMin,
          firstResponseUrgMin: input.firstResponseUrgMin,
          resolutionLowMin: input.resolutionLowMin,
          resolutionNormMin: input.resolutionNormMin,
          resolutionHighMin: input.resolutionHighMin,
          resolutionUrgMin: input.resolutionUrgMin,
        },
        include: { _count: { select: { tickets: true } } },
      });
    });

    // 6. Audit log — บันทึก sla_policy.created
    void audit.log({
      tenantId,
      actor: { type: "member", memberId: member.id },
      targetType: "sla_policy",
      targetId: newPolicy.id,
      action: "sla_policy.created",
      after: {
        name: newPolicy.name,
        isDefault: newPolicy.isDefault,
        firstResponseLowMin: newPolicy.firstResponseLowMin,
        firstResponseNormMin: newPolicy.firstResponseNormMin,
        firstResponseHighMin: newPolicy.firstResponseHighMin,
        firstResponseUrgMin: newPolicy.firstResponseUrgMin,
        resolutionLowMin: newPolicy.resolutionLowMin,
        resolutionNormMin: newPolicy.resolutionNormMin,
        resolutionHighMin: newPolicy.resolutionHighMin,
        resolutionUrgMin: newPolicy.resolutionUrgMin,
      },
    });

    // ถ้า set isDefault: true ต้อง log การเปลี่ยน default แยกด้วย
    if (newPolicy.isDefault) {
      void audit.log({
        tenantId,
        actor: { type: "member", memberId: member.id },
        targetType: "sla_policy",
        targetId: newPolicy.id,
        action: "sla_policy.default_changed",
        after: { defaultPolicyId: newPolicy.id },
      });
    }

    return NextResponse.json({ data: toDTO(newPolicy), error: null }, { status: 201 });
  } catch (err) {
    // TOCTOU guard: race ที่ทะลุ plan cap ภายใน tx → 403 (ไม่ใช่ 500)
    if (err instanceof PlanLimitError) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "PLAN_LIMIT_REACHED",
            message: "Plan ปัจจุบันมี SLA policy ครบจำนวนสูงสุดแล้ว กรุณา upgrade เพื่อเพิ่ม",
          },
        },
        { status: 403 }
      );
    }
    console.error("[POST /api/sla-policies] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
