// Layout สำหรับ agent route group — plain wrapper สำหรับ ticket pages
// หน้า auth (login) จัดการ centering ตัวเองผ่าน flex min-h-screen
import React from "react";

export default function AgentLayout({
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
