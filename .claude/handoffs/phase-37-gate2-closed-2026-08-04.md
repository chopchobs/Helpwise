# Handoff: Phase 37 — Gate 2 ปิดครบ (demo personas)
Date: 2026-08-04
Next focus: **Phase 38 — post-merge gate hardening (P1a / P6a / P7) + เปิด FeatureFlag `webhooks`**

## Git State
Base branch: `main` (commit **`7f6d055`**) · push แล้ว (`main...origin/main` ไม่มี ahead/behind)

| Phase | Branch | Status | Merged |
|-------|--------|--------|--------|
| 37 | `feature/phase-37-demo-personas` | ✅ **ปิดครบ** — Gate 1 + Gate 2 ผ่าน | ✅ `68ad2e1` |
| 38 | (ยังไม่สร้าง) | ⏳ pending | ❌ |

Commit ของ session นี้ (เก่า→ใหม่): `7eec335` run sheet · `47fdf6c` C-5 FAIL ชั้น 1 + proposal ·
**`fd8cb08` fix CSP `connect-src`** · `26ec0c9` Gate 2 ผ่าน · **`7f6d055` fix `/portal` 404**

Working state:
- Uncommitted: `.claude/project-plan.md` (บันทึกผล smoke `/portal/tickets` — commit พร้อม handoff นี้)
- Env/process ค้าง: **ไม่มี** (ไม่มี migration ในเฟสนี้)

⚠️ ต้อง verify ก่อนเริ่ม context ถัดไป:
- [ ] `git log --oneline -1 main` → ควรเป็น `7f6d055` หรือใหม่กว่า
- [ ] Vercel env ที่เพิ่งตั้งรอบนี้ยังอยู่ครบ (`NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY`,
      `SUPABASE_REALTIME_JWT_PRIVATE_KEY`/`KID`) — **ยังไม่มีอะไรบังคับ นี่คือเหตุผลของ P1a**

## Carried Forward
### Decisions
- **`/portal` 404 แก้เป็น hotfix แยก ไม่ผูกกับ P7** — P7 = กลไกป้องกันที่ต้องออกแบบ · บั๊กนี้ทำร้าย user อยู่จริง
  ผูกกัน = บั๊ก 1 บรรทัดกลายเป็นตัวประกันของงานที่ช้ากว่า (เกณฑ์นี้ใช้ซ้ำได้ทุกครั้งที่เลือก hotfix vs รวมทีเดียว)
- **CSP derive origin จาก env ไม่ใช้ wildcard** — แคบที่สุด แต่ **fail-silent ถ้า env หายตอน build**
  → P1a กลายเป็น **คู่บังคับ** ของ fix นี้ ไม่ใช่ optional
- **`owner@acme.test`: ใช้ "ทาง A′"** (update `passwordHash` เอง) — standing risk ปิดในตัว
  เพราะ password ที่ไม่มีใครรู้ ≠ password ที่ไม่มีใครเดาได้

### Constraints & Guardrails (ยังบังคับใช้)
- 🔴 **`.env` เครื่อง dev ใช้ Supabase + Upstash ชุดเดียวกับ prod — ไม่มี local DB แยก**
  → ⛔ ห้าม seed/migrate จาก local · rate limit + cache ใช้ counter ร่วมกับ prod
- **`NEXT_PUBLIC_*` = build-time inlined** → แก้ env แล้ว **ต้อง redeploy** · verify ได้ที่ **artifact เท่านั้น**
  (⛔ ห้ามใช้ readiness endpoint ยืนยัน — จะได้ false PASS)
- R-1: acme/globex public โดยสมบูรณ์ → **ห้ามเอาข้อมูลจริงเข้า 2 tenant นี้**
- กฎเดิมทั้งหมด → `.claude/project-plan.md` § Decisions + § ⚠️ ค้าง

