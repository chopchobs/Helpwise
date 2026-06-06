"use client";

/**
 * workspace layout — shell ที่ครอบทุกหน้าหลังจาก login
 * ทำหน้าที่เป็น auth gate: fetch /api/auth/agent/me ทุกครั้งที่ mount
 * ถ้า 401 → redirect ไป /login ทันที
 */

import { useState, useEffect, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import {
  LayoutDashboard,
  Inbox,
  Plus,
  LogOut,
  ChevronDown,
  Menu,
  X,
  CreditCard,
} from "lucide-react";
import type {
  MeResponse,
  SessionUser,
  SessionMember,
  SessionTenant,
} from "@/types/ticket";

// =============================================================================
// TYPES
// =============================================================================

interface SessionData {
  user: SessionUser;
  member: SessionMember;
  tenant: SessionTenant;
}

interface NavLinkProps {
  href: string;
  icon: React.ReactNode;
  label: string;
  isActive: boolean;
  onClick?: () => void;
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function NavLink({ href, icon, label, isActive, onClick }: NavLinkProps) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={[
        "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary",
        isActive
          ? "bg-primary-tint text-primary-ink font-semibold"
          : "text-secondary hover:bg-stone hover:text-foreground",
      ].join(" ")}
      aria-current={isActive ? "page" : undefined}
    >
      <span className="shrink-0" aria-hidden="true">{icon}</span>
      {label}
    </Link>
  );
}

/** skeleton แสดงระหว่างโหลด session */
function ShellSkeleton() {
  return (
    <div className="min-h-screen bg-background flex" aria-busy="true" aria-label="กำลังโหลด...">
      {/* sidebar skeleton */}
      <div className="hidden md:flex w-56 lg:w-64 shrink-0 flex-col bg-surface border-r border-border p-4 gap-3">
        <div className="h-8 bg-stone rounded-lg animate-pulse w-3/4" />
        <div className="mt-4 flex flex-col gap-2">
          <div className="h-9 bg-stone rounded-lg animate-pulse" />
          <div className="h-9 bg-stone rounded-lg animate-pulse" />
        </div>
      </div>
      {/* content skeleton */}
      <div className="flex-1 flex flex-col">
        <div className="h-14 bg-surface border-b border-border animate-pulse" />
        <div className="flex-1 p-6 flex flex-col gap-4">
          <div className="h-8 bg-stone rounded-lg animate-pulse w-1/3" />
          <div className="h-32 bg-stone rounded-xl animate-pulse" />
        </div>
      </div>
    </div>
  );
}

interface NavItem {
  href: string;
  icon: React.ReactNode;
  label: string;
}

// nav items คงที่ — กำหนดที่ module scope กัน re-create ทุก render
const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", icon: <LayoutDashboard size={18} />, label: "Dashboard" },
  { href: "/tickets", icon: <Inbox size={18} />, label: "Tickets" },
];

interface SidebarNavProps {
  session: SessionData;
  pathname: string;
}

/**
 * Sidebar nav content — top-level component (ไม่ define ใน render body ของ layout)
 * เพื่อให้ identity คงที่ ไม่ remount subtree ทุกครั้งที่ parent re-render
 * ใช้ซ้ำทั้ง desktop sidebar และ mobile drawer
 */
