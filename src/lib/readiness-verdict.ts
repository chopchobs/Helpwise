/**
 * src/lib/readiness-verdict.ts
 * Phase 39 ลำดับ 5 (erratum §E) — **ตรรกะการอ่านผล probe** (ฝั่งผู้อ่าน ไม่ใช่ฝั่ง endpoint)
 *
 * ทำไมอยู่ใน `src/` ไม่ใช่ในไฟล์ workflow: กฎที่สำคัญที่สุดของลำดับ 5 คือกฎ
 * **`INCONCLUSIVE`** (erratum §B(ค)) — กฎที่เขียนเป็น shell/YAML คือกฎที่ไม่มี test ค้ำ
 * และเป็นกฎที่ถ้าพลาดจะ "เงียบ" พอดี ⇒ เอาส่วนที่เป็นตรรกะล้วนมาไว้ที่นี่ให้ unit test จับได้
 *
 * ⚠️ ไฟล์นี้ต้อง **ไม่มี dependency** (ไม่แตะ prisma/redis/next) — `scripts/readiness-check.ts`
 *    รันบน GitHub Actions ที่ไม่มี DATABASE_URL · import อะไรที่ต่อ DB จะ throw ตั้งแต่ import
 */

// =============================================================================
// MARKER — source of truth เดียวของทั้งฝั่ง endpoint และฝั่งผู้อ่าน
// =============================================================================

/**
 * marker ที่พิสูจน์ว่า response มาจากโค้ดของเราจริง
 *
 * ⚠️ นี่คือหลักฐานชิ้นเดียวที่กฎ `INCONCLUSIVE` ใช้ · `src/lib/readiness.ts` import ค่านี้ไปใช้
 *    ⇒ ฝั่งเขียนกับฝั่งอ่านใช้ค่าเดียวกันเสมอ (ถ้าแยกกันเมื่อไร กฎจะตายเงียบ)
 */
export const READINESS_MARKER = "helpwise.readiness.v1";

// =============================================================================
// CADENCE — single source of truth ของ "ผู้เฝ้าเต้นบ่อยแค่ไหน"
// =============================================================================

/**
 * คาบของ cron ที่รัน `scripts/readiness-check.ts` (นาที)
 *
 * 🔑 **ค่านี้อยู่ที่นี่เพราะมันเป็น "ข้อเท็จจริงร่วม" ของสองฝั่งที่ import กันตรง ๆ ไม่ได้:**
 *   · `scripts/readiness-check.ts` ใช้คำนวณ in-band gap check
 *   · `src/lib/heartbeat.ts` ใช้เป็น **คาบที่คาดของ `readiness-probe`**
 *     (P2 เต้น heartbeat ของตัวเองทุกครั้งที่ cron มาเรียก ⇒ คาบการเต้น = คาบของ cron)
 *
 * ⚠️ **ไฟล์นี้ต้องไม่มี dependency** — `readiness-check.ts` รันบน GitHub Actions ที่ไม่มี
 *    `DATABASE_URL` ⇒ ค่านี้จึงวางที่นี่ ไม่ใช่ใน `heartbeat.ts` (ซึ่ง import prisma)
 *
 * 🔴 **สนามที่สาม:** `cron:` ใน `.github/workflows/readiness.yml` **ผูกด้วย import ไม่ได้ (YAML)**
 *    ⇒ มี test อ่านไฟล์ workflow มาเทียบกับค่านี้ (`readiness-cadence.test.ts`)
 *    เหตุผล: ค่าที่ถูกคัดลอกไว้หลายที่โดยไม่มีอะไรผูก คือรูปทรงที่ทำให้เกิด §G ข้อ 13 พอดี
 */
export const CRON_INTERVAL_MINUTES = 15;

// =============================================================================
// VERDICT
// =============================================================================

/**
 * ผลที่ผู้อ่านสรุปได้
 *
 * 4 ค่าแรกมาจาก endpoint · `INCONCLUSIVE` เป็นของฝั่งผู้อ่านล้วน:
 * **response มีอยู่ แต่ไม่ได้มาจากโค้ดของเรา** (Deployment Protection / CDN / error page ตอบแทน)
 *
 * ⛔ `INCONCLUSIVE` **ห้ามนับเป็น PASS และห้ามนับเป็น FAIL** — และต้อง **ดังเท่า `FAIL`**
 *    ต่างกันแค่ข้อความ: `FAIL` = ระบบพัง ไปดูว่าอะไรพัง · `INCONCLUSIVE` = วัดไม่ได้
 *    ต้องมีคนไปดูว่าทำไมวัดไม่ได้ (erratum §B(ค))
 */
