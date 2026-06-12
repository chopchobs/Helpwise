"use client";

/**
 * หน้า SLA Policy Settings (agent — OWNER/ADMIN เท่านั้น)
 * แสดงรายการ SLA policy + สร้าง/แก้ไข/ลบ/ตั้งค่า default
 * ถ้า feature FEATURE_LOCKED → แสดง upsell state
 * ถ้า role อื่น 403 → แสดง forbidden state
 */

import { useState, useEffect, useCallback, useId } from "react";
import {
  Timer,
  Plus,
  Pencil,
  Trash2,
  Star,
  ShieldAlert,
  Lock,
  RefreshCw,
  X,
  AlertTriangle,
  Check,
  ExternalLink,
} from "lucide-react";
import Link from "next/link";
import FormAlert from "@/components/ui/FormAlert";
import { formatMinutes } from "@/lib/ticket-ui";
import type {
  SlaPolicyDTO,
  SlaPolicyListData,
  SlaPolicyListResponse,
  SlaPolicyResponse,
  SlaPolicyDeleteResponse,
  CreateSlaPolicyBody,
  UpdateSlaPolicyBody,
} from "@/types/sla-policy";

// =============================================================================
// TYPES
// =============================================================================

/** ชนิด form mode — create ใหม่ หรือ edit policy ที่มีอยู่ */
type FormMode = { kind: "create" } | { kind: "edit"; policy: SlaPolicyDTO };

/** ค่าของ form inputs (ทุก field เป็น string เพราะมาจาก input[type=number]) */
interface PolicyFormValues {
  name: string;
  isDefault: boolean;
  firstResponseLowMin: string;
  firstResponseNormMin: string;
  firstResponseHighMin: string;
  firstResponseUrgMin: string;
  resolutionLowMin: string;
  resolutionNormMin: string;
  resolutionHighMin: string;
  resolutionUrgMin: string;
}

/** label + key สำหรับ render grid targets */
interface SlaTargetDef {
  key: keyof Omit<PolicyFormValues, "name" | "isDefault">;
  priorityLabel: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const PRIORITY_LABELS: Record<string, string> = {
  Low: "ต่ำ",
  Norm: "ปกติ",
  High: "สูง",
  Urg: "เร่งด่วน",
};

/** field groups สำหรับแสดงใน form + card */
const FIRST_RESPONSE_TARGETS: SlaTargetDef[] = [
  { key: "firstResponseLowMin",  priorityLabel: "ต่ำ" },
  { key: "firstResponseNormMin", priorityLabel: "ปกติ" },
  { key: "firstResponseHighMin", priorityLabel: "สูง" },
  { key: "firstResponseUrgMin",  priorityLabel: "เร่งด่วน" },
];

const RESOLUTION_TARGETS: SlaTargetDef[] = [
  { key: "resolutionLowMin",  priorityLabel: "ต่ำ" },
  { key: "resolutionNormMin", priorityLabel: "ปกติ" },
  { key: "resolutionHighMin", priorityLabel: "สูง" },
  { key: "resolutionUrgMin",  priorityLabel: "เร่งด่วน" },
];

const EMPTY_FORM: PolicyFormValues = {
  name: "",
  isDefault: false,
  firstResponseLowMin:  "480",
  firstResponseNormMin: "240",
  firstResponseHighMin: "60",
  firstResponseUrgMin:  "15",
  resolutionLowMin:     "2880",
  resolutionNormMin:    "1440",
  resolutionHighMin:    "480",
  resolutionUrgMin:     "240",
};

// =============================================================================
// HELPERS
// =============================================================================

/** แปลง PolicyFormValues เป็น CreateSlaPolicyBody หลัง validate */
function parseFormToBody(values: PolicyFormValues): CreateSlaPolicyBody {
  return {
    name:                   values.name.trim(),
    isDefault:              values.isDefault,
    firstResponseLowMin:    parseInt(values.firstResponseLowMin,  10),
    firstResponseNormMin:   parseInt(values.firstResponseNormMin, 10),
    firstResponseHighMin:   parseInt(values.firstResponseHighMin, 10),
    firstResponseUrgMin:    parseInt(values.firstResponseUrgMin,  10),
    resolutionLowMin:       parseInt(values.resolutionLowMin,     10),
    resolutionNormMin:      parseInt(values.resolutionNormMin,    10),
    resolutionHighMin:      parseInt(values.resolutionHighMin,    10),
    resolutionUrgMin:       parseInt(values.resolutionUrgMin,     10),
  };
}

/** map SlaPolicyDTO → PolicyFormValues สำหรับ prefill edit form */
function policyToFormValues(policy: SlaPolicyDTO): PolicyFormValues {
  return {
    name:                   policy.name,
    isDefault:              policy.isDefault,
    firstResponseLowMin:    String(policy.firstResponseLowMin),
    firstResponseNormMin:   String(policy.firstResponseNormMin),
    firstResponseHighMin:   String(policy.firstResponseHighMin),
    firstResponseUrgMin:    String(policy.firstResponseUrgMin),
    resolutionLowMin:       String(policy.resolutionLowMin),
    resolutionNormMin:      String(policy.resolutionNormMin),
    resolutionHighMin:      String(policy.resolutionHighMin),
    resolutionUrgMin:       String(policy.resolutionUrgMin),
  };
}

/** validate ฝั่ง client ก่อน submit — return error string หรือ null */
function validateForm(values: PolicyFormValues): string | null {
  if (!values.name.trim()) return "กรุณาระบุชื่อ policy";

  const numericFields = [
    values.firstResponseLowMin,
    values.firstResponseNormMin,
    values.firstResponseHighMin,
    values.firstResponseUrgMin,
    values.resolutionLowMin,
    values.resolutionNormMin,
    values.resolutionHighMin,
    values.resolutionUrgMin,
  ];

  for (const v of numericFields) {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 1) return "ค่าเวลาต้องเป็นตัวเลขจำนวนเต็มบวก (นาที)";
    // ตรงกับ bound ฝั่ง backend (max 100000 นาที) — กัน error หลัง submit
    if (n > 100000) return "ค่าเวลาต้องไม่เกิน 100000 นาที";
  }

