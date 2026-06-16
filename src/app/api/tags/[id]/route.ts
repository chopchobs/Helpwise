/**
 * PATCH  /api/tags/:id — แก้ไข tag (name/color)
 * DELETE /api/tags/:id — ลบ tag ออกจาก catalog (TicketTag cascade via FK)
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId)
 *   - findFirst tenant-scoped ก่อน mutate เสมอ — กัน cross-tenant mutation
 *
 * ⚠️ Agent-Only: tag เป็น internal — ห้าม expose ฝั่ง portal เด็ดขาด
 *
 * Audience: requireAgent({ roles: ["OWNER","ADMIN"] }) — catalog management
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { TagColor } from "@prisma/client";
import type { TagDTO } from "@/types/tag";

// =============================================================================
// ZOD SCHEMA
// =============================================================================

const patchTagSchema = z
  .object({
    name: z
      .string()
      .min(1, "ชื่อ tag ต้องไม่ว่าง")
      .max(50, "ชื่อ tag ต้องไม่เกิน 50 ตัวอักษร")
      .transform((v) => v.trim())
      .optional(),
    color: z.nativeEnum(TagColor).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "ต้องระบุ field อย่างน้อยหนึ่งอย่างที่ต้องการเปลี่ยน",
  });

// =============================================================================
// HELPER — map model → DTO
// =============================================================================

function toDTO(row: { id: string; name: string; color: TagColor }): TagDTO {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
  };
}

// =============================================================================
// PATCH /api/tags/:id — แก้ไข name/color
// =============================================================================

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;

    // 1. Auth gate — OWNER/ADMIN เท่านั้น
    const session = await requireAgent({ roles: ["OWNER", "ADMIN"] });
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

    const parsed = patchTagSchema.safeParse(body);
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

    // 3. ตรวจว่า tag อยู่ใน tenant นี้ — tenantPrisma inject tenantId ใน where อัตโนมัติ
    const existing = await db.tag.findFirst({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ tag ที่ต้องการแก้ไข" } },
        { status: 404 }
      );
    }

    // 4. update (tenant-scoped) — จัดการ unique constraint violation (ชื่อซ้ำ)
    let updated;
    try {
      updated = await db.tag.update({
        where: { id },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.color !== undefined && { color: input.color }),
        },
        select: { id: true, name: true, color: true },
      });
    } catch (updateErr: unknown) {
      // P2002 = unique constraint violation (@@unique tenantId+name)
      if (
        typeof updateErr === "object" &&
        updateErr !== null &&
        "code" in updateErr &&
        (updateErr as { code: string }).code === "P2002"
      ) {
        return NextResponse.json(
          {
            data: null,
            error: {
              code: "TAG_NAME_EXISTS",
              message: `ชื่อ tag "${input.name}" มีอยู่แล้วใน workspace นี้`,
            },
          },
          { status: 409 }
        );
      }
      throw updateErr;
    }

    return NextResponse.json({ data: { tag: toDTO(updated) }, error: null }, { status: 200 });
  } catch (err) {
    console.error("[PATCH /api/tags/:id] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}

// =============================================================================
// DELETE /api/tags/:id — ลบ tag ออกจาก catalog
// =============================================================================

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params;

    // 1. Auth gate — OWNER/ADMIN เท่านั้น
    const session = await requireAgent({ roles: ["OWNER", "ADMIN"] });
    const tenantId = session.ctx.tenantId; // ห้ามรับ tenantId จาก client
    const db = tenantPrisma(tenantId);

    // 2. ตรวจว่า tag อยู่ใน tenant นี้ก่อนลบ
    const existing = await db.tag.findFirst({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ tag ที่ต้องการลบ" } },
        { status: 404 }
      );
    }

    // 3. delete (tenant-scoped) — TicketTag cascade ตาม FK ที่ database กำหนด
    await db.tag.delete({ where: { id } });

    return NextResponse.json({ data: { id }, error: null }, { status: 200 });
  } catch (err) {
    console.error("[DELETE /api/tags/:id] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
