"use client";

/**
 * PortalHeader — header ถาวรของ portal ลูกค้า (Contact)
 *
 * แสดง: โลโก้/ชื่อ tenant + ลิงก์ "คำขอของฉัน" + ชื่อผู้ใช้ + ปุ่มออกจากระบบ
 *
 * กฎการแสดงผล:
 *   1. หน้า /portal/login และ /portal/verify → ไม่ render อะไรเลย (return null)
 *   2. nav + ชื่อผู้ใช้ + ปุ่มออกจากระบบ → แสดงเมื่อ contactLabel != null เท่านั้น
 *      (session หมดอายุ = layout อ่าน contact ไม่ได้ = ไม่โชว์ปุ่มที่กดแล้วไม่มีความหมาย)
 *   3. แถบโลโก้/ชื่อ tenant แสดงเสมอ (ไม่ผูกกับ branding feature อีกต่อไป)
 *
 * logout ใช้ endpoint เดิม POST /api/auth/portal/logout (ไม่มีการแก้ฝั่ง server)
 */

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Inbox, LogOut } from "lucide-react";

interface PortalHeaderProps {
  /** ชื่อ tenant — ใช้เป็น fallback ข้อความเมื่อไม่มีโลโก้ */
  tenantName: string | null;
  /** โลโก้ tenant — null เมื่อ branding ปิด/ไม่ได้ตั้งค่า → fallback เป็น text */
  logoUrl: string | null;
  /** contact.name ?? contact.email — null เมื่อยังไม่ login หรือ session หมดอายุ */
  contactLabel: string | null;
}

/** path ที่ต้องไม่มี header เลย (หน้า auth ของ portal) */
const BARE_PATHS = ["/portal/login", "/portal/verify"];

export default function PortalHeader({
  tenantName,
  logoUrl,
  contactLabel,
}: PortalHeaderProps) {
  const pathname = usePathname();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  // 1. หน้า auth — ไม่แสดง header ทั้งแถบ
  if (BARE_PATHS.includes(pathname)) return null;

  const isAuthenticated = contactLabel !== null;

  async function handleLogout(): Promise<void> {
    // กันกดซ้ำระหว่างรอ response
    if (isLoggingOut) return;
    setIsLoggingOut(true);

    try {
      await fetch("/api/auth/portal/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // network error — cookie อาจยังอยู่ แต่พาไปหน้า login ดีกว่าค้างอยู่หน้าเดิม
      // (หน้าที่ต้อง auth จะเด้งกลับมา login เองอยู่แล้วถ้า session ยังไม่ถูกล้าง)
    }

    // ⚠️ hard navigation ไม่ใช่ router.replace ด้วย 2 เหตุผล:
    //    1. layout เป็น server component ที่อ่าน session — client-side nav ไม่ re-render ให้
    //    2. full page load ล้าง client router cache ของ Next ที่อาจยังถือ RSC payload
    //       ของ ticket ลูกค้าค้างอยู่ในหน่วยความจำ (สำคัญเมื่อใช้เครื่องร่วมกับคนอื่น)
    //    replace ไม่ใช่ assign — ห้ามให้ปุ่ม back พากลับไปหน้าที่ต้อง login
    window.location.replace("/portal/login");
  }

  return (
    <header className="bg-surface border-b border-border">
      <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
        {/* ซ้าย: โลโก้ tenant (ถ้ามี) — ไม่มีก็ใช้ชื่อ tenant เป็น text */}
        <div className="flex items-center gap-3 min-w-0">
          {logoUrl ? (
            /*
             * ใช้ <img> ตรง ๆ ไม่ผ่าน next/image — project convention:
             * next/image optimizer อาจ SSRF ผ่าน /_next/image?url= endpoint
             * logoUrl ผ่าน https-only validator จาก parseBranding แล้ว (SSRF mitigation layer 1)
             * referrerPolicy="no-referrer" กัน tenant URL รั่วไปยัง 3rd-party server
             */
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={logoUrl}
              alt={tenantName ? `${tenantName} logo` : "Logo"}
              referrerPolicy="no-referrer"
              className="h-8 w-auto object-contain shrink-0"
            />
          ) : (
            <span className="text-sm font-semibold text-foreground truncate">
              {tenantName ?? "ศูนย์ช่วยเหลือ"}
            </span>
          )}
        </div>

        {/* ขวา: nav + ผู้ใช้ + logout — เฉพาะเมื่อมี session จริง */}
        {isAuthenticated && (
          <nav className="flex items-center gap-1 sm:gap-3 min-w-0">
            <Link
              href="/portal/tickets"
              className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-sm text-secondary hover:text-foreground hover:bg-stone transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <Inbox size={16} aria-hidden="true" />
              {/* มือถือเหลือแต่ icon — ป้องกันแถวล้นที่ 375px */}
              <span className="hidden sm:inline">คำขอของฉัน</span>
            </Link>

            <span
              className="hidden sm:block text-sm text-secondary truncate max-w-[12rem]"
              title={contactLabel}
            >
              {contactLabel}
            </span>

            <button
              type="button"
              onClick={() => void handleLogout()}
              disabled={isLoggingOut}
              aria-label="ออกจากระบบ"
              className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-sm text-secondary hover:text-foreground hover:bg-stone transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <LogOut size={16} aria-hidden="true" />
              <span className="hidden sm:inline">
                {isLoggingOut ? "กำลังออก..." : "ออกจากระบบ"}
              </span>
            </button>
          </nav>
        )}
      </div>
    </header>
  );
}
