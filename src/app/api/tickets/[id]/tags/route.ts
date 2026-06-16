/**
 * POST /api/tickets/:id/tags — apply tag บน ticket
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId)
 *   - verify ทั้ง ticket + tag อยู่ใน tenant เดียวกันก่อน create TicketTag
 *   - create TicketTag ใช้ scalar tenantId/ticketId/tagId (ห้าม connect)
 *
 * ⚠️ Agent-Only: tag เป็น internal — ห้าม expose ฝั่ง portal เด็ดขาด
 *
 * Audience: requireAgent() — ทุก active agent role (ยกเว้น VIEWER ถ้ามี read-only restriction)
 *           OWNER/ADMIN/AGENT ใช้ pattern เดียวกับ canned-response POST
 *
 * Idempotent: ถ้า tag ติดอยู่แล้ว (P2002 unique ticketId+tagId) → คืน 200 (idempotent)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import type { TagDTO } from "@/types/tag";

// =============================================================================
// ZOD SCHEMA
// =============================================================================

const applyTagSchema = z.object({
  tagId: z.string().min(1, "tagId ต้องไม่ว่าง"),
});

// =============================================================================
// POST /api/tickets/:id/tags — apply tag บน ticket
// =============================================================================

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id: ticketId } = await params;

    // 1. Auth gate — OWNER/ADMIN/AGENT (ทุก active agent)
    const session = await requireAgent({ roles: ["OWNER", "ADMIN", "AGENT"] });
    const { ctx, member } = session;
    const tenantId = ctx.tenantId; // ห้ามรับ tenantId จาก client
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

    const parsed = applyTagSchema.safeParse(body);
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

    const { tagId } = parsed.data;

    // 3. ตรวจว่า ticket อยู่ใน tenant นี้ (tenantPrisma inject tenantId กัน cross-tenant)
    const ticket = await db.ticket.findFirst({
      where: { id: ticketId },
      select: { id: true },
    });
    if (!ticket) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ ticket ที่ระบุ" } },
        { status: 404 }
      );
    }

    // 4. ตรวจว่า tag อยู่ใน tenant นี้ (กัน cross-tenant tag spoofing)
    const tag = await db.tag.findFirst({
      where: { id: tagId },
      select: { id: true, name: true, color: true },
    });
    if (!tag) {
      return NextResponse.json(
        { data: null, error: { code: "TAG_NOT_FOUND", message: "ไม่พบ tag ที่ระบุใน workspace นี้" } },
        { status: 404 }
      );
    }

    // 5. สร้าง TicketTag ด้วย scalar tenantId/ticketId/tagId (ห้าม connect)
    //    idempotent: ถ้า P2002 (unique ticketId+tagId) → tag ติดอยู่แล้ว คืน 200
    try {
      await db.ticketTag.create({
        data: {
          tenantId,
          ticketId,
          tagId,
        },
      });
    } catch (createErr: unknown) {
      // P2002 = unique constraint violation (@@unique ticketId+tagId) — idempotent คืน 200
      if (
        typeof createErr === "object" &&
        createErr !== null &&
        "code" in createErr &&
        (createErr as { code: string }).code === "P2002"
      ) {
        const tagDTO: TagDTO = {
          id: tag.id,
          name: tag.name,
          color: tag.color,
        };
        return NextResponse.json({ data: { tag: tagDTO }, error: null }, { status: 200 });
      }
      throw createErr;
    }

    // 6. Audit log — ticket.tag_added (fire-and-forget)
    void audit.log({
      tenantId,
      actor: { type: "member", memberId: member.id },
      targetType: "ticket",
      targetId: ticketId,
      action: "ticket.tag_added",
      metadata: { tagId, tagName: tag.name },
      ticketId,
    });

    const tagDTO: TagDTO = {
      id: tag.id,
      name: tag.name,
      color: tag.color,
    };

    return NextResponse.json({ data: { tag: tagDTO }, error: null }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/tickets/:id/tags] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
