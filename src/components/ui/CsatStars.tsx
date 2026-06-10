/**
 * CsatStars — read-only star rating display (1-5)
 * ใช้แสดงผล CSAT rating ทั้งฝั่ง portal (thank-you) และ agent (ticket detail/list)
 * ดาวที่ติด = text-warning (โทน amber ตาม semantic token), ดาวว่าง = text-muted
 */

import { Star } from "lucide-react";

// =============================================================================
// TYPES
// =============================================================================

interface CsatStarsProps {
  rating: number;
  /** compact = ดาวเล็กลง สำหรับ ticket list column */
  size?: "sm" | "md" | "lg";
  /** แสดงตัวเลขคะแนนกำกับด้านหลังดาวด้วย */
  showValue?: boolean;
  className?: string;
}

const SIZE_PX: Record<NonNullable<CsatStarsProps["size"]>, number> = {
  sm: 12,
  md: 16,
  lg: 24,
};

// =============================================================================
// COMPONENT
// =============================================================================

export default function CsatStars({
  rating,
  size = "md",
  showValue = false,
  className,
}: CsatStarsProps) {
  const starSize = SIZE_PX[size];
  // clamp ป้องกัน rating ผิดช่วงจาก backend (defensive)
  const filledCount = Math.max(0, Math.min(5, Math.round(rating)));

  return (
    <span
      className={["inline-flex items-center gap-0.5", className].filter(Boolean).join(" ")}
      role="img"
      aria-label={`คะแนน ${rating} จาก 5 ดาว`}
    >
      {Array.from({ length: 5 }, (_, i) => {
        const filled = i < filledCount;
        return (
          <Star
            key={i}
            size={starSize}
            aria-hidden="true"
            className={filled ? "fill-warning text-warning" : "text-muted"}
          />
        );
      })}
      {showValue && (
        <span className="ml-1 text-sm font-medium text-foreground">
          {rating.toFixed(1)}
        </span>
      )}
    </span>
  );
}
