/**
 * POST /api/jobs/webhook-deliver
 * Worker route — ส่ง outbound webhook หนึ่ง delivery (เรียกจาก Upstash QStash)
 *
 * source of truth: docs/webhooks-contract.md § 4 (headers) · § 5 (retry/DLQ) · § 6 (SSRF)
 *
 * ⚠️ Worker รันนอก middleware → ไม่มี tenant context จาก subdomain
 *    tenantId มาจาก payload ที่ verify QStash signature แล้วเท่านั้น
 *    แล้ว tenantPrisma(tenantId) ทุก query — ห้าม query ที่ไม่มี tenant scope เด็ดขาด
 *
 * Security:
 *   - verify QStash signature ก่อนทำงานใด ๆ (fail-closed บน production)
 *   - SSRF re-check ทุก attempt หลัง DNS resolve (กัน DNS rebinding) → ไม่ผ่าน = DEAD ทันที
 *   - ไม่ follow redirect (redirect: "manual") — 3xx ถือว่าล้มเหลว
 *   - responseBody ตัด 500 ตัวอักษรก่อนเก็บ (กันใช้ระบบเป็น proxy อ่านข้อมูลภายใน)
 *   - ห้าม log/return secret ของ endpoint
 *
 * Internal-note isolation (re-check ที่ worker — ไม่ trust payload ที่ enqueue ไว้):
 *   - event ticket.message_created ที่ payload.data.message.visibility ≠ PUBLIC → DEAD ไม่ยิงเลย
 *
 * Retry semantics (§ 5):
 *   - 2xx → SUCCEEDED → 200
 *   - ล้ม + attempt < MAX → FAILED → 500 (ให้ QStash retry)
 *   - ล้ม + attempt >= MAX → DEAD (DLQ) → 200 (หยุด retry)
 */

import { NextRequest, NextResponse } from "next/server";
import { tenantPrisma } from "@/lib/tenant";
import {
  verifyQStashSignature,
  getJobTargetUrl,
  WEBHOOK_DELIVER_WORKER_PATH,
  type WebhookDeliveryJob,
} from "@/lib/queue";
import { recordInboundAttempt } from "@/lib/inbound-counter";
import {
  assertSafeDestination,
  buildSignatureHeader,
  serializeEnvelope,
  WEBHOOK_EVENT_WIRE_NAMES,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_TIMEOUT_MS,
  WEBHOOK_USER_AGENT,
} from "@/lib/webhooks";
import { WebhookDeliveryStatus, WebhookEventType } from "@prisma/client";
import type { WebhookEnvelope, WebhookMessageEventData } from "@/types/webhook";

/** ความยาวสูงสุดของ responseBody/errorMessage ที่เก็บลง DB (§ 5) */
const RESPONSE_BODY_MAX_CHARS = 500;

function truncate(value: string): string {
  return value.length > RESPONSE_BODY_MAX_CHARS
    ? value.slice(0, RESPONSE_BODY_MAX_CHARS)
    : value;
}

