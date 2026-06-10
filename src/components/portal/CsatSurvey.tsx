"use client";

/**
 * CsatSurvey — portal CSAT widget (1-5 ดาว + comment เสริม)
 * แสดงเฉพาะเมื่อ ticket eligible (SOLVED/CLOSED + ยังไม่เคยส่ง)
 * Star rating ใช้ radiogroup/radio semantics — keyboard operable + accessible label
 * สี selected ใช้ text-warning (โทน amber ของ rating) ให้สอดคล้องกับ CsatStars
 */

import { useState } from "react";
import { Star, RefreshCw, CheckCircle2 } from "lucide-react";
import FormAlert from "@/components/ui/FormAlert";
import CsatStars from "@/components/ui/CsatStars";
import { formatDateFull } from "@/lib/ticket-ui";
import { CSAT_COMMENT_MAX_LENGTH } from "@/types/csat";
import type { CsatResponseDTO, PortalCsatSubmitResponse } from "@/types/csat";

// =============================================================================
// TYPES
// =============================================================================

interface CsatSurveyProps {
  ticketId: string;
  /** เรียกเมื่อ submit สำเร็จ (หรือเจอ ALREADY_SUBMITTED) เพื่ออัปเดต state ที่ parent */
  onSubmitted: (response: CsatResponseDTO) => void;
}

interface CsatThankYouProps {
  response: CsatResponseDTO;
}

// =============================================================================
// THANK-YOU CARD (read-only)
// =============================================================================

/** CsatThankYou — แสดงคะแนน + comment ที่ลูกค้าส่งไปแล้ว */
export function CsatThankYou({ response }: CsatThankYouProps) {
  return (
    <div className="bg-surface rounded-xl border border-border p-5 shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        <CheckCircle2 size={18} className="text-success" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-foreground">
          ขอบคุณสำหรับคะแนน
        </h2>
      </div>
      <CsatStars rating={response.rating} size="lg" />
      {response.comment && (
        <p className="mt-3 text-sm text-secondary whitespace-pre-wrap leading-relaxed">
          {response.comment}
        </p>
      )}
      <time className="block mt-3 text-xs text-muted" dateTime={response.createdAt}>
        ส่งเมื่อ {formatDateFull(response.createdAt)}
      </time>
    </div>
  );
}

// =============================================================================
// STAR RATING INPUT (radiogroup ของ radio 5 ปุ่ม)
// =============================================================================

interface StarRatingInputProps {
  value: number;
  onChange: (rating: number) => void;
  disabled: boolean;
}

const RATING_LABELS: Record<number, string> = {
  1: "แย่มาก",
  2: "แย่",
  3: "ปานกลาง",
  4: "ดี",
  5: "ดีมาก",
};

/**
 * StarRatingInput — radiogroup ของดาว 1-5
 * แต่ละดาวเป็น role="radio" เลือกได้ด้วยคีย์บอร์ด (Tab + Enter/Space, ลูกศรซ้าย-ขวา)
 * hover แสดง preview ด้วย local state แยกจาก value ที่เลือกจริง
 */
function StarRatingInput({ value, onChange, disabled }: StarRatingInputProps) {
  const [hoverValue, setHoverValue] = useState<number | null>(null);
  const displayValue = hoverValue ?? value;

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      onChange(value >= 5 ? 5 : value + 1 || 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      onChange(value <= 1 ? 1 : value - 1);
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="ให้คะแนนความพึงพอใจ 1 ถึง 5 ดาว"
      onKeyDown={handleKeyDown}
      className="inline-flex items-center gap-1"
    >
      {[1, 2, 3, 4, 5].map((star) => {
        const isSelected = value === star;
        const isFilled = star <= displayValue;

        return (
          <button
            key={star}
            type="button"
            role="radio"
            aria-checked={isSelected}
            aria-label={`${star} ดาว — ${RATING_LABELS[star]}`}
            tabIndex={isSelected || (value === 0 && star === 1) ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(star)}
            onMouseEnter={() => setHoverValue(star)}
            onMouseLeave={() => setHoverValue(null)}
            onFocus={() => setHoverValue(star)}
            onBlur={() => setHoverValue(null)}
            className="p-1 rounded-md focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Star
              size={32}
              aria-hidden="true"
              className={isFilled ? "fill-warning text-warning" : "text-muted"}
            />
          </button>
        );
      })}
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT — interactive form
// =============================================================================

export default function CsatSurvey({ ticketId, onSubmitted }: CsatSurveyProps) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (isSubmitting || rating < 1) return;
    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/portal/tickets/${ticketId}/csat`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, comment: comment.trim() || null }),
      });

      const json = (await res.json()) as PortalCsatSubmitResponse;

      // กรณีส่งซ้ำ (เช่น double-submit จากหลายแท็บ) — ถือว่าจบ flow แล้ว ไม่ใช่ error
      if (res.status === 409 && json.error?.code === "ALREADY_SUBMITTED") {
        // ไม่มี response กลับมาตรงๆ — ใช้ rating ที่ส่งล่าสุดเป็น fallback display
        onSubmitted({ rating, comment: comment.trim() || null, createdAt: new Date().toISOString() });
        return;
      }

      if (!res.ok || json.error || !json.data) {
        setError(json.error?.message ?? "ส่งคะแนนไม่สำเร็จ กรุณาลองใหม่");
        return;
      }

      onSubmitted(json.data);
    } catch {
      setError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="bg-surface rounded-xl border border-border p-5 shadow-sm">
      <h2 className="text-sm font-semibold text-foreground mb-1">
        ให้คะแนนความพึงพอใจ
      </h2>
      <p className="text-xs text-secondary mb-3">
        ความคิดเห็นของคุณช่วยให้เราปรับปรุงบริการได้ดียิ่งขึ้น
      </p>

      <StarRatingInput value={rating} onChange={setRating} disabled={isSubmitting} />

      <div className="mt-4">
        <label htmlFor="csat-comment" className="block text-xs font-medium text-secondary mb-1">
          ความคิดเห็นเพิ่มเติม (ไม่บังคับ)
        </label>
        <textarea
          id="csat-comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          maxLength={CSAT_COMMENT_MAX_LENGTH}
          disabled={isSubmitting}
          placeholder="บอกเราเพิ่มเติมเกี่ยวกับประสบการณ์ของคุณ..."
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground resize-none placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-colors hover:border-primary disabled:opacity-60"
        />
      </div>

      {error && (
        <div className="mt-2">
          <FormAlert variant="error" message={error} />
        </div>
      )}

      <div className="flex justify-end mt-3">
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={isSubmitting || rating < 1}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary-strong hover:bg-primary-strong-hover text-white text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary-strong"
        >
          {isSubmitting && <RefreshCw size={14} className="animate-spin" aria-hidden="true" />}
          {isSubmitting ? "กำลังส่ง..." : "ส่งคะแนน"}
        </button>
      </div>
    </div>
  );
}
