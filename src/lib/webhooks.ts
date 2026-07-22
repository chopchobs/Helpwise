/**
 * src/lib/webhooks.ts
 * Core library ของ Outbound Webhooks (Phase 36) — pure logic ล้วน
 *
 * source of truth: docs/webhooks-contract.md § 2 (envelope) · § 3 (event mapping)
 *                  § 4 (headers + signature) · § 6 (SSRF guard)
 *
 * Interface เล็ก deep module:
 *   - generateWebhookSecret / signWebhookPayload / buildSignatureHeader / verifyWebhookSignature
 *   - validateWebhookUrl / isBlockedIp / assertSafeDestination   ← SSRF guard (ภัยหลักของฟีเจอร์)
 *   - buildTicketEventPayload / buildMessageEventPayload / serializeEnvelope
 *
 * ⚠️ ไฟล์นี้ **ห้ามแตะ DB / tenant context** — ไม่มี import DB client โดยเจตนา
 *    (producer/worker เป็นคนถือ tenant scope แล้วส่ง plain object เข้ามาที่นี่)
 */

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { lookup } from "dns/promises";
import { isIP } from "net";
import type {
  TicketWebhookEventType,
  WebhookEnvelope,
  WebhookEventType,
  WebhookMessageEventData,
  WebhookMessageTicketRef,
  WebhookTicketChanges,
  WebhookTicketEventData,
  WebhookTicketSnapshot,
  WebhookWireEventName,
} from "@/types/webhook";

// =============================================================================
// CONSTANTS (§ 4, § 5) — ไม่มี env ใหม่ ทั้งหมดเป็น constant ในโค้ด
// =============================================================================

/** attempt สูงสุดต่อ delivery (attempt แรก + QStash retry 4 ครั้ง) → ครบแล้วเข้า DLQ */
export const WEBHOOK_MAX_ATTEMPTS = 5;

/** timeout ของ HTTP POST ไป receiver */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** User-Agent ที่ receiver ใช้ระบุว่ามาจาก Helpwise */
export const WEBHOOK_USER_AGENT = "Helpwise-Webhooks/1.0";

/** replay window ของ signature — receiver ควร reject ถ้า |now - t| เกินค่านี้ */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

// =============================================================================
// SECRET + SIGNATURE (§ 4) — Stripe-style `t=<unixSeconds>,v1=<hexHmac>`
// =============================================================================

/** สร้าง signing secret ใหม่ — plaintext เก็บลง WebhookEndpoint.secret (ห้าม log) */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

/**
 * HMAC-SHA256 (hex lowercase) ของ `${t}.${rawBody}`
 * secret ใช้ทั้งสตริงรวม prefix "whsec_" (utf8)
 */
export function signWebhookPayload(
  secret: string,
  rawBody: string,
  timestampSeconds: number
): string {
  return createHmac("sha256", secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest("hex");
}

/** ค่า header `X-Helpwise-Signature` */
export function buildSignatureHeader(
  secret: string,
  rawBody: string,
  timestampSeconds: number
): string {
  return `t=${timestampSeconds},v1=${signWebhookPayload(secret, rawBody, timestampSeconds)}`;
}

export interface VerifySignatureOptions {
  /** default = WEBHOOK_SIGNATURE_TOLERANCE_SECONDS (300s) */
  toleranceSeconds?: number;
  /** inject เวลาปัจจุบันได้เพื่อให้ทดสอบ deterministic */
  nowSeconds?: number;
}

/** แยก header `t=...,v1=...` — คืน null ถ้ารูปแบบผิด */
function parseSignatureHeader(
  header: string
): { t: number; v1: string } | null {
  let t: number | null = null;
  let v1: string | null = null;

  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t" && /^\d+$/.test(value)) t = Number(value);
    // v1 ต้องเป็น hex ของ sha256 (64 ตัว) — รูปแบบอื่นถือว่า malformed
    else if (key === "v1" && /^[0-9a-f]{64}$/.test(value)) v1 = value;
  }

  return t !== null && v1 !== null ? { t, v1 } : null;
}

