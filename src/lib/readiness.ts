/**
 * src/lib/readiness.ts
 * Phase 39 ลำดับ 2 (erratum §E) — ตรรกะของ readiness probe (P2)
 *
 * โจทย์ของ P2: จับ "กลไกพื้นหลังตายเงียบ" ให้ได้ก่อนที่จะรู้ตัวจากผู้ใช้
 * (ต้นเรื่อง: phase-38 QStash region incident — feature ตาย 1 เดือนโดยไม่มีสัญญาณ)
 *
 * แยกออกจาก route handler เพื่อให้ test ยิงตรรกะได้โดยไม่ต้องผ่าน Next
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⛔ กฎที่เป็น gate (erratum §F) — ห้ามผ่อน:
 *   1. read-only QStash call ต้องผ่าน client ตัวเดียวกับที่ publish ใช้จริง
 *      → `probeQStashReadOnly()` ใน `@/lib/queue` (ห้ามประกอบ URL เอง)
 *   2. **ห้ามมี key ของ `NEXT_PUBLIC_*` ในไฟล์นี้เด็ดขาด**
 *   3. response ที่ไม่ auth ห้ามมี tenant identifier ใด ๆ **รวมถึงจำนวน tenant**
 *   4. ไม่พบ heartbeat = FAIL เสมอ ห้าม fallback เป็น PASS
 *   5. min-interval ของ live probe ต้องมีจริง — **เป็นเงื่อนไขความถูกต้องของตัวเลข
 *      โควตา** (erratum §D) ไม่ใช่แค่มาตรการกัน DoS: min-interval คือสิ่งเดียวที่ทำให้
 *      outbound call ต่อวันคงที่ ไม่ขึ้นกับจำนวนผู้เรียก ⇒ เพดาน 96/วัน เป็นเพดานจริง
 *      หลุดเมื่อไร blind spot ~9.6pp ของ headroom จะไม่ bounded อีกต่อไป
 *   6. marker ต้องอยู่ในเนื้อ response เสมอ — กฎ `INCONCLUSIVE` (§B(ค)) พึ่งมันตัวเดียว
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { timingSafeEqual } from "node:crypto";
import { redis } from "@/lib/redis";
import { prisma } from "@/lib/prisma";
import {
  getHeartbeatWriteFailure,
  readHeartbeats,
  recordHeartbeat,
} from "@/lib/heartbeat";
import { probeQStashReadOnly } from "@/lib/queue";
import {
  evaluateInboundCounters,
  getCounterWriteFailure,
  readInboundCounters,
  type HeartbeatFreshness,
  type InboundCounters,
} from "@/lib/inbound-counter";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * marker ที่พิสูจน์ว่า response มาจากโค้ดของเราจริง
 *
 * ⚠️ **ค่าอยู่ที่ `@/lib/readiness-verdict` ที่เดียว** — ฝั่งเขียน (ไฟล์นี้) กับฝั่งอ่าน
 *    (`scripts/readiness-check.ts` ของลำดับ 5) จึง import ค่าเดียวกันเสมอ
 *    ถ้าแยกกันเมื่อไร กฎ `INCONCLUSIVE` จะตายเงียบทันที (marker mismatch ทุกรอบ)
 */
export { READINESS_MARKER } from "@/lib/readiness-verdict";
import { READINESS_MARKER } from "@/lib/readiness-verdict";

/**
 * ระยะห่างขั้นต่ำระหว่าง live probe สองครั้ง (วินาที) — v2 §3 ข้อ 6
 * 300s = 5 นาที · cron จริงยิงทุก 15 นาที ⇒ ไม่ชนกันโดยปกติ
 * ดูกฎข้อ 5 ในหัวไฟล์ว่าทำไมตัวเลขนี้เป็นเรื่องความถูกต้อง ไม่ใช่แค่ rate limit
 */
export const LIVE_PROBE_MIN_INTERVAL_SECONDS = 300;

/**
 * snapshot เก่ากว่านี้ถือว่า STALE (วินาที)
 * 1800s = 30 นาที = พลาด cron 15 นาทีติดกัน 2 รอบ
 */
export const SNAPSHOT_STALE_AFTER_SECONDS = 1800;

