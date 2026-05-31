import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  async headers() {
    return [
      {
        // ครอบทั้งแอปเพื่อป้องกัน Referrer header รั่วข้อมูล sensitive ออกไปทุกหน้า
        // /portal/verify ได้รับการคุ้มครองด้วย (defense-in-depth สำหรับ magic-link fragment)
        source: "/(.*)",
        headers: [
          {
            key: "Referrer-Policy",
            value: "no-referrer",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
