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
export const MECHANISMS = {
  /** QStash schedule ทุก 5 นาที — กลไกเดียวที่มีคาบแน่นอน ⇒ ใช้ตัดสิน stale ได้ */
  "sla-sweep": 300,
  "send-email": null,
  "webhook-deliver": null,
  /** P2 เต้นเองทุก live probe — คาบ = min-interval ของ live probe */
  "readiness-probe": 300,
} as const;

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
        expectedIntervalSeconds: MECHANISMS[mechanism],
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
   *  ok      — กลไกที่มีคาบทุกตัวเต้นอยู่ในหน้าต่างที่คาด
   *  error   — มีอย่างน้อยหนึ่งกลไกที่มีคาบค้างเกินหน้าต่าง
   *  missing — **ไม่พบแถวของกลไกที่มีคาบเลย** ⇒ FAIL เสมอ (§F ห้าม fallback เป็น PASS)
   */
  status: "ok" | "error" | "missing";
  detail: string;
  mechanisms: HeartbeatRow[];
}

/** กลไกที่มีคาบ = ตัวที่ใช้ตัดสิน stale ได้ */
const SCHEDULED_MECHANISMS = (
  Object.keys(MECHANISMS) as MechanismName[]
).filter((m) => MECHANISMS[m] !== null);

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
    return {
      status: "error",
      detail: staleOnes
        .map((m) => `${m.mechanism} stale ${m.ageSeconds}s`)
        .join(", "),
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
