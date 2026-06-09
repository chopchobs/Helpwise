/**
 * src/lib/__tests__/sla.test.ts
 * Unit tests สำหรับ SLA Engine — pure business logic
 * ไม่มี DB, network, prisma mock — test ล้วน ๆ
 */

import { describe, it, expect } from "vitest";
import {
  parseBusinessHours,
  resolveSlaMinutes,
  addBusinessMinutes,
  computeDeadlines,
  businessMinutesBetween,
  DEFAULT_SLA_MINUTES,
  type BusinessHours,
  type SlaPolicyFields,
} from "@/lib/sla";

// =============================================================================
// HELPERS
// =============================================================================

/** สร้าง Date UTC ที่แน่นอน — กันพฤติกรรมต่างกันตาม server TZ */
function utcDate(
  year: number,
  month: number, // 1-based
  day: number,
  hour = 0,
  minute = 0,
  second = 0
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second));
}

/** BusinessHours สำหรับ Asia/Bangkok, จันทร์–ศุกร์ 09:00–17:00 */
const bkkWeekdayHours: BusinessHours = {
  timezone: "Asia/Bangkok",
  days: [
    { day: "MON", start: "09:00", end: "17:00" },
    { day: "TUE", start: "09:00", end: "17:00" },
    { day: "WED", start: "09:00", end: "17:00" },
    { day: "THU", start: "09:00", end: "17:00" },
    { day: "FRI", start: "09:00", end: "17:00" },
  ],
};

/** SlaPolicyFields ตัวอย่างที่ใช้ค่าชัดเจน */
const samplePolicy: SlaPolicyFields = {
  firstResponseLowMin: 600,
  firstResponseNormMin: 300,
  firstResponseHighMin: 90,
  firstResponseUrgMin: 20,
  resolutionLowMin: 3000,
  resolutionNormMin: 1500,
  resolutionHighMin: 600,
  resolutionUrgMin: 150,
};

// =============================================================================
// A.1 — parseBusinessHours
// =============================================================================

