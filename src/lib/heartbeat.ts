/**
 * src/lib/heartbeat.ts
 * Phase 39 ลำดับ 4 (erratum §E) — heartbeat ระดับ mechanism
 *
 * หน้าที่: ตอบคำถาม "กลไกนี้ทำงานล่าสุดเมื่อไร" ให้ readiness probe
 * เป็น **ด้านที่สองของ corroboration ใน §C** — attempt ที่ signature ไม่ผ่านจะยกระดับ
 * เป็น `FAIL` ได้ก็ต่อเมื่อ heartbeat ของกลไกนั้นค้างด้วย (คนนอกที่ยิง forged header
 * ทำให้ heartbeat ค้างไม่ได้ ⇒ ตรึงสถานะเป็น FAIL ไม่ได้)
 *
 * ⛔ GLOBAL โดยตั้งใจ — ห้ามใส่ข้อมูลที่ระบุ tenant ลงตารางนี้เด็ดขาด
 *    (shape ที่ไม่ auth ของ probe เสิร์ฟค่าที่คำนวณจากตารางนี้ต่อสาธารณะ · §F)
 *    heartbeat ราย tenant = Phase 40
 *
 * ⚠️ §F: ทุก catch ในไฟล์ของ P2 ต้องมีทางออกไปถึงสถานะ — ไฟล์นี้จึง **ไม่กลืน error
 *    ในทาง read** (โยนขึ้นไปให้ readiness แปลงเป็น component error = FAIL)
 *    ส่วนทาง write กลืนได้เพราะห้ามทำให้ worker ล้ม — แต่ต้องทิ้ง flag ไว้ให้เห็น
 */

import { prisma } from "@/lib/prisma";
// คาบของ cron — อยู่ใน readiness-verdict เพราะ `readiness-check.ts` (GitHub Actions,
// ไม่มี DATABASE_URL) ต้อง import ค่าเดียวกันโดยไม่ลาก prisma เข้าไป
import { CRON_INTERVAL_MINUTES } from "@/lib/readiness-verdict";

// =============================================================================
// MECHANISMS
// =============================================================================

/**
 * กลไกที่ P2 เฝ้า พร้อมคาบที่คาดว่าจะเต้น
 *
 * `expectedIntervalSeconds = null` = **event-driven** — ไม่มีคาบ ⇒ ตัดสิน "ค้าง" ไม่ได้
 * โดยธรรมชาติ (ไม่มี message เข้ามาก็ไม่เต้น ซึ่งไม่ใช่ความผิดปกติ)
 * ⇒ กลไกพวกนี้บอกได้แค่ "เคยทำงานล่าสุดเมื่อไร" ไม่ถูกใช้ตัดสิน stale
 */
/**
 * บทบาทของกลไกในระบบเฝ้า — **แยกด้วย field ไม่ใช่ยกเว้นตามชื่อ** (§H-5 · ข้อ 3)
 *
 * · `watched` — ของที่ถูกเฝ้า · ค้าง = **ระบบพัง** ⇒ `FAIL`
 * · `watcher` — ตัวเฝ้าเอง · ค้าง = **ผู้เฝ้าเต้นไม่ทันคาบตัวเอง** ⇒ `WATCHER_LATE`
 *   (ผลตรวจในรอบนั้น **สด** — สิ่งที่ค้างคือจังหวะของผู้เฝ้า ไม่ใช่ของระบบ)
 *
 * 🔴 **ทำไมต้องเป็น field ไม่ใช่ `if (m === "readiness-probe")`:**
 * การยกเว้นตามชื่อคือที่ที่ภายหลังใช้ซ่อนของจริง — วันหนึ่งจะมีคนเติมชื่อที่สองเข้าไปในเงื่อนไข
 * เพื่อให้เสียงเงียบลง โดยไม่มีใครต้องอธิบายว่าทำไมกลไกนั้นถึง "ไม่นับ"
 * ⇒ บทบาทเป็นข้อเท็จจริงของกลไก ⇒ ต้องประกาศคู่กับกลไก และคอมไพเลอร์บังคับให้ครบทุกตัว
 */
