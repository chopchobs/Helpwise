"use client";

/**
 * DemoLoginClient — ส่วน client ของหน้า /demo
 *
 * 2 โหมด (server page เป็นคนตัดสินจาก cookie):
 *   - hasSession = false → auto-POST /api/auth/demo/login ทันที (พฤติกรรมเดิม 0 คลิก)
 *   - hasSession = true  → render หน้ายืนยันก่อน ไม่ auto-POST
 *     (กัน cookie clobber: visitor ที่ login อยู่แล้วเผลอกดลิงก์ persona แล้ว session ตัวเองถูกทับ)
 *
 * Redirect strategy: window.location.assign (full navigation) ไม่ใช่ router.push
 *   เพราะ workspace layout อ่าน cookie ฝั่ง server — soft nav อาจไม่ re-run server
 *   auth ด้วย cookie ที่เพิ่ง set; full navigation ทำให้ server เห็น cookie ใหม่แน่นอน
 *
 * ⚠️ props รับได้แค่ key + name ของ persona — ห้ามส่ง credential ใด ๆ ลงมา (DEMO_PASSWORD
 *   อยู่ใน src/lib/demo.ts ซึ่งเป็น server-only)
 */

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { resolveDemoNext } from "@/lib/demo-persona-ui";
import type { DemoPersonaKey } from "@/lib/demo-personas";

// =============================================================================
// TYPES
// =============================================================================

interface DemoLoginResponse {
  data: {
    user: { id: string; email: string; name: string | null };
    role: string;
  } | null;
  error: { code: string; message: string } | null;
}

interface DemoLoginClientProps {
  /** persona ที่จะ login (validate เป็น strict enum แล้วฝั่ง server page) */
  persona: DemoPersonaKey;
  /** ค่าดิบของ param `next` — validate ที่จุด redirect จริงด้วย resolveDemoNext */
  nextParam: string | null;
  /** true = มี agent session อยู่แล้ว → ต้องยืนยันก่อนทับ */
  hasSession: boolean;
  /** ชื่อ (หรืออีเมล) ของ session ปัจจุบัน — ใช้บอกว่ากำลังจะทับใคร */
  currentName: string | null;
  /** ชื่อ persona ปลายทาง — null ถ้าไม่รู้จัก (เช่นไม่ใช่ demo tenant) */
  targetName: string | null;
}

// =============================================================================
// COMPONENT
// =============================================================================

export default function DemoLoginClient({
  persona,
  nextParam,
  hasSession,
  currentName,
  targetName,
}: DemoLoginClientProps) {
  // error = true เมื่อ login ไม่สำเร็จ — ไม่เก็บ error detail (กัน leak)
  const [hasError, setHasError] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [, startTransition] = useTransition();

  // กัน state update หลัง unmount/redirect (พฤติกรรมเดิมของหน้านี้)
  const cancelledRef = useRef(false);
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const runDemoLogin = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/demo/login", {
        method: "POST",
        // credentials: "include" สำหรับ same-origin cookie (subdomain ถือว่า same-site)
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ persona }),
      });

      const json = (await res.json()) as DemoLoginResponse;

      if (!res.ok || json.error) {
        if (!cancelledRef.current) setHasError(true);
        return;
      }

      // cookie ถูก set โดย server แล้ว — full navigation ให้ server เห็น cookie ใหม่
      // ปลายทางผ่าน resolveDemoNext เสมอ (ค่าที่ไม่ผ่าน → /dashboard เงียบ ๆ)
      window.location.assign(resolveDemoNext(nextParam));
    } catch {
      if (!cancelledRef.current) setHasError(true);
    }
  }, [persona, nextParam]);

  // ใช้ startTransition เพื่อหลีกเลี่ยง cascading render ตาม react-hooks/set-state-in-effect
  // startTransition เป็น stable reference — ไม่ต้องใส่ใน deps
  useEffect(() => {
    // มี session อยู่แล้ว → รอผู้ใช้ยืนยัน ห้าม auto-POST (จะทับ cookie ของเขา)
    if (hasSession) return;
    startTransition(() => {
      void runDemoLogin();
    });
  }, [hasSession, runDemoLogin]);

  const showConfirm = hasSession && !isSwitching && !hasError;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="flex flex-col items-center text-center">
        {hasError ? (
          <DemoError onRetry={() => window.location.reload()} />
        ) : showConfirm ? (
          <DemoSwitchConfirm
            currentName={currentName}
            targetName={targetName}
            continueHref={resolveDemoNext(nextParam)}
            onSwitch={() => {
              setIsSwitching(true);
              void runDemoLogin();
            }}
          />
        ) : (
          <DemoLoading />
        )}
      </div>
    </div>
  );
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function DemoLoading() {
  return (
    <>
      <Loader2
        size={32}
        className="animate-spin text-primary"
        aria-hidden="true"
      />
      <p className="mt-4 text-base font-medium text-foreground">
        กำลังเข้าสู่ demo workspace…
      </p>
      <p className="mt-1 text-sm text-secondary">
        กรุณารอสักครู่ ระบบกำลังเตรียมข้อมูลตัวอย่างให้คุณ
      </p>
    </>
  );
}

interface DemoSwitchConfirmProps {
  currentName: string | null;
  targetName: string | null;
  continueHref: string;
  onSwitch: () => void;
}

function DemoSwitchConfirm({
  currentName,
  targetName,
  continueHref,
  onSwitch,
}: DemoSwitchConfirmProps) {
  const targetLabel = targetName ?? "บัญชี demo อีกคน";

  return (
    <>
      <h1 className="text-xl font-semibold text-foreground">
        สลับเป็น {targetLabel}?
      </h1>
      <p className="mt-2 max-w-sm text-sm text-secondary">
        ตอนนี้คุณใช้งานอยู่ในชื่อ{" "}
        <span className="font-medium text-foreground">
          {currentName ?? "บัญชีปัจจุบัน"}
        </span>{" "}
        — การสลับจะทับ session นี้ในเบราว์เซอร์นี้
      </p>
      <p className="mt-2 max-w-sm text-sm text-secondary">
        ถ้าอยากเห็น real-time presence ของ agent 2 คนพร้อมกัน ให้เปิดลิงก์นี้ใน
        <span className="font-medium text-foreground"> incognito</span> หรืออีกเบราว์เซอร์แทน
      </p>
      <div className="mt-5 flex items-center gap-4">
        <button
          type="button"
          onClick={onSwitch}
          className="rounded-lg bg-primary-strong px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-strong-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          สลับเป็น {targetLabel}
        </button>
        <a
          href={continueHref}
          className="text-sm font-medium text-primary-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          ใช้บัญชีเดิมต่อ
        </a>
      </div>
    </>
  );
}

function DemoError({ onRetry }: { onRetry: () => void }) {
  return (
    <>
      <h1 className="text-xl font-semibold text-foreground">
        เข้าสู่ demo ไม่สำเร็จ
      </h1>
      <p className="mt-2 max-w-sm text-sm text-secondary">
        ขออภัย ระบบ demo ยังไม่พร้อมในขณะนี้ กรุณาลองอีกครั้ง
      </p>
      <div className="mt-5 flex items-center gap-4">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg bg-primary-strong px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-strong-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          ลองอีกครั้ง
        </button>
        <a
          href="/login"
          className="text-sm font-medium text-primary-ink hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          ไปหน้า login
        </a>
      </div>
    </>
  );
}
