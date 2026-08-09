/**
 * scripts/readiness-check.ts
 * Phase 39 ลำดับ 5 (erratum §E) — ผู้อ่านผล probe ที่รันบน GitHub Actions
 *
 * รัน: `tsx scripts/readiness-check.ts <mode>`   mode = `post-deploy` | `scheduled`
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⛔ กฎที่เป็น gate — ตรรกะทั้งหมดอยู่ที่ `src/lib/readiness-verdict.ts` (มี unit test ค้ำ)
 *    ไฟล์นี้ทำแต่ I/O: ยิง HTTP · อ่าน/เขียน state · ส่ง Slack · ตั้ง exit code
 *    เหตุผลที่แยก: กฎที่เขียนใน shell/YAML คือกฎที่ไม่มี test ค้ำ และเป็นกฎที่ถ้าพลาดจะ "เงียบ" พอดี
 *
 *   1. **ห้ามใช้ HTTP status code เป็นหลักฐาน** — ตัดสินจาก marker + field `status` เท่านั้น
 *   2. ไม่พบ marker = `INCONCLUSIVE` — ห้ามนับ PASS ห้ามนับ FAIL · **ดังเท่า FAIL**
 *   3. **poll ที่โดเมน production เท่านั้น ห้าม `*.vercel.app`** (§F) — `*.vercel.app`
 *      ถูก Deployment Protection กัน (302) ⇒ อ่านผลผิด · ไฟล์นี้ปฏิเสธ base URL แบบนั้นตรง ๆ
 *   4. post-deploy: poll ครบเวลาแล้ว identity ยังไม่ตรง = **FAIL ที่ต้องแจ้ง**
 *      ⛔ ห้าม fallback เป็น "ข้ามไปก่อน"
 *   5. แจ้งแบบ transition-only **รวม recovery** (กลับมา OK ต้องแจ้ง)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ENV ที่ต้องมี (ตั้งเป็น GitHub secret — ดู .github/workflows/readiness.yml):
 *   PROD_BASE_URL         · origin ของโดเมน production เช่น https://gethelpwise.xyz
 *   READINESS_PROBE_TOKEN · shared secret ของ shape ที่ auth (ต้องตรงกับ env บน Vercel)
 *   SLACK_WEBHOOK_URL     · ปลายทางแจ้งเตือน
 *   EXPECTED_SHA          · (post-deploy เท่านั้น) commit sha ที่เพิ่ง deploy
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  classifyProbeResponse,
  CRON_INTERVAL_MINUTES,
  detectGap,
  identityMatches,
  isProductionProbeHost,
  LOUD_VERDICTS,
  shouldAlert,
  verdictHeadline,
  type ProbeVerdict,
  type Verdict,
} from "../src/lib/readiness-verdict";

// =============================================================================
// CONFIG
// =============================================================================

const PROBE_PATH = "/api/health/readiness";
const AUTH_HEADER = "x-readiness-token";

// ⚠️ `CRON_INTERVAL_MINUTES` ย้ายไป `@/lib/readiness-verdict` แล้ว (single source)
//    — `src/lib/heartbeat.ts` ใช้ค่าเดียวกันเป็นคาบที่คาดของ `readiness-probe` (§G ข้อ 13)

/** post-deploy: รอ alias สลับมาที่ deployment ใหม่ได้นานสุดเท่านี้ */
const IDENTITY_POLL_TIMEOUT_MS = 5 * 60_000;
const IDENTITY_POLL_INTERVAL_MS = 15_000;

const HTTP_TIMEOUT_MS = 20_000;

/** state ที่ข้ามรอบ — เก็บผ่าน actions/cache (ดู workflow) */
const STATE_FILE = ".readiness-state/state.json";

interface State {
  verdict: Verdict | null;
  lastRunAt: string | null;
}

// =============================================================================
// I/O HELPERS
// =============================================================================

function readState(): State {
  try {
    const raw = readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as State;
    return { verdict: parsed.verdict ?? null, lastRunAt: parsed.lastRunAt ?? null };
  } catch {
    // cache miss / ไฟล์เสีย = "ไม่รู้สถานะก่อนหน้า" ซึ่งเป็นค่าที่ shouldAlert() รองรับอยู่แล้ว
    return { verdict: null, lastRunAt: null };
  }
}

