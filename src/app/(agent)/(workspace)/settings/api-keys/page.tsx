"use client";

/**
 * หน้า API Keys Settings (agent — OWNER/ADMIN เท่านั้น)
 * แสดงรายการ API key, สร้าง key ใหม่ (plaintext เห็นครั้งเดียว), เพิกถอน key
 * ถ้า feature FEATURE_LOCKED → แสดง upsell state
 * ถ้า role อื่น 403 → แสดง forbidden state
 */

import { useState, useEffect, useCallback } from "react";
import {
  KeyRound,
  Plus,
  Trash2,
  ShieldAlert,
  Lock,
  RefreshCw,
  AlertTriangle,
  Copy,
  Check,
  ExternalLink,
} from "lucide-react";
import Link from "next/link";
import FormAlert from "@/components/ui/FormAlert";
import type {
  ApiKeyDTO,
  ApiKeyListResponse,
  ApiKeyCreateResponse,
  ApiKeyRevokeResponse,
} from "@/types/api-key";

// =============================================================================
// HELPERS
// =============================================================================

/** format วันที่เป็น th-TH สั้น ๆ */
function formatDate(value: string | null): string {
  if (!value) return "ยังไม่เคยใช้";
  return new Date(value).toLocaleString("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// =============================================================================
// LOADING SKELETON
// =============================================================================

function ApiKeysSkeleton() {
  return (
    <div className="animate-pulse flex flex-col gap-4" aria-busy="true" aria-label="กำลังโหลด...">
      <div className="flex justify-between items-center">
        <div className="h-6 bg-stone rounded w-40" />
        <div className="h-9 bg-stone rounded-lg w-36" />
      </div>
      {[1, 2].map((i) => (
        <div key={i} className="h-20 bg-stone rounded-xl" />
      ))}
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
          <h2 className="text-base font-bold text-foreground">API Access ไม่รวมใน Plan ปัจจุบัน</h2>
          <p className="text-sm text-secondary mt-2">
            API access เป็นฟีเจอร์ของแผน Enterprise อัปเกรดเพื่อสร้าง API key สำหรับเชื่อมต่อระบบภายนอก
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
// EMPTY STATE
// =============================================================================

function EmptyState({ onCreateClick }: { onCreateClick: () => void }) {
  return (
    <div className="bg-surface rounded-xl border border-border p-10 text-center flex flex-col items-center gap-4">
      <div className="w-12 h-12 rounded-full bg-primary-tint flex items-center justify-center">
        <KeyRound size={24} className="text-primary" aria-hidden="true" />
      </div>
      <div>
        <h3 className="text-base font-semibold text-foreground">ยังไม่มี API key</h3>
        <p className="text-sm text-secondary mt-1">
          สร้างอันแรกเพื่อเชื่อมต่อระบบภายนอก
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
        สร้าง API Key แรก
      </button>
    </div>
  );
}

// =============================================================================
// CREATE FORM — input ชื่อ + ปุ่มสร้าง
// =============================================================================

interface CreateFormProps {
  name: string;
  onChangeName: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
  submitError: string | null;
}

function CreateForm({ name, onChangeName, onSubmit, onCancel, isSubmitting, submitError }: CreateFormProps) {
  return (
    <div className="bg-surface rounded-xl border border-border p-6 flex flex-col gap-4">
      <h3 className="text-base font-bold text-foreground">สร้าง API Key ใหม่</h3>

      <div className="flex flex-col gap-1">
        <label htmlFor="api-key-name" className="text-sm font-medium text-foreground">
          ชื่อ Key <span className="text-danger" aria-hidden="true">*</span>
        </label>
        <input
          id="api-key-name"
          type="text"
          value={name}
          onChange={(e) => onChangeName(e.target.value)}
          disabled={isSubmitting}
          maxLength={80}
          placeholder="เช่น Zapier Integration, CI/CD Pipeline"
          className={[
            "w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm",
            "focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary",
            "disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-muted",
          ].join(" ")}
          required
          aria-required="true"
        />
      </div>

      {submitError && <FormAlert variant="error" message={submitError} />}

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={onSubmit}
          disabled={isSubmitting || !name.trim()}
          className={[
            "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white transition-colors",
            "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "bg-primary-strong hover:bg-primary-strong-hover",
          ].join(" ")}
        >
          {isSubmitting && <RefreshCw size={14} className="animate-spin" aria-hidden="true" />}
          {isSubmitting ? "กำลังสร้าง..." : "สร้าง Key"}
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
// PLAINTEXT KEY REVEAL — แสดงครั้งเดียวหลังสร้างสำเร็จ
// =============================================================================

interface PlaintextRevealProps {
  plaintextKey: string;
  onClose: () => void;
}

function PlaintextReveal({ plaintextKey, onClose }: PlaintextRevealProps) {
  const [isCopied, setIsCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(plaintextKey);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      // clipboard อาจถูกบล็อก — ผู้ใช้ select-copy เองได้
    }
  }

  return (
    <div className="bg-surface rounded-xl border-2 border-warning p-6 flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-warning-tint flex items-center justify-center shrink-0">
          <AlertTriangle size={20} className="text-warning-ink" aria-hidden="true" />
        </div>
        <div>
          <h3 className="text-base font-bold text-foreground">สร้าง API Key สำเร็จ</h3>
          <p className="text-sm text-warning-ink mt-1 font-medium">
            คัดลอกเก็บไว้เดี๋ยวนี้ — จะไม่แสดงอีก
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 p-3 rounded-lg bg-background border border-border">
        <code className="flex-1 text-sm font-mono text-foreground break-all select-all">
          {plaintextKey}
        </code>
        <button
          type="button"
          onClick={() => void handleCopy()}
          aria-label="คัดลอก API key"
          className={[
            "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border shrink-0 transition-colors",
            "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1",
            isCopied
              ? "border-success bg-success-tint text-success"
              : "border-border text-secondary hover:bg-stone hover:text-foreground bg-surface",
          ].join(" ")}
        >
          {isCopied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          {isCopied ? "คัดลอกแล้ว" : "คัดลอก"}
        </button>
      </div>

      <button
        type="button"
        onClick={onClose}
        className={[
          "self-start inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white transition-colors",
          "bg-primary-strong hover:bg-primary-strong-hover",
          "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
        ].join(" ")}
      >
        ปิด — ฉันคัดลอกแล้ว
      </button>
    </div>
  );
}

// =============================================================================
// REVOKE CONFIRM DIALOG — modal overlay
// =============================================================================

interface RevokeConfirmProps {
  apiKey: ApiKeyDTO;
  onConfirm: () => void;
  onCancel: () => void;
  isRevoking: boolean;
  revokeError: string | null;
}

function RevokeConfirmDialog({ apiKey, onConfirm, onCancel, isRevoking, revokeError }: RevokeConfirmProps) {
  return (
    <>
      {/* backdrop */}
      <div
        className="fixed inset-0 z-40 bg-foreground/30"
        aria-hidden="true"
        onClick={() => !isRevoking && onCancel()}
      />
      {/* dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="revoke-dialog-title"
        aria-describedby="revoke-dialog-desc"
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <div className="bg-surface rounded-xl border border-border shadow-lg p-6 max-w-sm w-full flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-danger-tint flex items-center justify-center shrink-0">
              <AlertTriangle size={20} className="text-danger" aria-hidden="true" />
            </div>
            <div>
              <h2 id="revoke-dialog-title" className="text-base font-bold text-foreground">
                เพิกถอน API Key
              </h2>
              <p id="revoke-dialog-desc" className="text-sm text-secondary mt-1">
                ต้องการเพิกถอน <strong className="text-foreground">&quot;{apiKey.name}&quot;</strong> ใช่ไหม?
                ระบบที่ใช้ key นี้อยู่จะไม่สามารถเรียก API ได้อีก — ดำเนินการนี้ย้อนกลับไม่ได้
              </p>
            </div>
          </div>

          {revokeError && <FormAlert variant="error" message={revokeError} />}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onConfirm}
              disabled={isRevoking}
              className={[
                "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white transition-colors",
                "focus:outline-none focus:ring-2 focus:ring-danger focus:ring-offset-2",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                "bg-danger hover:bg-danger/90",
              ].join(" ")}
            >
              {isRevoking && <RefreshCw size={14} className="animate-spin" aria-hidden="true" />}
              {isRevoking ? "กำลังเพิกถอน..." : "เพิกถอน Key"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={isRevoking}
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
// API KEY ROW
// =============================================================================

interface ApiKeyRowProps {
  apiKey: ApiKeyDTO;
  onRevoke: (apiKey: ApiKeyDTO) => void;
  isActing: boolean;
}

function ApiKeyRow({ apiKey, onRevoke, isActing }: ApiKeyRowProps) {
  const isRevoked = apiKey.revokedAt !== null;

  return (
    <div
      className={[
        "bg-surface rounded-xl border border-border p-4 flex items-center justify-between gap-4 flex-wrap",
        isRevoked ? "opacity-60" : "",
      ].join(" ")}
    >
      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className={["text-sm font-semibold text-foreground", isRevoked ? "line-through" : ""].join(" ")}>
            {apiKey.name}
          </h3>
          {isRevoked ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-stone text-muted border border-border">
              เพิกถอนแล้ว
            </span>
          ) : (
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-success-tint text-success border border-success-tint">
              ใช้งานอยู่
            </span>
          )}
        </div>
        <code className="text-xs font-mono text-secondary">{apiKey.keyPrefix}…</code>
        <p className="text-xs text-muted">
          สร้างเมื่อ {formatDate(apiKey.createdAt)} · ใช้ล่าสุด {formatDate(apiKey.lastUsedAt)}
        </p>
      </div>

      {!isRevoked && (
        <button
          type="button"
          onClick={() => onRevoke(apiKey)}
          disabled={isActing}
          aria-label={`เพิกถอน ${apiKey.name}`}
          className={[
            "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors shrink-0",
            "focus:outline-none focus:ring-2 focus:ring-danger focus:ring-offset-1",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "border-border text-secondary hover:bg-danger-tint hover:text-danger hover:border-danger-tint bg-surface",
          ].join(" ")}
        >
          <Trash2 size={12} aria-hidden="true" />
          เพิกถอน
        </button>
      )}
    </div>
  );
}

// =============================================================================
// API USAGE HINT — ข้อความนิ่ง อธิบายวิธีเรียก API
// =============================================================================

function ApiUsageHint() {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "https://{your-subdomain}.helpwise.com";

  return (
    <div className="bg-stone rounded-xl border border-border p-4 flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-foreground">วิธีใช้งาน API Key</h3>
      <p className="text-xs text-secondary">
        เรียก API โดยใส่ key ใน header <code className="font-mono">Authorization</code> แบบ Bearer token:
      </p>
      <pre className="text-xs font-mono text-foreground bg-background border border-border rounded-lg p-3 overflow-x-auto">
{`Base URL: ${baseUrl}/api
Authorization: Bearer hw_live_xxxxxxxxxxxxxxxxxxxx`}
      </pre>
    </div>
  );
}

// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function ApiKeysSettingsPage() {
  // ─── data state ────────────────────────────────────────────────────────────
  const [apiKeys, setApiKeys] = useState<ApiKeyDTO[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isForbidden, setIsForbidden] = useState(false);
  const [isFeatureLocked, setIsFeatureLocked] = useState(false);

  // ─── create form state ─────────────────────────────────────────────────────
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ─── plaintext reveal state — เห็นครั้งเดียว ────────────────────────────────
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  // ─── revoke state ──────────────────────────────────────────────────────────
  const [revokingKey, setRevokingKey] = useState<ApiKeyDTO | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // ─── fetch ─────────────────────────────────────────────────────────────────

  const fetchApiKeys = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    setIsForbidden(false);
    setIsFeatureLocked(false);

    try {
      const res = await fetch("/api/api-keys", { credentials: "include" });

      if (res.status === 403) {
        const json = (await res.json()) as ApiKeyListResponse;
        const code = typeof json.error === "object" ? json.error?.code : null;
        if (code === "FEATURE_LOCKED") {
          setIsFeatureLocked(true);
        } else {
          setIsForbidden(true);
        }
        return;
      }

      const json = (await res.json()) as ApiKeyListResponse;

      if (!res.ok || json.error || !json.data) {
        const msg = typeof json.error === "object" ? json.error?.message : json.error;
        setLoadError(msg ?? "โหลดข้อมูล API key ไม่สำเร็จ");
        return;
      }

      setApiKeys(json.data.apiKeys);
    } catch {
      setLoadError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // deferred ผ่าน microtask — กัน setState synchronous ใน effect body
    queueMicrotask(() => void fetchApiKeys());
  }, [fetchApiKeys]);

  // ─── handlers ──────────────────────────────────────────────────────────────

  function handleOpenCreate() {
    setIsFormOpen(true);
    setNewKeyName("");
    setSubmitError(null);
  }

  function handleCloseForm() {
    if (isSubmitting) return;
    setIsFormOpen(false);
    setSubmitError(null);
  }

  async function handleSubmitCreate() {
    if (isSubmitting || !newKeyName.trim()) return;

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName.trim() }),
      });

      const json = (await res.json()) as ApiKeyCreateResponse;

      if (!res.ok || json.error || !json.data) {
        const msg = typeof json.error === "object" ? json.error?.message : json.error;
        setSubmitError(msg ?? "สร้าง API key ไม่สำเร็จ กรุณาลองใหม่");
        return;
      }

      // สร้างสำเร็จ — ปิด form, แสดง plaintext key (ครั้งเดียว), แล้ว refetch
      setIsFormOpen(false);
      setRevealedKey(json.data.plaintextKey);
      await fetchApiKeys();
    } catch {
      setSubmitError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleCloseReveal() {
    // ปิดกล่อง plaintext — ไม่เก็บค่าซ้ำที่ใดอีก
    setRevealedKey(null);
  }

  function handleOpenRevoke(apiKey: ApiKeyDTO) {
    setRevokingKey(apiKey);
    setRevokeError(null);
  }

  async function handleConfirmRevoke() {
    if (!revokingKey || isRevoking) return;
    setIsRevoking(true);
    setRevokeError(null);

    try {
      const res = await fetch(`/api/api-keys/${revokingKey.id}`, {
        method: "DELETE",
        credentials: "include",
      });

      const json = (await res.json()) as ApiKeyRevokeResponse;

      if (!res.ok || json.error || !json.data) {
        const msg = typeof json.error === "object" ? json.error?.message : json.error;
        setRevokeError(msg ?? "เพิกถอนไม่สำเร็จ กรุณาลองใหม่");
        return;
      }

      setRevokingKey(null);
      await fetchApiKeys();
    } catch {
      setRevokeError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsRevoking(false);
    }
  }

  // ─── early return states ────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-foreground">API Keys</h1>
            <p className="mt-1 text-sm text-secondary">จัดการ API key สำหรับเชื่อมต่อระบบภายนอก</p>
          </div>
          <ApiKeysSkeleton />
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
            หน้า API Keys เข้าได้เฉพาะ <strong>OWNER</strong> และ <strong>ADMIN</strong> เท่านั้น
          </p>
        </div>
      </div>
    );
  }

  if (loadError || apiKeys === null) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="bg-surface rounded-xl border border-border p-8 max-w-md w-full text-center">
          <p className="text-danger font-medium mb-4">{loadError ?? "เกิดข้อผิดพลาด"}</p>
          <button
            type="button"
            onClick={() => void fetchApiKeys()}
            className="text-sm text-primary-ink hover:underline focus:outline-none focus:underline"
          >
            ลองใหม่
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col gap-6">

        {/* Page header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-foreground">API Keys</h1>
            <p className="mt-1 text-sm text-secondary">จัดการ API key สำหรับเชื่อมต่อระบบภายนอก</p>
          </div>

          {!isFormOpen && !revealedKey && (
            <button
              type="button"
              onClick={handleOpenCreate}
              className={[
                "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white transition-colors",
                "bg-primary-strong hover:bg-primary-strong-hover",
                "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
              ].join(" ")}
            >
              <Plus size={15} aria-hidden="true" />
              สร้าง API Key ใหม่
            </button>
          )}
        </div>

        {/* Plaintext reveal — ลำดับความสำคัญสูงสุด แสดงทับทุกอย่าง */}
        {revealedKey && (
          <PlaintextReveal plaintextKey={revealedKey} onClose={handleCloseReveal} />
        )}

        {/* Create form */}
        {isFormOpen && !revealedKey && (
          <CreateForm
            name={newKeyName}
            onChangeName={setNewKeyName}
            onSubmit={() => void handleSubmitCreate()}
            onCancel={handleCloseForm}
            isSubmitting={isSubmitting}
            submitError={submitError}
          />
        )}

        {/* Empty state */}
        {apiKeys.length === 0 && !isFormOpen && !revealedKey && (
          <EmptyState onCreateClick={handleOpenCreate} />
        )}

        {/* API key list */}
        {apiKeys.length > 0 && (
          <div className="flex flex-col gap-3" aria-label={`API key ทั้งหมด ${apiKeys.length} รายการ`}>
            {apiKeys.map((apiKey) => (
              <ApiKeyRow
                key={apiKey.id}
                apiKey={apiKey}
                onRevoke={handleOpenRevoke}
                isActing={isRevoking}
              />
            ))}
          </div>
        )}

        {/* Usage hint */}
        <ApiUsageHint />

      </div>

      {/* Revoke confirm modal */}
      {revokingKey && (
        <RevokeConfirmDialog
          apiKey={revokingKey}
          onConfirm={() => void handleConfirmRevoke()}
          onCancel={() => { if (!isRevoking) setRevokingKey(null); }}
          isRevoking={isRevoking}
          revokeError={revokeError}
        />
      )}
    </div>
  );
}
