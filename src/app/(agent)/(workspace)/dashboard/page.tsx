"use client";

/**
 * dashboard/page.tsx — หน้า Dashboard (agent workspace)
 * แสดงสรุป ticket ของ tenant: นับตาม status, ticket ของฉัน, คิว unassigned, ล่าสุด
 * fetch GET /api/dashboard ด้วย credentials: "include"
 */

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RefreshCw, Inbox, Users, Clock } from "lucide-react";
import StatusBadge from "@/components/ui/StatusBadge";
import PriorityBadge from "@/components/ui/PriorityBadge";
import FormAlert from "@/components/ui/FormAlert";
import CsatSummaryCard from "@/components/dashboard/CsatSummaryCard";
import { getStatusStyle, formatDate } from "@/lib/ticket-ui";
import type {
  DashboardResponse,
  AgentTicketSummary,
  TicketStatus,
} from "@/types/ticket";

// =============================================================================
// CONSTANTS
// =============================================================================

const STATUS_ORDER: TicketStatus[] = [
  "NEW",
  "OPEN",
  "PENDING",
  "ON_HOLD",
  "SOLVED",
  "CLOSED",
];

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

interface StatusCardProps {
  status: TicketStatus;
  count: number;
}

/** การ์ดสรุปจำนวน ticket ต่อสถานะ — ใช้ getStatusStyle สำหรับสี */
function StatusCard({ status, count }: StatusCardProps) {
  const { label, bg, text } = getStatusStyle(status);

  return (
    <div
      className={[
        "rounded-xl border border-border bg-surface p-4 flex flex-col gap-1 shadow-sm",
      ].join(" ")}
    >
      <span className={`text-xs font-medium uppercase tracking-wide ${text}`}>
        {label}
      </span>
      <div className="flex items-end justify-between mt-1">
        <span className={`text-3xl font-bold ${text}`}>{count}</span>
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${bg} ${text} border-transparent`}
          aria-hidden="true"
        >
          {label}
        </span>
      </div>
    </div>
  );
}

/** skeleton สำหรับ status cards */
function StatusCardsSkeleton() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className="rounded-xl border border-border bg-surface p-4 h-24 animate-pulse bg-stone"
        />
      ))}
    </div>
  );
}

interface TicketListSectionProps {
  title: string;
  /** id ของ <h2> เพื่อให้ section ที่ครอบใช้ aria-labelledby ชี้มาถูก */
  headingId?: string;
  count: number;
  tickets: AgentTicketSummary[];
  icon: React.ReactNode;
  emptyMessage: string;
  isLoading: boolean;
}

/** section แสดง list ticket พร้อม header + empty state */
function TicketListSection({
  title,
  headingId,
  count,
  tickets,
  icon,
  emptyMessage,
  isLoading,
}: TicketListSectionProps) {
  return (
    <div className="bg-surface rounded-xl border border-border shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-stone">
        <span className="text-secondary" aria-hidden="true">
          {icon}
        </span>
        <h2 id={headingId} className="text-sm font-semibold text-foreground">{title}</h2>
        <span className="ml-auto inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-primary-tint text-primary-ink">
          {count}
        </span>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 3 }, (_, i) => (
            <div
              key={i}
              className="h-12 bg-stone rounded-lg animate-pulse"
            />
          ))}
        </div>
      ) : tickets.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted">
          <Inbox size={32} aria-hidden="true" className="opacity-40" />
          <p className="text-sm">{emptyMessage}</p>
        </div>
      ) : (
        <ul role="list" className="divide-y divide-border">
          {tickets.map((ticket) => (
            <TicketRow key={ticket.id} ticket={ticket} />
          ))}
        </ul>
      )}
    </div>
  );
}

interface TicketRowProps {
  ticket: AgentTicketSummary;
}

/** แถว ticket ในแต่ละ section — คลิกไป /tickets/[id] */
function TicketRow({ ticket }: TicketRowProps) {
  const requesterName =
    ticket.requesterContact?.name ?? ticket.requesterContact?.email ?? "—";

  return (
    <li>
      <Link
        href={`/tickets/${ticket.id}`}
        className="flex items-center gap-3 px-4 py-3 hover:bg-stone transition-colors focus:outline-none focus:bg-stone group"
      >
        {/* Ticket number */}
        <span className="text-xs font-mono text-muted shrink-0 w-12">
          #{ticket.ticketNumber}
        </span>

        {/* Subject + requester */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground group-hover:text-primary-ink truncate">
            {ticket.subject}
          </p>
          <p className="text-xs text-muted truncate">{requesterName}</p>
        </div>

        {/* Badges + date */}
        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge status={ticket.status} />
          <PriorityBadge priority={ticket.priority} />
          <span className="text-xs text-muted hidden sm:block whitespace-nowrap">
            {formatDate(ticket.updatedAt)}
          </span>
        </div>
      </Link>
    </li>
  );
}

// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function DashboardPage() {
  const router = useRouter();

  const [dashboardData, setDashboardData] = useState<
    DashboardResponse["data"] | null
  >(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDashboard = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/dashboard", { credentials: "include" });

      if (res.status === 401) {
        // session หมดอายุ → ส่งกลับ login
        router.replace("/login");
        return;
      }

      const json = (await res.json()) as DashboardResponse;

      if (!res.ok || json.error || !json.data) {
        setError(json.error?.message ?? "โหลดข้อมูลไม่สำเร็จ");
        return;
      }

      setDashboardData(json.data);
    } catch {
      setError("ไม่สามารถเชื่อมต่อได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่");
    } finally {
      setIsLoading(false);
    }
  }, [router]);

  useEffect(() => {
    // deferred ผ่าน microtask — กัน setState synchronous ใน effect body
    queueMicrotask(() => void fetchDashboard());
  }, [fetchDashboard]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

      {/* Page Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
          <p className="mt-0.5 text-sm text-secondary">
            ภาพรวม ticket ของ tenant
          </p>
        </div>
        <button
          type="button"
          onClick={() => void fetchDashboard()}
          disabled={isLoading}
          aria-label="รีเฟรชข้อมูล"
          className="p-2 rounded-lg border border-border text-secondary hover:bg-stone disabled:opacity-40 transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <RefreshCw
            size={16}
            className={isLoading ? "animate-spin" : ""}
            aria-hidden="true"
          />
        </button>
      </div>

      {/* Error state */}
      {error && (
        <div className="mb-6">
          <FormAlert variant="error" message={error} />
        </div>
      )}

      {/* ================================================================== */}
      {/* Widget 1: Status Summary Cards                                       */}
      {/* ================================================================== */}
      <section aria-labelledby="status-summary-heading" className="mb-8">
        <h2
          id="status-summary-heading"
          className="text-sm font-semibold text-secondary uppercase tracking-wide mb-3"
        >
          สรุปตามสถานะ
        </h2>

        {isLoading ? (
          <StatusCardsSkeleton />
        ) : dashboardData ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {STATUS_ORDER.map((status) => (
              <StatusCard
                key={status}
                status={status}
                count={dashboardData.statusCounts[status] ?? 0}
              />
            ))}
          </div>
        ) : null}
      </section>

      {/* ================================================================== */}
      {/* Widget 2 + 3: My Assigned & Unassigned (2 คอลัมน์)                 */}
      {/* ================================================================== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <section aria-labelledby="my-assigned-heading">
          <TicketListSection
            title="Ticket ของฉัน"
            headingId="my-assigned-heading"
            count={dashboardData?.myAssignedCount ?? 0}
            tickets={dashboardData?.myAssigned ?? []}
            icon={<Users size={16} />}
            emptyMessage="ไม่มี ticket ที่ assigned ให้คุณ"
            isLoading={isLoading}
          />
        </section>

        <section aria-labelledby="unassigned-heading">
          <TicketListSection
            title="คิวที่ยังไม่ได้มอบหมาย"
            headingId="unassigned-heading"
            count={dashboardData?.unassignedCount ?? 0}
            tickets={dashboardData?.unassigned ?? []}
            icon={<Inbox size={16} />}
            emptyMessage="ไม่มี ticket ที่รอมอบหมาย"
            isLoading={isLoading}
          />
        </section>
      </div>

      {/* ================================================================== */}
      {/* Widget: CSAT Summary                                                */}
      {/* ================================================================== */}
      <section aria-labelledby="csat-summary-heading" className="mb-8">
        <h2
          id="csat-summary-heading"
          className="text-sm font-semibold text-secondary uppercase tracking-wide mb-3"
        >
          ความพึงพอใจลูกค้า
        </h2>
        <div className="max-w-md">
          <CsatSummaryCard />
        </div>
      </section>

      {/* ================================================================== */}
      {/* Widget 4: Recent Tickets                                            */}
      {/* ================================================================== */}
      <section aria-labelledby="recent-heading">
        <TicketListSection
          title="Ticket ล่าสุด"
          headingId="recent-heading"
          count={dashboardData?.recent.length ?? 0}
          tickets={dashboardData?.recent ?? []}
          icon={<Clock size={16} />}
          emptyMessage="ยังไม่มี ticket ในระบบ"
          isLoading={isLoading}
        />
      </section>
    </div>
  );
}
