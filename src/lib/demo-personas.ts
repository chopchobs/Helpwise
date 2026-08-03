/**
 * src/lib/demo-personas.ts
 * Demo personas — single source of truth ของ "ตัวละคร" demo ทั้งหมด (2 คนต่อ tenant)
 *
 * ⚠️ ไฟล์นี้ client-safe โดยตั้งใจ: ไม่มี secret/password อยู่เลย
 *   - client component (banner สลับ persona) import ไฟล์นี้ได้ตรง ๆ
 *   - DEMO_PASSWORD อยู่ใน src/lib/demo.ts เท่านั้น (ห้ามให้ติดไป client bundle)
 *
 * ⚠️ ห้าม import `@/...` ใด ๆ ในไฟล์นี้:
 *   seed (prisma/seed-demo.ts) รันด้วย tsx ซึ่ง resolve path alias `@/` ไม่ได้
 *   → seed import แบบ relative ("../src/lib/demo") ซึ่ง re-export ต่อจากไฟล์นี้
 */

// วิธี login ของ persona:
//   "password" = ใช้ DEMO_PASSWORD (public-by-design)
//   "persona"  = ไม่มี password สาธารณะ — resolve identity จาก allowlist ฝั่ง server เท่านั้น
export type DemoPersonaAuth = "password" | "persona";

// strict enum — ห้ามใช้ index/ตัวเลขอ้าง persona (กัน client ส่งค่าที่ไม่ได้ตั้งใจ)
export type DemoPersonaKey = "primary" | "secondary";

export interface DemoPersona {
  key: DemoPersonaKey;
  tenantSlug: string;
  email: string;
  name: string;
  auth: DemoPersonaAuth;
}

// slug ของ demo tenants (subdomain demo)
export const DEMO_TENANT_SLUGS = ["acme", "globex"] as const;

// persona ทั้งหมด — role = AGENT เสมอ (บังคับซ้ำที่ route + seed)
export const DEMO_PERSONAS: DemoPersona[] = [
  {
    key: "primary",
    tenantSlug: "acme",
    email: "demo@acme.helpwise.com",
    name: "Demo Agent",
    auth: "password",
  },
  {
    key: "secondary",
    tenantSlug: "acme",
    email: "alex@acme.helpwise.com",
    name: "Alex Rivera",
    auth: "persona",
  },
  {
    key: "primary",
    tenantSlug: "globex",
    email: "demo@globex.helpwise.com",
    name: "Demo Agent",
    auth: "password",
  },
  {
    key: "secondary",
    tenantSlug: "globex",
    email: "dana@globex.helpwise.com",
    name: "Dana Wu",
    auth: "persona",
  },
];

// type guard สำหรับค่าที่มาจาก client — เทียบค่าตรง ๆ (ไม่ใช้เป็น index/lookup key)
export function isDemoPersonaKey(value: unknown): value is DemoPersonaKey {
  return value === "primary" || value === "secondary";
}
