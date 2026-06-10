"use client";

/**
 * หน้า Ticket Detail (portal) — แสดง message thread สาธารณะ + กล่องตอบกลับ
 *
 * ⚠️ SECURITY NOTE (defense in depth):
 * หน้านี้ไม่มีโค้ดใดๆ ที่เกี่ยวกับ visibility / INTERNAL / internal note เลย
 * backend API /api/portal/tickets/:id คืนเฉพาะ PUBLIC messages
 * portal UI ไม่รู้จักและไม่สนใจ concept ของ "internal note" เลย
 *
 * Rendering: client fetch เพื่อให้ session cookie + tenant subdomain ทำงานถูกต้อง
 */

import { useState, useEffect, useCallback, useTransition } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Send, RefreshCw, User } from "lucide-react";
import StatusBadge from "@/components/ui/StatusBadge";
import FormAlert from "@/components/ui/FormAlert";
import CsatSurvey, { CsatThankYou } from "@/components/portal/CsatSurvey";
import { formatDateFull, getAuthorName, isAgentMessage } from "@/lib/ticket-ui";
import type {
  PortalTicketDetail,
  PortalTicketDetailResponse,
  PortalPostMessageResponse,
  PortalTicketMessage,
} from "@/types/ticket";
import type { CsatResponseDTO } from "@/types/csat";

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

interface PortalMessageBubbleProps {
  message: PortalTicketMessage;
}

/**
 * PortalMessageBubble — แสดงข้อความ 1 บรรทัดใน portal thread
 * แยกซ้าย (support team) / ขวา (ฉัน/ลูกค้า) ตามผู้ส่ง
 * ไม่มี logic ใดๆ เกี่ยวกับ visibility ทั้งสิ้น
 */
function PortalMessageBubble({ message }: PortalMessageBubbleProps) {
  const authorName = getAuthorName(message.authorMember, message.authorContact);
  const fromSupport = isAgentMessage(message.authorMember);

  if (fromSupport) {
    // ข้อความจากทีม support → align ซ้าย พื้นหลัง primary-tint
    return (
      <div className="flex flex-col items-start gap-1">
        <div className="flex items-center gap-2 mb-0.5">
          <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center">
            <User size={13} className="text-white" aria-hidden="true" />
          </div>
          <span className="text-xs font-medium text-secondary">
            {authorName} · ทีม Support
          </span>
        </div>
        <div className="max-w-[80%] bg-primary-tint border border-primary-tint rounded-2xl rounded-tl-md px-4 py-3">
          <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
            {message.body}
          </p>
        </div>
        <time className="text-xs text-secondary ml-9" dateTime={message.createdAt}>
          {formatDateFull(message.createdAt)}
        </time>
      </div>
    );
  }

  // ข้อความจากฉัน → align ขวา
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[80%] bg-surface border border-border rounded-2xl rounded-tr-md px-4 py-3 shadow-sm">
        <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
          {message.body}
        </p>
      </div>
      <time className="text-xs text-secondary" dateTime={message.createdAt}>
        {formatDateFull(message.createdAt)}
      </time>
    </div>
  );
}

// =============================================================================
// PORTAL REPLY BOX
// =============================================================================

interface PortalReplyBoxProps {
  ticketId: string;
  /** isClosed = true เฉพาะ CLOSED — SOLVED ยังตอบได้ (backend reopen อัตโนมัติ) */
  isClosed: boolean;
  isSolved: boolean;
  onMessageSent: (msg: PortalTicketMessage) => void;
}

/**
 * PortalReplyBox — ช่องตอบกลับฝั่ง portal
 * ส่งเฉพาะ body — ไม่มี visibility field เลย (backend บังคับ PUBLIC)
 */
