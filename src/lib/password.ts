/**
 * src/lib/password.ts
 * Password hashing utilities — ใช้ bcryptjs (pure JS, ไม่มี native build)
 *
 * เหตุผลที่เลือก bcryptjs แทน argon2:
 *   - ไม่ต้องการ native binary compilation → deploy ได้ทุก environment โดยไม่ต้อง provision
 *   - argon2 (argon2-cffi, node-argon2) ต้องการ native build → อาจ fail บน Alpine / Vercel layer บางตัว
 *   - bcrypt.compare() เป็น constant-time โดยธรรมชาติ → timing-safe
 *   - cost factor 12 = ~250ms บน commodity server (เหมาะกับ auth endpoint)
 *
 * ⚠️ ห้าม log password ดิบ หรือ hash ลง console/log ใด ๆ
 */

import bcrypt from "bcryptjs";

// cost factor 12: balance ระหว่าง security กับ latency (~250ms)
// เพิ่มได้ในอนาคตเมื่อ hardware แรงขึ้น — backward compatible เพราะ hash เก็บ cost ไว้
const BCRYPT_COST_FACTOR = 12;

/**
 * BLOCKER-1 / MEDIUM-2: Valid bcrypt hash (cost 12, 60 ตัว) สำหรับ normalize timing
 * ใช้ใน path "user ไม่พบ" หรือ "passwordHash เป็น null" เพื่อรัน verifyPassword จริง
 * และใช้เวลา ~250ms เหมือนกรณีปกติ (กัน timing oracle)
 *
 * Export เพื่อให้ route handlers ต่าง ๆ ใช้ constant เดียวกัน (ไม่ hardcode ซ้ำ)
 *
 * ⚠️ ค่านี้ไม่ใช่ secret — เป็นแค่ hash dummy ที่ไม่มีใครรู้ plaintext ที่ตรงกัน
 */
export const DUMMY_HASH = "$2a$12$GWXNbRKnMoloV5.W5EUOneRijhnm5OAi8YKKuFqxe7.gbnoFD.5gG";

/**
 * hash password ด้วย bcrypt cost factor 12
 * ต้องเรียกก่อน save User.passwordHash ลง DB เสมอ
 *
 * @param plain - password ดิบจาก user (ห้าม log)
 * @returns bcrypt hash string พร้อม salt ในตัว
 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST_FACTOR);
}

/**
 * เปรียบเทียบ password ดิบกับ hash ที่เก็บไว้ใน DB
 * bcrypt.compare เป็น constant-time → timing-safe ป้องกัน timing attack
 *
 * @param plain - password ดิบที่ user กรอกมา (ห้าม log)
 * @param hash  - hash ที่ดึงจาก DB
 * @returns true ถ้าตรงกัน, false ถ้าไม่ตรง
 */
export async function verifyPassword(
  plain: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
