/**
 * src/types/report.ts
 * Response DTO ของ GET /api/reports — source of truth สำหรับ frontend
 *
 * ⚠️ ห้ามแก้ shape โดยไม่ sync กับ frontend (ดู Phase 24 reporting/analytics)
 */

export interface ReportKpis {
  ticketsCreated: number;
  ticketsResolved: number;
  /** ค่าเฉลี่ยเวลา first response (นาที) — null ถ้าไม่มี ticket ที่ firstRespondedAt ใน range */
  avgFirstResponseMinutes: number | null;
  /** ค่าเฉลี่ยเวลา resolution (นาที) — null ถ้าไม่มี ticket ที่ resolvedAt ใน range */
  avgResolutionMinutes: number | null;
  /** สัดส่วน ticket ที่ breach SLA ใน range (0..1) — 0 ถ้าไม่มี ticket created ใน range */
  slaBreachRate: number;
  /** ค่าเฉลี่ย CSAT rating (1..5) — null ถ้าไม่มี response ใน range */
  csatAverage: number | null;
}

export interface ReportTrendPoint {
  /** "YYYY-MM-DD" (UTC bucket) */
  date: string;
  created: number;
  resolved: number;
}

export interface ReportBreakdownItem {
  /** priority value หรือ channel value */
  key: string;
  count: number;
}

export interface ReportData {
  /** ISO8601 — echo กลับ range ที่ใช้จริงหลัง clamp/normalize */
  range: { from: string; to: string };
  kpis: ReportKpis;
  /** เรียงตามวันจากเก่า→ใหม่ ครบทุกวันใน range (วันที่ไม่มี = 0) */
  trend: ReportTrendPoint[];
  /** ครบทุก priority (LOW/NORMAL/HIGH/URGENT) แม้ count 0 */
  byPriority: ReportBreakdownItem[];
  /** เฉพาะ channel ที่มีจริง */
  byChannel: ReportBreakdownItem[];
}
