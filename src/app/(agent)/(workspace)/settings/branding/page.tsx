"use client";

/**
 * หน้า Branding Settings (agent — OWNER/ADMIN เท่านั้น)
 * แก้ไข logoUrl + accentColor ของ tenant สำหรับ portal ลูกค้า
 * ถ้า feature FEATURE_LOCKED → แสดง upsell state
 * ถ้า role อื่น 403 → แสดง forbidden state
 */

import { useState, useEffect, useCallback, useId } from "react";
import {
  Palette,
  ShieldAlert,
  Lock,
  RefreshCw,
  ExternalLink,
  X,
} from "lucide-react";
import Link from "next/link";
import FormAlert from "@/components/ui/FormAlert";

// =============================================================================
// TYPES
// =============================================================================

interface BrandingData {
  logoUrl: string | null;
  accentColor: string | null;
  brandingEnabled: boolean;
}

interface BrandingResponse {
  data: BrandingData | null;
  error: { code: string; message: string } | null;
}

interface PatchBrandingResponse {
  data: { logoUrl: string | null; accentColor: string | null } | null;
  error: { code: string; message: string } | null;
}

/** ค่าใน form ที่ user กำลังแก้ไข */
interface FormValues {
  logoUrl: string;
  accentColor: string;
}

/** validation errors ต่อ field */
interface FieldErrors {
  logoUrl: string | null;
  accentColor: string | null;
}

// =============================================================================
// VALIDATORS — client-side, ต้องตรงกับ backend (source of truth อยู่ที่ backend)
// =============================================================================

/** validate logoUrl ฝั่ง client — เช็ค https:// prefix */
function clientValidateLogoUrl(value: string): string | null {
  if (!value) return null; // ค่าว่าง = ไม่ส่ง (ไม่ error)
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") {
      return "URL ต้องเริ่มต้นด้วย https:// เท่านั้น";
    }
    if (value.length > 2048) {
      return "URL ยาวเกิน 2048 ตัวอักษร";
    }
    return null;
  } catch {
    return "URL ไม่ถูกต้อง — ต้องเป็น URL เต็มรูปแบบ (เช่น https://example.com/logo.png)";
  }
}

/** validate accentColor ฝั่ง client — เช็ค #RRGGBB format */
function clientValidateAccentColor(value: string): string | null {
  if (!value) return null; // ค่าว่าง = ไม่ส่ง (ไม่ error)
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    return "สีต้องเป็น hex 6 หลัก เช่น #C4652A";
  }
  return null;
}

// =============================================================================
// LOADING SKELETON
// =============================================================================

function BrandingSkeleton() {
  return (
    <div className="animate-pulse flex flex-col gap-4" aria-busy="true" aria-label="กำลังโหลด...">
      <div className="h-10 bg-stone rounded-xl w-2/3" />
      <div className="h-48 bg-stone rounded-xl" />
      <div className="h-48 bg-stone rounded-xl" />
      <div className="h-10 bg-stone rounded-lg w-32" />
    </div>
  );
}

// =============================================================================
// FEATURE LOCKED STATE — upsell
// =============================================================================

function FeatureLockedState() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="bg-surface rounded-xl border border-border p-8 max-w-sm w-full text-center flex flex-col items-center gap-4">
        <div className="w-12 h-12 rounded-full bg-warning-tint flex items-center justify-center">
          <Lock size={24} className="text-warning-ink" aria-hidden="true" />
        </div>
        <div>
          <h2 className="text-base font-bold text-foreground">Custom Branding ไม่รวมใน Plan ปัจจุบัน</h2>
          <p className="text-sm text-secondary mt-2">
            ฟีเจอร์นี้ต้องใช้ plan ที่สูงกว่า อัปเกรดเพื่อตั้งค่า logo และสีของ portal ลูกค้าให้ตรงกับแบรนด์ของคุณ
          </p>
        </div>
        <Link
          href="/settings/billing"
          className={[
            "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white transition-colors",
            "bg-primary-strong hover:bg-primary-strong-hover",
            "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
          ].join(" ")}
        >
          <ExternalLink size={14} aria-hidden="true" />
          ดู Plan และอัปเกรด
        </Link>
      </div>
    </div>
  );
}

// =============================================================================
// LOGO FIELD — text input + live preview + clear button
// =============================================================================

interface LogoFieldProps {
  id: string;
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
  error: string | null;
  disabled: boolean;
}

