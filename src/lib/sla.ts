/**
 * src/lib/sla.ts
 * SLA Engine — pure business logic สำหรับคำนวณ deadline + business hours
 *
 * ไฟล์นี้ตั้งใจให้ไม่มี Prisma/Next import เพื่อให้ unit test ง่าย
 * ทุก function รับ plain data และคืน plain value
 *
 * Business Hours Timezone:
 *   ใช้ Intl.DateTimeFormat เพื่อแปลง Date เป็น local wall-clock time ของ tenant
 *   โดยไม่สมมติว่า server timezone ตรงกับ tenant timezone
 *
 * ⚠️ loop cap: addBusinessMinutes มี guard ≤ MAX_DAY_WALK_ITERATIONS เพื่อกัน infinite loop
 *   ถ้าเกิน cap หรือ business hours ไม่ valid → fallback 24/7 arithmetic
 */

import type { TicketPriority } from "@prisma/client";

// =============================================================================
// TYPES
// =============================================================================

/** วันใน week — ตาม ISO naming */
export type Weekday = "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN";

/** Business hours สำหรับ tenant — parse จาก Tenant.settings JSON */
export interface BusinessHours {
  /** IANA timezone เช่น "Asia/Bangkok", "America/New_York" */
  timezone: string;
  /** วันทำงาน + ช่วงเวลา (24-hour "HH:MM" format) */
  days: Array<{ day: Weekday; start: string; end: string }>;
}

/** SLA minutes คู่ per priority */
export interface SlaMinutes {
  firstResponseMin: number;
  resolutionMin: number;
}

/**
 * ส่วนของ SlaPolicy ที่ engine ต้องการ — ไม่ require full row
 * ทำให้ caller ส่ง Prisma select ที่ดึงเฉพาะ field ที่จำเป็นได้
 */
export interface SlaPolicyFields {
  firstResponseLowMin: number;
  firstResponseNormMin: number;
  firstResponseHighMin: number;
  firstResponseUrgMin: number;
  resolutionLowMin: number;
  resolutionNormMin: number;
  resolutionHighMin: number;
  resolutionUrgMin: number;
}

/** Input สำหรับ computeDeadlines */
export interface ComputeDeadlinesInput {
  /** เวลาเริ่มนับ (โดยปกติ = createdAt ของ ticket) */
  startAt: Date;
  priority: TicketPriority;
  /** SLA policy fields จาก DB — null = ใช้ DEFAULT_SLA_MINUTES */
  policy: SlaPolicyFields | null;
  /** business hours ของ tenant — null = 24/7 */
  businessHours: BusinessHours | null;
}

// =============================================================================
// DEFAULT SLA MINUTES (mirror schema @default values)
// เป็น canonical fallback เมื่อ tenant ไม่มี SlaPolicy row
// =============================================================================

/**
 * ค่า SLA default ตรงกับ @default ใน schema.prisma (SlaPolicy)
 * ใช้เมื่อ tenant ไม่มี policy row — ไม่ต้อง backfill ข้อมูลเก่า
 */
export const DEFAULT_SLA_MINUTES: Record<
  TicketPriority,
  SlaMinutes
> = {
  LOW:    { firstResponseMin: 480,  resolutionMin: 2880 },
  NORMAL: { firstResponseMin: 240,  resolutionMin: 1440 },
  HIGH:   { firstResponseMin: 60,   resolutionMin: 480  },
  URGENT: { firstResponseMin: 15,   resolutionMin: 120  },
};

// =============================================================================
// PARSE BUSINESS HOURS
// =============================================================================

/** validate รูปแบบ "HH:MM" (00:00–23:59) */
function isValidTimeString(s: unknown): s is string {
  if (typeof s !== "string") return false;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** validate Weekday string */
function isWeekday(s: unknown): s is Weekday {
  return (
    typeof s === "string" &&
    ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].includes(s)
  );
}

/**
 * Parse Tenant.settings Json เพื่อดึง BusinessHours
 * Return null ถ้า:
 *   - settings ไม่ใช่ object
 *   - ไม่มี businessHours key
 *   - timezone ไม่ใช่ string หรือว่าง
 *   - days ไม่ใช่ array หรือไม่มี valid entry เลย
 *
 * Defensive: ข้าม entry ที่ invalid แทนที่จะ return null ทั้งหมด
 * (tenant อาจตั้งค่า partial — ดีกว่า ignore บางวันมากกว่า disable ทั้งหมด)
 */
