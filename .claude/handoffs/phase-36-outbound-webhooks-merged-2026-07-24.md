# Handoff: Phase 36 — Outbound Webhooks (merged) + Realtime RLS recovery
Date: 2026-07-24
Next focus: **helpwise-phase36-merged-realtime-rls-live-on-prod** — ยืนยัน realtime presence live บน prod จริง (Phase 35 ไม่เคย active), ปิด migration recovery, แล้วเลือก Phase ถัดไป

## Git State
Base branch: main (HEAD: `d5b2d9b`) — **ahead of origin/main 1 commit (ต้อง push)**
Phase 36 merged เข้า main แล้ว (PR #16, merge commit `af79bff`)

| Phase | Branch | Status | Merged |
|-------|--------|--------|--------|
| 36 | feature/phase-36-outbound-webhooks | ✅ done (security PASS, docs อังกฤษ) | ✅ PR #16 `af79bff` |

Working state:
- Uncommitted: **ไม่มี (clean)**
- Commit ค้าง push: `d5b2d9b` (docs plan) + `6dafbef` (fix realtime migration) — Dev รัน `!git push origin main` เอง (hook block Claudy)
- Verified: 830 tests pass · `tsc` 0 error (กรอง `.next/types/* 2.ts` iCloud) · build สำเร็จ · main CI เขียว

⚠️ ต้อง verify ก่อนเริ่ม context ถัดไป:
- [ ] `git rev-list --count origin/main..main` = 0 (ยืนยัน push แล้ว — ตอน handoff = 1)
- [ ] **prod migration apply สำเร็จจริง** — query `_prisma_migrations`: 4 ตัวล่าสุด `finished_at` ไม่ null (ห้ามเชื่อ `migrate status` เพราะ failed migration หายจาก pending list)
- [ ] **realtime presence live** — `pg_policies` บน `realtime.messages` = **2 แถว** (ตอน handoff = 0 = feature dead) + smoke 2 เบราว์เซอร์

## Carried Forward
### Decisions
- **Prisma migration ถือกรรมสิทธิ์เฉพาะ schema `public`** — `realtime`/`storage`/`auth` แตะได้แค่ระดับ policy; **ห้ามใส่ `ALTER TABLE realtime.messages enable RLS`** (owner=`supabase_realtime_admin` → 42501). ถอดออกแล้ว commit `6dafbef`. รายละเอียด → memory `[[realtime-messages-rls-supabase]]`
- webhooks decisions เดิม (path แยก inbound, `await dispatch`, secret plaintext by-design, SSRF 2 ชั้น) → handoff เดิม + `[[outbound-webhooks-phase36]]` ยังมีผลครบ

### Constraints & Guardrails
- MEDIUM ปิดก่อน merge: rate-limit (replay 30/5นาที `failClosed`, create 20/ชม.) + cap `MAX_ENDPOINTS_PER_TENANT=10` (create-check + fan-out `take`+`orderBy createdAt asc`) + RLS migration `20260723000000_webhooks_rls`
- **`migrate status` เชื่อไม่ได้เมื่อมี failed migration** — query `_prisma_migrations` ตรง ๆ ดู `finished_at`/`rolled_back_at`

### Artifacts
- Phase 36 code/docs/migration → PR #16 diff + `docs/webhooks.md` (อังกฤษ 600 บรรทัด) + `20260723000000_webhooks_rls`
- แก้ realtime migration: `prisma/migrations/20260721000000_realtime_presence_rls/migration.sql` (เหลือแต่ create policy)

## Don't Retry
- **`ALTER TABLE realtime.messages enable row level security`** — 42501 owner ไม่ใช่ postgres; RLS เปิด default อยู่แล้ว อย่าใส่กลับ
- **`migrate resolve --applied` ให้ realtime migration** — SQL ยังไม่ถูก apply จริง (0 policy) ต้อง `--rolled-back` แล้วให้ Prisma รันไฟล์ที่แก้แล้ว
- webhooks Don't-Retry เดิม (path `/api/webhooks/[id]`, `void dispatch`, สร้าง in-memory engine ใหม่, SSRF 26 vector) → handoff เดิม ยังมีผล

## Session Summary
### เสร็จแล้ว
- Phase 36 ปิดครบ: security gate PASS (MEDIUM-1 rate-limit/cap + MEDIUM-2 RLS ปิด, LOW `orderBy` ปิด) · docs แปลอังกฤษ · merge PR #16 · CI เขียว
- ค้นพบ+เริ่มแก้: **Phase 35 realtime presence ไม่เคยทำงานบน prod** (0 policy บน realtime.messages) — แก้ migration แล้ว รอ apply

### ค้างอยู่ / Open Questions
- [ ] **Dev รัน migration recovery ให้จบ** (คำสั่งเต็มอยู่ในบทสนทนา session นี้): probe DIRECT_URL → `migrate resolve --rolled-back 20260721000000_realtime_presence_rls` → `npm run db:deploy` → verify 2 policy + smoke presence
- [ ] **เปิด FeatureFlag `webhooks`** ให้ tenant ที่ต้องการ (default false, requiredPlan pro) — ไม่เปิด = dispatcher เงียบ
- [ ] Backlog Phase 36 (LOW audit-url/payload-retention/route-rate-limit · doc bug `http_5xx`→`http_<status>` · error code ใหม่ยังไม่ใน docs + UI ไม่ handle 409/429) → บันทึกใน `.claude/handoffs/phase-36-outbound-webhooks-2026-07-22.md` § Backlog
- **Open Q:** เพิ่ม post-merge "verify migration apply บน prod จริง" เข้า DoD ไหม (Phase 35 ผ่านทุก gate ทั้งที่ feature dead — gate ตรวจแค่ code+mock DB) — รอ Dev ตัดสิน

## Next Session
### เริ่มต้นด้วย
1. อ่าน `.claude/project-plan.md` (§ ⚠️ ค้าง ข้อ 0 = migration recovery)
2. `git log --oneline main` + `git rev-list --count origin/main..main` verify push
3. ตรวจ ⚠️ 3 ข้อด้านบน (push · migration finished_at · 2 policy) ก่อนเริ่มงานใหม่

### Phase ถัดไป
- ยังไม่เลือก — Portfolio #1 fuzz / #2 webhooks / #3 realtime ทำครบแล้ว. เสนอ options จาก project-plan backlog ให้ Dev เลือก

## References
- Master plan: `.claude/project-plan.md`
- Handoff ก่อนหน้า: `.claude/handoffs/phase-36-outbound-webhooks-2026-07-22.md` (มี Backlog เต็ม + decisions webhooks)
- Memory: `[[realtime-messages-rls-supabase]]`, `[[outbound-webhooks-phase36]]`, `[[rls-hardening-phase27]]`
