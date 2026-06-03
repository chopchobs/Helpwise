"use client";

type AlertVariant = "error" | "success" | "info";

interface FormAlertProps {
  variant: AlertVariant;
  message: string;
}

// แสดง alert แบบ form-level (ไม่ใช่ field-level)
export default function FormAlert({ variant, message }: FormAlertProps) {
  const styles: Record<AlertVariant, string> = {
    error:   "bg-danger-tint border-danger text-danger",
    success: "bg-success-tint border-success text-success",
    info:    "bg-primary-tint border-primary text-primary-ink",
  };

  return (
    <div
      role="alert"
      aria-live="polite"
      className={`rounded-lg border px-4 py-3 text-sm font-medium ${styles[variant]}`}
    >
      {message}
    </div>
  );
}