/**
 * เพดานของ **read path**: memo snapshot ใน process นานเท่านี้ (มิลลิวินาที)
 *
 * ทำไมต้องมี: shape ที่ไม่ auth เปิดสาธารณะโดยจำเป็น (external pinger ลำดับ 6 ใช้)
 * ⇒ ถ้าอ่าน Redis ทุก request คนนอกยิงรัว ๆ = คำสั่ง Redis ไม่จำกัด
 * และ **Redis ไม่ใช่ของ P2 คนเดียว** — `src/proxy.ts` ใช้ทำ tenant lookup ทุก request
 * ของทั้งแอป ⇒ โควตา Redis หมด = ทั้งเว็บล่ม ไม่ใช่แค่ P2 ตาย
 * (รูปทรงเดียวกับบั๊ก counter คลาส 2 ที่ erratum §C แก้: คนนอกกดทรัพยากรที่มีมิเตอร์
 * ผ่าน endpoint สาธารณะ)
 *
 * นี่คือหลักการเดียวกับ min-interval ย้ายมาใช้กับ read path — ไม่ใช่กลไกใหม่
 *
 * ⚠️ **invariant: memo ต้องสั้นกว่าเกณฑ์ STALE มาก** ไม่งั้น memo จะกลายเป็นตัวถ่วง
 *    ที่ทำให้ค่าที่เสิร์ฟเก่าจนกระทบการตัดสิน STALE (มี test ค้ำ invariant นี้ไว้)
 */
export const SNAPSHOT_MEMO_TTL_MS = 10_000;

/**
 * id ของแถว singleton ใน `ReadinessState` — ทั้งระบบมีแถวเดียว (v2 §3 ข้อ 7)
 */
const SNAPSHOT_ROW_ID = "singleton";

/**
 * ⚠️ lock ของ min-interval **ยังอยู่บน Redis** หลังย้าย snapshot ไป Postgres แล้ว
 * เพราะต้องการ `SET NX EX` แบบ atomic ที่ราคาถูกและถูกต้องข้าม instance
 * ⇒ Redis ล่ม = จองคิวไม่ได้ = **ห้ามยิง live probe** (เพดานโควตาหาย) ⇒ FAIL
 *   แต่ snapshot ยังอยู่ครบใน Postgres ⇒ ไม่เสียความจำไปพร้อมกัน (erratum §H-1)
 */
const LIVE_PROBE_LOCK_KEY = "readiness:live-lock:v1";

/** ชื่อ header ของ shared secret ที่เปิดสิทธิ์ live probe */
export const READINESS_AUTH_HEADER = "x-readiness-token";

// =============================================================================
// TYPES
// =============================================================================

/**
 * สถานะ 4 ระดับ (erratum §E ลำดับ 2)
 *
 *   OK       — วัดสด ทุกอย่างปกติ ไม่มีข้อสังเกต
 *   DEGRADED — วัดได้ ระบบยังเดิน แต่มีข้อสังเกตที่ต้องมีคนดู (โควตา ≥80%,
 *              signature ปลอมเข้ามาแต่ delivery จริงยังผ่าน — erratum §C) → ลำดับ 3
 *   FAIL     — **ระบบพัง** (dependency ล่ม / ไม่พบ heartbeat / config หาย)
 *   STALE    — **วัดไม่ได้/ค่าที่มีเก่าเกินไป** ไม่ใช่ว่าระบบพัง แต่ต้องดังเท่ากัน
 *
 * ⚠️ ลำดับความรุนแรง: FAIL > STALE > DEGRADED > OK
 *    STALE อยู่เหนือ DEGRADED เพราะ "ไม่รู้" อันตรายกว่า "รู้ว่ามีข้อสังเกต"
 */
export type ReadinessStatus = "OK" | "DEGRADED" | "FAIL" | "STALE";

export type ComponentStatus = "ok" | "error" | "missing";

export interface ComponentReport {
  status: ComponentStatus;
  detail: string;
}

/** identity ของ deployment — ชื่อ env ทุกตัว confirm จากเอกสาร Vercel แล้ว (ดู getDeploymentIdentity) */
export interface DeploymentIdentity {
  deploymentId: string | null;
  commitSha: string | null;
  env: string | null;
  targetEnv: string | null;
}

