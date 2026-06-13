"use client";

/**
 * หน้า Canned Responses Settings (agent — ทุก role อ่านได้, AGENT+ จัดการได้)
 * แสดงรายการข้อความสำเร็จรูป + สร้าง/แก้ไข/ลบ
 * VIEWER จะไม่เห็นปุ่มจัดการ (backend enforce ซ้ำอยู่แล้ว)
 */

import { useState, useEffect, useCallback, useId } from "react";
import {
  MessageSquareText,
  Plus,
  Pencil,
  Trash2,
  RefreshCw,
  X,
  AlertTriangle,
} from "lucide-react";
import FormAlert from "@/components/ui/FormAlert";
import type {
  CannedResponseDTO,
  CannedResponseListResponse,
  CannedResponseMutationResponse,
  CannedResponseDeleteResponse,
} from "@/types/canned-response";
import type { MeResponse, MemberRole } from "@/types/ticket";

// =============================================================================
// CONSTANTS
// =============================================================================

const TITLE_MAX_LENGTH = 120;
const BODY_MAX_LENGTH = 10000;
const BODY_PREVIEW_LENGTH = 160;

// =============================================================================
// TYPES
// =============================================================================

/** form mode — create ใหม่ หรือ edit รายการที่มีอยู่ */
type FormMode = { kind: "create" } | { kind: "edit"; item: CannedResponseDTO };

interface FormValues {
  title: string;
  body: string;
}

const EMPTY_FORM: FormValues = { title: "", body: "" };

// =============================================================================
// HELPERS
// =============================================================================

/** validate ฝั่ง client ก่อน submit — return error string หรือ null */
function validateForm(values: FormValues): string | null {
  if (!values.title.trim()) return "กรุณาระบุชื่อข้อความสำเร็จรูป";
  if (values.title.length > TITLE_MAX_LENGTH) return `ชื่อต้องไม่เกิน ${TITLE_MAX_LENGTH} ตัวอักษร`;
  if (!values.body.trim()) return "กรุณาระบุเนื้อหาข้อความ";
  if (values.body.length > BODY_MAX_LENGTH) return `เนื้อหาต้องไม่เกิน ${BODY_MAX_LENGTH} ตัวอักษร`;
  return null;
}

/** ตัดเนื้อหาให้สั้นลงสำหรับแสดง preview ในรายการ */
function truncateBody(body: string): string {
  if (body.length <= BODY_PREVIEW_LENGTH) return body;
  return `${body.slice(0, BODY_PREVIEW_LENGTH)}…`;
}

