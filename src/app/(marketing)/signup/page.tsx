"use client";

/**
 * หน้า Signup — สมัคร Tenant ใหม่ (root domain)
 * เรียก POST /api/auth/signup แล้ว redirect ไป {slug}.{ROOT_DOMAIN}/login
 * ไม่ auto-login เพราะ session cookie คนละ domain (root vs subdomain)
 */

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Building2 } from "lucide-react";
import AuthCard from "@/components/ui/AuthCard";
import FormInput from "@/components/ui/FormInput";
import FormButton from "@/components/ui/FormButton";
import FormAlert from "@/components/ui/FormAlert";
import { SLUG_REGEX } from "@/lib/slug";

// =============================================================================
// VALIDATION SCHEMA — ต้องสอดคล้องกับ backend signupSchema
// =============================================================================

const signupSchema = z.object({
  companyName: z.string().min(1, "ชื่อบริษัทห้ามว่าง").max(100, "ชื่อบริษัทยาวเกิน 100 ตัวอักษร"),
  slug: z
    .string()
    .min(3, "slug ต้องมีอย่างน้อย 3 ตัวอักษร")
    .max(50, "slug ยาวเกิน 50 ตัวอักษร")
    .regex(SLUG_REGEX, "slug ใช้ได้เฉพาะตัวเล็ก, ตัวเลข, และ hyphen (-)"),
  name: z.string().min(1, "ชื่อของคุณห้ามว่าง").max(100, "ชื่อยาวเกิน 100 ตัวอักษร"),
  email: z.string().email("รูปแบบ email ไม่ถูกต้อง"),
  password: z
    .string()
    .min(8, "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร")
    .max(128, "รหัสผ่านยาวเกินไป"),
});

type SignupFormValues = z.infer<typeof signupSchema>;

// =============================================================================
// TYPES
// =============================================================================

interface SignupSuccessState {
  slug: string;
  rootDomain: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

export default function SignupPage() {
  // state สำหรับ error ระดับ form (จาก API) และ success state
  const [formError, setFormError] = useState<string | null>(null);
  const [successState, setSuccessState] = useState<SignupSuccessState | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupFormValues>({
    resolver: zodResolver(signupSchema),
  });

  async function handleSignup(values: SignupFormValues) {
    setFormError(null);

    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      const json = (await res.json()) as {
        data: { slug: string } | null;
        error: { code: string; message: string } | null;
      };

      if (!res.ok || json.error) {
        setFormError(json.error?.message ?? "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง");
        return;
      }

      if (json.data?.slug) {
        // สมัครสำเร็จ — แสดง workspace URL ให้ user ไป login
        // ไม่ auto-redirect เพราะ cookie คนละ domain
        const rootDomain =
          process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "gethelpwise.xyz";
        setSuccessState({ slug: json.data.slug, rootDomain });
      }
    } catch {
      // network error
      setFormError("ไม่สามารถเชื่อมต่อได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่");
    }
  }

  // === Success view ===
  if (successState) {
    const workspaceUrl = `https://${successState.slug}.${successState.rootDomain}/login`;
    return (
      <AuthCard>
        <div className="flex flex-col items-center text-center gap-4">
          <div className="w-12 h-12 rounded-full bg-success-tint flex items-center justify-center">
            <Building2 size={24} className="text-success" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">สมัครสำเร็จแล้ว!</h1>
            <p className="mt-2 text-sm text-secondary">
              Workspace ของคุณพร้อมใช้งานแล้ว กรุณาไป login ที่ workspace ของคุณ
            </p>
          </div>
          <a
            href={workspaceUrl}
            className="w-full flex items-center justify-center rounded-lg px-4 py-2.5 text-sm font-semibold text-white bg-primary-strong hover:bg-primary-strong-hover transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
          >
            ไปยัง {successState.slug}.{successState.rootDomain}
          </a>
          <p className="text-xs text-secondary break-all">
            {workspaceUrl}
          </p>
        </div>
      </AuthCard>
    );
  }

  // === Form view ===
  return (
    <AuthCard>
      {/* Header */}
      <div className="flex flex-col items-center mb-6">
        <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center mb-3">
          <Building2 size={20} className="text-white" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold text-foreground">เริ่มใช้งาน Helpwise</h1>
        <p className="mt-1 text-sm text-secondary text-center">
          สร้าง workspace ของบริษัทคุณ ใช้งานฟรีทันที
        </p>
      </div>

      {/* Form error (API level) */}
      {formError && <FormAlert variant="error" message={formError} />}

      <form
        onSubmit={handleSubmit(handleSignup)}
        noValidate
        className="mt-4 flex flex-col gap-4"
      >
        {/* Company Name */}
        <FormInput
          id="companyName"
          label="ชื่อบริษัท"
          type="text"
          placeholder="เช่น บริษัท ABC จำกัด"
          autoComplete="organization"
          error={errors.companyName?.message}
          {...register("companyName")}
        />

        {/* Workspace slug */}
        <div className="flex flex-col gap-1">
          <label htmlFor="slug" className="text-sm font-medium text-foreground">
            Workspace URL
          </label>
          <div className="flex items-center rounded-lg border border-border bg-surface overflow-hidden focus-within:ring-2 focus-within:ring-primary focus-within:border-transparent hover:border-primary transition-colors">
            {/* prefix — aria-hidden เพราะ input id ระบุ label ชัดอยู่แล้ว */}
            <span
              className="px-3 py-2 bg-stone text-sm text-secondary border-r border-border select-none whitespace-nowrap"
              aria-hidden="true"
            >
              https://
            </span>
            <input
              id="slug"
              type="text"
              placeholder="your-company"
              autoComplete="off"
              aria-describedby={errors.slug ? "slug-error" : "slug-hint"}
              aria-invalid={errors.slug ? true : undefined}
              className="flex-1 px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none bg-transparent"
              {...register("slug")}
            />
            <span
              className="px-3 py-2 bg-stone text-sm text-secondary border-l border-border select-none whitespace-nowrap"
              aria-hidden="true"
            >
              .gethelpwise.xyz
            </span>
          </div>
          {errors.slug ? (
            <p id="slug-error" role="alert" className="text-xs text-danger mt-0.5">
              {errors.slug.message}
            </p>
          ) : (
            <p id="slug-hint" className="text-xs text-secondary mt-0.5">
              ใช้ได้เฉพาะตัวอักษรพิมพ์เล็ก, ตัวเลข, และ hyphen
            </p>
          )}
        </div>

        {/* Name */}
        <FormInput
          id="name"
          label="ชื่อของคุณ"
          type="text"
          placeholder="เช่น สมชาย ใจดี"
          autoComplete="name"
          error={errors.name?.message}
          {...register("name")}
        />

        {/* Email */}
        <FormInput
          id="email"
          label="อีเมล"
          type="email"
          placeholder="you@company.com"
          autoComplete="email"
          error={errors.email?.message}
          {...register("email")}
        />

        {/* Password */}
        <FormInput
          id="password"
          label="รหัสผ่าน"
          type="password"
          placeholder="อย่างน้อย 8 ตัวอักษร"
          autoComplete="new-password"
          error={errors.password?.message}
          {...register("password")}
        />

        <FormButton isLoading={isSubmitting}>
          {isSubmitting ? "กำลังสร้าง workspace..." : "สร้าง Workspace"}
        </FormButton>
      </form>

      <p className="mt-4 text-center text-xs text-secondary">
        มี workspace อยู่แล้ว?{" "}
        <a href="/signin" className="text-primary-ink hover:underline font-medium">
          เข้าสู่ระบบ
        </a>
      </p>
    </AuthCard>
  );
}
