"use client";

/**
 * หน้า Agent Login — login สำหรับพนักงาน support (tenant subdomain)
 * เรียก POST /api/auth/agent/login; cookie ถูก set โดย server
 * สำเร็จ → redirect ไป "/" (dashboard — Phase ถัดไป)
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Headphones } from "lucide-react";
import AuthCard from "@/components/ui/AuthCard";
import FormInput from "@/components/ui/FormInput";
import FormButton from "@/components/ui/FormButton";
import FormAlert from "@/components/ui/FormAlert";

// =============================================================================
// VALIDATION SCHEMA
// =============================================================================

const loginSchema = z.object({
  email: z.string().email("รูปแบบ email ไม่ถูกต้อง"),
  password: z.string().min(1, "กรุณากรอกรหัสผ่าน"),
});

type LoginFormValues = z.infer<typeof loginSchema>;

// =============================================================================
// TYPES
// =============================================================================

interface ApiResponse {
  data: {
    user: { id: string; email: string; name: string | null };
    role: string;
  } | null;
  error: { code: string; message: string } | null;
}

// =============================================================================
// COMPONENT
// =============================================================================

export default function AgentLoginPage() {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
  });

  async function handleLogin(values: LoginFormValues) {
    setFormError(null);

    try {
      const res = await fetch("/api/auth/agent/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // credentials: "include" สำหรับ same-origin cookie (subdomain ถือว่า same-site)
        credentials: "include",
        body: JSON.stringify(values),
      });

      const json = (await res.json()) as ApiResponse;

      if (!res.ok || json.error) {
        // backend คืน generic error เสมอสำหรับ login fail
        setFormError(json.error?.message ?? "อีเมลหรือรหัสผ่านไม่ถูกต้อง");
        return;
      }

      // cookie ถูก set โดย server แล้ว — redirect ไป dashboard
      // TODO Phase (Dashboard): เปลี่ยน "/" เป็น "/dashboard" เมื่อสร้างหน้า dashboard แล้ว
      router.push("/");
    } catch {
      setFormError("ไม่สามารถเชื่อมต่อได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่");
    }
  }

  return (
    <AuthCard>
      {/* Header */}
      <div className="flex flex-col items-center mb-6">
        <div className="w-10 h-10 rounded-xl bg-[#3B5BDB] flex items-center justify-center mb-3">
          <Headphones size={20} className="text-white" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold text-[#1F2933]">เข้าสู่ระบบ</h1>
        <p className="mt-1 text-sm text-[#6B7280] text-center">
          สำหรับทีม support — กรุณา login ด้วยบัญชีของคุณ
        </p>
      </div>

      {/* Form-level error */}
      {formError && <FormAlert variant="error" message={formError} />}

      <form
        onSubmit={handleSubmit(handleLogin)}
        noValidate
        className="mt-4 flex flex-col gap-4"
      >
        <FormInput
          id="email"
          label="อีเมล"
          type="email"
          placeholder="you@company.com"
          autoComplete="email"
          error={errors.email?.message}
          {...register("email")}
        />

        <FormInput
          id="password"
          label="รหัสผ่าน"
          type="password"
          placeholder="รหัสผ่านของคุณ"
          autoComplete="current-password"
          error={errors.password?.message}
          {...register("password")}
        />

        <FormButton isLoading={isSubmitting}>
          {isSubmitting ? "กำลังเข้าสู่ระบบ..." : "เข้าสู่ระบบ"}
        </FormButton>
      </form>

      <p className="mt-4 text-center text-xs text-[#6B7280]">
        ยังไม่มี workspace?{" "}
        <a
          href={`https://${process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "helpwise.com"}/signup`}
          className="text-[#3B5BDB] hover:underline font-medium"
        >
          สมัครใช้งาน
        </a>
      </p>
    </AuthCard>
  );
}
