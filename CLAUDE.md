# Helpwise — Project Overview

โปรเจกต์นี้ (**Helpwise**) คือ **Multi-tenant SaaS Help Desk / Ticketing Platform** สำหรับ B2B
แต่ละบริษัทลูกค้า (tenant) ใช้ Helpwise รับเรื่อง support จากลูกค้าของตัวเอง — มี **app ภายในสำหรับ agent**
และ **portal สาธารณะสำหรับลูกค้าปลายทาง** เป้าหมาย: ประสิทธิภาพสูง โค้ดอ่านง่าย ดูแลระยะยาวได้ และ
**ข้อมูลแต่ละ tenant ต้องแยกขาดจากกันโดยสมบูรณ์ (Tenant Isolation)**

> ⚠️ **กฎสูงสุดของโปรเจกต์นี้:** ทุกข้อมูลเป็นของ Tenant ใด Tenant หนึ่งเสมอ. Cross-tenant data leak
> คือ Critical Bug ที่ร้ายแรงที่สุด. **และเฉพาะของ Help Desk:** "internal note" ของ agent ต้องไม่หลุดไปฝั่ง
> portal ลูกค้าโดยเด็ดขาด (ดู Ticketing Rules) — ถือเป็นการรั่วระดับ Critical เช่นกัน

---

## 🧭 Agent Ownership Map (orchestrator อ่านก่อน delegate)

| หัวข้อกฎ | เจ้าภาพหลัก (ต้องบังคับใช้) | เกี่ยวข้อง |
| --- | --- | --- |
| **Multi-tenancy Rules** | `database` (schema + `tenantId`; RLS scaffolded as defense-in-depth, **not active** — BYPASSRLS role), `backend` (application-enforced tenant-scoped query, context, membership verify) | `security` (audit อันดับ 1), `frontend` |
| **Identity & Audiences** | `backend` (แยก guard agent vs contact), `security` (privilege/visibility) | `database` (Contact per-tenant), `frontend` (แยก app/portal) |
| **Ticketing Rules** | `backend` (lifecycle, visibility), `database` (Ticket/Message schema) | `frontend` (ซ่อน internal note ฝั่ง portal), `security` |
| **SLA Rules** | `backend` (timer, business hours), `database` (SlaPolicy) | `frontend` (badge/นับเวลา) |
| **Inbound/Outbound Email** | `backend` (parse, idempotent, threading, verify) | `security` (spoof/spam), `devops` (queue, inbound webhook) |
| **Subscription & Billing** | `backend` (webhook idempotent + signature, sync→DB), `database` (money `Int`) | `security`, `frontend` |
| **Feature Flag** | `backend` (`hasFeature()`), `database` (seed) | `frontend` |
| **Audit Log** | `backend` (`audit.log()`), `database` (immutable) | `security` |
| **UI & Design System** | `frontend` (palette, semantic status color, portal branding) | — |
| **Definition of Done** | `code-review` + `qa-testing` + `security` ใช้เป็น **เกณฑ์ block** | — |

> สำหรับ reviewer: **Definition of Done + Multi-tenancy + Internal-note isolation = เกณฑ์ block** ไม่ใช่แค่ comment

---

## Tech Stack

- Next.js 16.2 (App Router) + TypeScript
- Prisma + PostgreSQL (Supabase)
- Tailwind CSS v4 · UI: Custom components + Lucide React (icons)
- Charts: Recharts (reporting) · Forms: React Hook Form + Zod
- **Billing: Stripe** (Subscriptions + Webhooks)
- **Cache / Tenant lookup: Redis** (Upstash)
- **Email: Postmark/SendGrid** (outbound + inbound parse webhook)
- **Queue: Upstash QStash** — งาน async: ส่ง email, ตรวจ SLA breach, ประมวลผล inbound
- **AI: Claude Haiku** (ticket summarize / suggest-reply / suggest-tags)

---

## Project Structure

