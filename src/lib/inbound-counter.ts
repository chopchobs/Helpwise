/**
 * src/lib/inbound-counter.ts
 * Phase 39 ลำดับ 3 (erratum §E) — inbound counter 2 ตัว ตามกฎที่แก้แล้วใน §C
 *
 * ทำไมนับที่ **inbound delivery attempt** ไม่ใช่ที่ publish (v2 §3 ข้อ 2 ข):
 * retry ของ QStash วิ่งเข้า endpoint ของเราเองทุกครั้ง ⇒ นับเห็นครบ
 * (เคส sweep พังต่อเนื่อง: แอปเรียกเอง 288/วัน แต่ retry ทำให้ของจริง 1,152/วัน —
 * counter ที่นับฝั่ง publish อ่านได้ 28.8% = OK ทั้งที่ของจริง 115.2% = false-PASS เต็มรูปแบบ)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * counter สองตัว (คนละหน้าที่ ห้ามรวมกัน):
 *
 *   1. **โควตา** — นับเฉพาะ attempt ที่ `verified` เท่านั้น เทียบเพดาน 1,000/วัน (UTC)
 *      ≥80% → DEGRADED · ≥100% → FAIL
 *      ✅ คนนอกดันตัวเลขนี้ไม่ได้ (ต้อง verify ผ่านก่อน) ⇒ เขียนทุก attempt ได้ปลอดภัย
 *
 *   2. **verify ไม่ผ่าน** — แยกเป็น 2 คลาสตาม §C ก่อนตัดสิน:
 *      · `signed_invalid` — สัญญาณจริง แต่ **forge ได้** ⇒ FAIL ต้องมี corroboration
 *        กับ heartbeat · ไม่มี corroboration = DEGRADED เท่านั้น
 *      · `unsigned`       — ขยะจากภายนอก ⇒ **ห้ามเป็น FAIL เด็ดขาด** (ไม่งั้นใครก็ตรึง
 *        สถานะเป็น FAIL ถาวร = ทำลายช่องเตือนทั้งช่อง) ⇒ rate-based → DEGRADED
 *
 * ⛔ **counter 2 เป็น write ที่คนนอกกระตุ้นได้ ⇒ ต้อง bounded** (§C ข้อบังคับที่ 2):
 *    · bucket write เท่านั้น — ห้าม insert 1 แถวต่อ 1 request
 *    · ห้ามเขียน Redis 1 คำสั่งต่อ 1 request ด้วย — ไม่งั้นย้ายความเสียหายจาก
 *      "ช่องเตือนพัง" ไปเป็น "โควตา Redis พัง" เฉย ๆ (Redis เป็นของทั้งแอป ดู §H-2)
 *      ⇒ สะสมใน process แล้ว flush เป็นช่วง
 *    · saturate ที่เพดานต่อ bucket ⇒ จำนวน write ต่อวันมีขอบบนคงที่
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { redis } from "@/lib/redis";
import type { InboundAttemptClass } from "@/lib/queue";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * เพดานโควตา QStash ต่อวัน (free tier) — ตัวเลขจาก v2 §3 ข้อ 2 (ก)
 * ใช้ตัวเลขนี้เป็นตัวหารของ % headroom
 */
export const QSTASH_DAILY_QUOTA = 1000;

/** threshold สองชั้นของโควตา — ตั้งจากตัวเลขจริงใน phase-38 §10.3 ไม่ใช่เดา */
export const QUOTA_DEGRADED_PERCENT = 80;
export const QUOTA_FAIL_PERCENT = 100;

/**
 * อัตรา `unsigned` ต่อชั่วโมงที่เกินแล้วถือเป็น DEGRADED
 * ⚠️ ค่านี้ **ไม่ได้มาจากหลักฐาน** — ตั้งจากเหตุผลว่า QStash ไม่เคยส่ง unsigned เลย
 *    ⇒ ค่าปกติควรเป็น 0 · 60/ชม. (1 ครั้ง/นาที) เผื่อ scanner ทั่วไปไว้แล้ว
 *    ปรับได้เมื่อมีข้อมูลจริง — แต่ห้ามเปลี่ยนให้มันมีผลแรงกว่า DEGRADED
 */
