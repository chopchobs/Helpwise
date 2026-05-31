"use client";

/**
 * หน้า Portal Verify — แลก magic-link token เป็น session cookie
 * ลิงก์จากอีเมล: /portal/verify#token=...  (fragment ไม่ถูกส่งไป server → ปลอดภัยกว่า query string)
 * อ่าน token จาก window.location.hash ฝั่ง client → POST /api/auth/portal/verify ทันทีผ่าน useEffect
 * สำเร็จ → redirect ไป portal home; ล้มเหลว → แสดง error + ลิงก์ขอใหม่
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldCheck, ShieldX } from "lucide-react";
import AuthCard from "@/components/ui/AuthCard";
import FormAlert from "@/components/ui/FormAlert";

// =============================================================================
// TYPES
// =============================================================================

type VerifyStatus = "verifying" | "success" | "error";

interface VerifyApiResponse {
  data: { ok: boolean } | null;
  error: { code: string; message: string } | null;
}

// =============================================================================
// COMPONENT
// =============================================================================

export default function PortalVerifyPage() {
  const router = useRouter();
  const [status, setStatus] = useState<VerifyStatus>("verifying");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // ref เพื่อกัน verify ซ้ำ (React StrictMode double-invoke useEffect)
  const hasVerified = useRef(false);

  useEffect(() => {
    // กัน double-invoke จาก React StrictMode
    if (hasVerified.current) return;
    hasVerified.current = true;

    async function verifyToken() {
      // อ่าน token จาก fragment (#token=...) — fragment ไม่ถูกส่งไป server ทำให้ปลอดภัยกว่า query string
      // window เข้าถึงได้ใน useEffect เท่านั้น (client-side only) กัน SSR error
      const hash = window.location.hash.slice(1); // ตัด "#" นำหน้าออก
      const token = new URLSearchParams(hash).get("token");

      // ลบ fragment ออกจาก address bar ทันทีหลังอ่านค่า เพื่อไม่ให้ token ค้างใน history
      router.replace("/portal/verify");

      // ไม่มี token ใน hash — แสดง error ทันที
      if (!token) {
        setErrorMessage("ลิงก์ไม่ถูกต้องหรือหมดอายุ กรุณาขอลิงก์ใหม่");
        setStatus("error");
        return;
      }

      try {
        const res = await fetch("/api/auth/portal/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ token }),
        });

        const json = (await res.json()) as VerifyApiResponse;

        if (res.ok && json.data?.ok) {
          setStatus("success");
          // รอสักครู่เพื่อให้ user เห็น success state ก่อน redirect
          // TODO Phase (Portal Dashboard): เปลี่ยน "/portal" เป็น "/portal/tickets" เมื่อสร้างแล้ว
          setTimeout(() => router.push("/portal"), 1200);
        } else {
          // token หมดอายุ / ถูกใช้ไปแล้ว / ไม่พบ
          setErrorMessage(json.error?.message ?? "ลิงก์ไม่ถูกต้องหรือหมดอายุ กรุณาขอลิงก์ใหม่");
          setStatus("error");
        }
      } catch {
        setErrorMessage("ไม่สามารถเชื่อมต่อได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่");
        setStatus("error");
      }
    }

    verifyToken();
  }, [router]);

  // === Verifying state ===
  if (status === "verifying") {
    return (
      <AuthCard>
        <div className="flex flex-col items-center text-center gap-4 py-4">
          <Loader2
            size={40}
            className="text-[#3B5BDB] animate-spin"
            aria-label="กำลังตรวจสอบลิงก์"
          />
          <div>
            <h1 className="text-lg font-bold text-[#1F2933]">กำลังตรวจสอบ...</h1>
            <p className="mt-1 text-sm text-[#6B7280]">กรุณารอสักครู่</p>
          </div>
        </div>
      </AuthCard>
    );
  }

  // === Success state ===
  if (status === "success") {
    return (
      <AuthCard>
        <div className="flex flex-col items-center text-center gap-4 py-4">
          <div className="w-12 h-12 rounded-full bg-teal-50 flex items-center justify-center">
            <ShieldCheck size={28} className="text-[#0CA678]" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-[#1F2933]">เข้าสู่ระบบสำเร็จ!</h1>
            <p className="mt-1 text-sm text-[#6B7280]">กำลังพาคุณไปยังหน้าหลัก...</p>
          </div>
        </div>
      </AuthCard>
    );
  }

  // === Error state ===
  return (
    <AuthCard>
      <div className="flex flex-col items-center text-center gap-4 py-4">
        <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center">
          <ShieldX size={28} className="text-[#E03131]" aria-hidden="true" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-[#1F2933]">ลิงก์ไม่สามารถใช้งานได้</h1>
          {errorMessage && (
            <div className="mt-3 w-full text-left">
              <FormAlert variant="error" message={errorMessage} />
            </div>
          )}
        </div>
        <a
          href="/portal/login"
          className="w-full flex items-center justify-center rounded-lg px-4 py-2.5 text-sm font-semibold text-white bg-[#3B5BDB] hover:bg-[#2F4BC4] transition-colors focus:outline-none focus:ring-2 focus:ring-[#3B5BDB] focus:ring-offset-2"
        >
          ขอลิงก์ใหม่
        </a>
      </div>
    </AuthCard>
  );
}
