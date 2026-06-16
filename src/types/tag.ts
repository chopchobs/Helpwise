/**
 * tag.ts — Type definitions สำหรับ Tag domain (agent-only)
 *
 * ⚠️ CRITICAL — Tag เป็น agent-internal เท่านั้น:
 *   - ห้าม import หรือใช้ TagDTO ในไฟล์ใด ๆ ที่ portal เห็น
 *   - portal routes ห้าม select/include ticketTags หรือ tag ใด ๆ
 *
 * ใช้ใน: agent UI, tag catalog API, ticket list/detail API (agent)
 */

import type { ApiError } from "@/types/ticket";

// =============================================================================
// TAG COLOR ENUM
// =============================================================================

export type TagColor = "GRAY" | "TERRACOTTA" | "SAGE" | "AMBER" | "SIENNA" | "SAND";

export const TAG_COLORS: TagColor[] = [
  "GRAY",
  "TERRACOTTA",
  "SAGE",
  "AMBER",
  "SIENNA",
  "SAND",
];

// =============================================================================
// TAG DTO
// =============================================================================

export interface TagDTO {
  id: string;
  name: string;
  color: TagColor;
}

// =============================================================================
// RESPONSE SHAPES
// =============================================================================

/** Response shape: GET /api/tags */
export interface TagListResponse {
  data: { tags: TagDTO[] } | null;
  error: ApiError | null;
}

/** Response shape: POST /api/tags, PATCH /api/tags/:id */
export interface TagMutationResponse {
  data: { tag: TagDTO } | null;
  error: ApiError | null;
}

/** Response shape: DELETE /api/tags/:id */
export interface TagDeleteResponse {
  data: { id: string } | null;
  error: ApiError | null;
}

/** Response shape: POST /api/tickets/:id/tags */
export interface TicketTagAddResponse {
  data: { tag: TagDTO } | null;
  error: ApiError | null;
}

/** Response shape: DELETE /api/tickets/:id/tags/:tagId */
export interface TicketTagRemoveResponse {
  data: { tagId: string } | null;
  error: ApiError | null;
}