function SidebarNav({ session, pathname }: SidebarNavProps) {
  // เฉพาะ OWNER/ADMIN เท่านั้นที่เห็น Settings nav
  const isAdmin =
    session.member.role === "OWNER" || session.member.role === "ADMIN";

  return (
    <>
      {/* โลโก้ / ชื่อ tenant */}
      <div className="flex items-center gap-2 px-2 mb-6">
        {session.tenant.logoUrl ? (
          // logoUrl เป็น URL ที่ tenant กำหนดเอง (ภายนอก) — ใช้ <img> ตรง ๆ
          // ไม่ผ่าน next/image optimizer เพื่อกัน SSRF ผ่าน image proxy
          // (จะ validate เป็น HTTPS ตอน wire branding ในเฟส portal)
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={session.tenant.logoUrl}
            alt={`${session.tenant.name} logo`}
            width={32}
            height={32}
            className="rounded-md object-contain shrink-0 w-8 h-8"
          />
        ) : (
          <div
            className="w-8 h-8 rounded-md bg-primary-tint flex items-center justify-center shrink-0"
            aria-hidden="true"
          >
            <span className="text-primary-ink text-xs font-bold uppercase">
              {session.tenant.name.charAt(0)}
            </span>
          </div>
        )}
        <span className="font-semibold text-foreground text-sm truncate">
          {session.tenant.name}
        </span>
      </div>

      {/* ปุ่ม + Ticket ใหม่ */}
      <Link
        href="/tickets/new"
        className="flex items-center justify-center gap-2 px-3 py-2 mb-4 rounded-lg bg-primary-strong hover:bg-primary-strong-hover text-white text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
      >
        <Plus size={16} aria-hidden="true" />
        + Ticket ใหม่
      </Link>

      {/* Nav links — ทุก role เห็น */}
      <nav aria-label="เมนูหลัก">
        <ul className="flex flex-col gap-1" role="list">
          {NAV_ITEMS.map((item) => (
            <li key={item.href}>
              <NavLink
                href={item.href}
                icon={item.icon}
                label={item.label}
                isActive={
                  item.href === "/dashboard"
                    ? pathname === "/dashboard"
                    : pathname.startsWith(item.href)
                }
              />
            </li>
          ))}
        </ul>
      </nav>

      {/* Admin-only nav — แสดงเฉพาะ OWNER/ADMIN */}
      {isAdmin && (
        <nav aria-label="ตั้งค่า" className="mt-4 pt-4 border-t border-border">
          <p className="px-3 mb-1 text-xs font-semibold text-muted uppercase tracking-wide">
            ตั้งค่า
          </p>
          <ul className="flex flex-col gap-1" role="list">
            <li>
              <NavLink
                href="/settings/billing"
                icon={<CreditCard size={18} />}
                label="Billing"
                isActive={pathname.startsWith("/settings/billing")}
              />
            </li>
          </ul>
        </nav>
      )}
    </>
  );
}

// =============================================================================
// MAIN LAYOUT COMPONENT
// =============================================================================