export type MechanismRole = "watched" | "watcher";

export interface MechanismSpec {
  /** คาบที่คาด (วินาที) · `null` = event-driven ⇒ ตัดสิน "ค้าง" ไม่ได้ */
  intervalSeconds: number | null;
  role: MechanismRole;
}

export const MECHANISMS = {
  /** QStash schedule ทุก 5 นาที — กลไกเดียวที่มีคาบแน่นอน ⇒ ใช้ตัดสิน stale ได้ */
  "sla-sweep": { intervalSeconds: 300, role: "watched" },
  "send-email": { intervalSeconds: null, role: "watched" },
  "webhook-deliver": { intervalSeconds: null, role: "watched" },
  /**
   * P2 เต้นเองทุก live probe — **คาบ = คาบของ cron ที่มาเรียก** ไม่ใช่ min-interval
   *
   * 🔴 **เคยเขียนไว้ผิดว่า "คาบ = min-interval ของ live probe" (= 300)** — §G ข้อ 13
   *    `LIVE_PROBE_MIN_INTERVAL_SECONDS` คือ **เพดานความถี่** ("ห้ามเต้นถี่กว่า 5 นาที")
   *    **ไม่ใช่คาบการเต้น** — ตัวที่กำหนดว่าเต้นบ่อยแค่ไหนคือ cron (15 นาที) ต่างหาก
   *    ⇒ ผลของค่าเดิม: เกณฑ์ stale (300×3 = 900s) **เท่ากับคาบจริง (900s) พอดี ⇒ margin = 0**
   *    ⇒ cron มาสายนิดเดียว = `stale` ⇒ `FAIL` · มาตรงเวลา = `OK` ⇒ **flap ไม่รู้จบ**
   *
   * ✅ ตอนนี้ดึงจาก **แหล่งเดียวกับที่ `readiness-check.ts` ใช้** ⇒ สองค่าเพี้ยนจากกันไม่ได้อีก
   *    (`cron:` ใน workflow เป็นสนามที่สาม — ผูกด้วย import ไม่ได้ จึงมี test อ่าน yml มาเทียบ)
   */
  "readiness-probe": {
    intervalSeconds: CRON_INTERVAL_MINUTES * 60,
    // 🔑 ตัวเดียวที่เป็น `watcher` — มันคือ P2 เอง
    role: "watcher",
  },
} as const satisfies Record<string, MechanismSpec>;

export type MechanismName = keyof typeof MECHANISMS;

/**
 * ตัวคูณความอดทนก่อนตัดสินว่า "ค้าง"
 * 3× = พลาดรอบติดกัน 3 ครั้ง — สูงพอไม่ noisy จาก jitter ของ scheduler
 * ต่ำพอให้ยังตรวจจับได้ภายในหลักสิบนาที
 */
export const STALE_TOLERANCE_FACTOR = 3;

// =============================================================================
// WRITE
// =============================================================================

/** flag ว่า heartbeat เขียนพลาด — ต้องไปโผล่ที่สถานะ ไม่ใช่แค่ log (§F) */
let writeFailure: string | null = null;

export function getHeartbeatWriteFailure(): string | null {
  return writeFailure;
}

/** ล้าง state ระดับ module — ใช้ใน test เท่านั้น */
export function __resetHeartbeatForTest(): void {
  writeFailure = null;
}

/**
 * บันทึกว่ากลไกนี้เพิ่งทำงานสำเร็จ
 *
 * เรียก **หลังทำงานจริงสำเร็จ** เท่านั้น — ไม่ใช่ตอนรับ request
 * (ไม่งั้น heartbeat จะสดทั้งที่งานล้มเหลว = corroboration ใน §C พัง:
 * เคส "signing key ไม่ตรง" ต้องทำให้ heartbeat ค้างจริง ๆ จึงจะจับได้)
 *
 * ⚠️ ไม่ throw — worker ห้ามล้มเพราะ heartbeat แต่ความล้มเหลวต้องไม่เงียบ
 */
