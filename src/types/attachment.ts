/**
 * attachment.ts — Type definitions ฝั่ง client สำหรับ Attachment domain
 * ใช้ร่วมกันระหว่าง agent UI และ portal UI
 *
 * ⚠️ ห้าม expose storageUrl/path ใน DTO ที่ client บริโภค
 *    (path มี structure tenant/ticket — client เรียก download endpoint ด้วย id แทน)
 */

import type { ApiError } from "@/types/ticket";

// =============================================================================
// ATTACHMENT METADATA DTO (ใน message)
// =============================================================================

/** metadata ของ attachment ที่ client เห็น — ไม่มี storageUrl/path */
export interface AttachmentDTO {
  id: string;
  fileName: string;
  fileSize: number; // bytes
  mimeType: string;
  createdAt: string;
}

// =============================================================================
// SIGN REQUEST / RESPONSE (ออก signed upload URL)
// =============================================================================

/** body ที่ client ส่งมาขอ signed upload URL */
export interface SignAttachmentRequest {
  fileName: string;
  mimeType: string;
  fileSize: number;
}

/** payload ที่ sign endpoint คืน — client ใช้ uploadUrl + token upload ตรงเข้า storage */
export interface SignAttachmentData {
  uploadUrl: string;
  token: string;
  path: string;
  maxBytes: number;
}

/** Response shape: POST /api/tickets/:id/attachments/sign และ portal version */
export interface SignAttachmentResponse {
  data: SignAttachmentData | null;
  error: ApiError | null;
}

// =============================================================================
// MESSAGE ATTACHMENT INPUT (client ส่งมาตอน create message)
// =============================================================================

/** attachment ที่ client แนบมากับ message create (อ้าง path ที่ upload แล้ว) */
export interface MessageAttachmentInput {
  path: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
}

// =============================================================================
// DOWNLOAD RESPONSE (ออก signed download URL)
// =============================================================================

/** Response shape: GET /api/attachments/:id และ portal version */
export interface AttachmentDownloadResponse {
  data: { url: string } | null;
  error: ApiError | null;
}
