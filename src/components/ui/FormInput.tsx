"use client";

import { forwardRef } from "react";

// ประเภทของ props สำหรับ input field ที่รองรับ label + error
interface FormInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  id: string;
}

// ใช้ forwardRef เพื่อให้ React Hook Form register ใช้ ref ได้
const FormInput = forwardRef<HTMLInputElement, FormInputProps>(function FormInput(
  { label, error, id, className, ...rest },
  ref
) {
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={id}
        className="text-sm font-medium text-foreground"
      >
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        aria-describedby={error ? `${id}-error` : undefined}
        aria-invalid={error ? true : undefined}
        className={[
          "w-full rounded-lg border px-3 py-2 text-sm text-foreground",
          "placeholder:text-muted",
          "focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent",
          "transition-colors",
          error
            ? "border-danger bg-danger-tint"
            : "border-border bg-surface hover:border-primary",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        {...rest}
      />
      {error && (
        <p
          id={`${id}-error`}
          role="alert"
          className="text-xs text-danger mt-0.5"
        >
          {error}
        </p>
      )}
    </div>
  );
});

FormInput.displayName = "FormInput";

export default FormInput;