function writeState(state: State): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * ตรวจ base URL ก่อนยิง — §F: ห้าม poll ที่ `*.vercel.app`
 * ยอมให้พังตั้งแต่ต้นดีกว่าปล่อยให้ไปเจอ 302 แล้วอ่านผลผิดทุกรอบ
 */
function assertProductionHost(baseUrl: string): void {
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    throw new Error(`PROD_BASE_URL ไม่ใช่ URL ที่ถูกต้อง: ${baseUrl}`);
  }
  if (!isProductionProbeHost(host)) {
    throw new Error(
      `⛔ PROD_BASE_URL ชี้ไปที่ ${host} — ห้าม poll *.vercel.app (Deployment Protection ตอบ 302 ⇒ อ่านผลผิด) · ต้องใช้โดเมน production (erratum §F)`
    );
  }
}

async function fetchProbe(baseUrl: string, token: string | null): Promise<ProbeVerdict> {
  const url = `${baseUrl.replace(/\/+$/, "")}${PROBE_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: token ? { [AUTH_HEADER]: token } : {},
      signal: controller.signal,
      // ⛔ ห้ามตาม redirect — 302 ของ Deployment Protection จะพาไปหน้า SSO
      //    แล้วได้ 200 จากหน้าอื่น ซึ่งคือ false-PASS ที่ v2 §5 เตือนไว้ตรง ๆ
      redirect: "manual",
    });
    const bodyText = await res.text().catch(() => null);
    return classifyProbeResponse({ httpStatus: res.status, bodyText });
  } catch (err) {
    // ยิงไม่ถึงเลย = วัดไม่ได้ ไม่ใช่ "ระบบพัง" ที่พิสูจน์ได้ ⇒ INCONCLUSIVE
    const v = classifyProbeResponse({ httpStatus: null, bodyText: null });
    return { ...v, detail: `request failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function notifySlack(webhook: string, text: string): Promise<void> {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    // แจ้งเตือนส่งไม่ออก = ช่องเตือนพัง ⇒ ต้องทำให้ job แดง ไม่ใช่ log เฉย ๆ
    throw new Error(`ส่ง Slack ไม่สำเร็จ: http ${res.status}`);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`ไม่ได้ตั้ง env ${name}`);
  return value;
}

// =============================================================================
// MODES
// =============================================================================

/**
 * post-deploy: รอจน alias ของ production ชี้ deployment ที่มี commit ตามที่คาด
 * แล้วค่อยอ่านผล — ถ้าอ่านก่อน alias สลับ จะได้ผลของ deployment เก่าและอ่านผิด
 */
async function runPostDeploy(baseUrl: string, token: string): Promise<{
  verdict: Verdict;
  lines: string[];
}> {
  const expectedSha = requireEnv("EXPECTED_SHA");
  const deadline = Date.now() + IDENTITY_POLL_TIMEOUT_MS;
  let last: ProbeVerdict | null = null;
  let attempts = 0;

  while (Date.now() < deadline) {
    attempts++;
    last = await fetchProbe(baseUrl, token);
    if (identityMatches(last, expectedSha)) {
      return {
        verdict: last.verdict,
        lines: [
          `alias ชี้ ${expectedSha.slice(0, 8)} แล้ว (poll ${attempts} ครั้ง)`,
          `deploymentId: ${last.deploymentId ?? "—"}`,
          `ผล: ${last.detail}`,
        ],
      };
    }
    await new Promise((r) => setTimeout(r, IDENTITY_POLL_INTERVAL_MS));
  }

  // ⛔ ครบเวลาแล้ว identity ยังไม่ตรง = FAIL ที่ต้องแจ้ง ห้าม "ข้ามไปก่อน"
  //    (เคสจริงที่ข้อนี้ครอบ: deploy ไม่เคยขึ้น alias / alias ชี้ deployment เก่าค้าง
  //     / Protection เปลี่ยนโหมดจนอ่าน identity ไม่ได้เลย)
  return {
    verdict: last?.verdict === "INCONCLUSIVE" ? "INCONCLUSIVE" : "FAIL",
    lines: [
      `⛔ poll ครบ ${IDENTITY_POLL_TIMEOUT_MS / 60_000} นาทีแล้ว alias ยังไม่ชี้ ${expectedSha.slice(0, 8)}`,
      `เห็นล่าสุด: commitSha=${last?.commitSha ?? "—"} · ${last?.detail ?? "—"}`,
    ],
  };
}