describe("parseBusinessHours", () => {
  // --- null / non-object / array input ---

  it("คืน null เมื่อรับ null", () => {
    expect(parseBusinessHours(null)).toBeNull();
  });

  it("คืน null เมื่อรับ undefined", () => {
    expect(parseBusinessHours(undefined)).toBeNull();
  });

  it("คืน null เมื่อรับ string", () => {
    expect(parseBusinessHours("Asia/Bangkok")).toBeNull();
  });

  it("คืน null เมื่อรับ number", () => {
    expect(parseBusinessHours(42)).toBeNull();
  });

  it("คืน null เมื่อรับ array", () => {
    expect(parseBusinessHours([])).toBeNull();
  });

  it("คืน null เมื่อ object ไม่มี businessHours key", () => {
    expect(parseBusinessHours({ foo: "bar" })).toBeNull();
  });

  it("คืน null เมื่อ businessHours เป็น null", () => {
    expect(parseBusinessHours({ businessHours: null })).toBeNull();
  });

  it("คืน null เมื่อ businessHours เป็น string", () => {
    expect(parseBusinessHours({ businessHours: "09:00-17:00" })).toBeNull();
  });

  it("คืน null เมื่อ businessHours เป็น array", () => {
    expect(parseBusinessHours({ businessHours: [] })).toBeNull();
  });

  // --- timezone validation ---

  it("คืน null เมื่อ timezone ไม่ใช่ string", () => {
    expect(
      parseBusinessHours({
        businessHours: {
          timezone: 42,
          days: [{ day: "MON", start: "09:00", end: "17:00" }],
        },
      })
    ).toBeNull();
  });

  it("คืน null เมื่อ timezone เป็น empty string", () => {
    expect(
      parseBusinessHours({
        businessHours: {
          timezone: "",
          days: [{ day: "MON", start: "09:00", end: "17:00" }],
        },
      })
    ).toBeNull();
  });

  it("คืน null เมื่อ timezone เป็น whitespace", () => {
    expect(
      parseBusinessHours({
        businessHours: {
          timezone: "   ",
          days: [{ day: "MON", start: "09:00", end: "17:00" }],
        },
      })
    ).toBeNull();
  });

  it("คืน null เมื่อ timezone ไม่รู้จัก (Intl reject)", () => {
    expect(
      parseBusinessHours({
        businessHours: {
          timezone: "Invalid/Zone",
          days: [{ day: "MON", start: "09:00", end: "17:00" }],
        },
      })
    ).toBeNull();
  });

  // --- days validation ---

  it("คืน null เมื่อ days ไม่ใช่ array", () => {
    expect(
      parseBusinessHours({
        businessHours: { timezone: "Asia/Bangkok", days: "MON" },
      })
    ).toBeNull();
  });

  it("คืน null เมื่อ days เป็น array ว่าง", () => {
    expect(
      parseBusinessHours({
        businessHours: { timezone: "Asia/Bangkok", days: [] },
      })
    ).toBeNull();
  });

  it("คืน null เมื่อ days มีแต่ entry ที่ invalid ทั้งหมด (weekday ผิด)", () => {
    expect(
      parseBusinessHours({
        businessHours: {
          timezone: "Asia/Bangkok",
          days: [{ day: "MONDAY", start: "09:00", end: "17:00" }],
        },
      })
    ).toBeNull();
  });

  it("กรอง entry ที่มี invalid start time ออก (25:00)", () => {
    // มี 1 entry valid + 1 invalid → result มีแค่ valid
    const result = parseBusinessHours({
      businessHours: {
        timezone: "Asia/Bangkok",
        days: [
          { day: "MON", start: "09:00", end: "17:00" }, // valid
          { day: "TUE", start: "25:00", end: "17:00" }, // invalid start
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.days).toHaveLength(1);
    expect(result!.days[0].day).toBe("MON");
  });

  it("กรอง entry ที่มี invalid end time ออก (9:5 — ไม่ match regex)", () => {
    const result = parseBusinessHours({
      businessHours: {
        timezone: "Asia/Bangkok",
        days: [
          { day: "MON", start: "09:00", end: "17:00" }, // valid
          { day: "TUE", start: "09:00", end: "9:5" }, // invalid end
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.days).toHaveLength(1);
  });

  it("กรอง entry ที่ end <= start ออก (start == end)", () => {
    const result = parseBusinessHours({
      businessHours: {
        timezone: "Asia/Bangkok",
        days: [
          { day: "MON", start: "09:00", end: "17:00" }, // valid
          { day: "TUE", start: "09:00", end: "09:00" }, // end == start → invalid
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.days).toHaveLength(1);
  });

  it("กรอง entry ที่ end < start ออก", () => {
    const result = parseBusinessHours({
      businessHours: {
        timezone: "Asia/Bangkok",
        days: [
          { day: "MON", start: "09:00", end: "17:00" }, // valid
          { day: "TUE", start: "17:00", end: "09:00" }, // end < start → invalid
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.days).toHaveLength(1);
  });

  it("กรอง entry ที่ start เป็น non-string ออก", () => {
    const result = parseBusinessHours({
      businessHours: {
        timezone: "Asia/Bangkok",
        days: [
          { day: "MON", start: "09:00", end: "17:00" },
          { day: "TUE", start: 900, end: "17:00" }, // start ไม่ใช่ string
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.days).toHaveLength(1);
  });

  it("คืน null เมื่อทุก entry invalid (หลังกรอง days ว่างเปล่า)", () => {
    expect(
      parseBusinessHours({
        businessHours: {
          timezone: "Asia/Bangkok",
          days: [
            { day: "INVALID", start: "09:00", end: "17:00" },
            { day: "MON", start: "25:00", end: "17:00" },
          ],
        },
      })
    ).toBeNull();
  });

  // --- valid input ---

  it("parse valid input คืน BusinessHours ที่ถูกต้อง", () => {
    const result = parseBusinessHours({
      businessHours: {
        timezone: "Asia/Bangkok",
        days: [
          { day: "MON", start: "09:00", end: "17:00" },
          { day: "FRI", start: "08:00", end: "18:00" },
        ],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.timezone).toBe("Asia/Bangkok");
    expect(result!.days).toHaveLength(2);
    expect(result!.days[0]).toEqual({ day: "MON", start: "09:00", end: "17:00" });
    expect(result!.days[1]).toEqual({ day: "FRI", start: "08:00", end: "18:00" });
  });

  it("trim timezone ที่มี leading/trailing whitespace ก่อน validate (regression)", () => {
    // เคยเป็น bug: Intl.DateTimeFormat validate ก่อน trim → tz ที่มีช่องว่างถูก reject เป็น null
    // fix แล้ว: trim ก่อน Intl check → ควรคืน object โดย timezone ถูก trim
    const result = parseBusinessHours({
      businessHours: {
        timezone: "  America/New_York  ",
        days: [{ day: "MON", start: "09:00", end: "17:00" }],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.timezone).toBe("America/New_York");
  });

  it("ยอมรับ timezone UTC", () => {
    const result = parseBusinessHours({
      businessHours: {
        timezone: "UTC",
        days: [{ day: "WED", start: "00:00", end: "23:59" }],
      },
    });
    expect(result).not.toBeNull();
    expect(result!.timezone).toBe("UTC");
  });
});

// =============================================================================
// A.2 — resolveSlaMinutes
// =============================================================================

describe("resolveSlaMinutes", () => {
  describe("policy = null → ใช้ DEFAULT_SLA_MINUTES", () => {
    it("LOW → 480 / 2880", () => {
      const r = resolveSlaMinutes(null, "LOW");
      expect(r.firstResponseMin).toBe(480);
      expect(r.resolutionMin).toBe(2880);
    });

    it("NORMAL → 240 / 1440", () => {
      const r = resolveSlaMinutes(null, "NORMAL");
      expect(r.firstResponseMin).toBe(240);
      expect(r.resolutionMin).toBe(1440);
    });

    it("HIGH → 60 / 480", () => {
      const r = resolveSlaMinutes(null, "HIGH");
      expect(r.firstResponseMin).toBe(60);
      expect(r.resolutionMin).toBe(480);
    });

    it("URGENT → 15 / 120", () => {
      const r = resolveSlaMinutes(null, "URGENT");
      expect(r.firstResponseMin).toBe(15);
      expect(r.resolutionMin).toBe(120);
    });
  });

  describe("policy มีค่า → ใช้ field ของ policy", () => {
    it("LOW → firstResponseLowMin / resolutionLowMin", () => {
      const r = resolveSlaMinutes(samplePolicy, "LOW");
      expect(r.firstResponseMin).toBe(samplePolicy.firstResponseLowMin);
      expect(r.resolutionMin).toBe(samplePolicy.resolutionLowMin);
    });

    it("NORMAL → firstResponseNormMin / resolutionNormMin", () => {
      const r = resolveSlaMinutes(samplePolicy, "NORMAL");
      expect(r.firstResponseMin).toBe(samplePolicy.firstResponseNormMin);
      expect(r.resolutionMin).toBe(samplePolicy.resolutionNormMin);
    });

    it("HIGH → firstResponseHighMin / resolutionHighMin", () => {
      const r = resolveSlaMinutes(samplePolicy, "HIGH");
      expect(r.firstResponseMin).toBe(samplePolicy.firstResponseHighMin);
      expect(r.resolutionMin).toBe(samplePolicy.resolutionHighMin);
    });

    it("URGENT → firstResponseUrgMin / resolutionUrgMin", () => {
      const r = resolveSlaMinutes(samplePolicy, "URGENT");
      expect(r.firstResponseMin).toBe(samplePolicy.firstResponseUrgMin);
      expect(r.resolutionMin).toBe(samplePolicy.resolutionUrgMin);
    });
  });
});

// =============================================================================
// A.3 — DEFAULT_SLA_MINUTES constant sanity
// =============================================================================

describe("DEFAULT_SLA_MINUTES constant", () => {
  it("LOW = 480 / 2880 (8 ชม. / 48 ชม.)", () => {
    expect(DEFAULT_SLA_MINUTES.LOW.firstResponseMin).toBe(480);
    expect(DEFAULT_SLA_MINUTES.LOW.resolutionMin).toBe(2880);
  });

  it("NORMAL = 240 / 1440 (4 ชม. / 24 ชม.)", () => {
    expect(DEFAULT_SLA_MINUTES.NORMAL.firstResponseMin).toBe(240);
    expect(DEFAULT_SLA_MINUTES.NORMAL.resolutionMin).toBe(1440);
  });

  it("HIGH = 60 / 480 (1 ชม. / 8 ชม.)", () => {
    expect(DEFAULT_SLA_MINUTES.HIGH.firstResponseMin).toBe(60);
    expect(DEFAULT_SLA_MINUTES.HIGH.resolutionMin).toBe(480);
  });

  it("URGENT = 15 / 120 (15 น. / 2 ชม.)", () => {
    expect(DEFAULT_SLA_MINUTES.URGENT.firstResponseMin).toBe(15);
    expect(DEFAULT_SLA_MINUTES.URGENT.resolutionMin).toBe(120);
  });
});

// =============================================================================
// A.4 — addBusinessMinutes
// =============================================================================

describe("addBusinessMinutes", () => {
  // --- 24/7 mode (bh = null) ---

  it("bh=null: เพิ่ม 60 นาทีแบบ wall-clock", () => {
    const start = utcDate(2025, 6, 9, 10, 0); // จันทร์ 09:00 Bangkok (UTC+7 → UTC 02:00; แต่เราใช้ UTC 10:00)
    const result = addBusinessMinutes(start, 60, null);
    expect(result.getTime()).toBe(start.getTime() + 60 * 60_000);
  });

  it("bh=null: minutes=0 คืน from เดิม", () => {
    const start = utcDate(2025, 6, 9, 10, 0);
    const result = addBusinessMinutes(start, 0, null);
    expect(result.getTime()).toBe(start.getTime());
  });

  it("bh=null: minutes ติดลบ → clamped to 0 (คืน from เดิม)", () => {
    // source code: Math.max(0, minutes) * 60000
    const start = utcDate(2025, 6, 9, 10, 0);
    const result = addBusinessMinutes(start, -30, null);
    expect(result.getTime()).toBe(start.getTime());
  });

  // --- Business hours mode ---
  // ใช้ timezone Asia/Bangkok (UTC+7)
  // เพื่อ test จาก UTC ต้องรู้ว่า: UTC+7 = local time; เช่น UTC 02:00 = Bangkok 09:00

  it("อยู่ใน window แล้ว + minutes พอดีอยู่ภายใน window เดียวกัน", () => {
    // Bangkok 09:00 = UTC 02:00 (วันจันทร์ 2025-06-09)
    const start = utcDate(2025, 6, 9, 2, 0); // Bangkok Mon 09:00
    // เพิ่ม 120 นาที → Bangkok 11:00 = UTC 04:00
    const result = addBusinessMinutes(start, 120, bkkWeekdayHours);
    expect(result.getTime()).toBe(utcDate(2025, 6, 9, 4, 0).getTime());
  });

  it("minutes=0 กับ business hours → คืน from เดิม", () => {
    const start = utcDate(2025, 6, 9, 2, 0); // Bangkok Mon 09:00
    const result = addBusinessMinutes(start, 0, bkkWeekdayHours);
    expect(result.getTime()).toBe(start.getTime());
  });

  it("เริ่มก่อนเวลาทำการ (ก่อน 09:00 Bangkok) → เริ่มนับจาก 09:00 ของวันนั้น", () => {
    // Bangkok Mon 07:00 = UTC Mon 00:00
    const start = utcDate(2025, 6, 9, 0, 0); // UTC Mon 00:00 = Bangkok Mon 07:00
    // เพิ่ม 30 นาที → นับจาก Bangkok 09:00 → Bangkok 09:30 = UTC 02:30
    const result = addBusinessMinutes(start, 30, bkkWeekdayHours);
    expect(result.getTime()).toBe(utcDate(2025, 6, 9, 2, 30).getTime());
  });

  it("ข้าม day boundary: ถ้าเริ่มช้า remaining넘ชน window end → ไปวันถัดไป", () => {
    // Bangkok Mon 16:00 = UTC Mon 09:00 — เหลือใน window = 60 นาที
    const start = utcDate(2025, 6, 9, 9, 0); // Bangkok Mon 16:00
    // ต้องการ 120 นาที → 60 วันนี้ + 60 นาทีวันพรุ่ง (Tue 09:00→10:00) = Bangkok Tue 10:00 = UTC Tue 03:00
    const result = addBusinessMinutes(start, 120, bkkWeekdayHours);
    expect(result.getTime()).toBe(utcDate(2025, 6, 10, 3, 0).getTime());
  });

  it("ข้าม weekend: ถ้า Friday end → Monday start ถัดไป", () => {
    // Bangkok Fri 16:30 = UTC Fri 09:30 — เหลือ 30 นาทีในวัน
    const start = utcDate(2025, 6, 13, 9, 30); // Fri (2025-06-13) UTC 09:30 = Bangkok 16:30
    // ต้องการ 90 นาที → 30 นาที Fri + 60 นาที Mon = Bangkok Mon 10:00 = UTC Mon 03:00
    const result = addBusinessMinutes(start, 90, bkkWeekdayHours);
    expect(result.getTime()).toBe(utcDate(2025, 6, 16, 3, 0).getTime());
  });

  it("เริ่มหลังเวลาทำการ (หลัง 17:00 Bangkok) → เริ่มนับ window วันถัดไป", () => {
    // Bangkok Mon 18:00 = UTC Mon 11:00
    const start = utcDate(2025, 6, 9, 11, 0); // Bangkok Mon 18:00
    // เพิ่ม 30 นาที → Bangkok Tue 09:30 = UTC Tue 02:30
    const result = addBusinessMinutes(start, 30, bkkWeekdayHours);
    expect(result.getTime()).toBe(utcDate(2025, 6, 10, 2, 30).getTime());
  });

  it("เริ่มวันเสาร์ → เริ่มนับ Monday", () => {
    // Bangkok Sat 10:00 = UTC Sat 03:00 (2025-06-14)
    const start = utcDate(2025, 6, 14, 3, 0);
    // เพิ่ม 60 นาที → Bangkok Mon 09:00 + 60 → Bangkok Mon 10:00 = UTC Mon 03:00
    const result = addBusinessMinutes(start, 60, bkkWeekdayHours);
    expect(result.getTime()).toBe(utcDate(2025, 6, 16, 3, 0).getTime());
  });

  it("เพิ่ม 480 นาที (8 ชม.) จากต้น window จันทร์ → จันทร์ 17:00 (ใช้ window เต็ม + ล้น→อังคาร)", () => {
    // Bangkok Mon 09:00 = UTC Mon 02:00
    // window จันทร์ = 480 นาที; 480 พอดี window → ผลคือ Bangkok Mon 17:00 = UTC Mon 10:00
    const start = utcDate(2025, 6, 9, 2, 0);
    const result = addBusinessMinutes(start, 480, bkkWeekdayHours);
    expect(result.getTime()).toBe(utcDate(2025, 6, 9, 10, 0).getTime()); // Bangkok Mon 17:00
  });
});

// =============================================================================
// A.5 — computeDeadlines
// =============================================================================

describe("computeDeadlines", () => {
  it("null policy + null businessHours → 24/7 arithmetic ด้วย DEFAULT values", () => {
    const startAt = utcDate(2025, 6, 9, 2, 0);
    const result = computeDeadlines({
      startAt,
      priority: "NORMAL",
      policy: null,
      businessHours: null,
    });
    // NORMAL default: firstResponse=240, resolution=1440
    expect(result.firstResponseDueAt.getTime()).toBe(
      startAt.getTime() + 240 * 60_000
    );
    expect(result.resolutionDueAt.getTime()).toBe(
      startAt.getTime() + 1440 * 60_000
    );
  });

  it("policy มีค่า + null businessHours → ใช้ policy minutes แบบ 24/7", () => {
    const startAt = utcDate(2025, 6, 9, 2, 0);
    const result = computeDeadlines({
      startAt,
      priority: "URGENT",
      policy: samplePolicy,
      businessHours: null,
    });
    expect(result.firstResponseDueAt.getTime()).toBe(
      startAt.getTime() + samplePolicy.firstResponseUrgMin * 60_000
    );
    expect(result.resolutionDueAt.getTime()).toBe(
      startAt.getTime() + samplePolicy.resolutionUrgMin * 60_000
    );
  });

  it("null policy + businessHours → ใช้ DEFAULT minutes ผ่าน business hours engine", () => {
    // URGENT default: firstResponse=15, resolution=120
    // Bangkok Mon 09:00 = UTC Mon 02:00
    const startAt = utcDate(2025, 6, 9, 2, 0);
    const result = computeDeadlines({
      startAt,
      priority: "URGENT",
      policy: null,
      businessHours: bkkWeekdayHours,
    });
    // 15 นาทีใน window → Bangkok 09:15 = UTC 02:15
    expect(result.firstResponseDueAt.getTime()).toBe(
      utcDate(2025, 6, 9, 2, 15).getTime()
    );
    // 120 นาทีใน window → Bangkok 11:00 = UTC 04:00
    expect(result.resolutionDueAt.getTime()).toBe(
      utcDate(2025, 6, 9, 4, 0).getTime()
    );
  });

  it("firstResponseDueAt ต้องมาก่อน resolutionDueAt เสมอสำหรับทุก priority", () => {
    const startAt = utcDate(2025, 6, 9, 2, 0);
    for (const priority of ["LOW", "NORMAL", "HIGH", "URGENT"] as const) {
      const result = computeDeadlines({
        startAt,
        priority,
        policy: null,
        businessHours: null,
      });
      expect(result.firstResponseDueAt.getTime()).toBeLessThan(
        result.resolutionDueAt.getTime()
      );
    }
  });
});

// =============================================================================
// A.6 — businessMinutesBetween
// =============================================================================

describe("businessMinutesBetween", () => {
  it("a === b → คืน 0", () => {
    const t = utcDate(2025, 6, 9, 2, 0);
    expect(businessMinutesBetween(t, t, null)).toBe(0);
  });

  it("a > b → คืน 0 (ป้องกัน negative)", () => {
    const a = utcDate(2025, 6, 9, 3, 0);
    const b = utcDate(2025, 6, 9, 2, 0);
    expect(businessMinutesBetween(a, b, null)).toBe(0);
  });

  it("bh=null: นับ wall-clock minutes ระหว่าง a-b", () => {
    const a = utcDate(2025, 6, 9, 2, 0);
    const b = utcDate(2025, 6, 9, 4, 30);
    expect(businessMinutesBetween(a, b, null)).toBe(150);
  });

  it("ช่วงเดียวกัน window: นับเฉพาะ open time", () => {
    // Bangkok Mon 09:00–11:00 = UTC 02:00–04:00 = 120 นาที
    const a = utcDate(2025, 6, 9, 2, 0); // Bangkok Mon 09:00
    const b = utcDate(2025, 6, 9, 4, 0); // Bangkok Mon 11:00
    expect(businessMinutesBetween(a, b, bkkWeekdayHours)).toBe(120);
  });

  it("ข้าม closed day: นับเฉพาะ open segments ไม่นับ weekend", () => {
    // Bangkok Fri 16:00 = UTC 09:00 → Fri window 16:00–17:00 = 60 นาที
    // Bangkok Mon 09:00 = UTC Mon 02:00 → Mon window 09:00–10:00 = 60 นาที
    // รวม = 120 นาที (เสาร์–อาทิตย์ = 0)
    const a = utcDate(2025, 6, 13, 9, 0); // Fri Bangkok 16:00
    const b = utcDate(2025, 6, 16, 3, 0); // Mon Bangkok 10:00
    expect(businessMinutesBetween(a, b, bkkWeekdayHours)).toBe(120);
  });

  it("a อยู่นอก window (ก่อนเปิด) → นับตั้งแต่เวลาเปิดเท่านั้น", () => {
    // Bangkok Mon 07:00 = UTC Mon 00:00 (ก่อนเปิด 09:00)
    // b = Bangkok Mon 10:00 = UTC 03:00 → open segment = 09:00–10:00 = 60 นาที
    const a = utcDate(2025, 6, 9, 0, 0);
    const b = utcDate(2025, 6, 9, 3, 0);
    expect(businessMinutesBetween(a, b, bkkWeekdayHours)).toBe(60);
  });

  it("b อยู่ก่อนวันทำการถัดไป → คืน 0", () => {
    // Bangkok Mon 17:30 = UTC Mon 10:30 (หลังปิด)
    // b = Bangkok Mon 20:00 = UTC Mon 13:00 → ไม่มี open segment
    const a = utcDate(2025, 6, 9, 10, 30);
    const b = utcDate(2025, 6, 9, 13, 0);
    expect(businessMinutesBetween(a, b, bkkWeekdayHours)).toBe(0);
  });
});
