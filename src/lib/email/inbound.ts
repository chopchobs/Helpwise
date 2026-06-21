/**
 * src/lib/email/inbound.ts
 * Postmark inbound email parser + secret verifier
 *
 * Postmark ส่ง webhook แบบ JSON มายัง POST /api/webhooks/email/
 * ไฟล์นี้ทำหน้าที่:
 *   1. parse และ normalize payload จาก Postmark inbound JSON format
 *   2. verify shared secret (constant-time) กัน spoof
 *   3. แยก slug จาก recipient address เพื่อ route ไป tenant
 *   4. แยก ticketNumber จาก subject เป็น fallback threading
 *
 * ⚠️ SECURITY: ทุก parse function ต้อง defensive — payload มาจาก internet
 *    ห้าม trust field ใดโดยไม่ validate รูปแบบ
 */

import crypto from "crypto";

// =============================================================================
// TYPES
// =============================================================================

/** Postmark inbound payload (ส่วนที่ใช้งาน) — ตาม Postmark Inbound JSON format */
interface PostmarkHeader {
  Name: string;
  Value: string;
}

interface PostmarkFromFull {
  Email?: unknown;
  Name?: unknown;
}

interface RawPostmarkPayload {
  MessageID?: unknown;
  From?: unknown;
  FromFull?: unknown;
  To?: unknown;
  ToFull?: unknown;
  OriginalRecipient?: unknown;
  Subject?: unknown;
  TextBody?: unknown;
  HtmlBody?: unknown;
  StrippedTextReply?: unknown;
  Headers?: unknown;
  Date?: unknown;
  MailboxHash?: unknown;
}

/** Normalized inbound email ที่ใช้ภายใน system */
export interface ParsedInboundEmail {
  /** RFC 5322 Message-ID — ใช้สำหรับ idempotency + threading */
  messageId: string;
  from: {
    email: string;
    name: string | null;
  };
  /** recipient email address ที่ email ถูกส่งมา (เช่น support@acme.gethelpwise.xyz) */
  recipient: string;
  subject: string;
  textBody: string;
  htmlBody: string | null;
  /** In-Reply-To header — ใช้ threading กลับ ticket เดิม */
  inReplyTo: string | null;
  /** References header — array ของ Message-ID ที่อยู่ใน thread */
  references: string[];
}

// =============================================================================
// PARSE POSTMARK INBOUND PAYLOAD
// =============================================================================

/**
 * parse และ normalize payload จาก Postmark inbound JSON
 * Return null ถ้า payload ขาด field สำคัญหรือรูปแบบผิด
 * (caller จะ return 200 benign เพื่อไม่ trigger Postmark retry)
 *
 * @param payload - raw JSON body จาก Postmark webhook (unknown — ยังไม่ validate)
 */
export function parsePostmarkInbound(payload: unknown): ParsedInboundEmail | null {
  // defensive: ต้องเป็น object
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const raw = payload as RawPostmarkPayload;

  // --- MessageID (required) ---
  if (typeof raw.MessageID !== "string" || raw.MessageID.trim() === "") {
    return null;
  }
  const messageId = raw.MessageID.trim();

  // --- From email (required) ---
  // ลอง FromFull.Email ก่อน แล้ว fallback ไป From string
  let fromEmail: string | null = null;
  let fromName: string | null = null;

  if (
    raw.FromFull &&
    typeof raw.FromFull === "object" &&
    !Array.isArray(raw.FromFull)
  ) {
    const ff = raw.FromFull as PostmarkFromFull;
    if (typeof ff.Email === "string" && ff.Email.includes("@")) {
      fromEmail = ff.Email.trim().toLowerCase();
    }
    if (typeof ff.Name === "string" && ff.Name.trim() !== "") {
      fromName = ff.Name.trim();
    }
  }

  // fallback: parse From string (รูปแบบ "Name <email>" หรือ "email")
  if (!fromEmail && typeof raw.From === "string") {
    const match = raw.From.match(/<([^>]+)>/) ?? raw.From.match(/^([^\s]+@[^\s]+)$/);
    if (match?.[1]?.includes("@")) {
      fromEmail = match[1].trim().toLowerCase();
    }
  }

  if (!fromEmail) {
    return null;
  }

  // --- Recipient (required) ---
  // ลอง OriginalRecipient ก่อน (Postmark recommend) แล้ว fallback To
  let recipient: string | null = null;

  if (typeof raw.OriginalRecipient === "string" && raw.OriginalRecipient.includes("@")) {
    recipient = raw.OriginalRecipient.trim().toLowerCase();
  } else if (typeof raw.To === "string" && raw.To.includes("@")) {
    // To อาจเป็น "Name <email>" — extract email ออกมา
    const match = raw.To.match(/<([^>]+@[^>]+)>/) ?? raw.To.match(/([^\s,]+@[^\s,]+)/);
    if (match?.[1]) {
      recipient = match[1].trim().toLowerCase();
    }
  }

  if (!recipient) {
    return null;
  }

  // --- Subject (ใช้ empty string ได้ถ้ามี body) ---
  const subject = typeof raw.Subject === "string" ? raw.Subject.trim() : "";

  // --- TextBody (required — ต้องมี body อย่างน้อยหนึ่งอย่าง) ---
  const textBody =
    typeof raw.TextBody === "string" ? raw.TextBody :
    typeof raw.StrippedTextReply === "string" ? raw.StrippedTextReply :
    "";

  const htmlBody = typeof raw.HtmlBody === "string" && raw.HtmlBody.trim() !== ""
    ? raw.HtmlBody
    : null;

  // ถ้าไม่มีทั้ง subject และ body — reject
  if (subject === "" && textBody === "" && htmlBody === null) {
    return null;
  }

  // --- Email threading headers จาก Headers array ---
  // Postmark ส่ง Headers เป็น array ของ { Name: string, Value: string }
  let inReplyTo: string | null = null;
  const references: string[] = [];

  if (Array.isArray(raw.Headers)) {
    for (const header of raw.Headers) {
      if (
        !header ||
        typeof header !== "object" ||
        typeof (header as PostmarkHeader).Name !== "string" ||
        typeof (header as PostmarkHeader).Value !== "string"
      ) {
        continue;
      }
      const h = header as PostmarkHeader;
      const name = h.Name.toLowerCase().trim();
      const value = h.Value.trim();

      if (name === "in-reply-to" && value !== "") {
        // นำ <...> ออกถ้ามี เพื่อ normalize
        inReplyTo = normalizeMessageId(value);
      } else if (name === "references" && value !== "") {
        // References = space-separated list ของ Message-IDs
        const ids = value.split(/\s+/).map(normalizeMessageId).filter((id): id is string => id !== null);
        references.push(...ids);
      }
    }
  }

  return {
    messageId,
    from: { email: fromEmail, name: fromName },
    recipient,
    subject,
    textBody,
    htmlBody,
    inReplyTo,
    references,
  };
}

