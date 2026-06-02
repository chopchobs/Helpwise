// Layout สำหรับ portal route group — plain wrapper สำหรับ ticket pages
// หน้า auth (login/verify) จัดการ centering ตัวเองผ่าน flex min-h-screen
// TODO Phase (Tenant Branding): ดึง logoUrl + accent color จาก Tenant.settings แล้ว inject CSS variable
import React from "react";

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#F7F9FB]">
      {children}
    </div>
  );
}