- `app/`
  - `app/(agent)/` — app ภายในสำหรับ agent (ต้อง login เป็น User + เป็นสมาชิก tenant)
  - `app/(portal)/` — portal สาธารณะสำหรับลูกค้า (Contact) — เห็นเฉพาะ ticket ของตัวเอง
  - `app/(marketing)/` — landing, pricing (ไม่มี tenant)
  - `app/api/` — ทุก route ต้องผ่าน tenant context + audience guard
  - `app/api/v1/` — public REST API (API-key auth)
  - `app/api/webhooks/stripe/` · `app/api/webhooks/email/` — inbound webhooks (verify signature)
- `lib/`
  - `lib/tenant.ts` — tenant context resolution
  - `lib/prisma.ts` — tenant-scoped Prisma client
  - `lib/auth.ts` — `requireAgent()` / `requireContact()` guards (แยก audience)
  - `lib/features.ts` · `lib/audit.ts` · `lib/stripe.ts`
  - `lib/email.ts` — parse inbound / ส่ง outbound / threading
  - `lib/sla.ts` — คำนวณ deadline + business hours
  - `lib/slug.ts` — canonical slug validation/normalization
- `src/proxy.ts` — tenant extraction จาก subdomain (Node runtime, root level)

---

## 🔒 Multi-tenancy Rules (สำคัญที่สุด)

Strategy: **Shared Database + Shared Schema** แยกด้วยคอลัมน์ `tenantId`

1. **ทุก Model ที่เป็นข้อมูล tenant ต้องมี `tenantId`** (ยกเว้น global: `User`, `Plan`, `FeatureFlag`)
2. **ทุก Query ต้องมีเงื่อนไข `tenantId` เสมอ** — ห้าม query โดยไม่ระบุ tenant
3. **ห้ามรับ `tenantId` จาก client** — ดึงจาก tenant context ที่ middleware verify แล้วเท่านั้น (กัน tenant spoofing)
4. **ห้าม raw SQL ที่ไม่มี tenant scope**
5. **ทุก API route ต้อง verify membership/identity** ก่อนทำงาน (ดู Identity & Audiences)

### Tenant Context Pattern

```typescript
// ❌ ไม่มี scope / รับ tenantId จาก client
const tickets = await prisma.ticket.findMany()
const tickets = await prisma.ticket.findMany({ where: { tenantId: req.body.tenantId } })

// ✅ ใช้ tenant-scoped client (tenantId มาจาก context ที่ verify แล้ว)
const db = tenantPrisma(ctx.tenantId)
const tickets = await db.ticket.findMany()
```

### Subdomain Routing

- URL: `{slug}.gethelpwise.xyz` (เช่น `acme.gethelpwise.xyz`)
- `src/proxy.ts`: แยก `slug` → lookup tenant (cache Redis) → ส่ง `x-tenant-id`, `x-tenant-plan` (**เขียนทับ header จาก client เสมอ**) → ไม่พบ = 404

---

## 👥 Identity & Audiences Rules (ลูกเล่นเด่นของ Help Desk)

ระบบมี **ผู้ใช้สองกลุ่มที่ต้องแยกขาด** — ห้ามปน auth context กัน:

| | **Agent (ภายใน)** | **Contact / ลูกค้า (ภายนอก)** |
| --- | --- | --- |
| คือใคร | พนักงาน support | ผู้แจ้ง ticket |
| โมเดล | `User` (global) + `TenantMember` | `Contact` (**tenant-scoped**) |
| อยู่หลาย tenant ได้ไหม | ได้ (1 User ทำงานหลายบริษัท) | **ไม่ได้** — คนเดียวที่อีเมลหา 2 บริษัท = 2 Contact คนละ tenant |
| login ที่ไหน | `app/(agent)/` | `app/(portal)/` (magic-link/email ต่อ tenant) |
| เห็นอะไร | ticket ทั้ง tenant (ตาม role) | **เฉพาะ ticket ของตัวเอง** ใน tenant นั้น |

