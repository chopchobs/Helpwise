/**
 * POST /api/tickets/:id/ai/summarize — สรุป thread ของ ticket ด้วย Claude API
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId) → LLM เข้าถึงข้าม tenant ไม่ได้แม้ถูก inject
 *
 * ⚠️ Agent-Only: ผลลัพธ์ AI = internal draft summary — ห้ามหลุดฝั่ง portal
 *   - agent เห็นได้ทั้ง PUBLIC + INTERNAL message (นี่ฝั่ง agent ไม่ใช่ portal)
 *
 * Pipeline: extract tenant → requireAgent → hasFeature(ai_assist) → verify ticket → rate-limit → AI
 *
 * Feature-gated: ต้องมี feature "ai_assist" → ไม่มีคืน 403 FEATURE_NOT_AVAILABLE
 * Cost guard: rate-limit ต่อ tenant ก่อนเรียก AI (AI call มี cost)
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import { audit } from "@/lib/audit";
import { checkRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { summarizeThread, AI_SUMMARY_MODEL } from "@/lib/ai";
import type { AiSummaryDTO } from "@/types/ai";

// cap จำนวน messages ที่ส่งให้ AI กัน prompt ใหญ่/cost พุ่ง — เอาล่าสุด ~50
const MAX_MESSAGES = 50;

// rate-limit: 10 ครั้ง / 1 ชั่วโมง ต่อ tenant (AI call มี cost)
const RATE_LIMIT = 10;
const RATE_WINDOW_SECONDS = 60 * 60;

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id: ticketId } = await params;

    // 1. Auth gate — OWNER/ADMIN/AGENT (ทุก active agent)
    const session = await requireAgent({ roles: ["OWNER", "ADMIN", "AGENT"] });
    const { ctx, member } = session;
    const tenantId = ctx.tenantId; // ห้ามรับ tenantId จาก client
    const db = tenantPrisma(tenantId);

    // 2. Feature gate — ต้องมี ai_assist (ไม่ hardcode plan)
    const enabled = await hasFeature(tenantId, FEATURE_KEYS.AI_ASSIST, ctx.plan);
    if (!enabled) {
      return NextResponse.json(
        {
          data: null,
          error: {
            code: "FEATURE_NOT_AVAILABLE",
            message: "ฟีเจอร์ AI Assist ไม่พร้อมใช้งานในแพ็กเกจปัจจุบัน กรุณาอัปเกรด",
          },
        },
        { status: 403 }
      );
    }

    // 3. verify ว่า ticket อยู่ใน tenant นี้ (tenantPrisma inject tenantId กัน cross-tenant)
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

    // 4. Cost guard — rate-limit ต่อ tenant ก่อนเรียก AI
    const rl = await checkRateLimit({
      key: rateLimitKey("ai-summarize", tenantId),
      limit: RATE_LIMIT,
      windowSeconds: RATE_WINDOW_SECONDS,
    });
    if (!rl.allowed) {
      return rateLimitResponse(rl.retryAfterSeconds);
    }

    // 5. ดึง messages ของ ticket — agent เห็นทั้ง PUBLIC + INTERNAL (ฝั่ง agent ไม่ใช่ portal)
    //    เลือก field เท่าที่ต้อง: visibility + body + author FK (ไว้ derive label "Agent"/"Customer")
    //    take ล่าสุด ~50 (orderBy desc) แล้ว reverse ให้เรียงตามเวลาก่อนส่ง AI
    const rows = await db.ticketMessage.findMany({
      where: { ticketId },
      select: {
        visibility: true,
        body: true,
        authorMemberId: true,
        authorContactId: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: MAX_MESSAGES,
    });

    const ordered = rows.reverse();

    // derive author label จาก type ของผู้เขียน — ไม่ดึงชื่อจริง (PII) เข้า prompt
    const messages = ordered.map((m) => ({
      author: m.authorMemberId ? "Agent" : m.authorContactId ? "Customer" : "System",
      visibility: m.visibility as "PUBLIC" | "INTERNAL",
      body: m.body,
    }));

    // 6. เรียก AI — แยก catch เพื่อไม่ leak รายละเอียด/key ออกไป client
    let summary: string;
    try {
      summary = await summarizeThread(messages);
    } catch (aiErr) {
      console.error(
        "[POST /api/tickets/:id/ai/summarize] AI error:",
        aiErr instanceof Error ? aiErr.message : String(aiErr)
      );
      return NextResponse.json(
        { data: null, error: { code: "AI_ERROR", message: "ไม่สามารถสร้างสรุปได้ในขณะนี้" } },
        { status: 502 }
      );
    }

    // 7. Audit log — การเรียก AI = action ที่มี cost. log แค่ metadata ห้าม log เนื้อหา/summary/PII
    void audit.log({
      tenantId,
      actor: { type: "member", memberId: member.id },
      targetType: "ticket",
      targetId: ticketId,
      action: "ticket.ai_summarized",
      metadata: { model: AI_SUMMARY_MODEL, messageCount: messages.length },
      ticketId,
    });

    const data: AiSummaryDTO = { summary };
    return NextResponse.json({ data, error: null }, { status: 200 });
  } catch (err) {
    console.error(
      "[POST /api/tickets/:id/ai/summarize] Unexpected error:",
      err instanceof Error ? err.message : String(err)
    );
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
