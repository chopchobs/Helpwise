/**
 * src/lib/tickets.ts
 * Service layer สำหรับ Ticket business logic — reuse ได้จากทั้ง agent และ portal route
 *
 * ⚠️ CRITICAL — Tenant Isolation:
 *   - ทุก function รับ `db = tenantPrisma(tenantId)` เป็น argument
 *   - ไม่ resolve tenant context เอง — caller รับผิดชอบส่ง scoped client ที่ถูกต้อง
 *   - กัน cross-tenant contamination และทำให้ test/reuse ง่ายขึ้น
 *
 * ⚠️ ticketNumber generation:
 *   ใช้ atomic counter — `tx.tenant.update({ data: { ticketCounter: { increment: 1 } } })`
 *   ภายใน interactive transaction เดียวกับการสร้าง ticket (atomic, ไม่ต้อง retry)
 *   row lock บน Tenant row serialize การสร้าง ticket พร้อมกันของ tenant เดียวกัน
 *   @@unique([tenantId, ticketNumber]) ยังคงอยู่เป็น DB-level safety net
 *
 *   หมายเหตุเรื่อง tenantPrisma ภายใน transaction:
 *   tenantPrisma extension ทำงานผ่าน $extends callback — เมื่อ pass tx (transaction client)
 *   เข้า interactive transaction callback, tx เป็น Prisma client ธรรมดา (ไม่มี extension)
 *   ดังนั้นภายใน transaction ต้องใส่ tenantId ใน where/data เองอย่างชัดเจน
 *   เพื่อความปลอดภัย (ไม่ต้องเดาว่า extension ทำงานหรือเปล่า)
 */

import { TicketStatus, TicketPriority, MessageVisibility } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantScopedPrisma } from "@/lib/tenant";
import { hasFeature, FEATURE_KEYS } from "@/lib/features";
import { parseBusinessHours, computeDeadlines } from "@/lib/sla";

// =============================================================================
// TYPES
// =============================================================================

export interface CreateTicketInput {
  tenantId: string;
  subject: string;
  requesterContactId: string;
  /** assigneeId = TenantMember.id — caller ต้อง verify ผ่าน verifyAssigneeMembership ก่อนส่งมา */
  assigneeId?: string;
  priority?: TicketPriority;
  channel?: string;
  /** Message-ID ของ inbound email ที่สร้าง ticket นี้ — เก็บที่ Ticket.emailMessageId */
  emailMessageId?: string;
  /**
   * plan ปัจจุบันของ tenant — ส่งเพื่อกัน extra DB query ใน hasFeature()
   * ได้จาก ctx.plan ของ TenantContext (proxy inject ไว้แล้ว)
   * ถ้าไม่ส่ง hasFeature จะ query DB เอง (1 query เพิ่ม)
   */
  plan?: string;
  firstMessage?: {
    body: string;
    visibility?: MessageVisibility;
    /** authorMemberId หรือ authorContactId อย่างใดอย่างหนึ่งต้องไม่ null */
    authorMemberId?: string;
    authorContactId?: string;
    // === Email threading fields ===
    emailMessageId?: string;
    emailInReplyTo?: string;
    emailReferences?: string;
    emailSentAt?: Date;
  };
}

export interface CreateMessageInput {
  tenantId: string;
  ticketId: string;
  body: string;
  visibility: MessageVisibility;
  /** authorMemberId หรือ authorContactId อย่างใดอย่างหนึ่งต้องไม่ null */
  authorMemberId?: string;
  authorContactId?: string;
  // === Email threading fields ===
  emailMessageId?: string;
  emailInReplyTo?: string;
  emailReferences?: string;
  emailSentAt?: Date;
}

// =============================================================================
// TICKET NUMBER GENERATOR (atomic + unique per tenant)
// =============================================================================

/**
 * สร้าง Ticket พร้อม ticketNumber ที่ unique ต่อ tenant แบบ atomic
 *
 * กลยุทธ์:
 *   - ใช้ prisma.$transaction() interactive transaction
 *   - atomic increment `Tenant.ticketCounter` ภายใน tx เดียวกับ ticket.create
 *     (row lock บน Tenant row serialize การสร้าง ticket ของ tenant เดียวกัน — ไม่มี race, ไม่ต้อง retry)
 *   - @@unique([tenantId, ticketNumber]) ยังอยู่เป็น DB-level safety net
 *
 * เหตุผลที่ไม่ใช้ tenantPrisma ภายใน tx:
 *   Prisma interactive transaction ส่ง tx client ที่ไม่มี $extends — extension ไม่ทำงาน
 *   จึงใส่ tenantId ใน where/data เองอย่างชัดเจนเพื่อ guarantee tenant scope
 *
 * @param db - tenant-scoped prisma client (tenantPrisma(tenantId)) — เพื่อ derive tenantId
 * @param input - ข้อมูล ticket ที่ต้องการสร้าง
 */