export type Verdict = "OK" | "DEGRADED" | "FAIL" | "STALE" | "INCONCLUSIVE";

/** verdict ที่ต้องส่งเสียงดัง — สองตัวนี้ดังเท่ากัน ต่างกันแค่ข้อความ */
export const LOUD_VERDICTS: readonly Verdict[] = ["FAIL", "INCONCLUSIVE"];

export interface ProbeResponse {
  /** HTTP status ที่ได้ · `null` = ยิงไม่ถึงเลย (network error/timeout) */
  httpStatus: number | null;
  /** เนื้อ response ดิบ · `null` = ไม่มีเนื้อ */
  bodyText: string | null;
}

export interface ProbeVerdict {
  verdict: Verdict;
  detail: string;
  /** deployment identity จากเนื้อ response — มีเฉพาะ shape ที่ auth */
  deploymentId: string | null;
  commitSha: string | null;
  /** `lastCheckAt` ที่ endpoint รายงาน (ISO) */
  lastCheckAt: string | null;
  /**
   * เหตุผลของสถานะ + component ที่ไม่ปกติ — **มีเฉพาะ shape ที่ auth**
   *
   * 🔴 **ทำไมต้องเก็บ (§H-13 · incident 2026-08-10):** ข้อความแจ้งเตือนเคยบอกแค่ *คำตัดสิน*
   * (`http 503: FAIL`) **ไม่บอกว่า component ไหนพัง** ⇒ ตอน incident ต้องไล่จากศูนย์
   * และ Vercel runtime log มี retention ~1 ชม. ⇒ **หน้าต่างที่จะรู้สาเหตุปิดไปพร้อมกัน**
   *
   * ⚠️ ค่าพวกนี้ **มีอยู่ในเนื้อ response อยู่แล้ว** — ของเดิมแค่โยนทิ้ง ไม่ใช่ข้อมูลใหม่
   */
  reasons: string[];
  /** component ที่ `status !== "ok"` เท่านั้น — ปกติเป็น array ว่าง */
  failingComponents: FailingComponent[];
}

export interface FailingComponent {
  name: string;
  status: string;
  detail: string;
}

const VALID_STATUSES = new Set(["OK", "DEGRADED", "FAIL", "STALE"]);

/** ตัดข้อความยาวให้พอดีหนึ่งบรรทัด — เพดาน ไม่ใช่ "พยายามสั้น" */
const DETAIL_MAX_CHARS = 90;

function truncate(text: string): string {
  return text.length <= DETAIL_MAX_CHARS ? text : `${text.slice(0, DETAIL_MAX_CHARS - 1)}…`;
}

/** `reasons` จากเนื้อ response — ทนกับ shape ที่ไม่ auth (ไม่มี field นี้) */
function readReasons(data: Record<string, unknown>): string[] {
  const raw = data.reasons;
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is string => typeof r === "string");
}

/**
 * component ที่ไม่ปกติ — **เฉพาะ `status !== "ok"`**
 *
 * ⛔ ไม่กรอง/ไม่ redact เนื้อ `detail` (§H-13 ตัดสินแล้ว): regex ที่ฆ่า `eu-central-1` ได้
 *    จะฆ่า `readiness-probe stale 8460s` ไปด้วย = ลบเหตุผลทั้งหมดของงานนี้
 *    · สิ่งที่ต้องกันจริง (tenant id / secret) **กันด้วยโครงสร้าง** — ไม่มี component ไหนแตะมันได้
 *    · รายการที่ยอมให้โผล่ = ตารางใน erratum §H-13 · มี test ค้ำว่า component ไม่งอกเพิ่มเงียบ ๆ
 */
function readFailingComponents(data: Record<string, unknown>): FailingComponent[] {
  const raw = data.components;
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => {
      const status = (v as { status?: unknown } | null)?.status;
      return typeof status === "string" && status !== "ok";
    })
    .map(([name, v]) => {
      const c = v as { status: string; detail?: unknown };
      return {
        name,
        status: c.status,
        detail: typeof c.detail === "string" ? truncate(c.detail) : "",
      };
    });
}

