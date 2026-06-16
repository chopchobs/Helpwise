"use client";

/**
 * หน้า Tags Settings (agent-only)
 * OWNER/ADMIN เท่านั้นจัดการ CRUD ได้ — AGENT/VIEWER เห็น list แบบ read-only
 * เลียน pattern canned-responses/page.tsx
 */

import { useState, useEffect, useCallback, useId } from "react";
import {
  Tags,
  Plus,
  Pencil,
  Trash2,
  RefreshCw,
  X,
  AlertTriangle,
} from "lucide-react";
import FormAlert from "@/components/ui/FormAlert";
import TagChip from "@/components/ui/TagChip";
import type {
  TagDTO,
  TagColor,
  TagListResponse,
  TagMutationResponse,
  TagDeleteResponse,
} from "@/types/tag";
import { TAG_COLORS } from "@/types/tag";
import type { MeResponse, MemberRole } from "@/types/ticket";

// =============================================================================
// CONSTANTS
// =============================================================================

const NAME_MAX_LENGTH = 50;

/** label แสดงชื่อสีภาษาไทย */
const TAG_COLOR_LABELS: Record<TagColor, string> = {
  GRAY:       "เทา",
  TERRACOTTA: "Terracotta",
  SAGE:       "เขียว Sage",
  AMBER:      "Amber",
  SIENNA:     "Sienna",
  SAND:       "Sand",
};

// =============================================================================
// TYPES
// =============================================================================

type FormMode = { kind: "create" } | { kind: "edit"; item: TagDTO };

interface FormValues {
  name: string;
  color: TagColor;
}

const EMPTY_FORM: FormValues = { name: "", color: "GRAY" };

// =============================================================================
// HELPERS
// =============================================================================

function validateForm(values: FormValues): string | null {
  if (!values.name.trim()) return "กรุณาระบุชื่อ tag";
  if (values.name.length > NAME_MAX_LENGTH) return `ชื่อต้องไม่เกิน ${NAME_MAX_LENGTH} ตัวอักษร`;
  return null;
}

// =============================================================================
// COLOR PICKER SWATCH (static class per color — Tailwind เห็นครบ)
// =============================================================================

/** Swatch classes รวม border/ring ด้วยเพื่อ selected state */
const SWATCH_BG_CLASSES: Record<TagColor, string> = {
  GRAY:       "bg-stone border-border",
  TERRACOTTA: "bg-primary border-primary",
  SAGE:       "bg-success border-success",
  AMBER:      "bg-warning border-warning",
  SIENNA:     "bg-danger border-danger",
  SAND:       "bg-sand border-sand",
};

interface ColorPickerProps {
  value: TagColor;
  onChange: (color: TagColor) => void;
  disabled?: boolean;
}

function ColorPicker({ value, onChange, disabled }: ColorPickerProps) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="เลือกสี tag">
      {TAG_COLORS.map((color) => {
        const isSelected = color === value;
        return (
          <button
            key={color}
            type="button"
            disabled={disabled}
            onClick={() => onChange(color)}
            aria-label={`สี ${TAG_COLOR_LABELS[color]}`}
            aria-pressed={isSelected}
            className={[
              "w-7 h-7 rounded-full border-2 transition-all focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1",
              SWATCH_BG_CLASSES[color],
              isSelected ? "ring-2 ring-offset-2 ring-foreground scale-110" : "hover:scale-105",
              disabled ? "opacity-50 cursor-not-allowed" : "",
            ].join(" ")}
          />
        );
      })}
    </div>
  );
}

// =============================================================================
// SKELETON
// =============================================================================

function TagSkeleton() {
  return (
    <div className="animate-pulse flex flex-col gap-4" aria-busy="true" aria-label="กำลังโหลด...">
      <div className="flex justify-between items-center">
        <div className="h-6 bg-stone rounded w-24" />
        <div className="h-9 bg-stone rounded-lg w-28" />
      </div>
      {[1, 2, 3].map((i) => (
        <div key={i} className="h-16 bg-stone rounded-xl" />
      ))}
    </div>
  );
}

// =============================================================================
// ITEM CARD
// =============================================================================

interface ItemCardProps {
  item: TagDTO;
  canManage: boolean;
  onEdit: (item: TagDTO) => void;
  onDelete: (item: TagDTO) => void;
  isActing: boolean;
}

