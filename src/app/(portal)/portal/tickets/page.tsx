"use client";

/**
 * หน้า Ticket List (portal) — แสดง ticket ของลูกค้าตัวเอง
 * ใช้ client fetch เพื่อให้ session cookie + tenant subdomain header ทำงานถูกต้อง
 *
 * หน้านี้ไม่มีโค้ดใดๆ ที่เกี่ยวกับ visibility / INTERNAL / internal note เลย
 * — portal API คืนเฉพาะข้อมูลสาธารณะ (defense in depth ที่ backend)
 */

import { useState, useEffect, useCallback, useTransition } from "react";
import Link from "next/link";
import { Plus, RefreshCw, Inbox } from "lucide-react";
import StatusBadge from "@/components/ui/StatusBadge";
import FormAlert from "@/components/ui/FormAlert";
import { formatDate } from "@/lib/ticket-ui";
import type {
  PortalTicketSummary,
  PortalTicketListResponse,
  TicketStatus,
} from "@/types/ticket";

// =============================================================================
// CONSTANTS
// =============================================================================

const STATUS_OPTIONS: { value: TicketStatus | ""; label: string }[] = [
  { value: "", label: "ทุกสถานะ" },
  { value: "NEW", label: "ใหม่" },
  { value: "OPEN", label: "เปิด" },
  { value: "PENDING", label: "รอการตอบกลับ" },
  { value: "ON_HOLD", label: "พัก" },
  { value: "SOLVED", label: "แก้แล้ว" },
  { value: "CLOSED", label: "ปิด" },
];

const LIMIT = 20;

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

interface TicketCardProps {
  ticket: PortalTicketSummary;
}

function TicketCard({ ticket }: TicketCardProps) {
  return (
    <Link
      href={`/portal/tickets/${ticket.id}`}
      className="block bg-surface rounded-xl border border-border p-4 hover:border-primary hover:shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-xs text-secondary font-medium">
              #{ticket.ticketNumber}
            </span>
            <StatusBadge status={ticket.status} />
          </div>
          <p className="text-sm font-medium text-foreground line-clamp-2">
            {ticket.subject}
          </p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-4 text-xs text-secondary">
        <span>อัปเดต: {formatDate(ticket.updatedAt)}</span>
        {ticket._count && (
          <span>{ticket._count.messages} ข้อความ</span>
        )}
      </div>
    </Link>
  );
}

interface PaginationBarProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

function PaginationBar({ page, totalPages, onPageChange }: PaginationBarProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between mt-4">
      <span className="text-sm text-secondary">
        หน้า {page} / {totalPages}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="px-3 py-1.5 text-sm rounded-lg border border-border bg-surface text-foreground disabled:opacity-40 disabled:cursor-not-allowed hover:bg-stone transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
          aria-label="หน้าก่อนหน้า"
        >
          ก่อนหน้า
        </button>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="px-3 py-1.5 text-sm rounded-lg border border-border bg-surface text-foreground disabled:opacity-40 disabled:cursor-not-allowed hover:bg-stone transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
          aria-label="หน้าถัดไป"
        >
          ถัดไป
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export default function PortalTicketListPage() {
  const [tickets, setTickets] = useState<PortalTicketSummary[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<TicketStatus | "">("");
  const [page, setPage] = useState(1);
  const [, startTransition] = useTransition();

  const fetchTickets = useCallback(async (status: TicketStatus | "", currentPage: number) => {
    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      params.set("page", String(currentPage));
      params.set("limit", String(LIMIT));

      const res = await fetch(`/api/portal/tickets?${params.toString()}`, {
        credentials: "include",
      });

      const json = (await res.json()) as PortalTicketListResponse;

      if (!res.ok || json.error) {
        if (res.status === 401) {
          setError("กรุณา login ก่อนใช้งาน");
        } else {
          setError(json.error?.message ?? "โหลดข้อมูลไม่สำเร็จ");
        }
        return;
      }

      if (json.data) {
        setTickets(json.data.tickets);
        setTotalPages(json.data.pagination.totalPages);
      }
    } catch {
      setError("ไม่สามารถเชื่อมต่อได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // ใช้ startTransition เพื่อหลีกเลี่ยง cascading render ตาม react-hooks/set-state-in-effect
  // startTransition เป็น stable reference — ไม่ต้องใส่ใน deps
  useEffect(() => {
    startTransition(() => { void fetchTickets(statusFilter, page); });
  }, [statusFilter, page, fetchTickets]);

  function handleStatusChange(value: TicketStatus | "") {
    setStatusFilter(value);
    setPage(1);
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto px-4 py-8">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-foreground">คำขอของฉัน</h1>
          <Link
            href="/portal/tickets/new"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary-strong hover:bg-primary-strong-hover text-white text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
          >
            <Plus size={16} aria-hidden="true" />
            แจ้งปัญหาใหม่
          </Link>
        </div>

        {/* Filter */}
        <div className="flex items-center gap-3 mb-4">
          <label htmlFor="portal-filter-status" className="text-sm text-secondary">
            กรองตามสถานะ:
          </label>
          <select
            id="portal-filter-status"
            value={statusFilter}
            onChange={(e) => handleStatusChange(e.target.value as TicketStatus | "")}
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4">
            <FormAlert variant="error" message={error} />
          </div>
        )}

        {/* List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3 text-secondary">
              <RefreshCw size={24} className="animate-spin" aria-hidden="true" />
              <span className="text-sm">กำลังโหลด...</span>
            </div>
          </div>
        ) : tickets.length === 0 && !error ? (
          <div className="flex flex-col items-center py-16 gap-3 text-secondary">
            <Inbox size={40} aria-hidden="true" className="opacity-40" />
            <p className="text-sm">ยังไม่มีคำขอ</p>
            <Link
              href="/portal/tickets/new"
              className="text-sm text-primary-ink hover:underline font-medium"
            >
              สร้างคำขอแรกของคุณ
            </Link>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              {tickets.map((ticket) => (
                <TicketCard key={ticket.id} ticket={ticket} />
              ))}
            </div>
            <PaginationBar
              page={page}
              totalPages={totalPages}
              onPageChange={setPage}
            />
          </>
        )}
      </div>
    </div>
  );
}
