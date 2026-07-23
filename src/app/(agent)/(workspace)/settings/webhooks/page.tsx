"use client";

/**
 * หน้า Webhooks Settings (agent — OWNER/ADMIN เท่านั้น)
 * จัดการ outbound webhook endpoint: สร้าง (secret เห็นครั้งเดียว), เปิด/ปิด, หมุน secret, ลบ
 * + แผง Deliveries (DLQ) สำหรับดูประวัติการส่งและสั่ง replay
 *
 * contract: docs/webhooks-contract.md § 7 (REST paths + DTO), § 3 (event list), § 5 (delivery status)
 * ⚠️ plaintext secret แสดงครั้งเดียวหลัง create/rotate — ไม่เก็บ ไม่ refetch (DTO ไม่มี field secret)
 */

import { useState, useEffect, useCallback, useId } from "react";
import {
  Webhook,
  Plus,
  Trash2,
  ShieldAlert,
  Lock,
  RefreshCw,
  RotateCcw,
  AlertTriangle,
  Copy,
  Check,
  Play,
  ExternalLink,
} from "lucide-react";
import Link from "next/link";
import FormAlert from "@/components/ui/FormAlert";
import WebhookDeliveryBadge from "@/components/ui/WebhookDeliveryBadge";
import type {
  WebhookEndpointDTO,
  WebhookDeliveryDTO,
  WebhookEventType,
  WebhookDeliveryStatus,
  WebhookWireEventName,
  WebhookEndpointListResponse,
  WebhookEndpointCreateResponse,
  WebhookDeliveryListResponse,
} from "@/types/webhook";
import type { ApiError } from "@/types/ticket";

// =============================================================================
// CONSTANTS
// =============================================================================

const DESCRIPTION_MAX_LENGTH = 80;
const DELIVERY_TAKE = 25;

interface WebhookEventOption {
  value: WebhookEventType;
  /** wire name ที่ส่งใน envelope field `type` — แสดงให้ผู้ใช้เห็นตรง ๆ (§ 3) */
  wire: WebhookWireEventName;
  label: string;
}

/** ทั้ง 5 event ตาม contract § 3 */
const WEBHOOK_EVENT_OPTIONS: WebhookEventOption[] = [
  { value: "TICKET_CREATED",          wire: "ticket.created",           label: "มี ticket ใหม่" },
  { value: "TICKET_STATUS_CHANGED",   wire: "ticket.status_changed",    label: "สถานะ ticket เปลี่ยน" },
  { value: "TICKET_ASSIGNED",         wire: "ticket.assigned",          label: "มอบหมาย ticket" },
  { value: "TICKET_PRIORITY_CHANGED", wire: "ticket.priority_changed",  label: "ความสำคัญเปลี่ยน" },
  { value: "TICKET_MESSAGE_CREATED",  wire: "ticket.message_created",   label: "ข้อความสาธารณะใหม่" },
];

/** lookup enum → wire name สำหรับแสดง chip บนการ์ด */
const EVENT_WIRE_NAMES: Record<WebhookEventType, string> = {
  TICKET_CREATED:          "ticket.created",
  TICKET_STATUS_CHANGED:   "ticket.status_changed",
  TICKET_ASSIGNED:         "ticket.assigned",
  TICKET_PRIORITY_CHANGED: "ticket.priority_changed",
  TICKET_MESSAGE_CREATED:  "ticket.message_created",
};

type DeliveryStatusFilter = "ALL" | WebhookDeliveryStatus;

const DELIVERY_STATUS_FILTERS: { value: DeliveryStatusFilter; label: string }[] = [
  { value: "ALL",       label: "ทั้งหมด" },
  { value: "PENDING",   label: "รอส่ง" },
  { value: "SUCCEEDED", label: "สำเร็จ" },
  { value: "FAILED",    label: "ล้มเหลว" },
  { value: "DEAD",      label: "หมดสิทธิ์ retry (DLQ)" },
];

// =============================================================================
// LOCAL RESPONSE TYPES — endpoint ที่ contract ไม่ได้ประกาศ DTO ไว้ใน types/webhook.ts
// =============================================================================

/** PATCH / DELETE endpoint และ POST replay — สนใจแค่ error, ข้อมูลจริง refetch เอา */
interface WebhookMutationResponse {
  data: unknown;
  error: ApiError | null;
}

