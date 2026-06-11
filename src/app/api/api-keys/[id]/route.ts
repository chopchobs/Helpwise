/**
 * DELETE /api/api-keys/:id — revoke (soft) API key
 *
 * ⚠️ Tenant Isolation: tenantPrisma scope ทำให้ key ของ tenant อื่น → 404
 * Feature gate: api_access — ปิด → 403 FEATURE_LOCKED
 */

import { NextResponse } from "next/server";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import { audit } from "@/lib/audit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function DELETE(
  _request: Request,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const session = await requireAgent({ roles: ["OWNER", "ADMIN"] });
    const { ctx, member } = session;
    const { id } = await params;

    const enabled = await hasFeature(ctx.tenantId, FEATURE_KEYS.API_ACCESS, ctx.plan);
    if (!enabled) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "FEATURE_LOCKED",
            message: "API access ไม่รวมอยู่ใน plan ปัจจุบัน กรุณาอัปเกรด plan",
          },
        },
        { status: 403 }
      );
    }

    const db = tenantPrisma(ctx.tenantId);

    // ตรวจว่า key เป็นของ tenant นี้และยัง active — tenantPrisma scope กัน cross-tenant
    const existing = await db.apiKey.findFirst({
      where: { id, revokedAt: null },
      select: { id: true },
    });

    if (!existing) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ API key หรือถูก revoke ไปแล้ว" } },
        { status: 404 }
      );
    }

    const revokedAt = new Date();
    await db.apiKey.update({
      where: { id },
      data: { revokedAt },
    });

    void audit.log({
      tenantId: ctx.tenantId,
      actor: { type: "member", memberId: member.id },
      targetType: "api_key",
      targetId: id,
      action: "api_key.revoked",
      before: { revokedAt: null },
      after: { revokedAt: revokedAt.toISOString() },
    });

    return NextResponse.json({ data: { id }, error: null }, { status: 200 });
  } catch (err) {
    console.error("[DELETE /api/api-keys/:id] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
