/**
 * src/lib/__tests__/readiness-verdict.test.ts
 *
 * Phase 39 ลำดับ 5 — กฎการอ่านผล probe
 * ทุกเคสเป็น gate:
 *   · ห้ามใช้ HTTP status code เป็นหลักฐาน
 *   · ไม่พบ marker = INCONCLUSIVE ไม่ว่า status code จะเป็นอะไร
 *   · INCONCLUSIVE ดังเท่า FAIL
 *   · transition-only รวม recovery · STALE เป็นสถานะจริง
 */

import { describe, it, expect } from "vitest";
import {
  classifyProbeResponse,
  detectGap,
  identityMatches,
  LOUD_VERDICTS,
  READINESS_MARKER,
  isPreviewProbeHost,
  isProductionProbeHost,
  shouldAlert,
  type Verdict,
} from "@/lib/readiness-verdict";
import { KNOWN_COMPONENT_KEYS } from "@/lib/readiness";

function body(data: Record<string, unknown>): string {
  return JSON.stringify({ data, error: null });
}

const OK_BODY = body({
  marker: READINESS_MARKER,
  status: "OK",
  lastCheckAt: "2026-08-08T12:00:00.000Z",
  deployment: { deploymentId: "dpl_1", commitSha: "abc123" },
});

describe("⛔ ห้ามใช้ HTTP status code เป็นหลักฐาน", () => {
  it("200 แต่ไม่มี marker → INCONCLUSIVE (ไม่ใช่ PASS)", () => {
    // เคสจริง: ตาม redirect ของ Deployment Protection ไปจนได้ 200 จากหน้า SSO/marketing
    const r = classifyProbeResponse({ httpStatus: 200, bodyText: "<html>sso</html>" });
    expect(r.verdict).toBe("INCONCLUSIVE");
  });

  it("503 แต่ marker ครบและ status=FAIL → FAIL (อ่านจากเนื้อ ไม่ใช่จาก code)", () => {
    const r = classifyProbeResponse({
      httpStatus: 503,
      bodyText: body({ marker: READINESS_MARKER, status: "FAIL" }),
    });
    expect(r.verdict).toBe("FAIL");
  });

  it("200 พร้อม marker + status=STALE → STALE ไม่ใช่ OK", () => {
    const r = classifyProbeResponse({
      httpStatus: 200,
      bodyText: body({ marker: READINESS_MARKER, status: "STALE" }),
    });
    expect(r.verdict).toBe("STALE");
  });

  it("200 พร้อม marker + status=WATCHER_LATE → WATCHER_LATE ไม่ใช่ OK", () => {
    // 🔑 ข้อ 3: verdict ตัวใหม่ต้องอยู่ใน VALID_STATUSES ไม่งั้นจะกลายเป็น INCONCLUSIVE
    //    (= "อ่านผลไม่ได้") ซึ่งดังเท่า FAIL ⇒ จะกลบความหมายที่เพิ่งแยกออกมาทั้งหมด
    const r = classifyProbeResponse({
      httpStatus: 200,
      bodyText: body({ marker: READINESS_MARKER, status: "WATCHER_LATE" }),
    });
    expect(r.verdict).toBe("WATCHER_LATE");
  });

  it("status ที่ไม่รู้จัก → ยังเป็น INCONCLUSIVE (เส้นทางลบของข้อบน)", () => {
    const r = classifyProbeResponse({
      httpStatus: 200,
      bodyText: body({ marker: READINESS_MARKER, status: "WATCHER_SLOW" }),
    });
    expect(r.verdict).toBe("INCONCLUSIVE");
  });

  it("401 จากแอปเรา (มี marker) ยังอ่านได้ว่าไม่ใช่ INCONCLUSIVE ถ้ามี status", () => {
    // 401 ที่ไม่มี status = อ่านผลไม่ได้ → INCONCLUSIVE (แต่แยกจาก 'ไม่ถึงแอป' ได้ด้วย marker)
    const r = classifyProbeResponse({
      httpStatus: 401,
      bodyText: JSON.stringify({ data: { marker: READINESS_MARKER }, error: "unauthorized" }),
    });
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.detail).toContain("marker ok");
  });
});

