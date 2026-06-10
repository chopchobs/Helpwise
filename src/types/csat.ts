/**
 * csat.ts — Type definitions สำหรับ CSAT Survey domain
 *
 * ใช้ร่วมกันระหว่าง portal, agent UI, และ summary endpoint
 *
 * CsatResponseDTO   — shape ของ response ที่ทั้ง portal และ agent เห็น
 * PortalCsatState   — state ที่ portal widget ใช้ตัดสินใจว่าจะแสดงอะไร
 * CsatSummary       — aggregate metrics สำหรับ agent dashboard
 * CsatSubmitBody    — request body ของ POST portal/tickets/:id/csat
 */

// =============================================================================
// CONSTANTS (shared backend Zod + frontend input — กัน drift)
// =============================================================================

/** ความยาวสูงสุดของ comment — ใช้ทั้ง Zod ฝั่ง backend และ maxLength ของ textarea */
export const CSAT_COMMENT_MAX_LENGTH = 1000;

// =============================================================================
// CSAT RESPONSE DTO (shared: portal + agent)
// =============================================================================

/**
 * ข้อมูล CSAT response ที่ return กลับ — createdAt เป็น ISO string
 * ทั้ง portal (ยืนยันการส่ง) และ agent (อ่านคะแนน) ใช้ shape เดียวกัน
 */
export interface CsatResponseDTO {
  rating: number;
  comment: string | null;
  createdAt: string; // ISO string
}

// =============================================================================
// PORTAL CSAT STATE
// =============================================================================

/**
 * State ที่ portal widget อ่านจาก GET /api/portal/tickets/:id
 * - eligible: true = ticket ถูก SOLVED/CLOSED และยังไม่มี response (แสดง form ได้)
 * - response: ข้อมูล response ที่ส่งไปแล้ว (null = ยังไม่เคยส่ง)
 */
export interface PortalCsatState {
  eligible: boolean;
  response: CsatResponseDTO | null;
}

// =============================================================================
// REQUEST BODY: POST /api/portal/tickets/:id/csat
// =============================================================================

/**
 * Body สำหรับ submit CSAT จาก portal
 * - rating: 1–5 (Int, validate ด้วย Zod ที่ backend)
 * - comment: optional free-text (อาจมี PII — ไม่ log ใน audit snapshot)
 */
export interface CsatSubmitBody {
  rating: number;
  comment?: string | null;
}

// =============================================================================
// CSAT SUMMARY (agent aggregate view)
// =============================================================================

/**
 * Aggregate metrics สำหรับ GET /api/csat/summary (agent-only)
 *
 * - averageRating: ค่าเฉลี่ย rating (null ถ้ายังไม่มี response เลย)
 * - responseCount: จำนวน CsatResponse ของ tenant นี้
 * - eligibleCount: จำนวน ticket ที่ status = SOLVED | CLOSED (denominator)
 * - responseRate: responseCount / eligibleCount (0 ถ้า eligibleCount = 0)
 * - ratingDistribution: count ต่อ rating 1–5 (return ครบ 5 bucket เสมอ แม้ count = 0)
 */
export interface CsatSummary {
  averageRating: number | null;
  responseCount: number;
  eligibleCount: number;
  responseRate: number; // fraction 0..1
  ratingDistribution: { rating: number; count: number }[]; // ratings 1..5
}

// =============================================================================
// API RESPONSE SHAPES
// =============================================================================

import type { ApiError } from "@/types/ticket";

/** Response shape: POST /api/portal/tickets/:id/csat */
export interface PortalCsatSubmitResponse {
  data: CsatResponseDTO | null;
  error: ApiError | null;
}

/** Response shape: GET /api/csat/summary */
export interface CsatSummaryResponse {
  data: CsatSummary | null;
  error: ApiError | null;
}
