/**
 * src/lib/demo.ts
 * Demo workspaces — single source of truth สำหรับ portfolio demo credentials
 *
 * ⚠️ credentials ในไฟล์นี้เป็น PUBLIC โดยตั้งใจ (portfolio demo)
 *   - visitor login ด้วย creds สาธารณะนี้ได้ → จึงจำกัดสิทธิ์เป็น role = AGENT เท่านั้น
 *     (ไม่ใช่ OWNER/ADMIN) เพื่อกัน action ทำลาย/admin จาก visitor
 *   - password เป็น public-by-design ไม่ใช่ secret — ห้ามนำ pattern นี้ไปใช้กับ user จริง
 *
 * ⚠️ ห้าม import `@/...` ใด ๆ ในไฟล์นี้:
 *   seed (prisma/seed-demo.ts) รันด้วย tsx ซึ่ง resolve path alias `@/` ไม่ได้
 *   → seed import ไฟล์นี้แบบ relative ("../src/lib/demo")
 *   → demo-login route import แบบ alias ("@/lib/demo")
 *   ทั้งสองฝั่งจึงต้องใช้ค่าเดียวกันจากไฟล์นี้ (creds ตรงกันเสมอ)
 */

export interface DemoAgent {
  tenantSlug: string;
  email: string;
  password: string;
  name: string;
}

// slug ของ demo tenants (subdomain demo)
export const DEMO_TENANT_SLUGS = ["acme", "globex"] as const;

// password สาธารณะที่ใช้ login demo (public-by-design — ดู header comment)
export const DEMO_PASSWORD = "demo-helpwise-2026";

// demo agent ที่ visitor ใช้ login (1 คนต่อ tenant) — role = AGENT เสมอ
export const DEMO_AGENTS: DemoAgent[] = [
  {
    tenantSlug: "acme",
    email: "demo@acme.helpwise.com",
    password: DEMO_PASSWORD,
    name: "Demo Agent",
  },
  {
    tenantSlug: "globex",
    email: "demo@globex.helpwise.com",
    password: DEMO_PASSWORD,
    name: "Demo Agent",
  },
];
