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
| 37 | Demo personas — visitor login เป็น agent คนที่ 2 (ไม่ใช้ password) + banner ชวนเปิด incognito ให้เห็น real-time presence จริง; security PASS · qa PASS-with-conditions · L-1/L-2 ปิดแล้ว · +166 tests (846→1012) | `feature/phase-37-demo-personas` | ✅ **ปิดครบ** — Gate 1 + Gate 2 ผ่าน (2026-08-04) | ✅ `68ad2e1` |
| 36 | Outbound webhooks — HMAC signing + SSRF guard + QStash retry/DLQ + replay (Portfolio #2); qa PASS-with-conditions (ปิดครบ) · security PASS (MEDIUM-1 rate-limit/cap + MEDIUM-2 RLS ปิดก่อน merge) · docs แปลอังกฤษแล้ว | `feature/phase-36-outbound-webhooks` | 🔴 **ปิด gate ไม่ได้** — smoke 2026-08-05: authz ผ่าน (200) แต่ **dispatch ตายบน prod (QStash region mismatch)** → ดู handoff § Finding | ✅ PR #16 (`af79bff`) |
| 38 | Post-merge gate hardening — P1a (REQUIRED mode ใน `scan:bundle` ผูก build ของ Vercel) · P6a (`buildCsp()` + 12 tests) · P4/P5 (deploy-checklist/operations env + gate เป็นตารางหลักฐาน) · escape hatch `SCAN_BUNDLE_SKIP_REQUIRED` | `feature/phase-38-gate-hardening` | ⏳ **ปิดไม่ได้** — ค้าง 2 อย่างที่ต้องใช้คนรันบน prod (ดู § ⚠️ ค้าง ข้อ 11) | ✅ `1eafba3` — **ยังไม่ push** |

> *Phase 20 = decision เชิงลบ (บันทึกว่า nonce CSP ใช้กับ `proxy.ts` ไม่ได้ — คง `unsafe-inline`) ไม่ใช่ feature ใหม่
> **Chore branches** (merged, ไม่ใช่ phase): `chore/db-init-seed`, `fix/proxy-host-header`, `chore/theme-warm-palette`

## Git State (สำหรับ verify รอบหน้า)
**Status: LAUNCHED — live ที่ gethelpwise.xyz · ⚠️ 2026-08-05: `main` = `1eafba3` (Phase 38 merged) แต่ **ยังไม่ push** — `main` นำ `origin/main` อยู่ (hook บล็อก `git push`, Dev ต้อง push เอง)**
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

**+ Post-merge gate (2026-08-03)** — เฉพาะ phase ที่มี migration / external resource: verify migration apply บน prod จริง (query `_prisma_migrations` ตรง ๆ, ห้ามเชื่อ `migrate status`) · verify effect จริง (`pg_policies` / `information_schema` / `relrowsecurity`) · external resource provision แล้ว (FeatureFlag, bucket, cron, env) · smoke 1 path บน prod. **phase ยังปิดไม่ได้จนกว่าผ่าน** → รายละเอียดใน `CLAUDE.md` § Post-merge gate

## ⚠️ ค้าง / ต้องสังเกต
0. ✅ **Migration prod ครบแล้ว 4 ตัว (2026-07-23, verified จาก `_prisma_migrations` applied=true):** `20260721000000_realtime_presence_rls`, `20260722000000_add_outbound_webhooks`, `20260722010000_add_webhooks_feature_flag`, `20260723000000_webhooks_rls`
   - 🔴 **ข้อเท็จจริงที่แก้แล้ว:** ที่เคยเขียนว่า realtime RLS "apply ด้วยมือผ่าน SQL editor" **ผิด** — `pg_policies` = **0 แถว** = Phase 35 presence/typing **ไม่เคยทำงานบน prod** จนถึง 2026-07-23. สาเหตุ: `alter table realtime.messages enable RLS` ล้ม **42501** (owner=`supabase_realtime_admin`) → ถอดบรรทัดออก (commit `6dafbef`), Supabase เปิด RLS default + `CREATE POLICY` ทำได้. กู้ด้วย `migrate resolve --rolled-back` → `db:deploy`. **ตอนนี้ realtime.messages = 2 policy แล้ว**
   - 🔴 **แก้ข้อความเดิม (2026-08-04):** ที่เคยเขียนว่า *"= presence LIVE บน prod แล้ว"* **ผิด** — policy พร้อมจริง
     แต่ **client ต่อไม่ได้ตั้งแต่แรก**: `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`
     **ไม่เคยถูกตั้งบน Vercel Production** → `getRealtimeClient()` คืน `null` → `useTicketPresence.start()`
     return ทันที (fail-soft) → **ไม่เคยยิง `/api/realtime/token` เลย**. พบตอนเดิน Gate 2 ของ Phase 37 (C-5 FAIL)
     → **Phase 35 presence ไม่เคยทำงานบน prod เลยตั้งแต่ต้น** · `NEXT_PUBLIC_*` inline ตอน build → ตั้ง env แล้ว **ต้อง redeploy**
     · หลักฐาน + ข้อเสนอเชิงระบบ → `.claude/specs/phase-37-gate2-run-sheet.md` § ผลการเดิน + `.claude/specs/post-merge-gate-external-resource-proposal.md`
   - ⚠️ บทเรียนถาวร (memory `realtime-messages-rls-supabase`): Prisma migration ถือกรรมสิทธิ์เฉพาะ schema `public`; `migrate status` เชื่อไม่ได้เมื่อมี failed migration (query `_prisma_migrations` ตรง ๆ)
   - ✅ **smoke presence ปิดแล้ว (2026-08-04)** — Gate 2 ของ Phase 37 กอง C-5 ผ่าน: WS `101` +
     `phx_reply {"status":"ok"}` + `presence_diff` joins · W1 เห็น "AR กำลังดูอยู่" · W2 เห็น "DA กำลังดูอยู่"
     = **ครั้งแรกที่ presence ทำงานจริงบน prod** (ต้องแก้ 3 ชั้นก่อน — ดู ข้อ 7)
   - เหลือ: เปิด FeatureFlag `webhooks`
   - ✅ **Open Q ปิดแล้ว (2026-08-03, Dev อนุมัติ):** เพิ่ม **Post-merge gate** เข้า DoD (`CLAUDE.md` § Post-merge gate) — phase ที่มี migration/external resource ต้อง verify บน prod จริงก่อนปิด phase
   - 🔶 **ผลย้อนหลัง (อัปเดต 2026-08-04):** Phase 35 **ผ่าน post-merge gate ครบแล้ว** (migration ✅ · smoke presence prod ✅)
     · Phase 36 ยัง **done-with-open-gate** (FeatureFlag `webhooks` ยังไม่เปิดให้ tenant ใด ✗)
1. **ไม่มี Phase ค้าง · LAUNCHED แล้ว** — merge + push ครบทุก branch, deploy live ที่ gethelpwise.xyz (Phase 31-33)
2. **RLS ยังไม่ active** (`RLS_ENABLED=false`, app ใช้ BYPASSRLS role) — application-enforced isolation เป็นด่านจริง; จะ activate RLS ต้องสลับ DB role + เปิด flag
3. **Stray duplicate files (iCloud)** — เป็นปัญหาเป็นระยะ ทำ build พัง; ลบทีละไฟล์ (`rm <file>` ไม่ใช่ `rm -rf`) เมื่อพบ
4. **Phase 28 deploy = เสร็จแล้วตอน launch** (Phase 31-33): migration `20260619000000_add_notification` + `20260619010000_add_sla_notification` apply แล้ว · QStash env provision + cron ยิง `/api/jobs/sla-sweep` แล้ว · `SLA_SWEEP_SECRET` ถอดออกครบ. deferred hardening ที่ยังเหลือ → memory `phase28-deferred-hardening`
5. **Email = Postmark scaffold** (`src/lib/email.ts` fetch-based, ไม่มี SDK dep; SendGrid = TODO) — wire จริง + verify provider key ก่อนเปิด outbound production จริงจัง
6. 🔴 **`prisma/seed-demo.ts` re-seed บน prod = อันตราย ต้องอ่านก่อนรัน** (วิเคราะห์ 2026-08-03, ยังไม่แก้ = backlog)
   - **`ticketCounter` hard-set (`l.868-871`)**: `data: { ticketCounter: maxTicketNumber }` (acme 1007 / globex 1006) ไม่ใช่ `max()` → ถ้า prod มี ticket เลขเกินนั้น counter **ถอยหลัง** → ชน unique `(tenantId, ticketNumber)` → **สร้าง ticket ใหม่ไม่ได้ทั้ง tenant** จนแก้มือ
   - `Tenant.settings` ถูกทับทั้งก้อน (branding จาก UI หาย) · `Subscription` ถูกทับ (status/price/period reset จาก now — ทับ Stripe sync)
   - ไม่มี dry-run flag · ไม่มี `delete` (upsert ล้วน จึงไม่ลบ junk ให้)
   - **Fix ที่ควรทำ (backlog):** เปลี่ยนเป็น `ticketCounter: Math.max(existing, maxTicketNumber)` · `settings` merge แทน replace หรือ update เฉพาะตอน create · เพิ่ม `--dry-run` flag. รายละเอียดเต็ม → memory `seed-demo-idempotency-acme-cruft`
7. ✅ **Phase 37 — Gate 1 + Gate 2 ผ่านครบ (2026-08-04) → ปิดเฟสได้** · 1012 tests เขียว
   - ✅ **Gate 1 ผ่าน** (SQL audit บน prod 2026-08-03, read-only): persona **4/4 OK** (User+TenantMember role=AGENT active) · contact/ticket นอก seed = **0** · **ApiKey/WebhookEndpoint/Attachment = 0** ทั้ง 2 tenant · `ticketCounter` ตรง `MAX(ticketNumber)` พอดี (acme 1007 · globex 1006) → **ไม่ต้อง re-seed**
   - ✅ **Gate 2 ผ่าน** — **B-7 (P0) ผ่านครบ 3 เกณฑ์** · **C-1…C-8 ผ่านทั้งหมด** · **C-8c = prod smoke เต็มตัว**
     (Checkpoint 1 DB + Checkpoint 2 Redis ผ่านทั้งคู่ → ไม่มี known gap). หลักฐานเด่น: portal แสดง
     **"การสนทนา (2 ข้อความ)"** ขณะที่ agent มี 4 → **ตัวนับเป็น 2 = กรองที่ระดับ query ไม่ใช่ UI** ·
     portal list เห็นเฉพาะ #1001/#1004 ของ Jane. รายละเอียด → `.claude/specs/phase-37-gate2-run-sheet.md`
   - 🔧 **Gate 2 เจอของจริงที่ทุก gate ก่อนหน้าไม่จับ** — C-5 รอบแรก FAIL จาก **3 ชั้นซ้อน**:
     (1) `NEXT_PUBLIC_SUPABASE_*` ไม่ได้ตั้งบน Vercel → เงียบสนิท (2) `SUPABASE_REALTIME_JWT_PRIVATE_KEY`/`KID`
     ไม่ได้ตั้ง → token 500 แต่ client กลืน error (3) 🔴 **CSP `connect-src` ไม่รองรับ Supabase = บั๊กโค้ดจาก Phase 35**
     (แก้แล้ว `fd8cb08`) → ข้อเสนอเชิงระบบ P1a-P7 ใน `.claude/specs/post-merge-gate-external-resource-proposal.md`
   - ⚠️ **R-1 ยังมีผลเชิงนโยบาย:** persona `secondary` login ได้โดยไม่มี credential → ข้อมูลใน acme/globex = **public ทั้งหมด** (ตอนนี้ข้อมูลสะอาดแล้ว แต่กฎคือ **ห้ามเอาของจริงเข้า 2 tenant นี้อีก**)
   - ✅ **open item `owner@acme.test` — เปลี่ยนสถานะแล้ว (2026-08-04):** ใช้เป็น subject ของ B-7 ผ่าน **"ทาง A′"**
     — จำ password ไม่ได้ + repo ไม่มี password-reset route → **สร้าง bcrypt hash เองแล้ว update `passwordHash`
     ผ่าน Supabase** (prod write ที่ไม่ได้วางแผนไว้ แต่ไม่เพิ่มแถวใหม่ baseline Gate 1 จึงไม่เสีย)
     → **standing risk ปิดไปในตัว**: จากเดิม "บัญชี OWNER บน tenant public ที่ไม่มีใครรู้ password"
     เป็น "**Dev คุม credential แล้ว**" · ตัวเลือกที่เหลือ (deactivate / ลด role / ถอด membership) ยังเปิดอยู่
     แต่**ไม่เร่งด่วนแล้ว**
   - 🔴 **บั๊กที่เจอระหว่างเดิน Gate 2 (ไม่เกี่ยวกับ Phase 37 แต่ severity สูงกว่า — ดูข้อ 9)**
   - บันทึกเหตุผลการตัดสินใจ 11 บท → `docs/phase-37-decision-log.md`
   - รายละเอียดเต็ม → `.claude/handoffs/phase-37-demo-personas-2026-08-03.md`
9. ✅ **`/portal` 404 หลัง magic-link verify — แก้แล้ว + smoke prod ผ่าน (hotfix 2026-08-04) ปิดครบ**
   - `src/app/(portal)/portal/verify/page.tsx:73-74` → `router.push("/portal")` แต่ **`/portal` ไม่มี `page.tsx`
     และไม่เคยมีในประวัติ repo** (`git log --all` ยืนยัน) → **contact ทุกคนเจอ 404 ทันทีหลัง login สำเร็จ**
     (session ถูกสร้างแล้ว แค่ปลายทางผิด) — นี่คือ **entry point เดียวของ portal ลูกค้า**
   - มี TODO เขียนกำกับไว้ตั้งแต่แรกว่า *"เปลี่ยนเป็น `/portal/tickets` เมื่อสร้างแล้ว"* — **`/portal/tickets` สร้างไปนานแล้ว**
     และ `"/portal"` ถูกอ้างอิงจุดเดียวในทั้ง repo → **fix = 1 บรรทัด ไม่มี dependency**
   - failure mode คนละแบบกับ presence: presence = *"ไม่มีใครรู้"* · อันนี้ = *"รู้ตั้งแต่เขียน แล้ว deferral
     ไม่เคยถูกทบทวน"* → ข้อเสนอ **P7** (grep TODO เทียบ route จริง / พิจารณาเปิด `typedRoutes`)
   - ✅ **แก้แล้วเป็น hotfix แยก** (ไม่ผูกกับ Phase 37 และไม่ผูกกับ P7 — P7 = กลไกป้องกันที่ต้องออกแบบ
     ส่วนนี่คือบั๊กที่กำลังทำร้าย user อยู่ ผูกกันจะกลายเป็นตัวประกันของงานที่ช้ากว่า):
     `router.push("/portal/tickets")` · tsc + eslint clean · **1012 tests ผ่าน**
   - ✅ **smoke prod ผ่าน (2026-08-04):** Private Window → ขอ magic link ใหม่ (ครั้งเดียว ไม่ติด rate limit)
     → verify แสดง "กำลังตรวจสอบ…" → **เด้งไป `/portal/tickets` เอง** → เห็น **#1001 (2 ข้อความ)** และ
     **#1004 (1 ข้อความ)** ของ Jane Cooper → ผ่านเกณฑ์เต็ม (ลงถูกหน้า + ข้อมูลถูกต้อง ไม่ใช่แค่ "ไม่ 404")
10. นี่คือ plan/handoff ครั้งแรกของ project — ก่อนหน้านี้ไม่มี `project-plan.md`
11. ⏳ **Phase 38 merged (`1eafba3`) แต่ยัง "ปิดไม่ได้"** — ค้าง 2 อย่างที่ต้องใช้คนรันบน prod: **(ก)** อ่าน build log ของ deploy ที่มาจาก `1eafba3` **(ข)** smoke webhooks ทาง A
    → รายละเอียดทั้งหมด (residual gap 4 ชั้น · case study P5 · backlog · don't retry): **`.claude/handoffs/phase-38-gate-hardening-merged-2026-08-05.md`**
