# Handoff: Phase 28 — Async Queue (QStash) + Notifications [COMPLETE]
Date: 2026-06-19
Next focus: **หลัง Phase 28 — deploy ที่ค้าง (migrations / QStash env / cron schedule) + เลือก Phase 29**

## Git State
Base branch: `main` — **ahead of origin 7 commits, ยังไม่ push** (Dev push เอง)
- Phase 28 merge commit: `915a4b3` (`Merge branch 'phase-28/async-queue-notifications'`)
- main HEAD: `f7330f4` (docs: record merge hash)
- Phase 28 ครบ 3 slice merged เข้า main (local) → ดูตาราง Phase ใน `.claude/project-plan.md` (เพิ่มแถว 28 แล้ว)

Working state: **clean** (no uncommitted, ไม่มี process/migration ค้างรัน)
- stray (iCloud): empty dirs `src/app/api/tags/[id] 2` ฯลฯ — git ignore, ไม่กระทบ build

⚠️ ต้อง verify ก่อนเริ่ม context ถัดไป:
- [ ] Dev **push main** แล้วหรือยัง (`git status -sb` → ahead 0 = pushed)
- [ ] **Deploy Phase 28 ยังไม่ทำ** (Dev สั่งทำทีหลัง — ดู Open Questions)

## Carried Forward
### Decisions (รายละเอียดเต็ม → `project-plan.md` § Decisions)
- Queue = **Upstash QStash** (ไม่ใช่ BullMQ); sla-sweep เลิกใช้ `SLA_SWEEP_SECRET` → QStash signature verify
- Notification = agent-audience (TenantMember recipient, FORCE RLS)

### Constraints & Guardrails (ยังบังคับ — เต็มใน `CLAUDE.md`)
- Worker route นอก middleware → tenantId จาก **verified source** → `tenantPrisma()` ทุก query; verify fail-closed บน prod; idempotent (atomic claim)
- **RLS_ENABLED default = false** — เปิดพร้อม migrate prod เท่านั้น

### Artifacts (Phase 28 — diff/commit ดู `git show`)
- `src/lib/queue.ts` · `src/lib/notifications.ts` · `src/app/api/jobs/{send-email,sla-sweep}/route.ts` · `src/app/api/notifications/` · `src/types/notification.ts`
- migrations: `20260619000000_add_notification`, `20260619010000_add_sla_notification`
- **Deferred hardening ทั้งหมด → memory `phase28-deferred-hardening`** (send-email outbound-eligibility guard = priority สูงสุด; ห้ามหาย)

## Don't Retry (เต็ม → memory)
- Nonce CSP กับ proxy.ts — infeasible (`nonce-csp-infeasible`)
- BullMQ worker บน Vercel — serverless รัน persistent worker ไม่ได้ → QStash
- `tenantPrisma` ใน `$transaction` — extension ไม่ compose; ใส่ tenantId เองใน tx
- create ผ่าน tenantPrisma ด้วย `tenant:{connect}` — Prisma reject; ใช้ scalar `tenantId`

## Session Summary
### เสร็จแล้ว
- Phase 28 Slice 3 (commit `baeccbc`): sla-sweep → QStash schedule + per-tenant loop + near-breach 80% (gate `hasFeature`) + notification + breach AuditLog. gate security PASS + qa PASS. **vitest 501 pass, tsc clean** (verify บน main แล้ว)
- Merge `--no-ff` Phase 28 เข้า main + อัปเดต `project-plan.md`

### ค้างอยู่ / Open Questions
- [ ] **Deploy Phase 28 (Dev):** apply 2 migrations (`add_notification`, `add_sla_notification`) · provision QStash env (`QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `QSTASH_TARGET_BASE_URL`) · ตั้ง QStash **cron schedule** ยิง `/api/jobs/sla-sweep` · ลบ env `SLA_SWEEP_SECRET`
- [ ] **เลือก Phase 29** — ยังไม่กำหนด (ถาม Dev). ตัวเลือกที่ค้าง: Phase 28 **hardening pass** (เก็บ deferred จาก memory ก่อน go-live) · notification real-time/polling (frontend, defer ไว้) · feature ใหม่
- [ ] FLAKY: full vitest เคยเจอ 1 failed/500 ครั้งเดียวใน ~12 รอบ, ไม่ reproduce, ไม่ใช่เทส sla-sweep — เฝ้าดู (ใน memory)

## Next Session
### เริ่มต้นด้วย
1. อ่าน `.claude/project-plan.md` + memory `phase28-deferred-hardening`
2. `git log --merges --oneline main` verify เห็น `915a4b3 ... phase-28` + `git status -sb` เช็ค push แล้วหรือยัง
3. ตรวจ ⚠️ + Open Questions ก่อนเริ่ม

### Phase ถัดไป
- ถาม Dev เลือก Phase 29 ก่อน (ดูตัวเลือกใน Open Questions). ถ้าเลือกแล้ว → branch `phase-29/<name>` จาก main (หลัง Dev push)
- **แนะนำ:** ทำ hardening pass (เก็บ deferred Phase 28) เป็น Phase 29 ก่อน feature ใหม่ — เป็นหนี้ที่ค้างก่อน go-live

## References
- Master plan: `.claude/project-plan.md`
- Deferred/constraints: memory `phase28-deferred-hardening`, `MEMORY.md`
- Handoff ก่อนหน้า: `.claude/handoffs/phase-28-async-queue-notifications-2026-06-19.md` (mid-phase, Slice 1-2)
