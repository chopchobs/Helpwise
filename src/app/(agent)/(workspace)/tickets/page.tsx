"use client";

/**
 * หน้า Ticket List (agent) — แสดง ticket ทั้งหมดของ tenant
 * ใช้ client fetch เพื่อให้ session cookie + tenant subdomain header
 * ถูกส่งอัตโนมัติผ่าน credentials: "include" (same-site cookie)
 * tenant subdomain middleware inject x-tenant-id ให้แล้วที่ server level
 */

import { useState, useEffect, useCallback, useTransition } from "react";
import Link from "next/link";
import { Plus, RefreshCw, Inbox } from "lucide-react";
import StatusBadge from "@/components/ui/StatusBadge";
import PriorityBadge from "@/components/ui/PriorityBadge";
import SlaBadge from "@/components/ui/SlaBadge";
import CsatStars from "@/components/ui/CsatStars";
import TagChip from "@/components/ui/TagChip";
import FormAlert from "@/components/ui/FormAlert";
import { formatDate } from "@/lib/ticket-ui";
import type {
  AgentTicketSummary,
  AgentTicketListResponse,
  TicketStatus,
  TicketPriority,
} from "@/types/ticket";
import type { TagDTO, TagListResponse } from "@/types/tag";

// =============================================================================
// TYPES
// =============================================================================

