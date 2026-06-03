// Layout สำหรับ portal route group — plain wrapper สำหรับ ticket pages
// หน้า auth (login/verify) จัดการ centering ตัวเองผ่าน flex min-h-screen
// TODO Phase (Tenant Branding): ดึง logoUrl + accent color จาก Tenant.settings แล้ว inject CSS variable
// เช่น style={{ "--color-primary": tenant.accentColor } as React.CSSProperties}
// เพื่อ override --color-primary ที่นิยามใน :root → portal จะใช้ Terracotta ของ tenant แทน
import React from "react";

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      {children}
    </div>
  );
}
