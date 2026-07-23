# Helpwise — Project Plan

> Multi-tenant SaaS Help Desk / Ticketing Platform (B2B).
> Plan นี้ reconstruct ย้อนหลังจาก git history + `CLAUDE.md` (plan/handoff ครั้งแรกของ project)
> รายละเอียดกฎทั้งหมดอยู่ใน `CLAUDE.md` ของ repo — ไฟล์นี้ **อ้างอิง ไม่ duplicate**

## Stack
→ อ้าง `CLAUDE.md` § Tech Stack (Next.js 16.2 App Router · Prisma 7 + PostgreSQL/Supabase · Tailwind v4 · Custom UI + Lucide · Recharts · React Hook Form + Zod · Stripe · Redis/Upstash · Postmark · Upstash QStash · Claude Haiku)

## Phase Status (1 แถว = 1 phase-branch จริงบน main)

| Phase | ชื่อ | Branch | Status | Merged |
|-------|------|--------|--------|--------|
| 01 | Database design — multi-tenant Prisma schema | `phase-1/database-design` | ✅ done | ✅ |
| 02 | Core infrastructure — multi-tenant infra layer | `phase-2/core-infrastructure` | ✅ done | ✅ |
| 03 | Identity & onboarding — signup, agent login, contact magic-link | `phase-3/identity-onboarding` | ✅ done | ✅ |
| 04 | Ticket vertical slice — agent + portal | `phase-4/ticket-vertical-slice` | ✅ done | ✅ |
| 05 | Agent create-ticket form + assignee dropdown | `phase-5/agent-create-ticket` | ✅ done | ✅ |
| 05b | Agent dashboard + nav shell | `phase-5b/dashboard-nav-shell` | ✅ done | ✅ |
| 05c | Inbound/outbound email (Postmark threading) | `phase-5c/inbound-outbound-email` | ✅ done | ✅ |
| 05d | SLA engine — deadlines, business-hours, pause/resume, breach sweep | `phase-5d/sla-engine` | ✅ done | ✅ |
| 06 | Stripe billing — webhook sync, checkout, portal | `phase-6/stripe-billing` | ✅ done | ✅ |
| 07 | Billing settings page + SLA badge UI | `phase-7/billing-sla-ui` | ✅ done | ✅ |
| 08 | SlaPolicy CRUD API + settings UI | `phase-8/sla-policy-crud` | ✅ done | ✅ |
| 09 | QA testing — Vitest setup + unit tests | `phase-9/qa-testing` | ✅ done | ✅ |
| 10 | Portal branding — logo + accent | `phase-10/portal-branding` | ✅ done | ✅ |
| 11 | CSAT survey — in-portal + agent score | `phase-11/csat-survey` | ✅ done | ✅ |
| 12 | Expand test coverage (branding, ticket-ui) | `phase-12/expand-test-coverage` | ✅ done | ✅ |
| 13 | Security hardening — rate limit + headers | `phase-13/security-hardening` | ✅ done | ✅ |
| 14 | Public REST API + API key management | `phase-14/api-access` | ✅ done | ✅ |
| 15 | API integration tests (rate-limit + access) | `phase-15/api-integration-tests` | ✅ done | ✅ |
| 16 | Public API reference + ops runbook + README | `phase-16/api-ops-docs` | ✅ done | ✅ |
| 17 | Deploy pipeline — GitHub Actions CI | `phase-17/deploy-pipeline` | ✅ done | ✅ |
| 18 | Stripe live-smoke + webhook tests | `phase-18/stripe-live-smoke` | ✅ done | ✅ |
| 19 | JWT auth pipeline integration tests | `phase-19/jwt-integration-tests` | ✅ done | ✅ |
| 20 | Nonce CSP — **documented infeasible** w/ proxy.ts | `phase-20/nonce-csp` | ✅ done* | ✅ |
| 21 | Atomic ticketNumber counter | `phase-21/ticketnumber-atomic` | ✅ done | ✅ |
| 22 | Ticket merge | `phase-22/ticket-merge` | ✅ done | ✅ |
| 23 | Canned responses — reusable reply templates | `phase-23/canned-responses` | ✅ done | ✅ |
| 24 | Reporting & analytics dashboard | `phase-24/reporting-dashboard` | ✅ done | ✅ |
| 25 | File attachments via Supabase Storage | `phase-25/file-attachments` | ✅ done | ✅ |
| 26 | Tags/labels for ticket triage | `phase-26/tags-labels` | ✅ done | ✅ |
| 27 | PostgreSQL Row Level Security — **scaffolded** as defense-in-depth (not active; app connects via BYPASSRLS role, `RLS_ENABLED=false`) | `phase-27/rls-hardening` | ✅ done | ✅ |
| 28 | Async queue (QStash) + notifications — outbound email queue, in-app assign notify, SLA near-breach/breach notify | `phase-28/async-queue-notifications` | ✅ done | ✅ |
| 29 | AI-assist (Claude Haiku 4.5) — summarize · suggest-reply (draft) · suggest-tags | `phase-29/ai-assist` | ✅ done | ✅ |
| 30 | Portfolio Demo Readiness — landing page + demo seed (acme/globex) + one-click demo-login + AI rate-limit fail-closed | `phase-30/portfolio-demo` | ✅ done | ✅ |
| 34 | Tenant-isolation fuzz suite (37 case/8 axis) + ปิด XT-WRITE-05 (composite tenant FK) | (บน main โดยตรง) | ✅ done | ✅ |
| 35 | Real-time presence/collision (Supabase Realtime) — token/RLS/presence/typing/collision; qa PASS-with-conditions | `feature/phase-35-realtime-presence` | ✅ done | ✅ |
| 36 | Outbound webhooks — HMAC signing + SSRF guard + QStash retry/DLQ + replay (Portfolio #2); qa PASS-with-conditions (ปิดครบ) · security PASS (MEDIUM-1 rate-limit/cap + MEDIUM-2 RLS ปิดก่อน merge) · docs แปลอังกฤษแล้ว | `feature/phase-36-outbound-webhooks` | ✅ done | ✅ PR #16 (`af79bff`) |

> *Phase 20 = decision เชิงลบ (บันทึกว่า nonce CSP ใช้กับ `proxy.ts` ไม่ได้ — คง `unsafe-inline`) ไม่ใช่ feature ใหม่
> **Chore branches** (merged, ไม่ใช่ phase): `chore/db-init-seed`, `fix/proxy-host-header`, `chore/theme-warm-palette`

## Git State (สำหรับ verify รอบหน้า)
**Status: LAUNCHED — live ที่ gethelpwise.xyz · ทุกเฟส merge + push แล้ว (`main` = `origin/main` in-sync)**
- main HEAD: `30ef022` (`docs: verify README accuracy`). Phase 31-33 (production-deploy → deploy-verify → post-launch docs) ทำตรงบน main (docs/handoff + `chore: swap root domain to gethelpwise.xyz` `f417541`) — ไม่ใช่ feature-branch
- ทุก phase-branch (01-30) + chore-branch merge เข้า main + push ขึ้น `origin/main` แล้ว — ไม่มี branch ค้าง, ไม่มี commit ค้าง push
- Phase 30 (landing + demo seed acme/globex + demo-login + AI fail-closed): security gate PASS (no High/Critical); acme = demo ล้วน 7 ticket (#1001-1007) หลัง cleanup junk. ดู memory `seed-demo-idempotency-acme-cruft`
- วิธี verify รอบหน้า: `git log --merges --oneline main` · `git status -sb` (ควรเป็น `main...origin/main` ไม่มี ahead/behind)

## Decisions & Constraints (ยังมีผล)
- กฎหลักทั้งหมด → อ้าง `CLAUDE.md`: Multi-tenancy Rules · Identity & Audiences · Ticketing / Internal-note isolation · SLA · Inbound/Outbound Email · Subscription & Billing (money เก็บเป็น `Int`) · Feature Flag · Audit Log · **Agent Ownership Map**
- Memory (`.claude/projects/.../memory/MEMORY.md`): Prisma 7 + Supabase datasource · tenant resolution อยู่ที่ `src/proxy.ts` (ไม่ใช่ `middleware.ts`) · tenantPrisma ไม่ใช้ใน `$transaction` · iCloud stray duplicate files
- **Isolation = application-enforced** (`tenantPrisma()` scope ทุก query) เป็นหลัก. **RLS = scaffolded defense-in-depth, ยังไม่ active** — prod app connect ผ่าน **BYPASSRLS role**, kill-switch `RLS_ENABLED` default = `false` (verified: `.env.example:17`, `src/lib/tenant.ts:51`). RLS code merged แล้วแต่จะ enforce ก็ต่อเมื่อสลับ role + เปิด flag
- **Queue = Upstash QStash** (ไม่ใช่ BullMQ — serverless fit): outbound email + sla-sweep ผ่าน QStash signature (worker route verify fail-closed บน prod, tenantId จาก verified source → `tenantPrisma`). sla-sweep เลิกใช้ `SLA_SWEEP_SECRET` แล้ว. Notification = agent-audience (TenantMember recipient, FORCE RLS). deferred hardening → memory `phase28-deferred-hardening`

## Definition of Done
→ อ้าง DoD 8 ข้อใน `CLAUDE.md` § Definition of Done — เป็นเกณฑ์ **block** ของ `code-review` / `qa-testing` / `security`

## ⚠️ ค้าง / ต้องสังเกต
0. **Migration ค้าง apply บน DB จริง 4 ตัว** (จาก `prisma migrate status` — ⚠️ **`migrate status` เชื่อไม่ได้เมื่อมี migration failed**: ตัวที่ failed จะหายจากรายการ pending ทำให้ดูเหมือนเคลียร์แล้ว ต้อง query `_prisma_migrations` ดู `finished_at`/`rolled_back_at` ตรง ๆ): `20260721000000_realtime_presence_rls`, `20260722000000_add_outbound_webhooks`, `20260722010000_add_webhooks_feature_flag`, `20260723000000_webhooks_rls`
   - 🔴 **ข้อเท็จจริงที่แก้แล้ว (2026-07-23):** ที่เคยเขียนว่า realtime RLS "น่าจะ apply ด้วยมือผ่าน SQL editor" **ผิด** — `pg_policies` บน `realtime.messages` = **0 แถว** แปลว่า **Phase 35 presence/typing ไม่เคยทำงานบน production เลย** (RLS เปิด default + ไม่มี policy = deny ทุก channel แบบเงียบ ๆ)
   - สาเหตุที่ apply ไม่ได้: บรรทัด `alter table realtime.messages enable row level security` ล้ม **42501** เพราะ owner คือ `supabase_realtime_admin` ไม่ใช่ `postgres` → **ถอดบรรทัดนั้นออกแล้ว** (commit `6dafbef`) เพราะ Supabase เปิด RLS ให้ default อยู่แล้ว ส่วน `CREATE POLICY` ทำได้ปกติ
   - ลำดับกู้: `migrate resolve --rolled-back 20260721000000_realtime_presence_rls` → `npm run db:deploy` (ได้ทั้ง 4 ตัว) → verify `pg_policies` ต้องได้ **2 แถว** + smoke presence 2 เบราว์เซอร์
   - รายละเอียดข้อจำกัด schema `realtime` → memory `realtime-messages-rls-supabase`
1. **ไม่มี Phase ค้าง · LAUNCHED แล้ว** — merge + push ครบทุก branch, deploy live ที่ gethelpwise.xyz (Phase 31-33)
2. **RLS ยังไม่ active** (`RLS_ENABLED=false`, app ใช้ BYPASSRLS role) — application-enforced isolation เป็นด่านจริง; จะ activate RLS ต้องสลับ DB role + เปิด flag
3. **Stray duplicate files (iCloud)** — เป็นปัญหาเป็นระยะ ทำ build พัง; ลบทีละไฟล์ (`rm <file>` ไม่ใช่ `rm -rf`) เมื่อพบ
4. **Phase 28 deploy = เสร็จแล้วตอน launch** (Phase 31-33): migration `20260619000000_add_notification` + `20260619010000_add_sla_notification` apply แล้ว · QStash env provision + cron ยิง `/api/jobs/sla-sweep` แล้ว · `SLA_SWEEP_SECRET` ถอดออกครบ. deferred hardening ที่ยังเหลือ → memory `phase28-deferred-hardening`
5. **Email = Postmark scaffold** (`src/lib/email.ts` fetch-based, ไม่มี SDK dep; SendGrid = TODO) — wire จริง + verify provider key ก่อนเปิด outbound production จริงจัง
6. นี่คือ plan/handoff ครั้งแรกของ project — ก่อนหน้านี้ไม่มี `project-plan.md`
