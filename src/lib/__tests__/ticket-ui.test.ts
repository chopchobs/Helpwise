/**
 * src/lib/__tests__/ticket-ui.test.ts
 * Unit tests สำหรับ ticket-ui.ts — pure UI helper functions
 * ไม่มี DOM, no server, no DB
 */

import { describe, it, expect } from "vitest";
import {
  formatSlaCountdown,
  formatDuration,
  formatMinutes,
  formatMoney,
  getStatusStyle,
  getPriorityStyle,
  formatDate,
  formatDateFull,
  getAuthorName,
  isAgentMessage,
} from "@/lib/ticket-ui";
import type { TicketStatus, TicketPriority } from "@/types/ticket";

// =============================================================================
// B.1 — formatDuration
// =============================================================================

describe("formatDuration", () => {
  it("ms < 60_000 (น้อยกว่า 1 นาที) → 'น้อยกว่า 1 น.'", () => {
    expect(formatDuration(0)).toBe("น้อยกว่า 1 น.");
    expect(formatDuration(30_000)).toBe("น้อยกว่า 1 น.");
    expect(formatDuration(59_999)).toBe("น้อยกว่า 1 น.");
  });

  it("60_000 ms (1 นาที) → '1 น.'", () => {
    expect(formatDuration(60_000)).toBe("1 น.");
  });

  it("15 นาที → '15 น.'", () => {
    expect(formatDuration(15 * 60_000)).toBe("15 น.");
  });

  it("59 นาที → '59 น.'", () => {
    expect(formatDuration(59 * 60_000)).toBe("59 น.");
  });

  it("60 นาที (1 ชม.) → '1 ชม.'", () => {
    expect(formatDuration(60 * 60_000)).toBe("1 ชม.");
  });

  it("90 นาที (1 ชม. 30 น.) → '1 ชม. 30 น.'", () => {
    expect(formatDuration(90 * 60_000)).toBe("1 ชม. 30 น.");
  });

  it("120 นาที (2 ชม.) → '2 ชม.'", () => {
    expect(formatDuration(120 * 60_000)).toBe("2 ชม.");
  });

  it("135 นาที (2 ชม. 15 น.) → '2 ชม. 15 น.'", () => {
    expect(formatDuration(135 * 60_000)).toBe("2 ชม. 15 น.");
  });

  it("1 วัน (1440 นาที) → '1 วัน'", () => {
    expect(formatDuration(1440 * 60_000)).toBe("1 วัน");
  });

  it("1 วัน 2 ชม. → '1 วัน 2 ชม.'", () => {
    // 1440 + 120 = 1560 นาที
    expect(formatDuration(1560 * 60_000)).toBe("1 วัน 2 ชม.");
  });

  it("2 วัน 5 ชม. → '2 วัน 5 ชม.'", () => {
    // (2*1440 + 5*60) = 3180 นาที
    expect(formatDuration(3180 * 60_000)).toBe("2 วัน 5 ชม.");
  });

  it("1 วัน ตรง ๆ ไม่มี hours leftover → '1 วัน' (ไม่มี hours part)", () => {
    // 24 ชม. พอดี = 0 hours leftover ในวัน
    expect(formatDuration(24 * 60 * 60_000)).toBe("1 วัน");
  });

  it("minutes ที่ days มี hours=0 → แสดงแค่วัน ไม่มี hours part", () => {
    // 48 ชม. = 2 วัน (hours leftover = 0)
    expect(formatDuration(48 * 60 * 60_000)).toBe("2 วัน");
  });
});

// =============================================================================
// B.2 — formatMinutes
// =============================================================================

