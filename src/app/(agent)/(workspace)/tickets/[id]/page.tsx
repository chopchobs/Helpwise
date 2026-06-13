"use client";

/**
 * หน้า Ticket Detail (agent) — แสดง thread ทั้งหมด รวม PUBLIC + INTERNAL
 * INTERNAL note แสดงด้วย visual แยกชัดเจน (warning tint + badge "🔒 Internal note")
 * เพื่อให้ agent รู้ชัดว่าลูกค้าไม่เห็นข้อความนั้น
 *
 * Rendering: client fetch เพื่อให้ session cookie + tenant subdomain header ทำงานถูกต้อง
 */

import { useState, useEffect, useCallback, useRef, useTransition } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Lock,
  Send,
  RefreshCw,
  User,
  GitMerge,
  AlertTriangle,
  MessageSquareText,
  X,
} from "lucide-react";
import StatusBadge from "@/components/ui/StatusBadge";
import PriorityBadge from "@/components/ui/PriorityBadge";
import SlaBadge from "@/components/ui/SlaBadge";
import CsatStars from "@/components/ui/CsatStars";
import FormAlert from "@/components/ui/FormAlert";
import {
  formatDateFull,
  getAuthorName,
  isAgentMessage,
} from "@/lib/ticket-ui";
import type {
  AgentTicketDetail,
  AgentTicketDetailResponse,
  AgentPatchTicketResponse,
  AgentPostMessageResponse,
  AgentMergeTicketResponse,
  AgentTicketMessage,
  TicketStatus,
  TicketPriority,
  MessageVisibility,
  MemberListItem,
  MembersResponse,
  MeResponse,
  MemberRole,
} from "@/types/ticket";
import type {
  CannedResponseDTO,
  CannedResponseListResponse,
} from "@/types/canned-response";

// =============================================================================
// CONSTANTS
// =============================================================================

const STATUS_OPTIONS: { value: TicketStatus; label: string }[] = [
  { value: "NEW", label: "ใหม่" },
  { value: "OPEN", label: "เปิด" },
  { value: "PENDING", label: "รอลูกค้า" },
  { value: "ON_HOLD", label: "พัก" },
  { value: "SOLVED", label: "แก้แล้ว" },
  { value: "CLOSED", label: "ปิด" },
];

const PRIORITY_OPTIONS: { value: TicketPriority; label: string }[] = [
  { value: "LOW", label: "ต่ำ" },
  { value: "NORMAL", label: "ปกติ" },
  { value: "HIGH", label: "สูง" },
  { value: "URGENT", label: "เร่งด่วน" },
];

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

interface MessageBubbleProps {
  message: AgentTicketMessage;
}

/**
 * MessageBubble — แสดงข้อความ 1 บรรทัดใน thread
 * INTERNAL note: พื้นหลัง warning-tint พร้อม badge "🔒 Internal note"
 * PUBLIC: แยกซ้าย (ลูกค้า) / ขวา (agent) ตามผู้ส่ง
 */
