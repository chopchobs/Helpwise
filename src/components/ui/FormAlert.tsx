"use client";

type AlertVariant = "error" | "success" | "info";

interface FormAlertProps {
  variant: AlertVariant;
  message: string;
}

// แสดง alert แบบ form-level (ไม่ใช่ field-level)
export default function FormAlert({ variant, message }: FormAlertProps) {
  const styles: Record<AlertVariant, string> = {
    error: "bg-red-50 border-[#E03131] text-[#E03131]",
    success: "bg-teal-50 border-[#0CA678] text-[#0CA678]",
    info: "bg-blue-50 border-[#3B5BDB] text-[#3B5BDB]",
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
