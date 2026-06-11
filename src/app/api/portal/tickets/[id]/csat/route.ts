/**
 * POST /api/portal/tickets/:id/csat — contact ส่งคะแนน CSAT หลัง ticket SOLVED/CLOSED
 *
 * ⚠️ CRITICAL — Own-Records Scope:
 *   - โหลด ticket ด้วย tenantPrisma + ตรวจ requesterContactId === ctx.contactId
 *   - ถ้าไม่ตรง หรือไม่พบ → 404 เสมอ (ห้าม reveal ว่า ticket มีอยู่จริง)
 *
 * ⚠️ Eligibility:
 *   - ticket ต้อง status = SOLVED หรือ CLOSED → 409 TICKET_NOT_RESOLVED ถ้ายังไม่ปิด
 *
 * ⚠️ Dedup (submit-once):
 *   - ticketId @unique ใน CsatResponse — Prisma P2002 → 409 ALREADY_SUBMITTED
 *
 * ⚠️ Feature Gate:
 *   - hasFeature(CSAT_SURVEY) → 403 FEATURE_LOCKED ถ้าปิด
 *
 * ⚠️ Audit Log:
 *   - log rating เท่านั้น (comment อาจมี PII — ห้าม log ใน snapshot)
 *
 * Audience: requireContact() — contact ของ tenant นี้เท่านั้น
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireContact, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import { audit } from "@/lib/audit";
import { Prisma, TicketStatus } from "@prisma/client";
import { CSAT_COMMENT_MAX_LENGTH } from "@/types/csat";
import type { CsatResponseDTO } from "@/types/csat";
import { checkRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";

// =============================================================================
// VALIDATION SCHEMA
// =============================================================================

const csatSubmitSchema = z.object({
  // rating ต้องเป็น Int 1–5 เท่านั้น — ไม่รับ Float
  rating: z
    .number()
    .int("rating ต้องเป็นจำนวนเต็ม")
    .min(1, "rating ต้องไม่น้อยกว่า 1")
    .max(5, "rating ต้องไม่เกิน 5"),
  // comment optional, trim whitespace, จำกัดความยาวตาม constant ที่ frontend ใช้ร่วม
  comment: z
    .string()
    .max(CSAT_COMMENT_MAX_LENGTH, `comment ต้องไม่เกิน ${CSAT_COMMENT_MAX_LENGTH} ตัวอักษร`)
    .transform((v) => v.trim())
    .nullable()
    .optional(),
});

// สถานะที่ถือว่า ticket ปิดแล้ว (eligible สำหรับ CSAT)
const RESOLVED_STATUSES: TicketStatus[] = [TicketStatus.SOLVED, TicketStatus.CLOSED];

// =============================================================================
// POST /api/portal/tickets/:id/csat — submit CSAT rating
// =============================================================================

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    // params เป็น Promise ใน Next.js 15+/16 — ต้อง await
    const { id: ticketId } = await params;

    // 1. ตรวจ auth — requireContact แยกขาดจาก requireAgent
    const session = await requireContact();
    const { contact, ctx } = session;

    // 1.5 Rate limit ตาม contactId — กัน spam submit ก่อน DB write
    const rl = await checkRateLimit({
      key: rateLimitKey("csat-submit", contact.id),
      limit: 20,
      windowSeconds: 60,
    });
    if (!rl.allowed) {
      return rateLimitResponse(rl.retryAfterSeconds);
    }

    // 2. Feature gate — csat_survey ต้องเปิด (pass ctx.plan กัน extra query)
    const featureEnabled = await hasFeature(ctx.tenantId, FEATURE_KEYS.CSAT_SURVEY, ctx.plan);
    if (!featureEnabled) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "FEATURE_LOCKED",
            message: "CSAT Survey ไม่รวมอยู่ใน plan ปัจจุบัน",
          },
        },
        { status: 403 }
      );
    }

    const db = tenantPrisma(ctx.tenantId);

    // 3. OWN-RECORDS SCOPE + ELIGIBILITY CHECK
    //    tenantPrisma inject tenantId (layer 1 — tenant isolation)
    //    ตรวจ requesterContactId === contact.id (layer 2 — own-records scope)
    //    ถ้าไม่พบ หรือไม่ใช่ contact นี้ → findFirst คืน null → 404
    //    ห้าม reveal ว่า ticket ID นั้นมีอยู่จริง (information leakage)
    const ticket = await db.ticket.findFirst({
      where: {
        id: ticketId,
        requesterContactId: contact.id, // OWN-RECORDS SCOPE
      },
      select: {
        id: true,
        status: true,
        requesterContactId: true,
      },
    });

    // ticket ไม่พบ หรือไม่ใช่ของ contact นี้ → 404 เสมอ
    if (!ticket) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ ticket ที่ระบุ" } },
        { status: 404 }
      );
    }

    // 4. Eligibility check — ticket ต้อง SOLVED หรือ CLOSED
    if (!RESOLVED_STATUSES.includes(ticket.status)) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "TICKET_NOT_RESOLVED",
            message: "ยังให้คะแนนไม่ได้ — ticket ยังไม่ถูกปิด",
          },
        },
        { status: 409 }
      );
    }

    // 5. Parse + validate body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { data: null, error: { code: "INVALID_JSON", message: "Request body ต้องเป็น JSON" } },
        { status: 400 }
      );
    }

    const parsed = csatSubmitSchema.safeParse(body);
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

    const { rating, comment } = parsed.data;

    // normalize comment ว่าง/whitespace-only → null (DB สะอาด ไม่เก็บ "")
    const normalizedComment = comment && comment.length > 0 ? comment : null;

    // 6. สร้าง CsatResponse — ใช้ scalar FK ตาม project gotcha (ห้าม connect)
    //    ticketId @unique → Prisma P2002 ถ้าส่งซ้ำ → 409 ALREADY_SUBMITTED
    let csatResponse: { id: string; rating: number; comment: string | null; createdAt: Date };
    try {
      csatResponse = await db.csatResponse.create({
        data: {
          tenantId: ctx.tenantId, // scalar FK — ห้ามใช้ connect (project gotcha)
          ticketId: ticketId,     // scalar FK — @unique บังคับ submit-once
          contactId: contact.id,  // contactId มาจาก session ไม่ใช่ client
          rating,
          comment: normalizedComment,
        },
        select: {
          id: true,
          rating: true,
          comment: true,
          createdAt: true,
        },
      });
    } catch (err) {
      // ตรวจ P2002 (unique constraint violation) = ส่งซ้ำ
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return NextResponse.json(
          {
            data: null,
            error: {
              code: "ALREADY_SUBMITTED",
              message: "คุณให้คะแนน ticket นี้ไปแล้ว",
            },
          },
          { status: 409 }
        );
      }
      throw err; // error อื่น bubble ขึ้น catch ด้านนอก
    }

    // 7. Audit log — log rating เท่านั้น (comment อาจมี PII — ห้าม log ใน snapshot)
    void audit.log({
      tenantId: ctx.tenantId,
      actor: { type: "contact", contactId: contact.id },
      targetType: "ticket",
      targetId: ticketId,
      action: "csat.submitted",
      after: { rating }, // comment ไม่ log (อาจมี PII)
      ticketId,
    });

    // 8. Build DTO + return 201
    const dto: CsatResponseDTO = {
      rating: csatResponse.rating,
      comment: csatResponse.comment,
      createdAt: csatResponse.createdAt.toISOString(),
    };

    return NextResponse.json({ data: dto, error: null }, { status: 201 });
  } catch (err) {
    console.error(
      "[POST /api/portal/tickets/:id/csat] Unexpected error:",
      err instanceof Error ? err.message : String(err)
    );
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
