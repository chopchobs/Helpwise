/**
 * ticket.ts — Type definitions ฝั่ง client สำหรับ API response shapes ของ Ticket domain
 * ใช้ร่วมกันระหว่าง agent UI และ portal UI
 */

import type { CsatResponseDTO, PortalCsatState } from "@/types/csat";

// =============================================================================
// ENUMS (string union เพื่อให้ใช้กับ Tailwind arbitrary values ง่าย)
// =============================================================================

export type TicketStatus =
  | "NEW"
  | "OPEN"
  | "PENDING"
  | "ON_HOLD"
  | "SOLVED"
  | "CLOSED";

export type TicketPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

/**
 * MessageVisibility ใช้เฉพาะฝั่ง agent เท่านั้น
 * portal UI จะไม่ import type นี้โดยเด็ดขาด
 */
export type MessageVisibility = "PUBLIC" | "INTERNAL";

// =============================================================================
// SHARED SUB-SHAPES
// =============================================================================

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** author ที่เป็น agent (มี authorMember) */
export interface AgentAuthor {
  user: {
    name: string | null;
    avatarUrl: string | null;
  };
}

/** author ที่เป็นลูกค้า (มี authorContact) */
export interface ContactAuthor {
  id: string;
  name: string | null;
  avatarUrl: string | null;
}

// =============================================================================
// AGENT-SIDE TYPES
// =============================================================================

/** รูปแบบ contact ที่แนบมากับ ticket (agent view) */
export interface RequesterContact {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
}

export type MemberRole = "OWNER" | "ADMIN" | "AGENT" | "VIEWER";

/** รูปแบบ assignee (agent view) — ตรงกับ GET /api/tickets/:id ที่ select { id, role, user } */
export interface AssigneeInfo {
  id: string;
  role: MemberRole;
  user: {
    name: string | null;
    avatarUrl: string | null;
  };
}

/** TicketMessage ฝั่ง agent — มี visibility field (PUBLIC | INTERNAL) */
export interface AgentTicketMessage {
  id: string;
  ticketId: string;
  body: string;
  visibility: MessageVisibility;
  createdAt: string;
  authorMember: AgentAuthor | null;
  authorContact: ContactAuthor | null;
}

/**
 * SLA state snapshot ที่ agent เห็น — null เมื่อ ticket ไม่มี SLA เลย (dueAt ทั้งคู่ null)
 * ใช้ทั้งใน list summary และ detail view
 */
export interface TicketSlaInfo {
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  firstRespondedAt: string | null;
  resolvedAt: string | null;
  firstResponseBreached: boolean;
  resolutionBreached: boolean;
  /** null = ไม่ได้ pause อยู่; ISO string = กำลัง pause ณ timestamp นี้ */
  slaPausedAt: string | null;
}

/** Ticket summary สำหรับ list (agent) */
export interface AgentTicketSummary {
  id: string;
  ticketNumber: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  createdAt: string;
  updatedAt: string;
  requesterContact: RequesterContact | null;
  assignee: AssigneeInfo | null;
  _count?: {
    messages: number;
  };
  /**
   * SLA info — null เมื่อ ticket ไม่มี deadline (SLA feature ปิด หรือสร้างก่อน policy)
   * agent-side เท่านั้น ห้าม expose ผ่าน portal
   */
  sla: TicketSlaInfo | null;
  /**
   * CSAT response ของ ticket นี้ — null เมื่อยังไม่มี response
   * agent เห็นคะแนนได้ แต่ portal จะเห็นผ่าน PortalCsatState แทน
   */
  csat: CsatResponseDTO | null;
}

/** Ticket detail ฝั่ง agent — มี messages array */
export interface AgentTicketDetail extends AgentTicketSummary {
  messages: AgentTicketMessage[];
  /** ticket ปลายทางที่ ticket นี้ถูกรวมเข้า — null = ยังไม่ถูก merge */
  mergedInto: { id: string; ticketNumber: number } | null;
  /** source tickets ที่ถูกรวมเข้า ticket นี้ */
  mergedFrom: { id: string; ticketNumber: number }[];
}

/** Response shape: GET /api/tickets */
export interface AgentTicketListResponse {
  data: {
    tickets: AgentTicketSummary[];
    pagination: Pagination;
  } | null;
  error: ApiError | null;
}

/** Response shape: GET /api/tickets/:id */
export interface AgentTicketDetailResponse {
  data: AgentTicketDetail | null;
  error: ApiError | null;
}

/** Response shape: POST /api/tickets */
export interface AgentCreateTicketResponse {
  data: AgentTicketDetail | null;
  error: ApiError | null;
}

/** Response shape: PATCH /api/tickets/:id */
export interface AgentPatchTicketResponse {
  data: AgentTicketSummary | null;
  error: ApiError | null;
}

/** Response shape: POST /api/tickets/:id/messages */
export interface AgentPostMessageResponse {
  data: AgentTicketMessage | null;
  error: ApiError | null;
}

