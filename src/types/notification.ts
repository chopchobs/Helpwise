/**
 * notification.ts — Type definitions สำหรับ Notification domain (agent-only)
 *
 * ⚠️ notification เป็น agent-audience เท่านั้น — portal (ลูกค้า) ห้ามเห็น
 *
 * ใช้ใน: agent workspace UI (NotificationBell), notifications API
 */

import type { ApiError } from "@/types/ticket";

// =============================================================================
// NOTIFICATION DTO
// =============================================================================

export type NotificationType = "TICKET_ASSIGNED";

export interface NotificationDTO {
  id: string;
  type: NotificationType;
  /** ticket ที่เกี่ยวข้อง — null = ไม่มีลิงก์ไป ticket */
  ticketId: string | null;
  /** ISO datetime — null = ยังไม่อ่าน */
  readAt: string | null;
  createdAt: string;
}

// =============================================================================
// RESPONSE SHAPES
// =============================================================================

/** Response shape: GET /api/notifications */
export interface NotificationListResponse {
  data: {
    notifications: NotificationDTO[];
    unreadCount: number;
  } | null;
  error: ApiError | null;
}

/** Response shape: PATCH /api/notifications/:id */
export interface NotificationMarkReadResponse {
  data: NotificationDTO | null;
  error: ApiError | null;
}
