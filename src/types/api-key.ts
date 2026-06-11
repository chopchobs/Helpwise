/**
 * api-key.ts — Type definitions สำหรับ API Key management (agent-side)
 * shared ระหว่าง backend route และ frontend
 */

import type { ApiError } from "@/types/ticket";

export interface ApiKeyDTO {
  id: string;
  name: string;
  /** เช่น "hw_live_AbC1" — โชว์ได้ ไม่ sensitive */
  keyPrefix: string;
  lastUsedAt: string | null;
  createdAt: string;
  /** null = active, มีค่า = ถูก revoke แล้ว */
  revokedAt: string | null;
}

/** Response shape: GET /api/api-keys */
export interface ApiKeyListResponse {
  data: { apiKeys: ApiKeyDTO[] } | null;
  error: ApiError | null;
}

/** Response shape: POST /api/api-keys — plaintextKey เห็นได้ครั้งเดียว */
export interface ApiKeyCreateResponse {
  data: { apiKey: ApiKeyDTO; plaintextKey: string } | null;
  error: ApiError | null;
}

/** Response shape: DELETE /api/api-keys/:id */
export interface ApiKeyRevokeResponse {
  data: { id: string } | null;
  error: ApiError | null;
}
