/**
 * src/lib/auth.ts
 * Audience Guards — แยก Agent (ภายใน) และ Contact (ลูกค้า) ขาดจากกัน
 *
 * ⚠️ CRITICAL SECURITY:
 *   - requireAgent() และ requireContact() ต้องไม่รับ token ของอีก audience
 *   - type field ใน token บังคับ audience แยกขาด
 *   - tenantId ห้ามมาจาก client — ดึงจาก getTenantContext() (middleware-injected header)
 *
 * Session Contract (JWT ใน httpOnly cookie):
 *
 *   Agent token:
 *     { sub: userId, type: "agent", iat, exp }
 *     — userId เป็น global User.id ไม่ผูกกับ tenant ใด
 *     — membership ตรวจที่ DB ผ่าน TenantMember (role ผูกกับ TenantMember ไม่ใช่ User)
 *
 *   Contact token:
 *     { sub: contactId, tenantId: string, type: "contact", iat, exp }
 *     — contactId ผูกกับ tenant นั้น ๆ เสมอ (Contact เป็น tenant-scoped)
 *     — tenantId ใน token ใช้เป็น double-check (แต่ source of truth ยังเป็น middleware header)
 *
 * TODO (Phase: Auth):
 *   - implement issueAgentToken() — login flow สำหรับ agent
 *   - implement issueContactToken() — magic-link สำหรับ contact
 *   - implement logout / token rotation / refresh token
 *   - rate limit บน auth endpoints
 */

import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { cookies } from "next/headers";
import { tenantPrisma, getTenantContext, type TenantContext } from "@/lib/tenant";
import type { TenantMember, User, Contact, MemberRole } from "@prisma/client";

// =============================================================================
// CONSTANTS
// =============================================================================

const AGENT_COOKIE_NAME = "hw_agent_session";
const CONTACT_COOKIE_NAME = "hw_contact_session";
const TOKEN_EXPIRY = "8h";

// =============================================================================
// TOKEN PAYLOAD TYPES
// =============================================================================

interface AgentTokenPayload extends JWTPayload {
  sub: string; // userId (User.id — global)
  type: "agent";
}

interface ContactTokenPayload extends JWTPayload {
  sub: string; // contactId (Contact.id — tenant-scoped)
  tenantId: string; // tenant ของ contact นี้ (double-check)
  type: "contact";
}

// =============================================================================
// RETURN TYPES
// =============================================================================

export interface AgentSession {
  user: User;
  member: TenantMember;
  ctx: TenantContext;
}

export interface ContactSession {
  contact: Contact;
  ctx: TenantContext;
}

// =============================================================================
// ERROR TYPES
// =============================================================================

export class AuthError extends Error {
  constructor(
    message: string,
    // 429 ใช้กับ pre-auth rate-limit (เช่น public API key guard) ที่ flow ผ่าน catch เดียวกัน
    public readonly statusCode: 401 | 403 | 429 = 401
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * แปลง AuthError เป็น { data: null, error } ตาม API response convention
 * ใช้ใน route handler: catch block
 */
export function toAuthErrorResponse(err: unknown): {
  data: null;
  error: { code: string; message: string };
  status: number;
} {
  if (err instanceof AuthError) {
    const code =
      err.statusCode === 403
        ? "FORBIDDEN"
        : err.statusCode === 429
          ? "RATE_LIMITED"
          : "UNAUTHORIZED";
    return {
      data: null,
      error: { code, message: err.message },
      status: err.statusCode,
    };
  }
  // error ที่ไม่ใช่ AuthError — ไม่ expose detail
  return {
    data: null,
    error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    status: 500,
  };
}

// =============================================================================
// JWT HELPERS (ใช้ jose — Web Crypto API, ใช้ได้ทั้ง Node + Edge)
// =============================================================================

function getJwtSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is not set. กรุณาตั้งค่า AUTH_SECRET ใน .env");
  }
  // L-2: บังคับความยาว secret อย่างน้อย 32 ตัวอักษรสำหรับ HS256
  if (secret.length < 32) {
    throw new Error("AUTH_SECRET must be at least 32 characters for HS256 security.");
  }
  return new TextEncoder().encode(secret);
}

async function verifyToken<T extends JWTPayload>(
  token: string
): Promise<T> {
  const { payload } = await jwtVerify<T>(token, getJwtSecret());
  return payload;
}

// =============================================================================
// AGENT AUTH
// =============================================================================