/** POST /api/webhook-endpoints/[id]/rotate-secret */
interface WebhookRotateSecretResponse {
  data: { plaintextSecret: string } | null;
  error: ApiError | null;
}

// =============================================================================
// HELPERS
// =============================================================================

/** format วันที่เป็น th-TH สั้น ๆ */
function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** แปลง error code จาก API เป็นข้อความไทยที่ผู้ใช้เข้าใจ (fallback = message จาก server) */
function translateApiError(error: ApiError | null | undefined, fallback: string): string {
  switch (error?.code) {
    case "FEATURE_LOCKED":
      return "ฟีเจอร์ Webhooks ไม่รวมในแผนปัจจุบัน กรุณาอัปเกรดที่หน้า Billing";
    case "INVALID_WEBHOOK_URL":
      return "URL ปลายทางใช้ไม่ได้ — ต้องเป็น https และห้ามชี้ไปเครือข่ายภายใน (localhost / IP ภายใน)";
    case "NOT_FOUND":
      return "ไม่พบรายการนี้ — อาจถูกลบไปแล้ว กรุณารีเฟรช";
    case "ALREADY_SUCCEEDED":
      return "delivery นี้ส่งสำเร็จไปแล้ว ไม่ต้อง replay ซ้ำ";
    case "VALIDATION_ERROR":
      return error.message || "ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง";
    case "FORBIDDEN":
    case "UNAUTHORIZED":
      return "ไม่มีสิทธิ์ดำเนินการนี้ — เฉพาะ OWNER/ADMIN เท่านั้น";
    default:
      return error?.message ?? fallback;
  }
}

// =============================================================================
// SKELETON
// =============================================================================

