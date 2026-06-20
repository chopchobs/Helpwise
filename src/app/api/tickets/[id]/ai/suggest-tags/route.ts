/**
 * POST /api/tickets/:id/ai/suggest-tags — เสนอ tag ให้ ticket ด้วย Claude API (Phase 29 Slice 3)
 *
 * ⚠️ Tenant Isolation:
 *   - tenantId ดึงจาก requireAgent() เท่านั้น ห้ามรับจาก client
 *   - ทุก query ผ่าน tenantPrisma(ctx.tenantId) → LLM เข้าถึงข้าม tenant ไม่ได้แม้ถูก inject
 *
 * ⚠️ Agent-Only: tag เป็น internal — ห้าม expose ฝั่ง portal เด็ดขาด
 *
 * ⚠️ เสนอจาก tag ที่มีจริงใน tenant เท่านั้น:
 *   - ดึง tag ของ tenant ผ่าน tenantPrisma → ส่งชื่อให้ LLM เลือก subset
 *   - validate กลับว่า tag ที่ AI เสนอ "มีจริงใน tenant" (filter by name) กัน LLM แต่ง tag ใหม่
 *   - route นี้ "ไม่" apply tag เอง — agent กด apply ผ่าน POST /api/tickets/:id/tags เดิม
 *
 * Pipeline: extract tenant → requireAgent → hasFeature(ai_assist) → verify ticket → rate-limit → AI
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAgent, toAuthErrorResponse } from "@/lib/auth";
import { tenantPrisma } from "@/lib/tenant";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import { audit } from "@/lib/audit";
import { checkRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { suggestTags, AI_SUMMARY_MODEL } from "@/lib/ai";
import type { AiTagSuggestionDTO } from "@/types/ai";
import type { TagDTO } from "@/types/tag";

// cap จำนวน messages ที่ส่งให้ AI กัน prompt ใหญ่/cost พุ่ง — เอาล่าสุด ~50
const MAX_MESSAGES = 50;

// rate-limit: 10 ครั้ง / 1 ชั่วโมง ต่อ tenant (AI call มี cost) — เดียวกับ summarize
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
      key: rateLimitKey("ai-suggest-tags", tenantId),
      limit: RATE_LIMIT,
      windowSeconds: RATE_WINDOW_SECONDS,
    });
    if (!rl.allowed) {
      return rateLimitResponse(rl.retryAfterSeconds);
    }

    // 5. ดึง tag ของ tenant (tenant-scoped) — เป็น whitelist ที่ AI เลือกได้เท่านั้น
    const tenantTags = await db.tag.findMany({
      select: { id: true, name: true, color: true },
    });

    // 6. ดึง messages ของ ticket — agent เห็นทั้ง PUBLIC + INTERNAL (ฝั่ง agent ไม่ใช่ portal)
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

    // 7. เรียก AI — ส่งชื่อ tag ที่มีใน tenant ให้เลือก subset
    let suggestedNames: string[];
    try {
      suggestedNames = await suggestTags(
        messages,
        tenantTags.map((t) => t.name)
      );
    } catch (aiErr) {
      console.error(
        "[POST /api/tickets/:id/ai/suggest-tags] AI error:",
        aiErr instanceof Error ? aiErr.message : String(aiErr)
      );
      return NextResponse.json(
        { data: null, error: { code: "AI_ERROR", message: "ไม่สามารถเสนอ tag ได้ในขณะนี้" } },
        { status: 502 }
      );
    }

    // 8. ⚠️ Validate กลับเป็น TagDTO เฉพาะ tag ที่ "มีจริงใน tenant" (กัน LLM แต่ง/ข้าม tenant)
    //    map ชื่อ → tag จริง ใน list ที่ดึงมา (suggestTags filter แล้ว แต่ validate ซ้ำที่ route)
    const byName = new Map(tenantTags.map((t) => [t.name, t]));
    const tags: TagDTO[] = [];
    for (const name of suggestedNames) {
      const t = byName.get(name);
      if (t) {
        tags.push({ id: t.id, name: t.name, color: t.color });
      }
    }

    // 9. Audit log — log แค่ metadata ห้าม log เนื้อหา/PII
    void audit.log({
      tenantId,
      actor: { type: "member", memberId: member.id },
      targetType: "ticket",
      targetId: ticketId,
      action: "ticket.ai_tags_suggested",
      metadata: { model: AI_SUMMARY_MODEL, messageCount: messages.length, suggestedCount: tags.length },
      ticketId,
    });

    const data: AiTagSuggestionDTO = { tags };
    return NextResponse.json({ data, error: null }, { status: 200 });
  } catch (err) {
    console.error(
      "[POST /api/tickets/:id/ai/suggest-tags] Unexpected error:",
      err instanceof Error ? err.message : String(err)
    );
    const { error, status } = toAuthErrorResponse(err);
    return NextResponse.json({ data: null, error }, { status });
  }
}
