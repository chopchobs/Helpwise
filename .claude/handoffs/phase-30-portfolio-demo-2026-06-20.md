# Handoff: Phase 30 — Portfolio Demo Readiness
Date: 2026-06-20
Next focus: **Slice D backend** (demo-login one-click + public-AI rate-limit **fail-closed**) → รัน `seed-demo` 2 รอบ verify idempotent → test demo-login e2e. **migrate เสร็จแล้ว** (6 migrations applied, `RLS_ENABLED=false`)

## Git State
Base branch: main (HEAD: `868d2ab`, ยังไม่ push — Dev push เอง)
Working branch: **`phase-30/portfolio-demo`** (HEAD: `ba203d3`, ยังไม่ merge เข้า main)

| Phase | Branch | Status | Merged |
|-------|--------|--------|--------|
| 30 (landing A+B+C) | `phase-30/portfolio-demo` | ✅ committed `ba203d3` | ❌ ยังไม่ merge |
| 30 (Slice D backend) | (เดียวกัน) | ❌ ยังไม่เริ่ม | ❌ |

Working state:
- **Uncommitted (ตั้งใจ — Slice D seed เสร็จแต่ยังไม่ commit):** `prisma/seed-demo.ts`, `src/lib/demo.ts` · นอกเรื่อง: `README.md` (M, ไม่ใช่ Phase 30), `.claude/diagrams/` (??)
- Env/process: ไม่มีค้างรัน. DB migrate เสร็จแล้ว (Dev). **partial demo data ค้างใน acme** จากตอน seed fail รอบแรก → seed idempotent reconcile เอง ไม่ต้อง cleanup

⚠️ ต้อง verify ก่อนเริ่ม:
- [ ] `git log --oneline -1` = `ba203d3` (landing committed)
- [ ] `npx tsx prisma/seed-demo.ts` รัน 2 รอบติด สำเร็จ (idempotent) — **ยังไม่เคยรันจบ** (รอบแรก fail เพราะ Tag table ไม่มี, ตอนนี้ migrate แล้วน่าจะผ่าน)
- [ ] commit Slice D seed (`seed-demo.ts` + `demo.ts`) หลัง verify

## Carried Forward
### Decisions (รายละเอียดเต็ม → `project-plan.md`, memory)
- Scope = **4-slice MVP** (hero+nav · AI · under-the-hood · demo entry). Defer pricing/features-grid/multi-tenancy/how-it-works → Phase 30b
- **Demo routing = Dev ตัดสินตอน deploy** → landing ใช้ `src/lib/landing-links.ts` (`DEMO_URL`/`SIGNIN_URL` fallback `#`, wire ผ่าน `NEXT_PUBLIC_*`)
- **Live AI in demo** ภายใต้ 3 guardrail: (1) Anthropic **org spend cap** (Dev ตั้งก่อน deploy) (2) public-AI route **fail-closed** (Redis error → deny ไม่ allow — กัน cost abuse) (3) AI อยู่หลัง demo-login
- demo creds **public-by-design**, role=**AGENT** (ไม่ใช่ OWNER/ADMIN). contract ใน `src/lib/demo.ts` (`DEMO_AGENTS`, `DEMO_PASSWORD` env-key style: password literal "demo-helpwise-2026" public โดยตั้งใจ)

### Constraints & Guardrails (ยังบังคับ — เต็มใน `CLAUDE.md`)
- Tenant isolation · audience guard (`requireAgent`/`requireContact` แยกขาด) · internal-note PUBLIC-only ฝั่ง portal · money `Int` · webhook/inbound idempotent+verify
- **RLS_ENABLED=false** (migrate แล้วแต่ยังไม่ activate — full RLS activation เป็น step แยกทีหลัง)
- demo-login: import creds จาก `@/lib/demo`; reuse logic login route เดิม (`src/app/api/auth/agent/login/route.ts` — password+membership+`issueAgentToken`+`setAgentCookie`). ต้องอยู่บน tenant context (subdomain)

### Artifacts
- Landing: `src/app/page.tsx` + `src/components/landing/` (9) + `src/lib/landing-links.ts` + `public/helpwise-architecture.svg` (commit `ba203d3`, diff: `git show ba203d3`)
- Slice D seed (uncommitted): `prisma/seed-demo.ts` (acme/globex, plan=pro, 6-8 ticket/tenant, INTERNAL note, near-breach SLA, tags) · `src/lib/demo.ts` (creds contract, **ห้าม import `@/`** — tsx ใน seed resolve alias ไม่ได้ → seed import relative `../src/lib/demo`)

## Don't Retry
- `import { Github } from "lucide-react"` — v1.17 ถอด brand icon ออกแล้ว (TS2305) → ใช้ `src/components/landing/GithubIcon.tsx` (inline SVG)
- `$?` หลัง pipe (`tsc | tail; echo $?`) วัด exit ของ tail ไม่ใช่ tsc — รัน tsc ตรง ๆ
- iCloud stray `* 2.*` (เช่น `.next/types/routes.d 2.ts`) หลอก tsc error — `find ... -name '* 2.*' -delete` (ดู memory `icloud-stray-duplicates`)
- ลบ partial demo data ด้วย cascading DELETE บน shared DB — destructive, ถูก block ถูกแล้ว (seed idempotent reconcile เอง)

## Session Summary
### เสร็จแล้ว
- Phase 30 landing (Slice A+B+C): nav/hero/tech-strip/AI/under-the-hood/CTA/footer — Server Component, token-clean, AA-fixed, ผ่าน code-review gate, build static. commit `ba203d3`
- Slice D seed code (verified tsc, ยังไม่รันจบ/ยังไม่ commit)

### ค้างอยู่ / Open Questions
- [ ] **Slice D backend:** demo-login route (one-click, ไม่ต้องกรอก) + public-AI rate-limit fail-closed [backend → security gate]
- [ ] รัน seed-demo 2 รอบ + commit seed
- [ ] test demo-login e2e (ต้องมี tenant subdomain context — ดู `src/proxy.ts` `{slug}.localhost`)
- [ ] Dev: provision `ANTHROPIC_API_KEY` + Anthropic org spend cap · แก้ `layout.tsx` metadata ("Create Next App") · footer dead anchors (defer 30b)

## Next Session
### เริ่มต้นด้วย
1. อ่าน `.claude/project-plan.md` + memory `ai-assist-phase29`, `phase28-deferred-hardening`
2. `git log --oneline -1` = `ba203d3` · `git status` เช็ค seed uncommitted
3. รัน `npx tsx prisma/seed-demo.ts` **2 รอบ** verify idempotent → commit ถ้าผ่าน
4. ตรวจ ⚠️ + Working state ก่อน delegate Slice D backend

### Slice D backend (delegate)
- `backend`: demo-login route ที่ login demo agent ด้วย creds จาก `@/lib/demo` (reuse logic `api/auth/agent/login`) + public-AI rate-limit **fail-closed** (Redis error → deny). file scope: route ใหม่ + `src/lib/rate-limit.ts`
- `security` gate: ยืนยัน fail-closed + demo creds จำกัด AGENT + ไม่มี cross-tenant leak + AI หลัง auth
- หลังเสร็จ: merge `phase-30/portfolio-demo` → main (`--no-ff`), อัปเดต `project-plan.md` Phase 30 row

## References
- Master plan: `.claude/project-plan.md` · Landing spec: `.claude/landing-outline.md`
- Handoff ก่อนหน้า: `.claude/handoffs/phase-29-ai-assist-2026-06-20.md`
- Login pattern: `src/app/api/auth/agent/login/route.ts` · Tenant resolution: `src/proxy.ts`
