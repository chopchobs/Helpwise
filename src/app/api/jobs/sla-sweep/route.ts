/**
 * POST /api/jobs/sla-sweep
 * Cron-sweep สำหรับตรวจ SLA breach — ถูกเรียกจาก external scheduler (เช่น Vercel Cron, Upstash QStash)
 *
 * ⚠️ INTENTIONAL CROSS-TENANT OPERATION:
 *   Route นี้ใช้ base `prisma` (ไม่ใช่ tenantPrisma) เพื่อ scan ทุก tenant ในครั้งเดียว
 *   เป็น system job ที่ออกแบบมาเพื่อทำงานข้าม tenant โดยเฉพาะ
 *   ข้อมูล tenant-specific ไม่ถูก expose ใน response — คืนเฉพาะ counts รวม
 *
 * Security:
 *   - ตรวจ SLA_SWEEP_SECRET ก่อนทำงานใด ๆ (timing-safe, pattern เดียวกับ email inbound)
 *   - production: ไม่มี secret → reject 401
 *   - dev: ไม่มี secret → allow + warn
 *
 * Idempotency:
 *   - breach flag เป็น boolean — ถ้า true แล้วก็ not match `= false` clause → ไม่ถูก update ซ้ำ
 *   - วิ่งสองครั้งบน ticket เดิม → flagged count = 0 ในรอบที่สอง
 *
 * Breach conditions:
 *   First-response breach:
 *     - firstResponseBreached = false
 *     - firstRespondedAt = null (ยังไม่มีคนตอบ)
 *     - firstResponseDueAt < now (เกิน deadline)
 *     - status NOT IN (PENDING, SOLVED, CLOSED)
 *     - slaPausedAt = null (ไม่กำลัง pause อยู่)
 *
 *   Resolution breach:
 *     - resolutionBreached = false
 *     - resolvedAt = null
 *     - resolutionDueAt < now
 *     - status NOT IN (SOLVED, CLOSED)  — หมายเหตุ: PENDING excluded ผ่าน slaPausedAt = null
 *       เพราะเมื่อ status = PENDING → slaPausedAt ถูก set → exclude ด้วย slaPausedAt: null
 *     - slaPausedAt = null (ไม่กำลัง pause อยู่)
 *
 * TODO (defer):
 *   - per-ticket AuditLog สำหรับ breach event (ปัจจุบัน log summary เดียว เพื่อลด write N)
 *   - แจ้งเตือน "ใกล้ถึง deadline" (warning threshold, เช่น 80% ของ SLA time)
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { setRlsBypass } from "@/lib/tenant";
import { TicketStatus } from "@prisma/client";

// =============================================================================
// SECRET VERIFICATION (pattern จาก src/lib/email/inbound.ts)
// =============================================================================

/**
 * เปรียบเทียบ string กับ Buffer ด้วย timingSafeEqual
 * กัน timing attack + length oracle (ใช้ Buffer.alloc pattern จาก inbound.ts)
 */
function timingSafeCompare(input: string, expected: Buffer): boolean {
  try {
    const inputBytes = Buffer.from(input, "utf-8");
    // STRONG: กัน length oracle — ถ้าขนาดต่างต้อง run timingSafeEqual จริง
    // ใช้ Buffer.alloc(expected.length) (zero-filled) บังคับ compare เต็มความยาว
    const safeInput =
      inputBytes.length === expected.length
        ? inputBytes
        : Buffer.alloc(expected.length);
    const equal = crypto.timingSafeEqual(safeInput, expected);
    return equal && inputBytes.length === expected.length;
  } catch {
    return false;
  }
}

/**
 * ตรวจ SLA_SWEEP_SECRET จาก request
 * รองรับ:
 *   1. Authorization: Bearer <secret>
 *   2. X-Sweep-Secret: <secret>
 *
 * Behavior เมื่อ SLA_SWEEP_SECRET ไม่ได้ตั้งค่า:
 *   - production: return false (reject 401)
 *   - development: return true + console.warn
 */
function verifySweepSecret(request: NextRequest): boolean {
  const secret = process.env.SLA_SWEEP_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      console.error(
        "[sla-sweep] SLA_SWEEP_SECRET is not set — rejecting sweep request in production"
      );
      return false;
    }
    // dev: allow แต่ warn
    console.warn(
      "[sla-sweep] SLA_SWEEP_SECRET is not set — allowing in dev mode (NOT SAFE for production)"
    );
    return true;
  }

  const secretBytes = Buffer.from(secret, "utf-8");

  // ลอง Authorization: Bearer <secret>
  const authHeader = request.headers.get("authorization") ?? "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice("bearer ".length).trim();
    if (token.length > 0) {
      return timingSafeCompare(token, secretBytes);
    }
  }

  // ลอง X-Sweep-Secret header
  const sweepHeader = request.headers.get("x-sweep-secret") ?? "";
  if (sweepHeader.length > 0) {
    return timingSafeCompare(sweepHeader, secretBytes);
  }

  // ไม่พบ credential
  return false;
}

