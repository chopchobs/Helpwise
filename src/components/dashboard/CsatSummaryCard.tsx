"use client";

/**
 * CsatSummaryCard — สรุปคะแนน CSAT ของ tenant สำหรับ dashboard
 * fetch GET /api/csat/summary — handle states: loading / feature-locked (403) / empty / loaded
 */

import { useState, useEffect, useCallback, useTransition } from "react";
import Link from "next/link";
import { Lock, ExternalLink, Star, RefreshCw } from "lucide-react";
import CsatStars from "@/components/ui/CsatStars";
import FormAlert from "@/components/ui/FormAlert";
import type { CsatSummary, CsatSummaryResponse } from "@/types/csat";

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

/** skeleton ระหว่างโหลด */
function CsatSummarySkeleton() {
  return (
    <div className="bg-surface rounded-xl border border-border p-4 animate-pulse">
      <div className="h-4 w-32 bg-stone rounded mb-4" />
      <div className="h-10 w-20 bg-stone rounded mb-3" />
      <div className="h-3 w-full bg-stone rounded" />
    </div>
  );
}

/** upsell state เมื่อ feature ถูก lock ตาม plan */
function CsatFeatureLocked() {
  return (
    <div className="bg-surface rounded-xl border border-border p-4 flex flex-col items-start gap-3">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-warning-tint flex items-center justify-center shrink-0">
          <Lock size={14} className="text-warning-ink" aria-hidden="true" />
        </div>
        <h2 className="text-sm font-semibold text-foreground">CSAT Survey</h2>
      </div>
      <p className="text-sm text-secondary">
        ฟีเจอร์สำรวจความพึงพอใจลูกค้าไม่รวมใน plan ปัจจุบัน — อัปเกรดเพื่อดูคะแนนความพึงพอใจของลูกค้า
      </p>
      <Link
        href="/settings/billing"
        className="inline-flex items-center gap-1 text-xs font-semibold text-primary-ink underline underline-offset-2 hover:opacity-80 focus:outline-none focus:ring-1 focus:ring-primary"
      >
        ดู Plan และอัปเกรด
        <ExternalLink size={10} aria-hidden="true" />
      </Link>
    </div>
  );
}

interface RatingDistributionBarsProps {
  distribution: CsatSummary["ratingDistribution"];
  responseCount: number;
}

/** แสดง bar เทียบสัดส่วนแต่ละ rating 1-5 */
function RatingDistributionBars({ distribution, responseCount }: RatingDistributionBarsProps) {
  return (
    <div className="flex flex-col gap-1.5 mt-3">
      {/* เรียงจาก 5 ดาวลงมา 1 ดาว ให้อ่านง่าย */}
      {[...distribution].reverse().map((bucket) => {
        const percent = responseCount > 0 ? (bucket.count / responseCount) * 100 : 0;

        return (
          <div key={bucket.rating} className="flex items-center gap-2">
            <span className="flex items-center gap-0.5 text-xs text-secondary w-6 shrink-0">
              {bucket.rating}
              <Star size={10} className="fill-warning text-warning" aria-hidden="true" />
            </span>
            <div className="flex-1 h-2 rounded-full bg-stone overflow-hidden">
              <div
                className="h-full rounded-full bg-warning"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="text-xs text-muted w-6 text-right shrink-0">{bucket.count}</span>
          </div>
        );
      })}
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export default function CsatSummaryCard() {
  const [summary, setSummary] = useState<CsatSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLocked, setIsLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const fetchSummary = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setIsLocked(false);

    try {
      const res = await fetch("/api/csat/summary", { credentials: "include" });
      const json = (await res.json()) as CsatSummaryResponse;

      if (res.status === 403 && json.error?.code === "FEATURE_LOCKED") {
        setIsLocked(true);
        return;
      }

      if (!res.ok || json.error || !json.data) {
        setError(json.error?.message ?? "โหลดข้อมูล CSAT ไม่สำเร็จ");
        return;
      }

      setSummary(json.data);
    } catch {
      setError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // ใช้ startTransition เพื่อหลีกเลี่ยง cascading render ตาม react-hooks/set-state-in-effect
  useEffect(() => {
    startTransition(() => { void fetchSummary(); });
  }, [fetchSummary]);

  if (isLoading) return <CsatSummarySkeleton />;
  if (isLocked) return <CsatFeatureLocked />;

  if (error) {
    return (
      <div className="bg-surface rounded-xl border border-border p-4">
        <FormAlert variant="error" message={error} />
      </div>
    );
  }

  if (!summary) return null;

  const responseRatePercent = Math.round(summary.responseRate * 100);

  return (
    <div className="bg-surface rounded-xl border border-border p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-foreground">CSAT Survey</h2>
        <button
          type="button"
          onClick={() => void fetchSummary()}
          aria-label="รีเฟรชข้อมูล CSAT"
          className="p-1 rounded-lg text-secondary hover:bg-stone transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>

      {summary.responseCount === 0 ? (
        <p className="text-sm text-secondary py-4 text-center">ยังไม่มีคะแนน CSAT</p>
      ) : (
        <>
          {/* คะแนนเฉลี่ย */}
          <div className="flex items-end gap-3 mb-1">
            <span className="text-3xl font-bold text-foreground leading-none">
              {summary.averageRating?.toFixed(1) ?? "—"}
            </span>
            {summary.averageRating !== null && (
              <CsatStars rating={summary.averageRating} size="md" />
            )}
          </div>

          {/* meta: จำนวน response + response rate */}
          <p className="text-xs text-secondary mb-2">
            {summary.responseCount} คำตอบ จาก {summary.eligibleCount} ticket
            ({responseRatePercent}% response rate)
          </p>

          {/* distribution bars */}
          <RatingDistributionBars
            distribution={summary.ratingDistribution}
            responseCount={summary.responseCount}
          />
        </>
      )}
    </div>
  );
}