export async function recordHeartbeat(mechanism: MechanismName): Promise<void> {
  const now = new Date();
  try {
    await prisma.mechanismHeartbeat.upsert({
      where: { mechanism },
      create: {
        mechanism,
        lastBeatAt: now,
        expectedIntervalSeconds: MECHANISMS[mechanism].intervalSeconds,
      },
      update: { lastBeatAt: now },
    });
    writeFailure = null; // เขียนสำเร็จ = สัญญาณล่าสุดเชื่อได้อีกครั้ง
  } catch (err) {
    writeFailure = `heartbeat write failed (${mechanism}): ${(err as Error).message.slice(0, 120)}`;
    console.error(`[heartbeat] ${writeFailure}`);
  }
}

// =============================================================================
// READ / EVALUATE
// =============================================================================

export interface HeartbeatRow {
  mechanism: string;
  lastBeatAt: Date;
  expectedIntervalSeconds: number | null;
  ageSeconds: number;
  /** ค้างเกินหน้าต่างที่คาดหรือยัง — `null` สำหรับกลไก event-driven */
  stale: boolean | null;
}

export interface HeartbeatReport {
  /**
   *  ok           — กลไกที่มีคาบทุกตัวเต้นอยู่ในหน้าต่างที่คาด
   *  error        — มีอย่างน้อยหนึ่งกลไก **`watched`** ที่ค้างเกินหน้าต่าง ⇒ ระบบพัง ⇒ `FAIL`
   *  watcher_late — ค้างเฉพาะกลไก **`watcher`** ⇒ ผู้เฝ้าเต้นไม่ทันคาบตัวเอง ⇒ `WATCHER_LATE`
   *  missing      — **ไม่พบแถวของกลไกที่มีคาบเลย** ⇒ FAIL เสมอ (§F ห้าม fallback เป็น PASS)
   *
   * ⚠️ ลำดับความรุนแรง: `missing`/`error` > `watcher_late` > `ok`
   *    ⇒ ถ้าค้างทั้งสองบทบาทพร้อมกัน **`error` ชนะ** (ของที่ถูกเฝ้าพังสำคัญกว่าจังหวะของผู้เฝ้า)
   */
  status: "ok" | "error" | "watcher_late" | "missing";
  detail: string;
  mechanisms: HeartbeatRow[];
}

/** กลไกที่มีคาบ = ตัวที่ใช้ตัดสิน stale ได้ */
const SCHEDULED_MECHANISMS = (
  Object.keys(MECHANISMS) as MechanismName[]
).filter((m) => MECHANISMS[m].intervalSeconds !== null);

/**
 * อ่าน heartbeat ทั้งหมดแล้วสรุปเป็น component report
 *
 * ⚠️ **ไม่จับ error** — อ่านตารางไม่ได้ = วัด corroboration ไม่ได้ ⇒ ต้องขึ้นไปถึง
 *    สถานะของ P2 (readiness แปลงเป็น component error = FAIL) ห้ามกลืนเป็น "ok"
 */
