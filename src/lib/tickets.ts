/**
 * src/lib/tickets.ts
 * Service layer สำหรับ Ticket business logic — reuse ได้จากทั้ง agent และ portal route
 *
 * ⚠️ CRITICAL — Tenant Isolation:
 *   - ทุก function รับ `db = tenantPrisma(tenantId)` เป็น argument
 *   - ไม่ resolve tenant context เอง — caller รับผิดชอบส่ง scoped client ที่ถูกต้อง
 *   - กัน cross-tenant contamination และทำให้ test/reuse ง่ายขึ้น
 *
 * ⚠️ ticketNumber race condition:
 *   ใช้ interactive transaction + retry loop (max 3 ครั้ง) เมื่อชน P2002
 *   โดยอาศัย @@unique([tenantId, ticketNumber]) เป็น DB-level guard
 *
 *   หมายเหตุเรื่อง tenantPrisma ภายใน transaction:
 *   tenantPrisma extension ทำงานผ่าน $extends callback — เมื่อ pass tx (transaction client)
 *   เข้า interactive transaction callback, tx เป็น Prisma client ธรรมดา (ไม่มี extension)
 *   ดังนั้นภายใน transaction ต้องใส่ tenantId ใน where/data เองอย่างชัดเจน
 *   เพื่อความปลอดภัย (ไม่ต้องเดาว่า extension ทำงานหรือเปล่า)
 */

import { Prisma, TicketStatus, TicketPriority, MessageVisibility } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { TenantScopedPrisma } from "@/lib/tenant";

// =============================================================================
// TYPES
// =============================================================================

export interface CreateTicketInput {
  tenantId: string;
  subject: string;
  requesterContactId: string;
  priority?: TicketPriority;
  channel?: string;
  firstMessage?: {
    body: string;
    visibility?: MessageVisibility;
    /** authorMemberId หรือ authorContactId อย่างใดอย่างหนึ่งต้องไม่ null */
    authorMemberId?: string;
    authorContactId?: string;
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
}

// =============================================================================
// TICKET NUMBER GENERATOR (atomic + unique per tenant)
// =============================================================================

/**
 * สร้าง Ticket พร้อม ticketNumber ที่ unique ต่อ tenant แบบ atomic
 *
 * กลยุทธ์:
 *   - ใช้ prisma.$transaction() interactive transaction เพื่อ atomic read-then-create
 *   - หา max(ticketNumber) ของ tenant + 1 ภายใน transaction เดียว
 *   - อาศัย @@unique([tenantId, ticketNumber]) เป็น DB-level guard สุดท้าย
 *   - retry สูงสุด 3 ครั้งเมื่อชน P2002 (unique constraint violation จาก race)
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
  const { tenantId, subject, requesterContactId, priority, channel, firstMessage } = input;

  // MAX_RETRIES สูงขึ้น + jitter backoff เพื่อทน burst contention บน tenant เดียว
  // (smoke test: create พร้อมกันหลายอันแล้วชน @@unique([tenantId, ticketNumber]))
  // วิธี max+1 แย่ง lock กันโดยธรรมชาติ — retry พร้อม jitter ช่วยให้ collide แล้วกระจายตัว
  const MAX_RETRIES = 10;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // ใช้ prisma (ไม่ใช่ db) สำหรับ interactive transaction เพราะ tx client ไม่มี extension
      // แต่ inject tenantId เองทุกที่เพื่อ guarantee tenant isolation
      const result = await prisma.$transaction(async (tx) => {
        // หา ticketNumber สูงสุดของ tenant นี้ ภายใน transaction เดียวกัน
        // ใส่ tenantId ใน where อย่างชัดเจน (tx ไม่มี extension)
        const maxResult = await tx.ticket.aggregate({
          where: { tenantId },
          _max: { ticketNumber: true },
        });

        const nextTicketNumber = (maxResult._max.ticketNumber ?? 0) + 1;

        // สร้าง ticket — ใส่ tenantId ใน data อย่างชัดเจน
        const ticket = await tx.ticket.create({
          data: {
            tenantId,
            ticketNumber: nextTicketNumber,
            subject,
            requesterContactId,
            priority: priority ?? TicketPriority.NORMAL,
            channel: channel ?? "portal",
            status: TicketStatus.NEW,
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
            },
          });
        }

        return ticket;
      });

      return result;
    } catch (err) {
      // P2002 = unique constraint violation — ticketNumber ชนจาก race condition
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002" &&
        attempt < MAX_RETRIES - 1
      ) {
        console.warn(
          `[tickets] ticketNumber race detected (attempt ${attempt + 1}/${MAX_RETRIES}), retrying...`,
          { tenantId }
        );
        // jitter backoff: หน่วงสุ่ม (เพิ่มตาม attempt) เพื่อกระจาย retry ที่ชนกัน
        // transaction abort แล้ว number จะถูก recalculate ใน round ถัดไป
        const backoffMs = Math.floor(Math.random() * 25) + attempt * 15;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw err;
    }
  }

  // ถ้าถึงตรงนี้หมายความว่า retry ครบ MAX_RETRIES แต่ TypeScript ต้องการ return
  throw new Error(`[tickets] Failed to generate unique ticketNumber after ${MAX_RETRIES} attempts`);
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
  const { tenantId, ticketId, body, visibility, authorMemberId, authorContactId } = input;

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