describe("formatMinutes", () => {
  it("minutes < 1 → 'น้อยกว่า 1 น.'", () => {
    expect(formatMinutes(0)).toBe("น้อยกว่า 1 น.");
  });

  it("15 → '15 น.'", () => {
    expect(formatMinutes(15)).toBe("15 น.");
  });

  it("60 → '1 ชม.'", () => {
    expect(formatMinutes(60)).toBe("1 ชม.");
  });

  it("90 → '1 ชม. 30 น.'", () => {
    expect(formatMinutes(90)).toBe("1 ชม. 30 น.");
  });

  it("1440 → '1 วัน' (24 ชม. พอดี)", () => {
    expect(formatMinutes(1440)).toBe("1 วัน");
  });

  it("2880 → '2 วัน' (48 ชม. พอดี)", () => {
    expect(formatMinutes(2880)).toBe("2 วัน");
  });

  it("480 → '8 ชม.'", () => {
    expect(formatMinutes(480)).toBe("8 ชม.");
  });

  it("120 → '2 ชม.'", () => {
    expect(formatMinutes(120)).toBe("2 ชม.");
  });
});

// =============================================================================
// B.3 — formatSlaCountdown
// =============================================================================

describe("formatSlaCountdown", () => {
  const now = new Date("2025-06-09T10:00:00.000Z");

  // --- breached ---

  it("isBreached=true → variant='danger', label เริ่มด้วย 'เกิน'", () => {
    // deadline ยังไม่ถึงแต่ isBreached=true (server flagged)
    const deadline = new Date("2025-06-09T11:00:00.000Z");
    const result = formatSlaCountdown(deadline.toISOString(), now, true);
    expect(result.variant).toBe("danger");
    expect(result.label).toMatch(/^เกิน/);
  });

  it("deadline ผ่านไปแล้ว (diffMs <= 0) และ isBreached=false → variant='danger'", () => {
    // deadline อยู่ในอดีต
    const deadline = new Date("2025-06-09T09:30:00.000Z");
    const result = formatSlaCountdown(deadline.toISOString(), now, false);
    expect(result.variant).toBe("danger");
    expect(result.label).toMatch(/^เกิน/);
  });

  it("isBreached=true + deadline อยู่ในอดีต → label บอก over-time duration", () => {
    // 30 นาทีที่แล้ว
    const deadline = new Date("2025-06-09T09:30:00.000Z");
    const result = formatSlaCountdown(deadline.toISOString(), now, true);
    expect(result.label).toBe("เกิน 30 น.");
  });

  // --- warning (ใกล้ครบ) ---

  it("deadline อีก 30 น. (น้อยกว่า default 60 น. threshold) → variant='warning'", () => {
    const deadline = new Date("2025-06-09T10:30:00.000Z"); // อีก 30 นาที
    const result = formatSlaCountdown(deadline.toISOString(), now, false);
    expect(result.variant).toBe("warning");
    expect(result.label).toMatch(/^ใกล้ครบ/);
  });

  it("deadline อีก 59 น. → variant='warning'", () => {
    const deadline = new Date("2025-06-09T10:59:00.000Z");
    const result = formatSlaCountdown(deadline.toISOString(), now, false);
    expect(result.variant).toBe("warning");
  });

  it("deadline พอดีกับ threshold (60 น.) → variant='normal' (ไม่ trigger warning)", () => {
    // diffMs = 60 * 60_000 = warningThresholdMs → condition: diffMs < threshold (false)
    const deadline = new Date("2025-06-09T11:00:00.000Z"); // อีกพอดี 60 นาที
    const result = formatSlaCountdown(deadline.toISOString(), now, false);
    expect(result.variant).toBe("normal");
  });

  // --- normal ---

  it("deadline อีก 2 ชม. → variant='normal'", () => {
    const deadline = new Date("2025-06-09T12:00:00.000Z");
    const result = formatSlaCountdown(deadline.toISOString(), now, false);
    expect(result.variant).toBe("normal");
    expect(result.label).toMatch(/^เหลือ/);
  });

  it("deadline อีก 1 วัน → variant='normal', label='เหลือ 1 วัน'", () => {
    const deadline = new Date("2025-06-10T10:00:00.000Z"); // อีก 24 ชม.
    const result = formatSlaCountdown(deadline.toISOString(), now, false);
    expect(result.variant).toBe("normal");
    expect(result.label).toBe("เหลือ 1 วัน");
  });

  // --- custom threshold ---

  it("custom warningThresholdMs=120 น. → deadline อีก 90 น. ควร warning", () => {
    const deadline = new Date("2025-06-09T11:30:00.000Z"); // อีก 90 นาที
    const result = formatSlaCountdown(
      deadline.toISOString(),
      now,
      false,
      120 * 60_000 // threshold 120 นาที
    );
    expect(result.variant).toBe("warning");
  });

  it("isBreached=true เมื่อ deadline อยู่ในอนาคตไกล → ยังคง danger (server บอก breached)", () => {
    const deadline = new Date("2025-06-10T12:00:00.000Z"); // อีก 26 ชม.
    const result = formatSlaCountdown(deadline.toISOString(), now, true);
    // server บอก breached แม้ deadline ยังไม่ถึง (เช่น กรณี pause + resume)
    expect(result.variant).toBe("danger");
  });
});

