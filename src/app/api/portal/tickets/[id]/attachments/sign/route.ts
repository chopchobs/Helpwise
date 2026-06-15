/**
 * POST /api/portal/tickets/:id/attachments/sign — contact ขอ signed upload URL
 *
 * ⚠️ CRITICAL — Own-Records Scope:
 *   - verify ticket.requesterContactId === session.contact.id
 *   - ถ้าไม่ตรง → 404 (ห้าม reveal ว่า ticket มีอยู่จริง)
 *
 * ⚠️ Double Scope Isolation:
 *   1. Tenant scope: tenantPrisma(ctx.tenantId)
 *   2. Own-records scope: requesterContactId = session.contact.id
 *
 * Flow เหมือน agent version แต่ใช้ requireContact() + own-records check
 *
 * Audience: requireContact() — เฉพาะ contact ที่ verified ของ tenant นี้เท่านั้น
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireContact, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import {
  buildAttachmentPath,
  createSignedUploadUrl,
  isAllowedMimeType,
  MAX_FILE_BYTES,
} from "@/lib/storage";

const signSchema = z.object({
  fileName: z.string().min(1, "fileName ห้ามว่าง").max(255, "fileName ยาวเกินไป"),
  mimeType: z.string().min(1, "mimeType ห้ามว่าง"),
  fileSize: z.number().int().positive("fileSize ต้องมากกว่า 0"),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id: ticketId } = await params;

    // 1. ตรวจ auth — requireContact แยกขาดจาก requireAgent
    const session = await requireContact();
    const { contact, ctx } = session;
    const db = tenantPrisma(ctx.tenantId);

    // 2. Parse + validate body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { data: null, error: { code: "INVALID_JSON", message: "Request body ต้องเป็น JSON" } },
        { status: 400 }
      );
    }

    const parsed = signSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          data: null,
          error: { code: "VALIDATION_ERROR", message: parsed.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง" },
        },
        { status: 400 }
      );
    }

    const { fileName, mimeType, fileSize } = parsed.data;

    // 3. OWN-RECORDS SCOPE: ดึง ticket + verify ownership
    //    tenantPrisma inject tenantId (layer 1) + requesterContactId filter (layer 2)
    const ticket = await db.ticket.findFirst({
      where: {
        id: ticketId,
        requesterContactId: contact.id, // OWN-RECORDS SCOPE
      },
      select: { id: true, mergedIntoId: true },
    });

    // ถ้าไม่พบ/ไม่ใช่ของ contact นี้ → 404 เสมอ (ห้าม reveal)
    if (!ticket) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ ticket ที่ระบุ" } },
        { status: 404 }
      );
    }

    // ticket ที่ถูก merge แล้ว = read-only
    if (ticket.mergedIntoId !== null) {
      return NextResponse.json(
        { data: null, error: { code: "TICKET_MERGED", message: "ticket นี้ถูกรวมไปแล้ว ไม่สามารถแนบไฟล์ได้" } },
        { status: 409 }
      );
    }

    // 4. validate mime + size (pre-check; re-verify authoritative ตอน create message)
    if (!isAllowedMimeType(mimeType)) {
      return NextResponse.json(
        { data: null, error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "ชนิดไฟล์ไม่รองรับ" } },
        { status: 400 }
      );
    }
    if (fileSize > MAX_FILE_BYTES) {
      return NextResponse.json(
        { data: null, error: { code: "FILE_TOO_LARGE", message: "ไฟล์มีขนาดใหญ่เกินกำหนด" } },
        { status: 400 }
      );
    }

    // 5. สร้าง object path + signed upload URL
    const { path } = buildAttachmentPath(ctx.tenantId, ticketId, fileName);
    const { uploadUrl, token } = await createSignedUploadUrl(path);

    return NextResponse.json(
      { data: { uploadUrl, token, path, maxBytes: MAX_FILE_BYTES }, error: null },
      { status: 200 }
    );
  } catch (err) {
    console.error("[POST /api/portal/tickets/:id/attachments/sign] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
