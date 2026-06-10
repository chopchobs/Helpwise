/**
 * GET /api/csat/summary — aggregate CSAT metrics ของ tenant
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId)
 *
 * ⚠️ Feature Gate:
 *   - ตรวจ hasFeature(CSAT_SURVEY) → 403 FEATURE_LOCKED ถ้าปิด
 *
 * ⚠️ Efficiency:
 *   - ใช้ aggregate/groupBy แทนการ load rows ทั้งหมด (ไม่ N+1)
 *   - responseCount, sum(rating), eligibleCount run parallel
 *
 * Audience: requireAgent() — ทุก role เห็น metrics ได้ (agent-only, ไม่ใช่ contact)
 */

import { NextResponse } from "next/server";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import { TicketStatus } from "@prisma/client";
import type { CsatSummary } from "@/types/csat";

// สถานะที่ถือว่า ticket eligible สำหรับ CSAT (denominator)
const RESOLVED_STATUSES: TicketStatus[] = [TicketStatus.SOLVED, TicketStatus.CLOSED];

// =============================================================================
// GET /api/csat/summary — aggregate CSAT metrics
// =============================================================================

export async function GET(): Promise<NextResponse> {
  try {
    // 1. ตรวจ auth — agent-only (ทุก role เห็น metrics ได้)
    const session = await requireAgent();
    const { ctx } = session;

    // 2. Feature gate — csat_survey ต้องเปิด (pass ctx.plan กัน extra query)
    const featureEnabled = await hasFeature(ctx.tenantId, FEATURE_KEYS.CSAT_SURVEY, ctx.plan);
    if (!featureEnabled) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "FEATURE_LOCKED",
            message: "CSAT Survey ไม่รวมอยู่ใน plan ปัจจุบัน กรุณา upgrade เพื่อใช้งาน",
          },
        },
        { status: 403 }
      );
    }

    const db = tenantPrisma(ctx.tenantId);

    // 3. Query parallel — tenantPrisma inject tenantId อัตโนมัติทุก query
    //
    //    a) aggregate: count + sum(rating) ของ CsatResponse
    //    b) groupBy rating: นับ distribution 1–5
    //    c) count ticket ที่ eligible (SOLVED | CLOSED) = denominator
    //
    //    ใช้ aggregate/groupBy แทนการ load rows เพื่อประสิทธิภาพ (ไม่ N+1)
    const [aggregateResult, ratingGroups, eligibleCount] = await Promise.all([
      // aggregate: count + sum(rating) ในครั้งเดียว
      db.csatResponse.aggregate({
        _count: { id: true },
        _sum: { rating: true },
      }),

      // groupBy rating 1–5: จำนวน response แต่ละ rating
      db.csatResponse.groupBy({
        by: ["rating"],
        _count: { id: true },
        orderBy: { rating: "asc" },
      }),

      // นับ ticket ที่ eligible — tenant-scoped ผ่าน tenantPrisma
      db.ticket.count({
        where: {
          status: { in: RESOLVED_STATUSES },
        },
      }),
    ]);

    const responseCount = aggregateResult._count.id;
    const ratingSum = aggregateResult._sum.rating ?? 0;

    // คำนวณ averageRating — null ถ้า 0 responses (ไม่ return NaN)
    // round to 2 decimals
    const averageRating =
      responseCount > 0
        ? Math.round((ratingSum / responseCount) * 100) / 100
        : null;

    // คำนวณ responseRate — 0 ถ้า eligibleCount = 0 (หาร 0 ไม่ได้)
    const responseRate =
      eligibleCount > 0 ? responseCount / eligibleCount : 0;

    // สร้าง ratingDistribution — return ครบ 5 bucket (rating 1–5) แม้ count = 0
    // กัน frontend ต้อง handle undefined key
    const groupMap = new Map<number, number>();
    for (const group of ratingGroups) {
      groupMap.set(group.rating, group._count.id);
    }

    const ratingDistribution = [1, 2, 3, 4, 5].map((r) => ({
      rating: r,
      count: groupMap.get(r) ?? 0,
    }));

    const summary: CsatSummary = {
      averageRating,
      responseCount,
      eligibleCount,
      responseRate,
      ratingDistribution,
    };

    return NextResponse.json({ data: summary, error: null }, { status: 200 });
  } catch (err) {
    console.error(
      "[GET /api/csat/summary] Unexpected error:",
      err instanceof Error ? err.message : String(err)
    );
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
