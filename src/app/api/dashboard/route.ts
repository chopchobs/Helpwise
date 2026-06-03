/**
 * GET /api/dashboard — สถิติ + รายการ ticket ของ tenant (agent view)
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() → ctx.tenantId เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId) ที่ inject tenantId อัตโนมัติ
 *   - ไม่ include messages ใน list — กัน internal-note leak โดยไม่จำเป็น
 *
 * Audience: requireAgent() — เฉพาะ agent ที่เป็นสมาชิก tenant นี้เท่านั้น
 */

import { NextResponse } from "next/server";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { Prisma, TicketStatus } from "@prisma/client";

// =============================================================================
// TYPES
// =============================================================================

/** shape ของ select ที่ใช้กับทุก list query — ตรงกับ AgentTicketSummary */
const TICKET_SELECT = {
  id: true,
  ticketNumber: true,
  subject: true,
  status: true,
  priority: true,
  createdAt: true,
  updatedAt: true,
  requesterContact: {
    select: {
      id: true,
      name: true,
      email: true,
      avatarUrl: true,
    },
  },
  assignee: {
    select: {
      id: true,
      role: true,
      user: {
        select: {
          id: true,
          name: true,
          avatarUrl: true,
        },
      },
    },
  },
  // ไม่ include messages หรือ _count — ไม่จำเป็นสำหรับ dashboard
  // และหลีกเลี่ยงความเสี่ยง internal-note leak ผ่าน messages array
} as const;

/** status ที่ถือว่า "active" (ยังต้อง action) — ไม่รวม SOLVED และ CLOSED */
const ACTIVE_STATUSES: TicketStatus[] = [
  TicketStatus.NEW,
  TicketStatus.OPEN,
  TicketStatus.PENDING,
  TicketStatus.ON_HOLD,
];

/**
 * shape จริงที่ Prisma คืนจาก TICKET_SELECT (createdAt/updatedAt เป็น Date)
 * client บริโภคผ่าน type AgentTicketSummary (date เป็น string หลัง JSON serialize)
 */
type TicketRow = Prisma.TicketGetPayload<{ select: typeof TICKET_SELECT }>;

interface DashboardData {
  statusCounts: Record<TicketStatus, number>;
  myAssignedCount: number;
  myAssigned: TicketRow[];
  unassignedCount: number;
  unassigned: TicketRow[];
  recent: TicketRow[];
}

// =============================================================================
// GET /api/dashboard
// =============================================================================

export async function GET(): Promise<NextResponse> {
  try {
    // 1. ตรวจ auth — ต้องเป็น agent ที่ active ของ tenant นี้
    const session = await requireAgent();
    const { member, ctx } = session;

    // 2. สร้าง tenant-scoped DB client — tenantId inject อัตโนมัติทุก query
    const db = tenantPrisma(ctx.tenantId);

    // 3. รัน query ทั้งหมดพร้อมกัน (parallel) เพื่อลด latency
    //    query แต่ละชุดไม่มี dependency ต่อกัน
    const [
      statusGroupBy,
      myAssignedCount,
      myAssigned,
      unassignedCount,
      unassigned,
      recent,
    ] = await Promise.all([
      // 3a. statusCounts — groupBy status นับทุก status ของ tenant
      db.ticket.groupBy({
        by: ["status"],
        _count: { _all: true },
      }),

      // 3b. myAssignedCount — นับ ticket ที่ assign ให้ member นี้ (active status เท่านั้น)
      db.ticket.count({
        where: {
          assigneeId: member.id,
          status: { in: ACTIVE_STATUSES },
        },
      }),

      // 3c. myAssigned — รายการ ticket ล่าสุดที่ assign ให้ member นี้ (active, take 8)
      db.ticket.findMany({
        where: {
          assigneeId: member.id,
          status: { in: ACTIVE_STATUSES },
        },
        orderBy: { updatedAt: "desc" },
        take: 8,
        select: TICKET_SELECT,
      }),

      // 3d. unassignedCount — นับ ticket ที่ยังไม่มีคนรับ (active status เท่านั้น)
      db.ticket.count({
        where: {
          assigneeId: null,
          status: { in: ACTIVE_STATUSES },
        },
      }),

      // 3e. unassigned — รายการ ticket ที่ยังไม่มีคนรับล่าสุด (active, take 8)
      db.ticket.findMany({
        where: {
          assigneeId: null,
          status: { in: ACTIVE_STATUSES },
        },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: TICKET_SELECT,
      }),

      // 3f. recent — ticket ล่าสุดทุก status (take 8) สำหรับ activity feed
      db.ticket.findMany({
        orderBy: { createdAt: "desc" },
        take: 8,
        select: TICKET_SELECT,
      }),
    ]);

    // 4. แปลง groupBy result เป็น object ที่มีครบทุก 6 status (default 0 ถ้าไม่มีใน result)
    //    เพื่อให้ frontend ใช้ตรงได้โดยไม่ต้อง check undefined
    const allStatuses = Object.values(TicketStatus) as TicketStatus[];
    const statusCountMap = new Map(
      statusGroupBy.map((row) => [row.status, row._count._all])
    );
    const statusCounts = Object.fromEntries(
      allStatuses.map((s) => [s, statusCountMap.get(s) ?? 0])
    ) as Record<TicketStatus, number>;

    const data: DashboardData = {
      statusCounts,
      myAssignedCount,
      myAssigned,
      unassignedCount,
      unassigned,
      recent,
    };

    return NextResponse.json({ data, error: null }, { status: 200 });
  } catch (err) {
    console.error(
      "[GET /api/dashboard] Unexpected error:",
      err instanceof Error ? err.message : String(err)
    );
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
