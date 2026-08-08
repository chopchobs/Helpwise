/**
 * POST /api/jobs/send-email
 * Worker route — ส่ง outbound agent-reply email (เรียกจาก Upstash QStash)
 *
 * ⚠️ Worker รันนอก middleware → ไม่มี tenant context จาก subdomain
 *    tenantId มาจาก payload ที่ verify QStash signature แล้วเท่านั้น
 *    แล้ว tenantPrisma(tenantId) ทุก query — ห้าม query ที่ไม่มี tenant scope เด็ดขาด
 *
 * Security:
 *   - verify QStash signature ก่อนทำงานใด ๆ (fail-closed บน production)
 *
 * Idempotency (QStash retry job ซ้ำได้ + worker ขนานกันได้):
 *   - claim แบบ atomic (conditional updateMany) ก่อนส่ง → กัน TOCTOU double-send
 *     ระหว่าง check (emailSentAt===null) กับ set มี race ถ้า 2 worker รันพร้อมกัน;
 *     conditional updateMany ปิด gap นี้: มีแค่ worker เดียวที่ count===1 (ชนะ claim)
 *   - ถ้า claim แล้ว sendEmail throw → rollback emailSentAt=null ให้ QStash retry ส่งใหม่ได้
 *     (tradeoff: claim-before-send กัน double-send, rollback กัน lost email เมื่อ provider ล้ม)
 *
 * Internal-note isolation (re-check ที่ worker — ไม่ trust producer):
 *   - ถ้า message ไม่ใช่ visibility=PUBLIC → ไม่ส่ง (internal note ห้าม email)
 */

import { NextRequest, NextResponse } from "next/server";
import { tenantPrisma } from "@/lib/tenant";
import { verifyQStashSignature, type SendEmailJob } from "@/lib/queue";
import { recordInboundAttempt } from "@/lib/inbound-counter";
import { recordHeartbeat } from "@/lib/heartbeat";
import { sendEmail } from "@/lib/email";
import { MessageVisibility } from "@prisma/client";

