/**
 * billing.ts — Type definitions สำหรับ Billing API (GET /api/billing)
 * ใช้ฝั่ง agent เท่านั้น (admin-only: OWNER/ADMIN)
 *
 * ⚠️ SECURITY: ไม่มี stripe* id ใด ๆ ใน shape เหล่านี้
 *   stripeCustomerId, stripeSubscriptionId, stripePriceId = sensitive + ไม่จำเป็นต่อ UI
 */

import type { ApiError } from "@/types/ticket";

// =============================================================================
// SUBSCRIPTION STATUS
// =============================================================================

export type BillingSubscriptionStatus =
  | "TRIALING"
  | "ACTIVE"
  | "PAST_DUE"
  | "CANCELLED"
  | "UNPAID";

// =============================================================================
// SUBSCRIPTION SHAPE (sanitized — ไม่มี stripe* id)
// =============================================================================

export interface BillingSubscription {
  status: BillingSubscriptionStatus;
  /** planName ที่ sync มาจาก Stripe metadata (อาจ null ก่อน webhook ครั้งแรก) */
  planName: string | null;
  /** ราคาปัจจุบัน — Int (satang/cents) ให้ frontend format เอง */
  currentPriceAmount: number;
  /** currency รหัสสาม ตัว เช่น "thb", "usd" */
  currency: string;
  /** วันสิ้นสุด period ปัจจุบัน (ISO 8601) หรือ null ถ้ายังไม่มี billing period */
  currentPeriodEnd: string | null;
  /** true = จะยกเลิกเมื่อสิ้น period นี้ */
  cancelAtPeriodEnd: boolean;
  /** วันหมด trial (ISO 8601) หรือ null */
  trialEndAt: string | null;
}

// =============================================================================
// PLAN SHAPE (sanitized — ส่งแค่ boolean ว่ามี priceId ไหม ไม่ส่ง priceId เอง)
// =============================================================================

export interface BillingPlan {
  /** name ที่ใช้เป็น identifier เช่น "starter", "pro" */
  name: string;
  /** ชื่อแสดงผล เช่น "Starter", "Pro" */
  displayName: string;
  /** ราคารายเดือน — Int (satang/cents) */
  pricePerMonth: number;
  /** ราคารายปี — Int (satang/cents) */
  pricePerYear: number;
  /** จำนวน agent สูงสุด (0 = unlimited) */
  maxAgents: number;
  /** จำนวน SLA policy สูงสุด (0 = unlimited) */
  maxSlaPolicies: number;
  /** รายการ feature keys ที่ plan นี้รวมไว้ */
  features: string[];
  /** มี Stripe Price สำหรับ monthly ไหม (ถ้า false = ไม่สามารถ checkout monthly ได้) */
  hasMonthlyPrice: boolean;
  /** มี Stripe Price สำหรับ yearly ไหม */
  hasYearlyPrice: boolean;
}

// =============================================================================
// ENTITLEMENTS (คำนวณ server-side เพื่อให้ frontend ไม่ต้อง re-implement logic)
// =============================================================================

export interface BillingEntitlements {
  /** tenant มี feature sla_policies หรือไม่ (ผ่าน hasFeature()) */
  slaPoliciesEnabled: boolean;
}

// =============================================================================
// RESPONSE SHAPE
// =============================================================================

/**
 * Data payload ของ GET /api/billing
 */
export interface BillingData {
  /**
   * subscription ปัจจุบันของ tenant
   * null = tenant ยังไม่เคยเข้า checkout / ไม่มี Subscription row
   */
  subscription: BillingSubscription | null;
  /** planName จาก Tenant.plan.displayName (plan ที่ผูกกับ tenant ใน DB ปัจจุบัน) */
  currentPlanName: string;
  /** รายการ plan ที่ active ทั้งหมด (ใช้แสดง pricing table / upgrade UI) */
  plans: BillingPlan[];
  /** entitlements ที่คำนวณแล้ว — ใช้ drive UI enable/disable ได้ทันที */
  entitlements: BillingEntitlements;
}

/** Response shape: GET /api/billing */
export interface BillingResponse {
  data: BillingData | null;
  error: ApiError | null;
}
