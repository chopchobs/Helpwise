# Handoff: Phase 35 — Real-time Presence/Collision
Date: 2026-07-22
Next focus: Dev provision/activate realtime บน Supabase (2 ข้อค้าง) → เลือก Portfolio item ถัดไป (แนวโน้ม #2 outbound webhooks)

## Git State
Base branch: main (HEAD: `10d84fc`)
Phase 35 ทำบน `feature/phase-35-realtime-presence` (5 commits) → **merge เข้า main แล้ว (fast-forward)**

| Phase | Branch | Status | Merged |
|-------|--------|--------|--------|
| 35 | feature/phase-35-realtime-presence | ✅ done (qa PASS-with-conditions) | ✅ (local) |

Commits (main): `ec4047f` RLS migration · `d016d2a` token endpoint · `a34c421` presence hook+UI · `7b05ddb` collision+M-1 hardening · `10d84fc` qa mint-validation test

Working state:
- **main ahead of origin/main by 5 → ⚠️ ยังไม่ push** (hook block `git push` ให้ Claudy — Dev รัน `!git push origin main` เอง)
- Uncommitted: `NATTAPON_Resume_TH.docx` (ไฟล์ส่วนตัว ไม่เกี่ยวงาน **อย่า commit**) + handoff ไฟล์นี้ (commit ได้)
- Env/process: ไม่มีค้าง. migration `20260721000000` (realtime RLS) **ยังไม่ apply ที่ไหนเลย** (ต้อง Supabase branch ก่อน)

⚠️ ต้อง verify ก่อนเริ่ม context ถัดไป:
- [ ] `git status -sb` — คาด main ahead 5 (หรือ in-sync ถ้า Dev push แล้ว)
- [ ] `git log --oneline main` — คาดเห็น 5 commit Phase 35 บนสุด

## Carried Forward
### Decisions
- **Transport = Supabase Realtime** (ไม่เพิ่ม vendor; อยู่ใน stack แล้ว). Presence+Broadcast authorize ผ่าน RLS บน `realtime.messages` **ล้วน** — อิสระจาก app RLS ที่ปิดอยู่ (ยืนยันจาก research spike)
- **JWT = ES256 asymmetric** (EC P-256), TTL 60s, `typ:"JWT"`+`kid` ใน header (supabase-js #553). แยกจาก session `AUTH_SECRET`/HS256 เด็ดขาด
- **Scope = presence + collision เท่านั้น** — **ตัด live message-sync/Postgres-Changes ออก** (Dev เลือก)
- **Defense-in-depth 2 ชั้นตั้งใจ**: RLS `starts_with()`+regex guard ที่ DB (M-1) **และ** `TENANT_ID_FORMAT` validate ที่ mint (app) — อย่าถอดชั้นใดชั้นหนึ่งออก

### Constraints & Guardrails
- Channel topic **เป๊ะ**: `tenant:{tenantId}:ticket:{ticketId}` + `{config:{private:true}}` (ไม่งั้น RLS ไม่ทำงาน)
- token endpoint **ไม่อ่าน body** — tenantId จาก `ctx.tenantId` ล้วน (token = tenant-scoped ไม่ใช่ ticket-scoped)
- presence = **agent-only** (`requireAgent()`), ห้ามโผล่ portal
- Contract = source of truth: `docs/realtime-presence-contract.md`

### Artifacts
- infra: `src/lib/realtime.ts`, `src/app/api/realtime/token/route.ts`, `prisma/migrations/20260721000000_realtime_presence_rls/migration.sql`
- client: `src/lib/supabase-realtime-client.ts`, `src/hooks/useTicketPresence.ts`, `src/components/ui/{PresenceBar,CollisionBanner}.tsx`, integrate ใน `tickets/[id]/page.tsx`
- tests: `realtime/__tests__/token.test.ts`, `hooks/__tests__/useTicketPresence.test.ts`, `ui/__tests__/CollisionBanner.test.ts`, `lib/__tests__/realtime.mint-validation.test.ts`
- Verified: suite **661/661**, tsc 0 error, build ✓, security no High/Critical

## Don't Retry
- **live E2E realtime ในเครื่อง** — ไม่มี Supabase instance; RLS enforcement จริง/token verify จริง ทดสอบได้เฉพาะ staging หลัง provision key (ดู memory `nonce-csp-infeasible` แนว constraint คล้ายกัน)
- **`like` ใน RLS policy** — เปลี่ยนเป็น `starts_with()` แล้ว (M-1) อย่ากลับไป `like` (wildcard injection class)
- **RLS policy subquery ตาราง app** — ห้าม (app RLS ปิด → พฤติกรรมไม่แน่นอนใต้ role authenticated)

## Session Summary
### เสร็จแล้ว
- Portfolio #3: Real-time presence/collision (Supabase Realtime) ครบ 3 slice — infra+client+collision+security hardening. qa verdict **PASS-WITH-CONDITIONS**. merge main แล้ว (รอ push)

### ค้างอยู่ / Open Questions — Dev ต้องทำก่อน enable prod
- [ ] **push main** → `!git push origin main` (blocked สำหรับ Claudy)
- [ ] **รัน migration `20260721000000` บน Supabase branch/copy + E2E** (tenant A join channel tenant B ต้องถูกปฏิเสธ) — provision EC key เสร็จแล้วใน `.env` (ยังไม่ใส่ Vercel)
- [ ] **ปิด "Allow public access"** ใน Supabase Realtime Settings — activation สุดท้ายหลัง E2E ผ่าน (M-2)
- [ ] deferred backlog (non-block): L-2 presence spoof ภายใน tenant · L-3 rate-limit token endpoint · L-4 refresh ~60s (accept)
- [ ] latent bug แยก (จาก Phase 34): `POST /api/v1/tickets` firstMessage ไม่มี author → 500 (ไม่เกี่ยว realtime)

## Next Session
### เริ่มต้นด้วย
1. อ่าน `.claude/project-plan.md` + handoff นี้
2. `git log --oneline main` + `git status -sb` verify Phase 35 merged/pushed
3. ตรวจ Dev เลือก Portfolio item ถัดไปหรือยัง (#2 outbound webhooks = signed+retry+DLQ reuse QStash)

### Phase ถัดไป
- Portfolio item ที่ Dev เลือก → branch `feature/phase-36-<slug>` จาก main

## References
- Master plan: `.claude/project-plan.md` (⚠️ ยังไม่มีแถว Phase 35 — เพิ่มตอนเริ่ม context หน้า)
- Contract: `docs/realtime-presence-contract.md`
- Handoff ก่อนหน้า: `.claude/handoffs/phase-34-tenant-isolation-fuzz-2026-07-21.md`
- Memory: `[[phase34-prod-migration-done]]` (Phase 34 prod ปิดแล้ว อย่า re-flag), `[[rls-hardening-phase27]]` (app RLS ปิด/BYPASSRLS)
