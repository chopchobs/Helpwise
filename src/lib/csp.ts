// สร้าง Content-Security-Policy string จาก directive แต่ละตัว
// แยกเป็น array เพื่อให้อ่าน/แก้ไขง่าย แล้ว join ด้วย "; "
// อยู่ใน src/lib เพื่อให้ unit test เรียกได้ (next.config.ts import ไปใช้) — ดู P6a ของ
// .claude/specs/post-merge-gate-external-resource-proposal.md
export function buildCsp(): string {
  // อ่าน NODE_ENV ภายใน function (ไม่ใช่ module-level const) เพื่อให้ test สลับ prod/dev ได้
  const isProd = process.env.NODE_ENV === "production";

  // Realtime presence (Phase 35) ต่อ WebSocket ไป Supabase — ต้องอยู่ใน connect-src
  // ไม่งั้นเบราว์เซอร์บล็อกตั้งแต่ต้น (พบตอน Gate 2 ของ Phase 37: presence ไม่เคยทำงานที่ไหนเลย)
  // derive จาก env ตอน build เพื่อให้แคบที่สุด — ไม่เปิดกว้างเป็น https://*.supabase.co
  // ⚠️ ถ้า NEXT_PUBLIC_SUPABASE_URL ไม่ถูกตั้งตอน build จะได้ connect-src 'self' เงียบ ๆ
  //    → ต้องมี guard ตอน build คู่กันเสมอ (ดู .claude/specs/post-merge-gate-external-resource-proposal.md)
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseOrigins = supabaseUrl
    ? [supabaseUrl, supabaseUrl.replace(/^https:/, "wss:")]
    : [];

  const directives: string[] = [
    "default-src 'self'",
    // portal ลูกค้า inject โลโก้ tenant + avatar เป็น <img src="https://..."> จาก host ภายนอกใดก็ได้
    "img-src 'self' https: data: blob:",
    // branding inject inline style (CSS custom properties) + Tailwind v4 ใช้ inline style
    "style-src 'self' 'unsafe-inline'",
    // 'unsafe-inline' จำเป็นสำหรับ Next.js inline runtime/hydration script (ยังไม่ใช้ nonce)
    // 'unsafe-eval' เฉพาะ dev เพราะ HMR ต้องใช้ eval — prod ไม่มี
    `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
    `connect-src 'self'${supabaseOrigins.length ? " " + supabaseOrigins.join(" ") : ""}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
  ];

  if (isProd) {
    directives.push("upgrade-insecure-requests");
  }

  return directives.join("; ");
}