// =============================================================================
// NORMALIZE MESSAGE-ID
// =============================================================================

/**
 * normalize Message-ID: ลบ angle brackets ออก เก็บแค่ value ข้างใน
 * เช่น "<abc@mail.example.com>" → "abc@mail.example.com"
 * ถ้าไม่ใช่รูปแบบที่รู้จัก return null
 */
function normalizeMessageId(raw: string): string | null {
  if (!raw || typeof raw !== "string") return null;
  const stripped = raw.trim();
  if (stripped === "") return null;
  // ลบ angle brackets
  const match = stripped.match(/^<(.+)>$/) ?? [null, stripped];
  const id = match[1]?.trim();
  if (!id || id === "") return null;
  return id;
}

// =============================================================================
// VERIFY INBOUND WEBHOOK SECRET
// =============================================================================

/**
 * ตรวจ shared secret จาก request เพื่อยืนยันว่า webhook มาจาก Postmark จริง
 *
 * รองรับสองรูปแบบ:
 *   1. HTTP Basic Auth password (Authorization: Basic base64(user:secret))
 *   2. X-Webhook-Secret header
 *
 * ใช้ timingSafeEqual เพื่อกัน timing attack
 *
 * Behavior เมื่อ EMAIL_INBOUND_WEBHOOK_SECRET ไม่ได้ตั้งค่า:
 *   - production: return false (reject) — ไม่มี secret = ไม่ปลอดภัย
 *   - development: return true (allow) + console.warn เพื่อแจ้ง dev
 *
 * @param request - Next.js Request object
 */
export function verifyInboundSecret(request: Request): boolean {
  const secret = process.env.EMAIL_INBOUND_WEBHOOK_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      // production ไม่มี secret = reject ทันที กัน spoof
      console.error(
        "[inbound] EMAIL_INBOUND_WEBHOOK_SECRET is not set — rejecting inbound webhook in production"
      );
      return false;
    }
    // dev: allow แต่ warn ให้ตั้งค่า
    console.warn(
      "[inbound] EMAIL_INBOUND_WEBHOOK_SECRET is not set — allowing in dev mode (NOT SAFE for production)"
    );
    return true;
  }

  const secretBytes = Buffer.from(secret, "utf-8");

  // --- ลอง HTTP Basic Auth ก่อน ---
  const authHeader = request.headers.get("authorization") ?? "";
  if (authHeader.toLowerCase().startsWith("basic ")) {
    try {
      const b64 = authHeader.slice("basic ".length).trim();
      const decoded = Buffer.from(b64, "base64").toString("utf-8");
      // รูปแบบ "username:password" — เอาส่วนหลัง ":" เป็น password
      const colonIdx = decoded.indexOf(":");
      const password = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded;
      if (password.length > 0) {
        return timingSafeCompare(password, secretBytes);
      }
    } catch {
      // base64 decode ล้ม — ลอง header ต่อ
    }
  }

  // --- ลอง X-Webhook-Secret header ---
  const headerSecret = request.headers.get("x-webhook-secret") ?? "";
  if (headerSecret.length > 0) {
    return timingSafeCompare(headerSecret, secretBytes);
  }

  // ไม่พบ credential ใด ๆ
  return false;
}

/**
 * เปรียบเทียบ string กับ Buffer ด้วย timingSafeEqual
 * ป้องกัน timing attack — ใช้แทน === เสมอสำหรับ secret comparison
 */