/** snapshot ที่เก็บไว้หลัง live probe — shape ที่ไม่ auth เสิร์ฟค่านี้เท่านั้น */
export interface ReadinessSnapshot {
  status: ReadinessStatus;
  checkedAt: string;
  reasons: string[];
  components: Record<string, ComponentReport>;
  /** ตัวเลข counter ลำดับ 3 — `null` เมื่ออ่านไม่ได้ (ไม่ใช่ 0 ซึ่งจะอ่านเป็น "ปกติ") */
  counters: InboundCounters | null;
  deploymentId: string | null;
}

export interface ReadinessReport {
  /** สถานะที่รายงาน */
  status: ReadinessStatus;
  /** HTTP status ที่ควรตอบ — **เพื่อความสะดวกของ pinger ที่อ่าน body ไม่ได้เท่านั้น** */
  httpStatus: number;
  body: Record<string, unknown>;
}

// =============================================================================
// DEPLOYMENT IDENTITY
// =============================================================================

/**
 * อ่าน identity ของ deployment จาก Vercel system env
 *
 * ✅ ชื่อทุกตัว confirm จากเอกสาร Vercel แล้ว (erratum §F บังคับ "ห้ามเดาชื่อ"):
 *   - `VERCEL_DEPLOYMENT_ID`  https://vercel.com/docs/environment-variables/system-environment-variables
 *     "The unique identifier for the deployment … Available at both build and runtime"
 *   - `VERCEL_GIT_COMMIT_SHA` https://vercel.com/docs/git/vercel-for-bitbucket
 *     "the full Git SHA of the commit that triggered the deployment"
 *   - `VERCEL_ENV` / `VERCEL_TARGET_ENV`  (system environment variables, build + runtime)
 *
 * ⛔ **ห้ามใช้ `VERCEL_URL`** — เอกสาร Vercel ระบุตรง ๆ ว่า
 *    "This variable cannot be used in conjunction with Standard Deployment Protection"
 *    และโปรเจกต์นี้ confirm แล้วว่าอยู่โหมด **Standard Protection** (erratum §G ข้อ 5)
 *
 * คืน `null` ต่อตัวเมื่อไม่มีค่า (local dev) — ไม่ throw
 */
export function getDeploymentIdentity(): DeploymentIdentity {
  return {
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    env: process.env.VERCEL_ENV ?? null,
    targetEnv: process.env.VERCEL_TARGET_ENV ?? null,
  };
}

// =============================================================================
// AUTH (shared secret)
// =============================================================================

/** ผลการตรวจ auth — แยก "ไม่ส่งมา" ออกจาก "ส่งมาผิด" คนละทางเดินกัน */
export type AuthOutcome = "anonymous" | "authorized" | "invalid";

/**
 * ตรวจ shared secret จาก header
 *
 *   ไม่ส่ง header มาเลย → `anonymous` (เสิร์ฟค่าที่เก็บไว้ ห้าม trigger outbound)
 *   ส่งมาและตรง       → `authorized` (ทางเดียวที่ทำให้เกิด live probe)
 *   ส่งมาแต่ไม่ตรง     → `invalid` (401 — ไม่ใช่ fallback เป็น anonymous
 *                        เพราะจะกลบ misconfig ของ cron ให้เงียบ)
 *
 * ⚠️ ถ้า `READINESS_PROBE_TOKEN` ไม่ได้ตั้ง = ไม่มีใคร live probe ได้เลยตลอดกาล
 *    = P2 ตายเงียบ ⇒ token ที่ส่งมาถือว่า invalid และ `probeTokenConfigured()`
 *    จะทำให้สถานะเป็น FAIL (fail-loud ต่อผู้ดูแล)
 */
export function checkProbeAuth(headerValue: string | null): AuthOutcome {
  if (headerValue === null || headerValue === "") return "anonymous";

  const expected = process.env.READINESS_PROBE_TOKEN;
  if (!expected) return "invalid";

  const a = Buffer.from(headerValue);
  const b = Buffer.from(expected);
  // timingSafeEqual โยนถ้าความยาวไม่เท่า — เทียบความยาวก่อน (ความยาวไม่ใช่ความลับ)
  if (a.length !== b.length) return "invalid";
  return timingSafeEqual(a, b) ? "authorized" : "invalid";
}

/** token ถูกตั้งค่าไว้ไหม — ไม่ตั้ง = P2 live probe ทำงานไม่ได้เลย */
export function probeTokenConfigured(): boolean {
  return Boolean(process.env.READINESS_PROBE_TOKEN);
}

// =============================================================================
// HEARTBEAT (ลำดับ 4 — ยังไม่ทำ)
// =============================================================================

