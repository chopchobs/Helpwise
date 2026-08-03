/**
 * src/lib/demo-persona-ui.ts
 * Pure helpers ของ demo persona UI (Phase 37 slice 2) — ไม่มี side effect / ไม่แตะ DOM
 *
 * ⚠️ client-safe: import ได้จาก client component (ไม่มี secret) และห้าม import `@/lib/demo`
 *   (DEMO_PASSWORD อยู่ในไฟล์นั้น — ห้ามติด client bundle)
 */

import {
  DEMO_TENANT_SLUGS,
  type DemoPersonaKey,
} from "@/lib/demo-personas";

/** ปลายทาง default เมื่อ `next` ใช้ไม่ได้ — ไม่ error ไม่แจ้งเตือน */
export const DEMO_NEXT_FALLBACK = "/dashboard";

/**
 * path ที่อนุญาตให้ redirect ต่อหลัง demo login: `/tickets/<id>` เท่านั้น
 *
 * ใช้ `(?![\s\S])` แทน `$` โดยตั้งใจ — ใน JS `$` ยัง match ก่อน newline ตัวสุดท้ายได้
 * ("/tickets/abc\n" จะผ่าน) ซึ่งเปิดช่องให้ค่าที่มี newline หลุดไปเป็นปลายทาง redirect
 */
const TICKET_PATH_PATTERN = /^\/tickets\/[A-Za-z0-9_-]+(?![\s\S])/;

/**
 * ตรวจ param `next` ของ /demo — open-redirect hardening
 *
 * กฎ: relative path เท่านั้น และต้องเป็น `/tickets/<id>` เท่านั้น
 * (reject `//…`, `http(s)://`, `\`, อะไรก็ตามที่มี host/query/fragment/newline)
 * ตรวจจาก string ดิบที่รับมา แล้วคืน "ค่าเดิมตัวนั้น" — ไม่ decode/normalize ก่อนตรวจ
 * ไม่ผ่าน → fallback /dashboard เงียบ ๆ
 */
export function resolveDemoNext(raw: string | null): string {
  if (!raw) return DEMO_NEXT_FALLBACK;
  if (!TICKET_PATH_PATTERN.test(raw)) return DEMO_NEXT_FALLBACK;
  return raw;
}

/**
 * URL ที่ให้ visitor copy ไปเปิดใน incognito → login เป็น agent คนที่ 2 แล้วเด้งเข้า ticket ใบเดิม
 * `origin` ต้องมาจาก window.location.origin เท่านั้น (ห้ามประกอบจาก input/env/searchParams)
 */
export function buildDemoPersonaUrl(origin: string, ticketId: string): string {
  return `${origin}/demo?persona=secondary&next=/tickets/${ticketId}`;
}

/** key ของ localStorage — ผูกกับ tenant เพื่อไม่ให้ปิดที่ tenant หนึ่งแล้วหายทุก tenant */
export function demoBannerDismissKey(tenantSlug: string): string {
  return `helpwise:demo-persona-banner-dismissed:${tenantSlug}`;
}

/**
 * ตัดสินว่าจะแสดง banner ชวนเปิด agent คนที่ 2 ไหม
 * แสดงเฉพาะ: demo tenant + session เป็น persona "primary" + ยังไม่เคยปิด
 * (secondary = เป็น agent คนที่ 2 อยู่แล้ว ไม่ต้องชวนซ้ำ)
 */
export function shouldShowDemoPersonaBanner(input: {
  demoPersona: DemoPersonaKey | null;
  tenantSlug: string | null;
  isDismissed: boolean;
}): boolean {
  if (input.isDismissed) return false;
  if (input.demoPersona !== "primary") return false;
  if (!input.tenantSlug) return false;
  return (DEMO_TENANT_SLUGS as readonly string[]).includes(input.tenantSlug);
}