/** scheduled: ยิง probe + in-band gap check */
async function runScheduled(
  baseUrl: string,
  token: string,
  state: State,
  now: Date
): Promise<{ verdict: Verdict; lines: string[] }> {
  const result = await fetchProbe(baseUrl, token);
  const gap = detectGap(state.lastRunAt, now, CRON_INTERVAL_MINUTES);

  const lines = [`ผล: ${result.detail}`, `lastCheckAt: ${result.lastCheckAt ?? "—"}`];
  if (gap.gapped) {
    // cron ตัวเองหายไป — ดังเท่ากับผลตรวจ ไม่ใช่หมายเหตุท้ายข้อความ
    lines.push(
      `🕳️ gap: workflow หายไป ${gap.missedRuns} รอบ (${gap.detail}) — ตัวเฝ้าเองเคยหยุด`
    );
  }
  return { verdict: result.verdict, lines };
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "post-deploy" && mode !== "scheduled") {
    throw new Error(`mode ไม่ถูกต้อง: ${mode} (ต้องเป็น post-deploy | scheduled)`);
  }

  const baseUrl = requireEnv("PROD_BASE_URL");
  assertProductionHost(baseUrl);
  const token = requireEnv("READINESS_PROBE_TOKEN");
  const webhook = requireEnv("SLACK_WEBHOOK_URL");

  const now = new Date();
  const state = readState();

  const { verdict, lines } =
    mode === "post-deploy"
      ? await runPostDeploy(baseUrl, token)
      : await runScheduled(baseUrl, token, state, now);

  const gapped = lines.some((l) => l.startsWith("🕳️"));
  const alerting = shouldAlert(state.verdict, verdict) || gapped;

  console.log(`[readiness-check] mode=${mode} verdict=${verdict} prev=${state.verdict ?? "—"}`);
  for (const l of lines) console.log(`  ${l}`);

  let alertDelivered = true;
  let alertError: string | null = null;

  if (alerting) {
    const header = verdictHeadline(verdict);
    const transition = `${state.verdict ?? "ไม่ทราบสถานะก่อนหน้า"} → ${verdict}`;
    try {
      await notifySlack(
        webhook,
        [`${header}`, `(${mode} · ${transition})`, ...lines, baseUrl + PROBE_PATH].join("\n")
      );
      console.log("[readiness-check] ส่ง Slack แล้ว");
    } catch (err) {
      alertDelivered = false;
      alertError = (err as Error).message;
      console.error(`[readiness-check] แจ้งเตือนส่งไม่ออก: ${alertError}`);
    }
  } else {
    console.log("[readiness-check] ไม่มี transition — ไม่แจ้ง (transition-only)");
  }

  // ── เขียน state เสมอ (แม้ step ก่อนหน้าจะล้ม) ─────────────────────────────
  // `lastRunAt` ต้องถูกบันทึกทุกรอบ ไม่งั้น in-band gap check จะเห็นเป็น "ไม่มีบันทึก"
  // ตลอดกาลและตรวจ gap ไม่ได้เลย
  //
  // 🔒 แต่ `verdict` **commit ก็ต่อเมื่อแจ้งออกไปจริงแล้ว** — ถ้า Slack ล่มแล้วเราจำ
  //    verdict ใหม่ไว้ รอบถัดไปจะเห็นว่า "ไม่มี transition" แล้วเงียบ
  //    ⇒ การแจ้งเตือนที่ส่งไม่ออกจะหายไปถาวร (ตกรูปเดิม: ความล้มเหลวกลบตัวเอง)
  //    ⇒ คงค่าเดิมไว้เพื่อให้รอบถัดไปยังมองเห็นเป็น transition แล้วแจ้งซ้ำ
  writeState({
    verdict: alertDelivered ? verdict : state.verdict,
    lastRunAt: now.toISOString(),
  });

  // FAIL กับ INCONCLUSIVE ดังเท่ากัน ⇒ job แดงเท่ากัน
  // แจ้งเตือนส่งไม่ออก = ช่องเตือนพัง ⇒ แดงด้วยเสมอ ไม่ว่า verdict จะเป็นอะไร
  if (LOUD_VERDICTS.includes(verdict) || !alertDelivered) {
    console.error(
      `[readiness-check] verdict=${verdict}${alertDelivered ? "" : " · alert ส่งไม่ออก"} — job แดง`
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[readiness-check]", (err as Error).message);
  process.exitCode = 1;
});
