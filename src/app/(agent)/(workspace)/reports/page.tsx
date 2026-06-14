"use client";

/**
 * reports/page.tsx — หน้า Reporting/Analytics dashboard (agent — ทุก role)
 * fetch GET /api/reports?from=&to= ด้วย credentials: "include"
 * ถ้า feature `analytics` ไม่เปิด (plan < pro) → 403 FEATURE_LOCKED → แสดง upgrade panel
 */

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Inbox,
  CheckCircle,
  Clock,
  Timer,
  AlertTriangle,
  Star,
  Lock,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import FormAlert from "@/components/ui/FormAlert";
import type { ReportData, ReportBreakdownItem } from "@/types/report";

// =============================================================================
// TYPES
// =============================================================================

interface ReportApiResponse {
  data: ReportData | null;
  error: { code: string; message: string } | null;
}

interface DateRange {
  from: string; // "YYYY-MM-DD"
  to: string;
}

type PresetKey = "7d" | "30d" | "90d";

// =============================================================================
// HELPERS
// =============================================================================

/** แปลงนาทีเป็นข้อความอ่านง่าย เช่น "1h 20m" / "45m" / "—" */
function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "—";
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  if (hours === 0) return `${mins}m`;
  return `${hours}h ${mins}m`;
}

/** คืนค่า "YYYY-MM-DD" ของวันนี้ลบ n วัน */
function dateOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

/** สร้าง range ตาม preset (วันนี้ - n+1 วัน ถึง วันนี้) */
function rangeFromPreset(preset: PresetKey): DateRange {
  const days = preset === "7d" ? 6 : preset === "30d" ? 29 : 89;
  return { from: dateOffset(days), to: dateOffset(0) };
}

/** format วันที่ trend chart ให้สั้น "MM-DD" */
function formatShortDate(isoDate: string): string {
  const parts = isoDate.split("-");
  if (parts.length !== 3) return isoDate;
  return `${parts[1]}-${parts[2]}`;
}

/** เลือกสี class สำหรับ SLA breach rate ตาม threshold */
function getSlaBreachColorClass(rate: number): string {
  const percent = rate * 100;
  if (percent > 20) return "text-danger";
  if (percent > 5) return "text-warning-ink";
  return "text-success";
}

/** เลือก CSS variable token สำหรับ bar ตาม priority */
function getPriorityColor(key: string): string {
  switch (key) {
    case "URGENT":
      return "var(--color-danger)";
    case "HIGH":
      return "var(--color-warning)";
    case "LOW":
      return "var(--color-muted)";
    default:
      return "var(--color-primary)";
  }
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

interface KpiCardProps {
  label: string;
  value: string;
  icon: React.ReactNode;
  valueColorClass?: string;
}

/** การ์ดแสดงตัวเลข KPI เดี่ยว */
function KpiCard({ label, value, icon, valueColorClass }: KpiCardProps) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4 flex flex-col gap-2 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-secondary uppercase tracking-wide">
          {label}
        </span>
        <span className="text-muted" aria-hidden="true">
          {icon}
        </span>
      </div>
      <span className={`text-2xl font-bold ${valueColorClass ?? "text-foreground"}`}>
        {value}
      </span>
    </div>
  );
}

/** skeleton สำหรับ KPI cards grid */
function KpiCardsSkeleton() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className="rounded-xl border border-border bg-surface p-4 h-24 animate-pulse bg-stone"
        />
      ))}
    </div>
  );
}

/** skeleton สำหรับ chart card */
function ChartSkeleton({ heightClass }: { heightClass: string }) {
  return (
    <div className={`rounded-xl border border-border bg-surface p-4 ${heightClass} animate-pulse bg-stone`} />
  );
}

interface DateRangeControlsProps {
  draftFrom: string;
  draftTo: string;
  activePreset: PresetKey | null;
  validationError: string | null;
  onPresetClick: (preset: PresetKey) => void;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onApply: () => void;
}

/** ส่วนเลือกช่วงวันที่ — preset + custom range */
function DateRangeControls({
  draftFrom,
  draftTo,
  activePreset,
  validationError,
  onPresetClick,
  onFromChange,
  onToChange,
  onApply,
}: DateRangeControlsProps) {
  const presets: { key: PresetKey; label: string }[] = [
    { key: "7d", label: "7 วัน" },
    { key: "30d", label: "30 วัน" },
    { key: "90d", label: "90 วัน" },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {presets.map((preset) => (
          <button
            key={preset.key}
            type="button"
            onClick={() => onPresetClick(preset.key)}
            className={[
              "px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors focus:outline-none focus:ring-2 focus:ring-primary",
              activePreset === preset.key
                ? "bg-primary-tint text-primary-ink border-primary-tint"
                : "bg-surface text-secondary border-border hover:bg-stone",
            ].join(" ")}
          >
            {preset.label}
          </button>
        ))}

        <div className="flex items-center gap-2 ml-2">
          <label htmlFor="report-from" className="text-sm text-secondary">
            จาก
          </label>
          <input
            id="report-from"
            type="date"
            value={draftFrom}
            onChange={(event) => onFromChange(event.target.value)}
            className="px-2 py-1.5 rounded-lg border border-border bg-surface text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <label htmlFor="report-to" className="text-sm text-secondary">
            ถึง
          </label>
          <input
            id="report-to"
            type="date"
            value={draftTo}
            onChange={(event) => onToChange(event.target.value)}
            className="px-2 py-1.5 rounded-lg border border-border bg-surface text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <button
            type="button"
            onClick={onApply}
            className="px-3 py-1.5 rounded-lg text-sm font-semibold text-white bg-primary-strong hover:bg-primary-strong-hover transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
          >
            ใช้ช่วงนี้
          </button>
        </div>
      </div>

      {validationError && (
        <p className="text-sm text-danger" role="alert">
          {validationError}
        </p>
      )}
    </div>
  );
}

