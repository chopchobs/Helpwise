# Helpwise — Project Plan

> Multi-tenant SaaS Help Desk / Ticketing Platform (B2B).
> Plan นี้ reconstruct ย้อนหลังจาก git history + `CLAUDE.md` (plan/handoff ครั้งแรกของ project)
> รายละเอียดกฎทั้งหมดอยู่ใน `CLAUDE.md` ของ repo — ไฟล์นี้ **อ้างอิง ไม่ duplicate**

## Stack
→ อ้าง `CLAUDE.md` § Tech Stack (Next.js 16.2 App Router · Prisma + PostgreSQL/Supabase · Tailwind v4 · Stripe · Redis/Upstash · Postmark · BullMQ)

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
| 27 | PostgreSQL Row Level Security (defense-in-depth) | `phase-27/rls-hardening` | ✅ done | ✅ |

> *Phase 20 = decision เชิงลบ (บันทึกว่า nonce CSP ใช้กับ `proxy.ts` ไม่ได้ — คง `unsafe-inline`) ไม่ใช่ feature ใหม่
> **Chore branches** (merged, ไม่ใช่ phase): `chore/db-init-seed`, `fix/proxy-host-header`, `chore/theme-warm-palette`

## Git State (สำหรับ verify รอบหน้า)
- main HEAD: `25acc353de89374c9aa95f8268d601c3558fa45f`
- ทุก phase-branch + chore-branch merge เข้า main แล้ว — ไม่มี branch ค้าง (local/remote = `main` เท่านั้น)
- วิธี verify รอบหน้า: `git log --merges --oneline main`

## Decisions & Constraints (ยังมีผล)
- กฎหลักทั้งหมด → อ้าง `CLAUDE.md`: Multi-tenancy Rules · Identity & Audiences · Ticketing / Internal-note isolation · SLA · Inbound/Outbound Email · Subscription & Billing (money เก็บเป็น `Int`) · Feature Flag · Audit Log · **Agent Ownership Map**
- Memory (`.claude/projects/.../memory/MEMORY.md`): Prisma 7 + Supabase datasource · tenant resolution อยู่ที่ `src/proxy.ts` (ไม่ใช่ `middleware.ts`) · tenantPrisma ไม่ใช้ใน `$transaction` · iCloud stray duplicate files
- **RLS kill-switch `RLS_ENABLED` default = `false`** (verified: `.env.example:17`, `src/lib/tenant.ts:51`) — RLS code merged แล้วแต่ **ยังไม่ activate** จนกว่าจะ migrate production

## Definition of Done
→ อ้าง DoD 8 ข้อใน `CLAUDE.md` § Definition of Done — เป็นเกณฑ์ **block** ของ `code-review` / `qa-testing` / `security`

## ⚠️ ค้าง / ต้องสังเกต
1. **ไม่มี Phase ค้าง** — merge ครบทุก branch
2. **RLS ยังไม่ activate** (`RLS_ENABLED=false`) — เปิดพร้อม migrate production เท่านั้น
3. **Stray duplicate files (iCloud)** — เป็นปัญหาเป็นระยะ ทำ build พัง; ลบทีละไฟล์ (`rm <file>` ไม่ใช่ `rm -rf`) เมื่อพบ
4. นี่คือ plan/handoff ครั้งแรกของ project — ก่อนหน้านี้ไม่มี `project-plan.md`