/** helper: skip แบบสำเร็จ (200) — ไม่ให้ QStash retry ต่อ */
function skip(reason: string): NextResponse {
  return NextResponse.json(
    { data: { skipped: reason }, error: null },
    { status: 200 }
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Verify QStash signature ก่อนทุก operation (fail-closed prod)
  //    pin target URL ของ worker นี้ (sign-side/verify-side ต้องอ่านค่าเดียวกัน)
  const { valid, rawBody, attemptClass } = await verifyQStashSignature(
    request,
    getJobTargetUrl(WEBHOOK_DELIVER_WORKER_PATH)
  );
  // Phase 39 ลำดับ 3: นับทุก attempt ตามคลาสที่ verify จำแนกจาก header เอง
  await recordInboundAttempt(attemptClass);
  if (!valid) {
    return NextResponse.json(
      { data: null, error: { code: "UNAUTHORIZED", message: "Invalid or missing QStash signature" } },
      { status: 401 }
    );
  }

  // 2. Parse payload จาก verified body เท่านั้น
  let job: WebhookDeliveryJob;
  try {
    const parsed = JSON.parse(rawBody) as Partial<WebhookDeliveryJob>;
    if (typeof parsed.tenantId !== "string" || typeof parsed.deliveryId !== "string") {
      throw new Error("missing tenantId/deliveryId");
    }
    job = { tenantId: parsed.tenantId, deliveryId: parsed.deliveryId };
  } catch {
    return NextResponse.json(
      { data: null, error: { code: "INVALID_PAYLOAD", message: "Payload ต้องมี tenantId และ deliveryId" } },
      { status: 400 }
    );
  }

  try {
    // 3. tenant-scoped client — tenantId จาก verified payload (worker ไม่มี middleware context)
    const db = tenantPrisma(job.tenantId);

    // 4. โหลด delivery + endpoint (composite FK บังคับให้ endpoint อยู่ tenant เดียวกันเสมอ)
    const delivery = await db.webhookDelivery.findFirst({
      where: { id: job.deliveryId },
      select: {
        id: true,
        eventType: true,
        eventId: true,
        payload: true,
        status: true,
        attemptCount: true,
        endpoint: { select: { url: true, secret: true, enabled: true } },
      },
    });

    // ไม่พบใน tenant นี้ → skip (ไม่ leak ว่ามี/ไม่มีใน tenant อื่น)
    if (!delivery) return skip("not_found");
    // idempotent — QStash retry job ซ้ำได้ ห้ามยิงซ้ำเมื่อสำเร็จไปแล้ว
    if (delivery.status === WebhookDeliveryStatus.SUCCEEDED) {
      return skip("already_succeeded");
    }
    // เข้า DLQ แล้ว → หยุด (replay ต้องสั่งด้วยมือผ่าน API replay)
    if (delivery.status === WebhookDeliveryStatus.DEAD) return skip("dead");
    // endpoint ถูกลบ/ปิดหลัง enqueue → ไม่ส่ง
    if (!delivery.endpoint?.enabled) return skip("endpoint_disabled");

    const endpoint = delivery.endpoint;
    const envelope = delivery.payload as unknown as WebhookEnvelope;

    // 5. Internal-note isolation — re-check จาก payload จริงที่จะส่ง ไม่ trust producer
    //    INTERNAL note ห้ามออกนอกระบบเด็ดขาด → mark DEAD (ไม่ retry) และไม่ยิง fetch
    if (delivery.eventType === WebhookEventType.TICKET_MESSAGE_CREATED) {
      const messageData = envelope.data as WebhookMessageEventData | undefined;
      if (messageData?.message?.visibility !== "PUBLIC") {
        await db.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: WebhookDeliveryStatus.DEAD,
            errorMessage: "internal_note_blocked",
          },
        });
        return skip("internal_note_blocked");
      }
    }

    // 6. attempt ปัจจุบัน (1-based) — ใช้ทั้ง header และเกณฑ์ตัดเข้า DLQ
    const attempt = delivery.attemptCount + 1;

    // 7. SSRF guard ทุก attempt (resolve DNS ใหม่ทุกครั้ง — กัน DNS rebinding)
    //    ปลายทางไม่ปลอดภัยไม่มีทางดีขึ้นเอง → DEAD ทันที ไม่ retry
    const destination = await assertSafeDestination(endpoint.url);
    if (!destination.ok) {
      await db.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: WebhookDeliveryStatus.DEAD,
          attemptCount: attempt,
          lastAttemptAt: new Date(),
          errorMessage: `blocked_destination:${destination.reason}`,
        },
      });
      return skip("blocked_destination");
    }

    // 8. serialize ครั้งเดียว → ใช้ทั้ง sign และ body (byte-per-byte เดียวกัน ไม่งั้น verify ไม่ผ่าน)
    const rawPayload = serializeEnvelope(envelope);
    const timestampSeconds = Math.floor(Date.now() / 1000);

    let responseStatus: number | null = null;
    let responseBody: string | null = null;
    let errorMessage: string | null = null;

    // 9. ยิงจริง — ไม่ follow redirect, timeout 10s
    try {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": WEBHOOK_USER_AGENT,
          "X-Helpwise-Event": WEBHOOK_EVENT_WIRE_NAMES[delivery.eventType],
          "X-Helpwise-Event-Id": delivery.eventId,
          "X-Helpwise-Delivery-Id": delivery.id,
          "X-Helpwise-Attempt": String(attempt),
          "X-Helpwise-Signature": buildSignatureHeader(
            endpoint.secret,
            rawPayload,
            timestampSeconds
          ),
        },
        body: rawPayload,
        redirect: "manual",
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });

      responseStatus = response.status;
      // เก็บไว้ debug เท่านั้น — ตัด 500 ตัวก่อนเสมอ
      responseBody = truncate(await response.text().catch(() => ""));
      if (responseStatus < 200 || responseStatus >= 300) {
        errorMessage = `http_${responseStatus}`;
      }
    } catch (err) {
      // timeout / network error — เก็บเฉพาะ message สั้น ๆ (ห้าม dump stack)
      errorMessage = truncate(
        err instanceof Error ? err.message : String(err)
      );
    }

    // 10. บันทึกผล + ตัดสินสถานะตาม § 5
    const succeeded =
      responseStatus !== null && responseStatus >= 200 && responseStatus < 300;
    const exhausted = attempt >= WEBHOOK_MAX_ATTEMPTS;
    const status = succeeded
      ? WebhookDeliveryStatus.SUCCEEDED
      : exhausted
        ? WebhookDeliveryStatus.DEAD
        : WebhookDeliveryStatus.FAILED;

    await db.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status,
        attemptCount: attempt,
        lastAttemptAt: new Date(),
        responseStatus,
        responseBody,
        errorMessage,
      },
    });

    if (succeeded) {
      return NextResponse.json(
        { data: { delivered: true, deliveryId: delivery.id }, error: null },
        { status: 200 }
      );
    }
    // ครบ MAX attempts → เข้า DLQ, ตอบ 200 เพื่อหยุด QStash retry
    if (exhausted) {
      return NextResponse.json(
        { data: { deadLettered: true, deliveryId: delivery.id }, error: null },
        { status: 200 }
      );
    }
    // ยังเหลือ attempt → 500 ให้ QStash retry ตาม backoff ของมัน
    return NextResponse.json(
      { data: null, error: { code: "DELIVERY_FAILED", message: "ส่ง webhook ไม่สำเร็จ" } },
      { status: 500 }
    );
  } catch (err) {
    // error ที่ไม่คาดคิด (load/update ล้ม) → 500 ให้ QStash retry
    // ⚠️ ห้าม leak รายละเอียดปลายทาง/secret ออก response
    console.error(
      "[webhook-deliver] job failed:",
      err instanceof Error ? err.message : String(err)
    );
    return NextResponse.json(
      { data: null, error: { code: "DELIVERY_FAILED", message: "ส่ง webhook ไม่สำเร็จ" } },
      { status: 500 }
    );
  }
}
