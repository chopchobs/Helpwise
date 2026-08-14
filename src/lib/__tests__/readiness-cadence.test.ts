/**
 * src/lib/__tests__/readiness-cadence.test.ts
 * Phase 39 — invariant ของ **คาบ** (erratum §G ข้อ 13 · §H-11)
 *
 * ทำไมต้องมีไฟล์นี้: เกณฑ์ `stale` ของ mechanism ถูกคำนวณจาก "คาบที่คาด" × tolerance
 * ถ้าคาบที่คาด **สั้นกว่าคาบจริง** เกณฑ์จะตั้งชนกับความเป็นจริง ⇒ ระบบ flag ตัวเองว่าค้าง
 * ทั้งที่ทำงานปกติ ⇒ **flap** ⇒ transition-only ยิงทุกครั้งที่พลิก = alert fatigue
 * ซึ่งเป็นความเสียหายที่ทั้งเฟสนี้สร้างมาเพื่อกัน
 *
 * ของจริงที่เกิดมาแล้ว: `readiness-probe` ถูกตั้งเป็น 300 (= min-interval ของ live probe)
 * ทั้งที่ตัวที่ทำให้มันเต้นคือ cron ทุก 15 นาที ⇒ เกณฑ์ 900s = คาบจริง 900s ⇒ margin = 0
 *
 * ⚠️ test พวกนี้ยึดกับ **เหตุผล** ไม่ใช่ตัวเลข — เปลี่ยนคาบ cron ได้ แต่ความสัมพันธ์ต้องคงอยู่
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MECHANISMS, STALE_TOLERANCE_FACTOR } from "@/lib/heartbeat";
import { CRON_INTERVAL_MINUTES } from "@/lib/readiness-verdict";

describe("cadence invariant — คาบที่คาดต้องไม่สั้นกว่าคาบจริงของ scheduler", () => {
  it("`readiness-probe`: คาบที่คาด ≥ คาบของ cron ที่ทำให้มันเต้น", () => {
    // 🔑 นี่คือ invariant ตัวจริง — ไม่ใช่ "ต้องเท่ากับ 900"
    //    P2 เต้น heartbeat ของตัวเองใน `runLiveProbe()` ซึ่งเกิดเมื่อ cron มาเรียกเท่านั้น
    //    ⇒ คาบการเต้นถูกกำหนดโดย cron ไม่ใช่โดยตัวมันเอง
    expect(MECHANISMS["readiness-probe"].intervalSeconds).toBeGreaterThanOrEqual(
      CRON_INTERVAL_MINUTES * 60
    );
  });

  it("ทุก mechanism ที่มีคาบ ต้องมี margin ก่อนถูกตัดสินว่า stale (tolerance > 1)", () => {
    // margin = 1.0 แปลว่า "ช้ากว่ากำหนดหนึ่งวินาที = ประกาศว่าค้าง" ⇒ ไม่มีทางไม่ flap
    expect(STALE_TOLERANCE_FACTOR).toBeGreaterThan(1);
  });

  it("`readiness-probe` ต้องทนการที่ cron พลาดได้อย่างน้อย 2 รอบก่อนประกาศ stale", () => {
    // เหตุผลของตัวเลข 2: GitHub scheduled workflow **มาสายเป็นปกติ** (ไม่ใช่ความผิดปกติ)
    // ⇒ ต้องทนความสายได้มากกว่าหนึ่งคาบ ไม่งั้นความสายธรรมดากลายเป็นสัญญาณเตือน
    const staleAfterSeconds =
      (MECHANISMS["readiness-probe"].intervalSeconds as number) * STALE_TOLERANCE_FACTOR;
    const missedRunsTolerated = staleAfterSeconds / (CRON_INTERVAL_MINUTES * 60);
    expect(missedRunsTolerated).toBeGreaterThanOrEqual(2);
  });

  it("heartbeat ต้องดัง **ทีหลัง** in-band gap check (สัญญาณเจาะจงกว่าต้องดังก่อน)", () => {
    // `detectGap()` ออกแบบมาเพื่อจับ "cron หาย" โดยเฉพาะ ⇒ ควรเป็นตัวที่พูดก่อน
    // heartbeat เป็น backstop ⇒ ถ้ามันดังก่อน ลำดับการวินิจฉัยจะกลับหัว
    // (detectGap เตือนเมื่อ missedRuns ≥ 1 คือห่าง ≥ 2 คาบ)
    const gapAlertSeconds = CRON_INTERVAL_MINUTES * 60 * 2;
    const heartbeatAlertSeconds =
      (MECHANISMS["readiness-probe"].intervalSeconds as number) * STALE_TOLERANCE_FACTOR;
    expect(heartbeatAlertSeconds).toBeGreaterThan(gapAlertSeconds);
  });
});

describe("สนามที่สาม — `cron:` ใน workflow ผูกด้วย import ไม่ได้ จึงต้องเทียบด้วย test", () => {
  // ⚠️ ข้อนี้คือรูที่ทำให้เกิด §G ข้อ 13: ค่าเดียวกันถูกคัดลอกไว้หลายที่โดยไม่มีอะไรผูก
  //    การเว้นสนามนี้ไว้ทั้งที่รู้ = ปล่อยรูรูปแบบเดิมที่เพิ่งกัดเราไว้เฉย ๆ
  const WORKFLOW_PATH = ".github/workflows/readiness.yml";

  /**
   * derive **คาบเป็นนาที** จากช่อง minute ของ cron 5 ฟิลด์ที่ชั่วโมงเป็น `*`
   *
   * รองรับสามรูปแบบ (ขยายจากรูปแบบ step เดิม เมื่อ 2026-08-14 ตอนเปลี่ยนเป็นรายชั่วโมง):
   *   step  `<star><slash>n * * * *`  ⇒ ทุก n นาที
   *   `<m> * * * *`        ⇒ รายชั่วโมง = 60 นาที
   *   `<a>,<b>,… * * * *`  ⇒ comma-list · **ต้องห่างเท่ากันทุกช่วง** (รวมช่วงข้ามชั่วโมง)
   *                          ไม่งั้นคำว่า "คาบ" ไม่มีความหมาย ⇒ คืน `null` ให้ test แดง
   * ⇒ คืน `null` เมื่ออ่านไม่ออก — **ห้ามเดา** (เดาแล้วเงียบ = รูเดิมของ §G ข้อ 13)
   */
  function cronIntervalMinutes(expr: string): number | null {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return null;
    const [minute, hour, dom, mon, dow] = fields;
    // ขอบเขตของ helper นี้: เฉพาะตารางที่ "ทุกชั่วโมง ทุกวัน" — นอกนั้นอ่านไม่ออก ให้แดง
    if (hour !== "*" || dom !== "*" || mon !== "*" || dow !== "*") return null;

    const stepped = minute.match(/^\*\/(\d+)$/);
    if (stepped) return Number(stepped[1]);

    if (/^\d+$/.test(minute)) return 60; // นาทีเดียวต่อชั่วโมง = รายชั่วโมง

    if (/^\d+(,\d+)+$/.test(minute)) {
      const mins = minute.split(",").map(Number).sort((a, b) => a - b);
      const deltas: number[] = [];
      for (let i = 1; i < mins.length; i++) deltas.push(mins[i] - mins[i - 1]);
      deltas.push(60 - mins[mins.length - 1] + mins[0]); // ช่วงข้ามชั่วโมง
      return deltas.every((d) => d === deltas[0]) ? deltas[0] : null;
    }
    return null;
  }

  it("helper อ่านคาบจาก cron expression ได้ถูกต้อง (เส้นทางบวกและลบ)", () => {
    // 🔑 helper ที่ test พึ่งพา ต้องมี test ของตัวเอง — ไม่งั้น test ข้างล่างอาจเขียว
    //    เพราะ helper อ่านผิดในทางที่บังเอิญตรงกับค่าคงที่
    expect(cronIntervalMinutes("*/15 * * * *")).toBe(15);
    expect(cronIntervalMinutes("0 * * * *")).toBe(60);
    expect(cronIntervalMinutes("37 * * * *")).toBe(60);
    expect(cronIntervalMinutes("7,22,37,52 * * * *")).toBe(15);
    // เส้นทางลบ — ต้องคืน null ไม่ใช่เดา
    expect(cronIntervalMinutes("0,10 * * * *")).toBeNull(); // ห่างไม่เท่ากัน (10 กับ 50)
    expect(cronIntervalMinutes("0 3 * * *")).toBeNull(); // ไม่ใช่ทุกชั่วโมง
    expect(cronIntervalMinutes("0 * * *")).toBeNull(); // ฟิลด์ไม่ครบ
    expect(cronIntervalMinutes("* * * * *")).toBeNull(); // ทุกนาที — ไม่ใช่รูปแบบที่รองรับ
  });

  it(`schedule ใน ${WORKFLOW_PATH} ตรงกับ CRON_INTERVAL_MINUTES`, () => {
    const yml = readFileSync(WORKFLOW_PATH, "utf8");

    // จับ **เนื้อใน quote** ของบรรทัด cron แล้วค่อย parse — ไม่ผูก test กับรูปแบบใดรูปแบบหนึ่ง
    const match = yml.match(/cron:\s*["']([^"']+)["']/);
    expect(
      match,
      `อ่าน cron จาก ${WORKFLOW_PATH} ไม่ได้ — ถ้าเปลี่ยนรูปแบบ schedule ต้องแก้ test นี้ด้วย ห้ามลบทิ้ง`
    ).not.toBeNull();

    const derived = cronIntervalMinutes(match![1]);
    expect(
      derived,
      `อ่านคาบจาก cron "${match![1]}" ไม่ได้ — รองรับเฉพาะ */n · นาทีเดียว · comma-list ที่ห่างเท่ากัน`
    ).not.toBeNull();

    expect(derived).toBe(CRON_INTERVAL_MINUTES);
  });
});
