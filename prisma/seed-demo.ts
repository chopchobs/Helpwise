/**
 * prisma/seed-demo.ts
 * Seed DEMO data สำหรับ portfolio demo ของ Helpwise
 *
 * รัน: npx tsx prisma/seed-demo.ts
 * prerequisite: ต้องรัน `npx prisma db seed` ก่อน (ต้องมี Plan "pro" อยู่แล้ว)
 *
 * idempotent: upsert ทุก record ตาม unique key — รันซ้ำได้ ไม่ duplicate/error
 *   TicketMessage ไม่มี natural unique → ใช้ deterministic id + upsert by id
 *
 * ⚠️ ห้ามแตะ prisma/seed.ts (มัน seed Plans + FeatureFlags อยู่ — ห้ามพัง)
 *
 * Multi-tenancy: ข้อมูลของ acme กับ globex แยกขาด — ทุก record tenant-scoped
 *   มี tenantId; ticketNumber sequential ต่อ tenant + Tenant.ticketCounter ตรงเลขล่าสุด
 * Demo creds: role = AGENT เท่านั้น (public-by-design, จำกัดสิทธิ์ visitor)
 */

import "dotenv/config";
import {
  PrismaClient,
  Prisma,
  type MemberRole,
  type TicketStatus,
  type TicketPriority,
  type MessageVisibility,
  type TagColor,
} from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
// credentials เป็น single source of truth — import แบบ relative (tsx resolve alias @/ ไม่ได้)
import { DEMO_AGENTS, DEMO_PASSWORD } from "../src/lib/demo";

// cost factor 12 — ต้องตรงกับ src/lib/password.ts (BCRYPT_COST_FACTOR)
// hash จาก plaintext เสมอ (ห้าม hardcode hash) เพื่อให้ demo-login (ใช้ plaintext เดียวกัน) verify ผ่าน
const BCRYPT_COST_FACTOR = 12;

// สร้าง PrismaClient ตรงใน seed โดยไม่ import @/lib/prisma (tsx ไม่ resolve alias @/)
function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set — กรุณาตั้งค่าใน .env");
  }
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

// helper: now + นาที (สำหรับ SLA due dates)
function minutesFromNow(min: number): Date {
  return new Date(Date.now() + min * 60_000);
}
// helper: now - นาที (สำหรับ createdAt / responded ในอดีต)
function minutesAgo(min: number): Date {
  return new Date(Date.now() - min * 60_000);
}

// === Demo data definition (per tenant) ===

interface DemoTagDef {
  key: string; // local key อ้างใน ticket.tagKeys
  name: string;
  color: TagColor;
}

interface DemoContactDef {
  key: string; // local key อ้างใน ticket.contactKey
  email: string;
  name: string;
}

interface DemoMessageDef {
  // local id suffix → deterministic id "demo-<slug>-t<num>-m<idx>"
  author: "contact" | "agent" | "agent2";
  visibility: MessageVisibility;
  body: string;
  // นาทีก่อน now ที่ข้อความนี้ถูกสร้าง (เรียงตามลำดับเวลา)
  agoMin: number;
}

interface DemoTicketDef {
  ticketNumber: number;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  contactKey: string;
  assignee: "agent" | "agent2" | null;
  tagKeys: string[];
  // SLA: นาทีจาก now (บวก = อนาคต/ใกล้ครบกำหนด, ลบ = อดีต/เกินกำหนด). null = ไม่ตั้ง
  firstResponseDueInMin: number | null;
  resolutionDueInMin: number | null;
  // นาทีก่อน now ที่ agent ตอบครั้งแรก. null = ยังไม่ตอบ (near-breach ถ้า due ใกล้)
  firstRespondedAgoMin: number | null;
  createdAgoMin: number;
  messages: DemoMessageDef[];
}