function MessageBubble({ message }: MessageBubbleProps) {
  const authorName = getAuthorName(message.authorMember, message.authorContact);
  const fromAgent = isAgentMessage(message.authorMember);

  // ─── INTERNAL NOTE ─────────────────────────────────────────────────────────
  // internal note แสดงด้วย visual แยกชัดเจนเพื่อให้ agent รู้ว่าลูกค้าไม่เห็น
  if (message.visibility === "INTERNAL") {
    return (
      <div className="flex flex-col gap-1.5 px-4 py-3 rounded-xl border border-warning-tint bg-warning-tint">
        {/* Badge บอกชัดว่าเป็น internal note */}
        <div className="flex items-center gap-1.5">
          <Lock size={12} className="text-warning" aria-hidden="true" />
          <span className="text-xs font-semibold text-warning-ink">
            Internal note — ลูกค้าไม่เห็น
          </span>
        </div>
        <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
          {message.body}
        </p>
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-secondary">โดย {authorName}</span>
          <span className="text-xs text-secondary">·</span>
          <time
            className="text-xs text-secondary"
            dateTime={message.createdAt}
          >
            {formatDateFull(message.createdAt)}
          </time>
        </div>
      </div>
    );
  }

  // ─── PUBLIC MESSAGE ────────────────────────────────────────────────────────
  // agent → align ขวา, ลูกค้า → align ซ้าย
  if (fromAgent) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[80%] bg-primary-strong text-white rounded-2xl rounded-tr-md px-4 py-3 shadow-sm">
          <p className="text-sm whitespace-pre-wrap leading-relaxed">{message.body}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-secondary">{authorName}</span>
          <span className="text-xs text-secondary">·</span>
          <time className="text-xs text-secondary" dateTime={message.createdAt}>
            {formatDateFull(message.createdAt)}
          </time>
        </div>
      </div>
    );
  }

  // ลูกค้า → ซ้าย
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex items-center gap-2 mb-0.5">
        <div className="w-6 h-6 rounded-full bg-border flex items-center justify-center">
          <User size={12} className="text-secondary" aria-hidden="true" />
        </div>
        <span className="text-xs font-medium text-secondary">{authorName}</span>
      </div>
      <div className="max-w-[80%] bg-surface border border-border rounded-2xl rounded-tl-md px-4 py-3 shadow-sm">
        <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
          {message.body}
        </p>
      </div>
      <time className="text-xs text-secondary ml-8" dateTime={message.createdAt}>
        {formatDateFull(message.createdAt)}
      </time>
    </div>
  );
}

// =============================================================================
// CANNED RESPONSE PICKER
// =============================================================================

interface CannedResponsePickerProps {
  onSelect: (body: string) => void;
  onClose: () => void;
}

/**
 * CannedResponsePicker — dropdown แสดงรายการข้อความสำเร็จรูปให้เลือกแทรกลง reply box
 * fetch เมื่อเปิด picker (ไม่ fetch on mount ของ ReplyBox)
 */
