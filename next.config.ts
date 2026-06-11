import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// สร้าง Content-Security-Policy string จาก directive แต่ละตัว
// แยกเป็น array เพื่อให้อ่าน/แก้ไขง่าย แล้ว join ด้วย "; "
function buildCsp(): string {
  const directives: string[] = [
    "default-src 'self'",
    // portal ลูกค้า inject โลโก้ tenant + avatar เป็น <img src="https://..."> จาก host ภายนอกใดก็ได้
    "img-src 'self' https: data: blob:",
    // branding inject inline style (CSS custom properties) + Tailwind v4 ใช้ inline style
    "style-src 'self' 'unsafe-inline'",
    // 'unsafe-inline' จำเป็นสำหรับ Next.js inline runtime/hydration script (ยังไม่ใช้ nonce)
    // 'unsafe-eval' เฉพาะ dev เพราะ HMR ต้องใช้ eval — prod ไม่มี
    `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
    "connect-src 'self'",
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

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  async headers() {
    const securityHeaders = [
      {
        key: "Referrer-Policy",
        value: "no-referrer",
      },
      {
        key: "Content-Security-Policy",
        value: buildCsp(),
      },
      {
        key: "X-Content-Type-Options",
        value: "nosniff",
      },
      {
        // defense-in-depth คู่กับ frame-ancestors 'none' ใน CSP
        key: "X-Frame-Options",
        value: "DENY",
      },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
      },
    ];

    // HSTS เฉพาะ production เพื่อไม่ให้ localhost ติด HSTS ของ browser
    if (isProd) {
      securityHeaders.push({
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains; preload",
      });
    }

    return [
      {
        // ครอบทั้งแอปเพื่อป้องกัน Referrer header รั่วข้อมูล sensitive ออกไปทุกหน้า
        // /portal/verify ได้รับการคุ้มครองด้วย (defense-in-depth สำหรับ magic-link fragment)
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