กฎเหล็ก:
1. **`requireAgent()` กับ `requireContact()` แยกกันเด็ดขาด** — endpoint ของ portal ห้ามให้ agent privilege หลุดเข้าไป และกลับกัน
2. **Contact ถูก scope แคบกว่า tenant อีกชั้น** — query ของ portal ต้องกรอง `requesterContactId = ctx.contactId` ด้วย (tenant scope + own-records scope)
3. **agent role ผูกกับ `TenantMember`** (`OWNER`/`ADMIN`/`AGENT`/`VIEWER`) ไม่ใช่ผูกกับ `User`
4. authz pipeline: extract tenant → ระบุ audience (agent/contact) → verify membership/ownership → ตรวจ role/feature → ทำงาน

---

## 🎫 Ticketing Rules

- **Ticket status:** `NEW`, `OPEN`, `PENDING` (รอลูกค้า), `ON_HOLD`, `SOLVED`, `CLOSED`. Priority: `LOW`/`NORMAL`/`HIGH`/`URGENT`
- **`ticketNumber` unique ต่อ tenant** (เช่น `#1024` ของ acme ไม่ชนกับ globex)
- **TicketMessage มี `visibility`: `PUBLIC` | `INTERNAL`**
  - `INTERNAL` = โน้ตระหว่าง agent — **ต้องไม่ถูก return / render ที่ฝั่ง portal เด็ดขาด** (กรองที่ query ฝั่ง backend ไม่ใช่แค่ซ่อนใน UI)
  - query ของ portal ต้อง `where: { visibility: 'PUBLIC' }` เสมอ
- assignment: ticket assign ให้ agent ที่เป็น `TenantMember` ของ tenant นั้นเท่านั้น
- ทุกการเปลี่ยน status/assignee/priority → บันทึก `AuditLog`

---

## ⏱️ SLA Rules

- **SlaPolicy ต่อ tenant** (และอาจผูกกับ plan): กำหนด **first-response time** + **resolution time** ตาม priority
- timer คิดตาม **business hours** ของ tenant (เก็บใน settings) ไม่ใช่ 24 ชม. เสมอ
- **pause timer เมื่อ status = `PENDING`** (รอลูกค้าตอบ) แล้ว resume เมื่อกลับมา
- ตรวจ SLA breach แบบ async ผ่าน queue (Upstash QStash) — เมื่อใกล้/เกิน deadline → flag + แจ้งเตือน
- SLA แบบละเอียด (เช่น หลาย policy, business hours) เป็น feature ที่ **gate ตาม plan** ผ่าน `hasFeature()`

---

## 📧 Inbound / Outbound Email Rules

- **Inbound:** ลูกค้าส่งเมลเข้า `support@{slug}.gethelpwise.xyz` → provider ยิง webhook → parse เป็น ticket ใหม่/append เข้า ticket เดิม (ดู threading)
  - **idempotent ด้วย Message-ID** (เก็บใน `ProcessedInboundEmail`) — provider ส่งซ้ำได้ ห้ามสร้าง ticket ซ้ำ (หลักการเดียวกับ Stripe webhook)
  - **verify** ว่าเมลมาจาก provider จริง (signature/secret) — กัน spoof สร้าง ticket ปลอม
  - routing: address → resolve tenant (เหมือน subdomain แต่ผ่านอีเมล)
- **Threading:** ใช้ `Message-ID` / `In-Reply-To` / header `References` จับคู่กลับ ticket เดิม; fallback ใช้ ticket number ใน subject
- **Outbound:** reply ของ agent ส่งกลับลูกค้า, ตั้ง header threading ให้ถูก, เก็บสำเนาเป็น `TicketMessage(visibility=PUBLIC)`

---

## 💳 Subscription & Billing Rules

