/**
 * src/lib/demo.ts
 * Demo workspaces — server-side entry ของ demo credentials (password + persona list)
 *
 * persona ทั้งหมด (key/tenantSlug/email/name) นิยามที่ src/lib/demo-personas.ts ที่เดียว
 * ไฟล์นี้เพิ่ม "ส่วนที่เป็น password" ทับลงไป แล้ว re-export ต่อ → แหล่งความจริงเดียว
 *
 * ⚠️ credentials ในไฟล์นี้เป็น PUBLIC โดยตั้งใจ (portfolio demo)
 *   - visitor login ด้วย creds สาธารณะนี้ได้ → จึงจำกัดสิทธิ์เป็น role = AGENT เท่านั้น
 *     (ไม่ใช่ OWNER/ADMIN) เพื่อกัน action ทำลาย/admin จาก visitor
 *   - password เป็น public-by-design ไม่ใช่ secret — ห้ามนำ pattern นี้ไปใช้กับ user จริง
 *   - ⚠️ ห้าม import ไฟล์นี้จาก client component (DEMO_PASSWORD จะติดไป bundle)
 *     client ให้ import src/lib/demo-personas.ts แทน
 *
 * ⚠️ ห้าม import `@/...` ใด ๆ ในไฟล์นี้:
 *   seed (prisma/seed-demo.ts) รันด้วย tsx ซึ่ง resolve path alias `@/` ไม่ได้
 *   → seed import ไฟล์นี้แบบ relative ("../src/lib/demo")
 *   → demo-login route import แบบ alias ("@/lib/demo")
 *   ทั้งสองฝั่งจึงต้องใช้ค่าเดียวกันจากไฟล์นี้ (creds ตรงกันเสมอ)
 */

import { DEMO_PERSONAS } from "./demo-personas";

export {
  DEMO_PERSONAS,
  DEMO_TENANT_SLUGS,
  isDemoPersonaKey,
  type DemoPersona,
  type DemoPersonaKey,
  type DemoPersonaAuth,
} from "./demo-personas";

export interface DemoAgent {
  tenantSlug: string;
  email: string;
  password: string;
  name: string;
}

// password สาธารณะที่ใช้ login demo (public-by-design — ดู header comment)
export const DEMO_PASSWORD = "demo-helpwise-2026";

// demo agent ที่ login ด้วย password (persona "primary" — 1 คนต่อ tenant), role = AGENT เสมอ
export const DEMO_AGENTS: DemoAgent[] = DEMO_PERSONAS.filter((p) => p.auth === "password").map(
  (p) => ({
    tenantSlug: p.tenantSlug,
    email: p.email,
    password: DEMO_PASSWORD,
    name: p.name,
  })
);