export const UNSIGNED_RATE_DEGRADED_PER_HOUR = 60;

/** เพดานต่อ bucket — เกินแล้ว counter saturate (หยุดเขียน บันทึกว่า "≥ เพดาน") */
export const BUCKET_SATURATE_AT = 10_000;

/** flush accumulator อย่างช้าทุกเท่านี้ (มิลลิวินาที) */
export const FLUSH_INTERVAL_MS = 60_000;

/** ...หรือเมื่อสะสมถึงจำนวนนี้ก่อน (กัน burst ค้างนานเกินไป) */
export const FLUSH_MAX_PENDING = 200;

const KEY_PREFIX = "readiness:inbound";
/** TTL ของ bucket — ยาวกว่าหน้าต่างที่อ่านพอสมควร แต่ยังหมดอายุเองเสมอ */
const DAILY_BUCKET_TTL_SECONDS = 172_800; // 48 ชม.
const HOURLY_BUCKET_TTL_SECONDS = 93_600; // 26 ชม.

// =============================================================================
// BUCKET KEYS
// =============================================================================

/** bucket รายวันตาม UTC — โควตาของ QStash รีเซ็ตรายวัน */
export function dailyBucketKey(cls: InboundAttemptClass, now = new Date()): string {
  return `${KEY_PREFIX}:${cls}:${now.toISOString().slice(0, 10)}`;
}

/** bucket รายชั่วโมงตาม UTC — ใช้กับคลาสที่ตัดสินแบบ rate */
export function hourlyBucketKey(cls: InboundAttemptClass, now = new Date()): string {
  return `${KEY_PREFIX}:${cls}:${now.toISOString().slice(0, 13)}`;
}

// =============================================================================
// ACCUMULATOR (bounded write)
// =============================================================================

interface Pending {
  signed_invalid: number;
  unsigned: number;
}

let pending: Pending = { signed_invalid: 0, unsigned: 0 };
/**
 * ⚠️ เริ่มที่ "เวลาปัจจุบัน" ไม่ใช่ 0 — ถ้าเริ่มที่ 0 เงื่อนไข
 * `Date.now() - lastFlushAt >= FLUSH_INTERVAL_MS` จะจริงตั้งแต่ attempt แรก
 * ⇒ request แรกของทุก instance เขียน Redis ทันที ⇒ คนนอกที่ยิงกระจายเข้า
 * instance ใหม่ ๆ ยังทำให้เกิด write ต่อ request ได้ = เพดานรั่ว
 */
let lastFlushAt = Date.now();
/** bucket ที่รู้แล้วว่า saturate — ไม่ต้องเขียนซ้ำ (เพดานของ write ต่อวัน) */
const saturatedBuckets = new Set<string>();

/**
 * 🔴 flag ว่า **write ของ counter เคยล้ม** — ต้องเดินทางออกไปถึงสถานะของ P2
 *
 * ทำไมจำเป็น: write ล้มแต่ read ยังได้ ⇒ ตัวเลขโควตา**ต่ำกว่าความจริงแบบเงียบ**
 * ⇒ readiness ดูสุขภาพดี ⇒ **false-PASS บนเกณฑ์ brief §8 ข้อ 2** ซึ่งเป็นเกณฑ์ที่
 * กลไกนับทั้งหมดนี้สร้างขึ้นมาเพื่อผ่าน · `console.error` อย่างเดียวไม่นับเป็นทางออก —
 * บน Vercel มันลงไปอยู่ใน log ที่ไม่มีใครเปิด = pattern เดียวกับ `EMAIL_PROVIDER` (brief §2.3)
 *
 * ⚠️ **ข้อจำกัดที่ต้องรู้: flag นี้เป็น per-instance และหายไปเมื่อ instance ตาย**
 *    ⇒ ครอบไม่ครบ (ดู erratum §H-4) — แต่ดีกว่าเงียบสนิท · sticky โดยตั้งใจ:
 *    ไม่ decay เอง เพราะ "หายเอง" คือคุณสมบัติที่ทำให้สัญญาณเชื่อถือไม่ได้
 */
let writeFailure: string | null = null;