export async function createTicketWithNumber(
  db: TenantScopedPrisma,
  input: CreateTicketInput
) {
  const { tenantId, subject, requesterContactId, assigneeId, priority, channel, emailMessageId, firstMessage, plan } = input;

  // ==========================================================================
  // SLA: คำนวณ deadline ก่อนเปิด transaction (หลีกเลี่ยง async inside tx)
  // ขั้นตอน:
  //   1. ตรวจ feature gate sla_policies — ถ้าปิดอยู่ไม่ต้อง query policy
  //   2. หา default SlaPolicy ของ tenant (tenant-scoped)
  //   3. อ่าน Tenant.settings → businessHours
  //   4. คำนวณ deadline จาก createdAt baseline (ใช้ now() ณ จุดนี้)
  //   5. ส่ง precomputed due dates เข้า tx.ticket.create เพื่อ atomic
  // ==========================================================================

  interface SlaCreateData {
    slaPolicyId?: string;
    firstResponseDueAt?: Date;
    resolutionDueAt?: Date;
  }

  let slaData: SlaCreateData = {};

  const slaEnabled = await hasFeature(tenantId, FEATURE_KEYS.SLA_POLICIES, plan);

  if (slaEnabled) {
    // query default policy + tenant settings แบบ parallel เพื่อลด latency
    const [defaultPolicy, tenantSettings] = await Promise.all([
      // tenant-scoped: ค้นหา default SlaPolicy ของ tenant นี้
      // ใช้ prisma โดยตรง (ไม่ใช้ db/tenantPrisma) เพราะต้องระบุ tenantId เองใน where
      // และการ query นี้เกิดก่อน tx — ไม่มี race condition กับ ticket create
      prisma.slaPolicy.findFirst({
        where: { tenantId, isDefault: true },
        select: {
          id: true,
          firstResponseLowMin: true,
          firstResponseNormMin: true,
          firstResponseHighMin: true,
          firstResponseUrgMin: true,
          resolutionLowMin: true,
          resolutionNormMin: true,
          resolutionHighMin: true,
          resolutionUrgMin: true,
        },
      }),
      // อ่าน settings ของ tenant เพื่อดึง business hours
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { settings: true },
      }),
    ]);

    const businessHours = parseBusinessHours(tenantSettings?.settings ?? null);
    const startAt = new Date(); // baseline = เวลาสร้าง ticket
    const effectivePriority = priority ?? TicketPriority.NORMAL;

    const { firstResponseDueAt, resolutionDueAt } = computeDeadlines({
      startAt,
      priority: effectivePriority,
      policy: defaultPolicy ?? null,
      businessHours,
    });

    slaData = {
      ...(defaultPolicy ? { slaPolicyId: defaultPolicy.id } : {}),
      firstResponseDueAt,
      resolutionDueAt,
    };
  }

  // ใช้ prisma (ไม่ใช่ db) สำหรับ interactive transaction เพราะ tx client ไม่มี extension
  // แต่ inject tenantId เองทุกที่เพื่อ guarantee tenant isolation
  const result = await prisma.$transaction(async (tx) => {
    // atomic increment ticketCounter ของ tenant นี้ — row lock บน Tenant row
    // serialize การสร้าง ticket พร้อมกันของ tenant เดียวกัน → ได้เลข unique โดยไม่ต้อง retry
    const counter = await tx.tenant.update({
      where: { id: tenantId },
      data: { ticketCounter: { increment: 1 } },
      select: { ticketCounter: true },
    });

    const nextTicketNumber = counter.ticketCounter;

    // สร้าง ticket — ใส่ tenantId ใน data อย่างชัดเจน
    // assigneeId ที่ส่งมาถูก verify จาก verifyAssigneeMembership แล้วที่ caller
    // tx ไม่มี extension — ใส่ tenantId ใน data เองเพื่อ guarantee tenant scope
    // slaData ถูก precompute ก่อน tx — inject ตรงนี้เพื่อ atomic (ไม่มี post-create update)
    const ticket = await tx.ticket.create({
      data: {
        tenantId,
        ticketNumber: nextTicketNumber,
        subject,
        requesterContactId,
        assigneeId: assigneeId ?? null,
        priority: priority ?? TicketPriority.NORMAL,
        channel: channel ?? "portal",
        status: TicketStatus.NEW,
        // เก็บ Message-ID ของ inbound email ที่สร้าง ticket นี้ (ถ้ามี)
        emailMessageId: emailMessageId ?? null,
        // SLA deadlines — set เฉพาะเมื่อ feature เปิดอยู่ (slaData ไม่ว่างเปล่า)
        ...slaData,
      },
    });

    // สร้าง firstMessage ถ้ามี
    if (firstMessage) {
      // ตรวจ exactly one author (app layer constraint)
      if (!firstMessage.authorMemberId && !firstMessage.authorContactId) {
        throw new Error("firstMessage ต้องมี authorMemberId หรือ authorContactId");
      }

      await tx.ticketMessage.create({
        data: {
          tenantId,
          ticketId: ticket.id,
          body: firstMessage.body,
          visibility: firstMessage.visibility ?? MessageVisibility.PUBLIC,
          authorMemberId: firstMessage.authorMemberId ?? null,
          authorContactId: firstMessage.authorContactId ?? null,
          // threading fields สำหรับ inbound email (ถ้ามี)
          emailMessageId: firstMessage.emailMessageId ?? null,
          emailInReplyTo: firstMessage.emailInReplyTo ?? null,
          emailReferences: firstMessage.emailReferences ?? null,
          emailSentAt: firstMessage.emailSentAt ?? null,
        },
      });
    }

    return ticket;
  });

  return result;
}