/**
 * อ่าน heartbeat ระดับ mechanism
 *
 * 🚧 **ลำดับ 4 ของ erratum §E ยังไม่ทำ** (Heartbeat table + `lastCheckAt` ของ P2 เอง)
 *    ⇒ ตอนนี้คืน `null` เสมอ ⇒ ตามกฎ §F **"ไม่พบ heartbeat = FAIL เสมอ ห้าม fallback
 *    เป็น PASS"** สถานะรวมของ live probe จะเป็น `FAIL` จนกว่าลำดับ 4 จะเสร็จ
 *    **นี่คือพฤติกรรมที่ตั้งใจ** — fail-closed ดีกว่ารายงาน OK จากข้อมูลที่ยังไม่มี
 *    ห้าม "ปิดชั่วคราว" ให้ผ่าน
 */
async function readMechanismHeartbeats(): Promise<ComponentReport> {
  // ⚠️ ไม่จับ error ที่นี่ — อ่านตาราง heartbeat ไม่ได้ = วัด corroboration ไม่ได้
  //    ต้องขึ้นไปถึงสถานะ (caller แปลงเป็น component error = FAIL) ห้ามกลืนเป็น ok
  const report = await readHeartbeats();
  return { status: report.status, detail: report.detail };
}

function heartbeatFreshness(report: ComponentReport): HeartbeatFreshness {
  if (report.status === "ok") return "fresh";
  if (report.status === "error") return "stale";
  return "unknown";
}

// =============================================================================
// SNAPSHOT STORE
// =============================================================================
/**
 * ที่เก็บ snapshot = ตาราง `ReadinessState` แถวเดียว (Postgres) — **ย้ายจาก Redis
 * แล้วในลำดับ 4** ตามที่ erratum §H-1 กำหนดไว้
 *
 * ผลที่ได้จากการย้าย: สถานะของ P2 ไม่อาศัยอยู่ใน dependency ที่ P2 เฝ้าอีกต่อไป
 * ⇒ Redis ล่ม = จองคิว live probe ไม่ได้ (FAIL ถูกต้อง) **แต่ยังอ่านผลตรวจล่าสุดได้**
 * ⇒ ไม่เสียทั้งการวัดและความจำพร้อมกันเหมือนตอนอยู่บน Redis
 *
 * memo (§H-2) ยังคงอยู่และสำคัญเท่าเดิม — ตอนนี้มันเป็นเพดานของ read path ที่ยิงลง
 * Postgres แทน ซึ่ง**ตรงกับสมมติฐานเดิมของ v2 §3 ข้อ 6** ("ยิงรัว ๆ ได้แค่ query DB ของเราเอง")
 */

/** ผลของการอ่าน snapshot — แยก "ไม่มี" ออกจาก "อ่านไม่ได้" เพราะสองอันนี้คนละสถานะ */
type SnapshotRead =
  | { kind: "value"; snapshot: ReadinessSnapshot }
  | { kind: "none" }
  | { kind: "error"; message: string };

/** memo ระดับ process — เพดานของ read path (ดู SNAPSHOT_MEMO_TTL_MS) */
let snapshotMemo: { at: number; result: SnapshotRead } | null = null;

/** ล้าง memo — ใช้ใน test เท่านั้น (process จริงไม่ต้องเรียก) */
export function __resetSnapshotMemoForTest(): void {
  snapshotMemo = null;
}

async function readSnapshotRaw(): Promise<SnapshotRead> {
  try {
    const row = await prisma.readinessState.findUnique({
      where: { id: SNAPSHOT_ROW_ID },
    });
    if (!row) return { kind: "none" };

    return {
      kind: "value",
      snapshot: {
        status: row.status as ReadinessStatus,
        checkedAt: row.lastCheckAt.toISOString(),
        reasons: row.reasons as unknown as string[],
        components: row.components as unknown as Record<string, ComponentReport>,
        counters: row.counters as unknown as InboundCounters | null,
        deploymentId: row.deploymentId,
      },
    };
  } catch (err) {
    // อ่าน store ไม่ได้ = ระบบพังจริง → FAIL (§F: ต้องมีทางออกไปถึงสถานะ)
    return { kind: "error", message: (err as Error).message.slice(0, 200) };
  }
}