describe("ไม่พบ marker = INCONCLUSIVE ทุกทาง", () => {
  const cases: [string, { httpStatus: number | null; bodyText: string | null }][] = [
    ["302 body ว่าง", { httpStatus: 302, bodyText: "" }],
    ["body เป็น null", { httpStatus: 200, bodyText: null }],
    ["ไม่ใช่ JSON", { httpStatus: 200, bodyText: "not json at all" }],
    ["JSON แต่ไม่มี data", { httpStatus: 200, bodyText: '{"hello":1}' }],
    ["marker ผิด", { httpStatus: 200, bodyText: body({ marker: "other", status: "OK" }) }],
    ["ยิงไม่ถึงเลย", { httpStatus: null, bodyText: null }],
    [
      "marker ถูกแต่ status ไม่รู้จัก",
      { httpStatus: 200, bodyText: body({ marker: READINESS_MARKER, status: "WEIRD" }) },
    ],
  ];

  for (const [name, input] of cases) {
    it(`${name} → INCONCLUSIVE`, () => {
      expect(classifyProbeResponse(input).verdict).toBe("INCONCLUSIVE");
    });
  }
});

describe("INCONCLUSIVE ต้องดังเท่า FAIL", () => {
  it("ทั้งสองอยู่ใน LOUD_VERDICTS", () => {
    expect(LOUD_VERDICTS).toContain("FAIL");
    expect(LOUD_VERDICTS).toContain("INCONCLUSIVE");
  });

  it("STALE/DEGRADED/OK ไม่อยู่ในกลุ่มที่ทำให้ job แดง", () => {
    // (ยังแจ้ง Slack ตาม transition — ดังคนละแกนกับ exit code)
    expect(LOUD_VERDICTS).not.toContain("STALE");
    expect(LOUD_VERDICTS).not.toContain("DEGRADED");
    expect(LOUD_VERDICTS).not.toContain("OK");
    // WATCHER_LATE = ผู้เฝ้าช้า ไม่ใช่ระบบพัง ⇒ ไม่ควรทำให้ job แดง
    // (ยังแจ้งตาม transition เหมือนเดิม — ⛔ ไม่ใช่การลดเสียง)
    expect(LOUD_VERDICTS).not.toContain("WATCHER_LATE");
  });
});

describe("transition-only รวม recovery", () => {
  it("สถานะเดิมซ้ำ → ไม่แจ้ง (กัน alert fatigue)", () => {
    expect(shouldAlert("FAIL", "FAIL")).toBe(false);
    expect(shouldAlert("OK", "OK")).toBe(false);
  });

  it("กลับมา OK → ต้องแจ้ง (recovery)", () => {
    expect(shouldAlert("FAIL", "OK")).toBe(true);
    expect(shouldAlert("STALE", "OK")).toBe(true);
  });

  it("OK → STALE ต้องแจ้ง (STALE เป็นสถานะจริง ไม่มีข้อยกเว้น)", () => {
    expect(shouldAlert("OK", "STALE")).toBe(true);
  });

  it("OK → WATCHER_LATE ต้องแจ้ง · และ WATCHER_LATE ซ้ำ → ไม่แจ้ง", () => {
    expect(shouldAlert("OK", "WATCHER_LATE")).toBe(true);
    expect(shouldAlert("WATCHER_LATE", "WATCHER_LATE")).toBe(false);
    expect(shouldAlert("WATCHER_LATE", "OK")).toBe(true); // recovery
  });

  it("FAIL ↔ WATCHER_LATE ต้องแจ้งทั้งสองทาง (คนละความหมายคนละที่ต้องไปดู)", () => {
    expect(shouldAlert("FAIL", "WATCHER_LATE")).toBe(true);
    expect(shouldAlert("WATCHER_LATE", "FAIL")).toBe(true);
  });

  it("FAIL → INCONCLUSIVE ต้องแจ้ง (คนละความหมาย แม้ดังเท่ากัน)", () => {
    expect(shouldAlert("FAIL", "INCONCLUSIVE")).toBe(true);
  });

  it("ไม่รู้สถานะก่อนหน้า (cache หาย) + OK → ไม่แจ้ง", () => {
    expect(shouldAlert(null, "OK")).toBe(false);
  });

  it("ไม่รู้สถานะก่อนหน้า + ไม่ปกติ → แจ้ง (ดังไว้ก่อน)", () => {
    for (const v of [
      "FAIL",
      "STALE",
      "DEGRADED",
      "WATCHER_LATE",
      "INCONCLUSIVE",
    ] as Verdict[]) {
      expect(shouldAlert(null, v)).toBe(true);
    }
  });
});

