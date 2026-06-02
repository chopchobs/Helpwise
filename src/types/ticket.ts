/**
 * ticket.ts — Type definitions ฝั่ง client สำหรับ API response shapes ของ Ticket domain
 * ใช้ร่วมกันระหว่าง agent UI และ portal UI
 */

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

/** รูปแบบ assignee (agent view) */
export interface AssigneeInfo {
  id: string;
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
}

/** Ticket detail ฝั่ง agent — มี messages array */
export interface AgentTicketDetail extends AgentTicketSummary {
  messages: AgentTicketMessage[];
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
// SHARED ERROR SHAPE
// =============================================================================

export interface ApiError {
  code: string;
  message: string;
}
