# Handoff: Phase 32 — Deploy Verify (multi-tenant + AI) + optional email
Date: 2026-06-21
Next focus: **verify multi-tenant prod deploy (acme/globex/demo-login/AI) เมื่อ DNS เขียว** → (optional) email outbound setup (ImprovMX forward + Postmark)

## Git State
Base branch: **main** (HEAD `f417541`) — synced origin/main (0 ahead / 0 behind, pushed ✅), working tree clean
- `f417541` chore: swap root domain → gethelpwise.xyz (29 files, tsc/eslint/vitest 576 green)
- `41ceab3` docs(handoff): Phase 31 production-deploy

| Phase | Branch | Status | Merged |
|-------|--------|--------|--------|
| 31 (deploy) | (commit ตรง main) | ✅ code+DB ready, Vercel deployed | ✅ pushed |
| 32 (verify) | (commit ตรง main) | 🔄 รอ DNS propagate → verify | — |

Working state: **clean, ไม่มี process ค้าง.** prod DB migrate+seed เสร็จ verified แล้ว (ดู Carried Forward)

⚠️ ต้อง verify ก่อนเริ่ม context ถัดไป:
- [ ] `git log --oneline -1 main` = `f417541` · `git status` clean
- [ ] **DNS propagate ถึงไหน** — Vercel domain ขึ้น "Valid Configuration" เขียวหรือยัง (เงื่อนไขเริ่ม verify ทั้งหมด)

## Deploy STATE (infra — Dev provision เอง)
- **Vercel project "helpwise" (Hobby)** deploy สำเร็จ · `helpwise-bice.vercel.app` = Valid
- **Custom domain** `gethelpwise.xyz` + `*.gethelpwise.xyz` added (Production scope)
- **GoDaddy nameservers → `ns1.vercel-dns.com` / `ns2.vercel-dns.com`** (เปลี่ยนแล้ว — **รอ propagate**, NS เปลี่ยนช้าได้ถึงหลาย ชม.)
- **prod Supabase** = `vygcqpktvjtynbboloex` (ap-southeast-1) — migrate(13) + db seed(3 plan/6 flag) + seed-demo เสร็จ
- **Vercel ENV (Production):** ค่า `.xyz` ครบ (ROOT_DOMAIN/DEMO/SIGNIN/API_BASE/QSTASH_TARGET/EMAIL_FROM) · `RLS_ENABLED=false` · **email 3 ตัว (EMAIL_PROVIDER/_API_KEY + INBOUND_WEBHOOK_SECRET) ยังไม่ set → console stub** (deferred) · **ไม่มี `SLA_SWEEP_SECRET`** (deprecated)

## Carried Forward
### Verified session นี้ (ห้ามตรวจซ้ำ — เผา token เปล่า)
- **prod DB สะอาด:** acme = ticket `#1001–1007` เป๊ะ (7 ใบ), contacts=4, tenant มีแค่ `acme`+`globex` — **ไม่มี dev/smoke junk** (เคลียร์ memory `seed-demo-idempotency-acme-cruft`)
- **demo creds (PUBLIC by design, role=AGENT):** `demo@acme.helpwise.com` / `demo@globex.helpwise.com` — password อยู่ใน `src/lib/demo.ts` (DEMO_PASSWORD). **อีเมล demo คง `.helpwise.com`** (login id ผูก DB ที่ seed แล้ว — ดู memory `real-domain-gethelpwise-xyz`)
- **.env.example ครบ 23/23** ตรงกับโค้ด — EMAIL_PROVIDER มี default `"console"` (email.ts:59), จัดอยู่ RECOMMENDED ไม่ใช่ REQUIRED (instrumentation.ts)

### Constraints (ยังบังคับ — เต็มอยู่ `CLAUDE.md`)
tenant isolation · audience guard (agent/contact แยก) · internal-note PUBLIC-only · ห้ามรับ tenantId จาก client · webhook idempotent+verify signature · ห้ามเคลม active DB-level RLS (RLS_ENABLED=false, role postgres BYPASSRLS)

