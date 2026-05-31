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
        className="text-sm font-medium text-[#1F2933]"
      >
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        aria-describedby={error ? `${id}-error` : undefined}
        aria-invalid={error ? true : undefined}
        className={[
          "w-full rounded-lg border px-3 py-2 text-sm text-[#1F2933]",
          "placeholder:text-[#6B7280]",
          "focus:outline-none focus:ring-2 focus:ring-[#3B5BDB] focus:border-transparent",
          "transition-colors",
          error
            ? "border-[#E03131] bg-red-50"
            : "border-[#E4E7EB] bg-white hover:border-[#3B5BDB]",
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
          className="text-xs text-[#E03131] mt-0.5"
        >
          {error}
        </p>
      )}
    </div>
  );
});

FormInput.displayName = "FormInput";

export default FormInput;