/**
 * ตรวจสอบว่า request มาจาก Agent ที่ authenticated และเป็นสมาชิก tenant นี้
 *
 * Pipeline:
 *   1. อ่าน agent token จาก httpOnly cookie
 *   2. verify JWT signature + expiry
 *   3. ตรวจว่า type === "agent" (ป้องกัน contact token ผ่านมาใช้ endpoint agent)
 *   4. ดึง tenant context จาก middleware-injected header
 *   5. ตรวจว่า User เป็น TenantMember ของ tenant นี้ และ isActive = true
 *   6. (optional) ตรวจ role ถ้า opts.roles ระบุมา
 *   7. คืน { user, member, ctx }
 *
 * @param opts.roles ถ้าระบุ จะตรวจว่า member มี role ใน list หรือไม่ → 403 ถ้าไม่มี
 * @throws AuthError(401) ถ้า token ไม่ valid หรือไม่ใช่ member
 * @throws AuthError(403) ถ้าไม่มีสิทธิ์ตาม role
 */
export async function requireAgent(
  opts: { roles?: MemberRole[] } = {}
): Promise<AgentSession> {
  // อ่าน cookie
  const cookieStore = await cookies();
  const token = cookieStore.get(AGENT_COOKIE_NAME)?.value;
  if (!token) {
    throw new AuthError("กรุณา login ก่อนใช้งาน", 401);
  }

  // verify JWT
  let payload: AgentTokenPayload;
  try {
    payload = await verifyToken<AgentTokenPayload>(token);
  } catch {
    throw new AuthError("Session หมดอายุหรือไม่ถูกต้อง กรุณา login ใหม่", 401);
  }

  // ⚠️ ตรวจ type — ห้ามให้ contact token ผ่านมา endpoint agent
  if (payload.type !== "agent") {
    throw new AuthError("Token ไม่ถูกต้องสำหรับ endpoint นี้", 401);
  }

  const userId = payload.sub;

  // ดึง tenant context จาก middleware header (ห้ามรับจาก client)
  const ctx = await getTenantContext();

  // M-2: ใช้ tenantPrisma แทน raw prisma เพื่อ enforce tenant scope อัตโนมัติ
  // ใส่ isActive ใน where clause โดยตรง แทนการ post-check หลัง query
  const db = tenantPrisma(ctx.tenantId);
  const member = await db.tenantMember.findFirst({
    where: { userId, isActive: true },
    include: { user: true },
  });

  if (!member) {
    throw new AuthError(
      "คุณไม่ได้เป็นสมาชิกของ workspace นี้ หรือถูก deactivate",
      403
    );
  }

  // ตรวจ user isActive
  if (!member.user.isActive) {
    throw new AuthError("บัญชีผู้ใช้ถูกระงับการใช้งาน", 403);
  }

  // ตรวจ role ถ้าระบุ
  if (opts.roles && opts.roles.length > 0) {
    if (!opts.roles.includes(member.role)) {
      throw new AuthError(
        `ต้องการสิทธิ์ ${opts.roles.join(" หรือ ")} เพื่อดำเนินการนี้`,
        403
      );
    }
  }

  return { user: member.user, member, ctx };
}

// =============================================================================
// CONTACT AUTH
// =============================================================================

/**
 * ตรวจสอบว่า request มาจาก Contact (ลูกค้า) ที่ authenticated ใน tenant นี้
 *
 * Pipeline:
 *   1. อ่าน contact token จาก httpOnly cookie (คนละ cookie กับ agent)
 *   2. verify JWT signature + expiry
 *   3. ตรวจว่า type === "contact" (ป้องกัน agent token ผ่านมาใช้ endpoint portal)
 *   4. ดึง tenant context จาก middleware-injected header
 *   5. ตรวจ tenantId ใน token ตรงกับ tenant จาก middleware (double-check)
 *   6. โหลด Contact record และตรวจว่าอยู่ใน tenant นี้ + isActive
 *   7. คืน { contact, ctx }
 *
 * ⚠️ Contact เห็นได้เฉพาะ ticket ของตัวเอง — caller ต้องกรอง requesterContactId ด้วย
 *    (ดู Identity & Audiences Rules)
 *
 * @throws AuthError(401) ถ้า token ไม่ valid หรือไม่ใช่ contact ใน tenant นี้
 */
