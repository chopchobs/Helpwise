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
  /** Tailwind arbitrary class สำหรับ background */
  bg: string;
  /** Tailwind arbitrary class สำหรับ text */
  text: string;
  /** Tailwind arbitrary class สำหรับ border */
  border: string;
}

/** map TicketStatus → label + semantic color ตาม design system */
export function getStatusStyle(status: TicketStatus): StatusStyle {
  const map: Record<TicketStatus, StatusStyle> = {
    NEW: {
      label: "ใหม่",
      bg: "bg-[#EEF2FF]",
      text: "text-[#3B5BDB]",
      border: "border-[#C5D0FF]",
    },
    OPEN: {
      label: "เปิด",
      bg: "bg-[#EEF2FF]",
      text: "text-[#3B5BDB]",
      border: "border-[#C5D0FF]",
    },
    PENDING: {
      label: "รอลูกค้า",
      bg: "bg-[#FFF4F0]",
      text: "text-[#E8590C]",
      border: "border-[#FFCAAD]",
    },
    ON_HOLD: {
      label: "พัก",
      bg: "bg-[#F3F4F6]",
      text: "text-[#6B7280]",
      border: "border-[#E4E7EB]",
    },
    SOLVED: {
      label: "แก้แล้ว",
      bg: "bg-[#ECFDF5]",
      text: "text-[#0CA678]",
      border: "border-[#A7F3D0]",
    },
    CLOSED: {
      label: "ปิด",
      bg: "bg-[#F3F4F6]",
      text: "text-[#6B7280]",
      border: "border-[#E4E7EB]",
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
    LOW: {
      label: "ต่ำ",
      bg: "bg-[#F3F4F6]",
      text: "text-[#6B7280]",
      border: "border-[#E4E7EB]",
    },
    NORMAL: {
      label: "ปกติ",
      bg: "bg-[#EEF2FF]",
      text: "text-[#3B5BDB]",
      border: "border-[#C5D0FF]",
    },
    HIGH: {
      label: "สูง",
      bg: "bg-[#FFF4F0]",
      text: "text-[#E8590C]",
      border: "border-[#FFCAAD]",
    },
    URGENT: {
      label: "เร่งด่วน",
      bg: "bg-[#FFF5F5]",
      text: "text-[#E03131]",
      border: "border-[#FFC9C9]",
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
    day: "numeric",
    month: "short",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** format วันที่แบบเต็มสำหรับ message thread (เช่น "2 มิถุนายน 2568, 14:30") */
export function formatDateFull(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("th-TH", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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