- **1 Tenant = 1 Subscription** เสมอ
- ราคาเก็บเป็น `Int` (satang/cents) — **ห้าม `Float` กับข้อมูลการเงิน**
- **ห้าม query Stripe API ทุก request** — sync ผ่าน webhook มาเก็บ DB แล้ว query จาก DB
- webhook ต้อง **idempotent** + **verify signature** ทุกครั้ง
- เปลี่ยน plan → update `Tenant.plan` ให้ตรง + **ล้าง Redis cache** (`x-tenant-plan` ที่ middleware cache ไว้)
- Status: `TRIALING`, `ACTIVE`, `PAST_DUE`, `CANCELLED`, `UNPAID`
- entitlement ที่ผูกกับ plan (ตัวอย่าง): จำนวน agent seats, จำนวน SLA policy, channels, API access

---

## 🚩 Feature Flag Rules

สองชั้น: global default (`FeatureFlag`) + per-tenant override (`TenantFeature`).
`hasFeature(tenantId, key)`: override ราย tenant ชนะก่อน → ไม่มีก็ดู `requiredPlan` เทียบ plan → ไม่มีก็ `defaultEnabled`

- **ห้าม hardcode** `if (tenant.plan === 'PRO')` ใน business logic — ใช้ `hasFeature()` เสมอ
- เพิ่ม flag ใหม่ผ่าน **migration/seed** ไม่ใช่ hardcode
- gate ที่ API → `403` + error code ที่บอกให้ upgrade
- flag ตัวอย่าง: `sla_policies`, `csat_survey`, `api_access`, `custom_branding`

---

## 📝 Audit Log Rules

- `AuditLog` **immutable** — ไม่มี `updatedAt`, ห้าม update/delete
- log action สำคัญ: เปลี่ยน status/assignee/priority, merge ticket, เชิญ agent, เปลี่ยน plan, แก้ข้อมูล contact
- ใช้ helper `audit.log()` เสมอ ไม่ create row ตรง ๆ
- เก็บ `before`/`after` JSON; **ห้าม log เนื้อหา/PII ที่ sensitive ลง snapshot แบบไม่จำเป็น**

---

## UI & Design System Rules

**Theme:** Clean, calm, trustworthy (เหมาะกับงาน support ที่ต้องอ่านเยอะ). โทนหลักสะอาด, ใช้ **semantic status color** สื่อสถานะ ticket/SLA

> 🏢 **Multi-tenant + Portal branding:** tenant ตั้ง `logoUrl` + accent color ได้ (เก็บใน `Tenant.settings`) โดยเฉพาะ **portal ลูกค้าต้องโชว์ branding ของ tenant** แต่ **base palette + โครงสร้างคงเดิมเสมอ**

### 🎨 Color Palette

- **Background Primary (Sand): #F5F0E8 — พื้นแอปหลัก (อย่าใช้ขาวล้วน #FFFFFF เป็นพื้นหลัก)
- **Background Secondary (Stone): #EDE8DE — section สลับ, sidebar, subtle surface
- **Surface (Warm White): #FAF7F2 — card, modal, dropdown
- **Primary / Action (Terracotta): #C4652A (hover #A8541F) — ปุ่มหลัก, CTA, active state
- **Success (Sage Green): #3B6D11 — สถานะสำเร็จ, สถานะบวก
- **Warning / ใกล้ครบกำหนด (Amber): #BA7517 — แจ้งเตือน, ใกล้เกิน deadline
- **Danger / เกินกำหนด (Sienna): #993C1D — urgent, error, breach
- **Text: primary #1A1A1A (ห้าม pure black #000000), secondary #555555, muted #888888
- **Border: #D9D4CC (subtle rgba(0,0,0,0.06))

**Theme tokens (single source of truth):** palette ทั้งหมดเป็น Tailwind v4 `@theme` token ใน `src/app/globals.css` — ใช้ semantic class เสมอ (`bg-background`, `bg-surface`, `bg-stone`, `text-foreground`, `text-secondary`, `text-muted`, `bg-primary`, `text-success/warning/danger`, `*-tint`). **ห้าม hardcode arbitrary hex** (`bg-[#C4652A]`) — เปลี่ยน palette/per-tenant branding ที่ token เดียว

