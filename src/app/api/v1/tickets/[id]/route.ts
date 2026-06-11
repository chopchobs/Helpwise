/**
 * GET /api/v1/tickets/:id — public REST API: ticket detail
 *
 * Auth: requireApiKey() + rate limit (scope "api-v1", 120/60s ต่อ apiKey)
 *
 * ⚠️ messages กรอง visibility = PUBLIC เท่านั้น — กัน internal note รั่วผ่าน API
 */

import { NextRequest, NextResponse } from "next/server";
import { toAuthErrorResponse } from "@/lib/auth";
import { requireApiKey } from "@/lib/api-auth";
import { tenantPrisma } from "@/lib/tenant";
import { checkRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { MessageVisibility, TicketPriority, TicketStatus } from "@prisma/client";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface PublicTicketMessageDTO {
  id: string;
  body: string;
  createdAt: string;
  author: { type: "agent" | "contact"; name: string | null };
}

interface PublicTicketDetailDTO {
  id: string;
  ticketNumber: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  createdAt: string;
  updatedAt: string;
  requester: { email: string; name: string | null } | null;
  messages: PublicTicketMessageDTO[];
}

export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  try {
    const { apiKey, ctx } = await requireApiKey(request);
    const { id } = await params;

    const rl = await checkRateLimit({
      key: rateLimitKey("api-v1", apiKey.id),
      limit: 120,
      windowSeconds: 60,
    });
    if (!rl.allowed) {
      return rateLimitResponse(rl.retryAfterSeconds);
    }

    const db = tenantPrisma(ctx.tenantId);

    // tenantPrisma scope กัน cross-tenant; ไม่เจอ → 404
    const ticket = await db.ticket.findFirst({
      where: { id },
      select: {
        id: true,
        ticketNumber: true,
        subject: true,
        status: true,
        priority: true,
        createdAt: true,
        updatedAt: true,
        requesterContact: { select: { email: true, name: true } },
        // ⚠️ กรอง visibility = PUBLIC เท่านั้น — internal note ห้ามหลุดผ่าน v1 API
        messages: {
          where: { visibility: MessageVisibility.PUBLIC },
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            body: true,
            createdAt: true,
            authorMember: { select: { user: { select: { name: true } } } },
            authorContact: { select: { name: true } },
          },
        },
      },
    });

    if (!ticket) {
      return NextResponse.json(
        { data: null, error: { code: "NOT_FOUND", message: "ไม่พบ ticket ที่ระบุ" } },
        { status: 404 }
      );
    }

    const messages: PublicTicketMessageDTO[] = ticket.messages.map((m) => ({
      id: m.id,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
      author: m.authorMember
        ? { type: "agent", name: m.authorMember.user.name }
        : { type: "contact", name: m.authorContact?.name ?? null },
    }));

    const responseDTO: PublicTicketDetailDTO = {
      id: ticket.id,
      ticketNumber: ticket.ticketNumber,
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority,
      createdAt: ticket.createdAt.toISOString(),
      updatedAt: ticket.updatedAt.toISOString(),
      requester: ticket.requesterContact
        ? { email: ticket.requesterContact.email, name: ticket.requesterContact.name }
        : null,
      messages,
    };

    return NextResponse.json({ data: responseDTO, error: null }, { status: 200 });
  } catch (err) {
    console.error("[GET /api/v1/tickets/:id] Unexpected error:", err instanceof Error ? err.message : String(err));
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
