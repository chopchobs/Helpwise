/**
 * GET /api/health/readiness
 *
 * Phase 39 ลำดับ 2 (erratum §E) — readiness probe ระดับ ops (P2)
 * ตรวจว่ากลไกพื้นหลัง (QStash queue, Redis, heartbeat ของ mechanism) ยังมีชีวิตจริง
 * ไม่ใช่แค่ app ตอบ 200 ได้
 *
 * ทำไม path นี้: `/api/health` อยู่ใน `SKIP_TENANT_PATH_PREFIXES` แล้ว
 * (`src/proxy.ts:84` + เงื่อนไข 207-209) ⇒ endpoint นี้ไม่เดินผ่าน tenant pipeline
 * **โดยไม่ต้องแก้ proxy สักบรรทัด** — erratum §B(ข) · ค้ำด้วย
 * `src/lib/__tests__/proxy-skip-readiness.test.ts`
 *
 * สอง shape (erratum §E ลำดับ 2):
 *   - ไม่ส่ง `x-readiness-token` → ค่าที่เก็บไว้เท่านั้น · **ไม่มี outbound call**
 *     · ไม่มี tenant identifier ใด ๆ (external pinger ลำดับ 6 ใช้ทางนี้)
 *   - ส่ง token ที่ถูก → รายละเอียดเต็ม · เป็นทางเดียวที่ทำให้เกิด live probe
 *     (ยังผ่าน min-interval อีกชั้น)
 *   - ส่ง token ผิด → 401 (ไม่ fallback เป็น anonymous — จะกลบ misconfig ของ cron)
 *
 * ⛔ **ผู้อ่านผลห้ามใช้ HTTP status code เป็นหลักฐาน** (erratum §B(ค)) —
 *    ไม่พบ `marker` ในเนื้อ response ⇒ `INCONCLUSIVE` ไม่ว่าจะได้ 200/302/401
 *    (กรณี Deployment Protection ตอบแทนแอปเรา)
 * ⛔ ห้ามมี key ของ `NEXT_PUBLIC_*` ในไฟล์นี้
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  READINESS_AUTH_HEADER,
  READINESS_MARKER,
  buildAnonymousReport,
  buildAuthorizedReport,
  checkProbeAuth,
} from "@/lib/readiness";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // ioredis + QStash client ใช้ Edge runtime ไม่ได้

export async function GET(request: NextRequest) {
  const outcome = checkProbeAuth(request.headers.get(READINESS_AUTH_HEADER));

  if (outcome === "invalid") {
    // ใส่ marker ไว้ด้วย: ผู้อ่านจะได้แยก "แอปเราปฏิเสธ" ออกจาก
    // "Deployment Protection กินไปก่อนถึงแอป" (= INCONCLUSIVE) ได้จริง
    return NextResponse.json(
      { data: { marker: READINESS_MARKER }, error: "unauthorized" },
      { status: 401 }
    );
  }

  const report =
    outcome === "authorized"
      ? await buildAuthorizedReport()
      : await buildAnonymousReport();

  return NextResponse.json(report.body, { status: report.httpStatus });
}
