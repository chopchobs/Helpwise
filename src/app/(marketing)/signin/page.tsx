"use client";

/**
 * หน้า Sign in — workspace picker (root domain)
 * root domain ไม่มี tenant context จึง login ตรงไม่ได้
 * ให้ user กรอก slug ของ workspace แล้วพาไป {slug}.{ROOT_DOMAIN}/login
 * ไม่เรียก API — แค่ validate slug แล้ว full navigation ข้าม subdomain
 */

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { LogIn } from "lucide-react";
import AuthCard from "@/components/ui/AuthCard";
import FormButton from "@/components/ui/FormButton";
import FormAlert from "@/components/ui/FormAlert";
import { SLUG_REGEX, buildTenantLoginUrl } from "@/lib/slug";

// =============================================================================
// VALIDATION SCHEMA — slug rule ตรงกับ signup (กัน path-traversal/injection)
// =============================================================================

const signinSchema = z.object({
  slug: z
    .string()
    .min(3, "slug ต้องมีอย่างน้อย 3 ตัวอักษร")
    .max(50, "slug ยาวเกิน 50 ตัวอักษร")
    .regex(SLUG_REGEX, "slug ใช้ได้เฉพาะตัวเล็ก, ตัวเลข, และ hyphen (-)"),
});

type SigninFormValues = z.infer<typeof signinSchema>;

// =============================================================================
// COMPONENT
// =============================================================================

export default function SigninPage() {
  // error ระดับ form (เผื่อ redirect ล้มเหลว)
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SigninFormValues>({
    resolver: zodResolver(signinSchema),
  });

  function handleSignin(values: SigninFormValues) {
    setFormError(null);

    try {
      // ประกอบ URL ของ tenant login แล้ว full navigation
      // (ข้าม subdomain — ใช้ window.location ไม่ใช่ router)
      // buildTenantLoginUrl validate slug อีกชั้น (defensive) — null = format ผิด กัน open-redirect
      const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "helpwise.com";
      const loginUrl = buildTenantLoginUrl(values.slug, rootDomain);
      if (!loginUrl) {
        setFormError("slug ไม่ถูกต้อง ไม่สามารถพาไป workspace ได้");
        return;
      }
      window.location.assign(loginUrl);
    } catch {
      setFormError("ไม่สามารถพาไป workspace ได้ กรุณาลองใหม่อีกครั้ง");
    }
  }

  return (
    <AuthCard>
      {/* Header */}
      <div className="flex flex-col items-center mb-6">
        <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center mb-3">
          <LogIn size={20} className="text-white" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold text-foreground">เข้าสู่ระบบ Helpwise</h1>
        <p className="mt-1 text-sm text-secondary text-center">
          กรอก workspace URL ของบริษัทคุณเพื่อเข้าสู่ระบบ
        </p>
      </div>

      {/* Form error */}
      {formError && <FormAlert variant="error" message={formError} />}

      <form
        onSubmit={handleSubmit(handleSignin)}
        noValidate
        className="mt-4 flex flex-col gap-4"
      >
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
              .helpwise.com
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

        <FormButton isLoading={isSubmitting}>
          {isSubmitting ? "กำลังพาไป workspace..." : "ไปยัง Workspace"}
        </FormButton>
      </form>

      <p className="mt-4 text-center text-xs text-secondary">
        ยังไม่มี workspace?{" "}
        <a href="/signup" className="text-primary-ink hover:underline font-medium">
          สร้าง workspace ใหม่
        </a>
      </p>
    </AuthCard>
  );
}