// =============================================================================
// B.4 — formatMoney
// =============================================================================

describe("formatMoney", () => {
  it("10000 satang + 'thb' → หาร 100 = 100 บาท", () => {
    const result = formatMoney(10000, "thb");
    // ตรวจ currency uppercase
    expect(result).toContain("THB");
    // ตรวจ amount ที่หาร 100 แล้ว → 100.00
    expect(result).toMatch(/100/);
  });

  it("29900 satang + 'thb' → 299 บาท", () => {
    const result = formatMoney(29900, "thb");
    expect(result).toContain("THB");
    expect(result).toMatch(/299/);
  });

  it("0 satang → 0.00", () => {
    const result = formatMoney(0, "thb");
    expect(result).toContain("THB");
    expect(result).toMatch(/0/);
  });

  it("currency case insensitive → uppercase ใน output", () => {
    const lower = formatMoney(10000, "thb");
    const upper = formatMoney(10000, "THB");
    expect(lower).toContain("THB");
    expect(upper).toContain("THB");
  });

  it("USD currency → uppercase 'USD'", () => {
    const result = formatMoney(1000, "usd");
    expect(result).toContain("USD");
  });

  it("100 satang = 1.00 unit (ตรวจว่าหาร 100 จริง ไม่ใช่ 1000)", () => {
    const result = formatMoney(100, "thb");
    // ต้องได้ 1.00 ไม่ใช่ 0.10 หรือ 10.00
    expect(result).toMatch(/1\.00|1,00/);
  });

  it("จำนวนเงินใหญ่: 1_000_000 satang = 10,000 บาท", () => {
    const result = formatMoney(1_000_000, "thb");
    expect(result).toContain("THB");
    // ตรวจ 10000 ในรูปแบบต่าง ๆ (locale อาจใช้ comma separator)
    expect(result).toMatch(/10[,.]?000/);
  });

  it("minimumFractionDigits=2: แม้เป็นตัวเลขกลม ต้องแสดง .00", () => {
    const result = formatMoney(50000, "thb"); // 500.00 บาท
    // ต้องมี .00 หรือ ,00 (ขึ้นอยู่กับ locale separator)
    expect(result).toMatch(/\.00|,00/);
  });
});

// =============================================================================
// B.5 — getStatusStyle
// =============================================================================

