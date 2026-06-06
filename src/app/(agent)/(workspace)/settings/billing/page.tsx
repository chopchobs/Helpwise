"use client";

/**
 * หน้า Billing Settings (agent — OWNER/ADMIN เท่านั้น)
 * แสดง subscription ปัจจุบัน + plan cards + ปุ่ม upgrade/manage
 * ถ้า role อื่นได้รับ 403 จาก API → แสดง state "เฉพาะ OWNER/ADMIN"
 */

import { useState, useEffect, useCallback, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import {
  CreditCard,
  RefreshCw,
  Check,
  AlertTriangle,
  ExternalLink,
  ShieldAlert,
} from "lucide-react";
import FormAlert from "@/components/ui/FormAlert";
import { formatMoney } from "@/lib/ticket-ui";
import type {
  BillingData,
  BillingResponse,
  BillingSubscriptionStatus,
  BillingPlan,
} from "@/types/billing";

// =============================================================================
// TYPES
// =============================================================================

type BillingInterval = "monthly" | "yearly";

interface CheckoutResponse {
  data: { url: string } | null;
  error: { code: string; message: string } | null;
}

interface PortalResponse {
  data: { url: string } | null;
  error: { code: string; message: string } | null;
}

// =============================================================================
// HELPERS — status badge
// =============================================================================

interface SubscriptionStatusStyle {
  label: string;
  bg: string;
  text: string;
  border: string;
}

/**
 * getSubscriptionStatusStyle — map BillingSubscriptionStatus → semantic class
 * ACTIVE→success, TRIALING→primary tint, PAST_DUE/UNPAID→warning, CANCELLED→muted/danger
 */
function getSubscriptionStatusStyle(status: BillingSubscriptionStatus): SubscriptionStatusStyle {
  const map: Record<BillingSubscriptionStatus, SubscriptionStatusStyle> = {
    ACTIVE: {
      label:  "ใช้งานอยู่",
      bg:     "bg-success-tint",
      text:   "text-success",
      border: "border-success-tint",
    },
    TRIALING: {
      label:  "ทดลองใช้",
      bg:     "bg-primary-tint",
      text:   "text-primary-ink",
      border: "border-primary-tint",
    },
    PAST_DUE: {
      label:  "ค้างชำระ",
      bg:     "bg-warning-tint",
      text:   "text-warning-ink",
      border: "border-warning-tint",
    },
    UNPAID: {
      label:  "ยังไม่ชำระ",
      bg:     "bg-warning-tint",
      text:   "text-warning-ink",
      border: "border-warning-tint",
    },
    CANCELLED: {
      label:  "ยกเลิกแล้ว",
      bg:     "bg-stone",
      text:   "text-muted",
      border: "border-border",
    },
  };
  return map[status];
}

/**
 * formatPeriodDate — format ISO date เป็น string ไทยสำหรับแสดง period
 */
function formatPeriodDate(iso: string): string {
  return new Date(iso).toLocaleString("th-TH", {
    day:   "numeric",
    month: "short",
    year:  "numeric",
  });
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

interface SubscriptionCardProps {
  billing: BillingData;
  onManagePortal: () => void;
  isManaging: boolean;
}

/** SubscriptionCard — แสดง subscription ปัจจุบัน + ปุ่ม manage */
function SubscriptionCard({ billing, onManagePortal, isManaging }: SubscriptionCardProps) {
  const { subscription, currentPlanName } = billing;

  // ยังไม่มี subscription
  if (!subscription) {
    return (
      <div className="bg-surface rounded-xl border border-border p-6 shadow-sm mb-6">
        <div className="flex items-center gap-2 mb-2">
          <CreditCard size={18} className="text-muted" aria-hidden="true" />
          <h2 className="text-base font-semibold text-foreground">Subscription ปัจจุบัน</h2>
        </div>
        <p className="text-sm text-secondary">
          ยังไม่มี subscription — เลือก plan ด้านล่างเพื่อเริ่มต้น
        </p>
      </div>
    );
  }

  const statusStyle = getSubscriptionStatusStyle(subscription.status);
  const isCancelling = subscription.cancelAtPeriodEnd;
  const isTrialing = subscription.status === "TRIALING";

  return (
    <div className="bg-surface rounded-xl border border-border p-6 shadow-sm mb-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        {/* ซ้าย: ข้อมูล plan */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 mb-1">
            <CreditCard size={18} className="text-primary" aria-hidden="true" />
            <h2 className="text-base font-semibold text-foreground">Subscription ปัจจุบัน</h2>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xl font-bold text-foreground capitalize">
              {currentPlanName}
            </span>
            {/* status badge */}
            <span
              className={[
                "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border",
                statusStyle.bg, statusStyle.text, statusStyle.border,
              ].join(" ")}
            >
              {statusStyle.label}
            </span>
          </div>

          {/* ราคาปัจจุบัน */}
          {subscription.currentPriceAmount > 0 && (
            <p className="text-sm text-secondary">
              {formatMoney(subscription.currentPriceAmount, subscription.currency)} / รอบ
            </p>
          )}

          {/* วันต่ออายุ/หมดอายุ */}
          {subscription.currentPeriodEnd && (
            <p className="text-sm text-secondary">
              {isCancelling ? "หมดอายุ" : "ต่ออายุ"}:{" "}
              <span className="text-foreground font-medium">
                {formatPeriodDate(subscription.currentPeriodEnd)}
              </span>
            </p>
          )}

          {/* ทดลองใช้ — แสดงวันหมด trial */}
          {isTrialing && subscription.trialEndAt && (
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary-tint border border-primary-tint mt-1">
              <span className="text-xs text-primary-ink font-medium">
                ทดลองถึง {formatPeriodDate(subscription.trialEndAt)}
              </span>
            </div>
          )}

          {/* คำเตือน cancel at period end */}
          {isCancelling && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-warning-tint border border-warning-tint mt-1">
              <AlertTriangle size={14} className="text-warning-ink shrink-0 mt-0.5" aria-hidden="true" />
              <span className="text-xs text-warning-ink font-medium">
                จะยกเลิกเมื่อสิ้นรอบบิลปัจจุบัน — ยังใช้งานได้ถึงวันที่แสดงด้านบน
              </span>
            </div>
          )}
        </div>

        {/* ขวา: ปุ่ม manage */}
        <button
          type="button"
          onClick={onManagePortal}
          disabled={isManaging}
          className={[
            "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold border transition-colors",
            "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
            "disabled:opacity-60 disabled:cursor-not-allowed",
            "border-border text-foreground hover:bg-stone bg-surface",
          ].join(" ")}
        >
          {isManaging ? (
            <RefreshCw size={14} className="animate-spin" aria-hidden="true" />
          ) : (
            <ExternalLink size={14} aria-hidden="true" />
          )}
          {isManaging ? "กำลังโหลด..." : "จัดการการเรียกเก็บเงิน"}
        </button>
      </div>
    </div>
  );
}

// =============================================================================

interface PlanCardProps {
  plan: BillingPlan;
  isCurrentPlan: boolean;
  interval: BillingInterval;
  onSelect: (planName: string, interval: BillingInterval) => void;
  isSelecting: boolean;
  selectingPlanName: string | null;
}

/** PlanCard — แสดงข้อมูล plan 1 ใบพร้อมปุ่ม upgrade */
function PlanCard({
  plan,
  isCurrentPlan,
  interval,
  onSelect,
  isSelecting,
  selectingPlanName,
}: PlanCardProps) {
  const price = interval === "monthly" ? plan.pricePerMonth : plan.pricePerYear;
  const hasPrice = interval === "monthly" ? plan.hasMonthlyPrice : plan.hasYearlyPrice;
  const isThisCardSelecting = isSelecting && selectingPlanName === plan.name;

  return (
    <div
      className={[
        "bg-surface rounded-xl border p-5 flex flex-col gap-4 transition-colors",
        isCurrentPlan ? "border-primary ring-1 ring-primary" : "border-border",
      ].join(" ")}
    >
      {/* Plan name + badge ปัจจุบัน */}
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-bold text-foreground">{plan.displayName}</h3>
        {isCurrentPlan && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-primary-tint text-primary-ink border border-primary-tint shrink-0">
            แพ็กเกจปัจจุบัน
          </span>
        )}
      </div>

      {/* ราคา */}
      <div>
        {price > 0 ? (
          <p className="text-2xl font-bold text-foreground">
            {formatMoney(price, "thb")}
            <span className="text-sm font-normal text-secondary ml-1">
              / {interval === "monthly" ? "เดือน" : "ปี"}
            </span>
          </p>
        ) : (
          <p className="text-2xl font-bold text-foreground">ฟรี</p>
        )}
        {!hasPrice && (
          <p className="text-xs text-muted mt-1">ยังไม่เปิดให้สมัคร ({interval === "monthly" ? "รายเดือน" : "รายปี"})</p>
        )}
      </div>

      {/* entitlements */}
      <ul className="flex flex-col gap-1.5" aria-label={`สิทธิ์ใน ${plan.displayName}`}>
        <li className="text-sm text-secondary flex items-center gap-2">
          <Check size={14} className="text-success shrink-0" aria-hidden="true" />
          {plan.maxAgents === 0 ? "Agent ไม่จำกัด" : `Agent สูงสุด ${plan.maxAgents} คน`}
        </li>
        <li className="text-sm text-secondary flex items-center gap-2">
          <Check size={14} className="text-success shrink-0" aria-hidden="true" />
          {plan.maxSlaPolicies === 0
            ? "SLA Policy ไม่จำกัด"
            : `SLA Policy สูงสุด ${plan.maxSlaPolicies} รายการ`}
        </li>
        {plan.features.map((feature) => (
          <li key={feature} className="text-sm text-secondary flex items-center gap-2">
            <Check size={14} className="text-success shrink-0" aria-hidden="true" />
            <span className="capitalize">{feature.replace(/_/g, " ")}</span>
          </li>
        ))}
      </ul>

      {/* ปุ่ม */}
      {isCurrentPlan ? (
        <button
          type="button"
          disabled
          className="mt-auto w-full px-4 py-2 rounded-lg text-sm font-semibold bg-stone text-muted border border-border cursor-not-allowed"
        >
          แพ็กเกจปัจจุบัน
        </button>
      ) : (
        <button
          type="button"
          disabled={!hasPrice || isSelecting}
          onClick={() => onSelect(plan.name, interval)}
          title={!hasPrice ? "ยังไม่เปิดให้สมัคร" : undefined}
          className={[
            "mt-auto w-full inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white transition-colors",
            "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            hasPrice
              ? "bg-primary-strong hover:bg-primary-strong-hover"
              : "bg-stone text-muted border border-border",
          ].join(" ")}
        >
          {isThisCardSelecting ? (
            <RefreshCw size={14} className="animate-spin" aria-hidden="true" />
          ) : null}
          {isThisCardSelecting ? "กำลังโหลด..." : hasPrice ? "เลือกแพ็กเกจ" : "ยังไม่เปิดให้สมัคร"}
        </button>
      )}
    </div>
  );
}

