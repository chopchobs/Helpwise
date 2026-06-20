// Tenant slug format — single source of truth (security: กัน path-traversal / host-injection / open-redirect)
// อนุญาตเฉพาะ a-z, 0-9, hyphen — บล็อก ".", "/", "@", ":", "\", whitespace ที่ใช้ escape host ได้
export const SLUG_REGEX = /^[a-z0-9-]+$/;

export function isValidSlugFormat(slug: string): boolean {
  return SLUG_REGEX.test(slug);
}

// ประกอบ URL agent login ของ tenant จาก slug + rootDomain
// validate slug ก่อนเสมอ (defensive) — คืน null ถ้า format ผิด เพื่อให้ caller กัน open-redirect
export function buildTenantLoginUrl(slug: string, rootDomain: string): string | null {
  if (!isValidSlugFormat(slug)) return null;
  return `https://${slug}.${rootDomain}/login`;
}
