/**
 * src/lib/features.ts
 * Feature Flag resolution — 2-layer system
 *
 * Layer 1 (per-tenant override): TenantFeature.enabled ชนะเสมอ ถ้ามี record
 * Layer 2 (global default): FeatureFlag.requiredPlan เทียบกับ plan ของ tenant
 *                           → ถ้าไม่มี requiredPlan ก็ใช้ defaultEnabled
 *
 * ⚠️ ห้าม hardcode plan check: `if (tenant.plan === 'pro')` ในที่อื่น
 *    ใช้ hasFeature() ทุกครั้ง เพื่อให้ใส่ override ราย tenant ได้
 *
 * gate ที่ API layer: ถ้า !hasFeature(tenantId, key) → 403 + upgrade error code
 *
 * การเพิ่ม flag ใหม่: ผ่าน migration/seed (ไม่ hardcode ลงโค้ด)
 */

import { prisma } from "@/lib/prisma";

// =============================================================================
// PLAN ORDERING
// ใช้สำหรับเปรียบเทียบ requiredPlan กับ plan ปัจจุบันของ tenant
// plan ที่อยู่ index สูงกว่าถือว่า "สูงกว่า"
// =============================================================================

const PLAN_ORDER: Record<string, number> = {
  starter: 0,
  growth: 1,
  pro: 2,
  enterprise: 3,
};

/**
 * คืน true ถ้า currentPlan >= requiredPlan (ตาม PLAN_ORDER)
 * ถ้า plan ไม่รู้จัก fallback เป็น false (safe default)
 */
function isPlanSufficient(
  currentPlan: string,
  requiredPlan: string
): boolean {
  const current = PLAN_ORDER[currentPlan.toLowerCase()] ?? -1;
  const required = PLAN_ORDER[requiredPlan.toLowerCase()] ?? 999;
  return current >= required;
}

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * ตรวจว่า tenant มี feature key นี้หรือไม่
 *
 * Logic:
 *   1. ตรวจ TenantFeature (per-tenant override) ก่อน — override ชนะเสมอ
 *   2. ถ้าไม่มี override → ดู FeatureFlag (global default)
 *      a. ถ้า requiredPlan ระบุ → เทียบ plan ของ tenant
 *      b. ถ้าไม่ระบุ requiredPlan → ใช้ defaultEnabled
 *   3. ถ้าไม่มี FeatureFlag record เลย → false (safe default: ปิดไว้ก่อน)
 *
 * @param tenantId  tenant ที่จะตรวจ — ต้องมาจาก TenantContext ไม่ใช่ client
 * @param featureKey  key ของ feature เช่น "sla_policies", "api_access"
 * @param tenantPlan  plan ปัจจุบันของ tenant (จาก TenantContext.plan)
 *                    ถ้าไม่ส่งมา function จะ query DB หา plan เอง (1 query เพิ่ม)
 */
export async function hasFeature(
  tenantId: string,
  featureKey: string,
  tenantPlan?: string
): Promise<boolean> {
  // Query ทั้ง TenantFeature และ FeatureFlag ใน parallel เพื่อลด latency
  const [tenantOverride, globalFlag] = await Promise.all([
    // Layer 1: per-tenant override
    prisma.tenantFeature.findUnique({
      where: {
        // composite unique: tenantId + featureKey
        tenantId_featureKey: { tenantId, featureKey },
      },
      select: { enabled: true },
    }),
    // Layer 2: global flag definition
    prisma.featureFlag.findUnique({
      where: { key: featureKey },
      select: {
        defaultEnabled: true,
        requiredPlan: true,
      },
    }),
  ]);

  // Layer 1: override ราย tenant ชนะเสมอ
  if (tenantOverride !== null) {
    return tenantOverride.enabled;
  }

  // ไม่มี FeatureFlag record เลย → safe default: ปิด
  if (!globalFlag) {
    return false;
  }

  // Layer 2: global default
  if (globalFlag.requiredPlan) {
    // ต้องการ plan ระดับหนึ่ง → เทียบ plan ปัจจุบัน
    const currentPlan =
      tenantPlan ??
      (await resolveTenantPlan(tenantId));
    return isPlanSufficient(currentPlan, globalFlag.requiredPlan);
  }

  // ไม่ gate ตาม plan → ใช้ defaultEnabled
  return globalFlag.defaultEnabled;
}

/**
 * Fallback: query plan ของ tenant จาก DB (เรียกเฉพาะตอนไม่มี tenantPlan ส่งมา)
 * ถ้า query ไม่เจอ tenant → fallback "starter" (ปลอดภัย — จะไม่ได้ feature พิเศษ)
 */
async function resolveTenantPlan(tenantId: string): Promise<string> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { plan: { select: { name: true } } },
  });
  return tenant?.plan.name ?? "starter";
}

// =============================================================================
// FEATURE KEYS (type-safe constants)
// เพิ่ม key ใหม่ที่นี่พร้อม seed migration เสมอ
// =============================================================================

export const FEATURE_KEYS = {
  SLA_POLICIES: "sla_policies",
  CSAT_SURVEY: "csat_survey",
  API_ACCESS: "api_access",
  CUSTOM_BRANDING: "custom_branding",
  MULTIPLE_SLA_POLICIES: "multiple_sla_policies",
  ANALYTICS: "analytics",
} as const;

export type FeatureKey = (typeof FEATURE_KEYS)[keyof typeof FEATURE_KEYS];
