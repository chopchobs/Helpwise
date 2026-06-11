/**
 * src/lib/api-key.ts
 * API Key generation + hashing สำหรับ feature "api_access"
 *
 * ⚠️ เก็บแค่ keyHash + keyPrefix ลง DB — ห้ามเก็บ plaintext เด็ดขาด
 *    plaintext จะ return ออกแค่ครั้งเดียวตอน create เท่านั้น
 */

import { randomBytes, createHash } from "crypto";

/** ความยาวของ keyPrefix ที่โชว์ใน UI ได้ (ไม่ sensitive) */
export const KEY_PREFIX_DISPLAY_LENGTH = 12;

export interface GeneratedApiKey {
  /** plaintext เต็ม — return ให้ user เห็นครั้งเดียวตอน create เท่านั้น */
  plaintext: string;
  /** sha256 hex ของ plaintext เต็ม — เก็บลง DB เพื่อ verify */
  keyHash: string;
  /** ส่วนต้นของ plaintext — โชว์ใน UI ได้ */
  keyPrefix: string;
}

/**
 * สร้าง API key ใหม่
 * plaintext = "hw_live_" + 32 random bytes (base64url)
 */
export function generateApiKey(): GeneratedApiKey {
  const plaintext = `hw_live_${randomBytes(32).toString("base64url")}`;
  const keyHash = hashApiKey(plaintext);
  const keyPrefix = plaintext.slice(0, KEY_PREFIX_DISPLAY_LENGTH);

  return { plaintext, keyHash, keyPrefix };
}

/** sha256 hex ของ plaintext key — ใช้ตอน verify (lookup ด้วย keyHash) */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}