function WebhooksSkeleton() {
  return (
    <div className="animate-pulse flex flex-col gap-4" aria-busy="true" aria-label="กำลังโหลด...">
      <div className="flex justify-between items-center">
        <div className="h-6 bg-stone rounded w-40" />
        <div className="h-9 bg-stone rounded-lg w-36" />
      </div>
      {[1, 2].map((i) => (
        <div key={i} className="h-24 bg-stone rounded-xl" />
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
          <h2 className="text-base font-bold text-foreground">Webhooks ไม่รวมใน Plan ปัจจุบัน</h2>
          <p className="text-sm text-secondary mt-2">
            อัปเกรดแผนเพื่อให้ Helpwise ส่ง event ของ ticket ไปยังระบบภายนอกของคุณแบบอัตโนมัติ
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
        <Webhook size={24} className="text-primary" aria-hidden="true" />
      </div>
      <div>
        <h3 className="text-base font-semibold text-foreground">ยังไม่มี webhook endpoint</h3>
        <p className="text-sm text-secondary mt-1">
          สร้าง endpoint แรกเพื่อให้ระบบภายนอกรับ event ของ ticket แบบเรียลไทม์
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
        สร้าง Endpoint แรก
      </button>
    </div>
  );
}

// =============================================================================
// CREATE FORM
// =============================================================================

interface CreateFormValues {
  description: string;
  url: string;
  events: WebhookEventType[];
}

const EMPTY_FORM: CreateFormValues = { description: "", url: "", events: [] };

interface CreateFormProps {
  values: CreateFormValues;
  onChange: (values: CreateFormValues) => void;
  onSubmit: () => void;
  onCancel: () => void;
  isSubmitting: boolean;
  submitError: string | null;
}

function CreateForm({ values, onChange, onSubmit, onCancel, isSubmitting, submitError }: CreateFormProps) {
  const baseId = useId();

  function handleToggleEvent(event: WebhookEventType) {
    const nextEvents = values.events.includes(event)
      ? values.events.filter((e) => e !== event)
      : [...values.events, event];
    onChange({ ...values, events: nextEvents });
  }

  return (
    <div className="bg-surface rounded-xl border border-border p-6 flex flex-col gap-4">
      <h3 className="text-base font-bold text-foreground">สร้าง Webhook Endpoint ใหม่</h3>

      {/* ชื่อ/คำอธิบาย */}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${baseId}-description`} className="text-sm font-medium text-foreground">
          ชื่อเรียก <span className="text-danger" aria-hidden="true">*</span>
        </label>
        <input
          id={`${baseId}-description`}
          type="text"
          value={values.description}
          onChange={(e) => onChange({ ...values, description: e.target.value })}
          disabled={isSubmitting}
          maxLength={DESCRIPTION_MAX_LENGTH}
          placeholder="เช่น CRM sync, Slack notifier"
          className={[
            "w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm",
            "focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary",
            "disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-muted",
          ].join(" ")}
          required
          aria-required="true"
        />
      </div>

      {/* URL ปลายทาง */}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${baseId}-url`} className="text-sm font-medium text-foreground">
          URL ปลายทาง <span className="text-danger" aria-hidden="true">*</span>
        </label>
        <input
          id={`${baseId}-url`}
          type="url"
          value={values.url}
          onChange={(e) => onChange({ ...values, url: e.target.value })}
          disabled={isSubmitting}
          placeholder="https://example.com/hooks/helpwise"
          aria-describedby={`${baseId}-url-hint`}
          className={[
            "w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm font-mono",
            "focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary",
            "disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-muted",
          ].join(" ")}
          required
          aria-required="true"
        />
        <span id={`${baseId}-url-hint`} className="text-xs text-muted">
          ต้องเป็น https และเข้าถึงได้จากอินเทอร์เน็ต (ระบบไม่ยิงไปเครือข่ายภายใน)
        </span>
      </div>

      {/* event ที่ subscribe */}
      <fieldset className="flex flex-col gap-2 border-0 p-0 m-0">
        <legend className="text-sm font-medium text-foreground mb-1">Event ที่ต้องการรับ</legend>
        <div className="flex flex-col gap-2">
          {WEBHOOK_EVENT_OPTIONS.map((option) => (
            <label
              key={option.value}
              htmlFor={`${baseId}-event-${option.value}`}
              className="flex items-center gap-2.5 text-sm text-foreground cursor-pointer"
            >
              <input
                id={`${baseId}-event-${option.value}`}
                type="checkbox"
                checked={values.events.includes(option.value)}
                onChange={() => handleToggleEvent(option.value)}
                disabled={isSubmitting}
                className="w-4 h-4 accent-primary focus:outline-none focus:ring-2 focus:ring-primary rounded disabled:cursor-not-allowed"
              />
              <code className="font-mono text-xs text-primary-ink">{option.wire}</code>
              <span className="text-xs text-secondary">— {option.label}</span>
            </label>
          ))}
        </div>
        {values.events.length === 0 && (
          <p className="text-xs text-warning-ink">
            ยังไม่ได้เลือก event — endpoint นี้จะไม่ได้รับอะไรเลย
          </p>
        )}
      </fieldset>

      {submitError && <FormAlert variant="error" message={submitError} />}

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={onSubmit}
          disabled={isSubmitting || !values.description.trim() || !values.url.trim()}
          className={[
            "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white transition-colors",
            "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "bg-primary-strong hover:bg-primary-strong-hover",
          ].join(" ")}
        >
          {isSubmitting && <RefreshCw size={14} className="animate-spin" aria-hidden="true" />}
          {isSubmitting ? "กำลังสร้าง..." : "สร้าง Endpoint"}
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
// SECRET REVEAL — แสดงครั้งเดียวหลัง create / rotate สำเร็จ
// =============================================================================

interface SecretRevealProps {
  secret: string;
  title: string;
  onClose: () => void;
}

function SecretReveal({ secret, title, onClose }: SecretRevealProps) {
  const [isCopied, setIsCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(secret);
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
          <h3 className="text-base font-bold text-foreground">{title}</h3>
          <p className="text-sm text-warning-ink mt-1 font-medium">
            คัดลอกเก็บไว้เดี๋ยวนี้ — จะไม่แสดงอีก
          </p>
          <p className="text-xs text-secondary mt-1">
            ใช้ secret นี้ตรวจลายเซ็นใน header <code className="font-mono">X-Helpwise-Signature</code> ฝั่งผู้รับ
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 p-3 rounded-lg bg-background border border-border">
        <code className="flex-1 text-sm font-mono text-foreground break-all select-all">
          {secret}
        </code>
        <button
          type="button"
          onClick={() => void handleCopy()}
          aria-label="คัดลอก signing secret"
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
// ENDPOINT CARD
// =============================================================================

interface EndpointCardProps {
  endpoint: WebhookEndpointDTO;
  isActing: boolean;
  isConfirmingDelete: boolean;
  actionError: string | null;
  onToggleEnabled: (endpoint: WebhookEndpointDTO) => void;
  onRotateSecret: (endpoint: WebhookEndpointDTO) => void;
  onRequestDelete: (endpoint: WebhookEndpointDTO) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (endpoint: WebhookEndpointDTO) => void;
}

function EndpointCard({
  endpoint,
  isActing,
  isConfirmingDelete,
  actionError,
  onToggleEnabled,
  onRotateSecret,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: EndpointCardProps) {
  return (
    <div className="bg-surface rounded-xl border border-border p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-foreground">{endpoint.description}</h3>
            {endpoint.enabled ? (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-success-tint text-success border border-success-tint">
                เปิดใช้งาน
              </span>
            ) : (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-stone text-muted border border-border">
                ปิดอยู่
              </span>
            )}
          </div>
          <code className="text-xs font-mono text-secondary break-all">{endpoint.url}</code>
          <p className="text-xs text-muted">สร้างเมื่อ {formatDateTime(endpoint.createdAt)}</p>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* toggle enabled */}
          <button
            type="button"
            role="switch"
            aria-checked={endpoint.enabled}
            aria-label={`${endpoint.enabled ? "ปิด" : "เปิด"}การใช้งาน ${endpoint.description}`}
            disabled={isActing}
            onClick={() => onToggleEnabled(endpoint)}
            className={[
              "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors",
              "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "border-border text-secondary hover:bg-stone hover:text-foreground bg-surface",
            ].join(" ")}
          >
            {endpoint.enabled ? "ปิดใช้งาน" : "เปิดใช้งาน"}
          </button>

          {/* rotate secret */}
          <button
            type="button"
            aria-label={`หมุน signing secret ของ ${endpoint.description}`}
            disabled={isActing}
            onClick={() => onRotateSecret(endpoint)}
            className={[
              "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors",
              "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "border-border text-secondary hover:bg-stone hover:text-foreground bg-surface",
            ].join(" ")}
          >
            <RotateCcw size={12} aria-hidden="true" />
            หมุน secret
          </button>

          {/* delete */}
          <button
            type="button"
            aria-label={`ลบ endpoint ${endpoint.description}`}
            disabled={isActing || isConfirmingDelete}
            onClick={() => onRequestDelete(endpoint)}
            className={[
              "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors",
              "focus:outline-none focus:ring-2 focus:ring-danger focus:ring-offset-1",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "border-border text-secondary hover:bg-danger-tint hover:text-danger hover:border-danger-tint bg-surface",
            ].join(" ")}
          >
            <Trash2 size={12} aria-hidden="true" />
            ลบ
          </button>
        </div>
      </div>

      {/* event chips */}
      {endpoint.events.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={`event ที่ ${endpoint.description} รับ`} role="list">
          {endpoint.events.map((event) => (
            <li
              key={event}
              className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono bg-stone text-secondary border border-border"
            >
              {EVENT_WIRE_NAMES[event]}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-warning-ink">ยังไม่ได้เลือก event — endpoint นี้จะไม่ได้รับอะไรเลย</p>
      )}

      {actionError && <FormAlert variant="error" message={actionError} />}

      {/* ยืนยันลบแบบ inline ในการ์ด (ไม่ใช้ native confirm) */}
      {isConfirmingDelete && (
        <div
          role="alert"
          className="rounded-lg border border-danger-tint bg-danger-tint p-3 flex items-center justify-between gap-3 flex-wrap"
        >
          <p className="text-xs text-foreground">
            ลบ <strong>&quot;{endpoint.description}&quot;</strong> ใช่ไหม? ประวัติการส่งทั้งหมดของ endpoint นี้จะถูกลบด้วย และย้อนกลับไม่ได้
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              autoFocus
              disabled={isActing}
              onClick={() => onConfirmDelete(endpoint)}
              className={[
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white transition-colors",
                "focus:outline-none focus:ring-2 focus:ring-danger focus:ring-offset-1",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                "bg-danger hover:bg-danger/90",
              ].join(" ")}
            >
              {isActing && <RefreshCw size={12} className="animate-spin" aria-hidden="true" />}
              {isActing ? "กำลังลบ..." : "ยืนยันลบ"}
            </button>
            <button
              type="button"
              disabled={isActing}
              onClick={onCancelDelete}
              className={[
                "px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors",
                "border-border text-secondary hover:bg-stone hover:text-foreground bg-surface",
                "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              ].join(" ")}
            >
              ยกเลิก
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// DELIVERIES PANEL (DLQ) — เลือก endpoint + filter status + replay
// =============================================================================

interface DeliveryRowProps {
  delivery: WebhookDeliveryDTO;
  isReplaying: boolean;
  onReplay: (delivery: WebhookDeliveryDTO) => void;
}

function DeliveryRow({ delivery, isReplaying, onReplay }: DeliveryRowProps) {
  // replay ได้เฉพาะ delivery ที่ยังไม่สำเร็จ (contract § 5)
  const canReplay = delivery.status !== "SUCCEEDED";

  return (
    <tr className="border-t border-border align-top">
      <td className="px-3 py-2 text-xs font-mono text-secondary whitespace-nowrap">
        {EVENT_WIRE_NAMES[delivery.eventType]}
      </td>
      <td className="px-3 py-2">
        <WebhookDeliveryBadge status={delivery.status} />
      </td>
      <td className="px-3 py-2 text-xs text-secondary tabular-nums">{delivery.attemptCount}</td>
      <td className="px-3 py-2 text-xs text-secondary tabular-nums">
        {delivery.responseStatus ?? "—"}
      </td>
      <td className="px-3 py-2 text-xs text-muted whitespace-nowrap">
        {formatDateTime(delivery.lastAttemptAt)}
      </td>
      <td className="px-3 py-2 text-right">
        {canReplay && (
          <button
            type="button"
            disabled={isReplaying}
            onClick={() => onReplay(delivery)}
            aria-label={`ส่งซ้ำ ${EVENT_WIRE_NAMES[delivery.eventType]}`}
            className={[
              "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors",
              "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "border-border text-secondary hover:bg-stone hover:text-foreground bg-surface",
            ].join(" ")}
          >
            {isReplaying ? (
              <RefreshCw size={12} className="animate-spin" aria-hidden="true" />
            ) : (
              <Play size={12} aria-hidden="true" />
            )}
            ส่งซ้ำ
          </button>
        )}
      </td>
    </tr>
  );
}

interface DeliveriesPanelProps {
  endpoints: WebhookEndpointDTO[];
}

function DeliveriesPanel({ endpoints }: DeliveriesPanelProps) {
  const baseId = useId();

  const [selectedEndpointId, setSelectedEndpointId] = useState("");
  const [statusFilter, setStatusFilter] = useState<DeliveryStatusFilter>("ALL");

  const [deliveries, setDeliveries] = useState<WebhookDeliveryDTO[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);

  const fetchDeliveries = useCallback(
    async (signal?: AbortSignal) => {
      if (!selectedEndpointId) {
        setDeliveries(null);
        setLoadError(null);
        return;
      }

      setIsLoading(true);
      setLoadError(null);

      try {
        const params = new URLSearchParams({
          endpointId: selectedEndpointId,
          take: String(DELIVERY_TAKE),
        });
        if (statusFilter !== "ALL") params.set("status", statusFilter);

        const res = await fetch(`/api/webhook-deliveries?${params.toString()}`, {
          credentials: "include",
          signal,
        });
        const json = (await res.json()) as WebhookDeliveryListResponse;

        if (!res.ok || json.error || !json.data) {
          setLoadError(translateApiError(json.error, "โหลดประวัติการส่งไม่สำเร็จ"));
          return;
        }

        setDeliveries(json.data.deliveries);
      } catch {
        // request ที่ถูกยกเลิก (เปลี่ยน filter เร็ว ๆ) ไม่ถือเป็น error ของผู้ใช้
        if (signal?.aborted) return;
        setLoadError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
      } finally {
        if (!signal?.aborted) setIsLoading(false);
      }
    },
    [selectedEndpointId, statusFilter]
  );

  useEffect(() => {
    // abort request เก่าเมื่อเปลี่ยน endpoint/filter — กัน response เก่ามาทับของใหม่
    const controller = new AbortController();
    // deferred ผ่าน microtask — กัน setState synchronous ใน effect body
    queueMicrotask(() => void fetchDeliveries(controller.signal));
    return () => controller.abort();
  }, [fetchDeliveries]);

  async function handleReplay(delivery: WebhookDeliveryDTO) {
    if (replayingId) return;
    setReplayingId(delivery.id);
    setReplayError(null);

    try {
      const res = await fetch(`/api/webhook-deliveries/${delivery.id}/replay`, {
        method: "POST",
        credentials: "include",
      });
      const json = (await res.json()) as WebhookMutationResponse;

      if (!res.ok || json.error) {
        setReplayError(translateApiError(json.error, "สั่งส่งซ้ำไม่สำเร็จ กรุณาลองใหม่"));
        return;
      }

      await fetchDeliveries();
    } catch {
      setReplayError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setReplayingId(null);
    }
  }

  return (
    <section className="bg-surface rounded-xl border border-border p-6 flex flex-col gap-4" aria-labelledby={`${baseId}-title`}>
      <div>
        <h2 id={`${baseId}-title`} className="text-base font-bold text-foreground">
          ประวัติการส่ง (Deliveries)
        </h2>
        <p className="text-sm text-secondary mt-1">
          ดูผลการส่งแต่ละ event และสั่งส่งซ้ำรายการที่ล้มเหลว
        </p>
      </div>

      {/* filter bar */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1 min-w-52">
          <label htmlFor={`${baseId}-endpoint`} className="text-xs font-medium text-foreground">
            Endpoint
          </label>
          <select
            id={`${baseId}-endpoint`}
            value={selectedEndpointId}
            onChange={(e) => setSelectedEndpointId(e.target.value)}
            className={[
              "px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm",
              "focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary",
            ].join(" ")}
          >
            <option value="">— เลือก endpoint —</option>
            {endpoints.map((endpoint) => (
              <option key={endpoint.id} value={endpoint.id}>
                {endpoint.description}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={`${baseId}-status`} className="text-xs font-medium text-foreground">
            สถานะ
          </label>
          <select
            id={`${baseId}-status`}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as DeliveryStatusFilter)}
            className={[
              "px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm",
              "focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary",
            ].join(" ")}
          >
            {DELIVERY_STATUS_FILTERS.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={() => void fetchDeliveries()}
          disabled={!selectedEndpointId || isLoading}
          className={[
            "inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border transition-colors",
            "border-border text-secondary hover:bg-stone hover:text-foreground bg-surface",
            "focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          ].join(" ")}
        >
          <RefreshCw size={12} className={isLoading ? "animate-spin" : ""} aria-hidden="true" />
          รีเฟรช
        </button>
      </div>

      {replayError && <FormAlert variant="error" message={replayError} />}
      {loadError && <FormAlert variant="error" message={loadError} />}

      {/* states */}
      {!selectedEndpointId && (
        <p className="text-sm text-muted py-6 text-center">
          เลือก endpoint เพื่อดูประวัติการส่ง
        </p>
      )}

      {selectedEndpointId && isLoading && (
        <div className="animate-pulse flex flex-col gap-2" aria-busy="true" aria-label="กำลังโหลด...">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-9 bg-stone rounded-lg" />
          ))}
        </div>
      )}

      {selectedEndpointId && !isLoading && !loadError && deliveries?.length === 0 && (
        <p className="text-sm text-muted py-6 text-center">
          ยังไม่มีประวัติการส่งที่ตรงกับเงื่อนไขนี้
        </p>
      )}

      {selectedEndpointId && !isLoading && deliveries && deliveries.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <caption className="sr-only">
              ประวัติการส่ง webhook ล่าสุดสูงสุด {DELIVERY_TAKE} รายการ
            </caption>
            <thead>
              <tr className="text-xs font-semibold text-muted uppercase tracking-wide">
                <th scope="col" className="px-3 py-2">Event</th>
                <th scope="col" className="px-3 py-2">สถานะ</th>
                <th scope="col" className="px-3 py-2">ครั้งที่ส่ง</th>
                <th scope="col" className="px-3 py-2">HTTP</th>
                <th scope="col" className="px-3 py-2">ส่งล่าสุด</th>
                <th scope="col" className="px-3 py-2 text-right">การทำงาน</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <DeliveryRow
                  key={delivery.id}
                  delivery={delivery}
                  isReplaying={replayingId === delivery.id}
                  onReplay={(item) => void handleReplay(item)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function WebhooksSettingsPage() {
  // ─── data state ────────────────────────────────────────────────────────────
  const [endpoints, setEndpoints] = useState<WebhookEndpointDTO[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isForbidden, setIsForbidden] = useState(false);
  const [isFeatureLocked, setIsFeatureLocked] = useState(false);

  // ─── create form state ─────────────────────────────────────────────────────
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [formValues, setFormValues] = useState<CreateFormValues>(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ─── secret reveal state — เห็นครั้งเดียว ไม่เก็บที่อื่น ────────────────────
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [revealTitle, setRevealTitle] = useState("");

  // ─── per-endpoint action state ─────────────────────────────────────────────
  const [actingEndpointId, setActingEndpointId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);

  // ─── fetch ─────────────────────────────────────────────────────────────────

  const fetchEndpoints = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    setIsForbidden(false);
    setIsFeatureLocked(false);

    try {
      const res = await fetch("/api/webhook-endpoints", { credentials: "include" });
      const json = (await res.json()) as WebhookEndpointListResponse;

      if (res.status === 403) {
        if (json.error?.code === "FEATURE_LOCKED") {
          setIsFeatureLocked(true);
        } else {
          setIsForbidden(true);
        }
        return;
      }

      if (!res.ok || json.error || !json.data) {
        setLoadError(translateApiError(json.error, "โหลดข้อมูล webhook ไม่สำเร็จ"));
        return;
      }

      setEndpoints(json.data.endpoints);
    } catch {
      setLoadError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // deferred ผ่าน microtask — กัน setState synchronous ใน effect body
    queueMicrotask(() => void fetchEndpoints());
  }, [fetchEndpoints]);

  // ─── create ────────────────────────────────────────────────────────────────

  function handleOpenCreate() {
    setIsFormOpen(true);
    setFormValues(EMPTY_FORM);
    setSubmitError(null);
  }

  function handleCloseForm() {
    if (isSubmitting) return;
    setIsFormOpen(false);
    setSubmitError(null);
  }

  async function handleSubmitCreate() {
    if (isSubmitting || !formValues.description.trim() || !formValues.url.trim()) return;

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch("/api/webhook-endpoints", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: formValues.description.trim(),
          url: formValues.url.trim(),
          events: formValues.events,
        }),
      });

      const json = (await res.json()) as WebhookEndpointCreateResponse;

      if (!res.ok || json.error || !json.data) {
        setSubmitError(translateApiError(json.error, "สร้าง endpoint ไม่สำเร็จ กรุณาลองใหม่"));
        return;
      }

      // สำเร็จ — ปิดฟอร์ม แล้วโชว์ secret ครั้งเดียว
      setIsFormOpen(false);
      setRevealTitle("สร้าง Webhook Endpoint สำเร็จ");
      setRevealedSecret(json.data.plaintextSecret);
      await fetchEndpoints();
    } catch {
      setSubmitError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsSubmitting(false);
    }
  }

  // ─── endpoint actions ──────────────────────────────────────────────────────

  async function handleToggleEnabled(endpoint: WebhookEndpointDTO) {
    if (actingEndpointId) return;
    setActingEndpointId(endpoint.id);
    setActionError(null);

    try {
      const res = await fetch(`/api/webhook-endpoints/${endpoint.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !endpoint.enabled }),
      });
      const json = (await res.json()) as WebhookMutationResponse;

      if (!res.ok || json.error) {
        setActionError({
          id: endpoint.id,
          message: translateApiError(json.error, "เปลี่ยนสถานะไม่สำเร็จ กรุณาลองใหม่"),
        });
        return;
      }

      await fetchEndpoints();
    } catch {
      setActionError({ id: endpoint.id, message: "ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่" });
    } finally {
      setActingEndpointId(null);
    }
  }

  async function handleRotateSecret(endpoint: WebhookEndpointDTO) {
    if (actingEndpointId) return;
    setActingEndpointId(endpoint.id);
    setActionError(null);

    try {
      const res = await fetch(`/api/webhook-endpoints/${endpoint.id}/rotate-secret`, {
        method: "POST",
        credentials: "include",
      });
      const json = (await res.json()) as WebhookRotateSecretResponse;

      if (!res.ok || json.error || !json.data) {
        setActionError({
          id: endpoint.id,
          message: translateApiError(json.error, "หมุน secret ไม่สำเร็จ กรุณาลองใหม่"),
        });
        return;
      }

      setRevealTitle(`หมุน secret ของ "${endpoint.description}" สำเร็จ`);
      setRevealedSecret(json.data.plaintextSecret);
    } catch {
      setActionError({ id: endpoint.id, message: "ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่" });
    } finally {
      setActingEndpointId(null);
    }
  }

  async function handleConfirmDelete(endpoint: WebhookEndpointDTO) {
    if (actingEndpointId) return;
    setActingEndpointId(endpoint.id);
    setActionError(null);

    try {
      const res = await fetch(`/api/webhook-endpoints/${endpoint.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      const json = (await res.json()) as WebhookMutationResponse;

      if (!res.ok || json.error) {
        setActionError({
          id: endpoint.id,
          message: translateApiError(json.error, "ลบไม่สำเร็จ กรุณาลองใหม่"),
        });
        return;
      }

      setConfirmingDeleteId(null);
      await fetchEndpoints();
    } catch {
      setActionError({ id: endpoint.id, message: "ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่" });
    } finally {
      setActingEndpointId(null);
    }
  }

  // ─── early return states ───────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="mb-6">
            <h1 className="text-2xl font-bold text-foreground">Webhooks</h1>
            <p className="mt-1 text-sm text-secondary">ส่ง event ของ ticket ไปยังระบบภายนอกอัตโนมัติ</p>
          </div>
          <WebhooksSkeleton />
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
            หน้า Webhooks เข้าได้เฉพาะ <strong>OWNER</strong> และ <strong>ADMIN</strong> เท่านั้น
          </p>
        </div>
      </div>
    );
  }

  if (loadError || endpoints === null) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="bg-surface rounded-xl border border-border p-8 max-w-md w-full text-center">
          <p className="text-danger font-medium mb-4">{loadError ?? "เกิดข้อผิดพลาด"}</p>
          <button
            type="button"
            onClick={() => void fetchEndpoints()}
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
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col gap-6">

        {/* Page header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="max-w-xl">
            <h1 className="text-2xl font-bold text-foreground">Webhooks</h1>
            <p className="mt-1 text-sm text-secondary">
              เมื่อมี event เกิดขึ้นกับ ticket (สร้างใหม่ เปลี่ยนสถานะ มอบหมาย ฯลฯ) Helpwise
              จะยิง HTTP POST พร้อมลายเซ็นไปยัง URL ที่คุณกำหนด — ใช้เชื่อมระบบภายนอกโดยไม่ต้อง poll API
            </p>
          </div>

          {!isFormOpen && !revealedSecret && (
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
              สร้าง Endpoint ใหม่
            </button>
          )}
        </div>

        {/* Secret reveal — สำคัญสุด แสดงเหนือทุกอย่าง */}
        {revealedSecret && (
          <SecretReveal
            secret={revealedSecret}
            title={revealTitle}
            onClose={() => setRevealedSecret(null)}
          />
        )}

        {/* Create form */}
        {isFormOpen && !revealedSecret && (
          <CreateForm
            values={formValues}
            onChange={setFormValues}
            onSubmit={() => void handleSubmitCreate()}
            onCancel={handleCloseForm}
            isSubmitting={isSubmitting}
            submitError={submitError}
          />
        )}

        {/* Empty state */}
        {endpoints.length === 0 && !isFormOpen && !revealedSecret && (
          <EmptyState onCreateClick={handleOpenCreate} />
        )}

        {/* Endpoint list */}
        {endpoints.length > 0 && (
          <div
            className="flex flex-col gap-3"
            aria-label={`webhook endpoint ทั้งหมด ${endpoints.length} รายการ`}
          >
            {endpoints.map((endpoint) => (
              <EndpointCard
                key={endpoint.id}
                endpoint={endpoint}
                isActing={actingEndpointId === endpoint.id}
                isConfirmingDelete={confirmingDeleteId === endpoint.id}
                actionError={actionError?.id === endpoint.id ? actionError.message : null}
                onToggleEnabled={(item) => void handleToggleEnabled(item)}
                onRotateSecret={(item) => void handleRotateSecret(item)}
                onRequestDelete={(item) => {
                  setConfirmingDeleteId(item.id);
                  setActionError(null);
                }}
                onCancelDelete={() => setConfirmingDeleteId(null)}
                onConfirmDelete={(item) => void handleConfirmDelete(item)}
              />
            ))}
          </div>
        )}

        {/* Deliveries (DLQ) — มีความหมายเมื่อมี endpoint แล้วเท่านั้น */}
        {endpoints.length > 0 && <DeliveriesPanel endpoints={endpoints} />}

      </div>
    </div>
  );
}
