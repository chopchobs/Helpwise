/**
 * GET  /api/v1/tickets — public REST API: list tickets
 * POST /api/v1/tickets — public REST API: สร้าง ticket ใหม่
 *
 * Auth: requireApiKey() — Bearer token (API key) บน tenant subdomain
 * Rate limit: 120 req / 60s ต่อ apiKey.id
 *
 * ⚠️ Clean public surface — ไม่ expose SLA/assignee internal fields
 * ⚠️ API ไม่มี internal note — firstMessage visibility = PUBLIC เสมอ
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { toAuthErrorResponse } from "@/lib/auth";
import { requireApiKey } from "@/lib/api-auth";
import { tenantPrisma, setTenantGuc } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { checkRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { MessageVisibility, Prisma, TicketPriority, TicketStatus } from "@prisma/client";
import {
  createTicketWithNumber,
  verifyContactBelongsToTenant,
} from "@/lib/tickets";
import { dispatchWebhookEvent } from "@/lib/webhook-dispatch";

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const listQuerySchema = z.object({
  status: z.nativeEnum(TicketStatus).optional(),
  priority: z.nativeEnum(TicketPriority).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const createTicketSchema = z
  .object({
    subject: z.string().min(3, "subject ต้องมีอย่างน้อย 3 ตัวอักษร").max(200, "subject ยาวเกิน 200 ตัวอักษร"),
    requesterContactId: z.string().min(1).optional(),
    requesterEmail: z.string().email("รูปแบบ requesterEmail ไม่ถูกต้อง").optional(),
    requesterName: z.string().min(1).optional(),
    priority: z.nativeEnum(TicketPriority).optional(),
    message: z
      .object({
        body: z.string().min(1, "body ห้ามว่าง").max(50000, "body ยาวเกิน 50,000 ตัวอักษร"),
      })
      .optional(),
  })
  .refine((data) => !!data.requesterContactId || !!data.requesterEmail, {
    message: "ต้องระบุ requesterContactId หรือ requesterEmail อย่างใดอย่างหนึ่ง",
    path: ["requesterContactId"],
  });

// =============================================================================
// PUBLIC DTO SHAPE
// =============================================================================

interface PublicTicketDTO {
  id: string;
  ticketNumber: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  createdAt: string;
  updatedAt: string;
  requester: { email: string; name: string | null } | null;
}

// =============================================================================
// GET /api/v1/tickets — list
// =============================================================================

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { apiKey, ctx } = await requireApiKey(request);

    // rate limit ต่อ apiKey
    const rl = await checkRateLimit({
      key: rateLimitKey("api-v1", apiKey.id),
      limit: 120,
      windowSeconds: 60,
    });
    if (!rl.allowed) {
      return rateLimitResponse(rl.retryAfterSeconds);
    }

    const { searchParams } = request.nextUrl;
    const queryParsed = listQuerySchema.safeParse({
      status: searchParams.get("status") ?? undefined,
      priority: searchParams.get("priority") ?? undefined,
      page: searchParams.get("page") ?? 1,
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

    const { status, priority, page, limit } = queryParsed.data;

    const db = tenantPrisma(ctx.tenantId);
    const where: Prisma.TicketWhereInput = {};
    if (status) where.status = status;
    if (priority) where.priority = priority;

    const [rawTickets, total] = await Promise.all([
      db.ticket.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          ticketNumber: true,
          subject: true,
          status: true,
          priority: true,
          createdAt: true,
          updatedAt: true,
          requesterContact: { select: { email: true, name: true } },
        },
      }),
      db.ticket.count({ where }),
    ]);

    const tickets: PublicTicketDTO[] = rawTickets.map((t) => ({
      id: t.id,
      ticketNumber: t.ticketNumber,
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      requester: t.requesterContact
        ? { email: t.requesterContact.email, name: t.requesterContact.name }
        : null,
    }));

    return NextResponse.json(
      {
        data: {
          tickets,
          pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        },
        error: null,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("[GET /api/v1/tickets] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}

// =============================================================================
// POST /api/v1/tickets — สร้าง ticket ใหม่
// =============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const { apiKey, ctx } = await requireApiKey(request);

    const rl = await checkRateLimit({
      key: rateLimitKey("api-v1", apiKey.id),
      limit: 120,
      windowSeconds: 60,
    });
    if (!rl.allowed) {
      return rateLimitResponse(rl.retryAfterSeconds);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { data: null, error: { code: "INVALID_JSON", message: "Request body ต้องเป็น JSON" } },
        { status: 400 }
      );
    }

    const parsed = createTicketSchema.safeParse(body);
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

    const {
      subject,
      requesterContactId: rawContactId,
      requesterEmail,
      requesterName,
      priority,
      message,
    } = parsed.data;

    const db = tenantPrisma(ctx.tenantId);

    // Resolve requesterContactId — เหมือน pattern ของ /api/tickets POST
    let resolvedContactId: string;

    if (rawContactId) {
      const contact = await verifyContactBelongsToTenant(db, rawContactId);
      if (!contact) {
        return NextResponse.json(
          { data: null, error: { code: "CONTACT_NOT_FOUND", message: "ไม่พบ contact ที่ระบุใน workspace นี้" } },
          { status: 400 }
        );
      }
      resolvedContactId = contact.id;
    } else {
      // upsert contact by email ภายใน transaction (base prisma + scalar tenantId)
      const upserted = await prisma.$transaction(async (tx) => {
        // Phase 27 RLS: ตั้ง tenant GUC ใน tx นี้ (Contact ถูก FORCE RLS) — base prisma ไม่ผ่าน tenantPrisma
        await setTenantGuc(tx, ctx.tenantId);
        const existingContact = await tx.contact.findFirst({
          where: { tenantId: ctx.tenantId, email: requesterEmail! },
          select: { id: true, name: true },
        });

        return tx.contact.upsert({
          where: {
            tenantId_email: { tenantId: ctx.tenantId, email: requesterEmail! },
          },
          create: {
            email: requesterEmail!,
            tenantId: ctx.tenantId,
            ...(requesterName ? { name: requesterName } : {}),
          },
          update: {
            ...(requesterName && !existingContact?.name ? { name: requesterName } : {}),
          },
          select: { id: true, name: true, email: true },
        });
      });
      resolvedContactId = upserted.id;
    }

    // สร้าง ticket — channel "api"; firstMessage visibility = PUBLIC เสมอ (API ไม่มี internal note)
    const ticket = await createTicketWithNumber(db, {
      tenantId: ctx.tenantId,
      subject,
      requesterContactId: resolvedContactId,
      priority,
      channel: "api",
      plan: ctx.plan,
      firstMessage: message
        ? {
            body: message.body,
            visibility: MessageVisibility.PUBLIC,
          }
        : undefined,
    });

    // โหลด ticket พร้อม requester + first message (ถ้ามี) สำหรับ response
    const created = await db.ticket.findUnique({
      where: { id: ticket.id },
      select: {
        id: true,
        ticketNumber: true,
        subject: true,
        status: true,
        priority: true,
        createdAt: true,
        updatedAt: true,
        requesterContact: { select: { email: true, name: true } },
      },
    });

    const responseDTO: PublicTicketDTO = created
      ? {
          id: created.id,
          ticketNumber: created.ticketNumber,
          subject: created.subject,
          status: created.status,
          priority: created.priority,
          createdAt: created.createdAt.toISOString(),
          updatedAt: created.updatedAt.toISOString(),
          requester: created.requesterContact
            ? { email: created.requesterContact.email, name: created.requesterContact.name }
            : null,
        }
      : {
          id: ticket.id,
          ticketNumber: ticket.ticketNumber,
          subject: ticket.subject,
          status: ticket.status,
          priority: ticket.priority,
          createdAt: ticket.createdAt.toISOString(),
          updatedAt: ticket.updatedAt.toISOString(),
          requester: null,
        };

    // audit log — actor = system (มาจาก API key ไม่ใช่ agent)
    void audit.log({
      tenantId: ctx.tenantId,
      actor: { type: "system" },
      targetType: "ticket",
      targetId: ticket.id,
      action: "ticket.created",
      after: { ticketNumber: ticket.ticketNumber, status: ticket.status, priority: ticket.priority, channel: "api" },
      ticketId: ticket.id,
      // metadata: apiKeyId + resolvedContactId เพื่อ trace abuse (key ถูกขโมยสร้าง spam) — ไม่ log email/PII
      metadata: { apiKeyId: apiKey.id, via: "api", requesterContactId: resolvedContactId },
    });

    // Outbound webhook ticket.created (contract § 3) — await เพื่อกัน serverless ตัดงานกลางคัน
    // (dispatcher ไม่ throw: feature gate + error handling อยู่ข้างใน)
    await dispatchWebhookEvent(
      db,
      ctx.tenantId,
      {
        eventType: "TICKET_CREATED",
        occurredAt: ticket.createdAt,
        ticket: {
          id: ticket.id,
          ticketNumber: ticket.ticketNumber,
          subject: ticket.subject,
          status: ticket.status,
          priority: ticket.priority,
          assigneeMemberId: ticket.assigneeId,
          requesterContactId: ticket.requesterContactId,
          channel: ticket.channel,
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt,
        },
      },
      ctx.plan
    );

    return NextResponse.json({ data: responseDTO, error: null }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/v1/tickets] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
