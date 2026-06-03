/**
 * GET  /api/contacts — search/list active contacts (สำหรับ requester combobox)
 * POST /api/contacts — สร้าง/upsert contact ใหม่
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() → ctx.tenantId เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId) ที่ inject tenantId อัตโนมัติ
 *
 * Audience: requireAgent() — เฉพาะ agent ที่เป็นสมาชิก tenant นี้เท่านั้น
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

// schema สำหรับ query string ของ GET
const listQuerySchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// schema สำหรับ POST body
const createContactSchema = z.object({
  email: z.string().email("รูปแบบ email ไม่ถูกต้อง"),
  name: z.string().min(1).optional(),
});

// =============================================================================
// GET /api/contacts — search/list active contacts
// =============================================================================

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    // 1. ตรวจ auth — ต้องเป็น agent ที่ active ของ tenant นี้
    const session = await requireAgent();
    const { ctx } = session;

    // 2. Parse query string
    const { searchParams } = request.nextUrl;
    const queryParsed = listQuerySchema.safeParse({
      q: searchParams.get("q") ?? undefined,
      limit: searchParams.get("limit") ?? 20,
    });

    if (!queryParsed.success) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "VALIDATION_ERROR",
            message: queryParsed.error.issues[0]?.message ?? "Query parameter ไม่ถูกต้อง",
          },
        },
        { status: 400 }
      );
    }

    const { q, limit } = queryParsed.data;

    // 3. Query active contacts ของ tenant นี้ — tenantPrisma inject tenantId อัตโนมัติ
    const db = tenantPrisma(ctx.tenantId);

    const contacts = await db.contact.findMany({
      where: {
        isActive: true,
        // ถ้ามี q ค้นจาก email หรือ name แบบ contains case-insensitive
        ...(q
          ? {
              OR: [
                { email: { contains: q, mode: "insensitive" } },
                { name: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
      },
    });

    return NextResponse.json(
      { data: { contacts }, error: null },
      { status: 200 }
    );
  } catch (err) {
    console.error(
      "[GET /api/contacts] Unexpected error:",
      err instanceof Error ? err.message : String(err)
    );
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}

// =============================================================================
// POST /api/contacts — สร้าง/upsert contact
// =============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // 1. ตรวจ auth — ต้องเป็น agent ที่ active ของ tenant นี้
    const session = await requireAgent();
    const { ctx, member } = session;

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

    const parsed = createContactSchema.safeParse(body);
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

    const { email, name } = parsed.data;

    // 3. ห่อ read + upsert ใน interactive transaction เพื่อให้ atomic
    //    กัน race condition ที่ request 2 อันส่ง email เดิมพร้อมกัน — isNew และ name-update logic จะถูกต้องเสมอ
    //    tx ไม่มี extension → ต้องใส่ tenantId เองใน where/create/update ทุกจุด
    const { contact, isNew } = await prisma.$transaction(async (tx) => {
      // อ่าน contact ปัจจุบัน ภายใน transaction เดียวกับ upsert
      const existing = await tx.contact.findFirst({
        where: { tenantId: ctx.tenantId, email },
        select: { id: true, email: true, name: true, avatarUrl: true },
      });

      // upsert: ถ้ามีอยู่แล้ว update name ถ้าเดิมว่าง; ไม่งั้นสร้างใหม่
      const upserted = await tx.contact.upsert({
        where: { tenantId_email: { tenantId: ctx.tenantId, email } },
        create: {
          email,
          tenantId: ctx.tenantId,
          ...(name ? { name } : {}),
        },
        update: {
          // อัปเดต name เฉพาะเมื่อ name ที่ส่งมาและ contact เดิม name ว่าง
          // ถ้า existing.name มีค่าแล้ว ไม่เขียนทับ (เคารพข้อมูลเดิม)
          ...(name && !existing?.name ? { name } : {}),
        },
        select: {
          id: true,
          email: true,
          name: true,
          avatarUrl: true,
        },
      });

      return { contact: upserted, isNew: !existing };
    });

    // 4. log audit contact.created เฉพาะเมื่อสร้างใหม่จริง (ไม่ใช่ existing)
    if (isNew) {
      void audit.log({
        tenantId: ctx.tenantId,
        actor: { type: "member", memberId: member.id },
        targetType: "contact",
        targetId: contact.id,
        action: "contact.created",
        after: { email: contact.email, name: contact.name },
      });
    }

    // 201 ถ้าสร้างใหม่, 200 ถ้ามีอยู่แล้ว
    return NextResponse.json(
      { data: contact, error: null },
      { status: isNew ? 201 : 200 }
    );
  } catch (err) {
    console.error(
      "[POST /api/contacts] Unexpected error:",
      err instanceof Error ? err.message : String(err)
    );
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