**AA-accessible variants (WCAG 4.5:1):** เมื่อมี **text จริงทับสี** ให้ใช้เฉดเข้มที่ผ่าน AA (สี base ด้านบนเป็นโทนกลาง-สว่าง contrast ไม่พอ):
- ปุ่ม/fill ที่มี text ขาว → `bg-primary-strong` (#A8541F, hover `bg-primary-strong-hover` #8C4216) ไม่ใช่ `bg-primary`
- text terracotta บนพื้นอ่อน (link, badge, ticket#) → `text-primary-ink` (#92451A) ไม่ใช่ `text-primary`
- text amber บนพื้นอ่อน (badge/label) → `text-warning-ink` (#8A570D) ไม่ใช่ `text-warning`
- ปุ่ม/fill amber ที่มี text ขาว (เช่น internal-note active) → `bg-warning-strong` (#94590E, hover `bg-warning-strong-hover` #7D4F0C) ไม่ใช่ `bg-warning`
- `text-primary`/`text-warning`/`bg-primary` (base) สงวนไว้ให้ icon / border / focus ring / decorative fill ที่ contrast 3:1 พอ

---

## Key Conventions & Architecture

- **React Components:** Standard Function Declaration เสมอ (เลี่ยง arrow function สำหรับ component)
- **TypeScript:** ระบุ Interface/Type ชัดเจนเสมอ
- **API Routes:** return JSON รูปแบบ `{ data, error }` เสมอ
- **API Routes (Multi-tenant + audience):** ลำดับ: extract tenant → audience guard (`requireAgent`/`requireContact`) → verify membership/ownership → ตรวจ role/feature → ทำงาน
- **Database:** ใช้ Prisma เท่านั้น (raw SQL ต้องมี tenant scope), ใช้ `tenantPrisma(tenantId)` ที่ inject scope อัตโนมัติ
- **Internal note isolation:** query ฝั่ง portal ต้องกรอง `visibility = PUBLIC` ที่ระดับ backend เสมอ — ห้ามพึ่งการซ่อนใน UI
- **Env vars:** root domain, Stripe keys, email provider keys, Redis URL ดึงจาก `.env` เสมอ ห้าม hardcode
- **Comments:** อธิบายลอจิกซับซ้อนด้วยคอมเมนต์ไทยสั้น ๆ โดยเฉพาะส่วน tenant isolation + audience/visibility

### Security Conventions

- ห้าม trust `tenantId` จาก client — ใช้จาก middleware context
- ห้าม return ข้อมูล tenant อื่น หรือ ticket ของ contact อื่น แม้ใน error message
- Contact เห็นเฉพาะ ticket ของตัวเอง (`requesterContactId = ctx.contactId`)
- agent action ต้องเช็ค `MemberRole` (เช่น เฉพาะ OWNER/ADMIN ลบ/merge/จัดการ member)
- inbound email + Stripe webhook ต้อง verify signature ทุกครั้ง
- validate `slug` ด้วย regex `/^[a-z0-9-]+$/`

### Definition of Done (ก่อน merge ทุก feature)

> `code-review` / `qa-testing` / `security` ใช้เป็น **เกณฑ์ block**

- [ ] ทุก query ใหม่มี tenant scope
- [ ] ไม่รับ `tenantId` จาก client
- [ ] audience guard ถูกต้อง (agent vs contact ไม่ปนกัน)
- [ ] internal note ไม่หลุดไป portal (query กรอง `visibility=PUBLIC`)
- [ ] contact เห็นเฉพาะ ticket ของตัวเอง
- [ ] inbound email / Stripe webhook idempotent + verify signature
- [ ] เช็ค permission/role + `hasFeature()` (ไม่ hardcode plan)
- [ ] บันทึก `AuditLog` สำหรับ action สำคัญ

#### Post-merge gate (เฉพาะ phase ที่มี migration หรือ external resource)

> ปิด phase ไม่ได้จนกว่าข้อนี้ผ่าน — **gate ก่อน merge ตรวจแค่ code + mock DB จึงไม่จับ feature ที่ตายบน prod**
> (บทเรียนจริง: Phase 35 realtime presence ผ่านทุก gate แต่ RLS policy ไม่เคย apply + `NEXT_PUBLIC_SUPABASE_*` ไม่เคยตั้งบน Vercel → feature dead 1 เดือน)

- [ ] **verify migration apply บน prod จริง** — query `_prisma_migrations` ตรง ๆ ว่า `finished_at` ไม่ null / `rolled_back_at` เป็น null ทุกตัวของ phase นั้น. **ห้ามเชื่อ `prisma migrate status`** (รายงานผิดเมื่อมี failed migration)
- [ ] **verify effect ของ migration บน prod** ไม่ใช่แค่แถวใน `_prisma_migrations` — เช่น policy → `pg_policies`, ตาราง/คอลัมน์ใหม่ → `information_schema`, RLS → `relrowsecurity`/`relforcerowsecurity`
- [ ] **ตารางหลักฐาน external resource** (ไม่ใช่ checkbox ของเจตนา) — ทุก resource ที่ feature ใช้ต้องเขียนเป็นตารางในเอกสารปิด phase:

| resource | คำสั่ง/วิธีตรวจบน prod | ผลที่ถือว่าผ่าน |
| --- | --- | --- |
| RLS policy | `select * from pg_policies where tablename='messages'` | ≥ 2 แถว |
| client env (`NEXT_PUBLIC_*`) | สแกน **artifact ที่ deploy จริง** — `npm run scan:bundle` (ไม่ใช่ถาม server) | ค่าโผล่ใน `.next/static` |
| server env / provider | เรียก endpoint ที่ **ใช้ provider นั้นจริง** บน prod แล้วดูผลลัพธ์ | ทำงานด้วย provider จริง (ไม่ใช่ค่า stub/`console`) |
| FeatureFlag | เรียก API ของ feature นั้นบน prod | `200` ไม่ใช่ `403` |
| gate ถูกเรียกจริงบน Vercel (Project Settings override `vercel.json` ได้ ตรวจจาก repo ไม่ได้) | อ่าน build log ของ deploy ล่าสุด | มีบรรทัด `✅ [scan:bundle] สะอาด` **ที่ต่อท้ายด้วย `และยืนยัน … ค่า NEXT_PUBLIC_*`** และไม่มี `GATE OVERRIDDEN` (เจอ = bypass อยู่ ยังไม่ผ่าน) |

- [ ] **ตรวจที่ชั้นเดียวกับที่ค่าถูกใช้จริง** — build-time value (`NEXT_PUBLIC_*` inline ตอน build → ต้อง redeploy) ตรวจที่ artifact · runtime value ตรวจที่ runtime. **ตรวจผิดชั้น = false PASS**
- [ ] **feature ที่ออกแบบให้ fail-soft ต้องมี assertion ยืนยัน happy path บน prod เสมอ** — fail-soft = ไม่มี error ให้เห็นโดยธรรมชาติ (fail-soft ต่อผู้ใช้ · fail-loud ต่อผู้ดูแล)
- [ ] **หลักฐานที่ผูก FK `onDelete: Cascade` กับของที่ต้องเก็บกวาด ต้องถูกบันทึกออกนอก DB ก่อนเก็บกวาดเสมอ**
      — ลบ parent = ลบหลักฐานทิ้งพร้อมกัน กู้ไม่ได้ (บทเรียนจริง: ลบ `WebhookEndpoint` ของ smoke แล้ว
      `WebhookDelivery` ที่เป็นหลักฐานปิด gate หายตามทันทีเหลือ 0 แถว — รอดเพราะบังเอิญเขียน snapshot ไว้ก่อน)
      · ลำดับบังคับ: **บันทึกหลักฐาน → verify ว่าบันทึกครบ → แล้วจึงลบ**
- [ ] **smoke ของจริงบน prod** อย่างน้อย 1 path ของ feature นั้น (ไม่ใช่ local/CI)
