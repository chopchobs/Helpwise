/**
 * POST /api/jobs/sla-sweep
 * SLA sweep worker — ถูกเรียกจาก Upstash QStash schedule (ยิงเป็นรอบ ๆ)
 *
 * ⚠️ Worker route รันนอก middleware → ไม่มี tenant context จาก subdomain
 *    tenantId มาจาก prisma.tenant.findMany (verified source ฝั่ง server) เท่านั้น
 *    แล้ว loop ราย tenant → tenantPrisma(tenant.id) ทุก query — ห้ามดึง ticket ข้าม tenant
 *    มาปนในรอบเดียว (จุด leak หลักของ slice นี้)
 *
 * Security:
 *   - verify QStash signature ก่อนทำงานใด ๆ (fail-closed บน production)
 *
 * สิ่งที่ทำต่อ tenant:
 *   1. BREACH (core — ไม่ gate ตาม plan):
 *      - first-response / resolution breach → atomic claim flag → AuditLog + Notification (ถ้ามี assignee)
 *   2. NEAR-BREACH (gate ด้วย hasFeature('sla_policies')):
 *      - เหลือ ≤ 20% ของ SLA window → atomic claim flag → Notification (ไม่ audit, ลด write-N)
 *
 * Idempotency:
 *   - claim แบบ atomic ผ่าน conditional updateMany (flag false→true ครั้งเดียว) —
 *     วนซ้ำ/QStash retry → count===0 → ไม่ notify/audit ซ้ำ
 *
 * Breach conditions:
 *   First-response: firstResponseBreached=false, firstRespondedAt=null,
 *     firstResponseDueAt < now, status NOT IN (PENDING,SOLVED,CLOSED), slaPausedAt=null
 *   Resolution: resolutionBreached=false, resolvedAt=null,
 *     resolutionDueAt < now, status NOT IN (SOLVED,CLOSED), slaPausedAt=null
 *
 * Response: คืนเฉพาะ aggregate counts — ห้าม leak tenant-specific data (ticket id ฯลฯ)
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { tenantPrisma } from "@/lib/tenant";
import {
  verifyQStashSignature,
  getJobTargetUrl,
  SLA_SWEEP_WORKER_PATH,
} from "@/lib/queue";
import { recordInboundAttempt } from "@/lib/inbound-counter";
import { createNotification } from "@/lib/notifications";
import { audit } from "@/lib/audit";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import {
  parseBusinessHours,
  resolveSlaMinutes,
  businessMinutesBetween,
  type SlaPolicyFields,
} from "@/lib/sla";
import { TicketStatus, NotificationType } from "@prisma/client";

// select ของ SlaPolicy ที่ engine ต้องการ (8 field ตาม SlaPolicyFields)
const SLA_POLICY_SELECT = {
  firstResponseLowMin: true,
  firstResponseNormMin: true,
  firstResponseHighMin: true,
  firstResponseUrgMin: true,
  resolutionLowMin: true,
  resolutionNormMin: true,
  resolutionHighMin: true,
  resolutionUrgMin: true,
} as const;

// near-breach threshold — แจ้งเตือนเมื่อเวลาทำการที่เหลือ ≤ 20% ของ window
const NEAR_BREACH_RATIO = 0.2;

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Verify QStash signature ก่อนทุก operation (fail-closed prod)
  //    sla-sweep ไม่ใช้ body payload แต่ต้อง verify เพื่อ consume + ตรวจ signature
  //    pin target URL ของ sla-sweep (sign-side/verify-side ต้องตรงกัน)
  const { valid, attemptClass } = await verifyQStashSignature(
    request,
    getJobTargetUrl(SLA_SWEEP_WORKER_PATH)
  );
  // Phase 39 ลำดับ 3: นับทุก attempt ตามคลาสที่ verify จำแนกจาก header เอง
  await recordInboundAttempt(attemptClass);
  if (!valid) {
    return NextResponse.json(
      { data: null, error: { code: "UNAUTHORIZED", message: "Invalid or missing QStash signature" } },
      { status: 401 }
    );
  }

  const now = new Date();
  const counters = {
    firstResponseBreached: 0,
    resolutionBreached: 0,
    firstResponseNearBreach: 0,
    resolutionNearBreach: 0,
  };

  try {
    // 2. ดึงรายชื่อ tenant (Tenant ไม่ใช่ FORCE-RLS table → อ่านผ่าน base prisma ได้)
    //    ทุก query ของ ticket/notification/audit หลังจากนี้ scope ราย tenant เท่านั้น
    const tenants = await prisma.tenant.findMany({
      select: { id: true, plan: { select: { name: true } }, settings: true },
    });

    for (const tenant of tenants) {
      // tenant-scoped client — ห้ามดึง ticket ข้าม tenant มาปนในรอบเดียว
      const db = tenantPrisma(tenant.id);
      const bh = parseBusinessHours(tenant.settings);
      const planName = tenant.plan?.name;

      // ---------------------------------------------------------------------
      // BREACH (core — ไม่ gate)
      // ---------------------------------------------------------------------

      // first-response breach candidates
      const frBreach = await db.ticket.findMany({
        where: {
          firstResponseBreached: false,
          firstRespondedAt: null,
          firstResponseDueAt: { not: null, lt: now },
          status: { notIn: [TicketStatus.PENDING, TicketStatus.SOLVED, TicketStatus.CLOSED] },
          slaPausedAt: null,
        },
        select: { id: true, assigneeId: true },
      });

      for (const t of frBreach) {
        // atomic claim — flag false→true ครั้งเดียว (กัน double-notify เมื่อ sweep ซ้อน)
        const claim = await db.ticket.updateMany({
          where: { id: t.id, firstResponseBreached: false },
          data: { firstResponseBreached: true },
        });
        if (claim.count !== 1) continue;
        counters.firstResponseBreached++;
        await audit.log({
          tenantId: tenant.id,
          actor: { type: "system" },
          targetType: "ticket",
          targetId: t.id,
          action: "ticket.sla_breached",
          ticketId: t.id,
          after: { firstResponseBreached: true },
        });
        // ไม่มี assignee = ไม่มีผู้รับ → flag + audit แต่ไม่ notify
        if (t.assigneeId) {
          await createNotification(db, {
            memberId: t.assigneeId,
            type: NotificationType.SLA_BREACH,
            ticketId: t.id,
          });
        }
      }

      // resolution breach candidates
      const resBreach = await db.ticket.findMany({
        where: {
          resolutionBreached: false,
          resolvedAt: null,
          resolutionDueAt: { not: null, lt: now },
          status: { notIn: [TicketStatus.SOLVED, TicketStatus.CLOSED] },
          slaPausedAt: null,
        },
        select: { id: true, assigneeId: true },
      });

      for (const t of resBreach) {
        const claim = await db.ticket.updateMany({
          where: { id: t.id, resolutionBreached: false },
          data: { resolutionBreached: true },
        });
        if (claim.count !== 1) continue;
        counters.resolutionBreached++;
        await audit.log({
          tenantId: tenant.id,
          actor: { type: "system" },
          targetType: "ticket",
          targetId: t.id,
          action: "ticket.sla_breached",
          ticketId: t.id,
          after: { resolutionBreached: true },
        });
        if (t.assigneeId) {
          await createNotification(db, {
            memberId: t.assigneeId,
            type: NotificationType.SLA_BREACH,
            ticketId: t.id,
          });
        }
      }

      // ---------------------------------------------------------------------
      // NEAR-BREACH (gate ด้วย hasFeature — ไม่ hardcode plan)
      // ---------------------------------------------------------------------
      const nearBreachEnabled = await hasFeature(
        tenant.id,
        FEATURE_KEYS.SLA_POLICIES,
        planName
      );
      if (!nearBreachEnabled) continue; // ข้าม near-breach ทั้ง tenant นี้ (breach ทำไปแล้ว)

      // first-response near-breach candidates: ยังไม่ตอบ, ยังไม่ breach, dueAt > now, ยังไม่ notified
      const frNear = await db.ticket.findMany({
        where: {
          firstResponseNearBreachNotified: false,
          firstResponseBreached: false,
          firstRespondedAt: null,
          firstResponseDueAt: { not: null, gt: now },
          status: { notIn: [TicketStatus.PENDING, TicketStatus.SOLVED, TicketStatus.CLOSED] },
          slaPausedAt: null,
        },
        select: {
          id: true,
          priority: true,
          assigneeId: true,
          firstResponseDueAt: true,
          slaPolicy: { select: SLA_POLICY_SELECT },
        },
      });

      for (const t of frNear) {
        if (!t.firstResponseDueAt) continue;
        const windowMin = resolveSlaMinutes(
          t.slaPolicy as SlaPolicyFields | null,
          t.priority
        ).firstResponseMin;
        // business-hours-aware: เวลาทำการที่เหลือถึง deadline (dueAt เก็บค่าที่ shift pause แล้ว)
        const remaining = businessMinutesBetween(now, t.firstResponseDueAt, bh);
        if (remaining > NEAR_BREACH_RATIO * windowMin) continue; // ยังไม่ใกล้ครบ

        const claim = await db.ticket.updateMany({
          where: { id: t.id, firstResponseNearBreachNotified: false },
          data: { firstResponseNearBreachNotified: true },
        });
        if (claim.count !== 1) continue;
        counters.firstResponseNearBreach++;
        if (t.assigneeId) {
          await createNotification(db, {
            memberId: t.assigneeId,
            type: NotificationType.SLA_NEAR_BREACH,
            ticketId: t.id,
          });
        }
      }

      // resolution near-breach candidates
      const resNear = await db.ticket.findMany({
        where: {
          resolutionNearBreachNotified: false,
          resolutionBreached: false,
          resolvedAt: null,
          resolutionDueAt: { not: null, gt: now },
          status: { notIn: [TicketStatus.SOLVED, TicketStatus.CLOSED] },
          slaPausedAt: null,
        },
        select: {
          id: true,
          priority: true,
          assigneeId: true,
          resolutionDueAt: true,
          slaPolicy: { select: SLA_POLICY_SELECT },
        },
      });

      for (const t of resNear) {
        if (!t.resolutionDueAt) continue;
        const windowMin = resolveSlaMinutes(
          t.slaPolicy as SlaPolicyFields | null,
          t.priority
        ).resolutionMin;
        const remaining = businessMinutesBetween(now, t.resolutionDueAt, bh);
        if (remaining > NEAR_BREACH_RATIO * windowMin) continue;

        const claim = await db.ticket.updateMany({
          where: { id: t.id, resolutionNearBreachNotified: false },
          data: { resolutionNearBreachNotified: true },
        });
        if (claim.count !== 1) continue;
        counters.resolutionNearBreach++;
        if (t.assigneeId) {
          await createNotification(db, {
            memberId: t.assigneeId,
            type: NotificationType.SLA_NEAR_BREACH,
            ticketId: t.id,
          });
        }
      }
    }

    return NextResponse.json(
      { data: { ...counters, scannedAt: now.toISOString() }, error: null },
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