/** counter เคยเขียนพลาดใน instance นี้หรือไม่ — readiness อ่านค่านี้ทุกรอบ live probe */
export function getCounterWriteFailure(): string | null {
  return writeFailure;
}

/** ล้าง state ระดับ module — ใช้ใน test เท่านั้น */
export function __resetInboundCounterForTest(): void {
  pending = { signed_invalid: 0, unsigned: 0 };
  lastFlushAt = Date.now();
  saturatedBuckets.clear();
  writeFailure = null;
}

/** บันทึกว่า write ล้ม — log **และ** ตั้ง flag ที่ readiness จะอ่านเจอ */
function markWriteFailure(scope: string, err: unknown): void {
  writeFailure = `${scope}: ${(err as Error).message.slice(0, 120)}`;
  console.error(`[inbound-counter] ${writeFailure}`);
}

/**
 * เขียน bucket เดียวแบบ saturate
 * INCRBY 1 คำสั่ง · เขียนเพิ่มอีก 1 คำสั่งเฉพาะ**ตอนข้ามเพดานครั้งแรก**เท่านั้น
 */
async function incrementBucket(
  key: string,
  amount: number,
  ttlSeconds: number
): Promise<void> {
  if (saturatedBuckets.has(key)) return; // ตันแล้ว — ไม่เขียนอีก

  const value = await redis.incrby(key, amount);
  if (value === amount) {
    // เพิ่งสร้าง bucket นี้ครั้งแรก → ตั้งอายุ (bucket จึงหมดอายุเองเสมอ)
    await redis.expire(key, ttlSeconds);
  }
  if (value >= BUCKET_SATURATE_AT) {
    await redis.set(key, String(BUCKET_SATURATE_AT), "EX", ttlSeconds);
    saturatedBuckets.add(key);
  }
}

/** flush ค่าที่สะสมไว้ลง Redis — ไม่ throw (counter พังห้ามทำให้ worker พัง) */
async function flushPending(): Promise<void> {
  const toFlush = pending;
  pending = { signed_invalid: 0, unsigned: 0 };
  lastFlushAt = Date.now();

  try {
    if (toFlush.signed_invalid > 0) {
      await incrementBucket(
        hourlyBucketKey("signed_invalid"),
        toFlush.signed_invalid,
        HOURLY_BUCKET_TTL_SECONDS
      );
    }
    if (toFlush.unsigned > 0) {
      await incrementBucket(
        hourlyBucketKey("unsigned"),
        toFlush.unsigned,
        HOURLY_BUCKET_TTL_SECONDS
      );
    }
  } catch (err) {
    // 🔴 write ล้ม → ต้องไปโผล่ที่สถานะของ P2 ไม่ใช่แค่ log (§F: catch ที่กลืน error
    //    ในไฟล์ของ P2 เอง ต้องมีทางออกไปถึงสถานะ)
    markWriteFailure("flush failed", err);
  }
}

/**
 * บันทึก inbound delivery attempt หนึ่งครั้ง
 *
 * เรียกที่ worker route **ทุก attempt ไม่ว่า verify จะผ่านหรือไม่** — คลาสมาจาก
 * `verifyQStashSignature()` ซึ่งคำนวณจากการอ่าน header เอง (ห้ามอนุมานจาก `valid`)
 *
 * ⚠️ ไม่ throw เด็ดขาด — counter เป็นเครื่องมือสังเกตการณ์ ห้ามทำให้ worker ล้ม
 */
export async function recordInboundAttempt(
  cls: InboundAttemptClass
): Promise<void> {
  try {
    if (cls === "verified") {
      // ✅ คนนอกดันตัวเลขนี้ไม่ได้ (ต้อง verify ผ่าน) และปริมาณถูกจำกัดด้วยโควตา
      //    ของ QStash เองอยู่แล้ว ⇒ เขียนทันทีได้ ความแม่นสำคัญกว่า (นี่คือตัวเลข
      //    โควตาที่ threshold 80/100% ตัดสินจากมัน — flush ช้าแล้วหายตอน instance ตาย
      //    จะทำให้ headroom รายงานต่ำกว่าจริงซึ่งเป็นทิศที่อันตราย)
      await incrementBucket(
        dailyBucketKey("verified"),
        1,
        DAILY_BUCKET_TTL_SECONDS
      );
      return;
    }

    // 🔒 สองคลาสที่คนนอกกระตุ้นได้ → สะสมใน process ก่อน (bounded write)
    pending[cls] += 1;
    const total = pending.signed_invalid + pending.unsigned;
    if (
      total >= FLUSH_MAX_PENDING ||
      Date.now() - lastFlushAt >= FLUSH_INTERVAL_MS
    ) {
      await flushPending();
    }
  } catch (err) {
    markWriteFailure("record failed", err);
  }
}