export async function readHeartbeats(now = new Date()): Promise<HeartbeatReport> {
  const rows = await prisma.mechanismHeartbeat.findMany({
    orderBy: { mechanism: "asc" },
  });

  const mechanisms: HeartbeatRow[] = rows.map((row) => {
    const ageSeconds = Math.max(
      0,
      Math.round((now.getTime() - row.lastBeatAt.getTime()) / 1000)
    );
    const expected = row.expectedIntervalSeconds;
    return {
      mechanism: row.mechanism,
      lastBeatAt: row.lastBeatAt,
      expectedIntervalSeconds: expected,
      ageSeconds,
      stale: expected === null ? null : ageSeconds > expected * STALE_TOLERANCE_FACTOR,
    };
  });

  // 🔒 §F: ไม่พบแถวของกลไกที่มีคาบแม้แต่ตัวเดียว = missing = FAIL
  //    (fresh deploy ที่ยังไม่มีใครเต้นก็ตกเคสนี้ — ตั้งใจ ไม่ใช่บั๊ก)
  const presentScheduled = mechanisms.filter((m) =>
    SCHEDULED_MECHANISMS.includes(m.mechanism as MechanismName)
  );
  if (presentScheduled.length === 0) {
    return {
      status: "missing",
      detail: `no heartbeat for any scheduled mechanism (${SCHEDULED_MECHANISMS.join(", ")})`,
      mechanisms,
    };
  }

  const staleOnes = presentScheduled.filter((m) => m.stale === true);
  if (staleOnes.length > 0) {
    const describe = (rows: HeartbeatRow[]) =>
      rows.map((m) => `${m.mechanism} stale ${m.ageSeconds}s`).join(", ");
    // 🔑 ข้อ 3: แยกตาม **บทบาท** ไม่ใช่ตามชื่อ — ของที่ถูกเฝ้าค้าง = ระบบพัง (`error`)
    //    ส่วนผู้เฝ้าค้าง = จังหวะของผู้เฝ้าเอง (`watcher_late`) ⇒ ผลตรวจรอบนี้ยังสด
    const watchedStale = staleOnes.filter(
      (m) => MECHANISMS[m.mechanism as MechanismName].role === "watched"
    );
    if (watchedStale.length > 0) {
      // ⚠️ ค้างทั้งสองบทบาท ⇒ `error` ชนะ แต่ **detail ต้องบอกครบทุกตัว** ไม่ใช่แค่ตัวที่ชนะ
      //    (บทเรียน §H-13: ข้อความที่บอกไม่ครบ ทำให้ incident ต้องเริ่มจากศูนย์)
      return { status: "error", detail: describe(staleOnes), mechanisms };
    }
    // 🔴 **ห้ามลดชั้น `missing` ลงมาเป็น `watcher_late`** — ถ้ากลไก `watched` **หายไปทั้งแถว**
    //    พร้อมกับที่ผู้เฝ้าค้าง เคสนั้นคือ FAIL ตาม §F ไม่ใช่ "ผู้เฝ้าช้า"
    //    (สาขานี้ `return` ก่อนสาขา `absent` ด้านล่าง ⇒ ต้องเช็คเองตรงนี้
    //     — ช่องเดียวกับที่ incident 2026-08-10 §5.1 บันทึกไว้ว่า stale กลบ absent ได้)
    const absentWhileWatcherLate = SCHEDULED_MECHANISMS.filter(
      (name) => !presentScheduled.some((m) => m.mechanism === name)
    );
    if (absentWhileWatcherLate.length === 0) {
      return { status: "watcher_late", detail: describe(staleOnes), mechanisms };
    }
    return {
      status: "missing",
      detail: `no heartbeat yet: ${absentWhileWatcherLate.join(", ")} · ${describe(staleOnes)}`,
      mechanisms,
    };
  }

  // กลไกที่มีคาบแต่ยังไม่เคยเต้นเลย — นับเป็น missing เช่นกัน ห้ามผ่านเงียบ
  const absent = SCHEDULED_MECHANISMS.filter(
    (name) => !presentScheduled.some((m) => m.mechanism === name)
  );
  if (absent.length > 0) {
    return {
      status: "missing",
      detail: `no heartbeat yet: ${absent.join(", ")}`,
      mechanisms,
    };
  }

  return {
    status: "ok",
    detail: `${presentScheduled.length} scheduled mechanism(s) beating`,
    mechanisms,
  };
}
