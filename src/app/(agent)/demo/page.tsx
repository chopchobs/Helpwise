"use client";

/**
 * หน้า Demo Entry — one-click demo login สำหรับ portfolio demo
 * เข้าถึงได้โดยไม่ต้อง login เพราะ (agent)/layout.tsx เป็น plain wrapper ไม่มี auth gate
 *   (auth gate อยู่ที่ (workspace)/layout.tsx ซึ่งไม่ครอบ route นี้)
 *
 * Flow: visitor ถูกส่งมาที่ /demo บน demo subdomain (full page load) →
 *   on mount auto-POST /api/auth/demo/login (same-origin, มี tenant context) →
 *   server set agent cookie → redirect เข้า /dashboard
 *
 * Redirect strategy: ใช้ window.location.assign (full navigation) ไม่ใช่ router.push
 *   เพราะ workspace layout อ่าน cookie ฝั่ง server — soft nav อาจไม่ re-run server
 *   auth ด้วย cookie ที่เพิ่ง set; full navigation ทำให้ server เห็น cookie ใหม่แน่นอน
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

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

// =============================================================================
// COMPONENT
// =============================================================================

export default function DemoEntryPage() {
  // error = true เมื่อ login ไม่สำเร็จ — ไม่เก็บ error detail (กัน leak)
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    // กัน double-run / state update หลัง redirect
    let cancelled = false;

    async function runDemoLogin() {
      try {
        const res = await fetch("/api/auth/demo/login", {
          method: "POST",
          // credentials: "include" สำหรับ same-origin cookie (subdomain ถือว่า same-site)
          credentials: "include",
        });

        const json = (await res.json()) as DemoLoginResponse;

        if (!res.ok || json.error) {
          if (!cancelled) setHasError(true);
          return;
        }

        // cookie ถูก set โดย server แล้ว — full navigation ให้ server เห็น cookie ใหม่
        window.location.assign("/dashboard");
      } catch {
        if (!cancelled) setHasError(true);
      }
    }

    void runDemoLogin();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="flex flex-col items-center text-center">
        {hasError ? (
          <DemoError onRetry={() => window.location.reload()} />
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
