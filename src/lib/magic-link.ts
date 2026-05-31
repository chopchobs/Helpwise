/**
 * src/lib/magic-link.ts
 * Shared helpers สำหรับ magic-link flow
 *
 * แยกออกมาเพื่อป้องกัน drift ระหว่าง request-link และ verify:
 *   - hashToken() ต้องใช้ algorithm เดียวกันทั้งสองฝั่ง
 *   - magicLinkKey() ต้องสร้าง Redis key รูปแบบเดียวกัน
 *
 * LOW-1: เดิม hashToken + magicLinkKey ซ้ำใน 2 routes — ถ้าแก้ข้างเดียว key ไม่ตรง verify พัง
 */

import { createHash } from "crypto";

/**
 * hash token ด้วย sha256 เพื่อเก็บใน Redis
 * ไม่ใช้ bcrypt เพราะต้องการ deterministic lookup
 * (bcrypt ใช้ random salt → ผลต่างทุกครั้ง → lookup ไม่ได้)
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * สร้าง Redis cache key สำหรับ magic-link token
 * รูปแบบ: magic:{tenantId}:{sha256(token)}
 *
 * tenantId อยู่ใน key เพื่อ:
 *   1. แยก namespace ระหว่าง tenant (ป้องกัน token ของ tenant A ใช้กับ tenant B)
 *   2. สะดวก debug / flush per-tenant
 */
export function magicLinkKey(tenantId: string, tokenHash: string): string {
  return `magic:${tenantId}:${tokenHash}`;
}