function LogoField({ id, value, onChange, onClear, error, disabled }: LogoFieldProps) {
  // สถานะ image โหลดไม่ได้ — ใช้ onError handler กัน broken image
  const [imgError, setImgError] = useState(false);
  // เก็บค่า value ที่เคยเช็คล่าสุด เพื่อ reset imgError เมื่อ value เปลี่ยน
  // (adjust state during render แทน useEffect — หลีกเลี่ยง cascading render)
  const [lastCheckedValue, setLastCheckedValue] = useState(value);
  if (value !== lastCheckedValue) {
    setLastCheckedValue(value);
    setImgError(false);
  }

  const hasValue = value.trim().length > 0;
  // แสดง preview เฉพาะเมื่อมีค่า, ไม่มี validation error, และ image ยังโหลดได้
  const showPreview = hasValue && error === null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          Logo URL
        </label>
        {/* ปุ่ม Clear — แสดงเมื่อมีค่า */}
        {hasValue && (
          <button
            type="button"
            onClick={onClear}
            disabled={disabled}
            aria-label="ลบ Logo URL"
            className={[
              "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs text-secondary hover:text-danger hover:bg-danger-tint transition-colors",
              "focus:outline-none focus:ring-2 focus:ring-danger focus:ring-offset-1",
              "disabled:opacity-50 disabled:cursor-not-allowed",
            ].join(" ")}
          >
            <X size={12} aria-hidden="true" />
            ลบ logo
          </button>
        )}
      </div>

      <input
        id={id}
        type="url"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="https://example.com/logo.png"
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
        aria-invalid={error !== null}
        className={[
          "w-full px-3 py-2 rounded-lg border bg-background text-foreground text-sm",
          "focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary",
          "disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-muted",
          error ? "border-danger" : "border-border",
        ].join(" ")}
      />

      <p id={`${id}-hint`} className="text-xs text-muted">
        ต้องเป็น https:// เท่านั้น — แสดงในหน้า portal ของลูกค้า
      </p>

      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-danger font-medium">
          {error}
        </p>
      )}

      {/* Live preview — graceful broken-image fallback ผ่าน onError */}
      {showPreview && (
        <div className="mt-1 p-3 rounded-lg bg-stone border border-border flex items-center gap-3">
          <span className="text-xs text-muted shrink-0">ตัวอย่าง:</span>
          {imgError ? (
            <span className="text-xs text-danger">โหลดรูปไม่ได้ — ตรวจสอบ URL อีกครั้ง</span>
          ) : (
            /*
             * ใช้ <img> ตรง ๆ ไม่ผ่าน next/image — project convention (SSRF via optimizer)
             * referrerPolicy="no-referrer" — defense-in-depth กัน URL รั่ว
             */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={value}
              alt="Logo preview"
              referrerPolicy="no-referrer"
              onError={() => setImgError(true)}
              className="h-8 w-auto max-w-[120px] object-contain rounded"
            />
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// COLOR FIELD — color picker + hex input + live swatch + sample button
// =============================================================================

interface ColorFieldProps {
  pickerId: string;
  hexId: string;
  value: string;
  onChange: (v: string) => void;
  onClear: () => void;
  error: string | null;
  disabled: boolean;
}

function ColorField({
  pickerId,
  hexId,
  value,
  onChange,
  onClear,
  error,
  disabled,
}: ColorFieldProps) {
  const hasValue = value.trim().length > 0;
  // hex valid = ผ่าน regex (สำหรับแสดง swatch/button preview)
  const isValidHex = /^#[0-9a-fA-F]{6}$/.test(value);

  // จำค่า hex ล่าสุดที่ valid — กัน color picker กระโดดไปสี fallback ตอน user พิมพ์ค้างกลางคัน
  // (#000000 = neutral default ตอนยังไม่เคยมีค่า ไม่ใช่ brand token จาก design system)
  // adjust state during render แทน useEffect — หลีกเลี่ยง cascading render
  const [lastValidHex, setLastValidHex] = useState("#000000");
  if (isValidHex && value !== lastValidHex) {
    setLastValidHex(value);
  }

  // sync จาก color picker → hex text input
  function handlePickerChange(e: React.ChangeEvent<HTMLInputElement>) {
    onChange(e.target.value.toUpperCase());
  }

  // sync จาก hex text input → color picker (เฉพาะเมื่อ valid)
  function handleHexChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    // ถ้า user พิมพ์โดยไม่มี # นำหน้าให้เติมให้
    if (raw && !raw.startsWith("#")) {
      onChange(`#${raw}`);
    } else {
      onChange(raw);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-foreground">Accent Color</p>
        {/* ปุ่ม Clear */}
        {hasValue && (
          <button
            type="button"
            onClick={onClear}
            disabled={disabled}
            aria-label="ลบ Accent Color"
            className={[
              "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs text-secondary hover:text-danger hover:bg-danger-tint transition-colors",
              "focus:outline-none focus:ring-2 focus:ring-danger focus:ring-offset-1",
              "disabled:opacity-50 disabled:cursor-not-allowed",
            ].join(" ")}
          >
            <X size={12} aria-hidden="true" />
            ลบสี
          </button>
        )}
      </div>

      <div className="flex items-center gap-3">
        {/* Color picker — label ผูกกับ picker input */}
        <label htmlFor={pickerId} className="sr-only">
          เลือก Accent Color
        </label>
        <input
          id={pickerId}
          type="color"
          value={isValidHex ? value : lastValidHex}
          onChange={handlePickerChange}
          disabled={disabled}
          aria-label="เลือกสีจาก color picker"
          className={[
            "w-10 h-10 rounded-lg border border-border cursor-pointer p-0.5 bg-surface",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "focus:outline-none focus:ring-2 focus:ring-primary",
          ].join(" ")}
        />

        {/* Hex text input */}
        <div className="flex flex-col gap-1 flex-1">
          <label htmlFor={hexId} className="sr-only">
            Hex Color Code
          </label>
          <input
            id={hexId}
            type="text"
            value={value}
            onChange={handleHexChange}
            disabled={disabled}
            placeholder="#C4652A"
            maxLength={7}
            aria-describedby={`${hexId}-hint${error ? ` ${hexId}-error` : ""}`}
            aria-invalid={error !== null}
            className={[
              "w-full px-3 py-2 rounded-lg border bg-background text-foreground text-sm font-mono",
              "focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary",
              "disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-muted",
              error ? "border-danger" : "border-border",
            ].join(" ")}
          />
        </div>
      </div>

      <p id={`${hexId}-hint`} className="text-xs text-muted">
        ต้องเป็น hex 6 หลัก เช่น #C4652A — ใช้เป็นสี CTA ใน portal ลูกค้า
      </p>

      {error && (
        <p id={`${hexId}-error`} role="alert" className="text-xs text-danger font-medium">
          {error}
        </p>
      )}

      {/* Live preview — swatch + sample button ด้วยสีที่เลือก */}
      {isValidHex && (
        <div className="mt-1 flex items-center gap-3 p-3 rounded-lg bg-stone border border-border">
          <span className="text-xs text-muted shrink-0">ตัวอย่าง:</span>
          {/* swatch — dynamic background color จาก accentColor ที่ validated แล้ว */}
          <div
            className="w-6 h-6 rounded-md border border-border shrink-0"
            style={{ backgroundColor: value }}
            aria-label={`สีที่เลือก: ${value}`}
          />
          {/* sample button — แสดงผล button จริงด้วยสี tenant */}
          <button
            type="button"
            disabled
            style={{ backgroundColor: value }}
            className="inline-flex items-center px-3 py-1 rounded-lg text-xs font-semibold text-white opacity-100 cursor-default"
            aria-hidden="true"
            tabIndex={-1}
          >
            ตัวอย่างปุ่ม
          </button>
          <span className="text-xs text-muted font-mono">{value}</span>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function BrandingSettingsPage() {
  const logoFieldId = useId();
  const colorPickerId = useId();
  const colorHexId = useId();

  // ─── data state ────────────────────────────────────────────────────────────
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isForbidden, setIsForbidden] = useState(false);
  const [isFeatureLocked, setIsFeatureLocked] = useState(false);

  // ─── form state ────────────────────────────────────────────────────────────
  const [formValues, setFormValues] = useState<FormValues>({
    logoUrl: "",
    accentColor: "",
  });
  // ค่าที่ server เก็บล่าสุด — ใช้เทียบหา field ที่ user แก้จริง (dirty-tracking)
  // กันบั๊ก: แก้สีอย่างเดียวแต่ส่ง logoUrl: null ไปด้วย → logo ถูกล้างเงียบ ๆ
  const [savedValues, setSavedValues] = useState<FormValues>({
    logoUrl: "",
    accentColor: "",
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({
    logoUrl: null,
    accentColor: null,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  // ─── fetch ─────────────────────────────────────────────────────────────────

  const fetchBranding = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    setIsForbidden(false);
    setIsFeatureLocked(false);

    try {
      const res = await fetch("/api/branding", { credentials: "include" });

      if (res.status === 403) {
        const json = (await res.json()) as BrandingResponse;
        const code = json.error?.code;
        if (code === "FEATURE_LOCKED") {
          setIsFeatureLocked(true);
        } else {
          setIsForbidden(true);
        }
        return;
      }

      const json = (await res.json()) as BrandingResponse;

      if (!res.ok || json.error || !json.data) {
        setLoadError(json.error?.message ?? "โหลดข้อมูล branding ไม่สำเร็จ");
        return;
      }

      // ถ้า feature ปิด — แสดง upsell state (data อาจมีแต่ brandingEnabled = false)
      if (!json.data.brandingEnabled) {
        setIsFeatureLocked(true);
        return;
      }

      // prefill form ด้วยค่าปัจจุบัน (null → string ว่างสำหรับ input)
      const prefill: FormValues = {
        logoUrl: json.data.logoUrl ?? "",
        accentColor: json.data.accentColor ?? "",
      };
      setFormValues(prefill);
      setSavedValues(prefill); // baseline สำหรับ dirty-tracking
      // validate ค่าที่ prefill ด้วย — กัน preview render ค่าที่ยังไม่ผ่าน validator
      setFieldErrors({
        logoUrl: clientValidateLogoUrl(prefill.logoUrl),
        accentColor: clientValidateAccentColor(prefill.accentColor),
      });
    } catch {
      setLoadError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // deferred ผ่าน microtask — กัน setState synchronous ใน effect body
    queueMicrotask(() => void fetchBranding());
  }, [fetchBranding]);

  // ─── handlers ──────────────────────────────────────────────────────────────

  function handleLogoChange(value: string) {
    setFormValues((prev) => ({ ...prev, logoUrl: value }));
    // validate ทันทีเพื่อ live feedback
    setFieldErrors((prev) => ({
      ...prev,
      logoUrl: clientValidateLogoUrl(value),
    }));
    setSubmitSuccess(false);
  }

  function handleLogoClear() {
    setFormValues((prev) => ({ ...prev, logoUrl: "" }));
    setFieldErrors((prev) => ({ ...prev, logoUrl: null }));
    setSubmitSuccess(false);
  }

  function handleColorChange(value: string) {
    setFormValues((prev) => ({ ...prev, accentColor: value }));
    // validate ทันทีเพื่อ live feedback
    setFieldErrors((prev) => ({
      ...prev,
      accentColor: clientValidateAccentColor(value),
    }));
    setSubmitSuccess(false);
  }

  function handleColorClear() {
    setFormValues((prev) => ({ ...prev, accentColor: "" }));
    setFieldErrors((prev) => ({ ...prev, accentColor: null }));
    setSubmitSuccess(false);
  }

  async function handleSubmit() {
    if (isSubmitting) return;

    // client-side validate ก่อน submit
    const logoError = clientValidateLogoUrl(formValues.logoUrl);
    const colorError = clientValidateAccentColor(formValues.accentColor);

    setFieldErrors({ logoUrl: logoError, accentColor: colorError });

    if (logoError || colorError) return;

    // สร้าง PATCH body — ส่งเฉพาะ field ที่ "เปลี่ยนจริง" เทียบกับ savedValues (dirty-tracking)
    //   - ไม่เปลี่ยน → omit (API ไม่แตะ field นั้น)
    //   - มีค่า → ส่ง string, ค่าว่าง → ส่ง null (clear)
    // กันบั๊ก: แก้สีอย่างเดียวต้องไม่ทำให้ logo หาย
    const body: Record<string, string | null> = {};

    if (formValues.logoUrl !== savedValues.logoUrl) {
      body.logoUrl = formValues.logoUrl.trim() || null;
    }
    if (formValues.accentColor !== savedValues.accentColor) {
      body.accentColor = formValues.accentColor.trim() || null;
    }

    // ไม่มีอะไรเปลี่ยน → ไม่ต้องยิง API (กัน 400 "ต้องระบุอย่างน้อย 1 field")
    if (Object.keys(body).length === 0) {
      setSubmitSuccess(true);
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);
    setSubmitSuccess(false);

    try {
      const res = await fetch("/api/branding", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const json = (await res.json()) as PatchBrandingResponse;

      if (!res.ok || json.error || !json.data) {
        const code = json.error?.code;
        if (code === "FEATURE_LOCKED") {
          // feature หมดอายุระหว่าง session → แสดง locked state
          setIsFeatureLocked(true);
          return;
        }
        setSubmitError(json.error?.message ?? "บันทึกไม่สำเร็จ กรุณาลองใหม่");
        return;
      }

      // บันทึกสำเร็จ — อัปเดต form + savedValues ด้วยค่าที่ validated จาก API (reset baseline)
      const saved: FormValues = {
        logoUrl: json.data.logoUrl ?? "",
        accentColor: json.data.accentColor ?? "",
      };
      setFormValues(saved);
      setSavedValues(saved);
      setSubmitSuccess(true);
    } catch {
      setSubmitError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsSubmitting(false);
    }
  }

  // ─── early return states ────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-foreground">Branding</h1>
            <p className="mt-1 text-sm text-secondary">ตั้งค่า logo และสีของ portal ลูกค้า</p>
          </div>
          <BrandingSkeleton />
        </div>
      </div>
    );
  }

  if (isFeatureLocked) {
    return <FeatureLockedState />;
  }

  if (isForbidden) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="bg-surface rounded-xl border border-border p-8 max-w-sm w-full text-center flex flex-col items-center gap-4">
          <ShieldAlert size={40} className="text-muted" aria-hidden="true" />
          <h2 className="text-base font-semibold text-foreground">ไม่มีสิทธิ์เข้าถึง</h2>
          <p className="text-sm text-secondary">
            หน้า Branding เข้าได้เฉพาะ <strong>OWNER</strong> และ <strong>ADMIN</strong> เท่านั้น
          </p>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="bg-surface rounded-xl border border-border p-8 max-w-md w-full text-center">
          <p className="text-danger font-medium mb-4">{loadError}</p>
          <button
            type="button"
            onClick={() => void fetchBranding()}
            className="text-sm text-primary-ink hover:underline focus:outline-none focus:underline"
          >
            ลองใหม่
          </button>
        </div>
      </div>
    );
  }

  // ─── main render ────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

        {/* Page header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-primary-tint flex items-center justify-center shrink-0">
            <Palette size={20} className="text-primary" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Branding</h1>
            <p className="mt-0.5 text-sm text-secondary">
              ตั้งค่า logo และสีของ portal ลูกค้า — แสดงเฉพาะเมื่อลูกค้าเข้า portal ของ workspace คุณ
            </p>
          </div>
        </div>

        {/* Form card */}
        <div className="bg-surface rounded-xl border border-border p-6 flex flex-col gap-6 shadow-sm">

          {/* success alert */}
          {submitSuccess && (
            <FormAlert
              variant="success"
              message="บันทึก Branding สำเร็จ — portal ลูกค้าจะแสดงการเปลี่ยนแปลงทันที"
            />
          )}

          {/* submit error */}
          {submitError && (
            <FormAlert variant="error" message={submitError} />
          )}

          {/* Logo URL field */}
          <LogoField
            id={logoFieldId}
            value={formValues.logoUrl}
            onChange={handleLogoChange}
            onClear={handleLogoClear}
            error={fieldErrors.logoUrl}
            disabled={isSubmitting}
          />

          {/* divider */}
          <div className="border-t border-border" aria-hidden="true" />

          {/* Accent Color field */}
          <ColorField
            pickerId={colorPickerId}
            hexId={colorHexId}
            value={formValues.accentColor}
            onChange={handleColorChange}
            onClear={handleColorClear}
            error={fieldErrors.accentColor}
            disabled={isSubmitting}
          />

          {/* divider */}
          <div className="border-t border-border" aria-hidden="true" />

          {/* Submit button */}
          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={isSubmitting || fieldErrors.logoUrl !== null || fieldErrors.accentColor !== null}
              className={[
                "inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold text-white transition-colors",
                "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                "bg-primary-strong hover:bg-primary-strong-hover",
              ].join(" ")}
            >
              {isSubmitting && (
                <RefreshCw size={14} className="animate-spin" aria-hidden="true" />
              )}
              {isSubmitting ? "กำลังบันทึก..." : "บันทึก Branding"}
            </button>
          </div>
        </div>

        {/* Info note */}
        <p className="mt-4 text-xs text-muted">
          การเปลี่ยนแปลงจะมีผลกับ portal ลูกค้า (&lt;slug&gt;.helpwise.com/portal) ทันที ไม่ต้องรีสตาร์ทระบบ
        </p>

      </div>
    </div>
  );
}