/**
 * verify signature ฝั่ง receiver (ใช้ในเทส + เป็นตัวอย่างอ้างอิงใน docs)
 * reject เมื่อ: header parse ไม่ได้ · timestamp เก่า/อนาคตเกิน tolerance · HMAC ไม่ตรง
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  header: string,
  opts: VerifySignatureOptions = {}
): boolean {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;

  const tolerance = opts.toleranceSeconds ?? WEBHOOK_SIGNATURE_TOLERANCE_SECONDS;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  // replay window — กันเอา request เก่าที่เซ็นถูกต้องมายิงซ้ำ
  if (Math.abs(now - parsed.t) > tolerance) return false;

  const expected = Buffer.from(
    signWebhookPayload(secret, rawBody, parsed.t),
    "utf8"
  );
  const actual = Buffer.from(parsed.v1, "utf8");
  // constant-time compare — timingSafeEqual throw ถ้าความยาวต่างกัน จึงเช็ค length ก่อน
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// =============================================================================
// SSRF GUARD (§ 6) — tenant เป็นคนป้อน URL ให้ server เราไปยิง
// =============================================================================

export type WebhookUrlValidation =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

/** hostname ที่ block ตรง ๆ (§ 6 ข้อ 3) */
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);
/** suffix ที่ block — ครอบ *.localhost และ *.internal (รวม metadata.google.internal) */
const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".internal"];

/** URL.hostname ของ IPv6 literal มีวงเล็บติดมา ("[::1]") — ตัดออกก่อนเช็ค */
function normalizeHostname(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;
}

function isBlockedHostname(host: string): boolean {
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  return BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function isBlockedIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (cloud metadata 169.254.169.254)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

/** แปลง IPv4 literal เป็น octets — คืน null ถ้ารูปแบบผิด */
function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return octets.every((n) => n >= 0 && n <= 255) ? octets : null;
}

/**
 * แปลง IPv6 literal เป็น 16 bytes (รองรับ "::" compression + IPv4 ฝังท้าย)
 * คืน null ถ้า parse ไม่ได้
 */
