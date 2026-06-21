/**
 * POST /api/webhooks/email/ — Postmark inbound email webhook
 *
 * ⚠️ SECURITY CRITICAL:
 *   - ไม่มี x-tenant-id header (proxy.ts skip path นี้) — ต้อง resolve tenant เอง
 *   - ต้อง verify secret ก่อนทุก DB operation
 *   - ห้าม trust tenantId จาก payload — derive จาก recipient address เท่านั้น
 *   - inbound message ต้อง visibility=PUBLIC เสมอ (ห้าม INTERNAL)
 *
 * Idempotency: ใช้ ProcessedInboundEmail (tenantId, messageId) unique guard
 *   Postmark อาจส่ง webhook ซ้ำ — ต้องไม่สร้าง ticket/message ซ้ำ
 *
 * Non-2xx policy:
 *   - Return 200 สำหรับ permanent failures (parse error, unknown tenant, duplicate)
 *     เหตุผล: Postmark จะ retry ทุก non-2xx ซ้ำ ๆ — เราไม่ต้องการ retry สำหรับข้อผิดพลาดถาวร
 *   - Return 500 เฉพาะ transient infrastructure errors ที่คาดว่า retry จะช่วยได้
 *     (เช่น DB ล่มชั่วคราว หลัง verify สำเร็จแล้ว)
 *   - Return 401 สำหรับ bad secret (ก่อน parse ใด ๆ)
 */

import { NextRequest, NextResponse } from "next/server";
import { Prisma, TicketStatus, MessageVisibility } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { tenantPrisma } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { redis, tenantSlugCacheKey, TENANT_CACHE_TTL_SECONDS } from "@/lib/redis";
import {
  verifyInboundSecret,
  parsePostmarkInbound,
  extractSlugFromRecipient,
  extractTicketNumberFromSubject,
} from "@/lib/email/inbound";
import { createTicketWithNumber, createTicketMessage } from "@/lib/tickets";

// =============================================================================
// TENANT LOOKUP (reuse pattern จาก proxy.ts)
// =============================================================================

interface ResolvedTenant {
  id: string;
  plan: string;
}

/** NOT_FOUND sentinel สำหรับ negative Redis cache */
const NOT_FOUND_SENTINEL = "__NOT_FOUND__";

/**
 * lookup tenant จาก slug — Redis cache → DB
 * reuse pattern เดียวกับ proxy.ts เพื่อ consistency
 */
async function lookupTenantBySlug(slug: string): Promise<ResolvedTenant | null> {
  const cacheKey = tenantSlugCacheKey(slug);

  // ลอง Redis cache ก่อน
  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) {
      if (cached === NOT_FOUND_SENTINEL) return null;
      return JSON.parse(cached) as ResolvedTenant;
    }
  } catch {
    // Redis ล่ม — fallthrough ไป DB
  }

  // DB lookup
  const tenant = await prisma.tenant.findFirst({
    where: { slug, isActive: true },
    select: { id: true, plan: { select: { name: true } } },
  });

  if (!tenant) {
    try {
      await redis.set(cacheKey, NOT_FOUND_SENTINEL, "EX", 30);
    } catch {
      // ignore cache write error
    }
    return null;
  }

  const result: ResolvedTenant = { id: tenant.id, plan: tenant.plan.name };

  try {
    await redis.set(cacheKey, JSON.stringify(result), "EX", TENANT_CACHE_TTL_SECONDS);
  } catch {
    // ignore cache write error
  }

  return result;
}

