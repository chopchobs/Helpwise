/**
 * src/lib/audit.ts
 * Immutable Audit Log helper
 *
 * ⚠️ AuditLog เป็น append-only — ห้าม update หรือ delete record นี้เด็ดขาด
 *    ใช้ audit.log() ทุกครั้ง — ห้าม create AuditLog ตรง ๆ ผ่าน prisma.auditLog.create
 *
 * Actions ที่ต้อง log (จาก CLAUDE.md):
 *   - ticket.status_changed, ticket.assigned, ticket.priority_changed
 *   - ticket.merged, ticket.closed, ticket.reopened
 *   - member.invited, member.role_changed, member.deactivated
 *   - contact.created, contact.updated
 *   - subscription.plan_changed, subscription.status_changed
 *
 * Actor types:
 *   - "user"    → actorUserId (User.id — global)
 *   - "member"  → actorMemberId (TenantMember.id — tenant-scoped)
 *   - "contact" → actorContactId (Contact.id — tenant-scoped)
 *   - "system"  → ไม่มี actor id (background job, webhook)
 *
 * ห้าม log PII หรือ sensitive data (เช่น password, full credit card) ใน before/after
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// =============================================================================
// ACTOR TYPES (Discriminated Union)
// =============================================================================

export type AuditActor =
  | { type: "user"; userId: string }
  | { type: "member"; memberId: string }
  | { type: "contact"; contactId: string }
  | { type: "system" };

// =============================================================================
// AUDIT LOG PARAMS
// =============================================================================

export interface AuditLogParams {
  /** tenant ที่เกิด event นี้ขึ้น */
  tenantId: string;
  /** ผู้กระทำ — discriminated union */
  actor: AuditActor;
  /** ประเภทของ entity ที่ถูกกระทำ เช่น "ticket", "contact", "tenant_member" */
  targetType: string;
  /** ID ของ entity นั้น */
  targetId: string;
  /** action เช่น "ticket.status_changed", "member.invited" */
  action: string;
  /** state ก่อนเปลี่ยน (optional) — ห้าม include sensitive fields */
  before?: Prisma.InputJsonValue;
  /** state หลังเปลี่ยน (optional) */
  after?: Prisma.InputJsonValue;
  /** ticketId ถ้า event นี้เกี่ยวกับ ticket (ไว้ query audit log ของ ticket โดยตรง) */
  ticketId?: string;
  /** metadata เพิ่มเติม เช่น IP, channel, reason */
  metadata?: Prisma.InputJsonValue;
}

// =============================================================================
// AUDIT OBJECT
// =============================================================================

/**
 * audit.log(params) — สร้าง AuditLog record (immutable, append-only)
 *
 * ใช้แทนการ call prisma.auditLog.create ตรง ๆ เพื่อ:
 *   1. enforce schema ของ params ผ่าน TypeScript
 *   2. map AuditActor discriminated union เป็น column ที่ถูกต้อง
 *   3. กัน programmer ลืม tenantId หรือ actor
 *
 * ถ้า log ล้มเหลว → log error แต่ไม่ throw (ไม่ควร block main operation เพราะ audit log ล้ม)
 * ยกเว้น: ถ้า caller ต้องการ strict mode สามารถใช้ audit.logStrict() แทน
 */
export const audit = {
  async log(params: AuditLogParams): Promise<void> {
    try {
      await createAuditLog(params);
    } catch (err) {
      // ไม่ throw เพื่อไม่ให้ audit log ล้มแล้ว block business operation
      // แต่ log error ไว้ตรวจสอบ
      console.error("[audit] Failed to create audit log:", {
        action: params.action,
        tenantId: params.tenantId,
        targetType: params.targetType,
        targetId: params.targetId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * logStrict — เหมือน log แต่ throw ถ้า insert ล้ม
   * ใช้ใน transaction ที่ต้องการ audit log เป็น part of atomicity
   */
  async logStrict(params: AuditLogParams): Promise<void> {
    await createAuditLog(params);
  },
};

// =============================================================================
// INTERNAL — สร้าง AuditLog record จริง
// =============================================================================

async function createAuditLog(params: AuditLogParams): Promise<void> {
  const {
    tenantId,
    actor,
    targetType,
    targetId,
    action,
    before,
    after,
    ticketId,
    metadata = {},
  } = params;

  // map AuditActor discriminated union เป็น column
  let actorUserId: string | undefined;
  let actorMemberId: string | undefined;
  let actorContactId: string | undefined;

  switch (actor.type) {
    case "user":
      actorUserId = actor.userId;
      break;
    case "member":
      actorMemberId = actor.memberId;
      break;
    case "contact":
      actorContactId = actor.contactId;
      break;
    case "system":
      // ไม่มี actor id
      break;
  }

  // ใช้ prisma โดยตรง (ไม่ผ่าน tenantPrisma) เพราะ tenantPrisma inject tenantId เข้า data
  // แต่เราต้องการ set tenantId เองให้ชัดเจน + AuditLog เป็น global concern ของ audit system
  // NOTE: tenantId ส่งมาจาก TenantContext ที่ verify แล้ว — ไม่ได้มาจาก client
  await prisma.auditLog.create({
    data: {
      tenantId,
      actorType: actor.type,
      actorUserId,
      actorMemberId,
      actorContactId,
      targetType,
      targetId,
      action,
      before: before ?? undefined,
      after: after ?? undefined,
      ticketId,
      metadata: metadata ?? {},
    },
  });
}
