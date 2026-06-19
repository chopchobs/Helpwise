# Handoff: Phase 28 — Async Queue (QStash) + Notifications
Date: 2026-06-19
Next focus: **Phase 28 Slice 3 — SLA near-breach + breach notification ผ่าน QStash schedule** (slice สุดท้ายของ Phase 28)

## Git State
Base branch: main (commit: `2e827b4` — มี project-plan.md แล้ว)
Working branch: `phase-28/async-queue-notifications` (HEAD `9a0cfb1`) — **ยังไม่ merge, ยังไม่ push**

| Slice | สาระ | Commit | Status |
|-------|------|--------|--------|
| 1 | QStash outbound email queue | `bfb0ef4` | ✅ done, gated |
| 2 | in-app notification (assign) | `9a0cfb1` | ✅ done, gated |
| 3 | SLA near-breach + breach notify | — | ⏳ ยังไม่เริ่ม (next focus) |

Working state: **clean** (ไม่มี uncommitted). ไม่มี process/migration ค้างรัน
- stray (iCloud): empty dirs `src/app/api/tags/[id] 2`, `.../tags/[tagId] 2`, `.git/index 2` — git ignore (empty/.git) ไม่กระทบ build/commit; ลบทีละไฟล์ได้ถ้ารำคาญ (อย่า `rm -rf` — hook block)

⚠️ ต้อง verify ก่อนเริ่ม context ถัดไป:
- [ ] Dev จะ **push** branch + **apply migration** `20260619000000_add_notification` เอง — เช็คว่าทำหรือยัง
- [ ] **`RLS_ENABLED` ต้องเปิดให้ตรงกับตอน apply migration** (Notification = FORCE RLS) ไม่งั้น query คืน 0 แถว (devops coordination)
- [ ] Dev provision QSTASH env (Slice 1): `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `QSTASH_TARGET_BASE_URL` (ตัวหลัง = canonical origin เดียวกับที่ publish — ผิด = jobs reject หมด)

## Carried Forward
### Decisions
- Queue = **Upstash QStash** (ไม่ใช่ BullMQ) — fit Vercel serverless; CLAUDE.md stack note แก้แล้ว (commit bfb0ef4)
- Notification: recipient = `TenantMember` (agent), FORCE RLS ตาม Tag precedent, scope `memberId` (recipient-only)
- `createNotification(db, {...})` ใน `src/lib/notifications.ts` — **Slice 3 ต้อง reuse ตัวนี้** (db = tenantPrisma scoped)

### Constraints & Guardrails (verbatim)
- Worker route รันนอก middleware → tenantId จาก **verified payload** เท่านั้น → `tenantPrisma()` ทุก query; verify signature **fail-closed บน prod**; idempotent (atomic claim)
- notification = **agent-audience only** ห้ามหลุด portal; recipient เห็นเฉพาะของตัวเอง
- กฎเต็ม → `CLAUDE.md` (Multi-tenancy / Audiences / SLA / Audit). มาตรฐานโค้ด → `~/.claude/coding-standards.md`

### Artifacts
- `src/lib/queue.ts` — QStash publish + verify (URL pin = `getWorkerTargetUrl()`)
- `src/app/api/jobs/send-email/route.ts` — worker pattern (verify→tenant-scope→claim→send→rollback) ← **Slice 3 worker ใช้ pattern เดียวกัน**
- `src/app/api/jobs/sla-sweep/route.ts` — มีอยู่แล้ว; Slice 3 = แปลง trigger เป็น QStash schedule + เพิ่ม near-breach 80% + emit notification (ปิด TODO ที่ `sla-sweep:204`)
- deferred items ทั้งหมด → memory `phase28-deferred-hardening` (MEDIUM-2 outbound-eligibility guard = priority สูงสุด; stale-notification; fire-and-forget log)

## Don't Retry
- **Nonce CSP** กับ proxy.ts — infeasible (memory `nonce-csp-infeasible`)
- **BullMQ worker บน Vercel** — ตัดทิ้งแล้ว (serverless รัน persistent worker ไม่ได้) → ใช้ QStash
- **`tenantPrisma` ใน `$transaction`** — extension ไม่ compose; ใน tx ใส่ tenantId เองทุก where/data
- **create ผ่าน tenantPrisma ด้วย `tenant:{connect}`** — Prisma reject; ใช้ scalar `tenantId`

## Session Summary
### เสร็จแล้ว
- Reconstruct `project-plan.md` (Phase 01–27) — commit `2e827b4` บน main
- Phase 28 Slice 1 (QStash email) + Slice 2 (notification) — gated (security+qa PASS), 488 tests, บน branch phase-28

### ค้างอยู่ / Open Questions
- [ ] Slice 3 ยังไม่เริ่ม (next focus)
- [ ] notification real-time/polling — ตอนนี้ fetch ตอน mount เท่านั้น (frontend เปิดเป็น open question, defer)
- [ ] Phase 28 hardening pass (deferred items) ก่อน go-live

## Next Session
### เริ่มต้นด้วย
1. อ่าน `.claude/project-plan.md`
2. `git log --oneline main` + `git log --oneline main..phase-28/async-queue-notifications` verify state
3. ตรวจ ⚠️ ด้านบน (push/migrate/RLS/QSTASH env) ก่อนเริ่ม Slice 3
4. อ่าน memory `phase28-deferred-hardening`

### Slice 3 (ปิด Phase 28)
- บน branch `phase-28/async-queue-notifications` เดิม (ต่อจาก `9a0cfb1`)
- backend: แปลง `sla-sweep` trigger → QStash schedule + near-breach 80% threshold + emit `Notification` ต่อ ticket (reuse `createNotification`, เพิ่ม `NotificationType` SLA values ผ่าน migration) — ปิด TODO `sla-sweep:204`
- gate: near-breach idempotent (ยิงครั้งเดียว), notification tenant/recipient scope, `hasFeature(sla_policies)` gate warning
- หลัง Slice 3 ผ่าน gate → merge phase-28 เข้า main + อัปเดต project-plan.md (เพิ่มแถว Phase 28)

## References
- Master plan: `.claude/project-plan.md`
- Deferred/constraints: memory `phase28-deferred-hardening`, `MEMORY.md`
- Handoff ก่อนหน้า: ไม่มี (นี่คือ handoff แรกของ project)
