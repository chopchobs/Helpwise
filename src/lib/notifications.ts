/**
 * src/lib/notifications.ts
 * Service layer สำหรับ Notification (agent-audience) — reuse ได้จากหลาย producer
 *
 * ⚠️ CRITICAL — Tenant Isolation:
 *   - createNotification รับ `db = tenantPrisma(tenantId)` เป็น argument
 *   - ไม่ resolve tenant context เอง — caller รับผิดชอบส่ง scoped client ที่ถูกต้อง
 *   - tenantId ถูก inject อัตโนมัติผ่าน extension ตอน create — ไม่ต้องส่งซ้ำที่นี่
 *
 * ⚠️ recipient scope:
 *   - memberId = recipient (agent) ที่จะเห็น notification นี้
 *   - การ "เห็น/mark-read" scope ที่ระดับ route (memberId = current member) — helper นี้แค่สร้าง
 */

import type { NotificationType, Prisma } from "@prisma/client";
import type { TenantScopedPrisma } from "@/lib/tenant";

// =============================================================================
// TYPES
// =============================================================================

export interface CreateNotificationInput {
  /** recipient (agent) — TenantMember.id ของผู้ที่จะได้รับ notification */
  memberId: string;
  type: NotificationType;
  /** ticket ที่เกี่ยว (optional) */
  ticketId?: string;
}

// =============================================================================
// createNotification
// =============================================================================

/**
 * สร้าง Notification ให้ recipient (agent) หนึ่งคน
 *
 * @param db   tenant-scoped Prisma client (tenantId inject อัตโนมัติผ่าน extension)
 * @param input { memberId, type, ticketId? } — ใช้ scalar memberId/ticketId ห้าม {connect}
 *              (extension reject relation-connect — ดู tenant.ts)
 */
export async function createNotification(
  db: TenantScopedPrisma,
  { memberId, type, ticketId }: CreateNotificationInput
): Promise<void> {
  // tenantId ถูก inject อัตโนมัติโดย tenantPrisma extension ตอน runtime —
  // type ของ Prisma ยังบังคับ tenantId อยู่ จึง cast ผ่าน Omit (ใช้ scalar memberId/ticketId
  // ไม่ใช่ {connect} เพราะ extension reject relation-connect)
  const data: Omit<Prisma.NotificationUncheckedCreateInput, "tenantId"> = {
    memberId,
    type,
    ...(ticketId ? { ticketId } : {}),
  };
  await db.notification.create({
    data: data as Prisma.NotificationUncheckedCreateInput,
  });
}