describe("getStatusStyle", () => {
  const statuses: TicketStatus[] = [
    "NEW",
    "OPEN",
    "PENDING",
    "ON_HOLD",
    "SOLVED",
    "CLOSED",
  ];

  it.each(statuses)("returns a defined, populated style object for %s", (status) => {
    const style = getStatusStyle(status);
    expect(style).toBeDefined();
    expect(typeof style.label).toBe("string");
    expect(style.label.length).toBeGreaterThan(0);
    expect(typeof style.bg).toBe("string");
    expect(style.bg.length).toBeGreaterThan(0);
    expect(typeof style.text).toBe("string");
    expect(style.text.length).toBeGreaterThan(0);
    expect(typeof style.border).toBe("string");
    expect(style.border.length).toBeGreaterThan(0);
  });

  it("NEW and OPEN share the same primary-tint colors but have distinct labels", () => {
    const newStyle = getStatusStyle("NEW");
    const openStyle = getStatusStyle("OPEN");
    expect(newStyle.bg).toBe(openStyle.bg);
    expect(newStyle.text).toBe(openStyle.text);
    expect(newStyle.border).toBe(openStyle.border);
    expect(newStyle.label).toBe("ใหม่");
    expect(openStyle.label).toBe("เปิด");
    expect(newStyle).toEqual({
      label: "ใหม่",
      bg: "bg-primary-tint",
      text: "text-primary-ink",
      border: "border-primary-tint",
    });
  });

  it("PENDING maps to warning (amber) style", () => {
    expect(getStatusStyle("PENDING")).toEqual({
      label: "รอลูกค้า",
      bg: "bg-warning-tint",
      text: "text-warning-ink",
      border: "border-warning-tint",
    });
  });

  it("ON_HOLD and CLOSED share the same neutral/stone colors but have distinct labels", () => {
    const onHold = getStatusStyle("ON_HOLD");
    const closed = getStatusStyle("CLOSED");
    expect(onHold.bg).toBe(closed.bg);
    expect(onHold.text).toBe(closed.text);
    expect(onHold.border).toBe(closed.border);
    expect(onHold).toEqual({
      label: "พัก",
      bg: "bg-stone",
      text: "text-muted",
      border: "border-border",
    });
    expect(closed.label).toBe("ปิด");
  });

  it("SOLVED maps to success (sage green) style", () => {
    expect(getStatusStyle("SOLVED")).toEqual({
      label: "แก้แล้ว",
      bg: "bg-success-tint",
      text: "text-success",
      border: "border-success-tint",
    });
  });
});

// =============================================================================
// B.6 — getPriorityStyle
// =============================================================================

describe("getPriorityStyle", () => {
  const priorities: TicketPriority[] = ["LOW", "NORMAL", "HIGH", "URGENT"];

  it.each(priorities)("returns a defined, populated style object for %s", (priority) => {
    const style = getPriorityStyle(priority);
    expect(style).toBeDefined();
    expect(typeof style.label).toBe("string");
    expect(style.label.length).toBeGreaterThan(0);
    expect(typeof style.bg).toBe("string");
    expect(style.bg.length).toBeGreaterThan(0);
    expect(typeof style.text).toBe("string");
    expect(style.text.length).toBeGreaterThan(0);
    expect(typeof style.border).toBe("string");
    expect(style.border.length).toBeGreaterThan(0);
  });

  it("LOW maps to neutral/stone style", () => {
    expect(getPriorityStyle("LOW")).toEqual({
      label: "ต่ำ",
      bg: "bg-stone",
      text: "text-muted",
      border: "border-border",
    });
  });

  it("NORMAL maps to primary-tint style", () => {
    expect(getPriorityStyle("NORMAL")).toEqual({
      label: "ปกติ",
      bg: "bg-primary-tint",
      text: "text-primary-ink",
      border: "border-primary-tint",
    });
  });

  it("HIGH maps to warning (amber) style", () => {
    expect(getPriorityStyle("HIGH")).toEqual({
      label: "สูง",
      bg: "bg-warning-tint",
      text: "text-warning-ink",
      border: "border-warning-tint",
    });
  });

  it("URGENT maps to danger (sienna) style", () => {
    expect(getPriorityStyle("URGENT")).toEqual({
      label: "เร่งด่วน",
      bg: "bg-danger-tint",
      text: "text-danger",
      border: "border-danger-tint",
    });
  });

  it("all 4 priorities have distinct label values", () => {
    const labels = priorities.map((p) => getPriorityStyle(p).label);
    expect(new Set(labels).size).toBe(4);
  });
});