/**
 * อ่าน snapshot ผ่าน memo — request ไม่จำกัดยุบเหลือ query ที่มีเพดาน
 *
 * memo ทั้งสามสถานะ (`value`/`none`/`error`) โดยตั้งใจ:
 * ถ้า memo เฉพาะกรณีเจอค่า คนนอกที่ยิงตอนยังไม่มี snapshot (หรือตอน store ล่ม)
 * จะยังทะลุไปถึง store ทุก request ⇒ เพดานหายไปในกรณีที่ต้องการเพดานที่สุด
 *
 * ⚠️ ราคาที่จ่าย: store ล่มจะถูกมองเห็นช้าได้ไม่เกิน `SNAPSHOT_MEMO_TTL_MS`
 *    (10 วินาที เทียบกับเกณฑ์ STALE 1800 วินาที — ไม่กระทบการตัดสิน)
 */
async function readSnapshot(): Promise<SnapshotRead> {
  const now = Date.now();
  if (snapshotMemo && now - snapshotMemo.at < SNAPSHOT_MEMO_TTL_MS) {
    return snapshotMemo.result;
  }
  const result = await readSnapshotRaw();
  snapshotMemo = { at: now, result };
  return result;
}

async function writeSnapshot(snapshot: ReadinessSnapshot): Promise<void> {
  const payload = {
    status: snapshot.status,
    lastCheckAt: new Date(snapshot.checkedAt),
    reasons: snapshot.reasons,
    components: snapshot.components as unknown as object,
    counters: (snapshot.counters ?? undefined) as unknown as object | undefined,
    deploymentId: snapshot.deploymentId,
  };

  await prisma.readinessState.upsert({
    where: { id: SNAPSHOT_ROW_ID },
    create: { id: SNAPSHOT_ROW_ID, ...payload },
    update: payload,
  });

  // live probe เพิ่งวัดสด — ดันเข้า memo ทันที ไม่ให้ memo เก่ากว่าค่าที่เพิ่งเขียน
  snapshotMemo = { at: Date.now(), result: { kind: "value", snapshot } };
}

/**
 * จอง slot ของ live probe — `SET NX EX` คือ min-interval ตัวจริง
 *
 * คืน `true` เฉพาะผู้ที่จองสำเร็จ ⇒ outbound call ต่อวันมีเพดานคงที่
 * ไม่ว่าจะมีผู้เรียกกี่คน (นี่คือเหตุผลที่ตัวเลข 96/วัน เป็นเพดานจริง — §D)
 *
 * ⚠️ throw ขึ้นไปให้ caller เมื่อ Redis พัง — **ห้ามกลืนแล้วยิง live probe ต่อ**
 *    เพราะ Redis พัง = ไม่มี min-interval = เพดานหาย = ตัวเลขโควตาไม่ bounded
 */
async function acquireLiveProbeSlot(): Promise<boolean> {
  const res = await redis.set(
    LIVE_PROBE_LOCK_KEY,
    "1",
    "EX",
    LIVE_PROBE_MIN_INTERVAL_SECONDS,
    "NX"
  );
  return res === "OK";
}

// =============================================================================
// LIVE PROBE
// =============================================================================

/** ping Redis พร้อม timeout สั้น — กัน endpoint ค้างถ้า Redis แขวน */
async function pingRedis(): Promise<ComponentReport> {
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("redis ping timeout")), 2000)
    );
    await Promise.race([redis.ping(), timeout]);
    return { status: "ok", detail: "ping ok" };
  } catch (err) {
    return { status: "error", detail: (err as Error).message.slice(0, 200) };
  }
}

/**
 * รวมสถานะจาก component + ข้อสังเกต → สถานะเดียว
 * FAIL > STALE > DEGRADED > OK
 */
export function rollUpStatus(
  components: Record<string, ComponentReport>,
  degradedReasons: string[]
): { status: ReadinessStatus; reasons: string[] } {
  const reasons: string[] = [];

  for (const [name, report] of Object.entries(components)) {
    if (report.status === "error") reasons.push(`${name}_error`);
    // 🔒 missing (โดยเฉพาะ heartbeat) = FAIL ตาม §F ห้าม fallback เป็น PASS
    if (report.status === "missing") reasons.push(`${name}_missing`);
  }

  if (reasons.length > 0) {
    return { status: "FAIL", reasons: [...reasons, ...degradedReasons] };
  }
  if (degradedReasons.length > 0) {
    return { status: "DEGRADED", reasons: degradedReasons };
  }
  return { status: "OK", reasons: [] };
}

