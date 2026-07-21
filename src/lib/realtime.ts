/**
 * src/lib/realtime.ts
 * Mint short-lived asymmetric JWT ให้ agent client เอาไปเชื่อม Supabase Realtime
 * (presence/broadcast) แบบ tenant-isolated.
 *
 * ⚠️ CRITICAL SECURITY / Tenant Isolation:
 *   - `tenantId` ที่ embed เป็น claim ต้องมาจาก server context (`ctx.tenantId` ที่
 *     requireAgent() verify แล้ว) เท่านั้น — caller ห้ามส่งมาจาก client body.
 *   - Channel topic ฝั่ง Realtime = `tenant:{tenantId}:ticket:{ticketId}` และ RLS
 *     policy scope ด้วย `tenantId` claim ล้วน → tenant A join channel tenant B ไม่ได้.
 *   - validate `tenantId` format ก่อน embed (defense-in-depth): กัน `:` / LIKE
 *     wildcard (`%`, `_`) หลุดเข้า topic prefix แม้ค่าจะ server-controlled อยู่แล้ว.
 *
 * Signing: asymmetric (ES256) + `kid` + `typ:"JWT"` ใน header.
 *   - key คนละตัว/คนละ purpose กับ session token (auth.ts / AUTH_SECRET / HS256).
 *   - ⚠️ `typ:"JWT"` ต้องใส่เอง — ไม่งั้น Supabase Realtime verify ไม่ผ่าน (supabase-js #553).
 */

import { SignJWT, importPKCS8, type KeyLike } from "jose";

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Algorithm ของ signing key = ES256 (Elliptic Curve P-256).
 * เหตุผล: เป็นค่า default/แนะนำของ Supabase JWT Signing Keys (asymmetric) รุ่นใหม่,
 * token เล็กกว่า RSA (ดีกับ token TTL สั้นที่ mint ถี่), sign เร็วกว่า.
 * ⚠️ Dev ต้อง generate signing key เป็น EC P-256 ให้ตรงกับ alg นี้ (ไม่ใช่ RSA).
 */
const REALTIME_JWT_ALG = "ES256";

/** TTL ของ token = 60 วินาที (client ต้อง refresh ก่อนหมดอายุ) */
const REALTIME_JWT_TTL_SECONDS = 60;

/**
 * รูปแบบ tenantId ที่ยอมรับได้ก่อน embed ลง claim/topic.
 * charset จำกัดที่ [a-zA-Z0-9-] → กัน `:` (โครงสร้าง topic) และ `%`/`_`/whitespace
 * (LIKE wildcard ใน RLS policy) injection. cuid ของ project เข้าเงื่อนไขนี้.
 */
const TENANT_ID_FORMAT = /^[a-zA-Z0-9-]{1,64}$/;

// =============================================================================
// ENV / KEY HELPERS
// =============================================================================

function getPrivateKeyPem(): string {
  const pem = process.env.SUPABASE_REALTIME_JWT_PRIVATE_KEY;
  if (!pem) {
    throw new Error(
      "SUPABASE_REALTIME_JWT_PRIVATE_KEY is not set. กรุณาตั้งค่าใน .env (PEM private key)"
    );
  }
  return pem;
}

function getKid(): string {
  const kid = process.env.SUPABASE_REALTIME_JWT_KID;
  if (!kid) {
    throw new Error(
      "SUPABASE_REALTIME_JWT_KID is not set. กรุณาตั้งค่าใน .env (key id ของ signing key)"
    );
  }
  return kid;
}

function getIssuer(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) {
    throw new Error(
      "SUPABASE_URL is not set. กรุณาตั้งค่าใน .env (ใช้ประกอบ iss ของ JWT)"
    );
  }
  // ตัด trailing slash กัน `//auth/v1` ซ้อน
  return `${url.replace(/\/+$/, "")}/auth/v1`;
}

/**
 * cache imported key ตาม PEM string — เลี่ยง parse PKCS8 ซ้ำทุก request
 * (token ถูก mint ต่อ request; PEM ไม่เปลี่ยนระหว่าง runtime)
 */
let cachedKey: { pem: string; key: KeyLike } | null = null;

async function getSigningKey(pem: string): Promise<KeyLike> {
  if (cachedKey && cachedKey.pem === pem) {
    return cachedKey.key;
  }
  const key = await importPKCS8(pem, REALTIME_JWT_ALG);
  cachedKey = { pem, key };
  return key;
}

// =============================================================================
// MINT
// =============================================================================

export interface MintRealtimeTokenInput {
  /** User.id (global) — จาก session ที่ verify แล้ว */
  userId: string;
  /** tenantId จาก server context (ctx.tenantId) — ⚠️ ห้ามมาจาก client */
  tenantId: string;
  /** TenantMember.id — ใช้เป็น presence key ฝั่ง client */
  memberId: string;
}

export interface MintRealtimeTokenResult {
  token: string;
  /** unix epoch (วินาที) ที่ token หมดอายุ = iat + 60 */
  expiresAt: number;
}

/**
 * Mint asymmetric JWT สำหรับ Supabase Realtime presence/broadcast (tenant-scoped).
 *
 * @throws Error ถ้า env key ไม่ครบ หรือ tenantId format ไม่ผ่าน validation
 */
export async function mintRealtimePresenceToken(
  input: MintRealtimeTokenInput
): Promise<MintRealtimeTokenResult> {
  const { userId, tenantId, memberId } = input;

  // defense-in-depth: กัน injection ใน topic prefix แม้ tenantId จะ server-controlled
  if (!TENANT_ID_FORMAT.test(tenantId)) {
    throw new Error("tenantId format ไม่ถูกต้องสำหรับ realtime token");
  }

  const privateKey = await getSigningKey(getPrivateKeyPem());
  const kid = getKid();
  const iss = getIssuer();

  const now = Math.floor(Date.now() / 1000);
  const exp = now + REALTIME_JWT_TTL_SECONDS;

  const token = await new SignJWT({
    role: "authenticated",
    tenantId,
    memberId,
  })
    // ⚠️ typ:"JWT" ต้องใส่เอง (jose ไม่ใส่ให้) — Supabase Realtime verify ต้องการ
    .setProtectedHeader({ alg: REALTIME_JWT_ALG, kid, typ: "JWT" })
    .setSubject(userId)
    .setAudience("authenticated")
    .setIssuer(iss)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(privateKey);

  return { token, expiresAt: exp };
}
