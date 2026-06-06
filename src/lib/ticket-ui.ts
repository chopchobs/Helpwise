/**
 * ticket-ui.ts — helper functions สำหรับ UI ของ ticket
 * ทุก function เป็น pure function ใช้ได้เฉพาะ client component (ไม่ import server lib)
 */

import type { TicketStatus, TicketPriority } from "@/types/ticket";

// =============================================================================
// STATUS
// =============================================================================

export interface StatusStyle {
  label: string;
  /** Tailwind class สำหรับ background */
  bg: string;
  /** Tailwind class สำหรับ text */
  text: string;
  /** Tailwind class สำหรับ border */
  border: string;
}

/** map TicketStatus → label + semantic color ตาม design system */
export function getStatusStyle(status: TicketStatus): StatusStyle {
  const map: Record<TicketStatus, StatusStyle> = {
    // NEW/OPEN — primary (Terracotta tint) แสดงว่า active / ต้องดำเนินการ
    NEW: {
      label:  "ใหม่",
      bg:     "bg-primary-tint",
      text:   "text-primary-ink",
      border: "border-primary-tint",
    },
    OPEN: {
      label:  "เปิด",
      bg:     "bg-primary-tint",
      text:   "text-primary-ink",
      border: "border-primary-tint",
    },
    // PENDING — warning (Amber) รอลูกค้าตอบ
    PENDING: {
      label:  "รอลูกค้า",
      bg:     "bg-warning-tint",
      text:   "text-warning-ink",
      border: "border-warning-tint",
    },
    // ON_HOLD — neutral (Stone/muted) พักชั่วคราว
    ON_HOLD: {
      label:  "พัก",
      bg:     "bg-stone",
      text:   "text-muted",
      border: "border-border",
    },
    // SOLVED — success (Sage green) แก้แล้ว
    SOLVED: {
      label:  "แก้แล้ว",
      bg:     "bg-success-tint",
      text:   "text-success",
      border: "border-success-tint",
    },
    // CLOSED — neutral (Stone/muted) ปิดแล้ว
    CLOSED: {
      label:  "ปิด",
      bg:     "bg-stone",
      text:   "text-muted",
      border: "border-border",
    },
  };
  return map[status];
}

// =============================================================================
// PRIORITY
// =============================================================================

export interface PriorityStyle {
  label: string;
  bg: string;
  text: string;
  border: string;
}

/** map TicketPriority → label + semantic color ตาม design system */
export function getPriorityStyle(priority: TicketPriority): PriorityStyle {
  const map: Record<TicketPriority, PriorityStyle> = {
    // LOW — neutral (Stone/muted)
    LOW: {
      label:  "ต่ำ",
      bg:     "bg-stone",
      text:   "text-muted",
      border: "border-border",
    },
    // NORMAL — primary (Terracotta tint) ระดับปกติ
    NORMAL: {
      label:  "ปกติ",
      bg:     "bg-primary-tint",
      text:   "text-primary-ink",
      border: "border-primary-tint",
    },
    // HIGH — warning (Amber) ต้องรีบดูแล
    HIGH: {
      label:  "สูง",
      bg:     "bg-warning-tint",
      text:   "text-warning-ink",
      border: "border-warning-tint",
    },
    // URGENT — danger (Sienna) เร่งด่วนสูงสุด
    URGENT: {
      label:  "เร่งด่วน",
      bg:     "bg-danger-tint",
      text:   "text-danger",
      border: "border-danger-tint",
    },
  };
  return map[priority];
}

// =============================================================================
// DATE FORMAT
// =============================================================================

/** format วันที่แบบกระชับ สำหรับ list (เช่น "2 มิ.ย. 68, 14:30") */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("th-TH", {
    day:    "numeric",
    month:  "short",
    year:   "2-digit",
    hour:   "2-digit",
    minute: "2-digit",
  });
}

