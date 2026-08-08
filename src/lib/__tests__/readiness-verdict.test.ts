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
  shouldAlert,
  type Verdict,
} from "@/lib/readiness-verdict";

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

  it("FAIL → INCONCLUSIVE ต้องแจ้ง (คนละความหมาย แม้ดังเท่ากัน)", () => {
    expect(shouldAlert("FAIL", "INCONCLUSIVE")).toBe(true);
  });

  it("ไม่รู้สถานะก่อนหน้า (cache หาย) + OK → ไม่แจ้ง", () => {
    expect(shouldAlert(null, "OK")).toBe(false);
  });

  it("ไม่รู้สถานะก่อนหน้า + ไม่ปกติ → แจ้ง (ดังไว้ก่อน)", () => {
    for (const v of ["FAIL", "STALE", "DEGRADED", "INCONCLUSIVE"] as Verdict[]) {
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
