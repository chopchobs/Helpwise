# Handoff: Phase 34 — Tenant-Isolation Fuzz Suite + XT-WRITE-05 Fix
Date: 2026-07-21
Next focus: Portfolio item ตัวถัดไป (#2 outbound webhooks **หรือ** #3 real-time collaboration) — **Dev ยังไม่เลือก** (open question ท้าย session)

## Git State
Base branch: main (commit: `ed77615`)
งานนี้ทำ **บน main โดยตรง ยังไม่ commit** (ไม่ได้แตก feature branch — เป็น portfolio task ไม่ใช่ numbered phase ตาม plan)

Working state:
- **Uncommitted (WIP, clean build):**
  - `M prisma/schema.prisma` — composite tenant FK 4 ตัว + `@@unique([tenantId,id])` ×2
  - `?? prisma/migrations/20260720000000_composite_tenant_fk_isolation/` — migration ใหม่
  - `M src/lib/auth.ts` (+ `M src/lib/__tests__/auth.test.ts`) — map Prisma `P2003`→400 `INVALID_REFERENCE`
  - `?? src/lib/__tests__/isolation/` — fuzz suite ทั้งชุด (threat-model + engine + tests)
  - `?? NATTAPON_Resume_TH.docx` — ไฟล์ส่วนตัว ไม่เกี่ยวงาน อย่า commit
- **Env/process เปิดค้าง:** migration `20260720000000` **apply บน dev DB แล้ว** (ผ่าน `migrate deploy`, guard ผ่าน 0 violation) — **ยังไม่ apply prod**

⚠️ ต้อง verify/resolve ก่อน /clear หรือก่อนเริ่ม context ถัดไป:
- [ ] **Commit งานที่ค้าง** (Dev ยังไม่สั่ง commit) — เสนอแยก 3 commit: schema+migration / auth P2003 / isolation suite
- [ ] **Apply migration บน production** — `prisma migrate deploy` (ยืนยัน env prod = `gethelpwise.xyz` / DIRECT_URL ก่อน) — **ผ่าน dev เท่านั้น ห้าม assume prod ทำแล้ว**
- [ ] ยืนยัน suite เขียว: `npx vitest run` → คาดเห็น **629 pass / 0 fail**

## Carried Forward
### Decisions
- **ปิด XT-WRITE-05 ที่ราก (DB composite FK)** ไม่ harden `tenant.ts` — prod ไม่มี nested write ผ่าน tenantPrisma เลย + guard generic เสี่ยง false-positive กับ JSON field; DB enforcement แข็งกว่าและไม่ขึ้นกับ RLS ที่ปิดอยู่
- ชั้น app = defense-in-depth (verify-before-write ที่มีอยู่แล้ว + P2003→400 mapping) ไม่ใช่ enforcement หลัก

### Constraints & Guardrails (ยังบังคับ)
- **tenantPrisma scope แค่ top-level** → ทุก write **ต้องใช้ scalar FK id ที่ verify tenant แล้ว** (`verifyContactBelongsToTenant`/`verifyAssigneeMembership`) — ห้าม nested `connect`/`create` ที่รับ id จาก client
- **Behavior change:** nullable FK (assignee/author*) `SET NULL`→**`RESTRICT`** → hard-delete `TenantMember`/`Contact` ที่ยังถูก ref จะ throw (ตอนนี้ app soft-delete `isActive` เท่านั้น = ปลอดภัย; path hard-delete ใหม่ต้องระวัง)
- รายละเอียดเต็ม → memory `[[tenantprisma-nested-write-gap]]`

### Artifacts
- `src/lib/__tests__/isolation/threat-model.ts` — 37 attack case / 8 axis (contract, typed) + `THREAT-MODEL.md`
- `src/lib/__tests__/isolation/_engine.ts` — faithful in-memory Prisma mock (โง่เรื่อง tenant scoping, model composite FK) — reusable สำหรับ isolation test อนาคต
- `.../isolation/{tenant-isolation.fuzz,audience,route-isolation,op-coverage,proxy-tenant}.test.ts` — 5 test file
- `.../isolation/composite-fk.integration.test.ts` — real-Postgres (ต้อง `DIRECT_URL`; `skipIf` เมื่อไม่มี DB)

## Don't Retry
- **แก้ `src/lib/tenant.ts` ให้ generic reject nested-write** — เสี่ยง false-positive กับ JSON field (`metadata`/`settings`) โดยไม่เพิ่ม value (prod ไม่มี nested write ผ่านมัน) → ใช้ DB composite FK แทน
- **`prisma migrate dev --create-only`** — Prisma 7 refuse non-interactive; ประกอบ migration จาก `migrate diff` แล้ว `migrate deploy` แทน
- **Integration test อ่าน `DATABASE_URL`** — vitest inject เป็น dummy; ต้องใช้ `DIRECT_URL`

## Session Summary
### เสร็จแล้ว
- Portfolio #1: tenant-isolation fuzz suite (37 case) + ปิด finding **XT-WRITE-05** (cross-tenant FK contamination) ครบ 3 ชั้น (DB composite FK + app P2003→400 + test mirror). Suite 629/629 เขียว, integration 7/7 บน Postgres จริง. Verified โดย Claudy เอง

### ค้าง / Open Questions
- [ ] commit + apply migration prod (ดู ⚠️ ด้านบน)
- [ ] Dev เลือก Portfolio item ถัดไป: **#2 outbound webhooks** (signed+retry+DLQ, reuse QStash) หรือ **#3 real-time** (SSE/Ably, agent-collision)
- [ ] Latent bug แยก: `POST /api/v1/tickets` ส่ง `firstMessage` ไม่มี author → 500 (ไม่เกี่ยว cross-tenant)
- [ ] (optional) provision test DB ใน CI เพื่อ gate ชั้น DB (ตอนนี้ integration `skipIf`)

## Next Session
### เริ่มต้นด้วย
1. อ่าน `.claude/project-plan.md`
2. `git log --oneline main` + `git status` — **คาดว่างาน Phase 34 ยัง uncommitted** (resolve ก่อน)
3. ตรวจ ⚠️ + Working state ด้านบน (โดยเฉพาะ migration prod ยังไม่ apply)

### Phase ถัดไป
- Portfolio #2/#3 (Dev เลือกก่อน) → branch `feature/phase-35-<slug>` จาก main **หลัง commit Phase 34**

## References
- Master plan: `.claude/project-plan.md`
- Analysis ตัวเลือก portfolio (impact/effort table) → อยู่ในบทสนทนา session นี้
- Handoff ก่อนหน้า: `.claude/handoffs/phase-33-post-launch-backlog-2026-06-21.md`
- Memory: `[[tenantprisma-nested-write-gap]]` (finding + fix เต็ม), `[[rls-hardening-phase27]]` (RLS ปิดอยู่)
