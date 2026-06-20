# Handoff: Phase 30 — Portfolio Demo Readiness (CODE DONE → DEPLOY)
Date: 2026-06-20
Next focus: **Deploy** demo (set env + provision Anthropic + Vercel) · fix 1 บรรทัด `(agent)/login` redirect `/` → `/dashboard`

## Git State
Base branch: **main** (HEAD `63b71a2`) — Phase 30 ปิดครบ (landing + seed + backend + frontend entry)
**main นำหน้า origin/main 8 commits — ยังไม่ push (Dev push เอง)**

| Phase | Branch | Status | Merged |
|-------|--------|--------|--------|
| 30 | `phase-30/portfolio-demo` | ✅ done (code) | ✅ `30166cf` (--no-ff) |

Working state:
- **Uncommitted (นอกเรื่อง Phase 30 — อย่า commit ปนงานใหม่):** `README.md` (M), `.claude/diagrams/` (??). ตั้งใจปล่อยไว้ตั้งแต่ต้น Phase 30
- Env/process: ไม่มีค้างรัน. **acme demo data สะอาดแล้ว** (cleanup committed — 7 demo ticket, ไม่มี junk)

⚠️ ต้อง verify ก่อนเริ่ม context ถัดไป:
- [ ] `git log --oneline -1 main` = `63b71a2`
- [ ] **Deploy ยังไม่ทำ** — เป็นงานหลักของ context ถัดไป (ดู Next Session)
- [ ] origin ตามหลัง 8 commits — Dev push ก่อน deploy

## Carried Forward
### Decisions (เต็ม → `project-plan.md` + memory)
- **Demo flow:** ปุ่ม "Try live demo" (wire `DEMO_URL` ใน `src/lib/landing-links.ts`) → `/demo` บน demo subdomain → auto-POST `/api/auth/demo/login` (no body) → server set cookie → `window.location.assign("/dashboard")` (full-nav ให้ server auth เห็น cookie)
- **AI route ทั้ง 3 fail-closed** (ไม่เฉพาะ demo): Redis ล่ม → deny กัน Anthropic cost abuse (security เห็นชอบ)
- demo creds public-by-design role=AGENT (`src/lib/demo.ts`); demo-login guard: demo-tenant only + role===AGENT defense-in-depth

### Constraints & Guardrails (ยังบังคับ — เต็มใน `CLAUDE.md`)
- Tenant isolation · audience guard · internal-note PUBLIC-only · money `Int` · webhook idempotent+verify · `RLS_ENABLED=false` (ยังไม่ activate)
- **AuditLog immutable** — cleanup acme ใช้ FK SetNull (audit row คงอยู่) ไม่ลบ audit; ดู memory `seed-demo-idempotency-acme-cruft`

### Artifacts (commit ดู `git show <hash>`)
- Landing `ba203d3` · Slice D seed `c5e9f4a` · Slice D backend `f664d7e` · Phase 30 merge `30166cf` · frontend entry `63b71a2`
- Demo entry: `src/app/(agent)/demo/page.tsx` · demo-login route: `src/app/api/auth/demo/login/route.ts`

## Don't Retry
- **demo-login เรียกตรงจาก landing (apex):** ทำไม่ได้ — route ต้องมี tenant subdomain context. ต้องผ่านหน้า `/demo` บน subdomain ก่อน (ทำแล้ว)
- ลบ junk acme ด้วย DELETE ไม่ดู FK — `AuditLog.ticketId` Restrict-ไม่ใช่/optional→SetNull; ต้อง delete ใน tx (ticketNumber<1000) ให้ cascade จัดการ msg/tag, audit SetNull เอง (ทำแล้ว)
- iCloud stray `* N.ts` ใน `.next/` หลอก tsc — filter `.next/` ออกตอนเช็ค
- `$?` หลัง pipe วัด exit ผิดตัว — รัน tsc/eslint ตรง ๆ

## Session Summary
### เสร็จแล้ว
- Phase 30 ครบทุก slice: landing · demo seed (idempotent, verified 2 รอบ) · demo-login + AI fail-closed (security PASS) · acme junk cleanup (tx) · frontend demo entry + metadata + footer (code-review PASS) · merge → main · project-plan updated

### ค้างอยู่ / Open Questions
- [ ] **Deploy** (งานหลัก context ถัดไป — ดู Next Session)
- [ ] fix 1 บรรทัด: `(agent)/login/page.tsx:81` redirect `router.push("/")` → `"/dashboard"` (dashboard มีแล้ว, TODO ค้างใน comment บรรทัด 80) — Dev ตอบ open question นี้ค้าง
- [ ] Defer 30b: pricing/features-grid section (+ footer #features/#pricing กลับเมื่อมี section)

## Next Session
### เริ่มต้นด้วย
1. อ่าน `.claude/project-plan.md` + memory `seed-demo-idempotency-acme-cruft`, `ai-assist-phase29`, `ci-lint-gate`
2. `git log --oneline -1 main` = `63b71a2` · `git status` (README/diagrams ปล่อยไว้)
3. ตรวจ ⚠️ ด้านบนก่อนเริ่ม

### งาน Deploy (Dev ทำ — บางส่วน manual)
- **set Vercel env (prod):** `NEXT_PUBLIC_DEMO_URL=https://{demo-subdomain}/demo` (เช่น `acme`) · `NEXT_PUBLIC_SIGNIN_URL` · `ANTHROPIC_API_KEY` · ตรวจ `NEXT_PUBLIC_ROOT_DOMAIN`, Redis/Stripe/email/QStash env (Phase 28 ค้าง — ดู project-plan §Phase 28 deploy)
- **Anthropic org spend cap** (manual ที่ console — guardrail demo live AI)
- `git push` (main นำหน้า 8 commits) → Vercel build (CI: lint+tsc+test+build ต้องเขียว — memory `ci-lint-gate`)
- verify: subdomain routing (`{slug}.helpwise.com`) + ปุ่ม demo → `/dashboard`
- **fix เล็ก (delegate frontend หรือ Claudy แก้ตรง):** `(agent)/login` redirect → `/dashboard`

## References
- Master plan: `.claude/project-plan.md` (Phase 30 row + Phase 28 deploy ค้าง)
- Handoff ก่อนหน้า: `.claude/handoffs/phase-30-portfolio-demo-2026-06-20.md` (landing→backend)
- Login pattern: `src/app/api/auth/agent/login/route.ts` · Tenant resolution: `src/proxy.ts`
