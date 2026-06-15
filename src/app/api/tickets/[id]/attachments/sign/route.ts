/**
 * POST /api/tickets/:id/attachments/sign — agent ขอ signed upload URL สำหรับแนบไฟล์
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId)
 *   - object path มี prefix {tenantId}/{ticketId}/ — ใช้ verify ownership ตอน create message
 *
 * Flow:
 *   requireAgent → load ticket (tenant-scoped) → 404 ถ้าไม่พบ → 409 ถ้า merged
 *   → validate mime/size → buildAttachmentPath → createSignedUploadUrl
 *
 * Note: endpoint นี้ไม่สร้าง Attachment row — แค่ออก URL ให้ client upload
 *       Attachment row จะถูกสร้างตอน POST message (verify ไฟล์มีจริงก่อน)
 *
 * Audience: requireAgent() — เฉพาะ agent ของ tenant นี้เท่านั้น
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
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

    // 1. ตรวจ auth
    const session = await requireAgent();
    const { ctx } = session;
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

    // 3. โหลด ticket — tenantPrisma inject tenantId กัน cross-tenant
    const ticket = await db.ticket.findFirst({
      where: { id: ticketId },
      select: { id: true, mergedIntoId: true },
    });

    if (!ticket) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ ticket ที่ระบุ" } },
        { status: 404 }
      );
    }

    // ticket ที่ถูก merge แล้ว = read-only — แนบไฟล์ใหม่ไม่ได้
    if (ticket.mergedIntoId !== null) {
      return NextResponse.json(
        { data: null, error: { code: "TICKET_MERGED", message: "ticket นี้ถูกรวมไปแล้ว ไม่สามารถแนบไฟล์ได้" } },
        { status: 409 }
      );
    }

    // 4. validate mime + size (pre-check; re-verify ด้วยค่า authoritative ตอน create message)
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

    // 5. สร้าง object path (prefix tenant/ticket) + signed upload URL
    const { path } = buildAttachmentPath(ctx.tenantId, ticketId, fileName);
    const { uploadUrl, token } = await createSignedUploadUrl(path);

    return NextResponse.json(
      { data: { uploadUrl, token, path, maxBytes: MAX_FILE_BYTES }, error: null },
      { status: 200 }
    );
  } catch (err) {
    console.error("[POST /api/tickets/:id/attachments/sign] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