function timingSafeCompare(input: string, expected: Buffer): boolean {
  try {
    const inputBytes = Buffer.from(input, "utf-8");
    // STRONG-1 fix: กัน length oracle — ถ้าขนาดต่างต้องยัง run timingSafeEqual จริง
    // ห้าม compare expected กับ expected (pointer-equal → JIT ย่อเหลือ ~0 time = leak length)
    // ใช้ Buffer.alloc(expected.length) (zero-filled) เพื่อบังคับ memory compare เต็มความยาว
    const safeInput =
      inputBytes.length === expected.length
        ? inputBytes
        : Buffer.alloc(expected.length);
    const equal = crypto.timingSafeEqual(safeInput, expected);
    // คืน true เฉพาะเมื่อทั้งความยาวตรง และ bytes ตรง
    return equal && inputBytes.length === expected.length;
  } catch {
    return false;
  }
}

// =============================================================================
// EXTRACT SLUG FROM RECIPIENT
// =============================================================================

/**
 * แยก tenant slug จาก recipient email address
 *
 * รูปแบบที่รองรับ:
 *   - support@{slug}.gethelpwise.xyz         ← รูปแบบหลัก (local-part = support)
 *   - support+{tag}@{slug}.gethelpwise.xyz   ← มี MailboxHash / plus-addressing
 *   - {slug}@gethelpwise.xyz                 ← รูปแบบสำรอง (slug อยู่ที่ local-part)
 *   - {anything}@{slug}.gethelpwise.xyz      ← local-part อื่น ๆ บน subdomain ของ slug
 *
 * หมายเหตุ: รูปแบบหลักที่ใช้คือ subdomain slug
 *   "support@acme.gethelpwise.xyz" → slug = "acme"
 *   slug ต้องผ่าน /^[a-z0-9-]+$/ เสมอ
 *
 * @param recipient - email address ของ recipient (ควร lowercase แล้ว)
 * @param rootDomain - root domain เช่น "gethelpwise.xyz" (จาก NEXT_PUBLIC_ROOT_DOMAIN)
 * @returns slug string หรือ null ถ้า parse ไม่ได้หรือ slug ไม่ valid
 */
export function extractSlugFromRecipient(
  recipient: string,
  rootDomain: string
): string | null {
  if (!recipient || !rootDomain) return null;

  // normalize — ลบ whitespace + lowercase
  const email = recipient.trim().toLowerCase();
  const domain = rootDomain.trim().toLowerCase();

  // แยก local@domain
  const atIdx = email.lastIndexOf("@");
  if (atIdx <= 0) return null;

  const localPart = email.slice(0, atIdx); // ส่วนก่อน @
  const emailDomain = email.slice(atIdx + 1); // ส่วนหลัง @

  let slug: string | null = null;

  // --- รูปแบบ 1: {anything}@{slug}.{rootDomain} ---
  // เช่น support@acme.gethelpwise.xyz → domain = "acme.gethelpwise.xyz", slug = "acme"
  const subdomainSuffix = `.${domain}`;
  if (emailDomain.endsWith(subdomainSuffix)) {
    const subdomain = emailDomain.slice(0, -(subdomainSuffix.length));
    // subdomain ต้องไม่มี dot เพิ่ม (เช่น "a.b.gethelpwise.xyz" ไม่ใช่ tenant slug)
    if (subdomain.length > 0 && !subdomain.includes(".")) {
      slug = subdomain;
    }
  }

  // --- รูปแบบ 2: {slug}@{rootDomain} (fallback — slug ที่ local-part) ---
  // เช่น acme@gethelpwise.xyz → slug = "acme"
  // ลบ MailboxHash (+tag) ออก: "acme+abc123@gethelpwise.xyz" → localPart base = "acme"
  if (!slug && emailDomain === domain) {
    const localBase = localPart.split("+")[0] ?? localPart;
    if (localBase.length > 0) {
      slug = localBase;
    }
  }

  if (!slug) return null;

  // validate slug format — กัน injection / path traversal
  const SLUG_REGEX = /^[a-z0-9-]+$/;
  if (!SLUG_REGEX.test(slug)) return null;

  return slug;
}

// =============================================================================
// EXTRACT TICKET NUMBER FROM SUBJECT
// =============================================================================

/**
 * fallback threading: แยก ticket number จาก subject
 * รองรับรูปแบบ:
 *   - "#1024" หรือ "[#1024]" อยู่ที่ใดก็ได้ใน subject
 *   - ตัวเลข 1 ถึง 10 หลัก (ป้องกัน overflow)
 *
 * @param subject - subject ของ email
 * @returns ticketNumber (number) หรือ null ถ้าไม่พบ
 */
export function extractTicketNumberFromSubject(subject: string): number | null {
  if (!subject || typeof subject !== "string") return null;

  // match "#1024" หรือ "[#1024]"
  const match = subject.match(/\[?#(\d{1,10})\]?/);
  if (!match?.[1]) return null;

  const num = parseInt(match[1], 10);
  if (isNaN(num) || num <= 0) return null;

  return num;
}