### Artifacts ที่สร้างไปแล้ว
- `.claude/specs/phase-37-gate2-run-sheet.md` — run sheet + **ผลจริงครบ** + 5 จุดที่ spec ไม่ตรงของจริง
- `.claude/specs/post-merge-gate-external-resource-proposal.md` — **P1a→P7 = input ของ Phase 38**
- `next.config.ts` (CSP) · `src/app/(portal)/portal/verify/page.tsx` (redirect)

## Don't Retry
- **อย่าใช้ `/api/health/readiness` (P2) ยืนยัน `NEXT_PUBLIC_*`** — server อ่าน runtime env จะรายงาน
  `configured: true` ทั้งที่ bundle ยังไม่มีค่า = **false PASS ตรงกับ bug class นี้**
- **อย่า assert P1a เฉพาะใน `ci.yml`** — GitHub Actions build ≠ artifact ที่ deploy → ต้องผูกกับ build ของ Vercel
- **อย่าแก้อีเมล contact ชั่วคราวเพื่อขอ magic link บน prod** (เหตุผล 3 ข้อ → run sheet § C-8c)
- **อย่าจด cookie `hw_agent_session` 12 ตัวแรก** — เป็น JWT ขึ้นต้นเหมือนกันหมด = false pass
- **อย่ารัน `prisma/seed-demo.ts` บน prod / จาก local** (project-plan ข้อ 6)

## Session Summary
### เสร็จแล้ว
- **Phase 37 ปิดครบ**: Gate 2 ผ่าน (B-7 P0 ✅ · C-1…C-8 ✅ · C-8c = prod smoke เต็มตัว ไม่มี known gap)
- **presence ทำงานจริงบน prod ครั้งแรก** หลังแก้ 3 ชั้นซ้อน (env client · env JWT · 🔴 CSP = บั๊กโค้ด Phase 35)
  → backlog "smoke presence Phase 35" ปิด · Phase 35 ผ่าน post-merge gate ครบ
- **hotfix `/portal` 404** (ตายตั้งแต่ Phase 3) + smoke prod ผ่าน

### ค้างอยู่ / Open Questions
- [ ] **เปิด FeatureFlag `webhooks`** ให้ tenant — Phase 36 ยัง done-with-open-gate
- [ ] Backlog เดิม: seed-demo hardening (`ticketCounter` เป็น `max()`, `settings` merge, `--dry-run`) ·
      R-2 XFF spoof (pre-existing ระดับ project) · Phase 36 backlog (LOW)
- **Open Q:** Phase 38 เอา P1a-P7 ทั้งชุด หรือเลือกเฉพาะ P4+P1a (ที่ proposal แนะนำถ้าเลือกได้แค่ 2)

## Next Session
### เริ่มต้นด้วย
1. อ่าน `.claude/project-plan.md` (§ ⚠️ ค้าง ข้อ 0 / 7 / 9)
2. อ่าน `.claude/specs/post-merge-gate-external-resource-proposal.md` — **spec ตั้งต้นของ Phase 38**
3. `git log --oneline -1 main` verify = `7f6d055` ขึ้นไป

### Phase ถัดไป
- **Phase 38: post-merge gate hardening** → branch `feature/phase-38-gate-hardening` จาก main
  ลำดับที่ proposal แนะนำ: **P4** (docs, XS) → **P1a** (REQUIRED mode ใน `scan-client-bundle.ts` +
  ผูกกับ build ของ Vercel, `VERCEL_ENV=production` เท่านั้น) → **P5** (gate wording) →
  **P6a** (test `buildCsp()`) → **P7a/P7b** (TODO เทียบ route จริง / พิจารณาเปิด `typedRoutes`)

## References
- Master plan: `.claude/project-plan.md`
- Handoff ก่อนหน้า: `.claude/handoffs/phase-37-demo-personas-2026-08-03.md`
- Decision log Phase 37: `docs/phase-37-decision-log.md`
- Memory: `[[real-domain-gethelpwise-xyz]]`, `[[realtime-messages-rls-supabase]]`, `[[demo-personas-phase37]]`