interface FilterState {
  status: TicketStatus | "";
  priority: TicketPriority | "";
  // filter ตาม tag (match-any) — array ของ tagId ที่เลือก
  tagIds: string[];
  page: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const STATUS_OPTIONS: { value: TicketStatus | ""; label: string }[] = [
  { value: "", label: "ทุกสถานะ" },
  { value: "NEW", label: "ใหม่" },
  { value: "OPEN", label: "เปิด" },
  { value: "PENDING", label: "รอลูกค้า" },
  { value: "ON_HOLD", label: "พัก" },
  { value: "SOLVED", label: "แก้แล้ว" },
  { value: "CLOSED", label: "ปิด" },
];

const PRIORITY_OPTIONS: { value: TicketPriority | ""; label: string }[] = [
  { value: "", label: "ทุก Priority" },
  { value: "LOW", label: "ต่ำ" },
  { value: "NORMAL", label: "ปกติ" },
  { value: "HIGH", label: "สูง" },
  { value: "URGENT", label: "เร่งด่วน" },
];

const LIMIT = 20;

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

interface TicketRowProps {
  ticket: AgentTicketSummary;
}

function TicketRow({ ticket }: TicketRowProps) {
  const requesterName =
    ticket.requesterContact?.name ?? ticket.requesterContact?.email ?? "—";
  const assigneeName = ticket.assignee?.user?.name ?? "ยังไม่ได้มอบหมาย";

  return (
    <tr className="border-b border-border hover:bg-stone transition-colors">
      <td className="px-4 py-3 text-sm font-medium text-primary-ink">
        <Link
          href={`/tickets/${ticket.id}`}
          className="hover:underline focus:outline-none focus:underline"
        >
          #{ticket.ticketNumber}
        </Link>
      </td>
      <td className="px-4 py-3 text-sm text-foreground max-w-xs">
        <Link
          href={`/tickets/${ticket.id}`}
          className="hover:text-primary-ink hover:underline focus:outline-none focus:underline line-clamp-2"
        >
          {ticket.subject}
        </Link>
        {/* tag chips (agent-only) — แสดงใต้หัวข้อถ้ามี */}
        {ticket.tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {ticket.tags.map((tag) => (
              <TagChip key={tag.id} tag={tag} />
            ))}
          </div>
        )}
      </td>
      <td className="px-4 py-3">
        <StatusBadge status={ticket.status} />
      </td>
      <td className="px-4 py-3">
        <PriorityBadge priority={ticket.priority} />
      </td>
      <td className="px-4 py-3 text-sm text-secondary">{requesterName}</td>
      <td className="px-4 py-3 text-sm text-secondary">{assigneeName}</td>
      <td className="px-4 py-3 text-xs text-secondary whitespace-nowrap">
        {formatDate(ticket.updatedAt)}
      </td>
      {/* SLA badge compact สำหรับ list view */}
      <td className="px-4 py-3">
        <SlaBadge sla={ticket.sla} compact />
      </td>
      {/* CSAT — ดาว+ตัวเลข compact หรือ "—" ถ้ายังไม่มีคะแนน */}
      <td className="px-4 py-3">
        {ticket.csat ? (
          <CsatStars rating={ticket.csat.rating} size="sm" showValue />
        ) : (
          <span className="text-sm text-muted">—</span>
        )}
      </td>
    </tr>
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
    <div className="flex items-center justify-between px-4 py-3 border-t border-border">
      <span className="text-sm text-secondary">
        หน้า {page} / {totalPages}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="px-3 py-1.5 text-sm rounded-lg border border-border text-foreground disabled:opacity-40 disabled:cursor-not-allowed hover:bg-stone transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
          aria-label="หน้าก่อนหน้า"
        >
          ก่อนหน้า
        </button>
        <button
          type="button"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="px-3 py-1.5 text-sm rounded-lg border border-border text-foreground disabled:opacity-40 disabled:cursor-not-allowed hover:bg-stone transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
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

export default function AgentTicketListPage() {
  const [tickets, setTickets] = useState<AgentTicketSummary[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // tag catalog ของ tenant — โหลดครั้งเดียวสำหรับ filter chips
  const [tagCatalog, setTagCatalog] = useState<TagDTO[]>([]);

  const [filters, setFilters] = useState<FilterState>({
    status: "",
    priority: "",
    tagIds: [],
    page: 1,
  });

  const fetchTickets = useCallback(async (f: FilterState) => {
    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (f.status) params.set("status", f.status);
      if (f.priority) params.set("priority", f.priority);
      // tag filter (match-any) — append หลายค่า
      for (const tagId of f.tagIds) params.append("tagId", tagId);
      params.set("page", String(f.page));
      params.set("limit", String(LIMIT));

      const res = await fetch(`/api/tickets?${params.toString()}`, {
        credentials: "include",
      });

      const json = (await res.json()) as AgentTicketListResponse;

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
        setTotal(json.data.pagination.total);
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
    startTransition(() => { void fetchTickets(filters); });
  }, [filters, fetchTickets]);

  // โหลด tag catalog ครั้งเดียวตอน mount (สำหรับ filter chips)
  // wrap queueMicrotask กัน setState synchronous ใน effect (react-hooks/set-state-in-effect)
  useEffect(() => {
    queueMicrotask(() => {
      void (async () => {
        try {
          const res = await fetch("/api/tags", { credentials: "include" });
          const json = (await res.json()) as TagListResponse;
          if (res.ok && json.data) setTagCatalog(json.data.tags);
        } catch {
          // ไม่ critical — filter chips แค่ไม่แสดง ถ้าโหลดไม่ได้
        }
      })();
    });
  }, []);

  function handleStatusChange(value: TicketStatus | "") {
    setFilters((prev) => ({ ...prev, status: value, page: 1 }));
  }

  function handlePriorityChange(value: TicketPriority | "") {
    setFilters((prev) => ({ ...prev, priority: value, page: 1 }));
  }

  // toggle tagId ใน filter (เลือก/ยกเลิก) — reset page เป็น 1
  function handleTagToggle(tagId: string) {
    setFilters((prev) => ({
      ...prev,
      tagIds: prev.tagIds.includes(tagId)
        ? prev.tagIds.filter((id) => id !== tagId)
        : [...prev.tagIds, tagId],
      page: 1,
    }));
  }

  function handlePageChange(page: number) {
    setFilters((prev) => ({ ...prev, page }));
  }

  function handleRefresh() {
    void fetchTickets(filters);
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Tickets</h1>
            {!isLoading && total > 0 && (
              <p className="mt-1 text-sm text-secondary">{total} tickets ทั้งหมด</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isLoading}
              aria-label="รีเฟรชข้อมูล"
              className="p-2 rounded-lg border border-border text-secondary hover:bg-stone disabled:opacity-40 transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} aria-hidden="true" />
            </button>
            <Link
              href="/tickets/new"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary-strong hover:bg-primary-strong-hover text-white text-sm font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
            >
              <Plus size={16} aria-hidden="true" />
              สร้าง Ticket
            </Link>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3 mb-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="filter-status" className="text-xs font-medium text-secondary">
              สถานะ
            </label>
            <select
              id="filter-status"
              value={filters.status}
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

          <div className="flex flex-col gap-1">
            <label htmlFor="filter-priority" className="text-xs font-medium text-secondary">
              Priority
            </label>
            <select
              id="filter-priority"
              value={filters.priority}
              onChange={(e) => handlePriorityChange(e.target.value as TicketPriority | "")}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            >
              {PRIORITY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Tag filter — toggle chips (match-any) แสดงเฉพาะถ้ามี tag ใน catalog */}
        {tagCatalog.length > 0 && (
          <div className="mb-4">
            <span className="text-xs font-medium text-secondary">กรองตาม Tag</span>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {tagCatalog.map((tag) => {
                const isSelected = filters.tagIds.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => handleTagToggle(tag.id)}
                    aria-pressed={isSelected}
                    className={[
                      "rounded-full transition-shadow focus:outline-none focus:ring-2 focus:ring-primary",
                      isSelected ? "ring-2 ring-primary ring-offset-1" : "opacity-70 hover:opacity-100",
                    ].join(" ")}
                  >
                    <TagChip tag={tag} />
                  </button>
                );
              })}
              {filters.tagIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => setFilters((prev) => ({ ...prev, tagIds: [], page: 1 }))}
                  className="ml-1 text-xs text-primary-ink hover:underline focus:outline-none focus:underline"
                >
                  ล้าง
                </button>
              )}
            </div>
          </div>
        )}

        {/* Error state */}
        {error && (
          <div className="mb-4">
            <FormAlert variant="error" message={error} />
          </div>
        )}

        {/* Table */}
        <div className="bg-surface rounded-xl border border-border overflow-hidden shadow-sm">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <div className="flex flex-col items-center gap-3 text-secondary">
                <RefreshCw size={24} className="animate-spin" aria-hidden="true" />
                <span className="text-sm">กำลังโหลด...</span>
              </div>
            </div>
          ) : tickets.length === 0 && !error ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-secondary">
              <Inbox size={40} aria-hidden="true" className="opacity-40" />
              <p className="text-sm">ไม่มี ticket ที่ตรงกับเงื่อนไข</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[700px]">
                  <thead>
                    <tr className="border-b border-border bg-stone">
                      <th className="px-4 py-3 text-left text-xs font-semibold text-secondary uppercase tracking-wide">
                        #
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-secondary uppercase tracking-wide">
                        หัวข้อ
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-secondary uppercase tracking-wide">
                        สถานะ
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-secondary uppercase tracking-wide">
                        Priority
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-secondary uppercase tracking-wide">
                        ผู้แจ้ง
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-secondary uppercase tracking-wide">
                        ผู้รับผิดชอบ
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-secondary uppercase tracking-wide">
                        อัปเดตล่าสุด
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-secondary uppercase tracking-wide">
                        SLA
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-secondary uppercase tracking-wide">
                        CSAT
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {tickets.map((ticket) => (
                      <TicketRow key={ticket.id} ticket={ticket} />
                    ))}
                  </tbody>
                </table>
              </div>
              <PaginationBar
                page={filters.page}
                totalPages={totalPages}
                onPageChange={handlePageChange}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