// =============================================================================
// READ
// =============================================================================

export interface InboundCounters {
  /** attempt ที่ verify ผ่าน วันนี้ (UTC) */
  quotaUsed: number;
  quotaLimit: number;
  quotaPercent: number;
  /** คลาส (1) ในชั่วโมงปัจจุบัน */
  signedInvalidThisHour: number;
  /** คลาส (2) ในชั่วโมงปัจจุบัน */
  unsignedThisHour: number;
  /** bucket ใด bucket หนึ่งตันเพดานแล้ว ⇒ ตัวเลขจริงสูงกว่านี้ */
  saturated: boolean;
}

async function readBucket(key: string): Promise<number> {
  const raw = await redis.get(key);
  if (raw === null) return 0; // key ยังไม่เคยถูกสร้าง = 0 จริง

  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    // ⛔ ห้ามคืน 0 เงียบ ๆ — ค่าเสียจะถูกอ่านเป็น "ไม่มี traffic เลย" ซึ่งดูสุขภาพดี
    //    ทั้งที่ของจริงคือวัดไม่ได้ ⇒ throw ให้ caller ยกเป็น reason ที่ถึงสถานะ
    throw new Error(`corrupt counter bucket: ${key}`);
  }
  return value;
}

/** อ่าน counter ทั้งหมด — ใช้ในทางเดินที่ auth ของ readiness probe เท่านั้น */
export async function readInboundCounters(): Promise<InboundCounters> {
  const [quotaUsed, signedInvalidThisHour, unsignedThisHour] = await Promise.all([
    readBucket(dailyBucketKey("verified")),
    readBucket(hourlyBucketKey("signed_invalid")),
    readBucket(hourlyBucketKey("unsigned")),
  ]);

  return {
    quotaUsed,
    quotaLimit: QSTASH_DAILY_QUOTA,
    quotaPercent: Math.round((quotaUsed / QSTASH_DAILY_QUOTA) * 1000) / 10,
    signedInvalidThisHour,
    unsignedThisHour,
    saturated:
      signedInvalidThisHour >= BUCKET_SATURATE_AT ||
      unsignedThisHour >= BUCKET_SATURATE_AT ||
      quotaUsed >= BUCKET_SATURATE_AT,
  };
}

// =============================================================================
// EVALUATE (กฎ §C)
// =============================================================================

/**
 * ความสดของ heartbeat ที่ใช้ corroborate คลาส (1)
 *
 * `"unknown"` = **ยังไม่มี heartbeat store** (ลำดับ 4) ⇒ corroborate ไม่ได้
 * ⇒ ตามกฎ §C ห้ามยกระดับเป็น FAIL จากคลาส (1) อย่างเดียว **และห้ามเงียบ**
 * ⇒ ลงเอยที่ DEGRADED พร้อม reason ที่บอกตรง ๆ ว่า corroboration ยังไม่มี
 */
export type HeartbeatFreshness = "fresh" | "stale" | "unknown";

export interface InboundEvaluation {
  /** ระดับที่ counter ชุดนี้เรียกร้อง — ตัวรวมสถานะจะเอาไปผสมกับ component อื่น */
  level: "OK" | "DEGRADED" | "FAIL";
  reasons: string[];
  /** ตัวเลขโควตากำลังรายงานต่ำกว่าความจริงอยู่หรือไม่ (§C ข้อสุดท้าย) */
  quotaUnderReported: boolean;
}