/** ยิง live probe จริง (outbound) แล้วเขียน snapshot */
async function runLiveProbe(): Promise<ReadinessSnapshot> {
  const [qstash, redisReport, heartbeat] = await Promise.all([
    probeQStashReadOnly().then<ComponentReport>((r) => ({
      status: r.ok ? "ok" : "error",
      detail: r.detail,
    })),
    pingRedis(),
    readMechanismHeartbeats(),
  ]);

  const components: Record<string, ComponentReport> = {
    qstash,
    redis: redisReport,
    heartbeat,
  };

  // P2 เต้น heartbeat ของตัวเอง — ทำ **หลัง** อ่าน heartbeat แล้ว เพื่อไม่ให้รอบนี้
  // ประเมินจังหวะเต้นของตัวเองที่เพิ่งเขียนไปในรอบเดียวกัน
  // (external pinger ลำดับ 6 เฝ้า lastCheckAt ที่เขียนพร้อม snapshot ด้านล่าง)
  await recordHeartbeat("readiness-probe");

  // ── ลำดับ 3: inbound counter 2 ตัว (กฎ §C) ────────────────────────────────
  let counters: InboundCounters | null = null;
  const degradedReasons: string[] = [];
  try {
    counters = await readInboundCounters();
    const evaluation = evaluateInboundCounters(
      counters,
      heartbeatFreshness(heartbeat),
      // write ของ counter เคยล้มไหม — ถ้าล้ม ตัวเลขที่อ่านได้ต่ำกว่าความจริง
      getCounterWriteFailure()
    );
    if (evaluation.level === "FAIL") {
      // counter เรียกร้อง FAIL — เดินผ่าน component เพื่อให้ rollUp ยกระดับให้
      components.inbound = {
        status: "error",
        detail: evaluation.reasons.join(","),
      };
    } else {
      degradedReasons.push(...evaluation.reasons);
    }
  } catch (err) {
    // อ่าน counter ไม่ได้ = วัด headroom ไม่ได้ ⇒ ห้ามเงียบ (ไม่ใช่ OK)
    degradedReasons.push("inbound_counters_unavailable");
    console.error("[readiness] counter read failed:", (err as Error).message);
  }

  // heartbeat เขียนพลาด = จังหวะเต้นที่อ่านได้อาจเก่ากว่าความจริง ⇒ ห้ามเงียบเช่นกัน
  if (getHeartbeatWriteFailure() !== null) {
    degradedReasons.push("heartbeat_write_failed");
  }

  if (!probeTokenConfigured()) {
    // ตามนิยาม: ถ้าไป live probe ได้แปลว่า token ตั้งแล้ว — เก็บไว้กัน regression
    components.config = {
      status: "error",
      detail: "READINESS_PROBE_TOKEN is not set",
    };
  }

  const { status, reasons } = rollUpStatus(components, degradedReasons);

  return {
    status,
    checkedAt: new Date().toISOString(),
    reasons,
    components,
    counters,
    deploymentId: getDeploymentIdentity().deploymentId,
  };
}

// =============================================================================
// REPORT BUILDERS (สอง shape)
// =============================================================================

function ageSeconds(checkedAt: string): number {
  return Math.max(0, Math.round((Date.now() - Date.parse(checkedAt)) / 1000));
}

function httpStatusFor(status: ReadinessStatus): number {
  // ⛔ status code นี้มีไว้ให้ pinger ที่อ่าน body ไม่ได้เท่านั้น
  //    **ห้ามใครใช้เป็นหลักฐาน** — หลักฐานคือ marker + field `status` ในเนื้อ response
  //    (erratum §B(ค): ไม่พบ marker ⇒ INCONCLUSIVE ไม่ว่า status code จะเป็นอะไร)
  return status === "OK" || status === "DEGRADED" ? 200 : 503;
}

/**
 * shape ที่ **ไม่ auth** — เสิร์ฟค่าที่เก็บไว้เท่านั้น
 *
 * ⛔ ห้าม trigger outbound call แม้แต่ครั้งเดียวในทางเดินนี้
 * ⛔ ห้ามมี tenant identifier ใด ๆ **รวมถึงจำนวน tenant** และห้ามมี component detail
 *    (detail มี message ของ provider ซึ่งเป็น infra detail ที่คนนอกไม่ควรเห็น)
 *
 * ผู้ใช้ทางเดินนี้คือ external pinger (ลำดับ 6) ที่เฝ้าเฉพาะความสดของ `checkedAt`
 */