export function parseBusinessHours(settings: unknown): BusinessHours | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return null;
  }

  const s = settings as Record<string, unknown>;
  const bh = s["businessHours"];

  if (!bh || typeof bh !== "object" || Array.isArray(bh)) {
    return null;
  }

  const bhObj = bh as Record<string, unknown>;
  const rawTimezone = bhObj["timezone"];

  if (typeof rawTimezone !== "string" || rawTimezone.trim() === "") {
    return null;
  }

  // trim ก่อน validate — กัน tz ที่มีช่องว่าง (copy-paste/JSON import) ถูก Intl reject
  const timezone = rawTimezone.trim();

  // ตรวจว่า timezone ใช้งานได้จริงกับ Intl
  try {
    Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    return null;
  }

  const rawDays = bhObj["days"];
  if (!Array.isArray(rawDays)) {
    return null;
  }

  const days: BusinessHours["days"] = [];

  for (const entry of rawDays) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;

    if (!isWeekday(e["day"])) continue;
    if (!isValidTimeString(e["start"])) continue;
    if (!isValidTimeString(e["end"])) continue;

    // ตรวจว่า start < end (อย่างน้อย 1 นาที)
    const startMinutes = timeStringToMinutes(e["start"] as string);
    const endMinutes = timeStringToMinutes(e["end"] as string);
    if (endMinutes <= startMinutes) continue;

    days.push({ day: e["day"] as Weekday, start: e["start"] as string, end: e["end"] as string });
  }

  if (days.length === 0) {
    return null;
  }

  return { timezone, days };
}

// =============================================================================
// RESOLVE SLA MINUTES
// =============================================================================

/**
 * ดึงคู่ firstResponseMin + resolutionMin จาก policy row หรือ DEFAULT_SLA_MINUTES
 * ตาม priority ที่ระบุ
 */
export function resolveSlaMinutes(
  policy: SlaPolicyFields | null,
  priority: TicketPriority
): SlaMinutes {
  if (!policy) {
    return DEFAULT_SLA_MINUTES[priority];
  }

  // map priority → field pair ใน SlaPolicy
  switch (priority) {
    case "LOW":
      return {
        firstResponseMin: policy.firstResponseLowMin,
        resolutionMin: policy.resolutionLowMin,
      };
    case "NORMAL":
      return {
        firstResponseMin: policy.firstResponseNormMin,
        resolutionMin: policy.resolutionNormMin,
      };
    case "HIGH":
      return {
        firstResponseMin: policy.firstResponseHighMin,
        resolutionMin: policy.resolutionHighMin,
      };
    case "URGENT":
      return {
        firstResponseMin: policy.firstResponseUrgMin,
        resolutionMin: policy.resolutionUrgMin,
      };
  }
}

// =============================================================================
// BUSINESS HOURS HELPERS
// =============================================================================

/** แปลง "HH:MM" เป็นจำนวนนาทีนับจากเที่ยงคืน */
function timeStringToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** แปลง Date เป็น wall-clock components ใน timezone ที่กำหนด (ใช้ Intl) */
function getLocalComponents(
  date: Date,
  timezone: string
): { year: number; month: number; day: number; hour: number; minute: number; weekday: Weekday } {
  // Intl weekday: Sun=0, Mon=1, ..., Sat=6
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });

  const parts = fmt.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  const year = parseInt(get("year"), 10);
  const month = parseInt(get("month"), 10);
  const day = parseInt(get("day"), 10);

  // hour12: false → "24" แทน "00:00" เพื่อป้องกัน off-by-one ของ Intl
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0;

  const minute = parseInt(get("minute"), 10);

  // weekday short name ใน en-US: "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"
  const shortMap: Record<string, Weekday> = {
    Sun: "SUN", Mon: "MON", Tue: "TUE", Wed: "WED",
    Thu: "THU", Fri: "FRI", Sat: "SAT",
  };
  const weekday = shortMap[get("weekday")] ?? "MON";

  return { year, month, day, hour, minute, weekday };
}

/**
 * สร้าง Date ที่ wall-clock ของ timezone ตรงกับ year/month/day/hour/minute ที่กำหนด
 * ใช้ binary search หา UTC timestamp ที่สอดคล้องกัน
 * (ไม่ใช้ Date.UTC เพราะต้องคำนึงถึง DST offset ของแต่ละ timezone)
 */
function localToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): Date {
  // naive = ตีความ wall-clock ที่ต้องการเป็น UTC ก่อน
  const naiveMs = Date.UTC(year, month - 1, day, hour, minute, 0);

  // หา tz offset ณ ช่วงเวลานี้: ดูว่า naive (เมื่อมองใน tz) ได้ wall-clock เท่าไร
  // แล้วตีความ wall-clock นั้นกลับเป็น UTC ด้วย Date.UTC (รองรับปฏิทินจริง — ไม่สมมติเดือนละ 30 วัน)
  // offset = asUtcOfLocal - naiveMs = ระยะที่ tz นำหน้า/ตามหลัง UTC (มิลลิวินาที)
  const c = getLocalComponents(new Date(naiveMs), timezone);
  const asUtcOfLocal = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, 0);
  const offsetMs = asUtcOfLocal - naiveMs;

  // UTC ที่ wall-clock ใน tz ตรงกับ target = naiveMs - offset
  // หมายเหตุ: offset คิด ณ จุด naive — คลาดเคลื่อนได้ ±1 ชม. เฉพาะวินาทีที่เกิด DST transition พอดี (rare, ยอมรับได้)
  return new Date(naiveMs - offsetMs);
}

/**
 * หาเวลาเริ่ม business-hours ถัดไปใน timezone ที่กำหนด
 * ถ้า `from` อยู่ใน business window อยู่แล้ว คืน `from` เอง
 */
function findNextOpenTime(from: Date, bh: BusinessHours): Date | null {
  // สร้าง index วันเปิดเพื่อ lookup เร็ว
  const openDays = new Map<Weekday, { startMin: number; endMin: number }>();
  for (const d of bh.days) {
    openDays.set(d.day, {
      startMin: timeStringToMinutes(d.start),
      endMin: timeStringToMinutes(d.end),
    });
  }

  // วนหา open slot ใน 14 วัน (2 สัปดาห์) — ถ้าหาไม่เจอใน 14 วัน = closed all days (invalid config)
  const MAX_SEARCH_DAYS = 14;
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  for (let i = 0; i < MAX_SEARCH_DAYS; i++) {
    const candidate = new Date(from.getTime() + i * ONE_DAY_MS);
    const local = getLocalComponents(candidate, bh.timezone);
    const window = openDays.get(local.weekday);

    if (!window) continue; // วันหยุด

    const currentMinuteOfDay = local.hour * 60 + local.minute;

    if (i === 0) {
      // วันเดิม: อาจอยู่ใน window หรือก่อน window
      if (currentMinuteOfDay >= window.startMin && currentMinuteOfDay < window.endMin) {
        // อยู่ใน window แล้ว — คืน from เดิม
        return from;
      }
      if (currentMinuteOfDay < window.startMin) {
        // ก่อนเปิด — คืนเวลาเปิดวันนี้
        return localToUtc(
          local.year, local.month, local.day,
          Math.floor(window.startMin / 60), window.startMin % 60,
          bh.timezone
        );
      }
      // หลังปิดแล้ว — ลองวันถัดไป
      continue;
    }

    // วันถัดไป — คืนเวลาเปิด
    return localToUtc(
      local.year, local.month, local.day,
      Math.floor(window.startMin / 60), window.startMin % 60,
      bh.timezone
    );
  }

  return null; // ไม่มีวันเปิดใน 14 วัน
}


/**
 * หา business-hours end timestamp ของ window ที่ `from` อยู่
 * ถ้า `from` ไม่อยู่ใน window คืน null
 */
function currentWindowEnd(from: Date, bh: BusinessHours): Date | null {
  const openDays = new Map<Weekday, { startMin: number; endMin: number }>();
  for (const d of bh.days) {
    openDays.set(d.day, {
      startMin: timeStringToMinutes(d.start),
      endMin: timeStringToMinutes(d.end),
    });
  }

  const local = getLocalComponents(from, bh.timezone);
  const window = openDays.get(local.weekday);
  if (!window) return null;

  const currentMin = local.hour * 60 + local.minute;
  if (currentMin < window.startMin || currentMin >= window.endMin) return null;

  return localToUtc(
    local.year, local.month, local.day,
    Math.floor(window.endMin / 60), window.endMin % 60,
    bh.timezone
  );
}

// =============================================================================
// ADD BUSINESS MINUTES
// =============================================================================

/**
 * MAX_DAY_WALK_ITERATIONS — จำนวนวันสูงสุดที่ algorithm จะเดินไปหา open time
 *
 * ตั้งใจเผื่อสำหรับ tenant ที่มี business hours แบบ sparse (เช่น เปิดแค่ 1 วัน/สัปดาห์)
 * และ minutes ที่ต้องการมากพอ — 366 วันครอบคลุมได้ ~52 สัปดาห์ = 52 วันทำงาน × กะ 8 ชม.
 * = ≈ 24,960 นาที ซึ่งมากกว่า resolutionLowMin (2880 นาที) มาก
 *
 * ถ้าเกิน cap → fallback เป็น 24/7 arithmetic เพื่อไม่ให้ deadline = null
 */