// =============================================================================
// LOADING SKELETON
// =============================================================================

function BillingSkeleton() {
  return (
    <div className="animate-pulse flex flex-col gap-4" aria-busy="true" aria-label="กำลังโหลด...">
      <div className="h-40 bg-stone rounded-xl" />
      <div className="flex gap-3">
        <div className="h-8 w-28 bg-stone rounded-full" />
        <div className="h-8 w-28 bg-stone rounded-full" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-64 bg-stone rounded-xl" />
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function BillingPage() {
  const searchParams = useSearchParams();
  const [billing, setBilling] = useState<BillingData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isForbidden, setIsForbidden] = useState(false);
  const [interval, setInterval] = useState<BillingInterval>("monthly");
  const [isManaging, setIsManaging] = useState(false);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectingPlanName, setSelectingPlanName] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // status query param หลังกลับจาก Stripe checkout
  const statusParam = searchParams.get("status");

  const fetchBilling = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setIsForbidden(false);

    try {
      const res = await fetch("/api/billing", { credentials: "include" });

      if (res.status === 403) {
        // role ไม่ใช่ OWNER/ADMIN → แสดง forbidden state
        setIsForbidden(true);
        return;
      }

      const json = (await res.json()) as BillingResponse;

      if (!res.ok || json.error || !json.data) {
        setError(json.error?.message ?? "โหลดข้อมูล billing ไม่สำเร็จ");
        return;
      }

      setBilling(json.data);
    } catch {
      setError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    startTransition(() => { void fetchBilling(); });
  }, [fetchBilling]);

  async function handleManagePortal() {
    if (isManaging) return;
    setIsManaging(true);
    setActionError(null);

    try {
      const res = await fetch("/api/billing/portal", {
        method: "POST",
        credentials: "include",
      });

      const json = (await res.json()) as PortalResponse;

      if (!res.ok || json.error || !json.data?.url) {
        setActionError(json.error?.message ?? "ไม่สามารถเปิด Billing Portal ได้ กรุณาลองใหม่");
        return;
      }

      window.location.href = json.data.url;
    } catch {
      setActionError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsManaging(false);
    }
  }

  async function handleSelectPlan(planName: string, selectedInterval: BillingInterval) {
    if (isSelecting) return;
    setIsSelecting(true);
    setSelectingPlanName(planName);
    setActionError(null);

    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planName, interval: selectedInterval }),
      });

      const json = (await res.json()) as CheckoutResponse;

      if (!res.ok || json.error || !json.data?.url) {
        setActionError(json.error?.message ?? "ไม่สามารถเริ่ม checkout ได้ กรุณาลองใหม่");
        return;
      }

      window.location.href = json.data.url;
    } catch {
      setActionError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsSelecting(false);
      setSelectingPlanName(null);
    }
  }

  // ─── States ─────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-foreground">Billing</h1>
            <p className="mt-1 text-sm text-secondary">จัดการ subscription และแพ็กเกจ</p>
          </div>
          <BillingSkeleton />
        </div>
      </div>
    );
  }

  if (isForbidden) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="bg-surface rounded-xl border border-border p-8 max-w-sm w-full text-center flex flex-col items-center gap-4">
          <ShieldAlert size={40} className="text-muted" aria-hidden="true" />
          <h2 className="text-base font-semibold text-foreground">ไม่มีสิทธิ์เข้าถึง</h2>
          <p className="text-sm text-secondary">
            หน้า Billing เข้าได้เฉพาะ <strong>OWNER</strong> และ <strong>ADMIN</strong> เท่านั้น
          </p>
        </div>
      </div>
    );
  }

  if (error || !billing) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="bg-surface rounded-xl border border-border p-8 max-w-md w-full text-center">
          <p className="text-danger font-medium mb-4">{error ?? "เกิดข้อผิดพลาด"}</p>
          <button
            type="button"
            onClick={() => void fetchBilling()}
            className="text-sm text-primary-ink hover:underline"
          >
            ลองใหม่
          </button>
        </div>
      </div>
    );
  }

  const currentPlanName = billing.currentPlanName?.toLowerCase();

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

        {/* Page header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-foreground">Billing</h1>
          <p className="mt-1 text-sm text-secondary">จัดการ subscription และแพ็กเกจของ workspace</p>
        </div>

        {/* Alert จาก query param (กลับจาก Stripe) */}
        {statusParam === "success" && (
          <div className="mb-6">
            <FormAlert
              variant="success"
              message="สมัคร subscription สำเร็จ — ระบบกำลัง sync ข้อมูล อาจใช้เวลาสักครู่"
            />
          </div>
        )}
        {statusParam === "cancel" && (
          <div className="mb-6">
            <FormAlert
              variant="info"
              message="ยกเลิกการสมัคร — คุณยังอยู่ใน plan เดิม"
            />
          </div>
        )}

        {/* Action error */}
        {actionError && (
          <div className="mb-6">
            <FormAlert variant="error" message={actionError} />
          </div>
        )}

        {/* Subscription card */}
        <SubscriptionCard
          billing={billing}
          onManagePortal={() => void handleManagePortal()}
          isManaging={isManaging}
        />

        {/* Plan cards section */}
        <div className="mb-4">
          <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
            <h2 className="text-base font-semibold text-foreground">แพ็กเกจทั้งหมด</h2>

            {/* Toggle monthly/yearly */}
            <div
              className="flex items-center gap-1 p-1 bg-stone rounded-full border border-border"
              role="group"
              aria-label="เลือกรอบการชำระเงิน"
            >
              <button
                type="button"
                onClick={() => setInterval("monthly")}
                aria-pressed={interval === "monthly"}
                className={[
                  "px-3 py-1 rounded-full text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary",
                  interval === "monthly"
                    ? "bg-surface text-foreground shadow-sm border border-border"
                    : "text-secondary hover:text-foreground",
                ].join(" ")}
              >
                รายเดือน
              </button>
              <button
                type="button"
                onClick={() => setInterval("yearly")}
                aria-pressed={interval === "yearly"}
                className={[
                  "px-3 py-1 rounded-full text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary",
                  interval === "yearly"
                    ? "bg-surface text-foreground shadow-sm border border-border"
                    : "text-secondary hover:text-foreground",
                ].join(" ")}
              >
                รายปี
              </button>
            </div>
          </div>

          {/* Plan grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {billing.plans.map((plan) => (
              <PlanCard
                key={plan.name}
                plan={plan}
                isCurrentPlan={plan.name.toLowerCase() === currentPlanName}
                interval={interval}
                onSelect={(name, iv) => void handleSelectPlan(name, iv)}
                isSelecting={isSelecting}
                selectingPlanName={selectingPlanName}
              />
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
