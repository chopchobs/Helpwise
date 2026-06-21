# Handoff: Phase 31 — Production Deploy (Vercel)
Date: 2026-06-21
Next focus: **post-provision — run migrate+seed prod DB (`docs/deploy-checklist.md` §4/§5) → set Vercel env → §6 build → §7/8 webhooks + verify + debug**

## Git State
Base branch: **main** (HEAD `35877e5`) — **synced กับ origin/main (pushed ✅, 0 ahead)**, working tree clean
- `35877e5` docs(landing): reword RLS claims → truthful (app-enforced; RLS scaffolded)
- `b41727f` docs(deploy): fix §5 seed order (migrate → db seed → seed-demo)
- `744b1e0` docs(handoff): Phase 30b done

| Phase | Branch | Status | Merged |
|-------|--------|--------|--------|
| 31 (deploy) | (commit ตรงเข้า main) | 🔄 in progress — code ready, infra pending | ✅ pushed |

Working state: **clean, ไม่มี process ค้าง.** ทุก gate green (tsc 0 · eslint 0 · vitest 576/576 · 2 SVG sync).
**Code = 100% deploy-ready.** บล็อกอยู่ที่ Dev provision external services (offline manual) เท่านั้น

⚠️ ต้อง verify ก่อนเริ่ม context ถัดไป:
- [ ] `git log --oneline -1 main` = `35877e5` · `git status` clean
- [ ] Dev provision (§0 DNS + §1) ถึงไหน — ถามก่อนรัน §4/§5

## IN PROGRESS (Dev offline)
Dev กำลัง provision: **§0 DNS** (จด domain + nameservers→Vercel + wildcard `*.helpwise.com`) + **§1** Supabase(+private bucket) / Upstash Redis+QStash / Stripe / Email / Anthropic(+spend cap §2). ทั้งหมด manual ในคอนโซล — Claudy แตะแค่ source control + code

## Carried Forward
### Findings (verified session นี้ — ห้ามตรวจซ้ำ)
- **RLS_ENABLED = `false`** ตอน deploy: role Supabase `postgres` มี `BYPASSRLS=true` → FORCE RLS ไม่ enforce (พิสูจน์: FORCE active + ไม่ตั้ง GUC → ยังคืนทุกแถว). `migrate deploy` apply FORCE RLS บน prod เปล่า **ปลอดภัย** กับ flag off. isolation จริง = app-layer (`tenantPrisma`). รายละเอียด → memory `rls-hardening-phase27`
- **`QSTASH_TARGET_BASE_URL=acme.helpwise.com` ถูกต้อง** — worker resolve tenant จาก verified **payload** (send-email) / DB loop (sla-sweep) ไม่ใช่ Host; base ใช้แค่ pin signature URL (sign=verify ต้องตรง). ไม่ต้องเปลี่ยนเป็น apex
- **`AUTH_SECRET`** gen ใหม่แล้ว → Dev ใส่ใน **Vercel env (Production)** เอง (ค่าไม่อยู่ในไฟล์ใด — generate ซ้ำด้วย `openssl rand -base64 48` ได้)

### Constraints (ยังบังคับ — เต็มอยู่ `CLAUDE.md`)
tenant isolation · audience guard (agent/contact แยก) · internal-note PUBLIC-only · ห้ามรับ tenantId จาก client · webhook idempotent+verify signature · ห้ามเคลม active DB-level RLS (จนกว่าจะมี non-bypass role + cross-tenant DB test)

## Don't Retry
- **`git push` ฝั่ง Claudy** — hook block (`block-dangerous-git.sh`). Commit ได้ แต่ Dev ต้อง `!git push` เอง
- **ตรวจ RLS/QSTASH base ซ้ำ** — verified แล้ว (ดู Findings) อย่าเผา token ซ้ำ
- zsh กิน glob ใน `grep --include`/`rg -E` (=encoding) — ใช้ `rg -n` หรือ Read ตรง

## Session Summary
### เสร็จแล้ว
- Pre-flight deploy-readiness: verify git/gate green · `.env.example` ครบ 23/23 ตรง checklist
- แก้ `docs/deploy-checklist.md §5` (3-step seed order) — commit `b41727f`
- ตอบ 2 go-live flag (RLS, QSTASH base) ด้วยหลักฐานจาก code+DB
- Reword RLS claims 3 surface (landing `UnderTheHood.tsx` · `README.md` · architecture SVG ×2) — commit `35877e5`

### Open Questions
- [ ] ไม่มีค้าง — รอ Dev provision เสร็จเท่านั้น

## Next Session
### เริ่มต้นด้วย
1. อ่าน `.claude/project-plan.md` + memory `rls-hardening-phase27`, `seed-demo-idempotency-acme-cruft`, `prisma7-supabase-datasource`, `ci-lint-gate`
2. `git log --oneline -1 main` = `35877e5` · `git status` clean
3. **ถาม Dev: provision เสร็จหรือยัง + มี prod `DIRECT_URL`/Vercel env ครบไหม** ก่อนรัน migrate

### งานหลัก (พอ Dev กลับมาพร้อม creds)
ตาม `docs/deploy-checklist.md` ตามลำดับ:
- **§4/§5 migrate+seed prod** (ต่อ prod `DIRECT_URL`): `prisma migrate deploy` → `prisma db seed` → `tsx prisma/seed-demo.ts` → verify acme = 7 ticket, ไม่มี dev/smoke junk (memory `seed-demo-idempotency-acme-cruft`: ระวัง acme cruft)
- **§3 Vercel env** (Production scope) — `RLS_ENABLED=false` คงไว้ · landing CTA fallback="#" อย่าลืม set
- **§6** Vercel build CI เขียว · **§7** Stripe/email/QStash webhooks หลังได้ prod URL · **§8** verify demo→`/dashboard`, AI fail-closed, Stripe idempotent
- ⚠️ secret ทุกตัว Dev ใส่ใน Vercel console เอง — **ห้ามเขียนค่าจริงลง repo/handoff/log**

### DEFERRED (ยกข้าม Phase — ยังต้องตามเก็บ)
- **RLS activation จริง** — ต้อง (1) non-BYPASSRLS app role (2) cross-tenant DB-level test (3) load-test fan-out endpoint ก่อนเปิด flag (memory `rls-hardening-phase27`)
- **regex migrate 3 จุด** → `@/lib/slug` (`proxy.ts` · `lib/email/inbound.ts` · `api/auth/signup/route.ts`) = drift debt, security-gated phase แยก (memory `slug-canonical-helper`)
- **#1 `.helpwise.com` suffix derive** จาก env ใน signin/signup input (pre-existing hardcode)
- **phase28-deferred-hardening** — MEDIUM-2 send-email outbound-eligibility guard + trust-model ADR (memory `phase28-deferred-hardening`)

## References
- Master plan: `.claude/project-plan.md`
- Deploy runbook: `docs/deploy-checklist.md` (งานหลัก context หน้า)
- Handoff ก่อนหน้า: `.claude/handoffs/phase-30b-landing-qa-polish-2026-06-21.md`
- Memory index: `.claude/projects/.../memory/MEMORY.md`