// =============================================================================
// B.7 — formatDate / formatDateFull
// =============================================================================

describe("formatDate", () => {
  const iso = "2025-06-09T10:30:00.000Z";

  it("returns a non-empty string", () => {
    const result = formatDate(iso);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("contains the 2-digit Buddhist year (68 for 2025) — th-TH locale", () => {
    // toLocaleString("th-TH", { year: "2-digit" }) → พ.ศ. 2568 → "68"
    const result = formatDate(iso);
    expect(result).toMatch(/68/);
  });

  it("contains a colon-separated time component (HH:mm)", () => {
    const result = formatDate(iso);
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("formatDateFull", () => {
  const iso = "2025-06-09T10:30:00.000Z";

  it("returns a non-empty string", () => {
    const result = formatDateFull(iso);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("contains the full Buddhist year 2568", () => {
    // toLocaleString("th-TH", { year: "numeric" }) → "2568"
    const result = formatDateFull(iso);
    expect(result).toMatch(/2568/);
  });

  it("contains a colon-separated time component (HH:mm)", () => {
    const result = formatDateFull(iso);
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });

  it("formatDateFull output is longer than formatDate (full month name vs short)", () => {
    // long month name (เช่น "มิถุนายน") ยาวกว่า short ("มิ.ย.")
    expect(formatDateFull(iso).length).toBeGreaterThan(formatDate(iso).length);
  });
});

// =============================================================================
// B.8 — getAuthorName / isAgentMessage
// =============================================================================

describe("getAuthorName", () => {
  it("authorMember with a name → returns member's name", () => {
    const member = { user: { name: "Agent Somchai" } };
    expect(getAuthorName(member, null)).toBe("Agent Somchai");
  });

  it("authorMember.user.name is null, authorContact has name → returns contact's name", () => {
    const member = { user: { name: null } };
    const contact = { name: "Khun Customer" };
    expect(getAuthorName(member, contact)).toBe("Khun Customer");
  });

  it("authorMember is null, authorContact has name → returns contact's name", () => {
    const contact = { name: "Khun Customer" };
    expect(getAuthorName(null, contact)).toBe("Khun Customer");
  });

  it("both authorMember and authorContact are null → fallback 'ไม่ระบุชื่อ'", () => {
    expect(getAuthorName(null, null)).toBe("ไม่ระบุชื่อ");
  });

  it("authorMember present but user.name null, authorContact present but name null → fallback 'ไม่ระบุชื่อ'", () => {
    const member = { user: { name: null } };
    const contact = { name: null };
    expect(getAuthorName(member, contact)).toBe("ไม่ระบุชื่อ");
  });

  it("authorMember.user.name takes precedence over authorContact.name when both present", () => {
    const member = { user: { name: "Agent Somchai" } };
    const contact = { name: "Khun Customer" };
    expect(getAuthorName(member, contact)).toBe("Agent Somchai");
  });

  it("authorMember.user.name is empty string (falsy) → falls through to authorContact", () => {
    // ใช้ truthiness check (?.user?.name) — empty string ถือเป็น falsy
    const member = { user: { name: "" } };
    const contact = { name: "Khun Customer" };
    expect(getAuthorName(member, contact)).toBe("Khun Customer");
  });
});

describe("isAgentMessage", () => {
  it("authorMember non-null → true (agent message)", () => {
    const member = { user: { name: "Agent Somchai" } };
    expect(isAgentMessage(member)).toBe(true);
  });

  it("authorMember is null → false (contact message)", () => {
    expect(isAgentMessage(null)).toBe(false);
  });

  it("authorMember present even with user.name null → still true (only null-check matters)", () => {
    const member = { user: { name: null } };
    expect(isAgentMessage(member)).toBe(true);
  });
});
