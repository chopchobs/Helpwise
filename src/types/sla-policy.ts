/**
 * sla-policy.ts — Type definitions สำหรับ SLA Policy API
 * ใช้ฝั่ง agent เท่านั้น (admin-only: OWNER/ADMIN)
 *
 * endpoint:
 *   GET    /api/sla-policies
 *   POST   /api/sla-policies
 *   GET    /api/sla-policies/:id
 *   PATCH  /api/sla-policies/:id
 *   DELETE /api/sla-policies/:id
 */

import type { ApiError } from "@/types/ticket";

// =============================================================================
// SLA POLICY DTO (response shape — ปลอดภัยส่งออก client)
// =============================================================================

export interface SlaPolicyDTO {
  id: string;
  name: string;
  /** true = policy นี้เป็น default ของ tenant (มีได้แค่ 1 ตัวต่อ tenant) */
  isDefault: boolean;
  // First-response time ตาม priority (นาที, คิดตาม business hours)
  firstResponseLowMin: number;
  firstResponseNormMin: number;
  firstResponseHighMin: number;
  firstResponseUrgMin: number;
  // Resolution time ตาม priority (นาที, คิดตาม business hours)
  resolutionLowMin: number;
  resolutionNormMin: number;
  resolutionHighMin: number;
  resolutionUrgMin: number;
  /** จำนวน ticket ที่ผูกกับ policy นี้อยู่ (optional — มาจาก _count) */
  ticketCount?: number;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

// =============================================================================
// REQUEST BODY TYPES
// =============================================================================

/**
 * Body สำหรับ POST /api/sla-policies (create)
 * Zod schema validate ที่ route handler
 */
export interface CreateSlaPolicyBody {
  name: string;
  isDefault?: boolean;
  firstResponseLowMin: number;
  firstResponseNormMin: number;
  firstResponseHighMin: number;
  firstResponseUrgMin: number;
  resolutionLowMin: number;
  resolutionNormMin: number;
  resolutionHighMin: number;
  resolutionUrgMin: number;
}

/**
 * Body สำหรับ PATCH /api/sla-policies/:id (partial update)
 * ทุก field เป็น optional — ส่งเฉพาะที่ต้องการเปลี่ยน
 */
export interface UpdateSlaPolicyBody {
  name?: string;
  isDefault?: boolean;
  firstResponseLowMin?: number;
  firstResponseNormMin?: number;
  firstResponseHighMin?: number;
  firstResponseUrgMin?: number;
  resolutionLowMin?: number;
  resolutionNormMin?: number;
  resolutionHighMin?: number;
  resolutionUrgMin?: number;
}

// =============================================================================
// RESPONSE SHAPES
// =============================================================================

/** Data payload ของ GET /api/sla-policies */
export interface SlaPolicyListData {
  policies: SlaPolicyDTO[];
  /**
   * true = tenant สามารถสร้าง policy เพิ่มได้
   * (ยังไม่ถึง maxSlaPolicies และมี MULTIPLE_SLA_POLICIES feature ถ้า count >= 1)
   */
  canCreateMore: boolean;
  /** จำนวน policy สูงสุดที่ plan นี้อนุญาต (0 = unlimited) */
  maxPolicies: number;
}

/** Response shape: GET /api/sla-policies */
export interface SlaPolicyListResponse {
  data: SlaPolicyListData | null;
  error: ApiError | string | null;
}

/** Response shape: GET/POST/PATCH /api/sla-policies/:id */
export interface SlaPolicyResponse {
  data: SlaPolicyDTO | null;
  error: ApiError | string | null;
}

/** Response shape: DELETE /api/sla-policies/:id */
export interface SlaPolicyDeleteResponse {
  data: { deleted: true } | null;
  error: ApiError | string | null;
}
