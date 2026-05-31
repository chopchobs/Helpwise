/**
 * POST /api/auth/agent/logout
 * ล้าง agent session cookie
 *
 * ไม่ต้อง verify token ก่อน — การลบ cookie เพียงพอ
 * (ถ้า token หมดอายุอยู่แล้วก็ไม่เป็นไร — ลบ cookie ให้สะอาด)
 */

import { NextResponse } from "next/server";
import { clearAgentCookie, toAuthErrorResponse } from "@/lib/auth";

export async function POST(): Promise<NextResponse> {
  try {
    await clearAgentCookie();
    return NextResponse.json({ data: { ok: true }, error: null }, { status: 200 });
  } catch (err) {
    console.error("[agent:logout] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
