/**
 * GET /api/attachments/:id — agent ขอ signed download URL ของ attachment
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() เท่านั้น
 *   - find ผ่าน tenantPrisma(ctx.tenantId) → กัน cross-tenant download
 *   - agent เห็น attachment ของ INTERNAL message ได้ (ไม่กรอง visibility)
 *
 * คืน signed download URL TTL สั้น (60s) — bucket private, ห้าม return path ตรง ๆ
 *
 * Audience: requireAgent() — เฉพาะ agent ของ tenant นี้เท่านั้น
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { createSignedDownloadUrl } from "@/lib/storage";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;

    // 1. ตรวจ auth
    const session = await requireAgent();
    const { ctx } = session;
    const db = tenantPrisma(ctx.tenantId);

    // 2. find attachment — tenantPrisma inject tenantId กัน cross-tenant
    const attachment = await db.attachment.findFirst({
      where: { id },
      select: { id: true, storageUrl: true },
    });

    if (!attachment) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบไฟล์แนบที่ระบุ" } },
        { status: 404 }
      );
    }

    // 3. gen signed download URL (TTL 60s) — bucket private
    const url = await createSignedDownloadUrl(attachment.storageUrl, 60);

    return NextResponse.json({ data: { url }, error: null }, { status: 200 });
  } catch (err) {
    console.error("[GET /api/attachments/:id] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
