/**
 * scripts/readiness-rehearsal.ts
 * Phase 39 ลำดับ 7 (erratum §E) — ซ้อมทำซ้ำได้: reproduce incident §2.3 บน **Preview**
 *
 * รัน: `tsx scripts/readiness-rehearsal.ts`
 * ⛔ **ยังรันไม่ได้จนกว่างานมือของ Dev จะครบ** — ดู `.claude/specs/phase-39-rehearsal-runbook.md`
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ไฟล์นี้แยกจาก `readiness-check.ts` โดยตั้งใจ (erratum §H-6) — **ไม่ใช่เพื่อความสะอาด
 * แต่เพื่อให้ "cron/post-deploy เรียกเส้นทางนี้ไม่ได้" เป็นจริงเชิงโครงสร้าง:**
 *
 *   · `readiness-check.ts`  → `assertProductionHost()` **ปฏิเสธ** `*.vercel.app`
 *   · ไฟล์นี้              → `assertPreviewHost()`   **บังคับว่าต้องเป็น** `*.vercel.app`
 *   ⇒ เซตของ host ที่สองสคริปต์ยอมรับ **ตัดกันเป็นเซตว่าง** ⇒ สลับเป้าหมายกันไม่ได้
 *     แม้ตั้ง env ผิด · ไม่ใช่ flag ที่เผลอเปิดได้
 *   · และไฟล์นี้ถูกเรียกจาก workflow ที่มี `workflow_dispatch` อย่างเดียว (ไม่มี schedule)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * สิ่งที่ซ้อม: ถอด `QSTASH_URL` ออกจาก Preview scope → deploy → probe ต้องรายงาน
 * **สาเหตุจริงของ incident** ไม่ใช่แค่ "พัง"
 *
 * ⛔ **เกณฑ์ตัดสินต้องเป็น error signature เฉพาะ ไม่ใช่แค่ `status === "FAIL"`**
 *    เหตุผล: ตอนนี้มีอีกหลายทางที่ทำให้ FAIL ได้ (ตารางยังไม่ถูก apply, heartbeat ยังไม่เต้น,
 *    token ไม่ตรง) ⇒ ถ้ารับ `FAIL` เฉย ๆ เป็นผ่าน เราจะ **ซ้อมสำเร็จโดยไม่ได้ทดสอบอะไรเลย**
 *    ซึ่งเป็นความผิดพลาดชนิดเดียวกับที่ทั้งเฟสนี้ป้องกันอยู่
 *
 * ENV:
 *   PREVIEW_BASE_URL                · URL ของ Preview deployment (ต้องเป็น *.vercel.app)
 *   VERCEL_AUTOMATION_BYPASS_SECRET · Protection Bypass token (erratum §B(ค) ทาง A)
 *   READINESS_PROBE_TOKEN           · shared secret ของ shape ที่ auth
 */

import {
  classifyProbeResponse,
  isPreviewProbeHost,
  type ProbeVerdict,
} from "../src/lib/readiness-verdict";

const PROBE_PATH = "/api/health/readiness";
const AUTH_HEADER = "x-readiness-token";
/** header ของ Protection Bypass — confirm จากหน้า Vercel Project Settings (erratum §G ข้อ 5) */
const BYPASS_HEADER = "x-vercel-protection-bypass";

/**
 * ลายเซ็นของ incident ที่กำลังซ้อม reproduce — phase-38 §2.1
 * **นี่คือเกณฑ์ตัดสินตัวจริง** ไม่ใช่ `status === "FAIL"`
 */
const EXPECTED_ERROR_SIGNATURE = /not found in this region \(eu-central-1\)/i;

/**
 * ⛔ ตรงข้ามกับ `assertProductionHost()` ใน readiness-check.ts อย่างสมบูรณ์
 * เส้นทางนี้ยิงได้**เฉพาะ** Preview — ตั้ง env เป็นโดเมน production เมื่อไร ปฏิเสธทันที
 * (กันเคสที่ร้ายที่สุด: เผลอรันซ้อมใส่ production)
 */
function assertPreviewHost(baseUrl: string): void {
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    throw new Error(`PREVIEW_BASE_URL ไม่ใช่ URL ที่ถูกต้อง: ${baseUrl}`);
  }
  if (!isPreviewProbeHost(host)) {
    throw new Error(
      `⛔ PREVIEW_BASE_URL ต้องเป็น *.vercel.app เท่านั้น (ได้ ${host}) — สคริปต์ซ้อมยิงเข้า production ไม่ได้เด็ดขาด (erratum §H-6)`
    );
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`ไม่ได้ตั้ง env ${name}`);
  return value;
}

async function probePreview(
  baseUrl: string,
  probeToken: string,
  bypass: string
): Promise<{ verdict: ProbeVerdict; raw: string | null }> {
  const url = `${baseUrl.replace(/\/+$/, "")}${PROBE_PATH}`;
  const res = await fetch(url, {
    headers: {
      [AUTH_HEADER]: probeToken,
      [BYPASS_HEADER]: bypass,
    },
    // ⛔ ห้ามตาม redirect — ตามไปจะได้ 200 จากหน้า SSO แล้วอ่านผิดว่าผ่าน
    redirect: "manual",
  });
  const raw = await res.text().catch(() => null);
  return {
    verdict: classifyProbeResponse({ httpStatus: res.status, bodyText: raw }),
    raw,
  };
}

/** ผลของการซ้อม — สามค่า ไม่ใช่สอง */
type RehearsalOutcome = "PROVEN" | "INCONCLUSIVE" | "INVALID";

