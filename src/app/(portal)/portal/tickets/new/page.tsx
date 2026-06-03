"use client";

/**
 * หน้า New Ticket (portal) — form สร้าง ticket ใหม่สำหรับลูกค้า
 * POST /api/portal/tickets → redirect ไป /portal/tickets/:id
 *
 * หน้านี้ไม่มีโค้ดใดๆ ที่เกี่ยวกับ visibility / INTERNAL / internal note เลย
 * body ที่ส่งเป็น PUBLIC เสมอ — backend บังคับที่ฝั่ง server
 */

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowLeft } from "lucide-react";
import AuthCard from "@/components/ui/AuthCard";
import FormInput from "@/components/ui/FormInput";
import FormButton from "@/components/ui/FormButton";
import FormAlert from "@/components/ui/FormAlert";
import { useState } from "react";
import type { PortalCreateTicketResponse } from "@/types/ticket";

// =============================================================================
// VALIDATION SCHEMA
// =============================================================================

// sync กับ backend: subject min(3).max(200), body min(1) — ไม่บังคับ min 10 เพื่อไม่ให้ frontend เข้มกว่า backend
const newTicketSchema = z.object({
  subject: z
    .string()
    .min(3, "หัวข้อต้องมีอย่างน้อย 3 ตัวอักษร")
    .max(200, "หัวข้อยาวเกินไป"),
  body: z
    .string()
    .min(1, "กรุณากรอกรายละเอียด")
    .max(5000, "ข้อความยาวเกินไป"),
});

type NewTicketFormValues = z.infer<typeof newTicketSchema>;

// =============================================================================
// COMPONENT
// =============================================================================

export default function PortalNewTicketPage() {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<NewTicketFormValues>({
    resolver: zodResolver(newTicketSchema),
  });

  async function handleCreate(values: NewTicketFormValues) {
    setFormError(null);

    try {
      const res = await fetch("/api/portal/tickets", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        // ส่งเฉพาะ subject + firstMessage.body — visibility ไม่ส่ง (backend บังคับ PUBLIC)
        body: JSON.stringify({
          subject: values.subject,
          firstMessage: { body: values.body },
        }),
      });

      const json = (await res.json()) as PortalCreateTicketResponse;

      if (!res.ok || json.error) {
        if (res.status === 401) {
          setFormError("กรุณา login ก่อนใช้งาน");
        } else {
          setFormError(json.error?.message ?? "สร้างคำขอไม่สำเร็จ กรุณาลองใหม่");
        }
        return;
      }

      if (json.data) {
        // redirect ไปหน้า detail หลังสร้างสำเร็จ
        router.push(`/portal/tickets/${json.data.id}`);
      }
    } catch {
      setFormError("ไม่สามารถเชื่อมต่อได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่");
    }
  }

  return (
    // centering page — layout ของ route group เป็น plain wrapper แล้ว
    <div className="flex min-h-screen items-start justify-center px-4 py-12">
    <div className="w-full max-w-lg">
      {/* Back button */}
      <button
        type="button"
        onClick={() => router.push("/portal/tickets")}
        className="inline-flex items-center gap-2 text-sm text-secondary hover:text-foreground mb-5 transition-colors focus:outline-none focus:underline"
      >
        <ArrowLeft size={16} aria-hidden="true" />
        กลับไปรายการ
      </button>

      <AuthCard>
        <div className="mb-6">
          <h1 className="text-xl font-bold text-foreground">แจ้งปัญหาใหม่</h1>
          <p className="mt-1 text-sm text-secondary">
            อธิบายปัญหาที่พบ — ทีม support จะตอบกลับโดยเร็ว
          </p>
        </div>

        {formError && (
          <div className="mb-4">
            <FormAlert variant="error" message={formError} />
          </div>
        )}

        <form
          onSubmit={handleSubmit(handleCreate)}
          noValidate
          className="flex flex-col gap-4"
        >
          <FormInput
            id="subject"
            label="หัวข้อ"
            type="text"
            placeholder="เช่น ไม่สามารถเข้าสู่ระบบได้"
            autoComplete="off"
            error={errors.subject?.message}
            {...register("subject")}
          />

          <div className="flex flex-col gap-1">
            <label
              htmlFor="body"
              className="text-sm font-medium text-foreground"
            >
              รายละเอียด
            </label>
            <textarea
              id="body"
              rows={5}
              placeholder="อธิบายปัญหาที่พบให้ละเอียด เช่น เกิดขึ้นเมื่อไหร่ ข้อความแจ้งเตือนที่เห็น..."
              aria-describedby={errors.body ? "body-error" : undefined}
              aria-invalid={errors.body ? true : undefined}
              className={[
                "w-full rounded-lg border px-3 py-2 text-sm text-foreground resize-none",
                "placeholder:text-muted",
                "focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent",
                "transition-colors",
                errors.body
                  ? "border-danger bg-danger-tint"
                  : "border-border bg-surface hover:border-primary",
              ].join(" ")}
              {...register("body")}
            />
            {errors.body && (
              <p
                id="body-error"
                role="alert"
                className="text-xs text-danger mt-0.5"
              >
                {errors.body.message}
              </p>
            )}
          </div>

          <FormButton isLoading={isSubmitting}>
            {isSubmitting ? "กำลังส่งคำขอ..." : "ส่งคำขอ"}
          </FormButton>
        </form>
      </AuthCard>
    </div>
    </div>
  );
}