interface DemoTenantDef {
  slug: string;
  name: string;
  settings: Prisma.InputJsonValue;
  // อีเมล demo agent คนที่ 2 (assignee variety) — agent หลักมาจาก DEMO_AGENTS
  agent2Email: string;
  agent2Name: string;
  tags: DemoTagDef[];
  contacts: DemoContactDef[];
  tickets: DemoTicketDef[];
}

// business hours (Asia/Bangkok) ใช้ร่วม — โครงสร้างตาม schema comment
const BUSINESS_HOURS = {
  timezone: "Asia/Bangkok",
  days: [
    { day: "MON", start: "09:00", end: "18:00" },
    { day: "TUE", start: "09:00", end: "18:00" },
    { day: "WED", start: "09:00", end: "18:00" },
    { day: "THU", start: "09:00", end: "18:00" },
    { day: "FRI", start: "09:00", end: "18:00" },
  ],
};

const TENANTS: DemoTenantDef[] = [
  {
    slug: "acme",
    name: "Acme Inc",
    settings: {
      businessHours: BUSINESS_HOURS,
      branding: {
        logoUrl: "https://dummyimage.com/200x60/C4652A/ffffff&text=Acme+Inc",
        accentColor: "#C4652A",
      },
    },
    agent2Email: "alex@acme.helpwise.com",
    agent2Name: "Alex Rivera",
    tags: [
      { key: "billing", name: "billing", color: "AMBER" },
      { key: "bug", name: "bug", color: "SIENNA" },
      { key: "feature", name: "feature-request", color: "SAGE" },
      { key: "vip", name: "vip", color: "TERRACOTTA" },
    ],
    contacts: [
      { key: "jane", email: "jane.cooper@northwind.example", name: "Jane Cooper" },
      { key: "marcus", email: "marcus.lee@umbra.example", name: "Marcus Lee" },
      { key: "priya", email: "priya.nair@lumon.example", name: "Priya Nair" },
      { key: "tom", email: "tom.becker@globex.example", name: "Tom Becker" },
    ],
    tickets: [
      {
        ticketNumber: 1001,
        subject: "Can't log in after password reset",
        status: "OPEN",
        priority: "HIGH",
        contactKey: "jane",
        assignee: "agent",
        tagKeys: ["bug", "vip"],
        firstResponseDueInMin: 20, // near-breach: due ใกล้ now, ยังไม่ตอบ
        resolutionDueInMin: 6 * 60,
        firstRespondedAgoMin: null,
        createdAgoMin: 40,
        messages: [
          {
            author: "contact",
            visibility: "PUBLIC",
            agoMin: 40,
            body:
              "Hi team, I requested a password reset this morning and followed the link in the email. " +
              "After setting a new password I keep getting 'Invalid credentials' on the login screen. " +
              "I've tried three different browsers and cleared my cache but nothing works. " +
              "This is blocking me from accessing our weekly billing report which is due today — can you help urgently?",
          },
          {
            author: "agent",
            visibility: "INTERNAL",
            agoMin: 30,
            body:
              "Checked auth logs — her reset token was consumed successfully but the new password hash " +
              "doesn't match any login attempt timestamp. Possible the reset email link was opened twice " +
              "and the second click invalidated the first token. Looping in to reproduce before replying.",
          },
        ],
      },
      {
        ticketNumber: 1002,
        subject: "Invoice double-charged for May subscription",
        status: "PENDING",
        priority: "URGENT",
        contactKey: "marcus",
        assignee: "agent2",
        tagKeys: ["billing", "vip"],
        firstResponseDueInMin: null,
        resolutionDueInMin: 2 * 60,
        firstRespondedAgoMin: 110,
        createdAgoMin: 130,
        messages: [
          {
            author: "contact",
            visibility: "PUBLIC",
            agoMin: 130,
            body:
              "We were charged twice for our Pro subscription this month — two identical charges of 990 THB " +
              "appeared on our statement on the same day. Our finance team flagged it during reconciliation. " +
              "Please refund the duplicate charge and confirm this won't happen again next cycle.",
          },
          {
            author: "agent2",
            visibility: "PUBLIC",
            agoMin: 110,
            body:
              "Thanks for flagging this, Marcus. I can see two charges on your account and I've already started " +
              "the refund for the duplicate. Refunds usually take 5–7 business days to appear. Could you confirm " +
              "the last 4 digits of the card so I can attach it to the refund request?",
          },
          {
            author: "agent2",
            visibility: "INTERNAL",
            agoMin: 108,
            body:
              "Stripe shows two payment_intents created 4 seconds apart — looks like a double webhook delivery " +
              "that wasn't deduped. Filed a note for the billing team. Waiting on card confirmation before issuing refund.",
          },
        ],
      },
      {
        ticketNumber: 1003,
        subject: "Feature request: dark mode for the agent dashboard",
        status: "NEW",
        priority: "LOW",
        contactKey: "priya",
        assignee: null,
        tagKeys: ["feature"],
        firstResponseDueInMin: 7 * 60,
        resolutionDueInMin: 48 * 60,
        firstRespondedAgoMin: null,
        createdAgoMin: 15,
        messages: [
          {
            author: "contact",
            visibility: "PUBLIC",
            agoMin: 15,
            body:
              "Our support agents work late shifts and the bright dashboard is hard on the eyes at night. " +
              "Would it be possible to add a dark mode toggle? Even a basic one would make a big difference for the team.",
          },
        ],
      },
      {
        ticketNumber: 1004,
        subject: "Email notifications stopped arriving since Monday",
        status: "OPEN",
        priority: "NORMAL",
        contactKey: "jane",
        assignee: "agent",
        tagKeys: ["bug"],
        firstResponseDueInMin: 25, // near-breach #2
        resolutionDueInMin: 20 * 60,
        firstRespondedAgoMin: null,
        createdAgoMin: 50,
        messages: [
          {
            author: "contact",
            visibility: "PUBLIC",
            agoMin: 50,
            body:
              "Since Monday morning none of our agents are receiving the email notifications when a new ticket " +
              "comes in. The in-app notifications still work, but the emails have completely stopped. " +
              "We rely on email alerts for after-hours coverage so this is becoming a real problem.",
          },
          {
            author: "agent",
            visibility: "INTERNAL",
            agoMin: 35,
            body:
              "Confirmed their notification emails are bouncing — the provider flagged their domain for a temporary " +
              "rate limit after a spike last week. Need to ask them to whitelist our sending domain and confirm SPF.",
          },
        ],
      },
      {
        ticketNumber: 1005,
        subject: "How do I export all tickets to CSV?",
        status: "SOLVED",
        priority: "LOW",
        contactKey: "priya",
        assignee: "agent2",
        tagKeys: [],
        firstResponseDueInMin: null,
        resolutionDueInMin: null,
        firstRespondedAgoMin: 280,
        createdAgoMin: 300,
        messages: [
          {
            author: "contact",
            visibility: "PUBLIC",
            agoMin: 300,
            body:
              "I need to export all of our tickets from the last quarter into a CSV file for an internal audit. " +
              "Is there a built-in way to do this, or do I need API access?",
          },
          {
            author: "agent2",
            visibility: "PUBLIC",
            agoMin: 280,
            body:
              "Great question! On the Pro plan you can export from Reports → Export. Choose your date range and " +
              "click 'Download CSV'. For automated exports you'd need API access (Enterprise). Let me know if the " +
              "manual export covers your audit needs!",
          },
        ],
      },
      {
        ticketNumber: 1006,
        subject: "Customer portal shows wrong company logo",
        status: "OPEN",
        priority: "NORMAL",
        contactKey: "tom",
        assignee: "agent",
        tagKeys: ["bug"],
        firstResponseDueInMin: 3 * 60,
        resolutionDueInMin: 18 * 60,
        firstRespondedAgoMin: 90,
        createdAgoMin: 120,
        messages: [
          {
            author: "contact",
            visibility: "PUBLIC",
            agoMin: 120,
            body:
              "When my customers open the support portal they're seeing the default Helpwise logo instead of our " +
              "branding. I uploaded our logo in settings last week and the preview looked correct. " +
              "Can you check why it isn't showing on the live portal?",
          },
          {
            author: "agent",
            visibility: "PUBLIC",
            agoMin: 90,
            body:
              "Thanks Tom — I can reproduce the issue. It looks like the logo URL is cached on our side. " +
              "I've cleared the branding cache for your workspace; can you do a hard refresh and confirm it now " +
              "shows your logo?",
          },
        ],
      },
      {
        ticketNumber: 1007,
        subject: "Need to add 3 more agent seats to our plan",
        status: "PENDING",
        priority: "NORMAL",
        contactKey: "marcus",
        assignee: "agent2",
        tagKeys: ["billing"],
        firstResponseDueInMin: null,
        resolutionDueInMin: 24 * 60,
        firstRespondedAgoMin: 160,
        createdAgoMin: 180,
        messages: [
          {
            author: "contact",
            visibility: "PUBLIC",
            agoMin: 180,
            body:
              "We're onboarding three new support staff next month and need to add agent seats. " +
              "What's the per-seat cost on the Pro plan and how do we get billed — prorated immediately or next cycle?",
          },
          {
            author: "agent2",
            visibility: "PUBLIC",
            agoMin: 160,
            body:
              "Happy to help you scale up! Additional Pro seats are prorated for the current cycle and then billed " +
              "normally going forward. I can add the three seats now if you confirm — just reply and I'll apply it.",
          },
        ],
      },
    ],
  },
  {
    slug: "globex",
    name: "Globex Corp",
    settings: {
      businessHours: BUSINESS_HOURS,
      // globex ใช้ default branding (ไม่ตั้ง logo/accent custom)
    },
    agent2Email: "dana@globex.helpwise.com",
    agent2Name: "Dana Wu",
    tags: [
      { key: "billing", name: "billing", color: "AMBER" },
      { key: "bug", name: "bug", color: "SIENNA" },
      { key: "feature", name: "feature-request", color: "SAGE" },
    ],
    contacts: [
      { key: "sara", email: "sara.kim@initech.example", name: "Sara Kim" },
      { key: "omar", email: "omar.haddad@hooli.example", name: "Omar Haddad" },
      { key: "lena", email: "lena.fischer@piedpiper.example", name: "Lena Fischer" },
    ],
    tickets: [
      {
        ticketNumber: 1001,
        subject: "API returns 401 even with a valid key",
        status: "OPEN",
        priority: "URGENT",
        contactKey: "sara",
        assignee: "agent",
        tagKeys: ["bug"],
        firstResponseDueInMin: 15, // near-breach
        resolutionDueInMin: 2 * 60,
        firstRespondedAgoMin: null,
        createdAgoMin: 25,
        messages: [
          {
            author: "contact",
            visibility: "PUBLIC",
            agoMin: 25,
            body:
              "Our integration suddenly started failing this morning. Every request to the tickets endpoint returns " +
              "401 Unauthorized, even though we're sending the same API key that worked yesterday. " +
              "We haven't rotated the key. Our nightly sync is completely down and customers are noticing.",
          },
          {
            author: "agent",
            visibility: "INTERNAL",
            agoMin: 18,
            body:
              "Their key prefix matches an ApiKey row but lastUsedAt stopped updating at 02:00. Suspect the key was " +
              "auto-revoked by our cleanup job that misfired overnight. Checking the revokedAt timestamp before replying.",
          },
        ],
      },
      {
        ticketNumber: 1002,
        subject: "Refund not received after cancellation",
        status: "PENDING",
        priority: "HIGH",
        contactKey: "omar",
        assignee: "agent2",
        tagKeys: ["billing"],
        firstResponseDueInMin: null,
        resolutionDueInMin: 5 * 60,
        firstRespondedAgoMin: 200,
        createdAgoMin: 220,
        messages: [
          {
            author: "contact",
            visibility: "PUBLIC",
            agoMin: 220,
            body:
              "I cancelled our subscription two weeks ago and was told a partial refund would be issued for the unused " +
              "period. It still hasn't shown up on our card. Can you check the status and give me a timeline?",
          },
          {
            author: "agent2",
            visibility: "PUBLIC",
            agoMin: 200,
            body:
              "Sorry for the wait, Omar. I see the refund was approved but it's stuck in 'pending' on the payment " +
              "processor side. I've escalated it and will follow up within 24 hours with a confirmation.",
          },
          {
            author: "agent2",
            visibility: "INTERNAL",
            agoMin: 198,
            body:
              "Refund is in pending state on Stripe for 12 days — that's abnormal. Need to open a ticket with the " +
              "processor. Flagging as HIGH because the customer already churned and this is a trust issue.",
          },
        ],
      },
      {
        ticketNumber: 1003,
        subject: "Request: Slack integration for new tickets",
        status: "NEW",
        priority: "NORMAL",
        contactKey: "lena",
        assignee: null,
        tagKeys: ["feature"],
        firstResponseDueInMin: 5 * 60,
        resolutionDueInMin: 24 * 60,
        firstRespondedAgoMin: null,
        createdAgoMin: 10,
        messages: [
          {
            author: "contact",
            visibility: "PUBLIC",
            agoMin: 10,
            body:
              "It would be fantastic to get a Slack notification in our #support channel whenever a new ticket is " +
              "created or assigned. Right now we're manually checking the dashboard. Is this on your roadmap?",
          },
        ],
      },
      {
        ticketNumber: 1004,
        subject: "Attachment upload fails for files over 5MB",
        status: "OPEN",
        priority: "NORMAL",
        contactKey: "sara",
        assignee: "agent",
        tagKeys: ["bug"],
        firstResponseDueInMin: 4 * 60,
        resolutionDueInMin: 20 * 60,
        firstRespondedAgoMin: 60,
        createdAgoMin: 80,
        messages: [
          {
            author: "contact",
            visibility: "PUBLIC",
            agoMin: 80,
            body:
              "When my customers try to attach screenshots larger than about 5MB to a ticket, the upload spins and " +
              "then fails with no error message. Smaller files work fine. Several customers have complained.",
          },
          {
            author: "agent",
            visibility: "INTERNAL",
            agoMin: 60,
            body:
              "Reproduced — the signed upload URL is fine but the storage bucket has a 5MB object limit on the free " +
              "tier config. Need to confirm with infra whether we bump the limit or add client-side compression.",
          },
        ],
      },
      {
        ticketNumber: 1005,
        subject: "Thanks — issue resolved quickly!",
        status: "SOLVED",
        priority: "LOW",
        contactKey: "omar",
        assignee: "agent2",
        tagKeys: [],
        firstResponseDueInMin: null,
        resolutionDueInMin: null,
        firstRespondedAgoMin: 400,
        createdAgoMin: 430,
        messages: [
          {
            author: "contact",
            visibility: "PUBLIC",
            agoMin: 430,
            body:
              "Just wanted to say the timezone issue on our SLA timers got fixed exactly as you described. " +
              "Everything is showing the right deadlines now. Appreciate the fast turnaround!",
          },
          {
            author: "agent2",
            visibility: "PUBLIC",
            agoMin: 400,
            body:
              "So glad to hear it, Omar! Thanks for confirming. I'll go ahead and mark this as solved — " +
              "don't hesitate to reach out if anything else comes up.",
          },
        ],
      },
      {
        ticketNumber: 1006,
        subject: "Agent accidentally deleted a canned response",
        status: "OPEN",
        priority: "LOW",
        contactKey: "lena",
        assignee: "agent",
        tagKeys: [],
        firstResponseDueInMin: 6 * 60,
        resolutionDueInMin: 30 * 60,
        firstRespondedAgoMin: 45,
        createdAgoMin: 70,
        messages: [
          {
            author: "contact",
            visibility: "PUBLIC",
            agoMin: 70,
            body:
              "One of our agents deleted a frequently-used canned response by mistake. Is there any way to recover it, " +
              "or do we have to recreate it from scratch? It had a fairly long template we'd refined over months.",
          },
          {
            author: "agent",
            visibility: "PUBLIC",
            agoMin: 45,
            body:
              "Sorry to hear that! Canned responses don't currently have a recovery option, but I can check our recent " +
              "backups to see if we can retrieve the text for you. Do you remember roughly when it was deleted?",
          },
        ],
      },
    ],
  },
];

