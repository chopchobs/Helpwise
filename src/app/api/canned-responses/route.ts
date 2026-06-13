/**
 * GET  /api/canned-responses — list canned responses ของ tenant
 * POST /api/canned-responses — สร้าง canned response ใหม่
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId)
 *
 * Audience:
 *   - GET  → requireAgent() — member ใด ๆ ที่ active อ่านได้ (ใช้ตอน reply ticket)
 *   - POST → requireAgent({ roles: ["OWNER","ADMIN","AGENT"] }) — กัน VIEWER แก้ไข
 *
 * Feature: base feature ไม่ gate plan (ไม่เรียก hasFeature)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import type { CannedResponseDTO } from "@/types/canned-response";

// =============================================================================
// ZOD SCHEMA
// =============================================================================

const createCannedResponseSchema = z.object({
  title: z
    .string()
    .min(1, "ชื่อข้อความต้องไม่ว่าง")
    .max(120, "ชื่อข้อความต้องไม่เกิน 120 ตัวอักษร")
    .transform((v) => v.trim()),
  body: z
    .string()
    .min(1, "เนื้อหาต้องไม่ว่าง")
    .max(10000, "เนื้อหาต้องไม่เกิน 10000 ตัวอักษร")
    .transform((v) => v.trim()),
});

// =============================================================================
// HELPER — map model → DTO
// =============================================================================

function toDTO(row: { id: string; title: string; body: string; createdAt: Date }): CannedResponseDTO {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

// =============================================================================
// GET /api/canned-responses — list ทั้งหมดของ tenant
// =============================================================================

export async function GET(): Promise<NextResponse> {
  try {
    // 1. Auth gate — member ใด ๆ ที่ active (ทุก role ใช้ตอน reply ticket)
    const session = await requireAgent();
    const tenantId = session.ctx.tenantId; // ห้ามรับ tenantId จาก client

    // 2. ดึง list — tenantPrisma inject tenantId อัตโนมัติ
    const db = tenantPrisma(tenantId);
    const rows = await db.cannedResponse.findMany({
      orderBy: { title: "asc" },
      select: { id: true, title: true, body: true, createdAt: true },
    });

    return NextResponse.json(
      { data: { cannedResponses: rows.map(toDTO) }, error: null },
      { status: 200 }
    );
  } catch (err) {
    console.error("[GET /api/canned-responses] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}

// =============================================================================
// POST /api/canned-responses — สร้างใหม่
// =============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // 1. Auth gate — OWNER/ADMIN/AGENT เท่านั้น (กัน VIEWER แก้ไข)
    const session = await requireAgent({ roles: ["OWNER", "ADMIN", "AGENT"] });
    const { ctx, member } = session;
    const tenantId = ctx.tenantId; // ห้ามรับ tenantId จาก client

    // 2. Parse + validate body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { data: null, error: { code: "INVALID_JSON", message: "Request body ต้องเป็น JSON" } },
        { status: 400 }
      );
    }

    const parsed = createCannedResponseSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "VALIDATION_ERROR",
            message: parsed.error.issues[0]?.message ?? "ข้อมูลไม่ถูกต้อง",
          },
        },
        { status: 400 }
      );
    }

    const input = parsed.data;

    // 3. สร้างด้วย scalar tenantId (tenantPrisma create ใช้ scalar ห้าม connect)
    const db = tenantPrisma(tenantId);
    const created = await db.cannedResponse.create({
      data: {
        tenantId,
        title: input.title,
        body: input.body,
        createdByMemberId: member.id,
      },
      select: { id: true, title: true, body: true, createdAt: true },
    });

    return NextResponse.json({ data: { cannedResponse: toDTO(created) }, error: null }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/canned-responses] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
