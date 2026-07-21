/**
 * POST /api/realtime/token — mint short-lived JWT ให้ agent เชื่อม Supabase Realtime
 *   (presence/broadcast) แบบ tenant-scoped.
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() → ctx.tenantId เท่านั้น ห้ามรับจาก client body
 *     (การรับ tenantId จาก client = tenant spoofing = critical bug).
 *   - body.ticketId (ถ้ามี) ไม่ถูกใช้กำหนด claim ใด ๆ — claim ผูกจาก server context ล้วน.
 *
 * Audience: requireAgent() — เฉพาะ agent ที่เป็นสมาชิก tenant นี้เท่านั้น
 *   (contact token ผ่านไม่ได้ — requireAgent เช็ค type==="agent" ให้แล้ว).
 */

import { NextResponse } from "next/server";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { mintRealtimePresenceToken } from "@/lib/realtime";

export async function POST() {
  try {
    // audience guard — คืน { user, member, ctx } ที่ verify membership แล้ว
    const { user, member, ctx } = await requireAgent();

    // ⚠️ tenantId มาจาก ctx (server context) เท่านั้น — ไม่แตะ request body
    const { token, expiresAt } = await mintRealtimePresenceToken({
      userId: user.id,
      tenantId: ctx.tenantId,
      memberId: member.id,
    });

    return NextResponse.json({ data: { token, expiresAt } }, { status: 200 });
  } catch (err) {
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