const MAX_DAY_WALK_ITERATIONS = 366;

/**
 * เพิ่ม `minutes` ของ "เวลาทำการ" จาก `from`
 *
 * อัลกอริทึม:
 *   1. หา next open time (ถ้า `from` อยู่ใน window แล้ว ก็คือ `from` เอง)
 *   2. ดูว่า window ปัจจุบันเหลือกี่นาที
 *   3. ถ้า remaining >= minutes ที่เหลือ → ขยับ cursor ไป minutes ข้างหน้าใน window เดียวกัน
 *   4. ถ้า remaining < minutes → หัก minutes ออก remaining แล้วกระโดดไปวันทำการถัดไป (i++)
 *   5. loop จนหมด minutes
 *   6. Cap ที่ MAX_DAY_WALK_ITERATIONS — ถ้าเกิน fallback 24/7
 *
 * Timezone: ใช้ Intl.DateTimeFormat กับ timezone ของ tenant — ไม่สมมติ server TZ
 * Loop cap: MAX_DAY_WALK_ITERATIONS (366 วัน) กัน infinite loop เมื่อ config ผิด
 *
 * @param from     เวลาเริ่มต้น
 * @param minutes  จำนวนนาที "เวลาทำการ" ที่ต้องการเพิ่ม
 * @param bh       business hours config — null = 24/7 mode
 * @returns        เวลาปลาย deadline
 */
export function addBusinessMinutes(
  from: Date,
  minutes: number,
  bh: BusinessHours | null
): Date {
  // 24/7 mode — เพิ่มแบบ wall clock ธรรมดา
  if (!bh || minutes <= 0) {
    return new Date(from.getTime() + Math.max(0, minutes) * 60000);
  }

  // สร้าง index วันเปิด
  const openDays = new Map<Weekday, { startMin: number; endMin: number }>();
  for (const d of bh.days) {
    openDays.set(d.day, {
      startMin: timeStringToMinutes(d.start),
      endMin: timeStringToMinutes(d.end),
    });
  }

  // ถ้าไม่มีวันเปิดเลย → fallback 24/7
  if (openDays.size === 0) {
    console.warn("[sla] addBusinessMinutes: ไม่มีวันทำการที่ valid — fallback 24/7");
    return new Date(from.getTime() + minutes * 60000);
  }

  let cursor = from;
  let remaining = minutes;
  let iterations = 0;

  while (remaining > 0) {
    // ป้องกัน infinite loop — ถ้าวนเกิน cap → fallback 24/7 จาก cursor ปัจจุบัน
    if (iterations >= MAX_DAY_WALK_ITERATIONS) {
      console.warn(
        `[sla] addBusinessMinutes: เกิน loop cap (${MAX_DAY_WALK_ITERATIONS} วัน) — fallback 24/7 สำหรับ ${remaining} นาทีที่เหลือ`
      );
      return new Date(cursor.getTime() + remaining * 60000);
    }
    iterations++;

    // หา next open time จาก cursor ปัจจุบัน
    const openTime = findNextOpenTime(cursor, bh);
    if (!openTime) {
      // ไม่มีวันเปิดใน 14 วัน → fallback 24/7
      console.warn("[sla] addBusinessMinutes: ไม่พบ open window ใน 14 วัน — fallback 24/7");
      return new Date(cursor.getTime() + remaining * 60000);
    }

    // ถ้ากระโดดไปวันใหม่ → อัพเดท cursor เป็นต้น window
    if (openTime.getTime() > cursor.getTime()) {
      cursor = openTime;
    }

    // คำนวณ minutes ที่เหลือในวันนี้
    const windowEnd = currentWindowEnd(cursor, bh);
    if (!windowEnd) {
      // cursor ไม่อยู่ใน window — ไม่ควรเกิดเพราะ findNextOpenTime คืน cursor อยู่ใน window
      // แต่ป้องกันไว้ด้วยการเดินไปวันถัดไป
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
      continue;
    }

    const minutesAvailableInWindow = Math.floor(
      (windowEnd.getTime() - cursor.getTime()) / 60000
    );

    if (minutesAvailableInWindow >= remaining) {
      // ใช้ remaining หมดภายใน window นี้ → คืน timestamp
      return new Date(cursor.getTime() + remaining * 60000);
    }

    // ใช้ window หมดแล้วยัง remaining เหลืออยู่ → กระโดดไปต้นวันทำการถัดไป
    remaining -= minutesAvailableInWindow;
    // กระโดดไปหลัง window ปัจจุบัน (1 วินาทีหลัง end เพื่อออกจาก window)
    cursor = new Date(windowEnd.getTime() + 1000);
  }

  return cursor;
}