function parseIpv6(ip: string): number[] | null {
  // ตัด zone id (fe80::1%eth0) ทิ้งก่อน
  let s = ip.split("%")[0].toLowerCase();

  // IPv4 ที่ฝังท้าย (::ffff:127.0.0.1) → แปลงเป็น hex 2 กลุ่มเพื่อ parse รวบเดียว
  const embedded = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embedded) {
    const octets = parseIpv4(embedded[1]);
    if (!octets) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    s = `${s.slice(0, embedded.index)}${hi}:${lo}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

/**
 * IP อยู่ในช่วงต้องห้ามไหม (§ 6 ข้อ 2) — ใช้ทั้งตอน validate URL และหลัง DNS resolve
 * IPv4-mapped/compatible IPv6 (::ffff:127.0.0.1) จะถูก unmap แล้วเช็คซ้ำด้วยกฎ IPv4
 */
export function isBlockedIp(ip: string): boolean {
  const bare = ip.split("%")[0];

  const v4 = parseIpv4(bare);
  if (v4) return isBlockedIpv4(v4);

  const bytes = parseIpv6(bare);
  // parse ไม่ได้ = ไม่รู้จัก → block ไว้ก่อน (fail-safe)
  if (!bytes) return true;

  if (bytes.every((b) => b === 0)) return true; // :: unspecified
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true; // ::1 loopback

  // IPv4-mapped (::ffff:a.b.c.d) และ IPv4-compatible (::a.b.c.d) → unmap แล้วเช็คกฎ IPv4
  const first10Zero = bytes.slice(0, 10).every((b) => b === 0);
  const mapped =
    first10Zero &&
    ((bytes[10] === 0xff && bytes[11] === 0xff) ||
      (bytes[10] === 0 && bytes[11] === 0));
  if (mapped) return isBlockedIpv4(bytes.slice(12));

  if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 ULA
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local

  return false;
}

/**
 * ตรวจ URL แบบ static (ไม่แตะ DNS) — ใช้ตอน create/update endpoint
 * เช็ค: scheme → hostname deny-list → IP literal ในช่วงต้องห้าม → port
 *
 * ⚠️ dev-only escape hatch: NODE_ENV !== "production" อนุญาต http: และ port อื่นได้
 *    เพื่อยิงเข้า receiver บนเครื่อง dev เท่านั้น — บน production บังคับ https + 443 เสมอ
 *    (อ่าน env ตอนเรียก ไม่ใช่ตอน import เพื่อให้ค่าสะท้อน runtime จริง)
 */
export function validateWebhookUrl(url: string): WebhookUrlValidation {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  const isProduction = process.env.NODE_ENV === "production";

  if (parsed.protocol !== "https:") {
    if (!(parsed.protocol === "http:" && !isProduction)) {
      return { ok: false, reason: "scheme_not_allowed" };
    }
  }

  const host = normalizeHostname(parsed.hostname);
  if (!host) return { ok: false, reason: "invalid_url" };
  if (isBlockedHostname(host)) return { ok: false, reason: "blocked_host" };
  // IP literal → เช็คช่วงต้องห้ามทันที (hostname ปกติจะไปเช็คอีกทีหลัง DNS resolve)
  if (isIP(host) !== 0 && isBlockedIp(host)) {
    return { ok: false, reason: "blocked_ip" };
  }
  if (isProduction && parsed.port !== "" && parsed.port !== "443") {
    return { ok: false, reason: "port_not_allowed" };
  }

  return { ok: true, url: parsed };
}

export type SafeDestinationResult = { ok: true } | { ok: false; reason: string };

/**
 * ตรวจปลายทางตอนจะส่งจริง: validate static + resolve DNS แล้วเช็คทุก IP ที่ได้
 * (กัน DNS rebinding — hostname ดูปกติแต่ resolve ไปที่ 169.254.169.254)
 * resolve ไม่ได้ = ปฏิเสธ (fail-closed)
 */
export async function assertSafeDestination(
  url: string
): Promise<SafeDestinationResult> {
  const validated = validateWebhookUrl(url);
  if (!validated.ok) return validated;

  const host = normalizeHostname(validated.url.hostname);
  // IP literal ผ่าน isBlockedIp ไปแล้วใน validateWebhookUrl — ไม่ต้อง resolve
  if (isIP(host) !== 0) return { ok: true };

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return { ok: false, reason: "dns_resolution_failed" };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: "dns_resolution_failed" };
  }
  // ต้องปลอดภัย "ทุก" IP ที่ resolve ได้ — เจอ IP ต้องห้ามแม้ตัวเดียวก็ block
  for (const { address } of addresses) {
    if (isBlockedIp(address)) return { ok: false, reason: "blocked_ip" };
  }

  return { ok: true };
}

// =============================================================================
// EVENT MAPPING + PAYLOAD BUILDER (§ 2, § 3)
// =============================================================================

/** enum → wire name ที่ส่งใน envelope field `type` */
export const WEBHOOK_EVENT_WIRE_NAMES: Record<
  WebhookEventType,
  WebhookWireEventName
> = {
  TICKET_CREATED: "ticket.created",
  TICKET_STATUS_CHANGED: "ticket.status_changed",
  TICKET_ASSIGNED: "ticket.assigned",
  TICKET_PRIORITY_CHANGED: "ticket.priority_changed",
  TICKET_MESSAGE_CREATED: "ticket.message_created",
};

/** รับได้ทั้ง Date (จาก DB model) และ ISO string — normalize เป็น ISO8601 UTC เสมอ */
type DateInput = Date | string;

function toIso(value: DateInput): string {
  return typeof value === "string" ? value : value.toISOString();
}

/** ticket snapshot ที่ producer ส่งเข้ามา — date เป็น Date หรือ ISO string ก็ได้ */
export interface TicketEventTicketInput
  extends Omit<WebhookTicketSnapshot, "createdAt" | "updatedAt"> {
  createdAt: DateInput;
  updatedAt: DateInput;
}

export interface TicketEventInput {
  /** eventId — caller generate เอง (1 event → หลาย delivery ใช้ค่าเดียวกัน) */
  eventId: string;
  eventType: TicketWebhookEventType;
  tenantId: string;
  /** เวลาที่ event เกิด */
  occurredAt: DateInput;
  ticket: TicketEventTicketInput;
  /** มีเฉพาะ status_changed / assigned / priority_changed */
  changes?: WebhookTicketChanges;
}

/** สร้าง envelope ของ event ticket.* ตาม § 2 */
export function buildTicketEventPayload(
  input: TicketEventInput
): WebhookEnvelope<WebhookTicketEventData> {
  const data: WebhookTicketEventData = {
    ticket: {
      ...input.ticket,
      createdAt: toIso(input.ticket.createdAt),
      updatedAt: toIso(input.ticket.updatedAt),
    },
  };
  // ใส่ changes เฉพาะเมื่อมีจริง — created ไม่มี field นี้ใน envelope
  if (input.changes) data.changes = input.changes;

  return {
    id: input.eventId,
    type: WEBHOOK_EVENT_WIRE_NAMES[input.eventType],
    createdAt: toIso(input.occurredAt),
    tenantId: input.tenantId,
    data,
  };
}

export interface MessageEventInput {
  eventId: string;
  tenantId: string;
  occurredAt: DateInput;
  ticket: WebhookMessageTicketRef;
  message: {
    id: string;
    /** ต้องเป็น "PUBLIC" — ค่าอื่น builder จะ throw */
    visibility: string;
    authorType: "agent" | "contact";
    authorId: string;
    body: string;
    createdAt: DateInput;
  };
}

/**
 * สร้าง envelope ของ ticket.message_created ตาม § 2
 *
 * ⚠️ Internal-note isolation ชั้นสุดท้าย: visibility ที่ไม่ใช่ PUBLIC = throw ทันที
 *    (fail-loud — ถ้า producer/worker พลาดกรอง เราต้องพังดัง ไม่ใช่ส่ง note หลุดออกนอกระบบ)
 */
export function buildMessageEventPayload(
  input: MessageEventInput
): WebhookEnvelope<WebhookMessageEventData> {
  if (input.message.visibility !== "PUBLIC") {
    throw new Error(
      "[webhooks] refusing to build payload for non-PUBLIC message — internal notes must never leave the system"
    );
  }

  return {
    id: input.eventId,
    type: WEBHOOK_EVENT_WIRE_NAMES.TICKET_MESSAGE_CREATED,
    createdAt: toIso(input.occurredAt),
    tenantId: input.tenantId,
    data: {
      ticket: input.ticket,
      message: {
        id: input.message.id,
        visibility: "PUBLIC",
        authorType: input.message.authorType,
        authorId: input.message.authorId,
        body: input.message.body,
        createdAt: toIso(input.message.createdAt),
      },
    },
  };
}

/**
 * serialize envelope เป็น raw body string
 *
 * ⚠️ ต้องเรียก "ครั้งเดียว" แล้วใช้สตริงเดียวกันทั้ง sign และ send —
 *    ถ้า stringify ใหม่ตอนส่ง byte อาจไม่ตรงกับตอนเซ็น → receiver verify ไม่ผ่าน
 */
export function serializeEnvelope(envelope: WebhookEnvelope): string {
  return JSON.stringify(envelope);
}
