/**
 * attachment-upload.ts — Reusable upload flow ฝั่ง client สำหรับ Phase 25 (File attachments)
 * ใช้ร่วมกันระหว่าง agent (`/api/tickets/:id/attachments/sign`) และ
 * portal (`/api/portal/tickets/:id/attachments/sign`) — รับ signEndpoint เป็น param
 *
 * flow: validate (client-side, UX เร็ว) → sign → PUT ตรงเข้า storage → คืน ref
 * ไม่ใช่ React component — arrow function ใช้ได้ตามกฎ (ห้าม arrow เฉพาะ named component)
 */

import type {
  MessageAttachmentInput,
  SignAttachmentResponse,
} from "@/types/attachment";

// =============================================================================
// LIMITS — sync กับ backend (source of truth คือ backend, นี่แค่ validate ก่อนเพื่อ UX)
// =============================================================================

export const MAX_ATTACHMENT_FILES = 10;
export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

// =============================================================================
// TYPES
// =============================================================================

/** ผลลัพธ์การ upload ไฟล์ 1 ไฟล์ — สำเร็จคืน attachment ref, ล้มเหลวคืน error message */
export interface AttachmentUploadResult {
  fileName: string;
  attachment: MessageAttachmentInput | null;
  errorMessage: string | null;
}

// =============================================================================
// VALIDATION
// =============================================================================

/** ตรวจ mime/size ก่อนยิง sign API — คืน error message ภาษาไทยถ้าไม่ผ่าน หรือ null ถ้าผ่าน */
export function validateAttachmentFile(file: File): string | null {
  if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
    return `ไฟล์ "${file.name}" มีขนาดเกิน 25MB`;
  }
  if (!ALLOWED_ATTACHMENT_MIME_TYPES.includes(file.type)) {
    return `ไฟล์ "${file.name}" เป็นชนิดที่ไม่รองรับ`;
  }
  return null;
}

// =============================================================================
// UPLOAD FLOW
// =============================================================================

/**
 * uploadAttachment — sign → PUT ตรงเข้า storage → คืน ref สำหรับแนบกับ message
 * @param file ไฟล์ที่ผู้ใช้เลือก
 * @param signEndpoint endpoint สำหรับขอ signed upload URL (agent หรือ portal)
 */
export async function uploadAttachment(
  file: File,
  signEndpoint: string
): Promise<AttachmentUploadResult> {
  // ─── client-side validate ก่อน (เกินลิมิต → ไม่ยิง API) ────────────────────
  const validationError = validateAttachmentFile(file);
  if (validationError) {
    return { fileName: file.name, attachment: null, errorMessage: validationError };
  }

  try {
    // ─── ขอ signed upload URL ───────────────────────────────────────────────
    const signRes = await fetch(signEndpoint, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: file.name,
        mimeType: file.type,
        fileSize: file.size,
      }),
    });

    const signJson = (await signRes.json()) as SignAttachmentResponse;

    if (!signRes.ok || signJson.error || !signJson.data) {
      return {
        fileName: file.name,
        attachment: null,
        errorMessage: getSignErrorMessage(signJson.error?.code, file.name),
      };
    }

    const { uploadUrl, token, path } = signJson.data;

    // ─── PUT ไฟล์ตรงเข้า storage (uploadUrl มี token embedded แล้ว) ──────────
    let putRes = await fetch(uploadUrl, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type },
    });

    // ทางสำรอง: ถ้า PUT ไม่ผ่าน ลองใส่ Authorization header + x-upsert
    if (!putRes.ok) {
      putRes = await fetch(uploadUrl, {
        method: "PUT",
        body: file,
        headers: {
          "Content-Type": file.type,
          Authorization: `Bearer ${token}`,
          "x-upsert": "true",
        },
      });
    }

    if (!putRes.ok) {
      return {
        fileName: file.name,
        attachment: null,
        errorMessage: `อัปโหลด "${file.name}" ไม่สำเร็จ กรุณาลองใหม่`,
      };
    }

    return {
      fileName: file.name,
      attachment: {
        path,
        fileName: file.name,
        mimeType: file.type,
        fileSize: file.size,
      },
      errorMessage: null,
    };
  } catch {
    return {
      fileName: file.name,
      attachment: null,
      errorMessage: `ไม่สามารถเชื่อมต่อเพื่ออัปโหลด "${file.name}" ได้`,
    };
  }
}

/** แปลง error code จาก sign API เป็นข้อความภาษาไทย */
function getSignErrorMessage(code: string | undefined, fileName: string): string {
  switch (code) {
    case "UNSUPPORTED_MEDIA_TYPE":
      return `ไฟล์ "${fileName}" เป็นชนิดที่ไม่รองรับ`;
    case "FILE_TOO_LARGE":
      return `ไฟล์ "${fileName}" มีขนาดเกิน 25MB`;
    case "TICKET_MERGED":
      return "ticket นี้ถูกรวมไปแล้ว ไม่สามารถแนบไฟล์ได้";
    default:
      return `เตรียมอัปโหลด "${fileName}" ไม่สำเร็จ`;
  }
}

// =============================================================================
// FORMAT HELPERS
// =============================================================================

/** แปลง bytes เป็น human-readable เช่น "1.2 MB" */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}
