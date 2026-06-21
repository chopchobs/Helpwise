import { headers } from "next/headers";
import { DEMO_URL } from "@/lib/landing-links";
import { isValidSlugFormat } from "@/lib/slug";

// subdomain ที่จองไว้ (ตรงกับ proxy) — ไม่ถือเป็น tenant
const RESERVED_SUBDOMAINS = new Set([
  "www",
  "app",
  "api",
  "admin",
  "mail",
  "ftp",
  "smtp",
]);

// resolve ปลายทางปุ่ม "Try live demo" ตาม Host ปัจจุบัน (server-only — ใช้ next/headers)
// บน tenant subdomain → คืน relative "/demo" เพื่ออยู่ subdomain เดิม + กัน open-redirect
// (ไม่ประกอบ absolute URL จาก host ที่ client ควบคุมได้)
// บน root domain / localhost / reserved / ไม่รู้จัก → fallback เป็น DEMO_URL (acme)
export async function resolveDemoUrl(): Promise<string> {
  const h = await headers();
  const rawHost = h.get("host") ?? h.get("x-forwarded-host") ?? "";
  const host = rawHost.split(":")[0]; // ตัด port ออก

  const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "gethelpwise.xyz";

  // root domain / localhost ตรง ๆ → ไม่มี tenant
  if (host === rootDomain || host === "localhost") {
    return DEMO_URL;
  }

  // ดึง slug จากส่วนหน้าของ host ถ้าเป็น subdomain ของ root domain หรือ localhost (dev)
  let slug: string | null = null;
  if (host.endsWith("." + rootDomain)) {
    slug = host.slice(0, host.length - ("." + rootDomain).length);
  } else if (host.endsWith(".localhost")) {
    slug = host.slice(0, host.length - ".localhost".length);
  }

  // valid tenant subdomain → อยู่ subdomain เดิม
  if (slug && isValidSlugFormat(slug) && !RESERVED_SUBDOMAINS.has(slug)) {
    return "/demo";
  }

  return DEMO_URL;
}
