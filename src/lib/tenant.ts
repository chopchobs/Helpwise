/**
 * src/lib/tenant.ts
 * หัวใจของ Tenant Isolation — ห้ามแก้โดยไม่เข้าใจ security implication
 *
 * สองส่วนหลัก:
 * 1. getTenantContext() — อ่าน tenant context จาก request headers ที่ middleware verify แล้ว
 * 2. tenantPrisma()    — Prisma Client Extension ที่ inject tenantId อัตโนมัติทุก operation
 *
 * ⚠️ CRITICAL: ทุก query ที่เกี่ยวกับข้อมูล tenant ต้องใช้ tenantPrisma() ไม่ใช่ prisma โดยตรง
 *              ห้ามรับ tenantId จาก client — ดึงจาก context ที่ middleware verify แล้วเท่านั้น
 */

import { headers } from "next/headers";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// =============================================================================
// TYPES
// =============================================================================

export interface TenantContext {
  /** ID ของ tenant ที่ middleware verify และ inject ผ่าน x-tenant-id header แล้ว */
  tenantId: string;
  /** ชื่อ plan ปัจจุบัน ที่ middleware อ่านจาก Redis cache และ inject ผ่าน x-tenant-plan */
  plan: string;
}

// =============================================================================
// GLOBAL MODELS (ไม่ inject tenantId)
// เหล่านี้คือ model ที่เป็น global ไม่ผูกกับ tenant ใด — User, Plan, FeatureFlag
// ถ้า inject tenantId เข้าไปจะทำให้ query หา User/Plan/FeatureFlag ไม่เจอ (where clause ผิด)
// =============================================================================

const GLOBAL_MODELS = new Set(["user", "plan", "featureFlag"]);

// =============================================================================
// TENANT CONTEXT RESOLUTION
// =============================================================================

/**
 * อ่าน TenantContext จาก request headers ที่ middleware เขียนทับไว้แล้ว
 * ต้องเรียกใน Server Component / Route Handler เท่านั้น (ใช้ next/headers)
 *
 * ⚠️ header เหล่านี้ middleware เขียนทับค่าจาก client เสมอ — เชื่อถือได้
 *    ห้ามอ่าน tenantId จาก request body, query string, หรือ path param
 *
 * @throws Error ถ้าไม่มี tenant headers (route ที่ไม่ต้อง tenant อย่าเรียก)
 */
export async function getTenantContext(): Promise<TenantContext> {
  const headerStore = await headers();
  const tenantId = headerStore.get("x-tenant-id");
  const plan = headerStore.get("x-tenant-plan");

  if (!tenantId) {
    throw new Error(
      "ไม่พบ x-tenant-id header — route นี้ต้องอยู่ใต้ subdomain ของ tenant"
    );
  }

  return {
    tenantId,
    plan: plan ?? "starter",
  };
}

// =============================================================================
// TENANT-SCOPED PRISMA CLIENT
// =============================================================================

/**
 * สร้าง Prisma Client Extension ที่ inject tenantId อัตโนมัติทุก operation
 *
 * กลไก: ใช้ $extends + $allModels.$allOperations query callback เพื่อ intercept
 * ทุก Prisma call และแทรก tenantId เข้าไปใน where/data โดยอัตโนมัติ
 *
 * Operation ที่รองรับ:
 * - findUnique/findFirst/findMany/findUniqueOrThrow/findFirstOrThrow → inject where.tenantId
 * - update/updateMany/delete/deleteMany/count/aggregate/groupBy → inject where.tenantId
 * - create → inject data.tenantId
 * - createMany → inject tenantId ใน args.data ทุก record
 * - upsert → inject where.tenantId + create.tenantId + update ไม่ inject (ไม่ควร update tenantId)
 *
 * ⚠️ ยกเว้น GLOBAL_MODELS: User, Plan, FeatureFlag
 *    เพราะ model เหล่านี้ไม่มีคอลัมน์ tenantId ใน schema
 *
 * @param tenantId ต้องมาจาก getTenantContext() หรือ middleware context เท่านั้น
 *                 ห้ามส่ง tenantId ที่มาจาก client โดยตรง
 */
