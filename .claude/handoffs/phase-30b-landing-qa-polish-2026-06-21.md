# Handoff: Phase 30b — Landing QA & Polish
Date: 2026-06-21
Next focus: **Deploy to production (Vercel)** — follow `docs/deploy-checklist.md` step-by-step

## Git State
Base branch: **main** (HEAD `22191c8`) — **synced กับ origin/main แล้ว (pushed ✅)**, working tree clean
3 commit ของ session นี้อยู่บน origin ครบ:
- `53bec88` fix(agent): login redirect `/` → `/dashboard`
- `a74b8a8` docs(deploy): add `docs/deploy-checklist.md` + fix env docs (ลบ deprecated `SLA_SWEEP_SECRET`)
- `22191c8` feat(landing): workspace-picker `/signin` + slug.ts canonical + fallback derive

| Phase | Branch | Status | Merged |
|-------|--------|--------|--------|
| 30b | (commit ตรงเข้า main) | ✅ done | ✅ pushed |

Working state: **ไม่มี uncommitted / ไม่มี process ค้าง** (clean). ทุก gate ผ่าน (code-review Approve · vitest 22/22 green · tsc clean · eslint 0)

⚠️ ต้อง verify ก่อนเริ่ม context ถัดไป:
- [ ] `git log --oneline -1 main` = `22191c8` และ `git status` clean
- [ ] **Deploy ยังไม่ทำ** — เป็นงานหลักของ context ถัดไป

## Carried Forward
### 30b เสร็จแล้ว (รายละเอียดดู commit/diff — ไม่ duplicate)
- workspace-picker `/signin` (`src/app/(marketing)/signin/page.tsx`) — root domain ไม่มี tenant → กรอก slug → `{slug}.{ROOT}/login`
- `src/lib/slug.ts` = **canonical** slug guard (`SLUG_REGEX`/`isValidSlugFormat`/`buildTenantLoginUrl`) + test `src/lib/__tests__/slug.test.ts` (22 cases, open-redirect proof)
- `src/lib/landing-links.ts` — fallback derive จาก `NEXT_PUBLIC_ROOT_DOMAIN` (ไม่มี dead `#`)
- signup page link `/login` → `/signin` (dead-end เดียวกันบน root)

### DEFERRED (ยกไป context หน้า — ยังบังคับ/ต้องตามเก็บ)
- **regex migrate 3 จุด** → `@/lib/slug` (memory `slug-canonical-helper`): `proxy.ts:40` · `lib/email/inbound.ts:374` · `api/auth/signup/route.ts:43`. **Confirmed byte-identical `/^[a-z0-9-]+$/`** = drift debt **ไม่ใช่ deploy blocker**. เป็น **security-gated phase แยก** (proxy = ด่านแรก tenant isolation → qa-testing/security verify subdomain routing ห้าม regress)
- **#1 `.helpwise.com` suffix derive** — hardcode ใน signin/signup input (pre-existing); derive จาก env ทั้งคู่รอบเดียว
- **phase28-deferred-hardening** (memory) — MEDIUM-2 send-email outbound-eligibility guard + trust-model ADR ยังค้าง
- Constraints หลักทั้งหมด → `CLAUDE.md` (tenant isolation · audience guard · internal-note PUBLIC-only · `RLS_ENABLED=false` ยังไม่ activate)

## Don't Retry
- picker วางที่ `/login` — ชน `(agent)/login` (route ไม่ผูก domain, proxy แค่ inject tenant header) → ใช้ `/signin`
- fold regex-migrate 3 security จุดเข้า commit polish — ต้อง gate แยก
- iCloud stray `* N.ts` หลอก tsc — filter `.next/` ออกตอนเช็ค

## Session Summary
### เสร็จแล้ว
- Phase 30b: audit landing 19 interactive element (ไม่มี dead section anchor จริง) → fix env-fallback `#` + Sign-in routing (workspace-picker) + extract slug.ts canonical พร้อม test → 3 commit pushed, main clean

### Open Questions
- [ ] ไม่มีค้าง — พร้อม deploy

## Next Session
### เริ่มต้นด้วย
1. อ่าน `.claude/project-plan.md` + memory `slug-canonical-helper`, `phase28-deferred-hardening`, `ci-lint-gate`, `nextjs16-proxy-vs-middleware`
2. `git log --oneline -1 main` = `22191c8` · `git status` clean
3. ตรวจ ⚠️ + DEFERRED ด้านบน

### งานหลัก: Deploy to production (Vercel)
- **ทำตาม `docs/deploy-checklist.md` ตามลำดับ** (DNS+wildcard → provision services → set Vercel env → migrate → seed demo → push → webhooks → verify)
- §0 DNS decision: custom domain + wildcard (`*.helpwise.com`) — demo subdomain ต้องการ; vercel.app เปล่าใช้ไม่ได้
- §2 Anthropic org spend cap ก่อน go-live (demo creds public)
- งานส่วนใหญ่ **manual โดย Dev** (provision/DNS/console) — Claudy แตะแค่ source control + code
- **เสร็จ deploy → เอา folder เข้า Cowork สอนทั้ง project**

## References
- Master plan: `.claude/project-plan.md`
- Deploy runbook: `docs/deploy-checklist.md` (งานหลัก context หน้า)
- Handoff ก่อนหน้า: `.claude/handoffs/phase-30-portfolio-demo-deploy-2026-06-20.md`
- Memory index: `.claude/projects/.../memory/MEMORY.md`