describe("identity match (post-deploy poll)", () => {
  it("sha ตรง → match", () => {
    expect(identityMatches(classifyProbeResponse({ httpStatus: 200, bodyText: OK_BODY }), "abc123")).toBe(true);
  });

  it("sha ไม่ตรง (alias ยังชี้ deployment เก่า) → ไม่ match", () => {
    expect(identityMatches(classifyProbeResponse({ httpStatus: 200, bodyText: OK_BODY }), "def456")).toBe(false);
  });

  it("INCONCLUSIVE → ไม่ match เด็ดขาด (sha ที่อ่านมาไม่ใช่ของเรา)", () => {
    const v = classifyProbeResponse({ httpStatus: 302, bodyText: "<html/>" });
    expect(identityMatches(v, "abc123")).toBe(false);
  });

  it("ไม่มี commitSha ใน response → ไม่ match (ไม่ใช่ผ่านเพราะเทียบไม่ได้)", () => {
    const v = classifyProbeResponse({
      httpStatus: 200,
      bodyText: body({ marker: READINESS_MARKER, status: "OK" }),
    });
    expect(identityMatches(v, "abc123")).toBe(false);
  });
});

describe("in-band gap check", () => {
  const now = new Date("2026-08-08T12:00:00.000Z");

  it("รันตามคาบปกติ → ไม่มี gap", () => {
    expect(detectGap("2026-08-08T11:45:00.000Z", now, 15).gapped).toBe(false);
  });

  it("หายไป 2 คาบ → gap (workflow เคยหยุด)", () => {
    const r = detectGap("2026-08-08T11:30:00.000Z", now, 15);
    expect(r.gapped).toBe(true);
    expect(r.missedRuns).toBe(1);
  });

  it("หายไปทั้งวัน → gap พร้อมจำนวนรอบที่พลาด", () => {
    const r = detectGap("2026-08-07T12:00:00.000Z", now, 15);
    expect(r.gapped).toBe(true);
    expect(r.missedRuns).toBe(95);
  });

  it("ไม่มีบันทึกรอบก่อน (รอบแรก/cache หาย) → ไม่ถือเป็น gap", () => {
    expect(detectGap(null, now, 15).gapped).toBe(false);
  });

  it("timestamp เสีย → ไม่ถือเป็น gap แต่บอกเหตุผลไว้", () => {
    const r = detectGap("ไม่ใช่วันที่", now, 15);
    expect(r.gapped).toBe(false);
    expect(r.detail).toContain("unreadable");
  });
});