interface RehearsalResult {
  outcome: RehearsalOutcome;
  lines: string[];
}

function evaluate(verdict: ProbeVerdict, raw: string | null): RehearsalResult {
  const lines: string[] = [`probe: ${verdict.detail}`];

  // 1) INCONCLUSIVE มี **สองสาเหตุที่ต่างกันคนละเรื่อง** — แยกด้วย 401
  //    (ก) ไม่มี marker  = Protection กินไปก่อนถึงแอป / bypass ผิด ⇒ ยังไม่ถึงโค้ดเรา
  //    (ข) มี marker แต่ 401 = **ถึงโค้ดเราแล้ว** แต่ READINESS_PROBE_TOKEN ไม่ตรง
  //        (route ตอบ marker + error ไม่มี field `status` ⇒ classify เป็น INCONCLUSIVE)
  //    เดิมชี้ไป bypass/deployment อย่างเดียว ⇒ ส่งคนไปแก้ผิดที่ทุกครั้งที่ token ไม่ตรง
  if (verdict.verdict === "INCONCLUSIVE") {
    const unauthorized = verdict.detail.includes("http 401");
    return {
      outcome: "INCONCLUSIVE",
      lines: [
        ...lines,
        ...(unauthorized
          ? [
              "⇒ 401 พร้อม marker = **ถึงโค้ดของเราแล้ว** แต่ token ไม่ตรง (ไม่ใช่ปัญหา bypass)",
              "   เช็ค: READINESS_PROBE_TOKEN ที่ GitHub secret ตรงกับที่ตั้งบน Vercel ไหม (runbook C2/C3)",
              "   ⚠️ env ที่เพิ่งตั้งไม่มีผลกับ deployment เดิม — ต้อง redeploy ก่อน (runbook C4)",
            ]
          : [
              "⇒ อ่าน marker ไม่ได้ — ยังไม่ถึงโค้ดของเราเลย",
              "   เช็ค: VERCEL_AUTOMATION_BYPASS_SECRET ถูกต้องไหม · Preview deployment ขึ้นแล้วจริงไหม (runbook B/A)",
            ]),
        "   ⛔ ห้ามนับเป็นผ่าน และห้ามนับเป็นไม่ผ่าน (erratum §B(ค))",
      ],
    };
  }

  // 2) ต้องเป็น FAIL — แต่ FAIL เฉย ๆ ยังไม่พอ
  if (verdict.verdict !== "FAIL") {
    return {
      outcome: "INVALID",
      lines: [
        ...lines,
        `⇒ คาดว่าจะได้ FAIL แต่ได้ ${verdict.verdict}`,
        "   แปลว่า QSTASH_URL อาจยังไม่ถูกถอดออกจาก Preview scope หรือยังไม่ได้ redeploy",
      ],
    };
  }

  // 3) 🔑 เกณฑ์ตัวจริง: ลายเซ็นของ error ต้องตรงกับ incident ที่กำลัง reproduce
  const matched = raw !== null && EXPECTED_ERROR_SIGNATURE.test(raw);
  if (!matched) {
    return {
      outcome: "INVALID",
      lines: [
        ...lines,
        "⇒ ได้ FAIL แต่ **ไม่พบ error signature ที่คาด** — ซ้อมนี้ไม่ได้พิสูจน์อะไร",
        `   คาด: ${EXPECTED_ERROR_SIGNATURE}`,
        "   FAIL นี้น่าจะมาจากสาเหตุอื่น เช่น ตารางยังไม่ถูก apply บน DB ของ Preview /",
        "   heartbeat ยังไม่เคยเต้น / token ไม่ตรง ⇒ ต้องแก้ prerequisite ให้ครบก่อนซ้อมใหม่",
        "   (ดู runbook: migration ต้องถูก apply กับ DB ที่ Preview ใช้ **ก่อน** ซ้อม)",
      ],
    };
  }

  return {
    outcome: "PROVEN",
    lines: [
      ...lines,
      "✅ FAIL พร้อม error signature ตรงกับ incident §2.1",
      "   ⇒ probe จับสาเหตุจริงได้ ไม่ใช่แค่รายงานว่าพัง",
    ],
  };
}

async function main(): Promise<void> {
  const baseUrl = requireEnv("PREVIEW_BASE_URL");
  assertPreviewHost(baseUrl);
  const probeToken = requireEnv("READINESS_PROBE_TOKEN");
  const bypass = requireEnv("VERCEL_AUTOMATION_BYPASS_SECRET");

  console.log(`[rehearsal] ยิง ${baseUrl}${PROBE_PATH}`);
  const { verdict, raw } = await probePreview(baseUrl, probeToken, bypass);
  const result = evaluate(verdict, raw);

  for (const l of result.lines) console.log(`  ${l}`);
  console.log(`[rehearsal] ผล: ${result.outcome}`);

  if (result.outcome !== "PROVEN") {
    console.error(
      "[rehearsal] ⛔ ยังพิสูจน์ไม่ได้ — ห้ามถือว่าซ้อมผ่าน · แก้ prerequisite แล้วซ้อมใหม่"
    );
    process.exitCode = 1;
  }

  console.log(
    "\n⚠️ อย่าลืมขั้นตอนสุดท้าย: ตั้ง QSTASH_URL กลับคืน Preview scope แล้ว redeploy\n" +
      "   (v2 §5 ข้อ 7 — ห้ามปล่อย Preview ค้างในสภาพพัง)"
  );
}

main().catch((err) => {
  console.error("[rehearsal]", (err as Error).message);
  process.exitCode = 1;
});
