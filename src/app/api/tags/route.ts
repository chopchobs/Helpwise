/**
 * GET  /api/tags — list tag catalog ของ tenant
 * POST /api/tags — สร้าง tag ใหม่ใน catalog
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId)
 *   - create ใช้ scalar tenantId (ห้าม tenant:{connect})
 *
 * ⚠️ Agent-Only: tag เป็น internal — ห้าม expose ฝั่ง portal เด็ดขาด
 *
 * Audience:
 *   - GET  → requireAgent() — ทุก role อ่านได้ (ใช้ตอน apply tag บน ticket)
 *   - POST → requireAgent({ roles: ["OWNER","ADMIN"] }) — จัดการ catalog เฉพาะ admin
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

const createTagSchema = z.object({
  name: z
    .string()
    .min(1, "ชื่อ tag ต้องไม่ว่าง")
    .max(50, "ชื่อ tag ต้องไม่เกิน 50 ตัวอักษร")
    .transform((v) => v.trim()),
  color: z.nativeEnum(TagColor),
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
// GET /api/tags — list tag catalog ของ tenant (เรียงตาม name)
// =============================================================================

export async function GET(): Promise<NextResponse> {
  try {
    // 1. Auth gate — ทุก role อ่านได้ (ใช้ตอน apply tag บน ticket)
    const session = await requireAgent();
    const tenantId = session.ctx.tenantId; // ห้ามรับ tenantId จาก client

    // 2. ดึง tag catalog — tenantPrisma inject tenantId อัตโนมัติ (tenant isolation)
    const db = tenantPrisma(tenantId);
    const rows = await db.tag.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true },
    });

    return NextResponse.json(
      { data: { tags: rows.map(toDTO) }, error: null },
      { status: 200 }
    );
  } catch (err) {
    console.error("[GET /api/tags] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}

// =============================================================================
// POST /api/tags — สร้าง tag ใหม่ใน catalog
// =============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // 1. Auth gate — OWNER/ADMIN เท่านั้นจัดการ catalog ได้
    const session = await requireAgent({ roles: ["OWNER", "ADMIN"] });
    const tenantId = session.ctx.tenantId; // ห้ามรับ tenantId จาก client

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

    const parsed = createTagSchema.safeParse(body);
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

    // 3. สร้างด้วย scalar tenantId (tenantPrisma create ใช้ scalar — ห้าม tenant:{connect})
    const db = tenantPrisma(tenantId);
    let created;
    try {
      created = await db.tag.create({
        data: {
          tenantId,
          name: input.name,
          color: input.color,
        },
        select: { id: true, name: true, color: true },
      });
    } catch (createErr: unknown) {
      // P2002 = unique constraint violation (@@unique tenantId+name)
      if (
        typeof createErr === "object" &&
        createErr !== null &&
        "code" in createErr &&
        (createErr as { code: string }).code === "P2002"
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
      throw createErr;
    }

    return NextResponse.json({ data: { tag: toDTO(created) }, error: null }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/tags] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