describe("§H-6 — เซต host ของสองเส้นทางต้องตัดกันเป็นเซตว่าง", () => {
  const hosts = [
    "gethelpwise.xyz",
    "acme.gethelpwise.xyz",
    "helpwise-abc123-scope.vercel.app",
    "helpwise.vercel.app",
    "localhost:3000",
    "example.com",
  ];

  it("ไม่มี host ไหนที่ทั้งสองเส้นทางยอมรับพร้อมกัน", () => {
    // นี่คือคุณสมบัติที่ทำให้ "cron เรียก rehearsal ไม่ได้" เป็นจริงเชิงโครงสร้าง
    // ไม่ใช่ข้อตกลง — สลับ env กันแล้วสคริปต์ต้องปฏิเสธ ไม่ใช่ทำงานผิดเงียบ ๆ
    const both = hosts.filter((h) => isProductionProbeHost(h) && isPreviewProbeHost(h));
    expect(both).toEqual([]);
  });

  it("เส้นทาง production ปฏิเสธ *.vercel.app ทุกรูปแบบ", () => {
    expect(isProductionProbeHost("helpwise-abc123-scope.vercel.app")).toBe(false);
    expect(isProductionProbeHost("gethelpwise.xyz")).toBe(true);
  });

  it("เส้นทาง rehearsal ปฏิเสธโดเมน production", () => {
    expect(isPreviewProbeHost("gethelpwise.xyz")).toBe(false);
    expect(isPreviewProbeHost("helpwise-abc123-scope.vercel.app")).toBe(true);
  });
});

// =============================================================================
// §H-13 — ข้อความแจ้งเตือนต้องบอก "สาเหตุ" ไม่ใช่แค่ "คำตัดสิน"
// =============================================================================

/**
 * 🔴 ที่มา: incident 2026-08-10 — ข้อความตอน `FAIL` บอกแค่ `ผล: http 503: FAIL`
 * ⇒ ไม่มีใครรู้ว่า component ไหนพัง ⇒ ไล่หาทั้งวัน และ Vercel runtime log
 * มี retention ~1 ชม. ⇒ หลักฐานตอนเริ่มเหตุหายไปก่อนจะเริ่มไล่
 *
 * ข้อมูลนี้ **อยู่ในเนื้อ response อยู่แล้ว** — ของเดิมแค่โยนทิ้ง
 */
describe("§H-13 — เก็บ reasons + component ที่ไม่ปกติ จากเนื้อ response", () => {
  const FAIL_BODY = body({
    marker: READINESS_MARKER,
    status: "FAIL",
    lastCheckAt: "2026-08-10T02:12:25.468Z",
    reasons: ["heartbeat_error"],
    components: {
      qstash: { status: "ok", detail: "reachable" },
      redis: { status: "ok", detail: "pong" },
      heartbeat: { status: "error", detail: "readiness-probe stale 8460s" },
    },
  });

  it("เก็บเฉพาะ component ที่ `status !== 'ok'`", () => {
    const v = classifyProbeResponse({ httpStatus: 503, bodyText: FAIL_BODY });

    expect(v.verdict).toBe("FAIL");
    expect(v.reasons).toEqual(["heartbeat_error"]);
    // 🔑 ของที่ปกติต้องไม่โผล่ — ไม่งั้นบรรทัดเดียวจะยาวเท่าทั้ง report
    expect(v.failingComponents.map((c) => c.name)).toEqual(["heartbeat"]);
    expect(v.failingComponents[0].detail).toBe("readiness-probe stale 8460s");
  });

  it("`OK` ที่ไม่มี component เสีย ⇒ ไม่มีอะไรให้พูด (บรรทัดนี้จะไม่ถูกสร้าง)", () => {
    const v = classifyProbeResponse({ httpStatus: 200, bodyText: OK_BODY });
    expect(v.reasons).toEqual([]);
    expect(v.failingComponents).toEqual([]);
  });

  it("truncate `detail` ที่ยาวเกินเพดาน — และยังอ่านออกว่าเป็นเรื่องอะไร", () => {
    const long = "x".repeat(500);
    const v = classifyProbeResponse({
      httpStatus: 503,
      bodyText: body({
        marker: READINESS_MARKER,
        status: "FAIL",
        components: { redis: { status: "error", detail: long } },
      }),
    });
    // เพดาน 90 ตัวอักษร — ค้ำว่า "มีเพดาน" ไม่ใช่ค้ำตัวเลขเป๊ะ
    expect(v.failingComponents[0].detail.length).toBeLessThanOrEqual(90);
    expect(v.failingComponents[0].detail.endsWith("…")).toBe(true);
  });

  it("ทนกับ shape ที่ไม่มี `reasons`/`components` (ทางเดินที่ไม่ auth) — ไม่โยน", () => {
    // ⚠️ checker ถือ token เสมอ แต่ห้ามพังถ้าวันหนึ่งได้ shape ที่ไม่ auth มา
    const v = classifyProbeResponse({ httpStatus: 200, bodyText: OK_BODY });
    expect(v.reasons).toEqual([]);
    expect(v.failingComponents).toEqual([]);
  });

  it("`components` ที่รูปร่างเพี้ยน (ไม่ใช่ object / ไม่มี status) ⇒ ข้าม ไม่โยน", () => {
    const v = classifyProbeResponse({
      httpStatus: 503,
      bodyText: body({
        marker: READINESS_MARKER,
        status: "FAIL",
        components: { weird: "not-an-object", half: { detail: "no status" } },
      }),
    });
    expect(v.failingComponents).toEqual([]);
  });
});

