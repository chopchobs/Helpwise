/**
 * GET /api/reports — Reporting/analytics สำหรับ agent dashboard (Phase 24)
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() → ctx.tenantId เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId) ที่ inject tenantId อัตโนมัติ
 *
 * ⚠️ Feature Gate:
 *   - hasFeature(ANALYTICS) → 403 FEATURE_LOCKED ถ้าปิด (เลียนแบบ csat/summary)
 *
 * ⚠️ Internal note isolation:
 *   - report นี้ aggregate เฉพาะ count/timestamp ของ Ticket/CsatResponse
 *     ไม่ได้แตะ TicketMessage.body เลย — ไม่มีความเสี่ยง internal-note leak
 *
 * Range:
 *   - query params from/to (ISO date) — default last 30 วัน
 *   - clamp สูงสุด 366 วัน → 400 VALIDATION_ERROR ถ้าเกิน
 *   - normalize: from = 00:00:00.000 UTC, to = 23:59:59.999 UTC
 *
 * คำนวณ avg เวลา + trend bucketing:
 *   - เลือกใช้ findMany({select}) แล้วคำนวณใน JS แทน $queryRaw
 *     เหตุผล: tenantPrisma() บล็อก queryRaw/executeRaw โดยตรง (M-1 guard ใน lib/tenant.ts)
 *     และช่วง range ถูก clamp ที่ 366 วัน ทำให้ผลลัพธ์ bounded — ปลอดภัยและง่ายกว่า
 *     การใช้ raw prisma + parameterized SQL แยก client คนละ scope
 *
 * Audience: requireAgent() — ทุก role เห็น report ได้ (agent-only, ไม่ใช่ contact)
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import { TicketPriority } from "@prisma/client";
import type {
  ReportData,
  ReportKpis,
  ReportTrendPoint,
  ReportBreakdownItem,
} from "@/types/report";

const MAX_RANGE_DAYS = 366;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// =============================================================================
// QUERY VALIDATION
// =============================================================================

const querySchema = z.object({
  from: z.string().datetime({ offset: true }).optional().or(z.string().date().optional()),
  to: z.string().datetime({ offset: true }).optional().or(z.string().date().optional()),
});

/**
 * แปลง query params เป็น { from, to } ที่ normalize แล้ว (UTC day boundaries)
 * - default: last 30 วัน
 * - validate from <= to และช่วงไม่เกิน MAX_RANGE_DAYS
 * @throws ValidationError ถ้า input ไม่ valid
 */
class ValidationError extends Error {}

function resolveDateRange(
  fromParam: string | undefined,
  toParam: string | undefined
): { from: Date; to: Date } {
  const now = new Date();

  let from: Date;
  let to: Date;

  if (!fromParam && !toParam) {
    // default: last 30 วัน — to = สิ้นสุดวันนี้, from = 30 วันก่อน เริ่มต้นวัน
    to = endOfUtcDay(now);
    from = startOfUtcDay(new Date(now.getTime() - 30 * MS_PER_DAY));
  } else {
    const parsedFrom = fromParam ? new Date(fromParam) : undefined;
    const parsedTo = toParam ? new Date(toParam) : undefined;

    if (fromParam && (!parsedFrom || isNaN(parsedFrom.getTime()))) {
      throw new ValidationError("รูปแบบวันที่ของ from ไม่ถูกต้อง");
    }
    if (toParam && (!parsedTo || isNaN(parsedTo.getTime()))) {
      throw new ValidationError("รูปแบบวันที่ของ to ไม่ถูกต้อง");
    }

    to = parsedTo ? endOfUtcDay(parsedTo) : endOfUtcDay(now);
    from = parsedFrom
      ? startOfUtcDay(parsedFrom)
      : startOfUtcDay(new Date(to.getTime() - 30 * MS_PER_DAY));
  }

  if (from.getTime() > to.getTime()) {
    throw new ValidationError("from ต้องมาก่อนหรือเท่ากับ to");
  }

  const rangeDays = (to.getTime() - from.getTime()) / MS_PER_DAY;
  if (rangeDays > MAX_RANGE_DAYS) {
    throw new ValidationError(`ช่วงเวลาต้องไม่เกิน ${MAX_RANGE_DAYS} วัน`);
  }

  return { from, to };
}

/** เริ่มต้นวัน 00:00:00.000 UTC */
function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0)
  );
}

/** สิ้นสุดวัน 23:59:59.999 UTC */
function endOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999)
  );
}

/** แปลง Date เป็น "YYYY-MM-DD" (UTC) */
function toUtcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// =============================================================================
// GET /api/reports
// =============================================================================