/**
 * escape HTML special chars กัน HTML injection ในกล่องเมลลูกค้า
 * (เหมือน reply route เดิม — agent body interpolate เข้า outbound HTML)
 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Verify QStash signature ก่อนทุก operation (fail-closed prod)
  //    verify อ่าน body ครั้งเดียว → คืน rawBody มา parse ต่อ (stream consume ได้ครั้งเดียว)
  const { valid, rawBody, attemptClass } = await verifyQStashSignature(request);
  // Phase 39 ลำดับ 3: นับทุก attempt ตามคลาสที่ verify จำแนกจาก header เอง
  // (ไม่ throw — counter ห้ามทำให้ worker ล้ม)
  await recordInboundAttempt(attemptClass);
  if (!valid) {
    return NextResponse.json(
      { data: null, error: { code: "UNAUTHORIZED", message: "Invalid or missing QStash signature" } },
      { status: 401 }
    );
  }

  // 2. Parse payload จาก verified body เท่านั้น
  let job: SendEmailJob;
  try {
    const parsed = JSON.parse(rawBody) as Partial<SendEmailJob>;
    if (typeof parsed.tenantId !== "string" || typeof parsed.messageId !== "string") {
      throw new Error("missing tenantId/messageId");
    }
    job = { tenantId: parsed.tenantId, messageId: parsed.messageId };
  } catch {
    return NextResponse.json(
      { data: null, error: { code: "INVALID_PAYLOAD", message: "Payload ต้องมี tenantId และ messageId" } },
      { status: 400 }
    );
  }

  try {
    // 3. tenant-scoped client — tenantId จาก verified payload (worker ไม่มี middleware context)
    const db = tenantPrisma(job.tenantId);

    // 4. โหลด message + ticket + requester ผ่าน db (tenant-scoped ทุก query)
    const message = await db.ticketMessage.findFirst({
      where: { id: job.messageId },
      select: {
        id: true,
        body: true,
        visibility: true,
        emailSentAt: true,
        emailMessageId: true,
        emailInReplyTo: true,
        emailReferences: true,
        ticket: {
          select: {
            subject: true,
            ticketNumber: true,
            requesterContact: { select: { email: true } },
          },
        },
      },
    });

    // message ไม่พบใน tenant นี้ → skip (idempotent-safe, ไม่ leak ว่ามี/ไม่มี)
    if (!message) {
      return NextResponse.json(
        { data: { skipped: "not_found" }, error: null },
        { status: 200 }
      );
    }

    // 5a. internal-note isolation — re-check ที่ worker, ไม่ trust producer
    //     INTERNAL note ห้ามส่ง email เด็ดขาด (กฎ CLAUDE.md verbatim)
    if (message.visibility !== MessageVisibility.PUBLIC) {
      return NextResponse.json(
        { data: { skipped: "not_public" }, error: null },
        { status: 200 }
      );
    }

    // 5b. idempotent — QStash retry ส่ง job ซ้ำได้ ห้ามส่งเมลซ้ำ
    if (message.emailSentAt !== null) {
      return NextResponse.json(
        { data: { skipped: "already_sent" }, error: null },
        { status: 200 }
      );
    }

    // 5c. ไม่มี requester email → ส่งไม่ได้ skip
    const contactEmail = message.ticket.requesterContact?.email;
    if (!contactEmail) {
      return NextResponse.json(
        { data: { skipped: "no_recipient" }, error: null },
        { status: 200 }
      );
    }

    // 6. claim แบบ atomic ก่อนส่ง — กัน double-send เมื่อ worker ขนาน/QStash retry ซ้ำ
    //    conditional: set emailSentAt เฉพาะตอนยัง PUBLIC + ยัง null (เงื่อนไขเดิมยกมาเป็น atomic guard)
    //    มีแค่ worker เดียวที่ count===1 (ชนะ claim) → worker อื่น count===0 → skip ไม่ส่ง
    const claimedAt = new Date();
    const claim = await db.ticketMessage.updateMany({
      where: {
        id: message.id,
        visibility: MessageVisibility.PUBLIC,
        emailSentAt: null,
      },
      data: { emailSentAt: claimedAt },
    });

    // claim แพ้ (worker อื่น claim/ส่งไปแล้ว) → skip ไม่ส่ง (กัน double-send)
    if (claim.count === 0) {
      return NextResponse.json(
        { data: { skipped: "already_claimed" }, error: null },
        { status: 200 }
      );
    }

    // 7. claim สำเร็จ (count===1) → ส่ง email พร้อม threading headers เดิม
    const replySubjectPrefix = `[#${message.ticket.ticketNumber}]`;
    const emailSubject = message.ticket.subject.startsWith(replySubjectPrefix)
      ? message.ticket.subject
      : `${replySubjectPrefix} ${message.ticket.subject}`;

    try {
      await sendEmail({
        to: contactEmail,
        subject: emailSubject,
        html: `<p>${escapeHtml(message.body).replace(/\n/g, "<br>")}</p>`,
        text: message.body,
        headers: {
          messageId: message.emailMessageId ?? undefined,
          inReplyTo: message.emailInReplyTo ?? undefined,
          references: message.emailReferences ?? undefined,
        },
      });
    } catch (sendErr) {
      // 7b. ส่งล้มหลัง claim → rollback emailSentAt=null ให้ QStash retry รอบหน้าส่งใหม่ได้
      //     (claim-before-send กัน double-send; rollback กัน lost email เมื่อ provider ล้ม)
      await db.ticketMessage.updateMany({
        where: { id: message.id, emailSentAt: claimedAt },
        data: { emailSentAt: null },
      });
      console.error(
        "[send-email] send failed (rolled back claim):",
        sendErr instanceof Error ? sendErr.message : String(sendErr)
      );
      return NextResponse.json(
        { data: null, error: { code: "SEND_FAILED", message: "ส่ง email ไม่สำเร็จ" } },
        { status: 500 }
      );
    }

    // Phase 39 ลำดับ 4: กลไกนี้ทำงานสำเร็จจริง → เต้น heartbeat
    //  (เต้นหลังงานสำเร็จเท่านั้น — ถ้าเต้นตอนรับ request จะสดทั้งที่งานล้ม
    //   ⇒ corroboration ใน §C พัง: เคส signing key ไม่ตรงต้องทำให้ heartbeat ค้างจริง)
    await recordHeartbeat("send-email");

    return NextResponse.json(
      { data: { sent: true, messageId: message.id }, error: null },
      { status: 200 }
    );
  } catch (err) {
    // error อื่น ๆ (load/parse) → คืน 500 เพื่อให้ QStash retry
    console.error(
      "[send-email] job failed:",
      err instanceof Error ? err.message : String(err)
    );
    return NextResponse.json(
      { data: null, error: { code: "SEND_FAILED", message: "ส่ง email ไม่สำเร็จ" } },
      { status: 500 }
    );
  }
}
