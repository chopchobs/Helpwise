/**
 * PATCH  /api/canned-responses/:id — แก้ไข title/body
 * DELETE /api/canned-responses/:id — ลบ canned response
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId)
 *   - ถ้าไม่พบในเฉพาะ tenant นี้ → 404 (ห้าม leak ว่ามีอยู่ใน tenant อื่น)
 *
 * Audience: requireAgent({ roles: ["OWNER","ADMIN","AGENT"] }) — กัน VIEWER แก้ไข/ลบ
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import type { CannedResponseDTO } from "@/types/canned-response";

// =============================================================================
// ZOD SCHEMA
// =============================================================================

const patchCannedResponseSchema = z
  .object({
    title: z
      .string()
      .min(1, "ชื่อข้อความต้องไม่ว่าง")
      .max(120, "ชื่อข้อความต้องไม่เกิน 120 ตัวอักษร")
      .transform((v) => v.trim())
      .optional(),
    body: z
      .string()
      .min(1, "เนื้อหาต้องไม่ว่าง")
      .max(10000, "เนื้อหาต้องไม่เกิน 10000 ตัวอักษร")
      .transform((v) => v.trim())
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "ต้องระบุ field อย่างน้อยหนึ่งอย่างที่ต้องการเปลี่ยน",
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
// PATCH /api/canned-responses/:id — แก้ไข
// =============================================================================

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;

    // 1. Auth gate — OWNER/ADMIN/AGENT เท่านั้น
    const session = await requireAgent({ roles: ["OWNER", "ADMIN", "AGENT"] });
    const tenantId = session.ctx.tenantId; // ห้ามรับ tenantId จาก client
    const db = tenantPrisma(tenantId);

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

    const parsed = patchCannedResponseSchema.safeParse(body);
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

    // 3. ตรวจว่าเป็นของ tenant นี้จริง — tenantPrisma inject tenantId ใน where อัตโนมัติ
    const existing = await db.cannedResponse.findFirst({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ canned response ที่ต้องการแก้ไข" } },
        { status: 404 }
      );
    }

    // 4. update (tenant-scoped)
    const updated = await db.cannedResponse.update({
      where: { id },
      data: {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.body !== undefined && { body: input.body }),
      },
      select: { id: true, title: true, body: true, createdAt: true },
    });

    return NextResponse.json({ data: { cannedResponse: toDTO(updated) }, error: null }, { status: 200 });
  } catch (err) {
    console.error("[PATCH /api/canned-responses/:id] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}

// =============================================================================
// DELETE /api/canned-responses/:id — ลบ
// =============================================================================

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;

    // 1. Auth gate — OWNER/ADMIN/AGENT เท่านั้น
    const session = await requireAgent({ roles: ["OWNER", "ADMIN", "AGENT"] });
    const tenantId = session.ctx.tenantId; // ห้ามรับ tenantId จาก client
    const db = tenantPrisma(tenantId);

    // 2. ตรวจว่าเป็นของ tenant นี้จริง ก่อนลบ
    const existing = await db.cannedResponse.findFirst({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ canned response ที่ต้องการลบ" } },
        { status: 404 }
      );
    }

    // 3. delete (tenant-scoped)
    await db.cannedResponse.delete({ where: { id } });

    return NextResponse.json({ data: { id }, error: null }, { status: 200 });
  } catch (err) {
    console.error("[DELETE /api/canned-responses/:id] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