function PortalReplyBox({ ticketId, isClosed, isSolved, onMessageSent }: PortalReplyBoxProps) {
  const [body, setBody] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend() {
    // กัน double-submit เมื่อ request กำลัง in-flight (เช่น Ctrl+Enter ยิงซ้ำ)
    if (isSubmitting) return;
    const trimmed = body.trim();
    if (!trimmed) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/portal/tickets/${ticketId}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        // ส่งเฉพาะ body — ไม่มี visibility (backend บังคับ PUBLIC เสมอ)
        body: JSON.stringify({ body: trimmed }),
      });

      const json = (await res.json()) as PortalPostMessageResponse;

      if (!res.ok || json.error) {
        setError(json.error?.message ?? "ส่งข้อความไม่สำเร็จ กรุณาลองใหม่");
        return;
      }

      if (json.data) {
        // สร้าง PortalTicketMessage จาก response เพื่ออัปเดต UI ทันที
        const newMsg: PortalTicketMessage = {
          id: json.data.id,
          ticketId: json.data.ticketId,
          body: json.data.body,
          createdAt: json.data.createdAt,
          authorMember: null,
          authorContact: json.data.authorContact,
        };
        onMessageSent(newMsg);
        setBody("");
      }
    } catch {
      setError("ไม่สามารถเชื่อมต่อได้ กรุณาลองใหม่");
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      // void เพื่อระบุชัดว่า ignore promise อย่างตั้งใจ (ตามแนวทางเดียวกับ void fetchTickets)
      void handleSend();
    }
  }

  if (isClosed) {
    return (
      <div className="bg-surface rounded-xl border border-border p-4 text-center">
        <p className="text-sm text-secondary">
          คำขอนี้ถูกปิดแล้ว — หากยังมีปัญหาโปรดสร้างคำขอใหม่
        </p>
      </div>
    );
  }

  return (
    <div className="bg-surface rounded-xl border border-border p-4">
      {/* hint สำหรับ SOLVED — แจ้งว่าการตอบกลับจะเปิด ticket ใหม่ */}
      {isSolved && (
        <p className="text-xs text-secondary mb-2">
          ticket นี้ได้รับการแก้ไขแล้ว — ตอบกลับเพื่อเปิด ticket นี้อีกครั้ง
        </p>
      )}
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="พิมพ์ข้อความตอบกลับ... (Ctrl+Enter เพื่อส่ง)"
        rows={4}
        aria-label="ข้อความตอบกลับ"
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground resize-none placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-colors hover:border-primary"
      />

      {error && (
        <div className="mt-2">
          <FormAlert variant="error" message={error} />
        </div>
      )}

      <div className="flex justify-end mt-3">
        <button
          type="button"
          onClick={handleSend}
          disabled={isSubmitting || !body.trim()}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary-strong hover:bg-primary-strong-hover text-white text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-primary-strong"
        >
          {isSubmitting ? (
            <RefreshCw size={14} className="animate-spin" aria-hidden="true" />
          ) : (
            <Send size={14} aria-hidden="true" />
          )}
          {isSubmitting ? "กำลังส่ง..." : "ส่งข้อความ"}
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export default function PortalTicketDetailPage() {
  const params = useParams();
  const router = useRouter();
  const ticketId = params.id as string;

  const [ticket, setTicket] = useState<PortalTicketDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const fetchTicket = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/portal/tickets/${ticketId}`, {
        credentials: "include",
      });

      const json = (await res.json()) as PortalTicketDetailResponse;

      if (!res.ok || json.error) {
        if (res.status === 401) {
          setError("กรุณา login ก่อนใช้งาน");
        } else if (res.status === 404) {
          setError("ไม่พบคำขอนี้");
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

  function handleMessageSent(msg: PortalTicketMessage) {
    setTicket((prev) =>
      prev ? { ...prev, messages: [...prev.messages, msg] } : prev
    );
  }

  /** อัปเดต state หลังส่ง CSAT สำเร็จ → สลับไปแสดง thank-you card */
  function handleCsatSubmitted(response: CsatResponseDTO) {
    setTicket((prev) =>
      prev ? { ...prev, csat: { eligible: false, response } } : prev
    );
  }

  // ─── Loading ───────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-secondary">
          <RefreshCw size={28} className="animate-spin" aria-hidden="true" />
          <span className="text-sm">กำลังโหลด...</span>
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
            onClick={() => router.push("/portal/tickets")}
            className="text-sm text-primary-ink hover:underline"
          >
            กลับไปรายการ
          </button>
        </div>
      </div>
    );
  }

  // block reply เฉพาะ CLOSED — SOLVED ยังตอบได้ (backend reopen ticket อัตโนมัติ)
  const isClosed = ticket.status === "CLOSED";

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 py-8">

        {/* Back button */}
        <button
          type="button"
          onClick={() => router.push("/portal/tickets")}
          className="inline-flex items-center gap-2 text-sm text-secondary hover:text-foreground mb-6 transition-colors focus:outline-none focus:underline"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          กลับไปรายการ
        </button>

        {/* Ticket header */}
        <div className="bg-surface rounded-xl border border-border p-5 mb-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="text-xs font-semibold text-secondary">
              #{ticket.ticketNumber}
            </span>
            <StatusBadge status={ticket.status} />
          </div>
          <h1 className="text-lg font-bold text-foreground leading-snug">
            {ticket.subject}
          </h1>
          {ticket.assignee && (
            <p className="mt-2 text-sm text-secondary">
              ผู้ดูแล:{" "}
              <span className="text-foreground font-medium">
                {ticket.assignee.user.name ?? "ทีม Support"}
              </span>
            </p>
          )}
        </div>

        {/* Message thread */}
        <div className="bg-surface rounded-xl border border-border shadow-sm overflow-hidden mb-4">
          <div className="px-5 py-3 border-b border-border bg-stone">
            <h2 className="text-sm font-semibold text-foreground">
              การสนทนา ({ticket.messages.length} ข้อความ)
            </h2>
          </div>

          <div className="px-5 py-4 flex flex-col gap-4">
            {ticket.messages.length === 0 ? (
              <p className="text-sm text-secondary text-center py-8">
                ยังไม่มีข้อความ — ทีม support จะตอบกลับโดยเร็ว
              </p>
            ) : (
              ticket.messages.map((msg) => (
                <PortalMessageBubble key={msg.id} message={msg} />
              ))
            )}
          </div>
        </div>

        {/* Reply box — ไม่มี visibility toggle เลย */}
        <PortalReplyBox
          ticketId={ticketId}
          isClosed={isClosed}
          isSolved={ticket.status === "SOLVED"}
          onMessageSent={handleMessageSent}
        />

        {/*
          CSAT widget — 3 กรณี:
          1. มี response แล้ว → thank-you card (read-only)
          2. eligible (SOLVED/CLOSED + ยังไม่เคยส่ง) → form ให้คะแนน
          3. ไม่ตรงทั้งสอง (ticket ยังเปิดอยู่ หรือ feature ปิด) → ไม่แสดงอะไรเลย
        */}
        {ticket.csat.response !== null ? (
          <div className="mt-4">
            <CsatThankYou response={ticket.csat.response} />
          </div>
        ) : ticket.csat.eligible ? (
          <div className="mt-4">
            <CsatSurvey ticketId={ticketId} onSubmitted={handleCsatSubmitted} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
