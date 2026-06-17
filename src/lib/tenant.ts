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
// RLS KILL-SWITCH (Phase 27)
// =============================================================================

/**
 * RLS_ENABLED env flag — สวิตช์เปิด/ปิดการฉีด GUC + wrap interactive transaction
 *
 * ⚠️ ค่าเริ่มต้น = ปิด (false). การ wrap ทุก query เป็น interactive transaction มี cost
 *    (extra round-trip + ถือ pgbouncer connection นานขึ้น โดยเฉพาะ endpoint แบบ fan-out
 *    ที่ยิงหลาย query ขนานกัน) — จึง gate ไว้หลัง flag เพื่อให้:
 *    1. deploy โค้ดได้โดยไม่กระทบ performance จน Dev พร้อม activate
 *    2. ต้องเปิด flag นี้ "พร้อมกับ" การ apply migration ที่ FORCE RLS (ทั้งคู่ต้องตรงกัน
 *       มิฉะนั้น FORCE+flag-off จะทำ query คืน 0 แถว, หรือ flag-on+ยังไม่ migrate = เปลือง tx เปล่า)
 *    3. เป็น kill-switch rollback ได้ทันทีโดยไม่ต้อง redeploy/rollback migration
 */
export function isRlsEnabled(): boolean {
  return process.env.RLS_ENABLED === "true";
}

/** tx client ที่รัน raw SQL ได้ (โครงสร้างขั้นต่ำ — เลี่ยง import Prisma.TransactionClient) */
interface RawCapableTx {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
}

/**
 * ตั้ง tenant GUC (app.current_tenant_id) แบบ transaction-local ภายใน tx ที่ caller จัดการเอง
 * ใช้ในจุดที่มี prisma.$transaction ตรง ๆ (ไม่ผ่าน tenantPrisma) แต่แตะตาราง FORCE RLS
 * no-op เมื่อ RLS_ENABLED ปิด — กันค่า round-trip ส่วนเกินตอนยังไม่ activate
 */
export async function setTenantGuc(tx: RawCapableTx, tenantId: string): Promise<void> {
  if (!isRlsEnabled()) return;
  await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
}

/**
 * เปิด rls_bypass แบบ transaction-local สำหรับ system job ที่ทำงาน cross-tenant โดยเจตนา
 * (เช่น SLA sweep) — policy ฝั่ง DB อนุญาตเมื่อ current_setting('app.rls_bypass')='on'
 * no-op เมื่อ RLS_ENABLED ปิด
 */
export async function setRlsBypass(tx: RawCapableTx): Promise<void> {
  if (!isRlsEnabled()) return;
  await tx.$executeRaw`SELECT set_config('app.rls_bypass', 'on', true)`;
}

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
          // global model ไม่ถูก FORCE RLS — ไม่ต้องตั้ง GUC, ไม่ต้อง wrap transaction
          if (model && GLOBAL_MODELS.has(model.charAt(0).toLowerCase() + model.slice(1))) {
            return query(args);
          }

          // ใช้ unknown เป็น intermediate cast เพื่อให้ TypeScript ยอม spread args
          // Prisma $allOperations ใช้ generic args ที่ซับซ้อน — pattern นี้เป็น recommended
          // โดย Prisma docs สำหรับ middleware-style extension
          const mutableArgs = args as unknown as Record<string, unknown>;

          // Phase 27 RLS: dispatch operation ภายใน interactive transaction ที่ตั้ง
          // tenant GUC (app.current_tenant_id) แบบ transaction-local ก่อนเสมอ
          // เหตุผลที่ต้อง wrap tx: runtime ต่อผ่าน pgbouncer transaction-pooling —
          // session-level `SET` ไม่ติดเพราะ connection ถูกคืน pool ทันทีหลัง statement
          // ต้องใช้ set_config(..., true) (is_local=true) ภายใน "transaction เดียวกัน"
          // กับ query จริง เพื่อให้ RLS policy ฝั่ง DB อ่านค่า GUC นี้เห็น
          //
          // ใช้ `prisma` (base client, un-extended) ใน $transaction — เพราะถ้าใช้ client
          // ที่ extend แล้ว เรียก tx[model][operation] จะวน recursive เข้า extension นี้อีก
          // (infinite loop) — ต้อง dispatch ผ่าน base delegate เท่านั้น
          const runScoped = async (): Promise<unknown> => {
            // RLS kill-switch: เมื่อปิด → พฤติกรรมเดิม (ไม่ wrap tx, ไม่ตั้ง GUC)
            // app-layer tenantId injection ด้านบนยังทำงานครบ — กัน cross-tenant เหมือนเดิม
            if (!isRlsEnabled()) {
              return query(args);
            }
            return prisma.$transaction(async (tx) => {
              // ตั้ง tenant GUC แบบ transaction-local (pgbouncer-safe)
              // RLS policy ฝั่ง DB อ่านค่านี้เพื่อ filter cross-tenant access เป็น defense-in-depth
              await tx.$executeRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;

              const lowerModelName =
                (model as string).charAt(0).toLowerCase() + (model as string).slice(1);
              // tx เป็น base PrismaClient transaction client (ไม่มี extension) — ไม่ recursive
              const delegate = (
                tx as unknown as Record<
                  string,
                  Record<string, (a: unknown) => Promise<unknown>>
                >
              )[lowerModelName];
              return delegate[operation as string](args);
            });
          };

          // M-1: ปิดกั้น raw SQL ที่อาจไม่มี tenant scope — แปลง silent bypass เป็น error
          // ต้องอยู่ก่อน branch อื่น ๆ เพื่อให้ TypeScript ยังเห็น operation เป็น full union
          // ผู้เรียกต้องใช้ raw prisma พร้อม tenant scope ที่ชัดเจนเอง
          const rawOperation = operation as string;
          if (
            rawOperation === "queryRaw" ||
            rawOperation === "executeRaw" ||
            rawOperation === "queryRawUnsafe" ||
            rawOperation === "executeRawUnsafe" ||
            rawOperation === "queryRawTyped"
          ) {
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
            return runScoped();
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
            return runScoped();
          }

          if (operation === "create") {
            // inject tenantId เข้า data — กัน create โดยไม่มี tenant scope
            const existingData =
              mutableArgs["data"] as Record<string, unknown> | undefined;
            mutableArgs["data"] = { ...existingData, tenantId };
            return runScoped();
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
            return runScoped();
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
            return runScoped();
          }

          // operation อื่น ๆ ที่ไม่ได้ handle — เผื่อ Prisma เพิ่ม op ใหม่ในอนาคต
          // ยัง wrap tx + ตั้ง GUC เพื่อ fail-safe (ดีกว่า bypass RLS เงียบ ๆ) แต่ log เตือน
          // เพราะ tenantId ไม่ถูก inject เข้า args — อาศัย RLS เป็น backstop ชั้นเดียว
          console.warn(
            `[tenantPrisma] unhandled operation "${rawOperation}" on model "${model}" — tenantId ไม่ถูก inject, อาศัย RLS เป็น backstop`
          );
          return runScoped();
        },
      },
    },
  });
}

// Type export สำหรับ route handler ที่ต้องการ type ของ tenantPrisma
export type TenantScopedPrisma = ReturnType<typeof tenantPrisma>;
