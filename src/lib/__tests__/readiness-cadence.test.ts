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
    expect(MECHANISMS["readiness-probe"]).toBeGreaterThanOrEqual(
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
      (MECHANISMS["readiness-probe"] as number) * STALE_TOLERANCE_FACTOR;
    const missedRunsTolerated = staleAfterSeconds / (CRON_INTERVAL_MINUTES * 60);
    expect(missedRunsTolerated).toBeGreaterThanOrEqual(2);
  });

  it("heartbeat ต้องดัง **ทีหลัง** in-band gap check (สัญญาณเจาะจงกว่าต้องดังก่อน)", () => {
    // `detectGap()` ออกแบบมาเพื่อจับ "cron หาย" โดยเฉพาะ ⇒ ควรเป็นตัวที่พูดก่อน
    // heartbeat เป็น backstop ⇒ ถ้ามันดังก่อน ลำดับการวินิจฉัยจะกลับหัว
    // (detectGap เตือนเมื่อ missedRuns ≥ 1 คือห่าง ≥ 2 คาบ)
    const gapAlertSeconds = CRON_INTERVAL_MINUTES * 60 * 2;
    const heartbeatAlertSeconds =
      (MECHANISMS["readiness-probe"] as number) * STALE_TOLERANCE_FACTOR;
    expect(heartbeatAlertSeconds).toBeGreaterThan(gapAlertSeconds);
  });
});

describe("สนามที่สาม — `cron:` ใน workflow ผูกด้วย import ไม่ได้ จึงต้องเทียบด้วย test", () => {
  // ⚠️ ข้อนี้คือรูที่ทำให้เกิด §G ข้อ 13: ค่าเดียวกันถูกคัดลอกไว้หลายที่โดยไม่มีอะไรผูก
  //    การเว้นสนามนี้ไว้ทั้งที่รู้ = ปล่อยรูรูปแบบเดิมที่เพิ่งกัดเราไว้เฉย ๆ
  const WORKFLOW_PATH = ".github/workflows/readiness.yml";

  it(`schedule ใน ${WORKFLOW_PATH} ตรงกับ CRON_INTERVAL_MINUTES`, () => {
    const yml = readFileSync(WORKFLOW_PATH, "utf8");

    // จับรูปแบบ `*/<n> * * * *` ในบรรทัด cron
    const match = yml.match(/cron:\s*["']\*\/(\d+)\s+\*\s+\*\s+\*\s+\*["']/);
    expect(
      match,
      `อ่าน cron จาก ${WORKFLOW_PATH} ไม่ได้ — ถ้าเปลี่ยนรูปแบบ schedule ต้องแก้ test นี้ด้วย ห้ามลบทิ้ง`
    ).not.toBeNull();

    expect(Number(match![1])).toBe(CRON_INTERVAL_MINUTES);
  });
});