export function tenantPrisma(tenantId: string) {
  return prisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          // ยกเว้น global models — ไม่มี tenantId ใน schema
          // User, Plan, FeatureFlag เป็น global — ถ้า inject tenantId จะ query ไม่เจอ
          if (model && GLOBAL_MODELS.has(model.charAt(0).toLowerCase() + model.slice(1))) {
            return query(args);
          }

          // ใช้ unknown เป็น intermediate cast เพื่อให้ TypeScript ยอม spread args
          // Prisma $allOperations ใช้ generic args ที่ซับซ้อน — pattern นี้เป็น recommended
          // โดย Prisma docs สำหรับ middleware-style extension
          const mutableArgs = args as unknown as Record<string, unknown>;

          // M-1: ปิดกั้น raw SQL ที่อาจไม่มี tenant scope — แปลง silent bypass เป็น error
          // ต้องอยู่ก่อน branch อื่น ๆ เพื่อให้ TypeScript ยังเห็น operation เป็น full union
          // ผู้เรียกต้องใช้ raw prisma พร้อม tenant scope ที่ชัดเจนเอง
          const rawOperation = operation as string;
          if (rawOperation === "queryRaw" || rawOperation === "executeRaw") {
            throw new Error(
              `[tenantPrisma] Raw SQL via tenantPrisma is not allowed — use raw prisma with explicit tenant scope. Operation: ${rawOperation}`
            );
          }

          // แยก operation แต่ละประเภทเพื่อ inject tenantId ให้ถูกจุด
          if (
            operation === "findUnique" ||
            operation === "findFirst" ||
            operation === "findMany" ||
            operation === "findUniqueOrThrow" ||
            operation === "findFirstOrThrow" ||
            operation === "count" ||
            operation === "aggregate" ||
            operation === "groupBy" ||
            operation === "delete" ||
            operation === "deleteMany"
          ) {
            // inject tenantId เข้า where — กัน cross-tenant read/write/delete
            const existingWhere =
              mutableArgs["where"] as Record<string, unknown> | undefined;
            mutableArgs["where"] = { ...existingWhere, tenantId };
            return query(args);
          }

          // B-1: update/updateMany — inject where.tenantId และ strip tenantId ออกจาก data
          // กัน caller ส่ง data: { tenantId: '<other>' } เพื่อย้าย record ข้าม tenant
          if (operation === "update" || operation === "updateMany") {
            const existingWhere =
              mutableArgs["where"] as Record<string, unknown> | undefined;
            mutableArgs["where"] = { ...existingWhere, tenantId };

            const existingData =
              mutableArgs["data"] as Record<string, unknown> | undefined;
            if (existingData) {
              const { tenantId: _stripped, ...safeData } = existingData;
              mutableArgs["data"] = safeData;
            }
            return query(args);
          }

          if (operation === "create") {
            // inject tenantId เข้า data — กัน create โดยไม่มี tenant scope
            const existingData =
              mutableArgs["data"] as Record<string, unknown> | undefined;
            mutableArgs["data"] = { ...existingData, tenantId };
            return query(args);
          }

          if (operation === "createMany") {
            // inject tenantId ทุก record ใน data array
            const data = mutableArgs["data"];
            if (Array.isArray(data)) {
              mutableArgs["data"] = (data as Record<string, unknown>[]).map(
                (record) => ({ ...record, tenantId })
              );
            } else if (data && typeof data === "object") {
              mutableArgs["data"] = {
                ...(data as Record<string, unknown>),
                tenantId,
              };
            }
            return query(args);
          }

          if (operation === "upsert") {
            // inject tenantId เข้า where + create; strip tenantId ออกจาก update payload
            // B-1: กัน update block เขียน tenantId ใหม่ข้าม tenant
            const existingWhere =
              mutableArgs["where"] as Record<string, unknown> | undefined;
            const existingCreate =
              mutableArgs["create"] as Record<string, unknown> | undefined;
            mutableArgs["where"] = { ...existingWhere, tenantId };
            mutableArgs["create"] = { ...existingCreate, tenantId };

            const existingUpdate =
              mutableArgs["update"] as Record<string, unknown> | undefined;
            if (existingUpdate) {
              const { tenantId: _stripped, ...safeUpdate } = existingUpdate;
              mutableArgs["update"] = safeUpdate;
            }
            return query(args);
          }

          // operation อื่น ๆ ที่ไม่ได้ handle — ผ่านตรงโดยไม่ inject
          return query(args);
        },
      },
    },
  });
}

// Type export สำหรับ route handler ที่ต้องการ type ของ tenantPrisma
export type TenantScopedPrisma = ReturnType<typeof tenantPrisma>;