export async function requireContact(): Promise<ContactSession> {
  // อ่าน cookie — คนละ cookie กับ agent เพื่อแยก session ขาดจากกัน
  const cookieStore = await cookies();
  const token = cookieStore.get(CONTACT_COOKIE_NAME)?.value;
  if (!token) {
    throw new AuthError("กรุณา login ก่อนใช้งาน portal", 401);
  }

  // verify JWT
  let payload: ContactTokenPayload;
  try {
    payload = await verifyToken<ContactTokenPayload>(token);
  } catch {
    throw new AuthError("Session หมดอายุหรือไม่ถูกต้อง กรุณา login ใหม่", 401);
  }

  // ⚠️ ตรวจ type — ห้ามให้ agent token ผ่านมา endpoint portal
  if (payload.type !== "contact") {
    throw new AuthError("Token ไม่ถูกต้องสำหรับ endpoint นี้", 401);
  }

  const contactId = payload.sub;

  // ดึง tenant context จาก middleware header (source of truth)
  const ctx = await getTenantContext();

  // Double-check: tenantId ใน token ต้องตรงกับ tenant จาก middleware
  // กัน token ของ tenant A หลุดมาใช้กับ tenant B (ต่างแม้ผ่าน JWT verify แล้ว)
  if (payload.tenantId !== ctx.tenantId) {
    throw new AuthError(
      "Token ไม่ถูกต้องสำหรับ workspace นี้",
      401
    );
  }

  // โหลด Contact และตรวจว่าอยู่ใน tenant นี้
  // ใช้ tenantPrisma เพื่อ enforce tenant scope ที่ DB layer ด้วย
  const db = tenantPrisma(ctx.tenantId);
  const contact = await db.contact.findUnique({
    where: { id: contactId },
  });

  if (!contact || !contact.isActive) {
    throw new AuthError("บัญชีลูกค้าไม่พบหรือถูกระงับ", 401);
  }

  // ตรวจ tenantId ของ Contact ตรงกับ tenant context อีกชั้น (defense in depth)
  if (contact.tenantId !== ctx.tenantId) {
    throw new AuthError("Contact ไม่อยู่ใน workspace นี้", 403);
  }

  return { contact, ctx };
}

// Export constants สำหรับ auth route handlers
export { AGENT_COOKIE_NAME, CONTACT_COOKIE_NAME, TOKEN_EXPIRY };

// =============================================================================
// TOKEN ISSUANCE
// =============================================================================

/**
 * ออก JWT สำหรับ agent หลังจาก verify email + password
 * payload: { sub: userId, type: "agent", iat, exp }
 */
export async function issueAgentToken(userId: string): Promise<string> {
  return new SignJWT({ type: "agent" } satisfies Omit<AgentTokenPayload, keyof JWTPayload>)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(getJwtSecret());
}

/**
 * ออก JWT สำหรับ contact หลังจาก verify magic-link token
 * payload: { sub: contactId, tenantId, type: "contact", iat, exp }
 */
export async function issueContactToken(
  contactId: string,
  tenantId: string
): Promise<string> {
  return new SignJWT({
    type: "contact",
    tenantId,
  } satisfies Omit<ContactTokenPayload, keyof JWTPayload>)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(contactId)
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(getJwtSecret());
}

// =============================================================================
// COOKIE HELPERS
// cookie attributes บังคับ (security):
//   httpOnly: true     — กัน JavaScript client อ่าน cookie (XSS)
//   secure: prod only  — ส่งผ่าน HTTPS เท่านั้นใน production
//   sameSite: strict   — กัน CSRF ข้าม site
//   path: /            — ใช้ได้ทุก path ของ subdomain
// maxAge ตรงกับ TOKEN_EXPIRY (8h = 28800 วินาที)
// =============================================================================

/** maxAge เป็นวินาที ตรงกับ TOKEN_EXPIRY "8h" */
const COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60; // 8 ชั่วโมง

/**
 * set agent session cookie หลัง login สำเร็จ
 * ⚠️ เรียกใน route handler เท่านั้น (ใช้ next/headers cookies())
 */
export async function setAgentCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(AGENT_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}

/**
 * set contact session cookie หลัง magic-link verify สำเร็จ
 * ⚠️ เรียกใน route handler เท่านั้น
 */
export async function setContactCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(CONTACT_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}

/**
 * ลบ agent session cookie (logout)
 *
 * MEDIUM-1: ใช้ set maxAge=0 แทน delete() — บาง browser ไม่ clear cookie
 * ถ้า attributes (httpOnly, secure, sameSite, path) ไม่ตรงกับที่ set ไว้ตอน login
 */
export async function clearAgentCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(AGENT_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
}

/**
 * ลบ contact session cookie (logout)
 *
 * MEDIUM-1: ใช้ set maxAge=0 แทน delete() เหตุผลเดียวกับ clearAgentCookie
 */
export async function clearContactCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(CONTACT_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
}