// =============================================================================
// SWEEP ROUTE HANDLER
// =============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Verify secret ก่อนทุก operation
  if (!verifySweepSecret(request)) {
    return NextResponse.json(
      { data: null, error: { code: "UNAUTHORIZED", message: "Invalid or missing sweep secret" } },
      { status: 401 }
    );
  }

  const now = new Date();

  try {
    // 2. Flag first-response breaches (idempotent — เงื่อนไข firstResponseBreached: false กัน re-flag)
    //
    // Exclude:
    //   - status PENDING: slaPausedAt = null (PENDING tickets มี slaPausedAt set อยู่ → ถูก exclude โดยอัตโนมัติ)
    //   - status SOLVED/CLOSED: ticket จบแล้ว ไม่ต้อง flag
    //   - slaPausedAt != null: กำลัง pause อยู่ (ไม่ว่า status ไหน)
    //
    // หมายเหตุ: ใช้ prisma โดยตรง (ไม่ใช่ tenantPrisma) — intentional cross-tenant system job
    // ใช้ index บน firstResponseDueAt สำหรับ performance
    //
    // Phase 27 RLS: Ticket ถูก FORCE RLS — job นี้ต้องทำงาน cross-tenant โดยเจตนา
    // จึงเปิด app.rls_bypass แบบ transaction-local (ไม่ใช่ session-level เพราะ
    // runtime ต่อผ่าน pgbouncer transaction-pooling) ครอบทั้ง 2 updateMany ใน tx เดียว
    const { firstResponseResult, resolutionResult } = await prisma.$transaction(
      async (tx) => {
        // system job ทำงาน cross-tenant โดยเจตนา — เปิด rls_bypass แบบ transaction-local เท่านั้น
        await setRlsBypass(tx);

        const firstResponseResult = await tx.ticket.updateMany({
          where: {
            firstResponseBreached: false,
            firstRespondedAt: null,
            firstResponseDueAt: { not: null, lt: now },
            // exclude terminal statuses
            status: {
              notIn: [TicketStatus.PENDING, TicketStatus.SOLVED, TicketStatus.CLOSED],
            },
            // exclude tickets ที่กำลัง pause อยู่ (รวมถึง PENDING ที่ slaPausedAt ถูก set)
            slaPausedAt: null,
          },
          data: {
            firstResponseBreached: true,
          },
        });

        // 3. Flag resolution breaches
        //
        // Exclude:
        //   - status SOLVED/CLOSED: resolve แล้ว
        //   - slaPausedAt != null: กำลัง pause อยู่
        //     (เมื่อ status = PENDING → slaPausedAt ถูก set ที่ PATCH route → ถูก exclude ด้วย slaPausedAt: null)
        //
        // ใช้ index บน resolutionDueAt
        const resolutionResult = await tx.ticket.updateMany({
          where: {
            resolutionBreached: false,
            resolvedAt: null,
            resolutionDueAt: { not: null, lt: now },
            // exclude terminal statuses
            status: {
              notIn: [TicketStatus.SOLVED, TicketStatus.CLOSED],
            },
            // exclude tickets ที่กำลัง pause อยู่
            slaPausedAt: null,
          },
          data: {
            resolutionBreached: true,
          },
        });

        return { firstResponseResult, resolutionResult };
      }
    );

    const firstResponseBreached = firstResponseResult.count;
    const resolutionBreached = resolutionResult.count;

    // 4. Summary — log ลง console เท่านั้น (ไม่เขียน AuditLog)
    //    AuditLog.tenantId เป็น FK → Tenant.id จึงเขียน summary แบบ cross-tenant ไม่ได้
    //    (tenantId ปลอมเช่น "__system__" จะ violate FK แล้ว audit.log soft-fail เงียบ ๆ)
    //    TODO (phase ถัดไป): per-ticket AuditLog ต่อ tenant จริง (action "ticket.sla_breached")
    //    โดย findMany ticket ที่เพิ่ง flag แล้ว group ตาม tenantId — เลี่ยงตอนนี้เพื่อกัน write N records
    console.log(
      `[sla-sweep] scannedAt=${now.toISOString()} firstResponseBreached=${firstResponseBreached} resolutionBreached=${resolutionBreached}`
    );

    return NextResponse.json(
      {
        data: {
          firstResponseBreached,
          resolutionBreached,
          scannedAt: now.toISOString(),
        },
        error: null,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error(
      "[sla-sweep] Unexpected error:",
      err instanceof Error ? err.message : String(err)
    );
    return NextResponse.json(
      { data: null, error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
      { status: 500 }
    );
  }
}
