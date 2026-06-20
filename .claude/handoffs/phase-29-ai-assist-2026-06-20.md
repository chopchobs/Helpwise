# Handoff: Phase 29 — AI-assist (Claude Haiku 4.5)
Date: 2026-06-20
Next focus: **Phase 30 — Portfolio Demo Readiness** (landing page + seed demo tenants + deploy Vercel) · ก่อนเริ่ม: provision `ANTHROPIC_API_KEY` + test AI demo

## Git State
Base branch: main (HEAD: `868d2ab`) — **ahead of origin 5 commits, ยังไม่ push** (Dev push เอง)

| Phase | Branch | Status | Merged |
|-------|--------|--------|--------|
| 28 | `phase-28/async-queue-notifications` | ✅ | ✅ (`915a4b3`) |
| 29 | `phase-29/ai-assist` | ✅ | ✅ (`66882f6`, `--no-ff`) |

Working state: **clean** (no uncommitted, ไม่มี process/migration ค้างรัน)

⚠️ ต้อง verify ก่อนเริ่ม context ถัดไป:
- [ ] Dev **push main** แล้วหรือยัง (`git status -sb` → ahead 0 = pushed) — ตอน handoff ahead 5
- [ ] `git log --merges --oneline main` เห็น `66882f6 ... phase-29` + `915a4b3 ... phase-28`

## Carried Forward
### Decisions (เต็ม → memory `ai-assist-phase29`, `project-plan.md` § Decisions)
- AI model = **`claude-haiku-4-5`** (cost-appropriate; const `AI_SUMMARY_MODEL` ใน `src/lib/ai.ts`)
- `src/lib/ai.ts` **ไม่ query DB เอง** — route ดึง messages ผ่าน `tenantPrisma` แล้วส่งเข้า lib = defense หลักกัน prompt-injection cross-tenant
- Feature-gate UI = **reactive 403** (ไม่ใช่ client `hasFeature` — กัน hardcode plan); authoritative gate ที่ backend
- suggest-reply = **draft only ห้าม auto-send** · suggest-tags = เสนอจาก tenant tag จริงเท่านั้น (double-validate)

### Constraints & Guardrails (ยังบังคับ — เต็มใน `CLAUDE.md`)
- Tenant isolation · agent-audience (AI output ห้ามหลุด portal) · `hasFeature('ai_assist')` gate · audit ไม่ log PII/draft
- **RLS_ENABLED default = false** — เปิดพร้อม migrate prod เท่านั้น

### Artifacts (Phase 29 — diff ดู `git show 66882f6`)
- `src/lib/ai.ts` · `src/types/ai.ts` · `src/app/api/tickets/[id]/ai/{summarize,suggest-reply,suggest-tags}/route.ts`
- flag `ai_assist`: migration `20260620000000_add_ai_assist_flag` + `prisma/seed.ts` (plan pro/enterprise) + `FEATURE_KEYS.AI_ASSIST`
- UI: `src/app/(agent)/(workspace)/tickets/[id]/page.tsx` (3 ปุ่ม AI)

## Don't Retry (เต็ม → memory)
- client-side `hasFeature` ใน UI — ต้อง hardcode plan (ห้าม) + per-tenant override ทำให้ plan ไม่ authoritative → ใช้ reactive 403
- effort/thinking/temperature params กับ haiku-4-5 — ไม่รองรับ (request ให้ minimal)
- BullMQ worker บน Vercel (Phase 28) · nonce CSP กับ proxy.ts · tenantPrisma ใน `$transaction`

## Session Summary
### เสร็จแล้ว
- Phase 29: AI-assist 3 slice (summarize · suggest-reply draft · suggest-tags) ด้วย Claude Haiku 4.5. ผ่าน security+qa gate ทุก slice. tsc clean, **545 tests pass**. merge `--no-ff` เข้า main + อัปเดต plan/memory

### ค้างอยู่ / Open Questions
- [ ] **Provision `ANTHROPIC_API_KEY`** (env/Vercel) — มิฉะนั้น AI route คืน 502; จำเป็นต่อ demo
- [ ] **Deploy ค้างจาก Phase 28 (Dev):** apply migrations (`add_notification`, `add_sla_notification`, `add_ai_assist_flag`) · QStash env (`QSTASH_*`) + cron `/api/jobs/sla-sweep` · ลบ env `SLA_SWEEP_SECRET`
- [ ] **Deferred hardening** (memory `ai-assist-phase29` + `phase28-deferred-hardening`): rate-limit fail-open+AI cost (org spend cap) · DPA/PDPA ก่อน prod · MEDIUM-2 send-email outbound-eligibility guard · cosmetic `summarizeThread` ใช้ `buildThread`

## Next Session
### เริ่มต้นด้วย
1. อ่าน `.claude/project-plan.md` + memory `ai-assist-phase29`
2. `git log --merges --oneline main` verify phase-29 merged + `git status -sb` เช็ค push
3. ตรวจ ⚠️ + Open Questions ก่อนเริ่ม Phase 30

### Phase ถัดไป
- **Phase 30 — Portfolio Demo Readiness:** landing/marketing page (`app/(marketing)/`) · seed demo tenants (acme/globex) ที่ plan pro+ เปิด ai_assist + มีข้อมูลตัวอย่างจริง · deploy Vercel (env: `ANTHROPIC_API_KEY`, QSTASH, Stripe, Redis, Supabase) → branch `phase-30/portfolio-demo` จาก main (หลัง Dev push)
- หมายเหตุ: seed ปัจจุบันไม่มี demo **tenant** (มีแค่ Plans + FeatureFlags global) — Phase 30 ต้องเพิ่ม Tenant/TenantMember/Contact/Ticket seed

## References
- Master plan: `.claude/project-plan.md`
- Memory: `ai-assist-phase29`, `phase28-deferred-hardening`, `MEMORY.md`
- Handoff ก่อนหน้า: `.claude/handoffs/phase-28-async-queue-complete-2026-06-19.md`
