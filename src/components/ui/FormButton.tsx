"use client";

import { Loader2 } from "lucide-react";

interface FormButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  isLoading?: boolean;
  children: React.ReactNode;
}

// ปุ่ม primary สำหรับ form submit — รองรับ loading state
export default function FormButton({
  isLoading = false,
  children,
  disabled,
  className,
  ...rest
}: FormButtonProps) {
  const isDisabled = disabled || isLoading;

  return (
    <button
      type="submit"
      disabled={isDisabled}
      aria-disabled={isDisabled}
      className={[
        "w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5",
        "text-sm font-semibold text-white",
        "bg-primary-strong hover:bg-primary-strong-hover",
        "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
        "transition-colors",
        "disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:bg-primary-strong",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {isLoading && (
        <Loader2
          size={16}
          className="animate-spin"
          aria-hidden="true"
        />
      )}
      {children}
    </button>
  );
}
