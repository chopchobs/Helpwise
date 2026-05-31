/**
 * POST /api/auth/portal/logout
 * ล้าง contact session cookie
 *
 * ไม่ต้อง verify token ก่อน — การลบ cookie เพียงพอ
 */

import { NextResponse } from "next/server";
import { clearContactCookie, toAuthErrorResponse } from "@/lib/auth";

export async function POST(): Promise<NextResponse> {
  try {
    await clearContactCookie();
    return NextResponse.json({ data: { ok: true }, error: null }, { status: 200 });
  } catch (err) {
    console.error("[portal:logout] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