// =============================================================================
// MAIN WEBHOOK HANDLER
// =============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ─── ขั้นที่ 1: ตรวจ secret ก่อนทุกอย่าง ──────────────────────────────────
  // กัน spoof — ไม่ leak เหตุผลว่าทำไม reject (401 ไม่มี body detail)
  if (!verifyInboundSecret(request)) {
    return new NextResponse(null, { status: 401 });
  }

  // ─── ขั้นที่ 2: parse JSON + validate payload ─────────────────────────────
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    // JSON parse error = permanent failure → 200 benign (ไม่ต้อง retry)
    console.warn("[inbound] Failed to parse JSON body — ignoring");
    return NextResponse.json(
      { data: null, error: "invalid_json" },
      { status: 200 }
    );
  }

  const parsed = parsePostmarkInbound(rawBody);
  if (!parsed) {
    // payload ผิดรูปแบบ / ขาด field สำคัญ = permanent → 200 benign
    console.warn("[inbound] parsePostmarkInbound returned null — ignoring malformed payload");
    return NextResponse.json(
      { data: null, error: "malformed_payload" },
      { status: 200 }
    );
  }

  const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "gethelpwise.xyz";

  // ─── ขั้นที่ 3: resolve tenant จาก recipient address ─────────────────────
  // ⚠️ tenant ต้องมาจาก recipient address เท่านั้น — ห้าม trust field อื่นจาก payload
  const slug = extractSlugFromRecipient(parsed.recipient, rootDomain);
  if (!slug) {
    // recipient ไม่ตรงรูปแบบ — ไม่รู้จะ route ไปที่ไหน → 200 benign
    console.warn("[inbound] Cannot extract slug from recipient:", parsed.recipient);
    return NextResponse.json(
      { data: null, error: "unroutable_recipient" },
      { status: 200 }
    );
  }

  let tenant: ResolvedTenant | null;
  try {
    tenant = await lookupTenantBySlug(slug);
  } catch (err) {
    // DB lookup ล้ม = transient → 500 (Postmark จะ retry)
    console.error("[inbound] Tenant lookup failed:", err instanceof Error ? err.message : String(err));
    return new NextResponse("Internal Server Error", { status: 500 });
  }

  if (!tenant) {
    // ไม่พบ tenant → 200 benign (ไม่มีประโยชน์ retry)
    console.warn("[inbound] Tenant not found for slug:", slug);
    return NextResponse.json(
      { data: null, error: "tenant_not_found" },
      { status: 200 }
    );
  }

  const tenantId = tenant.id;

  // ─── ขั้นที่ 4: idempotency CLAIM (atomic) ───────────────────────────────
  // BLOCKER-1 fix: claim-first แทน check-then-act — กัน TOCTOU race
  //   เดิม findUnique → ... → create มีช่องว่าง: webhook 2 ฉบับมาพร้อมกัน
  //   ผ่าน findUnique ทั้งคู่ (null) แล้วสร้าง ticket ซ้ำ
  //   ย้าย create มาก่อน process: อาศัย @@unique([tenantId, messageId]) เป็น lock
  //   P2002 = มี request อื่น claim messageId นี้ไปแล้ว → skip ทันที (200)
  let claimId: string;
  try {
    const claim = await prisma.processedInboundEmail.create({
      data: {
        tenantId,
        messageId: parsed.messageId,
        ticketId: null,
        status: "processing", // interim — อัพเดตเป็น ok/error หลัง process เสร็จ
      },
    });
    claimId = claim.id;
  } catch (claimErr) {
    if (
      claimErr instanceof Prisma.PrismaClientKnownRequestError &&
      claimErr.code === "P2002"
    ) {
      // duplicate delivery — มี request อื่น claim messageId นี้ไปแล้ว → skip
      return NextResponse.json(
        { data: { action: "duplicate" }, error: null },
        { status: 200 }
      );
    }
    // transient DB error ก่อนเริ่ม process → 500 ให้ Postmark retry
    console.error(
      "[inbound] Failed to claim idempotency slot:",
      claimErr instanceof Error ? claimErr.message : String(claimErr)
    );
    return new NextResponse("Internal Server Error", { status: 500 });
  }

  // ─── ขั้นที่ 5–8: process email ────────────────────────────────────────────
  // ถ้า process ล้ม → บันทึก ProcessedInboundEmail status="error" แล้ว return 200
  // (เพื่อกัน Postmark retry loop — error ถาวรไม่ควร retry)
  // ยกเว้น: ถ้า error เกิดก่อนที่จะรู้ tenantId (ขั้นที่ 1-3) → 500 เพื่อให้ retry
  let processedTicketId: string | null = null;
  let processedAction: "created" | "appended" = "created";

  try {
    const db = tenantPrisma(tenantId);

    // ─── ขั้นที่ 5: resolve หรือสร้าง Contact (per-tenant) ────────────────
    // upsert Contact ตาม from.email ภายใน tenant นี้
    // tenantPrisma inject tenantId ใน create + where อัตโนมัติ
    // แต่สำหรับ upsert composite unique ต้องใส่ tenantId ใน where ด้วยตัวเองเพื่อ explicit
    const contact = await db.contact.upsert({
      where: {
        // composite unique: @@unique([tenantId, email])
        // tenantPrisma extension inject tenantId เข้า where อัตโนมัติ
        // แต่ TypeScript type ของ upsert where ต้องการ composite key แบบนี้
        tenantId_email: { tenantId, email: parsed.from.email },
      },
      create: {
        // ใช้ scalar tenantId — ห้ามใช้ tenant: { connect } เพราะ tenantPrisma extension
        // จะ spread scalar tenantId เข้า create อยู่แล้ว → Prisma reject ถ้ามีทั้ง
        // relation (tenant) และ FK scalar (tenantId) พร้อมกัน (จะ throw ทุก inbound ใหม่)
        tenantId,
        email: parsed.from.email,
        name: parsed.from.name ?? undefined,
      },
      update: {
        // อัพเดต name ถ้า contact ยังไม่มีชื่อ
        ...(parsed.from.name ? { name: parsed.from.name } : {}),
      },
      select: { id: true, email: true, name: true },
    });

    // ─── ขั้นที่ 6: threading — หา ticket เดิมที่ match ─────────────────
    // ลำดับ thread matching:
    //   a. หา TicketMessage ที่ emailMessageId ตรงกับ inReplyTo หรือ references
    //   b. หา Ticket ที่ emailMessageId ตรงกับ inReplyTo หรือ references
    //   c. fallback: แยก ticketNumber จาก subject แล้วหา Ticket ตาม ticketNumber
    let existingTicketId: string | null = null;

    // รวม message-ids ที่ต้องการค้นหา (inReplyTo + references)
    const threadMessageIds: string[] = [];
    if (parsed.inReplyTo) {
      threadMessageIds.push(parsed.inReplyTo);
    }
    for (const ref of parsed.references) {
      if (!threadMessageIds.includes(ref)) {
        threadMessageIds.push(ref);
      }
    }

    if (threadMessageIds.length > 0) {
      // a. ค้นหา TicketMessage ที่ emailMessageId ตรงกับ thread ids (tenant-scoped)
      const matchedMsg = await db.ticketMessage.findFirst({
        where: {
          emailMessageId: { in: threadMessageIds },
        },
        select: { ticketId: true },
        orderBy: { createdAt: "desc" },
      });

      if (matchedMsg) {
        existingTicketId = matchedMsg.ticketId;
      } else {
        // b. ค้นหา Ticket ที่ emailMessageId ตรงกับ thread ids (tenant-scoped)
        const matchedTicket = await db.ticket.findFirst({
          where: {
            emailMessageId: { in: threadMessageIds },
          },
          select: { id: true },
        });
        if (matchedTicket) {
          existingTicketId = matchedTicket.id;
        }
      }
    }

    // c. fallback: แยก ticketNumber จาก subject
    if (!existingTicketId) {
      const ticketNum = extractTicketNumberFromSubject(parsed.subject);
      if (ticketNum !== null) {
        // ค้นหา ticket ตาม ticketNumber ภายใน tenant นี้ (tenant-scoped)
        const matchedByNum = await db.ticket.findFirst({
          where: { ticketNumber: ticketNum },
          select: {
            id: true,
            requesterContact: { select: { email: true } },
          },
        });
        // BLOCKER-2 fix: ticketNumber เดาได้ (sequential ต่อ tenant) + โผล่ใน subject ของ
        //   outbound email ทุกฉบับ — ถ้า thread ด้วย subject อย่างเดียว ใครก็ inject ข้อความ
        //   เข้า ticket ของลูกค้าคนอื่น + reopen ได้. จึง thread ด้วย subject ได้เฉพาะเมื่อ
        //   sender เป็น requesterContact ของ ticket นั้นจริง — ไม่ใช่ก็สร้าง ticket ใหม่แทน
        if (
          matchedByNum &&
          matchedByNum.requesterContact.email === parsed.from.email
        ) {
          existingTicketId = matchedByNum.id;
        }
      }
    }

    if (existingTicketId) {
      // ─── append message เข้า ticket เดิม ────────────────────────────
      // ดึง ticket status เพื่อตรวจว่าต้อง reopen ไหม
      const existingTicket = await db.ticket.findFirst({
        where: { id: existingTicketId },
        select: { id: true, status: true, ticketNumber: true },
      });

      if (!existingTicket) {
        // ticket หายไประหว่าง process (race) — สร้างใหม่แทน
        existingTicketId = null;
      } else {
        // สร้าง message — visibility=PUBLIC เสมอสำหรับ inbound email
        // ห้ามเป็น INTERNAL — inbound จากลูกค้าต้องเห็นได้จากทั้งสองฝ่าย
        await createTicketMessage(db, {
          tenantId,
          ticketId: existingTicketId,
          body: parsed.textBody || "(no text body)",
          visibility: MessageVisibility.PUBLIC,
          authorContactId: contact.id,
          emailMessageId: parsed.messageId,
          emailInReplyTo: parsed.inReplyTo ?? undefined,
          emailReferences: parsed.references.length > 0
            ? parsed.references.join(" ")
            : undefined,
        });

        // reopen ticket ถ้าเคย SOLVED/CLOSED (ลูกค้า reply กลับมา)
        if (
          existingTicket.status === TicketStatus.SOLVED ||
          existingTicket.status === TicketStatus.CLOSED
        ) {
          await db.ticket.update({
            where: { id: existingTicketId },
            data: { status: TicketStatus.OPEN },
          });

          // audit: reopen จาก inbound email
          void audit.log({
            tenantId,
            actor: { type: "system" },
            targetType: "ticket",
            targetId: existingTicketId,
            action: "ticket.reopened_from_email",
            before: { status: existingTicket.status },
            after: { status: TicketStatus.OPEN },
            ticketId: existingTicketId,
          });
        }

        processedTicketId = existingTicketId;
        processedAction = "appended";

        // audit: message appended from email
        void audit.log({
          tenantId,
          actor: { type: "system" },
          targetType: "ticket",
          targetId: existingTicketId,
          action: "ticket.message_appended_from_email",
          after: { messageId: parsed.messageId, contactId: contact.id },
          ticketId: existingTicketId,
        });
      }
    }

    if (!existingTicketId) {
      // ─── สร้าง ticket ใหม่ ─────────────────────────────────────────
      const newTicket = await createTicketWithNumber(db, {
        tenantId,
        subject: parsed.subject || `(no subject) from ${parsed.from.email}`,
        requesterContactId: contact.id,
        channel: "email",
        // เก็บ Message-ID ของ inbound email แรกที่ ticket นี้
        emailMessageId: parsed.messageId,
        firstMessage: {
          body: parsed.textBody || "(no text body)",
          // inbound message จากลูกค้าต้องเป็น PUBLIC เสมอ
          visibility: MessageVisibility.PUBLIC,
          authorContactId: contact.id,
          // threading fields ของ first message
          emailMessageId: parsed.messageId,
          emailInReplyTo: parsed.inReplyTo ?? undefined,
          emailReferences: parsed.references.length > 0
            ? parsed.references.join(" ")
            : undefined,
        },
      });

      processedTicketId = newTicket.id;
      processedAction = "created";

      // audit: ticket สร้างจาก inbound email
      void audit.log({
        tenantId,
        actor: { type: "system" },
        targetType: "ticket",
        targetId: newTicket.id,
        action: "ticket.created_from_email",
        after: {
          ticketNumber: newTicket.ticketNumber,
          contactId: contact.id,
          messageId: parsed.messageId,
        },
        ticketId: newTicket.id,
      });
    }

    // ─── ขั้นที่ 8: อัพเดต claim → status="ok" + ticketId ────────────────
    // claim ถูกสร้างไว้แล้วในขั้นที่ 4 — ใช้ update (ไม่ใช่ create) เพื่อกัน duplicate
    await prisma.processedInboundEmail.update({
      where: { id: claimId },
      data: { ticketId: processedTicketId, status: "ok" },
    });

    return NextResponse.json(
      {
        data: { ticketId: processedTicketId, action: processedAction },
        error: null,
      },
      { status: 200 }
    );
  } catch (err) {
    // unexpected error หลัง verify + parse ผ่านแล้ว
    // log error แล้วพยายามบันทึก ProcessedInboundEmail status="error"
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[inbound] Unexpected error processing email:", {
      messageId: parsed.messageId,
      tenantId,
      error: errMsg,
    });

    // อัพเดต claim → status="error" (claim ถูกสร้างในขั้นที่ 4 แล้ว — ใช้ update)
    // STRONG-4: ไม่เก็บ err.message ดิบ (Prisma error อาจมี param values/PII)
    //   เก็บแค่ error code หรือ message prefix สั้น ๆ
    const safeErrDetail =
      err instanceof Prisma.PrismaClientKnownRequestError
        ? `PrismaError:${err.code}`
        : errMsg.slice(0, 200);
    try {
      await prisma.processedInboundEmail.update({
        where: { id: claimId },
        data: { status: "error", errorDetail: safeErrDetail },
      });
    } catch (saveErr) {
      console.error(
        "[inbound] Failed to update error record:",
        saveErr instanceof Error ? saveErr.message : String(saveErr)
      );
    }

    // return 200 เพื่อกัน Postmark retry ซ้ำ ๆ กับ payload เดิมที่ fail ถาวร
    // หมายเหตุ: ถ้า error เป็น transient (เช่น DB ล่มชั่วคราวก่อนเราจะ save record)
    //   Postmark จะไม่ retry เพราะเราส่ง 200 ไปแล้ว
    //   trade-off: ยอมเสีย retry เพื่อแลกกับไม่เกิด duplicate flood
    //   ถ้าต้องการ retry: ใช้ BullMQ queue แทน inline processing (Phase ถัดไป)
    return NextResponse.json(
      { data: null, error: "internal_error" },
      { status: 200 }
    );
  }
}
