/**
 * GET /api/portal/attachments/:id — contact ขอ signed download URL ของ attachment
 *
 * ⚠️ CRITICAL — Internal Note Isolation:
 *   - attachment ที่ผูกกับ message visibility=INTERNAL ห้าม download ฝั่ง portal เด็ดขาด
 *   - ตรวจ parent message.visibility ที่ระดับ backend → 404 ถ้าไม่ใช่ PUBLIC
 *
 * ⚠️ CRITICAL — Own-Records Scope:
 *   - attachment ต้องผูกกับ ticket ที่ requesterContactId === session.contact.id
 *   - ถ้าไม่ตรง → 404 (ห้าม reveal ว่ามีอยู่จริง)
 *
 * ⚠️ Triple Scope Isolation:
 *   1. Tenant scope: tenantPrisma(ctx.tenantId)
 *   2. Own-records scope: ticket.requesterContactId = session.contact.id
 *   3. Visibility scope: message.visibility = PUBLIC
 *   ทุก fail → 404 (ไม่แยก reason เพื่อไม่ leak)
 *
 * Audience: requireContact() — เฉพาะ contact ที่ verified ของ tenant นี้เท่านั้น
 */

import { NextRequest, NextResponse } from "next/server";
import { requireContact, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { createSignedDownloadUrl } from "@/lib/storage";
import { MessageVisibility } from "@prisma/client";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;

    // 1. ตรวจ auth — requireContact แยกขาดจาก requireAgent
    const session = await requireContact();
    const { contact, ctx } = session;
    const db = tenantPrisma(ctx.tenantId);

    // 2. find attachment + parent message.visibility + ticket.requesterContactId
    //    tenantPrisma inject tenantId (layer 1)
    const attachment = await db.attachment.findFirst({
      where: { id },
      select: {
        id: true,
        storageUrl: true,
        message: { select: { visibility: true } },
        ticket: { select: { requesterContactId: true } },
      },
    });

    // ไม่พบ → 404
    if (!attachment) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบไฟล์แนบที่ระบุ" } },
        { status: 404 }
      );
    }

    // CRITICAL — own-records: ต้องเป็น ticket ของ contact นี้ → ไม่ตรง 404 (ห้าม reveal)
    if (attachment.ticket.requesterContactId !== contact.id) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบไฟล์แนบที่ระบุ" } },
        { status: 404 }
      );
    }

    // CRITICAL — internal-note isolation: attachment ของ INTERNAL message ห้ามหลุดฝั่ง portal
    // → 404 (ห้าม reveal ว่ามี internal note/attachment อยู่)
    if (attachment.message.visibility !== MessageVisibility.PUBLIC) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบไฟล์แนบที่ระบุ" } },
        { status: 404 }
      );
    }

    // 3. gen signed download URL (TTL 60s)
    const url = await createSignedDownloadUrl(attachment.storageUrl, 60);

    return NextResponse.json({ data: { url }, error: null }, { status: 200 });
  } catch (err) {
    console.error("[GET /api/portal/attachments/:id] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