/** format วันที่แบบเต็มสำหรับ message thread (เช่น "2 มิถุนายน 2568, 14:30") */
export function formatDateFull(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("th-TH", {
    day:    "numeric",
    month:  "long",
    year:   "numeric",
    hour:   "2-digit",
    minute: "2-digit",
  });
}

// =============================================================================
// SLA COUNTDOWN FORMAT
// =============================================================================

export interface SlaCountdownResult {
  /** label แสดงผล เช่น "เหลือ 2 ชม. 15 น." | "เกิน 30 น." | "พรุ่งนี้ 09:00" */
  label: string;
  /** variant ของ badge */
  variant: "normal" | "warning" | "danger" | "paused" | "resolved";
}

/**
 * formatSlaCountdown — pure function คำนวณ SLA countdown จาก deadline + ปัจจุบัน
 * ใช้สำหรับ SlaBadge live-tick
 *
 * @param deadlineIso  ISO 8601 string ของ deadline
 * @param now          Date ปัจจุบัน (inject เพื่อ testability)
 * @param isBreached   ข้อมูล breached ที่ server คำนวณไว้แล้ว
 * @param warningThresholdMs  เวลาเหลือน้อยกว่านี้ = warning (default 60 นาที)
 */
export function formatSlaCountdown(
  deadlineIso: string,
  now: Date,
  isBreached: boolean,
  warningThresholdMs = 60 * 60 * 1000
): SlaCountdownResult {
  const deadline = new Date(deadlineIso);
  const diffMs = deadline.getTime() - now.getTime();

  // เกิน deadline แล้ว
  if (isBreached || diffMs <= 0) {
    const overMs = Math.abs(diffMs);
    return { label: `เกิน ${formatDuration(overMs)}`, variant: "danger" };
  }

  // ใกล้ครบ (น้อยกว่า threshold)
  if (diffMs < warningThresholdMs) {
    return { label: `ใกล้ครบ ${formatDuration(diffMs)}`, variant: "warning" };
  }

  // เหลือเวลาปกติ
  return { label: `เหลือ ${formatDuration(diffMs)}`, variant: "normal" };
}

/**
 * formatDuration — แปลง milliseconds เป็น string กระชับภาษาไทย
 * เช่น 7740000 ms → "2 ชม. 9 น."
 */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);

  if (totalMinutes < 1) {
    return "น้อยกว่า 1 น.";
  }

  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days >= 1) {
    const parts = [`${days} วัน`];
    if (hours > 0) parts.push(`${hours} ชม.`);
    return parts.join(" ");
  }

  if (hours >= 1) {
    const parts = [`${hours} ชม.`];
    if (minutes > 0) parts.push(`${minutes} น.`);
    return parts.join(" ");
  }

  return `${minutes} น.`;
}

// =============================================================================
// BILLING FORMAT
// =============================================================================

/**
 * formatMoney — แปลง Int satang/cents เป็น string แสดงราคา
 * เช่น formatMoney(29900, "thb") → "299.00 THB"
 * money เก็บเป็น Int — ห้ามใช้ Float (กฎ project)
 */
export function formatMoney(satang: number, currency: string): string {
  const amount = satang / 100;
  const formatted = amount.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${formatted} ${currency.toUpperCase()}`;
}

// =============================================================================
// AUTHOR DISPLAY
// =============================================================================

/** ดึงชื่อผู้ส่งจาก message (ใช้ field ที่ไม่ null) */
export function getAuthorName(
  authorMember: { user: { name: string | null } } | null,
  authorContact: { name: string | null } | null
): string {
  if (authorMember?.user?.name) return authorMember.user.name;
  if (authorContact?.name) return authorContact.name;
  return "ไม่ระบุชื่อ";
}

/** บอกว่า message นี้มาจาก agent หรือ contact */
export function isAgentMessage(
  authorMember: { user: { name: string | null } } | null
): boolean {
  return authorMember !== null;
}
