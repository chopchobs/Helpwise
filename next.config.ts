import type { NextConfig } from "next";
// buildCsp ย้ายไป src/lib/csp.ts เพื่อให้ unit test เรียกได้ (พฤติกรรมเดิมทุกประการ)
import { buildCsp } from "./src/lib/csp";

const isProd = process.env.NODE_ENV === "production";

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