// =============================================================================
// COMPUTE DEADLINES
// =============================================================================

/**
 * คำนวณ firstResponseDueAt และ resolutionDueAt จาก startAt + priority + policy + business hours
 *
 * @param input.startAt       เวลาเริ่มนับ (ticket.createdAt)
 * @param input.priority      priority ของ ticket
 * @param input.policy        SlaPolicy row จาก DB (null = ใช้ DEFAULT_SLA_MINUTES)
 * @param input.businessHours business hours ของ tenant (null = 24/7)
 * @returns { firstResponseDueAt, resolutionDueAt }
 */
export function computeDeadlines(input: ComputeDeadlinesInput): {
  firstResponseDueAt: Date;
  resolutionDueAt: Date;
} {
  const { startAt, priority, policy, businessHours } = input;

  const { firstResponseMin, resolutionMin } = resolveSlaMinutes(policy, priority);

  return {
    firstResponseDueAt: addBusinessMinutes(startAt, firstResponseMin, businessHours),
    resolutionDueAt: addBusinessMinutes(startAt, resolutionMin, businessHours),
  };
}

// =============================================================================
// BUSINESS MINUTES BETWEEN
// =============================================================================

/**
 * คำนวณจำนวนนาที "เวลาทำการ" ระหว่างสองช่วงเวลา
 *
 * ใช้สำหรับวัดเวลา pause เพื่อ shift deadline เมื่อ resume
 * ถ้า a > b → คืน 0 (ป้องกัน negative pause duration)
 *
 * อัลกอริทึม: เดิน cursor จาก a ถึง b
 *   - รวมเฉพาะ open-time segments
 *   - กระโดดข้าม closed time/days
 *
 * 24/7 mode (bh = null): คืน wall-clock minutes
 *
 * @param a  start timestamp
 * @param b  end timestamp
 * @param bh business hours config — null = 24/7
 * @returns  open-time minutes between a and b
 */
export function businessMinutesBetween(
  a: Date,
  b: Date,
  bh: BusinessHours | null
): number {
  if (a.getTime() >= b.getTime()) return 0;

  // 24/7 mode
  if (!bh) {
    return Math.floor((b.getTime() - a.getTime()) / 60000);
  }

  // สร้าง index วันเปิด
  const openDays = new Map<Weekday, { startMin: number; endMin: number }>();
  for (const d of bh.days) {
    openDays.set(d.day, {
      startMin: timeStringToMinutes(d.start),
      endMin: timeStringToMinutes(d.end),
    });
  }

  if (openDays.size === 0) {
    return Math.floor((b.getTime() - a.getTime()) / 60000);
  }

  let totalMinutes = 0;
  let cursor = a;
  let iterations = 0;

  while (cursor.getTime() < b.getTime()) {
    if (iterations >= MAX_DAY_WALK_ITERATIONS) {
      // cap ถึง — fallback: นับเป็น wall-clock ที่เหลือ
      totalMinutes += Math.floor((b.getTime() - cursor.getTime()) / 60000);
      break;
    }
    iterations++;

    const openTime = findNextOpenTime(cursor, bh);
    if (!openTime) {
      // ไม่มี window → หยุด
      break;
    }

    if (openTime.getTime() > b.getTime()) {
      // next open time อยู่หลัง b → ไม่มี open segment ในช่วงที่เหลือ
      break;
    }

    // ถ้ากระโดดไปวันใหม่
    if (openTime.getTime() > cursor.getTime()) {
      cursor = openTime;
    }

    // หา window end
    const windowEnd = currentWindowEnd(cursor, bh);
    if (!windowEnd) {
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
      continue;
    }

    // คำนวณ segment ที่ทับกับ [cursor, b]
    const segEnd = windowEnd.getTime() < b.getTime() ? windowEnd : b;
    const segMinutes = Math.floor((segEnd.getTime() - cursor.getTime()) / 60000);
    totalMinutes += Math.max(0, segMinutes);

    if (segEnd.getTime() >= b.getTime()) break;

    // กระโดดไปหลัง window (1 วินาทีหลัง end)
    cursor = new Date(windowEnd.getTime() + 1000);
  }

  return totalMinutes;
}