/** state เมื่อ feature analytics ไม่อยู่ใน plan ปัจจุบัน */
function FeatureLockedState() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="bg-surface rounded-xl border border-border p-8 max-w-sm w-full text-center flex flex-col items-center gap-4">
        <div className="w-12 h-12 rounded-full bg-warning-tint flex items-center justify-center">
          <Lock size={24} className="text-warning-ink" aria-hidden="true" />
        </div>
        <div>
          <h2 className="text-base font-bold text-foreground">
            Reporting &amp; Analytics ไม่รวมใน Plan ปัจจุบัน
          </h2>
          <p className="text-sm text-secondary mt-2">
            ฟีเจอร์นี้อยู่ในแพ็กเกจ Pro ขึ้นไป อัปเกรดเพื่อดูสรุปและกราฟวิเคราะห์ ticket ของทีมคุณ
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

interface BreakdownChartProps {
  title: string;
  items: ReportBreakdownItem[];
  colorForKey: (key: string) => string;
}

/** การ์ดแสดง bar chart breakdown (priority หรือ channel) */
function BreakdownChart({ title, items, colorForKey }: BreakdownChartProps) {
  const hasData = items.some((item) => item.count > 0);

  return (
    <div className="rounded-xl border border-border bg-surface p-4 flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {hasData ? (
        <div style={{ height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={items} layout="vertical" margin={{ left: 16 }}>
              <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
              <XAxis type="number" allowDecimals={false} tick={{ fill: "var(--color-secondary)", fontSize: 12 }} />
              <YAxis
                type="category"
                dataKey="key"
                tick={{ fill: "var(--color-secondary)", fontSize: 12 }}
                width={70}
              />
              <Tooltip />
              <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                {items.map((item) => (
                  <BarChartCell key={item.key} fill={colorForKey(item.key)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="h-24 flex items-center justify-center text-sm text-muted">
          ไม่มีข้อมูลในช่วงนี้
        </div>
      )}
    </div>
  );
}

/** wrapper เล็ก ๆ สำหรับ Recharts Cell (แยกออกมาเพื่อความชัดเจน) */
function BarChartCell({ fill }: { fill: string }) {
  // recharts ใช้ React.Children ของ <Bar> เป็น <Cell> — import ตรงนี้เพื่อหลีกเลี่ยง unused import warning
  return <Cell fill={fill} />;
}

// =============================================================================
// MAIN PAGE COMPONENT
// =============================================================================

export default function ReportsPage() {
  const defaultRange = rangeFromPreset("30d");

  const [appliedRange, setAppliedRange] = useState<DateRange>(defaultRange);
  const [draftFrom, setDraftFrom] = useState<string>(defaultRange.from);
  const [draftTo, setDraftTo] = useState<string>(defaultRange.to);
  const [activePreset, setActivePreset] = useState<PresetKey | null>("30d");
  const [validationError, setValidationError] = useState<string | null>(null);

  const [reportData, setReportData] = useState<ReportData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFeatureLocked, setIsFeatureLocked] = useState(false);

  const fetchReport = useCallback(async (range: DateRange) => {
    setIsLoading(true);
    setError(null);
    setIsFeatureLocked(false);

    try {
      const params = new URLSearchParams({ from: range.from, to: range.to });
      const res = await fetch(`/api/reports?${params.toString()}`, {
        credentials: "include",
      });

      const json = (await res.json()) as ReportApiResponse;

      if (res.status === 403 && json.error?.code === "FEATURE_LOCKED") {
        setIsFeatureLocked(true);
        return;
      }

      if (!res.ok || json.error || !json.data) {
        setError(json.error?.message ?? "โหลดข้อมูลรายงานไม่สำเร็จ");
        return;
      }

      setReportData(json.data);
    } catch {
      setError("ไม่สามารถเชื่อมต่อได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // deferred ผ่าน microtask — กัน setState synchronous ใน effect body
    queueMicrotask(() => void fetchReport(appliedRange));
  }, [appliedRange, fetchReport]);

  // ─── handlers ──────────────────────────────────────────────────────────────

  function handlePresetClick(preset: PresetKey) {
    const range = rangeFromPreset(preset);
    setActivePreset(preset);
    setValidationError(null);
    setDraftFrom(range.from);
    setDraftTo(range.to);
    setAppliedRange(range);
  }

  function handleFromChange(value: string) {
    setActivePreset(null);
    setDraftFrom(value);
  }

  function handleToChange(value: string) {
    setActivePreset(null);
    setDraftTo(value);
  }

  function handleApply() {
    if (!draftFrom || !draftTo) {
      setValidationError("กรุณาเลือกวันที่เริ่มต้นและสิ้นสุด");
      return;
    }
    if (draftFrom > draftTo) {
      setValidationError("วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด");
      return;
    }
    setValidationError(null);
    setAppliedRange({ from: draftFrom, to: draftTo });
  }

  // ─── early returns ─────────────────────────────────────────────────────────

  if (isFeatureLocked) {
    return <FeatureLockedState />;
  }

  const kpis = reportData?.kpis ?? null;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">รายงาน &amp; วิเคราะห์</h1>
          <p className="mt-0.5 text-sm text-secondary">
            สรุปภาพรวมและแนวโน้มของ ticket ในทีมคุณ
          </p>
        </div>
        <button
          type="button"
          onClick={() => void fetchReport(appliedRange)}
          disabled={isLoading}
          aria-label="รีเฟรชข้อมูล"
          className="p-2 rounded-lg border border-border text-secondary hover:bg-stone disabled:opacity-40 transition-colors focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} aria-hidden="true" />
        </button>
      </div>

      {/* Date range controls */}
      <DateRangeControls
        draftFrom={draftFrom}
        draftTo={draftTo}
        activePreset={activePreset}
        validationError={validationError}
        onPresetClick={handlePresetClick}
        onFromChange={handleFromChange}
        onToChange={handleToChange}
        onApply={handleApply}
      />

      {/* Error state */}
      {error && <FormAlert variant="error" message={error} />}

      {/* KPI Cards */}
      {isLoading ? (
        <KpiCardsSkeleton />
      ) : kpis ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <KpiCard
            label="Ticket ที่สร้าง"
            value={String(kpis.ticketsCreated)}
            icon={<Inbox size={18} />}
          />
          <KpiCard
            label="Ticket ที่แก้ไขเสร็จ"
            value={String(kpis.ticketsResolved)}
            icon={<CheckCircle size={18} />}
          />
          <KpiCard
            label="เวลาตอบครั้งแรกเฉลี่ย"
            value={formatMinutes(kpis.avgFirstResponseMinutes)}
            icon={<Clock size={18} />}
          />
          <KpiCard
            label="เวลาแก้ไขเฉลี่ย"
            value={formatMinutes(kpis.avgResolutionMinutes)}
            icon={<Timer size={18} />}
          />
          <KpiCard
            label="SLA Breach Rate"
            value={`${(kpis.slaBreachRate * 100).toFixed(1)}%`}
            icon={<AlertTriangle size={18} />}
            valueColorClass={getSlaBreachColorClass(kpis.slaBreachRate)}
          />
          <KpiCard
            label="CSAT เฉลี่ย"
            value={kpis.csatAverage === null ? "—" : `${kpis.csatAverage.toFixed(2)} / 5`}
            icon={<Star size={18} />}
          />
        </div>
      ) : null}

      {/* Trend chart */}
      {isLoading ? (
        <ChartSkeleton heightClass="h-[300px]" />
      ) : reportData ? (
        <div className="rounded-xl border border-border bg-surface p-4 flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-foreground">แนวโน้ม Ticket รายวัน</h3>
          {reportData.trend.some((point) => point.created > 0 || point.resolved > 0) ? (
            <div style={{ height: 300 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={reportData.trend}>
                  <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={formatShortDate}
                    tick={{ fill: "var(--color-secondary)", fontSize: 12 }}
                  />
                  <YAxis allowDecimals={false} tick={{ fill: "var(--color-secondary)", fontSize: 12 }} />
                  <Tooltip labelFormatter={(value) => formatShortDate(String(value))} />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="created"
                    name="สร้างใหม่"
                    stroke="var(--color-primary)"
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="resolved"
                    name="แก้ไขเสร็จ"
                    stroke="var(--color-success)"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-24 flex items-center justify-center text-sm text-muted">
              ไม่มีข้อมูลในช่วงนี้
            </div>
          )}
        </div>
      ) : null}

      {/* Breakdown charts */}
      {isLoading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ChartSkeleton heightClass="h-[300px]" />
          <ChartSkeleton heightClass="h-[300px]" />
        </div>
      ) : reportData ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <BreakdownChart
            title="แยกตาม Priority"
            items={reportData.byPriority}
            colorForKey={getPriorityColor}
          />
          <BreakdownChart
            title="แยกตาม Channel"
            items={reportData.byChannel}
            colorForKey={() => "var(--color-primary)"}
          />
        </div>
      ) : null}
    </div>
  );
}