function CannedResponsePicker({ onSelect, onClose }: CannedResponsePickerProps) {
  const [items, setItems] = useState<CannedResponseDTO[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let isCancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/canned-responses", { credentials: "include" });
        const json = (await res.json()) as CannedResponseListResponse;

        if (isCancelled) return;

        if (!res.ok || json.error || !json.data) {
          const msg = typeof json.error === "object" ? json.error?.message : json.error;
          setLoadError(msg ?? "โหลดข้อความสำเร็จรูปไม่สำเร็จ");
          return;
        }

        setItems(json.data.cannedResponses);
      } catch {
        if (!isCancelled) setLoadError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
      }
    })();

    return () => {
      isCancelled = true;
    };
  }, []);

  return (
    <div
      role="menu"
      aria-label="เลือกข้อความสำเร็จรูป"
      className="absolute bottom-full left-0 mb-2 w-72 max-h-72 overflow-y-auto rounded-xl border border-border bg-surface shadow-lg z-10 flex flex-col"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-semibold text-secondary">ข้อความสำเร็จรูป</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="ปิด"
          className="p-1 rounded-md text-muted hover:bg-stone hover:text-secondary focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      {items === null && !loadError && (
        <div className="px-3 py-4 text-sm text-secondary text-center" aria-busy="true">
          กำลังโหลด...
        </div>
      )}

      {loadError && (
        <div className="px-3 py-4 text-sm text-danger text-center">{loadError}</div>
      )}

      {items !== null && items.length === 0 && (
        <div className="px-3 py-4 flex flex-col items-center gap-2 text-center">
          <p className="text-sm text-secondary">ยังไม่มีข้อความสำเร็จรูป</p>
          <Link
            href="/settings/canned-responses"
            className="text-xs text-primary-ink hover:underline focus:outline-none focus:underline"
          >
            ไปสร้างที่ตั้งค่า
          </Link>
        </div>
      )}

      {items !== null && items.length > 0 && (
        <ul role="none" className="flex flex-col p-1">
          {items.map((item) => (
            <li key={item.id} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => onSelect(item.body)}
                className="w-full text-left px-3 py-2 rounded-lg hover:bg-stone focus:outline-none focus:ring-2 focus:ring-primary transition-colors"
              >
                <p className="text-sm font-medium text-foreground truncate">{item.title}</p>
                <p className="text-xs text-secondary truncate">{item.body}</p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// =============================================================================
// REPLY BOX
// =============================================================================

interface ReplyBoxProps {
  ticketId: string;
  onMessageSent: (msg: AgentTicketMessage) => void;
}

/**
 * ReplyBox — ช่องตอบกลับฝั่ง agent
 * มี toggle PUBLIC reply / INTERNAL note
 * ส่ง visibility ตามที่ agent เลือก
 */
function ReplyBox({ ticketId, onMessageSent }: ReplyBoxProps) {
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<MessageVisibility>("PUBLIC");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /** แทรกเนื้อหา canned response ลง textarea — ต่อท้ายด้วย newline ถ้ามีข้อความอยู่แล้ว */
  function handleSelectCannedResponse(cannedBody: string) {
    setBody((prev) => (prev.trim() ? `${prev}\n${cannedBody}` : cannedBody));
    setIsPickerOpen(false);
    textareaRef.current?.focus();
  }

  async function handleSend() {
    // กัน double-submit เมื่อ request กำลัง in-flight (เช่น Ctrl+Enter ยิงซ้ำ)
    if (isSubmitting) return;
    const trimmed = body.trim();
    if (!trimmed) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/tickets/${ticketId}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: trimmed, visibility }),
      });

      const json = (await res.json()) as AgentPostMessageResponse;

      if (!res.ok || json.error) {
        setError(json.error?.message ?? "ส่งข้อความไม่สำเร็จ กรุณาลองใหม่");
        return;
      }

      if (json.data) {
        onMessageSent(json.data);
        setBody("");
      }
    } catch {
      setError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Ctrl+Enter หรือ Cmd+Enter ส่งข้อความ
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      // void เพื่อระบุชัดว่า ignore promise อย่างตั้งใจ (ตามแนวทางเดียวกับ void fetchTickets)
      void handleSend();
    }
  }

  const isInternal = visibility === "INTERNAL";

  return (
    <div
      className={[
        "rounded-xl border p-4 transition-colors",
        isInternal
          ? "border-warning-tint bg-warning-tint"
          : "border-border bg-surface",
      ].join(" ")}
    >
      {/* Toggle PUBLIC / INTERNAL */}
      <div className="flex items-center gap-2 mb-3" role="group" aria-label="ประเภทข้อความ">
        <button
          type="button"
          onClick={() => setVisibility("PUBLIC")}
          aria-pressed={!isInternal}
          className={[
            "px-3 py-1 rounded-full text-xs font-semibold border transition-colors focus:outline-none focus:ring-2 focus:ring-primary",
            !isInternal
              ? "bg-primary-strong text-white border-primary"
              : "bg-surface text-secondary border-border hover:border-primary",
          ].join(" ")}
        >
          Reply สาธารณะ
        </button>
        <button
          type="button"
          onClick={() => setVisibility("INTERNAL")}
          aria-pressed={isInternal}
          className={[
            "inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-semibold border transition-colors focus:outline-none focus:ring-2 focus:ring-warning",
            isInternal
              ? "bg-warning-strong text-white border-warning-strong"
              : "bg-surface text-secondary border-border hover:border-warning",
          ].join(" ")}
        >
          <Lock size={10} aria-hidden="true" />
          Internal note
        </button>
      </div>

      {/* Internal note hint */}
      {isInternal && (
        <p className="text-xs text-warning-ink mb-2 flex items-center gap-1">
          <Lock size={10} aria-hidden="true" />
          ข้อความนี้จะมองเห็นเฉพาะทีม agent เท่านั้น — ลูกค้าไม่เห็น
        </p>
      )}

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={
          isInternal
            ? "เขียน internal note สำหรับทีม..."
            : "พิมพ์ข้อความตอบกลับลูกค้า... (Ctrl+Enter เพื่อส่ง)"
        }
        rows={4}
        aria-label="ข้อความ"
        className={[
          "w-full rounded-lg border px-3 py-2 text-sm text-foreground resize-none",
          "placeholder:text-muted",
          "focus:outline-none focus:ring-2 focus:border-transparent",
          "transition-colors",
          isInternal
            ? "border-warning-tint focus:ring-warning bg-surface"
            : "border-border focus:ring-primary bg-surface",
        ].join(" ")}
      />

      {error && (
        <div className="mt-2">
          <FormAlert variant="error" message={error} />
        </div>
      )}

      <div className="flex justify-between items-center mt-3">
        {/* ปุ่มเปิด canned response picker */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setIsPickerOpen((open) => !open)}
            aria-label="แทรกข้อความสำเร็จรูป"
            aria-haspopup="menu"
            aria-expanded={isPickerOpen}
            className={[
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors",
              "focus:outline-none focus:ring-2 focus:ring-primary",
              "border-border text-secondary hover:bg-stone hover:text-foreground bg-surface",
            ].join(" ")}
          >
            <MessageSquareText size={14} aria-hidden="true" />
            ข้อความสำเร็จรูป
          </button>

          {isPickerOpen && (
            <CannedResponsePicker
              onSelect={handleSelectCannedResponse}
              onClose={() => setIsPickerOpen(false)}
            />
          )}
        </div>

        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={isSubmitting || !body.trim()}
          className={[
            "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white transition-colors",
            "focus:outline-none focus:ring-2 focus:ring-offset-2",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            isInternal
              ? "bg-warning-strong hover:bg-warning-strong-hover focus:ring-warning disabled:hover:bg-warning-strong"
              : "bg-primary-strong hover:bg-primary-strong-hover focus:ring-primary disabled:hover:bg-primary-strong",
          ].join(" ")}
        >
          {isSubmitting ? (
            <RefreshCw size={14} className="animate-spin" aria-hidden="true" />
          ) : (
            <Send size={14} aria-hidden="true" />
          )}
          {isSubmitting ? "กำลังส่ง..." : isInternal ? "บันทึก Note" : "ส่งข้อความ"}
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// MERGED BANNER — แสดงเมื่อ ticket นี้ถูก merge เข้า ticket อื่นแล้ว (read-only)
// =============================================================================

interface MergedBannerProps {
  mergedInto: { id: string; ticketNumber: number };
}

function MergedBanner({ mergedInto }: MergedBannerProps) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-warning-tint bg-warning-tint px-4 py-3 mb-4">
      <GitMerge size={18} className="text-warning-ink shrink-0" aria-hidden="true" />
      <p className="text-sm text-warning-ink">
        Ticket นี้ถูกรวมเข้า{" "}
        <Link
          href={`/tickets/${mergedInto.id}`}
          className="font-semibold underline hover:no-underline"
        >
          #{mergedInto.ticketNumber}
        </Link>{" "}
        และถูกปิดแล้ว (read-only)
      </p>
    </div>
  );
}