export async function GET(request: Request): Promise<NextResponse> {
  try {
    // 1. ตรวจ auth — agent-only (ทุก role เห็น report ได้)
    const session = await requireAgent();
    const { ctx } = session;

    // 2. Feature gate — analytics ต้องเปิด (pass ctx.plan กัน extra query)
    const featureEnabled = await hasFeature(ctx.tenantId, FEATURE_KEYS.ANALYTICS, ctx.plan);
    if (!featureEnabled) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "FEATURE_LOCKED",
            message: "Reporting & Analytics ไม่รวมอยู่ใน plan ปัจจุบัน กรุณา upgrade เพื่อใช้งาน",
          },
        },
        { status: 403 }
      );
    }

    // 3. Parse + validate query params (from/to)
    const url = new URL(request.url);
    const parsedQuery = querySchema.safeParse({
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
    });

    if (!parsedQuery.success) {
      return NextResponse.json(
        {
          data: null,
          error: { code: "VALIDATION_ERROR", message: "พารามิเตอร์ from/to ไม่ถูกต้อง" },
        },
        { status: 400 }
      );
    }

    let range: { from: Date; to: Date };
    try {
      range = resolveDateRange(parsedQuery.data.from, parsedQuery.data.to);
    } catch (err) {
      if (err instanceof ValidationError) {
        return NextResponse.json(
          { data: null, error: { code: "VALIDATION_ERROR", message: err.message } },
          { status: 400 }
        );
      }
      throw err;
    }

    const { from, to } = range;
    const db = tenantPrisma(ctx.tenantId);

    // 4. Query parallel — tenantPrisma inject tenantId อัตโนมัติทุก query
    const [
      ticketsCreatedCount,
      ticketsResolvedCount,
      breachedCreatedCount,
      resolvedTicketsForAvg,
      firstRespondedTicketsForAvg,
      priorityGroups,
      channelGroups,
      csatAggregate,
      createdDatesRaw,
      resolvedDatesRaw,
    ] = await Promise.all([
      // 4a. ticketsCreated = count ticket createdAt ∈ [from,to]
      db.ticket.count({
        where: { createdAt: { gte: from, lte: to } },
      }),

      // 4b. ticketsResolved = count ticket resolvedAt ∈ [from,to]
      db.ticket.count({
        where: { resolvedAt: { gte: from, lte: to } },
      }),

      // 4c. นับ ticket created ∈ range ที่ breach (first-response หรือ resolution)
      //     ใช้ count + OR แทนการ findMany ทั้งชุดเข้า memory (bounded, scale ได้บน tenant ใหญ่)
      db.ticket.count({
        where: {
          createdAt: { gte: from, lte: to },
          OR: [{ firstResponseBreached: true }, { resolutionBreached: true }],
        },
      }),

      // 4d. ticket resolvedAt ∈ range — สำหรับ avgResolutionMinutes (คำนวณใน JS)
      db.ticket.findMany({
        where: { resolvedAt: { gte: from, lte: to } },
        select: { createdAt: true, resolvedAt: true },
      }),

      // 4e. ticket firstRespondedAt ∈ range — สำหรับ avgFirstResponseMinutes
      db.ticket.findMany({
        where: { firstRespondedAt: { gte: from, lte: to } },
        select: { createdAt: true, firstRespondedAt: true },
      }),

      // 4f. byPriority — groupBy priority ของ ticket created ∈ range
      db.ticket.groupBy({
        by: ["priority"],
        where: { createdAt: { gte: from, lte: to } },
        _count: { _all: true },
      }),

      // 4g. byChannel — groupBy channel ของ ticket created ∈ range
      db.ticket.groupBy({
        by: ["channel"],
        where: { createdAt: { gte: from, lte: to } },
        _count: { _all: true },
      }),

      // 4h. csatAverage — aggregate rating ของ CsatResponse createdAt ∈ range
      db.csatResponse.aggregate({
        where: { createdAt: { gte: from, lte: to } },
        _avg: { rating: true },
        _count: { id: true },
      }),

      // 4i. createdAt ของ ticket created ∈ range — สำหรับ trend bucketing
      db.ticket.findMany({
        where: { createdAt: { gte: from, lte: to } },
        select: { createdAt: true },
      }),

      // 4j. resolvedAt ของ ticket resolved ∈ range — สำหรับ trend bucketing
      db.ticket.findMany({
        where: { resolvedAt: { gte: from, lte: to } },
        select: { resolvedAt: true },
      }),
    ]);

    // 5. slaBreachRate = (created ∈ range ที่ breach) / (created ∈ range) — 0 ถ้า denom = 0
    //    denominator ใช้ ticketsCreatedCount (4a) ซ้ำได้เพราะ filter ช่วงเดียวกัน
    const slaBreachRate =
      ticketsCreatedCount > 0 ? breachedCreatedCount / ticketsCreatedCount : 0;

    // 6. avgResolutionMinutes — เฉลี่ย (resolvedAt - createdAt) เป็นนาที
    const avgResolutionMinutes = computeAvgMinutes(
      resolvedTicketsForAvg.map((t) => ({
        from: t.createdAt,
        to: t.resolvedAt as Date, // not null เพราะ where filter resolvedAt ∈ range
      }))
    );

    // 7. avgFirstResponseMinutes — เฉลี่ย (firstRespondedAt - createdAt) เป็นนาที
    const avgFirstResponseMinutes = computeAvgMinutes(
      firstRespondedTicketsForAvg.map((t) => ({
        from: t.createdAt,
        to: t.firstRespondedAt as Date,
      }))
    );

    // 8. csatAverage — null ถ้าไม่มี response, round 2 decimals
    const csatCount = csatAggregate._count.id;
    const csatAverage =
      csatCount > 0 && csatAggregate._avg.rating !== null
        ? Math.round(csatAggregate._avg.rating * 100) / 100
        : null;

    // 9. byPriority — เติมให้ครบ 4 enum แม้ count 0
    const allPriorities = Object.values(TicketPriority) as TicketPriority[];
    const priorityCountMap = new Map(
      priorityGroups.map((g) => [g.priority, g._count._all])
    );
    const byPriority: ReportBreakdownItem[] = allPriorities.map((p) => ({
      key: p,
      count: priorityCountMap.get(p) ?? 0,
    }));

    // 10. byChannel — เฉพาะ channel ที่มีจริง
    const byChannel: ReportBreakdownItem[] = channelGroups.map((g) => ({
      key: g.channel,
      count: g._count._all,
    }));

    // 11. trend — bucket รายวัน UTC ตั้งแต่ from ถึง to ครบทุกวัน (เติม 0)
    const trend = buildTrend(from, to, createdDatesRaw, resolvedDatesRaw);

    const kpis: ReportKpis = {
      ticketsCreated: ticketsCreatedCount,
      ticketsResolved: ticketsResolvedCount,
      avgFirstResponseMinutes,
      avgResolutionMinutes,
      slaBreachRate,
      csatAverage,
    };

    const data: ReportData = {
      range: { from: from.toISOString(), to: to.toISOString() },
      kpis,
      trend,
      byPriority,
      byChannel,
    };

    return NextResponse.json({ data, error: null }, { status: 200 });
  } catch (err) {
    console.error(
      "[GET /api/reports] Unexpected error:",
      err instanceof Error ? err.message : String(err)
    );
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * คำนวณค่าเฉลี่ยของ (to - from) เป็นนาที — null ถ้า list ว่าง
 * round 2 decimals
 */
function computeAvgMinutes(pairs: { from: Date; to: Date }[]): number | null {
  if (pairs.length === 0) return null;
  const totalMinutes = pairs.reduce((sum, { from, to }) => {
    return sum + (to.getTime() - from.getTime()) / 60000;
  }, 0);
  return Math.round((totalMinutes / pairs.length) * 100) / 100;
}

/**
 * สร้าง trend array รายวัน (UTC) ตั้งแต่ from ถึง to ครบทุกวัน
 * created/resolved bucket ตามวันที่ createdAt/resolvedAt (UTC)
 */
function buildTrend(
  from: Date,
  to: Date,
  createdRows: { createdAt: Date }[],
  resolvedRows: { resolvedAt: Date | null }[]
): ReportTrendPoint[] {
  // นับจำนวนต่อวัน
  const createdMap = new Map<string, number>();
  for (const row of createdRows) {
    const key = toUtcDateKey(row.createdAt);
    createdMap.set(key, (createdMap.get(key) ?? 0) + 1);
  }

  const resolvedMap = new Map<string, number>();
  for (const row of resolvedRows) {
    if (!row.resolvedAt) continue;
    const key = toUtcDateKey(row.resolvedAt);
    resolvedMap.set(key, (resolvedMap.get(key) ?? 0) + 1);
  }

  // เติมทุกวันใน range ให้ครบ (วันที่ไม่มี = 0)
  const trend: ReportTrendPoint[] = [];
  const cursor = startOfUtcDay(from);
  const lastDay = startOfUtcDay(to);

  while (cursor.getTime() <= lastDay.getTime()) {
    const key = toUtcDateKey(cursor);
    trend.push({
      date: key,
      created: createdMap.get(key) ?? 0,
      resolved: resolvedMap.get(key) ?? 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return trend;
}
