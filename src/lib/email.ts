/**
 * src/lib/email.ts
 * Outbound email abstraction — stub implementation (log only) + Postmark scaffold
 *
 * ออกแบบให้เสียบ provider จริงได้ผ่าน EMAIL_PROVIDER env:
 *   - EMAIL_PROVIDER=postmark → ใช้ Postmark API (scaffold — ต้อง set EMAIL_PROVIDER_API_KEY)
 *   - EMAIL_PROVIDER=sendgrid → ใช้ SendGrid API (TODO)
 *   - ไม่ set (default)       → log ลง console (dev mode)
 *
 * Threading headers:
 *   sendEmail รองรับ optional headers: messageId, inReplyTo, references
 *   ใช้สำหรับ agent reply outbound เพื่อ thread email กลับ client mail client
 *
 * TODO:
 *   - เพิ่ม email queue ผ่าน BullMQ เพื่อ retry เมื่อ provider ล่ม
 *   - ปิด magic-link URL logging ใน production
 *   - เพิ่ม HTML template engine (เช่น react-email)
 *   - Postmark case ปัจจุบันเป็น scaffold — ต้อง wire จริงก่อน production
 *
 * ⚠️ SECURITY: magic-link URL ที่ log ออกมามีความสามารถ login ได้ทันที
 *    การ log นี้ปลอดภัยเฉพาะ development environment เท่านั้น
 */

// =============================================================================
// TYPES
// =============================================================================

/** Optional email threading headers สำหรับ RFC 5322 thread support */
export interface EmailThreadingHeaders {
  /** Message-ID ที่จะตั้งให้ email นี้ (ไม่ต้องมี angle brackets) */
  messageId?: string;
  /** In-Reply-To header — Message-ID ของ email ที่ reply กลับ */
  inReplyTo?: string;
  /** References header — space-separated list ของ Message-IDs ใน thread */
  references?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** threading headers สำหรับ agent reply (optional) */
  headers?: EmailThreadingHeaders;
}

// =============================================================================
// CORE SEND FUNCTION
// =============================================================================

/**
 * ส่ง email ผ่าน provider ที่ตั้งไว้ใน EMAIL_PROVIDER env
 * รองรับ optional threading headers สำหรับ agent reply
 *
 * ⚠️ prod: ต้องเปลี่ยนไปใช้ provider จริงก่อน go-live
 */
export async function sendEmail(msg: EmailMessage): Promise<void> {
  const provider = process.env.EMAIL_PROVIDER ?? "console";

  switch (provider) {
    case "postmark":
      await sendViaPostmark(msg);
      return;

    case "console":
    default:
      // BLOCKER: production ต้องมี provider จริง — ถ้าไม่มีให้ throw แทน log
      // กัน token หรือ content หลุดเข้า log บน production
      if (process.env.NODE_ENV === "production") {
        throw new Error("[email] No email provider configured for production");
      }

      // stub: log เพื่อ dev/test เท่านั้น — ไม่ส่งจริง
      console.log("[email:stub] ──────────────────────────────────────");
      console.log(`[email:stub] → to:      ${msg.to}`);
      console.log(`[email:stub] → subject: ${msg.subject}`);
      console.log(`[email:stub] → html:    ${msg.html}`);
      if (msg.text) {
        console.log(`[email:stub] → text:    ${msg.text}`);
      }
      if (msg.headers) {
        if (msg.headers.messageId) {
          console.log(`[email:stub] → Message-ID:   <${msg.headers.messageId}>`);
        }
        if (msg.headers.inReplyTo) {
          console.log(`[email:stub] → In-Reply-To:  <${msg.headers.inReplyTo}>`);
        }
        if (msg.headers.references) {
          console.log(`[email:stub] → References:   ${msg.headers.references}`);
        }
      }
      console.log("[email:stub] ──────────────────────────────────────");
      return;
  }
}

// =============================================================================
// POSTMARK PROVIDER (scaffold — fetch-based, no SDK dependency)
// =============================================================================

/**
 * ส่ง email ผ่าน Postmark API
 *
 * ⚠️ SCAFFOLD: implementation นี้ยัง not fully wired — ต้องตั้ง EMAIL_PROVIDER_API_KEY
 *    และ test ก่อน deploy production
 *
 * threading headers: ส่งผ่าน Postmark Headers array
 * (Postmark รองรับ custom headers ผ่าน field "Headers": [{Name: ..., Value: ...}])
 */
async function sendViaPostmark(msg: EmailMessage): Promise<void> {
  const apiKey = process.env.EMAIL_PROVIDER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "[email:postmark] EMAIL_PROVIDER_API_KEY is not set — cannot send via Postmark"
    );
  }

  // สร้าง Headers array สำหรับ threading
  const customHeaders: Array<{ Name: string; Value: string }> = [];
  if (msg.headers?.messageId) {
    customHeaders.push({ Name: "Message-ID", Value: `<${msg.headers.messageId}>` });
  }
  if (msg.headers?.inReplyTo) {
    customHeaders.push({ Name: "In-Reply-To", Value: `<${msg.headers.inReplyTo}>` });
  }
  if (msg.headers?.references) {
    customHeaders.push({ Name: "References", Value: msg.headers.references });
  }

  const body: Record<string, unknown> = {
    From: process.env.EMAIL_FROM_ADDRESS ?? `support@${process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "helpwise.com"}`,
    To: msg.to,
    Subject: msg.subject,
    HtmlBody: msg.html,
    ...(msg.text ? { TextBody: msg.text } : {}),
    ...(customHeaders.length > 0 ? { Headers: customHeaders } : {}),
    MessageStream: "outbound",
  };

  const response = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Postmark-Server-Token": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "(no body)");
    throw new Error(
      `[email:postmark] API error ${response.status}: ${detail}`
    );
  }
}

// =============================================================================
// MAGIC-LINK HELPER
// =============================================================================

/**
 * compose และส่ง magic-link email ให้ contact
 *
 * ⚠️ SECURITY — DEV ONLY: log magic-link URL ลง console เพื่อความสะดวกในการ test
 *    link มีอายุ 15 นาทีและใช้ได้ครั้งเดียว แต่ผู้ที่เข้าถึง log สามารถ login ได้
 *    ต้องปิด log นี้ก่อน deploy production
 */
export async function sendMagicLink(
  to: string,
  link: string
): Promise<void> {
  // ⚠️ DEV ONLY: แสดง magic-link URL ใน log เพื่อ dev/test — ปิดใน production
  if (process.env.NODE_ENV !== "production") {
    console.log("[email:magic-link] ─────────────────────────────────");
    console.log(`[email:magic-link] → to:   ${to}`);
    console.log(`[email:magic-link] → link: ${link}`);
    console.log("[email:magic-link] ─────────────────────────────────");
  }

  await sendEmail({
    to,
    subject: "ลิงก์เข้าสู่ระบบของคุณ (มีอายุ 15 นาที)",
    html: `
      <p>สวัสดี,</p>
      <p>คลิกลิงก์ด้านล่างเพื่อเข้าสู่ระบบ:</p>
      <p><a href="${link}" style="font-weight:bold;">เข้าสู่ระบบ</a></p>
      <p>ลิงก์มีอายุ <strong>15 นาที</strong> และใช้ได้เพียงครั้งเดียวเท่านั้น</p>
      <p>หากคุณไม่ได้ขอลิงก์นี้ กรุณาเพิกเฉย</p>
    `,
    text: `เข้าสู่ระบบที่: ${link}\n\nลิงก์มีอายุ 15 นาที และใช้ได้เพียงครั้งเดียว`,
  });
}