/**
 * อ่านผล probe เป็น verdict
 *
 * ⛔ **ห้ามใช้ HTTP status code เป็นหลักฐาน** — `httpStatus` ถูกใช้เฉพาะใน `detail`
 *    เพื่อการวินิจฉัยของมนุษย์เท่านั้น ไม่มีบรรทัดไหนตัดสิน verdict จากมัน
 *    (เหตุผล: `201` เคยดูเหมือนผ่านทั้งที่ระบบตายสนิท — phase-38 · และ `302` จาก
 *    Deployment Protection ก็มี "response" ครบถ้วนโดยที่แอปเราไม่เคยถูกเรียก)
 *
 * ทุกทางที่อ่าน marker ไม่ได้ ⇒ `INCONCLUSIVE` ไม่ว่า status code จะเป็น 200/302/401/500
 */
export function classifyProbeResponse(res: ProbeResponse): ProbeVerdict {
  const base = {
    deploymentId: null,
    commitSha: null,
    lastCheckAt: null,
    reasons: [] as string[],
    failingComponents: [] as FailingComponent[],
  };
  const codeNote = res.httpStatus === null ? "no response" : `http ${res.httpStatus}`;

  if (res.bodyText === null || res.bodyText.trim() === "") {
    return { ...base, verdict: "INCONCLUSIVE", detail: `${codeNote}: empty body` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.bodyText);
  } catch {
    // หน้า HTML ของ SSO / error page ของ CDN ตกทางนี้
    return { ...base, verdict: "INCONCLUSIVE", detail: `${codeNote}: body is not JSON` };
  }

  const data = (parsed as { data?: Record<string, unknown> })?.data;
  if (!data || typeof data !== "object") {
    return { ...base, verdict: "INCONCLUSIVE", detail: `${codeNote}: no data object` };
  }

  if (data.marker !== READINESS_MARKER) {
    // JSON ที่ถูกต้องแต่ไม่ใช่ของเรา — เช่น error envelope ของ proxy ชั้นหน้า
    return { ...base, verdict: "INCONCLUSIVE", detail: `${codeNote}: marker mismatch` };
  }

  const identity = {
    reasons: readReasons(data),
    failingComponents: readFailingComponents(data),
    deploymentId:
      (data.deployment as { deploymentId?: string } | undefined)?.deploymentId ?? null,
    commitSha:
      (data.deployment as { commitSha?: string } | undefined)?.commitSha ?? null,
    lastCheckAt: (data.lastCheckAt as string | null) ?? null,
  };

  // marker ถูกต้องแล้ว แต่ status ไม่ใช่ค่าที่รู้จัก = อ่านผลไม่ได้เช่นกัน
  if (typeof data.status !== "string" || !VALID_STATUSES.has(data.status)) {
    return {
      ...identity,
      verdict: "INCONCLUSIVE",
      detail: `${codeNote}: marker ok but status is not a known value`,
    };
  }

  return {
    ...identity,
    verdict: data.status as Verdict,
    detail: `${codeNote}: ${data.status}`,
  };
}

// =============================================================================
// IDENTITY MATCH (post-deploy poll)
// =============================================================================

/**
 * deployment ที่ตอบอยู่หลัง alias คือ commit ที่เพิ่ง push แล้วหรือยัง
 *
 * ต้องได้ marker ก่อน (ไม่งั้น `commitSha` ที่อ่านมาไม่ใช่ของเรา) และ sha ต้องตรงเป๊ะ
 */
export function identityMatches(v: ProbeVerdict, expectedSha: string): boolean {
  if (v.verdict === "INCONCLUSIVE") return false;
  if (!v.commitSha || !expectedSha) return false;
  return v.commitSha === expectedSha;
}

// =============================================================================
// TRANSITION RULE
// =============================================================================

/**
 * แจ้งเตือนไหม — **transition-only รวม recovery**
 *
 * | prev | curr | แจ้ง? |
 * | --- | --- | --- |
 * | เท่ากัน | เท่ากัน | ❌ ไม่แจ้ง (นี่คือทั้งประเด็นของ transition-only: กัน alert fatigue) |
 * | ต่างกัน | ใด ๆ | ✅ แจ้ง — **รวม `→ OK` (recovery ต้องแจ้ง)** |
 * | ไม่รู้ (`null`) | `OK` | ❌ ไม่แจ้ง — รอบแรก/cache หาย ไม่ควรทักทายด้วยเสียง |
 * | ไม่รู้ (`null`) | อื่น ๆ | ✅ แจ้ง — ไม่รู้ว่าเคยเป็นอะไร แต่ตอนนี้ไม่ปกติ ⇒ ดังไว้ก่อน |
 *
 * `STALE` เป็นสถานะจริง ⇒ `OK → STALE` เป็น transition ที่ยิงตามกฎเดิม ไม่มีข้อยกเว้น
 */