function ItemCard({ item, canManage, onEdit, onDelete, isActing }: ItemCardProps) {
  return (
    <div className="bg-surface rounded-xl border border-border px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-3">
        <TagChip tag={item} />
      </div>

      {canManage && (
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            title="แก้ไข"
            aria-label={`แก้ไข tag ${item.name}`}
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
            title={`ลบ tag ${item.name}`}
            aria-label={`ลบ tag ${item.name}`}
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
          {isEditing ? "แก้ไข Tag" : "สร้าง Tag ใหม่"}
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

      {/* ชื่อ tag */}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${baseId}-name`} className="text-sm font-medium text-foreground">
          ชื่อ tag <span className="text-danger" aria-hidden="true">*</span>
        </label>
        <input
          id={`${baseId}-name`}
          type="text"
          value={values.name}
          onChange={(e) => onChange({ ...values, name: e.target.value })}
          disabled={isSubmitting}
          maxLength={NAME_MAX_LENGTH}
          placeholder="เช่น VIP, refund-risk, billing"
          className={[
            "w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm",
            "focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary",
            "disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-muted",
          ].join(" ")}
          required
          aria-required="true"
        />
        <span className="text-xs text-muted self-end">
          {values.name.length} / {NAME_MAX_LENGTH}
        </span>
      </div>

      {/* color picker */}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-foreground">สี</span>
        <ColorPicker
          value={values.color}
          onChange={(color) => onChange({ ...values, color })}
          disabled={isSubmitting}
        />
        {/* preview chip ตาม color ที่เลือก */}
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-muted">Preview:</span>
          <TagChip tag={{ id: "preview", name: values.name || "ตัวอย่าง", color: values.color }} />
        </div>
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
  item: TagDTO;
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
        aria-labelledby="delete-tag-title"
        aria-describedby="delete-tag-desc"
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <div className="bg-surface rounded-xl border border-border shadow-lg p-6 max-w-sm w-full flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-danger-tint flex items-center justify-center shrink-0">
              <AlertTriangle size={20} className="text-danger" aria-hidden="true" />
            </div>
            <div>
              <h2 id="delete-tag-title" className="text-base font-bold text-foreground">
                ลบ Tag
              </h2>
              <p id="delete-tag-desc" className="text-sm text-secondary mt-1">
                ต้องการลบ tag{" "}
                <strong className="text-foreground">&quot;{item.name}&quot;</strong> ใช่ไหม?
                tag จะถูกถอดออกจาก ticket ทั้งหมด
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
        <Tags size={24} className="text-primary" aria-hidden="true" />
      </div>
      <div>
        <h3 className="text-base font-semibold text-foreground">ยังไม่มี Tag</h3>
        <p className="text-sm text-secondary mt-1">
          สร้าง tag เพื่อจัดกลุ่ม ticket ได้ง่ายขึ้น
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
          สร้าง Tag แรก
        </button>
      )}
    </div>
  );
}

// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function TagsSettingsPage() {
  // ─── data state ────────────────────────────────────────────────────────────
  const [items, setItems] = useState<TagDTO[] | null>(null);
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
  const [deletingItem, setDeletingItem] = useState<TagDTO | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ─── fetch list ────────────────────────────────────────────────────────────

  const fetchItems = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);

    try {
      const res = await fetch("/api/tags", { credentials: "include" });
      const json = (await res.json()) as TagListResponse;

      if (!res.ok || json.error || !json.data) {
        const msg = typeof json.error === "object" ? json.error?.message : json.error;
        setLoadError(msg ?? "โหลด tag ไม่สำเร็จ");
        return;
      }

      setItems(json.data.tags);
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

  // ─── fetch role (สำหรับซ่อนปุ่มจัดการ ให้เฉพาะ OWNER/ADMIN) ──────────────

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

  // เฉพาะ OWNER/ADMIN เท่านั้นที่จัดการ tag ได้
  const canManage = memberRole === "OWNER" || memberRole === "ADMIN";

  // ─── handlers ──────────────────────────────────────────────────────────────

  function handleOpenCreate() {
    setFormMode({ kind: "create" });
    setFormValues(EMPTY_FORM);
    setSubmitError(null);
  }

  function handleOpenEdit(item: TagDTO) {
    setFormMode({ kind: "edit", item });
    setFormValues({ name: item.name, color: item.color });
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
      const payload = { name: formValues.name.trim(), color: formValues.color };

      let res: Response;
      if (formMode.kind === "create") {
        res = await fetch("/api/tags", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        res = await fetch(`/api/tags/${formMode.item.id}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }

      const json = (await res.json()) as TagMutationResponse;

      if (!res.ok || json.error || !json.data) {
        // handle 409 TAG_NAME_EXISTS แยกต่างหาก
        if (json.error?.code === "TAG_NAME_EXISTS") {
          setSubmitError("ชื่อ tag ซ้ำ กรุณาใช้ชื่ออื่น");
          return;
        }
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

  function handleOpenDelete(item: TagDTO) {
    setDeletingItem(item);
    setDeleteError(null);
  }

  async function handleConfirmDelete() {
    if (!deletingItem || isDeleting) return;
    setIsDeleting(true);
    setDeleteError(null);

    try {
      const res = await fetch(`/api/tags/${deletingItem.id}`, {
        method: "DELETE",
        credentials: "include",
      });

      const json = (await res.json()) as TagDeleteResponse;

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
            <h1 className="text-2xl font-bold text-foreground">Tags</h1>
            <p className="mt-1 text-sm text-secondary">จัดกลุ่ม ticket ด้วย tag</p>
          </div>
          <TagSkeleton />
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
            <h1 className="text-2xl font-bold text-foreground">Tags</h1>
            <p className="mt-1 text-sm text-secondary">
              จัดกลุ่ม ticket ด้วย tag ({items.length})
            </p>
            {!canManage && memberRole !== null && (
              <p className="mt-1 text-xs text-muted">
                เฉพาะ OWNER/ADMIN เท่านั้นที่สร้าง/แก้ไข/ลบ tag ได้
              </p>
            )}
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
          <div
            className="flex flex-col gap-2"
            aria-label={`tag ทั้งหมด ${items.length} รายการ`}
          >
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