export async function buildAnonymousReport(): Promise<ReadinessReport> {
  const read = await readSnapshot();

  let status: ReadinessStatus;
  let checkedAt: string | null = null;
  let age: number | null = null;

  if (read.kind === "error") {
    // อ่าน snapshot ไม่ได้ = Redis พัง = ระบบพังจริง → FAIL (ไม่ใช่ STALE)
    status = "FAIL";
  } else if (read.kind === "none") {
    // ไม่เคยมีใคร live probe เลย = วัดไม่ได้ ไม่ใช่ระบบพัง → STALE (ดังเท่า FAIL)
    status = "STALE";
  } else {
    checkedAt = read.snapshot.checkedAt;
    age = ageSeconds(read.snapshot.checkedAt);
    status = age > SNAPSHOT_STALE_AFTER_SECONDS ? "STALE" : read.snapshot.status;
  }

  return {
    status,
    httpStatus: httpStatusFor(status),
    body: {
      data: {
        marker: READINESS_MARKER,
        status,
        // ชื่อ field = lastCheckAt ตามคำศัพท์ของดีไซน์ — external pinger (ลำดับ 6)
        // เฝ้า field นี้ · ตรงกับคอลัมน์ ReadinessState.lastCheckAt
        lastCheckAt: checkedAt,
        ageSeconds: age,
        staleAfterSeconds: SNAPSHOT_STALE_AFTER_SECONDS,
        // ⛔ ไม่มี deployment identity ในทางเดินนี้ — ผู้บริโภคทั้งหมดของ identity
        //    (ลำดับ 5 alias poll) ถือ token อยู่แล้วจึงอ่าน shape ที่ auth ได้
        //    ⇒ ไม่มีเหตุให้คนนอกเห็นข้อมูล infra (ตัดสิน 2026-08-08)
      },
      error: null,
    },
  };
}

/**
 * ขั้นตอนใน `buildAuthorizedReport()` ที่โยน error ได้ — **แยกไว้เพราะแต่ละขั้นคนละ dependency**
 *
 * 🔴 เดิม `catch` ก้อนเดียวครอบทั้งสามขั้นแล้วรายงานเป็น `redis` ทุกกรณี
 *    ⇒ Prisma โยน (เคสที่น่าจะเจอที่สุดตอนซ้อม: ตารางยังไม่ถูก apply) ออกมาเป็น
 *    "redis unavailable" ⇒ **เอกสารชี้ไปทางหนึ่ง เนื้อ response ชี้ไปอีกทาง**
 *    บนเส้นทางที่ทั้งเฟสสร้างมาเพื่อให้ "อ่านออกว่าอะไรพัง" (erratum §H-8)
 */
type LiveProbeStage = "lock" | "probe" | "write" | "read";

/**
 * stage → ตัวการที่ต้องรายงาน · **สถานะยังเป็น `FAIL` ทุกขั้น ไม่ผ่อนขั้นไหนทั้งสิ้น**
 * ที่เปลี่ยนคือ component key + reason + `liveProbeSkippedReason` ต้องตรงกับสิ่งที่เกิดจริง
 */
const STAGE_FAILURE: Record<
  LiveProbeStage,
  { component: string; reason: string; skippedReason: string }
> = {
  // จอง lock ไม่ได้ = Redis พัง ⇒ ไม่มี min-interval ⇒ **ห้ามยิง live probe**
  // (เพดานโควตาจะหาย — กฎข้อ 5 ในหัวไฟล์) · นี่คือกรณีเดียวที่ "suppressed" เป็นความจริง
  lock: {
    component: "redis",
    reason: "redis_error",
    skippedReason: "redis unavailable — live probe suppressed",
  },
  // live probe ยิงไปแล้วและโยนกลางทาง — **ไม่ได้ถูก suppress** ต้องไม่พูดว่า suppressed
  probe: {
    component: "probe",
    reason: "live_probe_error",
    skippedReason: "live probe threw mid-flight — ไม่ได้ถูกกัน (ดู components.probe)",
  },
  // วัดสำเร็จแล้วแต่เขียน snapshot ไม่ลง = Postgres ฝั่ง write (เช่น ตารางยังไม่ถูก apply)
  write: {
    component: "store",
    reason: "snapshot_write_error",
    skippedReason: "live probe ok แต่เขียน snapshot ไม่ได้ (store write)",
  },
  // ทาง min-interval: อ่าน snapshot ไม่ได้ = Postgres ฝั่ง read
  read: {
    component: "store",
    reason: "snapshot_read_error",
    skippedReason: "min-interval — และอ่าน snapshot ที่เก็บไว้ไม่ได้ (store read)",
  },
};