// === Pro plan pricing (ตรงกับ seed.ts PLANS) ===
const PRO_PRICE_SATANG = 99000; // ฿990/เดือน
const PRO_CURRENCY = "thb";

async function main(): Promise<void> {
  const db = createClient();

  try {
    console.log("--- Helpwise DEMO Seed เริ่มต้น ---\n");

    // lookup Plan "pro" (อย่า hardcode id) — ต้อง seed มาก่อน
    const proPlan = await db.plan.findUnique({ where: { name: "pro" } });
    if (!proPlan) {
      throw new Error(
        'Plan "pro" ไม่พบใน DB — กรุณารัน `npx prisma db seed` ก่อนรัน seed-demo'
      );
    }

    // pre-hash demo password ครั้งเดียว (plaintext เดียวกันทุก tenant)
    const demoPasswordHash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_COST_FACTOR);

    for (const t of TENANTS) {
      console.log(`\n=== Tenant: ${t.slug} (${t.name}) ===`);

      // map slug → demo agent หลัก (จาก single source of truth)
      const demoAgent = DEMO_AGENTS.find((a) => a.tenantSlug === t.slug);
      if (!demoAgent) {
        throw new Error(`DEMO_AGENTS ไม่มี entry สำหรับ slug "${t.slug}"`);
      }

      // ---- Tenant ----
      const tenant = await db.tenant.upsert({
        where: { slug: t.slug },
        update: {
          name: t.name,
          planId: proPlan.id,
          settings: t.settings,
          isActive: true,
          // ticketCounter set หลังสร้าง ticket ครบ (ดูท้าย loop)
        },
        create: {
          slug: t.slug,
          name: t.name,
          planId: proPlan.id,
          settings: t.settings,
          isActive: true,
          ticketCounter: 0,
        },
      });
      console.log(`  [ok] Tenant`);

      // ---- Subscription (1 tenant = 1 subscription) ----
      await db.subscription.upsert({
        where: { tenantId: tenant.id },
        update: {
          status: "ACTIVE",
          currentPriceAmount: PRO_PRICE_SATANG,
          currency: PRO_CURRENCY,
          planName: "pro",
          currentPeriodStart: minutesAgo(10 * 24 * 60), // ~10 วันก่อน
          currentPeriodEnd: minutesFromNow(20 * 24 * 60), // ~20 วันข้างหน้า
        },
        create: {
          tenantId: tenant.id,
          status: "ACTIVE",
          currentPriceAmount: PRO_PRICE_SATANG,
          currency: PRO_CURRENCY,
          planName: "pro",
          currentPeriodStart: minutesAgo(10 * 24 * 60),
          currentPeriodEnd: minutesFromNow(20 * 24 * 60),
        },
      });
      console.log(`  [ok] Subscription (ACTIVE, pro)`);

      // ---- Demo agent หลัก (User global + TenantMember AGENT) ----
      const demoUser = await db.user.upsert({
        where: { email: demoAgent.email },
        update: { name: demoAgent.name, passwordHash: demoPasswordHash, isActive: true },
        create: {
          email: demoAgent.email,
          name: demoAgent.name,
          passwordHash: demoPasswordHash,
          isActive: true,
        },
      });
      const demoMember = await db.tenantMember.upsert({
        where: { tenantId_userId: { tenantId: tenant.id, userId: demoUser.id } },
        update: { role: "AGENT" as MemberRole, isActive: true },
        create: {
          tenantId: tenant.id,
          userId: demoUser.id,
          role: "AGENT" as MemberRole, // public-by-design → จำกัดสิทธิ์ AGENT เท่านั้น
          isActive: true,
        },
      });

      // ---- Agent คนที่ 2 (assignee variety) — ไม่ใช่ demo-login (password สุ่ม) ----
      const agent2User = await db.user.upsert({
        where: { email: t.agent2Email },
        update: { name: t.agent2Name, isActive: true },
        create: {
          email: t.agent2Email,
          name: t.agent2Name,
          // ไม่ใช่ login account สาธารณะ → hash password สุ่ม (ไม่มีใครรู้ plaintext)
          passwordHash: await bcrypt.hash(`${t.slug}-agent2-${Date.now()}`, BCRYPT_COST_FACTOR),
          isActive: true,
        },
      });
      const agent2Member = await db.tenantMember.upsert({
        where: { tenantId_userId: { tenantId: tenant.id, userId: agent2User.id } },
        update: { role: "AGENT" as MemberRole, isActive: true },
        create: {
          tenantId: tenant.id,
          userId: agent2User.id,
          role: "AGENT" as MemberRole,
          isActive: true,
        },
      });
      console.log(`  [ok] Agents (demo=${demoAgent.email}, agent2=${t.agent2Email})`);

      // map "agent"/"agent2" → memberId
      const memberByKey: Record<"agent" | "agent2", string> = {
        agent: demoMember.id,
        agent2: agent2Member.id,
      };

      // ---- SLA default policy ----
      // ใช้ deterministic id เพื่อ idempotent (ไม่มี natural unique นอกจาก id)
      const slaPolicyId = `demo-sla-${t.slug}`;
      await db.slaPolicy.upsert({
        where: { id: slaPolicyId },
        update: { name: "Standard SLA", isDefault: true, tenantId: tenant.id },
        create: {
          id: slaPolicyId,
          tenantId: tenant.id,
          name: "Standard SLA",
          isDefault: true,
          // ใช้ค่า default ใน schema สำหรับ *Min ทั้งหมด
        },
      });
      console.log(`  [ok] SlaPolicy (default)`);

      // ---- Tags ----
      const tagIdByKey: Record<string, string> = {};
      for (const tag of t.tags) {
        const row = await db.tag.upsert({
          where: { tenantId_name: { tenantId: tenant.id, name: tag.name } },
          update: { color: tag.color as TagColor },
          create: {
            tenantId: tenant.id,
            name: tag.name,
            color: tag.color as TagColor,
          },
        });
        tagIdByKey[tag.key] = row.id;
      }
      console.log(`  [ok] Tags (${t.tags.length})`);

      // ---- Contacts ----
      const contactIdByKey: Record<string, string> = {};
      for (const c of t.contacts) {
        const row = await db.contact.upsert({
          where: { tenantId_email: { tenantId: tenant.id, email: c.email } },
          update: { name: c.name, isActive: true },
          create: {
            tenantId: tenant.id,
            email: c.email,
            name: c.name,
            isActive: true,
          },
        });
        contactIdByKey[c.key] = row.id;
      }
      console.log(`  [ok] Contacts (${t.contacts.length})`);

      // ---- Tickets + Messages + TicketTags ----
      let maxTicketNumber = 0;
      for (const tk of t.tickets) {
        maxTicketNumber = Math.max(maxTicketNumber, tk.ticketNumber);

        const contactId = contactIdByKey[tk.contactKey];
        if (!contactId) {
          throw new Error(`ticket #${tk.ticketNumber}: contactKey "${tk.contactKey}" ไม่พบ`);
        }
        const assigneeId = tk.assignee ? memberByKey[tk.assignee] : null;

        const firstResponseDueAt =
          tk.firstResponseDueInMin === null ? null : minutesFromNow(tk.firstResponseDueInMin);
        const resolutionDueAt =
          tk.resolutionDueInMin === null ? null : minutesFromNow(tk.resolutionDueInMin);
        const firstRespondedAt =
          tk.firstRespondedAgoMin === null ? null : minutesAgo(tk.firstRespondedAgoMin);
        const resolvedAt = tk.status === "SOLVED" ? minutesAgo(tk.createdAgoMin - 20) : null;
        const createdAt = minutesAgo(tk.createdAgoMin);

        const ticket = await db.ticket.upsert({
          where: {
            tenantId_ticketNumber: { tenantId: tenant.id, ticketNumber: tk.ticketNumber },
          },
          update: {
            subject: tk.subject,
            status: tk.status as TicketStatus,
            priority: tk.priority as TicketPriority,
            requesterContactId: contactId,
            assigneeId,
            slaPolicyId,
            channel: "portal",
            firstResponseDueAt,
            resolutionDueAt,
            firstRespondedAt,
            resolvedAt,
          },
          create: {
            tenantId: tenant.id,
            ticketNumber: tk.ticketNumber,
            subject: tk.subject,
            status: tk.status as TicketStatus,
            priority: tk.priority as TicketPriority,
            requesterContactId: contactId,
            assigneeId,
            slaPolicyId,
            channel: "portal",
            firstResponseDueAt,
            resolutionDueAt,
            firstRespondedAt,
            resolvedAt,
            createdAt,
          },
        });

        // Messages — deterministic id + upsert by id (idempotent, ไม่มี natural unique)
        let msgIdx = 0;
        for (const m of tk.messages) {
          msgIdx++;
          const msgId = `demo-${t.slug}-t${tk.ticketNumber}-m${msgIdx}`;
          const authorMemberId =
            m.author === "contact" ? null : memberByKey[m.author];
          const authorContactId = m.author === "contact" ? contactId : null;
          const msgCreatedAt = minutesAgo(m.agoMin);

          await db.ticketMessage.upsert({
            where: { id: msgId },
            update: {
              visibility: m.visibility as MessageVisibility,
              body: m.body,
              authorMemberId,
              authorContactId,
            },
            create: {
              id: msgId,
              tenantId: tenant.id,
              ticketId: ticket.id,
              authorMemberId,
              authorContactId,
              visibility: m.visibility as MessageVisibility,
              body: m.body,
              bodyFormat: "text",
              createdAt: msgCreatedAt,
            },
          });
        }

        // TicketTags
        for (const tagKey of tk.tagKeys) {
          const tagId = tagIdByKey[tagKey];
          if (!tagId) {
            throw new Error(`ticket #${tk.ticketNumber}: tagKey "${tagKey}" ไม่พบ`);
          }
          await db.ticketTag.upsert({
            where: { ticketId_tagId: { ticketId: ticket.id, tagId } },
            update: {},
            create: {
              tenantId: tenant.id,
              ticketId: ticket.id,
              tagId,
            },
          });
        }
      }
      console.log(`  [ok] Tickets (${t.tickets.length}) + messages + tags`);

      // ---- set ticketCounter = เลข ticketNumber ล่าสุด ----
      // app ใช้ atomic increment จาก counter นี้ — ถ้าไม่ตรง ticket ใหม่จะชน unique
      await db.tenant.update({
        where: { id: tenant.id },
        data: { ticketCounter: maxTicketNumber },
      });
      console.log(`  [ok] ticketCounter = ${maxTicketNumber}`);
    }

    console.log("\n--- DEMO Seed สำเร็จ ---");
    console.log("Demo credentials (PUBLIC by design, role=AGENT):");
    for (const a of DEMO_AGENTS) {
      console.log(`  ${a.tenantSlug}: ${a.email} / ${a.password}`);
    }
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error("DEMO Seed ล้มเหลว:", err);
  process.exit(1);
});