export function shouldAlert(prev: Verdict | null, curr: Verdict): boolean {
  if (prev === null) return curr !== "OK";
  return prev !== curr;
}

/** ข้อความของแต่ละ verdict — `FAIL` กับ `INCONCLUSIVE` ดังเท่ากัน ต่างกันแค่คำ */
export function verdictHeadline(v: Verdict): string {
  switch (v) {
    case "OK":
      return "✅ readiness กลับมาปกติ";
    case "DEGRADED":
      return "🟠 readiness DEGRADED — ระบบยังเดิน แต่มีข้อสังเกตที่ต้องมีคนดู";
    case "FAIL":
      return "🔴 readiness FAIL — ระบบพัง ไปดูว่าอะไรพัง";
    case "STALE":
      return "🟡 readiness STALE — ผลตรวจเก่าเกินไป ไม่มีอะไรวัดสดอยู่";
    case "INCONCLUSIVE":
      return "🔴 readiness INCONCLUSIVE — วัดไม่ได้ ต้องมีคนไปดูว่าทำไมวัดไม่ได้";
  }
}

// =============================================================================
// IN-BAND GAP CHECK
// =============================================================================

export interface GapResult {
  gapped: boolean;
  missedRuns: number;
  detail: string;
}

/**
 * cron ตัวเองหายไปหรือเปล่า — ตรวจ **ในช่องเดียวกัน** (in-band)
 *
 * ทำไมต้องมี: GitHub Actions ปิด scheduled workflow อัตโนมัติเมื่อ repo เงียบ 60 วัน
 * (erratum §A/§G) และ Actions เองก็ล่มได้ ⇒ **ตัวเฝ้าหายไปเงียบ ๆ** ซึ่งคือ failure mode
 * เดียวกับที่ทั้งเฟสนี้กำลังแก้ · เทียบกับ "รอบก่อนรันเมื่อไร" ที่เก็บใน state
 *
 * ⚠️ ครอบไม่ครบโดยธรรมชาติ: ถ้า cron **ไม่รันเลย** ก็ไม่มีใครมาเช็ค — ชั้นที่ครอบเคสนั้นคือ
 *    external pinger (ลำดับ 6) ที่อยู่นอก GitHub ทั้งหมด สองชั้นนี้เสริมกัน ไม่ทดแทนกัน
 */
export function detectGap(
  lastRunAt: string | null,
  now: Date,
  intervalMinutes: number
): GapResult {
  if (lastRunAt === null) {
    return { gapped: false, missedRuns: 0, detail: "no previous run recorded" };
  }
  const elapsedMs = now.getTime() - Date.parse(lastRunAt);
  if (Number.isNaN(elapsedMs)) {
    return { gapped: false, missedRuns: 0, detail: "unreadable previous run timestamp" };
  }
  const elapsedMinutes = elapsedMs / 60_000;
  const missedRuns = Math.max(0, Math.floor(elapsedMinutes / intervalMinutes) - 1);
  return {
    gapped: missedRuns >= 1, // ห่างตั้งแต่ 2 คาบขึ้นไป = พลาดอย่างน้อย 1 รอบ
    missedRuns,
    detail: `last run ${Math.round(elapsedMinutes)} min ago (interval ${intervalMinutes} min)`,
  };
}

// =============================================================================
// HOST GUARDS — สองเซตที่ต้องตัดกันเป็นเซตว่าง (erratum §H-6)
// =============================================================================

/**
 * host ที่ **เส้นทาง production** (`scripts/readiness-check.ts`) ยอมรับ
 * ⛔ ปฏิเสธ `*.vercel.app` — Deployment Protection ตอบ `302` ⇒ อ่านผลผิดทุกรอบ (§F)
 */
export function isProductionProbeHost(host: string): boolean {
  return host !== "" && !host.endsWith(".vercel.app");
}

/**
 * host ที่ **เส้นทาง rehearsal** (`scripts/readiness-rehearsal.ts`) ยอมรับ
 * บังคับว่าต้องเป็น `*.vercel.app` — กันเคสที่ร้ายที่สุด: เผลอรันซ้อมใส่ production
 */
export function isPreviewProbeHost(host: string): boolean {
  return host.endsWith(".vercel.app");
}
