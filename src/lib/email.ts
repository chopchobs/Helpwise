/**
 * src/lib/email.ts
 * Outbound email abstraction — stub implementation (log only)
 *
 * ออกแบบให้เสียบ provider จริงได้ใน Phase ถัดไป:
 *   - set EMAIL_PROVIDER=postmark → ใช้ Postmark API
 *   - set EMAIL_PROVIDER=sendgrid → ใช้ SendGrid API
 *   - ไม่ set (default) → log ลง console (dev mode)
 *
 * TODO (Phase: Email Integration):
 *   - เพิ่ม Postmark / SendGrid provider (ใส่ API key ใน POSTMARK_API_KEY / SENDGRID_API_KEY)
 *   - เพิ่ม email queue ผ่าน BullMQ เพื่อ retry เมื่อ provider ล่ม
 *   - ปิด magic-link URL logging ใน production
 *   - เพิ่ม HTML template engine (เช่น react-email)
 *
 * ⚠️ SECURITY: magic-link URL ที่ log ออกมามีความสามารถ login ได้ทันที
 *    การ log นี้ปลอดภัยเฉพาะ development environment เท่านั้น
 *    ต้องปิดก่อน deploy production (ดู TODO ด้านบน)
 */

// =============================================================================
// TYPES
// =============================================================================

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

// =============================================================================
// CORE SEND FUNCTION
// =============================================================================

/**
 * ส่ง email ผ่าน provider ที่ตั้งไว้ใน EMAIL_PROVIDER env
 * ปัจจุบัน: stub — log ลง console เท่านั้น
 *
 * ⚠️ prod: ต้องเปลี่ยนไปใช้ provider จริงก่อน go-live
 */
export async function sendEmail(msg: EmailMessage): Promise<void> {
  const provider = process.env.EMAIL_PROVIDER ?? "console";

  switch (provider) {
    case "console":
    default:
      // BLOCKER-2: production ต้องมี provider จริง — ถ้าไม่มีให้ throw แทน log
      // กัน magic-link token (ที่อยู่ใน msg.html) หลุดเข้า log บน production
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
      console.log("[email:stub] ──────────────────────────────────────");
      return;

    // TODO (Phase: Email Integration): เพิ่ม case "postmark" และ "sendgrid" ที่นี่
    // case "postmark":
    //   await sendViaPostmark(msg);
    //   return;
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
