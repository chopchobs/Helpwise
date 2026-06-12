"use client";

/**
 * SlaBadge — แสดงสถานะ SLA ของ ticket พร้อม live countdown
 * อัปเดตทุก 30 วินาที (ไม่จำเป็นต้อง real-time ทุกวินาที)
 * ใช้ semantic token ทั้งหมด ห้าม hardcode hex
 */

import { useState, useEffect } from "react";
import { PauseCircle, AlertTriangle, Clock, CheckCircle } from "lucide-react";
import { formatSlaCountdown } from "@/lib/ticket-ui";
import type { TicketSlaInfo } from "@/types/ticket";

// =============================================================================
// TYPES
// =============================================================================

interface SlaBadgeProps {
  sla: TicketSlaInfo | null;
  /** compact=true: badge ขนาดเล็กสำหรับ ticket list */
  compact?: boolean;
  className?: string;
}

// mapping variant → Tailwind semantic classes (ตาม design system)
const VARIANT_CLASSES: Record<
  "normal" | "warning" | "danger" | "paused" | "resolved",
  { bg: string; text: string; border: string }
> = {
  normal:   { bg: "bg-stone",         text: "text-secondary",    border: "border-border" },
  warning:  { bg: "bg-warning-tint",  text: "text-warning-ink",  border: "border-warning-tint" },
  danger:   { bg: "bg-danger-tint",   text: "text-danger",       border: "border-danger-tint" },
  paused:   { bg: "bg-stone",         text: "text-muted",        border: "border-border" },
  resolved: { bg: "bg-success-tint",  text: "text-success",      border: "border-success-tint" },
};

// =============================================================================
// HELPERS (คำนวณ state ของ SLA จาก snapshot)
// =============================================================================

interface SlaDisplayState {
  icon: React.ReactNode;
  label: string;
  /** deadline label: "first-response" | "resolution" */
  deadlineLabel: string;
  variant: "normal" | "warning" | "danger" | "paused" | "resolved";
}

/**
 * computeSlaState — คำนวณ display state จาก TicketSlaInfo + เวลาปัจจุบัน
 * pure-ish function (inject now เพื่อ testability ถ้าต้องการ)
 */
function computeSlaState(sla: TicketSlaInfo, now: Date): SlaDisplayState {
  // 1. paused
  if (sla.slaPausedAt !== null) {
    return {
      icon: <PauseCircle size={12} aria-hidden="true" />,
      label: "SLA พัก",
      deadlineLabel: "",
      variant: "paused",
    };
  }

  // 2. resolved — ถ้า resolvedAt มีค่า → ticket จบแล้ว
  // แต่ต้องเช็ค breach ก่อน: ถ้าเคยเกิน SLA (first-response หรือ resolution)
  // ต้องโชว์ danger "เกิน SLA" ไม่ใช่ "ผ่าน" สีเขียว (กัน signal ผิด)
  if (sla.resolvedAt !== null) {
    if (sla.firstResponseBreached || sla.resolutionBreached) {
      return {
        icon: <AlertTriangle size={12} aria-hidden="true" />,
        label: "เกิน SLA",
        deadlineLabel: "",
        variant: "danger",
      };
    }
    return {
      icon: <CheckCircle size={12} aria-hidden="true" />,
      label: "SLA ผ่าน",
      deadlineLabel: "",
      variant: "resolved",
    };
  }

  // 3. เลือก active deadline: first-response ก่อน, fallback resolution
  const useFirstResponse =
    sla.firstRespondedAt === null && sla.firstResponseDueAt !== null;

  const activeDeadlineIso = useFirstResponse
    ? sla.firstResponseDueAt
    : sla.resolutionDueAt;
  const isBreached = useFirstResponse
    ? sla.firstResponseBreached
    : sla.resolutionBreached;
  const deadlineLabel = useFirstResponse ? "ตอบครั้งแรก" : "แก้ปัญหา";

  // ไม่มี deadline เลย (SLA feature ปิด หรือ policy ไม่ครอบคลุม)
  if (!activeDeadlineIso) {
    return {
      icon: <Clock size={12} aria-hidden="true" />,
      label: "ไม่มี SLA",
      deadlineLabel: "",
      variant: "normal",
    };
  }

  // 4. คำนวณ countdown
  const result = formatSlaCountdown(activeDeadlineIso, now, isBreached);

  const icon =
    result.variant === "danger" ? (
      <AlertTriangle size={12} aria-hidden="true" />
    ) : (
      <Clock size={12} aria-hidden="true" />
    );

  return {
    icon,
    label: result.label,
    deadlineLabel,
    variant: result.variant,
  };
}

// =============================================================================
// COMPONENT
// =============================================================================

export default function SlaBadge({ sla, compact = false, className }: SlaBadgeProps) {
  // ใช้ null เพื่อหลีกเลี่ยง hydration mismatch (server ไม่รู้ clock ของ client)
  const [now, setNow] = useState<Date | null>(null);

  // mount แล้วค่อยตั้ง now + tick ทุก 30 วินาที
  useEffect(() => {
    // ตั้งเวลาฝั่ง client หลัง mount — กัน hydration mismatch กับ SSR (ตั้งใจ sync setState)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(new Date());

    const interval = setInterval(() => {
      setNow(new Date());
    }, 30_000);

    // cleanup interval เมื่อ unmount
    return () => clearInterval(interval);
  }, []);

  // ไม่มี SLA หรือยังไม่ hydrate → ไม่ render
  if (sla === null || now === null) return null;

  const state = computeSlaState(sla, now);
  const { bg, text, border } = VARIANT_CLASSES[state.variant];

  // compact: badge เดี่ยวไม่มี deadline label
  if (compact) {
    return (
      <span
        className={[
          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium border",
          bg, text, border, className,
        ]
          .filter(Boolean)
          .join(" ")}
        title={state.deadlineLabel ? `SLA ${state.deadlineLabel}: ${state.label}` : state.label}
      >
        {state.icon}
        {state.label}
      </span>
    );
  }

  // full variant: แสดง deadline label ด้วย
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium border",
        bg, text, border, className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {state.icon}
      <span>
        {state.deadlineLabel ? (
          <>
            <span className="opacity-70 mr-1">{state.deadlineLabel}:</span>
            {state.label}
          </>
        ) : (
          state.label
        )}
      </span>
    </span>
  );
}