/**
 * ตัดสินตามกฎ §C ทั้งข้อ
 *
 * | เงื่อนไข | ผล |
 * | --- | --- |
 * | โควตา ≥ 100% | FAIL |
 * | โควตา ≥ 80% | DEGRADED |
 * | คลาส (1) > 0 **และ** heartbeat ค้าง | **FAIL** (corroboration ครบสองด้าน) |
 * | คลาส (1) > 0 **แต่** heartbeat สด | DEGRADED — "มีคนยิง signature ปลอม แต่ delivery จริงยังผ่าน" |
 * | คลาส (1) > 0 **และ** heartbeat ยังไม่มี (ลำดับ 4) | DEGRADED + reason ว่า corroborate ไม่ได้ |
 * | คลาส (2) เกิน rate | DEGRADED — เป็นข้อมูล ไม่ใช่คำพิพากษา |
 *
 * ⛔ คลาส (2) ไม่มีทางทำให้เป็น FAIL ไม่ว่าจะมากแค่ไหน — นั่นคือทั้งประเด็นของ §C
 */
export function evaluateInboundCounters(
  counters: InboundCounters,
  heartbeat: HeartbeatFreshness,
  /** ข้อความจาก `getCounterWriteFailure()` — `null` = ยังไม่เคยเขียนพลาด */
  writeFailed: string | null = null
): InboundEvaluation {
  const reasons: string[] = [];
  let level: InboundEvaluation["level"] = "OK";

  const escalate = (next: InboundEvaluation["level"]) => {
    if (next === "FAIL") level = "FAIL";
    else if (next === "DEGRADED" && level === "OK") level = "DEGRADED";
  };

  // ── counter 1: โควตา ──────────────────────────────────────────────────────
  if (counters.quotaPercent >= QUOTA_FAIL_PERCENT) {
    reasons.push(`quota_exhausted_${counters.quotaPercent}pct`);
    escalate("FAIL");
  } else if (counters.quotaPercent >= QUOTA_DEGRADED_PERCENT) {
    reasons.push(`quota_high_${counters.quotaPercent}pct`);
    escalate("DEGRADED");
  }

  // ── write ล้ม: ตัวเลขที่อ่านได้ต่ำกว่าความจริง ⇒ กฎเดียวกับเคส signed_invalid ──
  //    (write ล้มแต่ read ได้ = counter ดูสุขภาพดีทั้งที่นับไม่ครบ = false-PASS)
  if (writeFailed !== null) {
    reasons.push("inbound_counter_write_failed");
    escalate("DEGRADED"); // ห้ามเป็น OK ตลอดช่วงที่ flag ติด
  }

  // ── counter 2 คลาส (1): signed-but-invalid ────────────────────────────────
  const quotaUnderReported = counters.signedInvalidThisHour > 0 || writeFailed !== null;
  if (counters.signedInvalidThisHour > 0) {
    // §C: ตลอดช่วงที่คลาส (1) ไม่เป็นศูนย์ ตัวเลขโควตาต่ำกว่าความจริง
    // และสถานะรวม **ห้ามเป็น OK** (DEGRADED เป็นอย่างต่ำ)
    if (heartbeat === "stale") {
      reasons.push("signed_invalid_with_stale_heartbeat");
      escalate("FAIL"); // corroboration ครบสองด้าน = signing key ไม่ตรงของจริง
    } else if (heartbeat === "fresh") {
      reasons.push("signed_invalid_delivery_still_ok");
      escalate("DEGRADED"); // forge ได้ ⇒ ห้ามให้คนนอกตรึงเป็น FAIL
    } else {
      reasons.push("signed_invalid_corroboration_unavailable");
      escalate("DEGRADED"); // ลำดับ 4 ยังไม่มี — ไม่เงียบ แต่ยังไม่ตัดสินว่าพัง
    }
  }

  if (quotaUnderReported) reasons.push("quota_under_reported");

  // ── counter 2 คลาส (2): unsigned — rate-based เท่านั้น ────────────────────
  if (counters.unsignedThisHour > UNSIGNED_RATE_DEGRADED_PER_HOUR) {
    reasons.push(`unsigned_rate_${counters.unsignedThisHour}_per_hour`);
    escalate("DEGRADED"); // ⛔ ห้ามเป็น FAIL ไม่ว่าตัวเลขจะสูงแค่ไหน
  }

  if (counters.saturated) reasons.push("counter_saturated");

  return { level, reasons, quotaUnderReported };
}