// =============================================================================
// MERGE DIALOG — modal ยืนยันการรวม ticket
// =============================================================================

interface MergeDialogProps {
  onConfirm: (targetTicketNumber: number) => void;
  onCancel: () => void;
  isMerging: boolean;
  mergeError: string | null;
}

function MergeDialog({ onConfirm, onCancel, isMerging, mergeError }: MergeDialogProps) {
  const [targetInput, setTargetInput] = useState("");

  function handleConfirm() {
    const targetTicketNumber = Number(targetInput);
    if (!targetInput || Number.isNaN(targetTicketNumber)) return;
    onConfirm(targetTicketNumber);
  }

  const isValid = targetInput.trim() !== "" && !Number.isNaN(Number(targetInput));

  return (
    <>
      {/* backdrop */}
      <div
        className="fixed inset-0 z-40 bg-foreground/30"
        aria-hidden="true"
        onClick={() => !isMerging && onCancel()}
      />
      {/* dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="merge-dialog-title"
        aria-describedby="merge-dialog-desc"
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <div className="bg-surface rounded-xl border border-border shadow-lg p-6 max-w-sm w-full flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-warning-tint flex items-center justify-center shrink-0">
              <GitMerge size={20} className="text-warning-ink" aria-hidden="true" />
            </div>
            <div>
              <h2 id="merge-dialog-title" className="text-base font-bold text-foreground">
                รวม Ticket
              </h2>
              <p id="merge-dialog-desc" className="text-sm text-secondary mt-1">
                ระบุหมายเลข ticket ปลายทางที่ต้องการรวมเข้า
              </p>
            </div>
          </div>

          {/* คำเตือนผลกระทบของการ merge */}
          <div className="rounded-lg border border-warning-tint bg-warning-tint px-3 py-2 flex items-start gap-2">
            <AlertTriangle size={14} className="text-warning-ink shrink-0 mt-0.5" aria-hidden="true" />
            <ul className="text-xs text-warning-ink list-disc pl-4 space-y-0.5">
              <li>ข้อความทั้งหมดจะถูกย้ายไป ticket ปลายทาง</li>
              <li>ticket นี้จะถูกปิดและรวมเข้าปลายทาง</li>
              <li>merge ได้เฉพาะ ticket ของลูกค้าคนเดียวกัน</li>
            </ul>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="merge-target" className="text-xs font-medium text-secondary">
              หมายเลข Ticket ปลายทาง
            </label>
            <input
              id="merge-target"
              type="number"
              min={1}
              value={targetInput}
              onChange={(e) => setTargetInput(e.target.value)}
              placeholder="เช่น 1024"
              disabled={isMerging}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
            />
          </div>

          {mergeError && <FormAlert variant="error" message={mergeError} />}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleConfirm}
              disabled={isMerging || !isValid}
              className={[
                "inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white transition-colors",
                "focus:outline-none focus:ring-2 focus:ring-warning focus:ring-offset-2",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                "bg-warning-strong hover:bg-warning-strong-hover",
              ].join(" ")}
            >
              {isMerging && <RefreshCw size={14} className="animate-spin" aria-hidden="true" />}
              {isMerging ? "กำลังรวม..." : "ยืนยันรวม Ticket"}
            </button>
            <button
              type="button"
              onClick={onCancel}
              disabled={isMerging}
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
// MAIN COMPONENT
// =============================================================================

export default function AgentTicketDetailPage() {
  const params = useParams();
  const router = useRouter();
  const ticketId = params.id as string;

  const [ticket, setTicket] = useState<AgentTicketDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [isPatchingStatus, setIsPatchingStatus] = useState(false);
  const [isPatchingPriority, setIsPatchingPriority] = useState(false);
  const [isPatchingAssignee, setIsPatchingAssignee] = useState(false);
  // รายชื่อ members สำหรับ assignee dropdown
  const [members, setMembers] = useState<MemberListItem[]>([]);
  // role ของ user ปัจจุบัน — ใช้ gate ปุ่ม Merge (เฉพาะ OWNER/ADMIN)
  const [memberRole, setMemberRole] = useState<MemberRole | null>(null);
  const [isMergeDialogOpen, setIsMergeDialogOpen] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const fetchTicket = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/tickets/${ticketId}`, {
        credentials: "include",
      });

      const json = (await res.json()) as AgentTicketDetailResponse;

      if (!res.ok || json.error) {
        if (res.status === 401) {
          setError("กรุณา login ก่อนใช้งาน");
        } else if (res.status === 404) {
          setError("ไม่พบ ticket นี้");
        } else {
          setError(json.error?.message ?? "โหลดข้อมูลไม่สำเร็จ");
        }
        return;
      }

      if (json.data) setTicket(json.data);
    } catch {
      setError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsLoading(false);
    }
  }, [ticketId]);

  // ใช้ startTransition เพื่อหลีกเลี่ยง cascading render ตาม react-hooks/set-state-in-effect
  // startTransition เป็น stable reference — ไม่ต้องใส่ใน deps
  useEffect(() => {
    startTransition(() => { void fetchTicket(); });
  }, [fetchTicket]);

  // โหลด members สำหรับ assignee dropdown เมื่อ mount
  useEffect(() => {
    async function loadMembers() {
      try {
        const res = await fetch("/api/members", { credentials: "include" });
        const json = (await res.json()) as MembersResponse;
        if (res.ok && json.data) {
          setMembers(json.data.members);
        }
      } catch {
        // ไม่ block UI — assignee dropdown จะแสดง list ว่างแต่ยังใช้งานได้
      }
    }
    void loadMembers();
  }, []);

  // โหลด session เพื่อรู้ role ปัจจุบัน — ใช้ gate ปุ่ม Merge
  useEffect(() => {
    async function loadSession() {
      try {
        const res = await fetch("/api/auth/agent/me", { credentials: "include" });
        const json = (await res.json()) as MeResponse;
        if (res.ok && json.data) {
          setMemberRole(json.data.member.role);
        }
      } catch {
        // ไม่ block UI — ปุ่ม Merge จะถูกซ่อนถ้าโหลด role ไม่สำเร็จ
      }
    }
    void loadSession();
  }, []);

  async function handleStatusChange(status: TicketStatus) {
    if (!ticket || isPatchingStatus) return;
    setIsPatchingStatus(true);
    setPatchError(null);

    try {
      const res = await fetch(`/api/tickets/${ticketId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });

      const json = (await res.json()) as AgentPatchTicketResponse;

      if (!res.ok || json.error) {
        setPatchError(json.error?.message ?? "อัปเดต status ไม่สำเร็จ");
        return;
      }

      if (json.data) {
        // capture ไว้ก่อนเข้า setState closure เพื่อหลีกเลี่ยง non-null assertion ใน closure
        const updated = json.data;
        // อัปเดต status + sla (deadline ถูก shift หลัง pause/resume) เพื่อให้ badge ไม่ stale
        setTicket((prev) =>
          prev ? { ...prev, status: updated.status, sla: updated.sla } : prev
        );
      }
    } catch {
      setPatchError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsPatchingStatus(false);
    }
  }

  async function handlePriorityChange(priority: TicketPriority) {
    if (!ticket || isPatchingPriority) return;
    setIsPatchingPriority(true);
    setPatchError(null);

    try {
      const res = await fetch(`/api/tickets/${ticketId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority }),
      });

      const json = (await res.json()) as AgentPatchTicketResponse;

      if (!res.ok || json.error) {
        setPatchError(json.error?.message ?? "อัปเดต priority ไม่สำเร็จ");
        return;
      }

      if (json.data) {
        // capture ไว้ก่อนเข้า setState closure เพื่อหลีกเลี่ยง non-null assertion ใน closure
        const updated = json.data;
        // priority เปลี่ยน → deadline ถูก recompute → อัปเดต sla ด้วย
        setTicket((prev) =>
          prev ? { ...prev, priority: updated.priority, sla: updated.sla } : prev
        );
      }
    } catch {
      setPatchError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsPatchingPriority(false);
    }
  }

  async function handleAssigneeChange(assigneeId: string) {
    if (!ticket || isPatchingAssignee) return;
    setIsPatchingAssignee(true);
    setPatchError(null);

    try {
      const res = await fetch(`/api/tickets/${ticketId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        // ส่ง null เมื่อ assigneeId เป็นสตริงว่าง (unassign)
        body: JSON.stringify({ assigneeId: assigneeId || null }),
      });

      const json = (await res.json()) as AgentPatchTicketResponse;

      if (!res.ok || json.error) {
        setPatchError(json.error?.message ?? "อัปเดต assignee ไม่สำเร็จ");
        return;
      }

      if (json.data) {
        // capture ไว้ก่อนเข้า setState closure เพื่อหลีกเลี่ยง non-null assertion ใน closure
        const updated = json.data;
        setTicket((prev) =>
          prev ? { ...prev, assignee: updated.assignee } : prev
        );
      }
    } catch {
      setPatchError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsPatchingAssignee(false);
    }
  }

  // แปลง error code จาก merge API เป็นข้อความภาษาไทยที่เข้าใจง่าย
  function getMergeErrorMessage(code: string | undefined, fallback: string): string {
    switch (code) {
      case "CANNOT_MERGE_SELF":
        return "รวมเข้าตัวเองไม่ได้";
      case "CANNOT_MERGE_DIFFERENT_REQUESTER":
        return "ลูกค้าผู้แจ้งคนละคน รวมไม่ได้";
      case "TARGET_NOT_FOUND":
        return "ไม่พบ ticket ปลายทาง";
      case "NOT_FOUND":
        return "ไม่พบ ticket นี้";
      case "ALREADY_MERGED":
        return "ticket นี้ถูกรวมไปแล้ว";
      case "TARGET_ALREADY_MERGED":
        return "ticket ปลายทางถูกรวมไปที่อื่นแล้ว รวมไม่ได้";
      case "VALIDATION_ERROR":
        return "หมายเลข ticket ปลายทางไม่ถูกต้อง";
      case "FORBIDDEN":
        return "คุณไม่มีสิทธิ์รวม ticket นี้";
      default:
        return fallback;
    }
  }

  async function handleMergeConfirm(targetTicketNumber: number) {
    if (isMerging) return;
    setIsMerging(true);
    setMergeError(null);

    try {
      const res = await fetch(`/api/tickets/${ticketId}/merge`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetTicketNumber }),
      });

      const json = (await res.json()) as AgentMergeTicketResponse;

      if (!res.ok || json.error || !json.data) {
        setMergeError(
          getMergeErrorMessage(json.error?.code, json.error?.message ?? "รวม ticket ไม่สำเร็จ")
        );
        return;
      }

      // สำเร็จ → ปิด dialog แล้ว navigate ไป target ticket
      setIsMergeDialogOpen(false);
      router.push(`/tickets/${json.data.target.id}`);
    } catch {
      setMergeError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsMerging(false);
    }
  }

  function handleMessageSent(msg: AgentTicketMessage) {
    setTicket((prev) =>
      prev ? { ...prev, messages: [...prev.messages, msg] } : prev
    );
  }

  // ─── Loading ───────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-secondary">
          <RefreshCw size={28} className="animate-spin" aria-hidden="true" />
          <span className="text-sm">กำลังโหลด ticket...</span>
        </div>
      </div>
    );
  }

  // ─── Error ─────────────────────────────────────────────────────────────────
  if (error || !ticket) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="bg-surface rounded-xl border border-border p-8 max-w-md w-full text-center">
          <p className="text-danger font-medium mb-4">{error ?? "เกิดข้อผิดพลาด"}</p>
          <button
            type="button"
            onClick={() => router.push("/tickets")}
            className="text-sm text-primary-ink hover:underline"
          >
            กลับไปหน้า Ticket List
          </button>
        </div>
      </div>
    );
  }

  const requesterName =
    ticket.requesterContact?.name ??
    ticket.requesterContact?.email ??
    "ไม่ระบุ";

  // เฉพาะ OWNER/ADMIN และ ticket ยังไม่ถูก merge เท่านั้นที่เห็นปุ่ม Merge
  const canMerge =
    (memberRole === "OWNER" || memberRole === "ADMIN") && ticket.mergedInto === null;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

        {/* Back button */}
        <button
          type="button"
          onClick={() => router.push("/tickets")}
          className="inline-flex items-center gap-2 text-sm text-secondary hover:text-foreground mb-6 transition-colors focus:outline-none focus:underline"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          กลับไป Ticket List
        </button>

        {/* Banner: ticket นี้ถูก merge เข้า ticket อื่นแล้ว */}
        {ticket.mergedInto !== null && <MergedBanner mergedInto={ticket.mergedInto} />}

        {/* Ticket header */}
        <div className="bg-surface rounded-xl border border-border p-6 mb-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-semibold text-secondary">
                #{ticket.ticketNumber}
              </span>
              <StatusBadge status={ticket.status} />
              <PriorityBadge priority={ticket.priority} />
              {/* SLA badge เด่นใกล้ status — แสดง deadline label เต็ม */}
              <SlaBadge sla={ticket.sla} />
            </div>

            {/* ปุ่มรวม ticket — เฉพาะ OWNER/ADMIN และยังไม่ถูก merge */}
            {canMerge && (
              <button
                type="button"
                onClick={() => setIsMergeDialogOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-border text-secondary hover:bg-stone hover:text-foreground transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <GitMerge size={14} aria-hidden="true" />
                รวม Ticket
              </button>
            )}
          </div>

          <h1 className="text-xl font-bold text-foreground leading-snug mb-4">
            {ticket.subject}
          </h1>

          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-secondary">
            <span>
              ผู้แจ้ง: <span className="text-foreground font-medium">{requesterName}</span>
            </span>
          </div>

          {/* Indicator: ticket นี้เป็นปลายทางของ ticket อื่นที่ merge เข้ามา */}
          {ticket.mergedFrom.length > 0 && (
            <p className="text-xs text-muted mt-2">
              รวมจาก:{" "}
              {ticket.mergedFrom.map((source, idx) => (
                <span key={source.id}>
                  {idx > 0 && ", "}
                  <Link href={`/tickets/${source.id}`} className="text-primary-ink hover:underline">
                    #{source.ticketNumber}
                  </Link>
                </span>
              ))}
            </p>
          )}

          {/* CSAT result — แสดงเฉพาะเมื่อลูกค้าให้คะแนนแล้ว */}
          {ticket.csat && (
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border">
              <span className="text-sm text-secondary">คะแนนความพึงพอใจ:</span>
              <CsatStars rating={ticket.csat.rating} showValue />
              {ticket.csat.comment && (
                <span className="text-sm text-secondary italic truncate">
                  “{ticket.csat.comment}”
                </span>
              )}
            </div>
          )}

          {/* Controls: เปลี่ยน status + priority + assignee */}
          <div className="flex flex-wrap gap-3 mt-4 pt-4 border-t border-border">
            <div className="flex flex-col gap-1">
              <label htmlFor="ctrl-status" className="text-xs font-medium text-secondary">
                เปลี่ยนสถานะ
              </label>
              <select
                id="ctrl-status"
                value={ticket.status}
                disabled={isPatchingStatus}
                onChange={(e) => handleStatusChange(e.target.value as TicketStatus)}
                className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
              >
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label htmlFor="ctrl-priority" className="text-xs font-medium text-secondary">
                เปลี่ยน Priority
              </label>
              <select
                id="ctrl-priority"
                value={ticket.priority}
                disabled={isPatchingPriority}
                onChange={(e) => handlePriorityChange(e.target.value as TicketPriority)}
                className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
              >
                {PRIORITY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Assignee dropdown — รูปแบบเดียวกับ status/priority control */}
            <div className="flex flex-col gap-1">
              <label htmlFor="ctrl-assignee" className="text-xs font-medium text-secondary">
                ผู้รับผิดชอบ
              </label>
              <select
                id="ctrl-assignee"
                value={ticket.assignee?.id ?? ""}
                disabled={isPatchingAssignee}
                onChange={(e) => void handleAssigneeChange(e.target.value)}
                className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
              >
                <option value="">ยังไม่มอบหมาย</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.user.name ?? m.user.email}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {patchError && (
            <div className="mt-3">
              <FormAlert variant="error" message={patchError} />
            </div>
          )}
        </div>

        {/* Message thread */}
        <div className="bg-surface rounded-xl border border-border shadow-sm overflow-hidden mb-4">
          <div className="px-6 py-4 border-b border-border bg-stone">
            <h2 className="text-sm font-semibold text-foreground">
              Messages ({ticket.messages.length})
            </h2>
            {/* คำอธิบาย legend สำหรับ agent */}
            <p className="text-xs text-secondary mt-0.5">
              ข้อความที่มีพื้นหลังสีเหลือง/ส้มอ่อน = Internal note (ลูกค้าไม่เห็น)
            </p>
          </div>

          <div className="px-6 py-4 flex flex-col gap-4">
            {ticket.messages.length === 0 ? (
              <p className="text-sm text-secondary text-center py-8">
                ยังไม่มีข้อความ
              </p>
            ) : (
              ticket.messages.map((msg) => (
                <MessageBubble key={msg.id} message={msg} />
              ))
            )}
          </div>
        </div>

        {/* Reply box — ซ่อนเมื่อ ticket ถูก merge แล้ว (read-only) */}
        {ticket.mergedInto === null && (
          <ReplyBox ticketId={ticketId} onMessageSent={handleMessageSent} />
        )}
      </div>

      {/* Merge dialog */}
      {isMergeDialogOpen && (
        <MergeDialog
          onConfirm={(targetTicketNumber) => void handleMergeConfirm(targetTicketNumber)}
          onCancel={() => { setMergeError(null); setIsMergeDialogOpen(false); }}
          isMerging={isMerging}
          mergeError={mergeError}
        />
      )}
    </div>
  );
}