// =============================================================================
// §H-13 ประตู — รายชื่อ component ห้ามงอกเงียบ ๆ
// =============================================================================

/**
 * 🚪 **ทำไมข้อนี้ถึงเป็น gate ไม่ใช่ nice-to-have**
 *
 * §H-13 ตัดสินว่า **ไม่ redact `components[].detail`** ก่อนส่งเข้าห้องแจ้งเตือน
 * โดยอ้างเหตุผลเดียว: *"สิ่งที่ต้องกันจริง (tenant id / secret) กันด้วยโครงสร้าง —
 * ไม่มี component ไหนแตะมันได้"*
 * ⇒ **ข้ออ้างนั้นเป็นจริงเฉพาะกับรายชื่อชุดปัจจุบัน** ⇒ component ใหม่ที่งอกเงียบ ๆ
 *   ทำให้ข้ออ้างพังโดยไม่มีใครรู้ ⇒ **ข้อมูลหลุดเข้าห้องแบบที่ไม่มีใครตัดสินใจให้หลุด**
 *
 * สองชั้นที่บังคับ:
 *   1. **TypeScript** — `ComponentMap` ถูก type ด้วย key ชุดนี้ ⇒ เพิ่ม key = คอมไพล์ไม่ผ่าน
 *   2. **test นี้** — เทียบลิสต์กับตารางใน §H-13 ⇒ แก้ลิสต์ = แดง = ถูกบังคับให้กลับไปอ่าน
 *
 * 📌 **ชั้น 1 พิสูจน์ตัวเองแล้วตอนเขียน (2026-08-10):** ลิสต์ฉบับแรกมี 4 ตัว
 *    (`qstash` `redis` `heartbeat` `config`) — **คอมไพเลอร์จับได้ทันทีว่าขาด `inbound`**
 *    และการไล่ `STAGE_FAILURE` พบอีกสอง (`probe` `store`) ⇒ **ของจริงคือ 7 ไม่ใช่ 4**
 *    ⇒ ถ้าเขียนเป็น test อย่างเดียวโดยไม่ผูก type ลิสต์ที่ผิดจะผ่านไปเงียบ ๆ
 */
describe("§H-13 ประตู — `KNOWN_COMPONENT_KEYS` ต้องตรงกับตารางที่ตัดสินไว้", () => {
  it("รายชื่อตรงเป๊ะ — เพิ่ม/ลบเมื่อไรต้องกลับไปทบทวนตารางใน §H-13 ก่อน", () => {
    expect([...KNOWN_COMPONENT_KEYS].sort()).toEqual(
      ["config", "heartbeat", "inbound", "probe", "qstash", "redis", "store"].sort()
    );
  });

  it("ไม่มีชื่อซ้ำ — key ซ้ำจะทำให้ component หนึ่งทับอีกอันเงียบ ๆ", () => {
    expect(new Set(KNOWN_COMPONENT_KEYS).size).toBe(KNOWN_COMPONENT_KEYS.length);
  });
});
