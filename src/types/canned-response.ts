/**
 * canned-response.ts — Type definitions ฝั่ง client สำหรับ Canned Response API
 * ใช้ร่วมกันระหว่าง agent UI และ API routes
 */

import type { ApiError } from "@/types/ticket";

export interface CannedResponseDTO {
  id: string;
  title: string;
  body: string;
  createdAt: string; // ISO
}

export interface CannedResponseListResponse {
  data: { cannedResponses: CannedResponseDTO[] } | null;
  error: ApiError | null;
}

export interface CannedResponseMutationResponse {
  data: { cannedResponse: CannedResponseDTO } | null;
  error: ApiError | null;
}

export interface CannedResponseDeleteResponse {
  data: { id: string } | null;
  error: ApiError | null;
}