// =============================================================================
// ASSIGNEE VALIDATION
// =============================================================================

/**
 * ตรวจว่า memberId เป็น active TenantMember ของ tenant นี้จริง
 * ใช้ก่อน assign ticket เพื่อกัน cross-tenant assignment
 *
 * @param db - tenant-scoped prisma client
 * @param memberId - TenantMember.id ที่ต้องการ verify
 * @returns TenantMember ถ้า valid, null ถ้าไม่ใช่ member ที่ active ของ tenant นี้
 */
export async function verifyAssigneeMembership(
  db: TenantScopedPrisma,
  memberId: string
) {
  // tenantPrisma inject tenantId อัตโนมัติ — ไม่ต้องใส่ tenantId ใน where ซ้ำ
  const member = await db.tenantMember.findFirst({
    where: { id: memberId, isActive: true },
    select: { id: true, userId: true, role: true, isActive: true },
  });
  return member;
}

// =============================================================================
// VERIFY CONTACT BELONGS TO TENANT
// =============================================================================

/**
 * ตรวจว่า contactId เป็น Contact ที่ active ของ tenant นี้
 * ใช้ก่อน agent สร้าง ticket แทน contact เพื่อกัน cross-tenant contact spoofing
 *
 * @param db - tenant-scoped prisma client
 * @param contactId - Contact.id ที่ต้องการ verify
 * @returns Contact ถ้า valid, null ถ้าไม่ใช่ contact ของ tenant นี้
 */
export async function verifyContactBelongsToTenant(
  db: TenantScopedPrisma,
  contactId: string
) {
  const contact = await db.contact.findFirst({
    where: { id: contactId, isActive: true },
    select: { id: true, email: true, name: true, isActive: true },
  });
  return contact;
}

// =============================================================================
// CREATE MESSAGE
// =============================================================================

/**
 * สร้าง TicketMessage และคืน message ที่สร้างแล้ว
 * บังคับ exactly one author (authorMemberId XOR authorContactId)
 *
 * @param db - tenant-scoped prisma client
 * @param input - ข้อมูล message
 */
export async function createTicketMessage(
  db: TenantScopedPrisma,
  input: CreateMessageInput
) {
  const {
    tenantId,
    ticketId,
    body,
    visibility,
    authorMemberId,
    authorContactId,
    emailMessageId,
    emailInReplyTo,
    emailReferences,
    emailSentAt,
  } = input;

  // app layer constraint: exactly one author ต้องไม่ null
  if (!authorMemberId && !authorContactId) {
    throw new Error("TicketMessage ต้องมี authorMemberId หรือ authorContactId");
  }
  if (authorMemberId && authorContactId) {
    throw new Error("TicketMessage มี author ได้แค่คนเดียว (member หรือ contact ไม่ใช่ทั้งคู่)");
  }

  // tenantPrisma inject tenantId อัตโนมัติใน create แต่ TypeScript Prisma input type
  // ยังต้องการ tenantId อยู่ — ส่งตรง ๆ เพื่อ type safety (extension จะ overwrite ด้วยค่าที่ถูกต้อง)
  const message = await db.ticketMessage.create({
    data: {
      tenantId,
      ticketId,
      body,
      visibility,
      authorMemberId: authorMemberId ?? null,
      authorContactId: authorContactId ?? null,
      // threading fields — null ถ้าไม่ใช่ email message
      emailMessageId: emailMessageId ?? null,
      emailInReplyTo: emailInReplyTo ?? null,
      emailReferences: emailReferences ?? null,
      emailSentAt: emailSentAt ?? null,
    },
    include: {
      authorMember: {
        select: { id: true, role: true, user: { select: { id: true, name: true, avatarUrl: true } } },
      },
      authorContact: {
        select: { id: true, name: true, email: true, avatarUrl: true },
      },
    },
  });

  return message;
}