/** format วันที่แบบไทยสั้น ๆ */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("th-TH", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// =============================================================================
// SKELETON
// =============================================================================

function CannedResponseSkeleton() {
  return (
    <div className="animate-pulse flex flex-col gap-4" aria-busy="true" aria-label="กำลังโหลด...">
      <div className="flex justify-between items-center">
        <div className="h-6 bg-stone rounded w-48" />
        <div className="h-9 bg-stone rounded-lg w-36" />
      </div>
      {[1, 2, 3].map((i) => (
        <div key={i} className="h-24 bg-stone rounded-xl" />
      ))}
    </div>
  );
}

// =============================================================================
// ITEM CARD
// =============================================================================

interface ItemCardProps {
  item: CannedResponseDTO;
  canManage: boolean;
  onEdit: (item: CannedResponseDTO) => void;
  onDelete: (item: CannedResponseDTO) => void;
  isActing: boolean;
}

function ItemCard({ item, canManage, onEdit, onDelete, isActing }: ItemCardProps) {
  return (
    <div className="bg-surface rounded-xl border border-border p-4 flex items-start justify-between gap-3 flex-wrap">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-sm font-bold text-foreground">{item.title}</h3>
          <span className="text-xs text-muted">{formatDate(item.createdAt)}</span>
        </div>
        <p className="text-sm text-secondary mt-1 whitespace-pre-wrap break-words">
          {truncateBody(item.body)}
        </p>
      </div>

      {canManage && (
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            title="แก้ไข"
            aria-label={`แก้ไข ${item.title}`}
            disabled={isActing}
            onClick={() => onEdit(item)}
            className={[
              "p-1.5 rounded-lg border border-border text-secondary hover:bg-stone hover:text-foreground bg-surface transition-colors",
              "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1",
              "disabled:opacity-50 disabled:cursor-not-allowed",
            ].join(" ")}
          >
            <Pencil size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            title={`ลบ ${item.title}`}
            aria-label={`ลบ ${item.title}`}
            disabled={isActing}
            onClick={() => onDelete(item)}
            className={[
              "p-1.5 rounded-lg border border-border text-secondary hover:bg-danger-tint hover:text-danger hover:border-danger-tint bg-surface transition-colors",
              "focus:outline-none focus:ring-2 focus:ring-danger focus:ring-offset-1",
              "disabled:opacity-50 disabled:cursor-not-allowed",
            ].join(" ")}
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// FORM — ใช้ทั้ง create และ edit
// =============================================================================

interface ItemFormProps {
  mode: FormMode;
  values: FormValues;
  onChange: (values: FormValues) => void;
  onSubmit: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
  submitError: string | null;
}

function ItemForm({ mode, values, onChange, onSubmit, onCancel, isSubmitting, submitError }: ItemFormProps) {
  const baseId = useId();
  const isEditing = mode.kind === "edit";

  return (
    <div className="bg-surface rounded-xl border border-border p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-bold text-foreground">
          {isEditing ? "แก้ไขข้อความสำเร็จรูป" : "สร้างข้อความสำเร็จรูปใหม่"}
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

      {/* ชื่อ */}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${baseId}-title`} className="text-sm font-medium text-foreground">
          ชื่อ <span className="text-danger" aria-hidden="true">*</span>
        </label>
        <input
          id={`${baseId}-title`}
          type="text"
          value={values.title}
          onChange={(e) => onChange({ ...values, title: e.target.value })}
          disabled={isSubmitting}
          maxLength={TITLE_MAX_LENGTH}
          placeholder="เช่น ขอบคุณที่ติดต่อเรา"
          className={[
            "w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm",
            "focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary",
            "disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-muted",
          ].join(" ")}
          required
          aria-required="true"
        />
      </div>

      {/* เนื้อหา */}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${baseId}-body`} className="text-sm font-medium text-foreground">
          เนื้อหา <span className="text-danger" aria-hidden="true">*</span>
        </label>
        <textarea
          id={`${baseId}-body`}
          value={values.body}
          onChange={(e) => onChange({ ...values, body: e.target.value })}
          disabled={isSubmitting}
          maxLength={BODY_MAX_LENGTH}
          rows={6}
          placeholder="พิมพ์เนื้อหาข้อความที่จะใช้ตอบลูกค้า..."
          className={[
            "w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm resize-y",
            "focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary",
            "disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-muted",
          ].join(" ")}
          required
          aria-required="true"
        />
        <span className="text-xs text-muted self-end">
          {values.body.length.toLocaleString("th-TH")} / {BODY_MAX_LENGTH.toLocaleString("th-TH")}
        </span>
      </div>

      {submitError && <FormAlert variant="error" message={submitError} />}

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
          {isSubmitting ? "กำลังบันทึก..." : isEditing ? "บันทึกการแก้ไข" : "สร้าง"}
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
// DELETE CONFIRM DIALOG
// =============================================================================

interface DeleteConfirmProps {
  item: CannedResponseDTO;
  onConfirm: () => void;
  onCancel: () => void;
  isDeleting: boolean;
  deleteError: string | null;
}

function DeleteConfirmDialog({ item, onConfirm, onCancel, isDeleting, deleteError }: DeleteConfirmProps) {
  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-foreground/30"
        aria-hidden="true"
        onClick={() => !isDeleting && onCancel()}
      />
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
                ลบข้อความสำเร็จรูป
              </h2>
              <p id="delete-dialog-desc" className="text-sm text-secondary mt-1">
                ต้องการลบ <strong className="text-foreground">&quot;{item.title}&quot;</strong> ใช่ไหม?
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
              {isDeleting ? "กำลังลบ..." : "ลบ"}
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
// EMPTY STATE
// =============================================================================

function EmptyState({ canManage, onCreateClick }: { canManage: boolean; onCreateClick: () => void }) {
  return (
    <div className="bg-surface rounded-xl border border-border p-10 text-center flex flex-col items-center gap-4">
      <div className="w-12 h-12 rounded-full bg-primary-tint flex items-center justify-center">
        <MessageSquareText size={24} className="text-primary" aria-hidden="true" />
      </div>
      <div>
        <h3 className="text-base font-semibold text-foreground">ยังไม่มีข้อความสำเร็จรูป</h3>
        <p className="text-sm text-secondary mt-1">
          สร้างอันแรกเพื่อใช้ตอบ ticket ได้เร็วขึ้น
        </p>
      </div>
      {canManage && (
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
          สร้างข้อความแรก
        </button>
      )}
    </div>
  );
}

// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function CannedResponsesSettingsPage() {
  // ─── data state ────────────────────────────────────────────────────────────
  const [items, setItems] = useState<CannedResponseDTO[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ─── role gate ─────────────────────────────────────────────────────────────
  const [memberRole, setMemberRole] = useState<MemberRole | null>(null);

  // ─── form state ────────────────────────────────────────────────────────────
  const [formMode, setFormMode] = useState<FormMode | null>(null);
  const [formValues, setFormValues] = useState<FormValues>(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ─── delete confirm ────────────────────────────────────────────────────────
  const [deletingItem, setDeletingItem] = useState<CannedResponseDTO | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ─── fetch list ────────────────────────────────────────────────────────────

  const fetchItems = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);

    try {
      const res = await fetch("/api/canned-responses", { credentials: "include" });
      const json = (await res.json()) as CannedResponseListResponse;

      if (!res.ok || json.error || !json.data) {
        const msg = typeof json.error === "object" ? json.error?.message : json.error;
        setLoadError(msg ?? "โหลดข้อความสำเร็จรูปไม่สำเร็จ");
        return;
      }

      setItems(json.data.cannedResponses);
    } catch {
      setLoadError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // deferred ผ่าน microtask — กัน setState synchronous ใน effect body
    queueMicrotask(() => void fetchItems());
  }, [fetchItems]);

  // ─── fetch role (สำหรับซ่อนปุ่มจัดการให้ VIEWER) ────────────────────────────

  useEffect(() => {
    queueMicrotask(() => {
      void (async () => {
        try {
          const res = await fetch("/api/auth/agent/me", { credentials: "include" });
          const json = (await res.json()) as MeResponse;
          if (res.ok && json.data) {
            setMemberRole(json.data.member.role);
          }
        } catch {
          // เงียบ — ถ้า fetch ไม่สำเร็จถือว่า readonly (ปลอดภัยกว่า)
        }
      })();
    });
  }, []);

  const canManage = memberRole !== null && memberRole !== "VIEWER";

  // ─── handlers ──────────────────────────────────────────────────────────────

  function handleOpenCreate() {
    setFormMode({ kind: "create" });
    setFormValues(EMPTY_FORM);
    setSubmitError(null);
  }

  function handleOpenEdit(item: CannedResponseDTO) {
    setFormMode({ kind: "edit", item });
    setFormValues({ title: item.title, body: item.body });
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
      const body = { title: formValues.title.trim(), body: formValues.body };

      let res: Response;
      if (formMode.kind === "create") {
        res = await fetch("/api/canned-responses", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        res = await fetch(`/api/canned-responses/${formMode.item.id}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }

      const json = (await res.json()) as CannedResponseMutationResponse;

      if (!res.ok || json.error || !json.data) {
        const msg = typeof json.error === "object" ? json.error?.message : json.error;
        setSubmitError(msg ?? "บันทึกไม่สำเร็จ กรุณาลองใหม่");
        return;
      }

      setFormMode(null);
      await fetchItems();
    } catch {
      setSubmitError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleOpenDelete(item: CannedResponseDTO) {
    setDeletingItem(item);
    setDeleteError(null);
  }

  async function handleConfirmDelete() {
    if (!deletingItem || isDeleting) return;
    setIsDeleting(true);
    setDeleteError(null);

    try {
      const res = await fetch(`/api/canned-responses/${deletingItem.id}`, {
        method: "DELETE",
        credentials: "include",
      });

      const json = (await res.json()) as CannedResponseDeleteResponse;

      if (!res.ok || json.error || !json.data) {
        const msg = typeof json.error === "object" ? json.error?.message : json.error;
        setDeleteError(msg ?? "ลบไม่สำเร็จ กรุณาลองใหม่");
        return;
      }

      setDeletingItem(null);
      await fetchItems();
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
            <h1 className="text-2xl font-bold text-foreground">ข้อความสำเร็จรูป</h1>
            <p className="mt-1 text-sm text-secondary">จัดการข้อความที่ใช้ตอบลูกค้าซ้ำ ๆ ได้รวดเร็ว</p>
          </div>
          <CannedResponseSkeleton />
        </div>
      </div>
    );
  }

  if (loadError || items === null) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="bg-surface rounded-xl border border-border p-8 max-w-md w-full text-center">
          <p className="text-danger font-medium mb-4">{loadError ?? "เกิดข้อผิดพลาด"}</p>
          <button
            type="button"
            onClick={() => void fetchItems()}
            className="text-sm text-primary-ink hover:underline focus:outline-none focus:underline"
          >
            ลองใหม่
          </button>
        </div>
      </div>
    );
  }

  const isFormOpen = formMode !== null;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

        {/* Page header */}
        <div className="flex items-start justify-between gap-4 flex-wrap mb-6">
          <div>
            <h1 className="text-2xl font-bold text-foreground">ข้อความสำเร็จรูป</h1>
            <p className="mt-1 text-sm text-secondary">
              จัดการข้อความที่ใช้ตอบลูกค้าซ้ำ ๆ ได้รวดเร็ว ({items.length})
            </p>
          </div>

          {canManage && !isFormOpen && (
            <button
              type="button"
              onClick={handleOpenCreate}
              className={[
                "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white transition-colors",
                "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
                "bg-primary-strong hover:bg-primary-strong-hover",
              ].join(" ")}
            >
              <Plus size={15} aria-hidden="true" />
              สร้างใหม่
            </button>
          )}
        </div>

        {/* Form */}
        {isFormOpen && formMode && (
          <div className="mb-6">
            <ItemForm
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
        {items.length === 0 && !isFormOpen && (
          <EmptyState canManage={canManage} onCreateClick={handleOpenCreate} />
        )}

        {/* List */}
        {items.length > 0 && (
          <div className="flex flex-col gap-3" aria-label={`ข้อความสำเร็จรูปทั้งหมด ${items.length} รายการ`}>
            {items.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                canManage={canManage}
                onEdit={handleOpenEdit}
                onDelete={handleOpenDelete}
                isActing={isDeleting}
              />
            ))}
          </div>
        )}

      </div>

      {deletingItem && (
        <DeleteConfirmDialog
          item={deletingItem}
          onConfirm={() => void handleConfirmDelete()}
          onCancel={() => { if (!isDeleting) setDeletingItem(null); }}
          isDeleting={isDeleting}
          deleteError={deleteError}
        />
      )}
    </div>
  );
}
