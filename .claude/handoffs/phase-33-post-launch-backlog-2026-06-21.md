# Handoff: Phase 33 — Post-Launch Backlog
Date: 2026-06-21
Next focus: Deferred backlog (dev รอบหน้า) — เลือก slice จากรายการด้านล่าง ไม่มี blocker

## Git State
Base branch: main (commit: `0ca4e5b`) — **pushed clean** (local == origin/main)
| Phase | Branch | Status | Merged |
|-------|--------|--------|--------|
| 31 | feature/phase-31 production-deploy | ✅ done | ✅ |
| 32 | deploy-verify | ✅ done | ✅ |
| 33 | (this) post-launch — demo CTA fix | ✅ done | ✅ (ff → main `0ca4e5b`) |

Working state:
- Uncommitted/WIP: ไม่มี (clean). ลบ iCloud stray `src/lib/demo-url 2.ts` แล้ว (ดู memory `icloud-stray-duplicates`)
- Env/process เปิดค้าง: ไม่มี — deploy live เสร็จสมบูรณ์

⚠️ ต้อง verify ก่อนเริ่ม context ถัดไป:
- [ ] `git log --oneline -1 origin/main` = `0ca4e5b` (ยืนยัน push)
- [ ] `find src prisma -name "* 2.*"` = ว่าง (iCloud dup เป็นระยะ — ลบก่อน build)

## Carried Forward (ยังมีผล)
### Decisions
- Prod root domain = **gethelpwise.xyz** (ดู memory `real-domain-gethelpwise-xyz`). Vercel env ใช้ `.xyz`. test fixtures/demo emails คง `helpwise.com` ไว้ตั้งใจ — อย่าแก้
- Landing (`src/app/page.tsx`) render ที่ `/` ของ **ทุก host** รวม tenant subdomain → กลายเป็น dynamic (`ƒ`) หลัง fix demo CTA. ถ้าแตะ landing ต่อ ให้รู้ว่ามัน per-host แล้ว
- demo CTA tenant-aware ผ่าน `resolveDemoUrl()` (อ่าน Host): subdomain → relative `/demo`; root/localhost/reserved → `DEMO_URL` (acme fallback)
- `NEXT_PUBLIC_SIGNIN_URL` ถอดออกจาก Vercel แล้ว (fallback `/signin` ในโค้ดถูก — อย่า re-introduce env override)

### Constraints & Guardrails
- กฎเดิมทั้งหมดใน `CLAUDE.md` ยังบังคับ: tenant isolation, internal-note PUBLIC filter, audience guard, money `Int`, webhook idempotent+signature, `hasFeature()` ไม่ hardcode plan, `git push` Claudy ทำเองไม่ได้ (hook block → Dev push)

### Artifacts session นี้
- `src/lib/demo-url.ts` — server helper `resolveDemoUrl()` (commit `0ca4e5b`)
- Prod live: Supabase (migrate+seed+seed-demo), Vercel deploy, wildcard DNS+SSL (`*.gethelpwise.xyz`)

## Don't Retry
- **nonce CSP กับ proxy.ts** — ไม่ทำงาน (Next ไม่ inject nonce เข้า script ผ่าน proxy) ดู memory `nonce-csp-infeasible`. คง `unsafe-inline`
- **absolute URL จาก Host ในปุ่ม demo** — เสี่ยง open-redirect/host-injection. ใช้ relative `/demo` บน subdomain เท่านั้น

## Session Summary
### เสร็จแล้ว
- **Deploy end-to-end live + verified:** gethelpwise.xyz, acme/globex แยก tenant จริง (branding + data + 6-7 tickets), AI assist ทำงาน. Supabase migrate+seed, Vercel, wildcard DNS+SSL
- **Domain swap** → gethelpwise.xyz (จาก placeholder helpwise.com)
- **Bug fix 2 จุด:** demo CTA tenant-aware (`0ca4e5b`) + ลบ env `NEXT_PUBLIC_SIGNIN_URL` (Dev ทำใน Vercel)

### Open Questions
- ไม่มี blocker — backlog ทั้งหมดเป็น enhancement/hardening เลือกทำได้อิสระ

## Next Session — Deferred Backlog (เลือก slice)
1. **globex-on-root** — ทางเข้า globex บน root landing (Hero โฆษณา "acme & globex" แต่ root มีปุ่มเดียว→acme). Design: 2 ปุ่ม / dropdown / workspace cards (ถาม Dev เลือก)
2. **email outbound** — ImprovMX + Postmark domain verify
3. **email inbound** — MX แยก subdomain
4. **RLS activation** — non-bypassrls role + cross-tenant DB test + load-test (ปัจจุบัน `RLS_ENABLED` default off, ดู memory `rls-hardening-phase27`)
5. **regex migrate 3 จุด** → `@/lib/slug` (proxy / inbound / signup-route) — ดู memory `slug-canonical-helper` (drift debt, ไม่ใช่ blocker)
6. **phase28-hardening** — MEDIUM-2 worker outbound-eligibility guard + trust-model doc (ดู memory `phase28-deferred-hardening`)

### เริ่มต้นด้วย
1. อ่าน `.claude/project-plan.md`
2. `git log --oneline main` verify state
3. ตรวจ ⚠️ + iCloud stray ด้านบนก่อนเริ่ม
4. เลือก backlog slice → branch `feature/phase-34-<name>` จาก main

## References
- Master plan: `.claude/project-plan.md`
- Handoff ก่อนหน้า: `.claude/handoffs/phase-32-deploy-verify-2026-06-21.md`
- Memory index: `memory/MEMORY.md` (deferred items อ้างถึง memory แต่ละไฟล์)
