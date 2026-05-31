"use client";

/**
 * หน้า Portal Login — ลูกค้าขอ magic-link (tenant subdomain)
 * เรียก POST /api/auth/portal/request-link
 * API คืน { sent: true } เสมอ (anti-enumeration) → แสดงข้อความ generic
 */

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Mail } from "lucide-react";
import AuthCard from "@/components/ui/AuthCard";
import FormInput from "@/components/ui/FormInput";
import FormButton from "@/components/ui/FormButton";
import FormAlert from "@/components/ui/FormAlert";

// =============================================================================
// VALIDATION SCHEMA
// =============================================================================

const requestLinkSchema = z.object({
  email: z.string().email("รูปแบบ email ไม่ถูกต้อง"),
});

type RequestLinkFormValues = z.infer<typeof requestLinkSchema>;

// =============================================================================
// COMPONENT
// =============================================================================

export default function PortalLoginPage() {
  // sent: true เมื่อ request ส่งแล้ว — แสดงข้อความ generic (anti-enumeration)
  const [isSent, setIsSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<RequestLinkFormValues>({
    resolver: zodResolver(requestLinkSchema),
  });

  async function handleRequestLink(values: RequestLinkFormValues) {
    setFormError(null);

    try {
      const res = await fetch("/api/auth/portal/request-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(values),
      });

      // API คืน 200 + { sent: true } เสมอ (anti-enumeration)
      // กรณี network error หรือ unexpected — แสดง generic sent message อยู่ดี
      if (res.ok) {
        setIsSent(true);
      } else {
        // กรณีผิดปกติ (เช่น 500) — แสดง error เบา ๆ ไม่เปิดเผยรายละเอียด
        setFormError("เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
      }
    } catch {
      setFormError("ไม่สามารถเชื่อมต่อได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่");
    }
  }

  // === Sent view — แสดงหลังจาก request ส่งแล้ว ===
  if (isSent) {
    return (
      <AuthCard>
        <div className="flex flex-col items-center text-center gap-4">
          <div className="w-12 h-12 rounded-full bg-teal-50 flex items-center justify-center">
            <Mail size={24} className="text-[#0CA678]" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-[#1F2933]">ตรวจสอบอีเมลของคุณ</h1>
            <p className="mt-2 text-sm text-[#6B7280]">
              ถ้าอีเมล{" "}
              <span className="font-medium text-[#1F2933]">{getValues("email")}</span>{" "}
              มีในระบบ เราได้ส่งลิงก์เข้าสู่ระบบไปแล้ว กรุณาตรวจอีเมล
            </p>
            <p className="mt-2 text-xs text-[#6B7280]">
              ลิงก์มีอายุ 15 นาที และใช้ได้ครั้งเดียวเท่านั้น
            </p>
          </div>

          {/* ส่งใหม่ — กลับไปฟอร์มเดิม */}
          <button
            type="button"
            onClick={() => setIsSent(false)}
            className="text-sm text-[#3B5BDB] hover:underline font-medium focus:outline-none focus:underline"
          >
            ไม่ได้รับอีเมล? ส่งลิงก์ใหม่
          </button>
        </div>
      </AuthCard>
    );
  }

  // === Form view ===
  return (
    <AuthCard>
      {/* Header */}
      <div className="flex flex-col items-center mb-6">
        <div className="w-10 h-10 rounded-xl bg-[#3B5BDB] flex items-center justify-center mb-3">
          <Mail size={20} className="text-white" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold text-[#1F2933]">เข้าสู่ระบบ</h1>
        <p className="mt-1 text-sm text-[#6B7280] text-center">
          กรอกอีเมลของคุณ เราจะส่งลิงก์เข้าสู่ระบบให้
        </p>
      </div>

      {/* Form-level error */}
      {formError && <FormAlert variant="error" message={formError} />}

      <form
        onSubmit={handleSubmit(handleRequestLink)}
        noValidate
        className="mt-4 flex flex-col gap-4"
      >
        <FormInput
          id="email"
          label="อีเมล"
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          error={errors.email?.message}
          {...register("email")}
        />

        <FormButton isLoading={isSubmitting}>
          {isSubmitting ? "กำลังส่งลิงก์..." : "ส่งลิงก์เข้าสู่ระบบ"}
        </FormButton>
      </form>

      <p className="mt-4 text-center text-xs text-[#6B7280]">
        ต้องการความช่วยเหลือ?{" "}
        <a href="mailto:support@helpwise.com" className="text-[#3B5BDB] hover:underline font-medium">
          ติดต่อทีม support
        </a>
      </p>
    </AuthCard>
  );
}