/**
 * shape ที่ **auth แล้ว** — รายละเอียดเต็ม + เป็นทางเดียวที่ทำให้เกิด live probe
 *
 * min-interval: จองไม่ได้ ⇒ เสิร์ฟ snapshot แทน (ไม่ยิง outbound)
 */
export async function buildAuthorizedReport(): Promise<ReadinessReport> {
  const identity = getDeploymentIdentity();

  let snapshot: ReadinessSnapshot | null = null;
  let source: "live" | "stored" = "stored";
  let skippedReason: string | null = null;

  // 🔑 stage ปัจจุบัน — ตัวชี้ว่า "ใครโยน" ตอนตกลง catch (ดู STAGE_FAILURE)
  let stage: LiveProbeStage = "lock";

  try {
    const gotSlot = await acquireLiveProbeSlot();
    if (gotSlot) {
      stage = "probe";
      snapshot = await runLiveProbe();
      stage = "write";
      await writeSnapshot(snapshot);
      source = "live";
    } else {
      skippedReason = "min-interval";
      stage = "read";
      const read = await readSnapshot();
      if (read.kind === "error") throw new Error(read.message);
      snapshot = read.kind === "value" ? read.snapshot : null;
    }
  } catch (err) {
    // สถานะเป็น FAIL ทุก stage เหมือนเดิม — ที่ต่างคือ **ชี้ตัวการให้ถูก**
    const failure = STAGE_FAILURE[stage];
    const components: Record<string, ComponentReport> = {
      [failure.component]: {
        status: "error",
        detail: `[${stage}] ${(err as Error).message.slice(0, 200)}`,
      },
    };
    return {
      status: "FAIL",
      httpStatus: httpStatusFor("FAIL"),
      body: {
        data: {
          marker: READINESS_MARKER,
          status: "FAIL",
          source: "unavailable",
          lastCheckAt: null,
          ageSeconds: null,
          liveProbeSkippedReason: failure.skippedReason,
          reasons: [failure.reason],
          components,
          deployment: identity,
          minIntervalSeconds: LIVE_PROBE_MIN_INTERVAL_SECONDS,
        },
        error: null,
      },
    };
  }

  if (!snapshot) {
    // ยังไม่มีใครวัดเลย และรอบนี้ก็ยิงไม่ได้เพราะ min-interval → วัดไม่ได้
    return {
      status: "STALE",
      httpStatus: httpStatusFor("STALE"),
      body: {
        data: {
          marker: READINESS_MARKER,
          status: "STALE",
          source: "stored",
          lastCheckAt: null,
          ageSeconds: null,
          liveProbeSkippedReason: skippedReason,
          reasons: ["no_snapshot"],
          components: {},
          deployment: identity,
          minIntervalSeconds: LIVE_PROBE_MIN_INTERVAL_SECONDS,
        },
        error: null,
      },
    };
  }

  const age = ageSeconds(snapshot.checkedAt);
  const status: ReadinessStatus =
    source === "stored" && age > SNAPSHOT_STALE_AFTER_SECONDS
      ? "STALE"
      : snapshot.status;

  return {
    status,
    httpStatus: httpStatusFor(status),
    body: {
      data: {
        marker: READINESS_MARKER,
        status,
        source,
        lastCheckAt: snapshot.checkedAt,
        ageSeconds: age,
        staleAfterSeconds: SNAPSHOT_STALE_AFTER_SECONDS,
        liveProbeSkippedReason: skippedReason,
        reasons: snapshot.reasons,
        components: snapshot.components,
        // ⛔ counters อยู่เฉพาะ shape ที่ auth — ตัวเลข inbound เป็นข้อมูล infra
        counters: snapshot.counters,
        deployment: identity,
        minIntervalSeconds: LIVE_PROBE_MIN_INTERVAL_SECONDS,
      },
      error: null,
    },
  };
}
