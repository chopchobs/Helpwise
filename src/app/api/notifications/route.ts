/**
 * GET /api/notifications — list notification ของ current member (agent)
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() → ctx.tenantId เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId) ที่ inject tenantId อัตโนมัติ
 *
 * ⚠️ Recipient scope (สองชั้น):
 *   - tenant scope (จาก tenantPrisma) + own-records scope (memberId = current member)
 *   - member เห็นเฉพาะ notification ของตัวเอง — ห้าม leak ของ member อื่น
 *
 * Audience: requireAgent() — agent เท่านั้น (ห้าม contact/portal เข้าถึง)
 */

import { NextResponse } from "next/server";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";

export async function GET(): Promise<NextResponse> {
  try {
    // 1. ตรวจ auth + ดึง tenant context + current member จาก verified session
    const session = await requireAgent();
    const { ctx, member } = session;
    const db = tenantPrisma(ctx.tenantId);

    // 2. Query notification ของ current member เท่านั้น (tenant scope + own-records scope)
    //    memberId มาจาก verified session — ห้ามรับจาก client
    const [notifications, unreadCount] = await Promise.all([
      db.notification.findMany({
        where: { memberId: member.id },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          type: true,
          ticketId: true,
          readAt: true,
          createdAt: true,
        },
      }),
      // unreadCount = readAt null ของ member นี้
      db.notification.count({
        where: { memberId: member.id, readAt: null },
      }),
    ]);

    // 3. แปลง Date → ISO string
    const notificationsDTO = notifications.map((n) => ({
      id: n.id,
      type: n.type,
      ticketId: n.ticketId,
      readAt: n.readAt ? n.readAt.toISOString() : null,
      createdAt: n.createdAt.toISOString(),
    }));

    return NextResponse.json(
      { data: { notifications: notificationsDTO, unreadCount }, error: null },
      { status: 200 }
    );
  } catch (err) {
    console.error(
      "[GET /api/notifications] Unexpected error:",
      err instanceof Error ? err.message : String(err)
    );
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