## Don't Retry
- **`git push` ฝั่ง Claudy** — hook block. Commit ได้ แต่ Dev `!git push` เอง
- **ตรวจ prod DB seed / .env.example completeness ซ้ำ** — verified แล้ว (ดู Carried Forward)
- **swap demo email เป็น .xyz** — จะพัง demo-login (DB มี .helpwise.com) ต้อง re-seed พร้อมกัน, ไม่คุ้ม cosmetic
- zsh กิน glob ใน `grep --include` — ใช้ `grep -rn` / `perl -pi -e` / Read ตรง

## Session Summary
### เสร็จแล้ว
- งาน 1: deploy-checklist §4/§5 — migrate+seed prod Supabase + verify acme 7 ticket สะอาด
- งาน 2: domain swap `helpwise.com`→`gethelpwise.xyz` (commit `f417541`, 29 files, gate green) — เว้น test fixtures + demo emails (accepted residue)
- ตอบ env audit: .env.example ครบ 23/23, EMAIL_PROVIDER มี code default

### Open Questions
- [ ] ไม่มีค้าง — รอ DNS propagate เท่านั้น

## Next Session
### เริ่มต้นด้วย
1. อ่าน `.claude/project-plan.md` + memory `real-domain-gethelpwise-xyz`, `rls-hardening-phase27`
2. `git log --oneline -1 main` = `f417541` · `git status` clean
3. **ถาม Dev / เช็ค: Vercel domain "Valid Configuration" เขียวหรือยัง** ก่อนเริ่ม verify

### งานหลัก (พอ DNS เขียว)
1. **รอ DNS** → Vercel "Valid Configuration" เขียว → wildcard SSL (`*.gethelpwise.xyz`) ออกอัตโนมัติ
2. **Verify (deploy-checklist §8):**
   - `gethelpwise.xyz` → landing โหลด + cert Active
   - `acme.gethelpwise.xyz` vs `globex.gethelpwise.xyz` → **แยก tenant จริง** (data ไม่ปน)
   - ปุ่ม "Try live demo" → `/demo` → auto-login → **`/dashboard`** · login ปกติ → `/dashboard`
   - **AI summarize** ทำงาน (ANTHROPIC_API_KEY set + spend cap แล้ว) · Redis down → fail-closed
3. **(optional) email outbound:**
   - ImprovMX: forward `support@gethelpwise.xyz` → gmail (เพิ่ม **MX record ที่ Vercel DNS**)
   - Postmark: create account + verify domain (เพิ่ม **DKIM ที่ Vercel DNS**)
   - set `EMAIL_PROVIDER=postmark` + `EMAIL_PROVIDER_API_KEY` + `EMAIL_FROM_ADDRESS=support@gethelpwise.xyz` ใน Vercel env → **redeploy**

### DEFERRED (ยกข้าม — ยังต้องตามเก็บ)
- **email inbound** — MX ของ ImprovMX (forward) ชนกับ inbound parse webhook; ต้องเลือกทางก่อน (memory: ออกแบบ inbound routing)
- **regex migrate 3 จุด** → `@/lib/slug` (proxy.ts · email/inbound.ts · api/auth/signup/route.ts) = drift debt (memory `slug-canonical-helper`)
- **RLS activation จริง** — ต้อง non-BYPASSRLS app role + cross-tenant DB test + load-test ก่อนเปิด flag (memory `rls-hardening-phase27`)
- **phase28-deferred-hardening** — send-email outbound-eligibility guard + trust-model ADR (memory `phase28-deferred-hardening`)

## References
- Master plan: `.claude/project-plan.md`
- Deploy runbook: `docs/deploy-checklist.md`
- Handoff ก่อนหน้า: `.claude/handoffs/phase-31-production-deploy-2026-06-21.md`
- Memory: `real-domain-gethelpwise-xyz`, `seed-demo-idempotency-acme-cruft`, `rls-hardening-phase27`