  return null;
}

// =============================================================================
// LOADING SKELETON
// =============================================================================

function SlaSkeleton() {
  return (
    <div className="animate-pulse flex flex-col gap-4" aria-busy="true" aria-label="กำลังโหลด...">
      <div className="flex justify-between items-center">
        <div className="h-6 bg-stone rounded w-40" />
        <div className="h-9 bg-stone rounded-lg w-36" />
      </div>
      {[1, 2].map((i) => (
        <div key={i} className="h-48 bg-stone rounded-xl" />
      ))}
    </div>
  );
}

// =============================================================================
// TARGET GRID — shared between card display and form
// =============================================================================

interface TargetRowProps {
  label: string;
  targets: { priorityLabel: string; minutes: number }[];
}

/** SlaTargetRow — แสดง first-response หรือ resolution targets 4 ลำดับความสำคัญในแถวเดียว */
function SlaTargetRow({ label, targets }: TargetRowProps) {
  return (
    <div>
      <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-1.5">{label}</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {targets.map(({ priorityLabel, minutes }) => (
          <div
            key={priorityLabel}
            className="flex flex-col gap-0.5 px-2 py-1.5 rounded-lg bg-background border border-border"
          >
            <span className="text-xs text-muted">{priorityLabel}</span>
            <span className="text-sm font-semibold text-foreground">{formatMinutes(minutes)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// POLICY CARD
// =============================================================================

interface PolicyCardProps {
  policy: SlaPolicyDTO;
  onEdit: (policy: SlaPolicyDTO) => void;
  onSetDefault: (policy: SlaPolicyDTO) => void;
  onDelete: (policy: SlaPolicyDTO) => void;
  isActing: boolean;
  actingId: string | null;
}

function PolicyCard({
  policy,
  onEdit,
  onSetDefault,
  onDelete,
  isActing,
  actingId,
}: PolicyCardProps) {
  const isThisActing = isActing && actingId === policy.id;

  const firstResponseTargets = [
    { priorityLabel: PRIORITY_LABELS["Low"],  minutes: policy.firstResponseLowMin },
    { priorityLabel: PRIORITY_LABELS["Norm"], minutes: policy.firstResponseNormMin },
    { priorityLabel: PRIORITY_LABELS["High"], minutes: policy.firstResponseHighMin },
    { priorityLabel: PRIORITY_LABELS["Urg"],  minutes: policy.firstResponseUrgMin },
  ];

  const resolutionTargets = [
    { priorityLabel: PRIORITY_LABELS["Low"],  minutes: policy.resolutionLowMin },
    { priorityLabel: PRIORITY_LABELS["Norm"], minutes: policy.resolutionNormMin },
    { priorityLabel: PRIORITY_LABELS["High"], minutes: policy.resolutionHighMin },
    { priorityLabel: PRIORITY_LABELS["Urg"],  minutes: policy.resolutionUrgMin },
  ];

  return (
    <div
      className={[
        "bg-surface rounded-xl border p-5 flex flex-col gap-4 transition-colors",
        policy.isDefault ? "border-primary ring-1 ring-primary" : "border-border",
      ].join(" ")}
    >
      {/* Header: ชื่อ + badge + actions */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-base font-bold text-foreground">{policy.name}</h3>
          {policy.isDefault && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-primary-tint text-primary-ink border border-primary-tint">
              <Star size={10} aria-hidden="true" />
              Default
            </span>
          )}
          {typeof policy.ticketCount === "number" && (
            <span className="text-xs text-muted">
              {policy.ticketCount.toLocaleString("th-TH")} ticket
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Set as default — แสดงเฉพาะ non-default policy */}
          {!policy.isDefault && (
            <button
              type="button"
              title="ตั้งเป็น default"
              aria-label={`ตั้ง ${policy.name} เป็น default`}
              disabled={isActing}
              onClick={() => onSetDefault(policy)}
              className={[
                "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors",
                "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                "border-border text-secondary hover:bg-stone hover:text-foreground bg-surface",
              ].join(" ")}
            >
              {isThisActing ? (
                <RefreshCw size={12} className="animate-spin" aria-hidden="true" />
              ) : (
                <Star size={12} aria-hidden="true" />
              )}
              ตั้งเป็น Default
            </button>
          )}

          {/* Edit */}
          <button
            type="button"
            title="แก้ไข"
            aria-label={`แก้ไข ${policy.name}`}
            disabled={isActing}
            onClick={() => onEdit(policy)}
            className={[
              "p-1.5 rounded-lg border border-border text-secondary hover:bg-stone hover:text-foreground bg-surface transition-colors",
              "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1",
              "disabled:opacity-50 disabled:cursor-not-allowed",
            ].join(" ")}
          >
            <Pencil size={14} aria-hidden="true" />
          </button>

          {/* Delete — disabled สำหรับ default policy (ลบไม่ได้) */}
          <button
            type="button"
            title={policy.isDefault ? "ไม่สามารถลบ Default policy ได้" : `ลบ ${policy.name}`}
            aria-label={policy.isDefault ? "ไม่สามารถลบ Default policy ได้" : `ลบ ${policy.name}`}
            disabled={isActing || policy.isDefault}
            onClick={() => !policy.isDefault && onDelete(policy)}
            className={[
              "p-1.5 rounded-lg border transition-colors",
              "focus:outline-none focus:ring-2 focus:ring-danger focus:ring-offset-1",
              policy.isDefault
                ? "border-border text-muted cursor-not-allowed opacity-40 bg-surface"
                : "border-border text-secondary hover:bg-danger-tint hover:text-danger hover:border-danger-tint bg-surface disabled:opacity-50 disabled:cursor-not-allowed",
            ].join(" ")}
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* SLA targets */}
      <div className="flex flex-col gap-3">
        <SlaTargetRow label="First Response" targets={firstResponseTargets} />
        <SlaTargetRow label="Resolution" targets={resolutionTargets} />
      </div>
    </div>
  );
}

// =============================================================================
// FORM — ใช้ทั้ง create และ edit
// =============================================================================

interface PolicyFormProps {
  mode: FormMode;
  values: PolicyFormValues;
  onChange: (values: PolicyFormValues) => void;
  onSubmit: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
  submitError: string | null;
}

/** NumberInput — input number ที่ผูก value ผ่าน PolicyFormValues */
function NumberInput({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-secondary font-medium">
        {label}
      </label>
      <div className="flex items-center gap-1">
        <input
          id={id}
          type="number"
          min={1}
          step={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={[
            "w-full px-2.5 py-1.5 rounded-lg border border-border bg-background text-foreground text-sm",
            "focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "placeholder:text-muted",
          ].join(" ")}
          placeholder="นาที"
          aria-describedby={`${id}-unit`}
        />
        <span id={`${id}-unit`} className="text-xs text-muted shrink-0">นาที</span>
      </div>
    </div>
  );
}

function PolicyForm({
  mode,
  values,
  onChange,
  onSubmit,
  onCancel,
  isSubmitting,
  submitError,
}: PolicyFormProps) {
  const baseId = useId();

  function handleFieldChange<K extends keyof PolicyFormValues>(key: K, val: PolicyFormValues[K]) {
    onChange({ ...values, [key]: val });
  }

  // สร้าง id ให้กับ input ทุกตัวจาก base id
  function fid(suffix: string) {
    return `${baseId}-${suffix}`;
  }

  const isEditing = mode.kind === "edit";

  return (
    <div className="bg-surface rounded-xl border border-border p-6 flex flex-col gap-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-bold text-foreground">
          {isEditing ? "แก้ไข SLA Policy" : "สร้าง SLA Policy ใหม่"}
        </h3>
        <button
          type="button"
          onClick={onCancel}
          aria-label="ปิดฟอร์ม"
          disabled={isSubmitting}
          className="p-1.5 rounded-lg text-muted hover:bg-stone hover:text-secondary transition-colors focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
        >
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      {/* ชื่อ policy */}
      <div className="flex flex-col gap-1">
        <label htmlFor={fid("name")} className="text-sm font-medium text-foreground">
          ชื่อ Policy <span className="text-danger" aria-hidden="true">*</span>
        </label>
        <input
          id={fid("name")}
          type="text"
          value={values.name}
          onChange={(e) => handleFieldChange("name", e.target.value)}
          disabled={isSubmitting}
          maxLength={80}
          placeholder="เช่น Standard SLA, Premium SLA"
          className={[
            "w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm",
            "focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary",
            "disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-muted",
          ].join(" ")}
          required
          aria-required="true"
        />
      </div>

      {/* First Response targets */}
      <div>
        <p className="text-sm font-semibold text-foreground mb-2.5">
          First Response Time <span className="text-muted font-normal text-xs">(นาที)</span>
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {FIRST_RESPONSE_TARGETS.map(({ key, priorityLabel }) => (
            <NumberInput
              key={key}
              id={fid(key)}
              label={priorityLabel}
              value={values[key]}
              onChange={(v) => handleFieldChange(key, v)}
              disabled={isSubmitting}
            />
          ))}
        </div>
      </div>

      {/* Resolution targets */}
      <div>
        <p className="text-sm font-semibold text-foreground mb-2.5">
          Resolution Time <span className="text-muted font-normal text-xs">(นาที)</span>
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {RESOLUTION_TARGETS.map(({ key, priorityLabel }) => (
            <NumberInput
              key={key}
              id={fid(key)}
              label={priorityLabel}
              value={values[key]}
              onChange={(v) => handleFieldChange(key, v)}
              disabled={isSubmitting}
            />
          ))}
        </div>
      </div>

      {/* isDefault checkbox */}
      <div className="flex items-center gap-2">
        <input
          id={fid("isDefault")}
          type="checkbox"
          checked={values.isDefault}
          onChange={(e) => handleFieldChange("isDefault", e.target.checked)}
          disabled={isSubmitting || (isEditing && mode.policy.isDefault)}
          className="w-4 h-4 rounded border-border accent-[color:var(--color-primary)] focus:ring-2 focus:ring-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        />
        <label htmlFor={fid("isDefault")} className="text-sm text-foreground cursor-pointer select-none">
          ตั้งเป็น Default Policy
        </label>
        {isEditing && mode.policy.isDefault && (
          <span className="text-xs text-muted">(policy นี้เป็น default อยู่แล้ว)</span>
        )}
      </div>

      {/* Error alert */}
      {submitError && (
        <FormAlert variant="error" message={submitError} />
      )}

      {/* Submit / Cancel */}
      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={onSubmit}
          disabled={isSubmitting}
          className={[
            "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white transition-colors",
            "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "bg-primary-strong hover:bg-primary-strong-hover",
          ].join(" ")}
        >
          {isSubmitting && <RefreshCw size={14} className="animate-spin" aria-hidden="true" />}
          {isSubmitting ? "กำลังบันทึก..." : isEditing ? "บันทึกการแก้ไข" : "สร้าง Policy"}
        </button>

        <button
          type="button"
          onClick={onCancel}
          disabled={isSubmitting}
          className={[
            "px-4 py-2 rounded-lg text-sm font-semibold border transition-colors",
            "border-border text-secondary hover:bg-stone hover:text-foreground bg-surface",
            "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          ].join(" ")}
        >
          ยกเลิก
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// DELETE CONFIRM DIALOG — modal overlay
// =============================================================================

interface DeleteConfirmProps {
  policy: SlaPolicyDTO;
  onConfirm: () => void;
  onCancel: () => void;
  isDeleting: boolean;
  deleteError: string | null;
}

function DeleteConfirmDialog({ policy, onConfirm, onCancel, isDeleting, deleteError }: DeleteConfirmProps) {
  return (
    <>
      {/* backdrop */}
      <div
        className="fixed inset-0 z-40 bg-foreground/30"
        aria-hidden="true"
        onClick={() => !isDeleting && onCancel()}
      />
      {/* dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-dialog-title"
        aria-describedby="delete-dialog-desc"
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <div className="bg-surface rounded-xl border border-border shadow-lg p-6 max-w-sm w-full flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-danger-tint flex items-center justify-center shrink-0">
              <AlertTriangle size={20} className="text-danger" aria-hidden="true" />
            </div>
            <div>
              <h2 id="delete-dialog-title" className="text-base font-bold text-foreground">
                ลบ SLA Policy
              </h2>
              <p id="delete-dialog-desc" className="text-sm text-secondary mt-1">
                ต้องการลบ <strong className="text-foreground">&quot;{policy.name}&quot;</strong> ใช่ไหม?
                {typeof policy.ticketCount === "number" && policy.ticketCount > 0 && (
                  <span className="block mt-1 text-warning-ink">
                    มี {policy.ticketCount.toLocaleString("th-TH")} ticket ที่ผูกกับ policy นี้อยู่
                  </span>
                )}
              </p>
            </div>
          </div>

          {deleteError && <FormAlert variant="error" message={deleteError} />}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onConfirm}
              disabled={isDeleting}
              className={[
                "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white transition-colors",
                "focus:outline-none focus:ring-2 focus:ring-danger focus:ring-offset-2",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                "bg-danger hover:bg-danger/90",
              ].join(" ")}
            >
              {isDeleting && <RefreshCw size={14} className="animate-spin" aria-hidden="true" />}
              {isDeleting ? "กำลังลบ..." : "ลบ Policy"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={isDeleting}
              className={[
                "px-4 py-2 rounded-lg text-sm font-semibold border transition-colors",
                "border-border text-secondary hover:bg-stone hover:text-foreground bg-surface",
                "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              ].join(" ")}
            >
              ยกเลิก
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// =============================================================================
// UPSELL STATE — feature locked
// =============================================================================

function FeatureLockedState() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="bg-surface rounded-xl border border-border p-8 max-w-sm w-full text-center flex flex-col items-center gap-4">
        <div className="w-12 h-12 rounded-full bg-warning-tint flex items-center justify-center">
          <Lock size={24} className="text-warning-ink" aria-hidden="true" />
        </div>
        <div>
          <h2 className="text-base font-bold text-foreground">SLA Policy ไม่รวมใน Plan ปัจจุบัน</h2>
          <p className="text-sm text-secondary mt-2">
            ฟีเจอร์นี้ต้องใช้ plan ที่สูงกว่า อัปเกรดเพื่อตั้งค่า SLA policy แบบกำหนดเองสำหรับทีม support ของคุณ
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
// PLAN LIMIT BANNER — แสดงเมื่อ canCreateMore === false
// =============================================================================

interface PlanLimitBannerProps {
  maxPolicies: number;
}

function PlanLimitBanner({ maxPolicies }: PlanLimitBannerProps) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 rounded-xl border border-warning-tint bg-warning-tint">
      <AlertTriangle size={16} className="text-warning-ink shrink-0 mt-0.5" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-warning-ink">
          ถึงจำนวนสูงสุดแล้ว ({maxPolicies} policy) — อัปเกรดเพื่อสร้างเพิ่ม
        </p>
        <Link
          href="/settings/billing"
          className="inline-flex items-center gap-1 text-xs text-warning-ink underline underline-offset-2 mt-0.5 hover:opacity-80 focus:outline-none focus:ring-1 focus:ring-warning"
        >
          ดู Billing
          <ExternalLink size={10} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}

// =============================================================================
// EMPTY STATE
// =============================================================================

function EmptyState({ onCreateClick }: { onCreateClick: () => void }) {
  return (
    <div className="bg-surface rounded-xl border border-border p-10 text-center flex flex-col items-center gap-4">
      <div className="w-12 h-12 rounded-full bg-primary-tint flex items-center justify-center">
        <Timer size={24} className="text-primary" aria-hidden="true" />
      </div>
      <div>
        <h3 className="text-base font-semibold text-foreground">ยังไม่มี SLA Policy</h3>
        <p className="text-sm text-secondary mt-1">
          สร้าง policy แรกเพื่อกำหนด SLA target สำหรับแต่ละระดับความสำคัญของ ticket
        </p>
      </div>
      <button
        type="button"
        onClick={onCreateClick}
        className={[
          "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white transition-colors",
          "bg-primary-strong hover:bg-primary-strong-hover",
          "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
        ].join(" ")}
      >
        <Plus size={15} aria-hidden="true" />
        สร้าง Policy แรก
      </button>
    </div>
  );
}

// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function SlaSettingsPage() {
  // ─── data state ────────────────────────────────────────────────────────────
  const [listData, setListData]     = useState<SlaPolicyListData | null>(null);
  const [isLoading, setIsLoading]   = useState(true);
  const [loadError, setLoadError]   = useState<string | null>(null);
  const [isForbidden, setIsForbidden] = useState(false);
  const [isFeatureLocked, setIsFeatureLocked] = useState(false);

  // ─── form state ────────────────────────────────────────────────────────────
  const [formMode, setFormMode]     = useState<FormMode | null>(null);
  const [formValues, setFormValues] = useState<PolicyFormValues>(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError]   = useState<string | null>(null);

  // ─── action state ─────────────────────────────────────────────────────────
  const [isActing, setIsActing]     = useState(false);
  const [actingId, setActingId]     = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // ─── delete confirm ────────────────────────────────────────────────────────
  const [deletingPolicy, setDeletingPolicy] = useState<SlaPolicyDTO | null>(null);
  const [isDeleting, setIsDeleting]   = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ─── fetch ─────────────────────────────────────────────────────────────────

  const fetchPolicies = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    setIsForbidden(false);
    setIsFeatureLocked(false);

    try {
      const res = await fetch("/api/sla-policies", { credentials: "include" });

      if (res.status === 403) {
        const json = (await res.json()) as SlaPolicyListResponse;
        // feature locked → upsell
        const code = typeof json.error === "object" ? json.error?.code : null;
        if (code === "FEATURE_LOCKED") {
          setIsFeatureLocked(true);
        } else {
          // role ไม่ใช่ OWNER/ADMIN
          setIsForbidden(true);
        }
        return;
      }

      const json = (await res.json()) as SlaPolicyListResponse;

      if (!res.ok || json.error || !json.data) {
        const msg = typeof json.error === "object" ? json.error?.message : json.error;
        setLoadError(msg ?? "โหลดข้อมูล SLA policy ไม่สำเร็จ");
        return;
      }

      setListData(json.data);
    } catch {
      setLoadError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // deferred ผ่าน microtask — กัน setState synchronous ใน effect body
    queueMicrotask(() => void fetchPolicies());
  }, [fetchPolicies]);

  // ─── handlers ──────────────────────────────────────────────────────────────

  function handleOpenCreate() {
    setFormMode({ kind: "create" });
    setFormValues(EMPTY_FORM);
    setSubmitError(null);
  }

  function handleOpenEdit(policy: SlaPolicyDTO) {
    setFormMode({ kind: "edit", policy });
    setFormValues(policyToFormValues(policy));
    setSubmitError(null);
  }

  function handleCloseForm() {
    if (isSubmitting) return;
    setFormMode(null);
    setSubmitError(null);
  }

  async function handleSubmitForm() {
    if (!formMode || isSubmitting) return;

    const validationError = validateForm(formValues);
    if (validationError) {
      setSubmitError(validationError);
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const body = parseFormToBody(formValues);

      let res: Response;
      if (formMode.kind === "create") {
        res = await fetch("/api/sla-policies", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        // แปลง CreateSlaPolicyBody → UpdateSlaPolicyBody (ทุก field เหมือนกัน แค่ partial)
        const updateBody: UpdateSlaPolicyBody = body;
        res = await fetch(`/api/sla-policies/${formMode.policy.id}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updateBody),
        });
      }

      const json = (await res.json()) as SlaPolicyResponse;

      if (!res.ok || json.error || !json.data) {
        const msg = typeof json.error === "object" ? json.error?.message : json.error;
        setSubmitError(msg ?? "บันทึกไม่สำเร็จ กรุณาลองใหม่");
        return;
      }

      // บันทึกสำเร็จ — ปิด form และ refetch
      setFormMode(null);
      await fetchPolicies();
    } catch {
      setSubmitError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSetDefault(policy: SlaPolicyDTO) {
    if (isActing) return;
    setIsActing(true);
    setActingId(policy.id);
    setActionError(null);

    try {
      const res = await fetch(`/api/sla-policies/${policy.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isDefault: true } satisfies UpdateSlaPolicyBody),
      });

      const json = (await res.json()) as SlaPolicyResponse;

      if (!res.ok || json.error || !json.data) {
        const msg = typeof json.error === "object" ? json.error?.message : json.error;
        setActionError(msg ?? "ตั้งค่า default ไม่สำเร็จ กรุณาลองใหม่");
        return;
      }

      await fetchPolicies();
    } catch {
      setActionError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsActing(false);
      setActingId(null);
    }
  }

  function handleOpenDelete(policy: SlaPolicyDTO) {
    setDeletingPolicy(policy);
    setDeleteError(null);
  }

  async function handleConfirmDelete() {
    if (!deletingPolicy || isDeleting) return;
    setIsDeleting(true);
    setDeleteError(null);

    try {
      const res = await fetch(`/api/sla-policies/${deletingPolicy.id}`, {
        method: "DELETE",
        credentials: "include",
      });

      const json = (await res.json()) as SlaPolicyDeleteResponse;

      if (!res.ok || json.error || !json.data?.deleted) {
        const msg = typeof json.error === "object" ? json.error?.message : json.error;
        // 409 errors: CANNOT_DELETE_DEFAULT, CANNOT_DELETE_LAST → แสดงข้อความโดยตรง
        setDeleteError(msg ?? "ลบไม่สำเร็จ กรุณาลองใหม่");
        return;
      }

      // ลบสำเร็จ
      setDeletingPolicy(null);
      await fetchPolicies();
    } catch {
      setDeleteError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsDeleting(false);
    }
  }

  // ─── early return states ────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-foreground">SLA Policy</h1>
            <p className="mt-1 text-sm text-secondary">จัดการ SLA target ตามระดับความสำคัญของ ticket</p>
          </div>
          <SlaSkeleton />
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
            หน้า SLA Policy เข้าได้เฉพาะ <strong>OWNER</strong> และ <strong>ADMIN</strong> เท่านั้น
          </p>
        </div>
      </div>
    );
  }

  if (loadError || !listData) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="bg-surface rounded-xl border border-border p-8 max-w-md w-full text-center">
          <p className="text-danger font-medium mb-4">{loadError ?? "เกิดข้อผิดพลาด"}</p>
          <button
            type="button"
            onClick={() => void fetchPolicies()}
            className="text-sm text-primary-ink hover:underline focus:outline-none focus:underline"
          >
            ลองใหม่
          </button>
        </div>
      </div>
    );
  }

  const { policies, canCreateMore, maxPolicies } = listData;
  const isFormOpen = formMode !== null;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

        {/* Page header */}
        <div className="flex items-start justify-between gap-4 flex-wrap mb-6">
          <div>
            <h1 className="text-2xl font-bold text-foreground">SLA Policy</h1>
            <p className="mt-1 text-sm text-secondary">
              จัดการ SLA target ตามระดับความสำคัญของ ticket
              {maxPolicies > 0 && (
                <span className="ml-1 text-muted">
                  ({policies.length}/{maxPolicies})
                </span>
              )}
            </p>
          </div>

          {/* ปุ่มสร้าง — disabled เมื่อถึง limit หรือ form เปิดอยู่ */}
          {!isFormOpen && (
            <button
              type="button"
              onClick={handleOpenCreate}
              disabled={!canCreateMore}
              title={!canCreateMore ? "ถึงจำนวนสูงสุดแล้ว — อัปเกรดเพื่อสร้างเพิ่ม" : undefined}
              className={[
                "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white transition-colors",
                "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
                canCreateMore
                  ? "bg-primary-strong hover:bg-primary-strong-hover"
                  : "bg-stone text-muted border border-border cursor-not-allowed",
              ].join(" ")}
            >
              <Plus size={15} aria-hidden="true" />
              สร้าง Policy ใหม่
            </button>
          )}
        </div>

        {/* Plan limit banner */}
        {!canCreateMore && policies.length > 0 && (
          <div className="mb-6">
            <PlanLimitBanner maxPolicies={maxPolicies} />
          </div>
        )}

        {/* Action error (set default, etc.) */}
        {actionError && (
          <div className="mb-6">
            <FormAlert variant="error" message={actionError} />
          </div>
        )}

        {/* Check เครื่องหมาย success หลัง create/edit */}
        {/* (ไม่มี success banner — refetch เงียบ ๆ ทำให้ UI อัปเดตเอง) */}

        {/* Form — อยู่ด้านบน list เสมอ */}
        {isFormOpen && formMode && (
          <div className="mb-6">
            <PolicyForm
              mode={formMode}
              values={formValues}
              onChange={setFormValues}
              onSubmit={() => void handleSubmitForm()}
              onCancel={handleCloseForm}
              isSubmitting={isSubmitting}
              submitError={submitError}
            />
          </div>
        )}

        {/* Empty state */}
        {policies.length === 0 && !isFormOpen && (
          <EmptyState onCreateClick={handleOpenCreate} />
        )}

        {/* Policy list */}
        {policies.length > 0 && (
          <div
            className="flex flex-col gap-4"
            aria-label={`SLA policies ทั้งหมด ${policies.length} รายการ`}
          >
            {policies.map((policy) => (
              <PolicyCard
                key={policy.id}
                policy={policy}
                onEdit={handleOpenEdit}
                onSetDefault={(p) => void handleSetDefault(p)}
                onDelete={handleOpenDelete}
                isActing={isActing}
                actingId={actingId}
              />
            ))}
          </div>
        )}

      </div>

      {/* Delete confirm modal */}
      {deletingPolicy && (
        <DeleteConfirmDialog
          policy={deletingPolicy}
          onConfirm={() => void handleConfirmDelete()}
          onCancel={() => { if (!isDeleting) setDeletingPolicy(null); }}
          isDeleting={isDeleting}
          deleteError={deleteError}
        />
      )}
    </div>
  );
}
