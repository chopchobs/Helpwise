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
}

const VALID_STATUSES = new Set(["OK", "DEGRADED", "FAIL", "STALE"]);

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