export default function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const [session, setSession] = useState<SessionData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);

  // ตรวจ session ทุกครั้งที่ layout mount
  const verifySession = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/agent/me", { credentials: "include" });

      if (res.status === 401) {
        // ไม่มี session → ส่งกลับ login
        router.replace("/login");
        return;
      }

      const json = (await res.json()) as MeResponse;

      if (!res.ok || json.error || !json.data) {
        router.replace("/login");
        return;
      }

      setSession(json.data);
    } catch {
      // network error → ส่งกลับ login
      router.replace("/login");
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void verifySession();
  }, [verifySession]);

  // ปิด mobile menu เมื่อเปลี่ยน route
  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [pathname]);

  const handleLogout = useCallback(async () => {
    try {
      await fetch("/api/auth/agent/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // ถ้า logout API พัง ก็ redirect ไป login ได้เลย
    }
    router.replace("/login");
  }, [router]);

  // ขณะโหลด session ให้แสดง skeleton เพื่อหลีกเลี่ยง layout shift
  if (isLoading || !session) {
    return <ShellSkeleton />;
  }

  // ใช้ local variable เพื่อให้ TypeScript narrow type ใน nested JSX ได้
  const activeSession: SessionData = session;

  return (
    <div className="min-h-screen bg-background flex">
      {/* ============================================================ */}
      {/* Desktop Sidebar — fixed ซ้าย, hidden บน mobile              */}
      {/* ============================================================ */}
      <aside
        className="hidden md:flex w-56 lg:w-64 shrink-0 flex-col bg-surface border-r border-border p-4 sticky top-0 h-screen overflow-y-auto"
        aria-label="Sidebar navigation"
      >
        <SidebarNav session={activeSession} pathname={pathname} />
      </aside>

      {/* ============================================================ */}
      {/* Mobile Overlay + Drawer                                       */}
      {/* ============================================================ */}
      {isMobileMenuOpen && (
        <>
          {/* backdrop */}
          <div
            className="fixed inset-0 z-20 bg-foreground/30 md:hidden"
            aria-hidden="true"
            onClick={() => setIsMobileMenuOpen(false)}
          />
          {/* drawer */}
          <aside
            className="fixed inset-y-0 left-0 z-30 w-72 bg-surface border-r border-border p-4 flex flex-col md:hidden overflow-y-auto"
            aria-label="Mobile navigation"
          >
            <button
              type="button"
              onClick={() => setIsMobileMenuOpen(false)}
              className="self-end p-1.5 rounded-lg hover:bg-stone text-secondary focus:outline-none focus:ring-2 focus:ring-primary mb-2"
              aria-label="ปิดเมนู"
            >
              <X size={20} aria-hidden="true" />
            </button>
            <SidebarNav session={activeSession} pathname={pathname} />
          </aside>
        </>
      )}

      {/* ============================================================ */}
      {/* Main content area                                             */}
      {/* ============================================================ */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Topbar */}
        <header className="sticky top-0 z-10 bg-surface border-b border-border px-4 h-14 flex items-center justify-between shrink-0">
          {/* ซ้าย: hamburger (mobile) */}
          <button
            type="button"
            onClick={() => setIsMobileMenuOpen(true)}
            className="md:hidden p-1.5 rounded-lg hover:bg-stone text-secondary focus:outline-none focus:ring-2 focus:ring-primary"
            aria-label="เปิดเมนู"
          >
            <Menu size={20} aria-hidden="true" />
          </button>

          {/* spacer สำหรับ desktop */}
          <div className="hidden md:block" />

          {/* ขวา: plan badge + user menu */}
          <div className="flex items-center gap-3">
            {/* Plan badge */}
            <span className="hidden sm:inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border border-border text-secondary bg-stone uppercase tracking-wide">
              {activeSession.tenant.plan}
            </span>

            {/* User menu dropdown */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setIsUserMenuOpen((prev) => !prev)}
                className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-stone text-secondary transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
                aria-haspopup="true"
                aria-expanded={isUserMenuOpen}
                aria-label="เมนูผู้ใช้"
              >
                {/* Avatar — avatarUrl เป็น URL ภายนอก ใช้ <img> ตรง ๆ ไม่ผ่าน optimizer (กัน SSRF) */}
                {activeSession.user.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={activeSession.user.avatarUrl}
                    alt={activeSession.user.name ?? activeSession.user.email}
                    width={28}
                    height={28}
                    className="rounded-full object-cover w-7 h-7"
                  />
                ) : (
                  <div
                    className="w-7 h-7 rounded-full bg-primary-tint flex items-center justify-center shrink-0"
                    aria-hidden="true"
                  >
                    <span className="text-primary-ink text-xs font-bold uppercase">
                      {(activeSession.user.name ?? activeSession.user.email).charAt(0)}
                    </span>
                  </div>
                )}
                {/* ชื่อ + role */}
                <div className="hidden sm:flex flex-col items-start leading-tight">
                  <span className="text-sm font-medium text-foreground max-w-[120px] truncate">
                    {activeSession.user.name ?? activeSession.user.email}
                  </span>
                  <span className="text-xs text-muted capitalize">
                    {activeSession.member.role.toLowerCase()}
                  </span>
                </div>
                <ChevronDown size={14} aria-hidden="true" className="shrink-0" />
              </button>

              {/* Dropdown menu */}
              {isUserMenuOpen && (
                <>
                  {/* backdrop สำหรับปิด dropdown */}
                  <div
                    className="fixed inset-0 z-10"
                    aria-hidden="true"
                    onClick={() => setIsUserMenuOpen(false)}
                  />
                  <div
                    className="absolute right-0 mt-1 w-48 bg-surface rounded-xl border border-border shadow-lg z-20 py-1 overflow-hidden"
                    role="menu"
                    aria-label="ตัวเลือกผู้ใช้"
                  >
                    {/* ข้อมูล user */}
                    <div className="px-3 py-2 border-b border-border">
                      <p className="text-sm font-medium text-foreground truncate">
                        {activeSession.user.name ?? "—"}
                      </p>
                      <p className="text-xs text-muted truncate">
                        {activeSession.user.email}
                      </p>
                    </div>
                    {/* ปุ่ม logout */}
                    <button
                      type="button"
                      onClick={() => { void handleLogout(); }}
                      role="menuitem"
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-danger hover:bg-danger-tint transition-colors focus:outline-none focus:bg-danger-tint"
                    >
                      <LogOut size={15} aria-hidden="true" />
                      ออกจากระบบ
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 bg-background">
          {children}
        </main>
      </div>
    </div>
  );
}