/** Response shape: POST /api/tickets/:id/merge */
export interface AgentMergeTicketResponse {
  data: {
    source: {
      id: string;
      ticketNumber: number;
      status: TicketStatus;
      mergedInto: { id: string; ticketNumber: number };
    };
    target: { id: string; ticketNumber: number };
  } | null;
  error: ApiError | null;
}

// =============================================================================
// PORTAL-SIDE TYPES
// PortalTicketMessage ไม่มี visibility field — portal เห็นเฉพาะ PUBLIC
// =============================================================================

/** TicketMessage ฝั่ง portal — ไม่มี visibility field เลย (PUBLIC only) */
export interface PortalTicketMessage {
  id: string;
  ticketId: string;
  body: string;
  createdAt: string;
  authorMember: AgentAuthor | null;
  authorContact: ContactAuthor | null;
}

/** Assignee ที่ portal เห็นได้ (ชื่อ + avatar เท่านั้น) */
export interface PortalAssigneeInfo {
  user: {
    name: string | null;
    avatarUrl: string | null;
  };
}

/** Ticket summary สำหรับ list (portal) */
export interface PortalTicketSummary {
  id: string;
  ticketNumber: number;
  subject: string;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
  _count?: {
    messages: number;
  };
}

/** Ticket detail ฝั่ง portal — messages เป็น PUBLIC เท่านั้น */
export interface PortalTicketDetail {
  id: string;
  ticketNumber: number;
  subject: string;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
  assignee: PortalAssigneeInfo | null;
  messages: PortalTicketMessage[];
  /** CSAT state สำหรับ portal widget — eligible = แสดง form, response = ยืนยันที่ส่งแล้ว */
  csat: PortalCsatState;
}

/** Response shape: GET /api/portal/tickets */
export interface PortalTicketListResponse {
  data: {
    tickets: PortalTicketSummary[];
    pagination: Pagination;
  } | null;
  error: ApiError | null;
}

/** Response shape: GET /api/portal/tickets/:id */
export interface PortalTicketDetailResponse {
  data: PortalTicketDetail | null;
  error: ApiError | null;
}

/** Response shape: POST /api/portal/tickets */
export interface PortalCreateTicketResponse {
  data: PortalTicketDetail | null;
  error: ApiError | null;
}

/** Response shape: POST /api/portal/tickets/:id/messages */
export interface PortalPostMessageResponse {
  data: {
    id: string;
    ticketId: string;
    body: string;
    createdAt: string;
    authorContact: ContactAuthor | null;
  } | null;
  error: ApiError | null;
}

// =============================================================================
// MEMBER & CONTACT LIST (สำหรับ create-ticket form + assignee dropdown)
// =============================================================================

/** รายชื่อ member ที่ใช้ใน assignee dropdown */
export interface MemberListItem {
  id: string; // TenantMember.id — ใช้เป็น assigneeId
  role: "OWNER" | "ADMIN" | "AGENT" | "VIEWER";
  user: {
    id: string;
    name: string | null;
    email: string;
    avatarUrl: string | null;
  };
}

/** Response shape: GET /api/members */
export interface MembersResponse {
  data: { members: MemberListItem[] } | null;
  error: ApiError | null;
}

/** รายชื่อ contact ที่ใช้ใน requester combobox */
export interface ContactListItem {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

/** Response shape: GET /api/contacts */
export interface ContactsResponse {
  data: { contacts: ContactListItem[] } | null;
  error: ApiError | null;
}

// =============================================================================
// AUTH & SESSION TYPES (agent workspace)
// =============================================================================

/** ข้อมูล user ที่ login อยู่ */
export interface SessionUser {
  id: string;
  name: string | null;
  email: string;
  avatarUrl: string | null;
}

/** ข้อมูล membership ใน tenant ปัจจุบัน */
export interface SessionMember {
  id: string;
  role: MemberRole;
}

/** ข้อมูล tenant ปัจจุบัน */
export interface SessionTenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
  logoUrl: string | null;
  accentColor: string | null;
}

/** Response shape: GET /api/auth/agent/me */
export interface MeResponse {
  data: {
    user: SessionUser;
    member: SessionMember;
    tenant: SessionTenant;
  } | null;
  error: ApiError | null;
}

// =============================================================================
// DASHBOARD TYPES
// =============================================================================

/** Response shape: GET /api/dashboard */
export interface DashboardResponse {
  data: {
    statusCounts: Record<TicketStatus, number>;
    myAssignedCount: number;
    myAssigned: AgentTicketSummary[];
    unassignedCount: number;
    unassigned: AgentTicketSummary[];
    recent: AgentTicketSummary[];
  } | null;
  error: ApiError | null;
}

// =============================================================================
// SHARED ERROR SHAPE
// =============================================================================

export interface ApiError {
  code: string;
  message: string;
}
