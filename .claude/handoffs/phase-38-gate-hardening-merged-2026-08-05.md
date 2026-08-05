# Handoff: Phase 38 — Post-merge Gate Hardening (merged, **ยังปิดไม่ได้**)
Date: 2026-08-05
Next focus: **Phase 39 — P2 (readiness endpoint สำหรับ server-side resource) + P3 (observable fail-soft)**

## Git State
Base branch: `main` (commit **`add3c28`**)

| Phase | Branch | Status | Merged |
|-------|--------|--------|--------|
| 37 | `feature/phase-37-demo-personas` | ✅ ปิดครบ (Gate 1+2) | ✅ `68ad2e1` |
| 36 | `feature/phase-36-outbound-webhooks` | ⏳ done-with-open-gate — smoke prod ยังไม่เคยรัน | ✅ `af79bff` |
| 38 | `feature/phase-38-gate-hardening` | ⏳ **merged แต่ปิดไม่ได้** — ค้าง 2 อย่างที่ต้องใช้คนรัน | ✅ `1eafba3` |

Commit ของ session นี้ (เก่า→ใหม่): `8b4501a` P1a/P4/P5/P6a · `457e40b` review fixes ·
`c72b6df` runbook ทาง A · `1eafba3` merge · `add3c28` project-plan

Working state:
- Uncommitted: ไม่มี (clean)
- Env/process ค้าง: ไม่มี (ไม่มี migration ในเฟสนี้ · ไม่ได้แตะ DB)

⚠️ ต้อง verify ก่อนเริ่ม context ถัดไป:
- [x] ✅ **push แล้ว (Dev รันจาก Terminal จริง) — `origin/main` = `58c83d5`** ยืนยันด้วย `git ls-remote origin main`
      · Vercel deploy จาก `58c83d5` = **Ready · Production (live จริง)**
- [x] ✅ **ค้าง (ก) ปิดแล้ว 2026-08-05** — ดู § ตารางหลักฐาน Phase 38
- [ ] ค้าง (ข): smoke webhooks ตาม `.claude/specs/phase-38-webhooks-flag-runbook.md`

## ตารางหลักฐาน Phase 38 (ตามรูปแบบ `CLAUDE.md` § Post-merge gate)

| resource | วิธีตรวจบน prod | ผลที่ได้ |
|---|---|---|
| **gate ถูกเรียกจริงบน Vercel** | อ่าน build log ของ deploy `58c83d5` (Production · Ready · 1m 5s · 2026-08-05) | ✅ **VERIFIED** — พบบรรทัด `✅ [scan:bundle] สะอาด — … และยืนยัน 2 ค่า …` · ไม่มี `GATE OVERRIDDEN` |
| client env (`NEXT_PUBLIC_*`) | clause ในบรรทัดเดียวกัน | ✅ ยืนยัน **2 ค่า** (`SUPABASE_URL` + `ANON_KEY`) — ตรงตามที่ตั้งใจหลังย้าย `ROOT_DOMAIN` เป็น advisory |
| Vercel Dashboard override | Dev เปิด Project Settings ดูเอง | ✅ Override **ปิดทั้ง 4 ช่อง** → `vercel.json` มีผลจริง |
| FeatureFlag `webhooks` (Phase 36) | smoke ตาม runbook ทาง A | ⏳ **ยังไม่ทำ** = ค้าง (ข) |

> 🏁 **`58c83d5` คือครั้งแรกที่ gate รันจริงบน Vercel** — ก่อนหน้านี้ `vercel.json` `buildCommand: "next build"`
> override `package.json` อยู่ → `scan:bundle` ไม่เคยถูกเรียกในสาย build ของ production เลย

## Carried Forward
### Decisions
- **webhooks ปิด gate ด้วย "ทาง A" (smoke อย่างเดียว ไม่แตะ DB)** — เส้นทางที่ลูกค้าเดินจริงคือ
  `plan → x-tenant-plan (Redis) → hasFeature()`. ใส่ `TenantFeature` override = พิสูจน์คนละชั้นกับที่ค่าถูกใช้จริง
  (ละเมิดกฎที่ `457e40b` เพิ่งเขียนลง `CLAUDE.md`) + แลกด้วย deviation `audit.log()` + override ที่ค้างตลอดไป
  → **ห้ามย้อนกลับไปทำทาง B** เหตุผลเต็มอยู่ใน runbook § 0
- **ROOT_DOMAIN = advisory ไม่ใช่หลักฐาน** — มี fallback ฝังใน source → assertion ที่ fail ไม่ได้เลย
  = แถวเขียวปลอม ซึ่งแย่กว่าไม่มีแถว (สร้างความมั่นใจปลอม)
- **escape hatch ต้องเป็นกลไกในโค้ด ไม่ใช่คำแนะนำในเอกสาร** — "แก้ไฟล์ชั่วคราวแล้ว revert" คนจะลืม revert
  = เสีย gate ถาวรแบบเงียบ (failure mode เดียวกับ TODO ของ `/portal`)

### Constraints & Guardrails (ยังบังคับใช้)
- 🔴 **`.env` เครื่อง dev = Supabase/Upstash ชุดเดียวกับ prod** → ⛔ ห้าม seed/migrate/write จาก local
- **`NEXT_PUBLIC_*` = build-time inlined** → แก้ env แล้วต้อง **redeploy** · verify ที่ **artifact เท่านั้น**
- ⛔ **ห้าม infer สถานะ prod จาก `seed-demo.ts`** — `Tenant.plan` จริงบน prod ยังไม่มีใครยืนยัน
  (runbook § 2-2 คือ query ที่ตอบข้อนี้) · seed ห้ามรันบน prod
- R-1: acme/globex public โดยสมบูรณ์ → ห้ามเอาข้อมูลจริงเข้า 2 tenant นี้
- `git push` = งานของ Dev เท่านั้น (hook บล็อก)

### Artifacts ที่สร้างไปแล้ว
- `scripts/scan-client-bundle.ts` — REQUIRED mode + advisory + `SCAN_BUNDLE_SKIP_REQUIRED`
- `src/lib/csp.ts` + `src/lib/__tests__/csp.test.ts` — 12 tests กัน CSP regression (รวม 1024 tests)
- `vercel.json` / `package.json` — `buildCommand: "npm run build"` → `next build && npm run scan:bundle`
- `CLAUDE.md` § Post-merge gate — ตารางหลักฐาน 5 แถว (แทน checkbox ของเจตนา)
- `.claude/specs/phase-38-webhooks-flag-runbook.md` — runbook read-only ล้วน (504 บรรทัด)

## Don't Retry
- **อย่าใช้ readiness/health endpoint ยืนยัน `NEXT_PUBLIC_*`** — server อ่าน runtime env → false PASS
- **อย่า assert P1a เฉพาะใน `ci.yml`** — CI build ≠ artifact ที่ deploy
- **อย่าผูก gate ไว้ที่ `package.json` `build` อย่างเดียว** — `vercel.json buildCommand` override ได้
  (และ Vercel Dashboard override `vercel.json` ได้อีกชั้น — Dev ยืนยันแล้วว่า Override ปิดทั้ง 4 ช่อง)
- **อย่าใช้ปุ่ม demo login smoke webhooks** — demo persona = `AGENT` → ได้ `FORBIDDEN` เสมอ ไม่เกี่ยวกับ flag
- **อย่าเปลี่ยน plan ของ tenant ใดเพื่อทำ negative test** — ถ้าไม่มี tenant ที่ plan < `pro` ให้บันทึก known gap (runbook § 5.3)
- **อย่าพยายาม `git push` เอง — Claude Code ทำไม่ได้ทุกทาง** (ทั้ง tool call และโหมด `!`)
  hook `~/.claude/hooks/block-dangerous-git.sh` บล็อกที่ชั้น PreToolUse → **Dev ต้องรันจาก Terminal จริงเสมอ**
  (hook จับที่ข้อความคำสั่งด้วย — commit message ที่มีคำว่า push ก็โดนบล็อก)
  · หลัง Dev push แล้วให้ verify ด้วย `git ls-remote origin main` ไม่ใช่เชื่อคำบอก

## Session Summary
### เสร็จแล้ว
- **Phase 38 merged (`1eafba3`)** — P1a/P4/P5/P6a + review fixes · tsc clean · lint 0 error · 1024 tests · build ผ่าน
- **ของจริงของเฟสนี้: เจอว่า `vercel.json buildCommand` override `package.json`** → ถ้าไม่เจอ P1a ทั้งก้อน
  จะเป็นงานตกแต่งที่ไม่เคยรันบน Vercel เลย

### ค้างอยู่ / Open Questions
- [x] ✅ **(ก) ปิดแล้ว** — deploy `58c83d5` ผ่านเกณฑ์ครบ (ดู § ตารางหลักฐาน Phase 38)
- [ ] **(ข) smoke webhooks ทาง A** → ปิด gate ของ **Phase 36** ด้วย
- [ ] **Residual gap — ห้ามเข้าใจว่า Phase 38 ปิดครบ:** บั๊ก presence มี **4 ชั้น** · Phase 38 ปิดแค่
      **ชั้น 2 (client env)** + **ชั้น 4 (CSP)** · **ชั้น 3 (`SUPABASE_REALTIME_JWT_PRIVATE_KEY`/`KID`
      = server env) ยังไม่มี assertion อัตโนมัติ** — P4 ใส่ docs แล้วก็จริงแต่ **docs ไม่ใช่ gate**
- [ ] **Backlog:** test ที่ assert grep string (`✅ [scan:bundle] สะอาด …` / `GATE OVERRIDDEN`) ในตัว script
      กัน drift กับเอกสาร 3 ไฟล์ · P1b build-time guard (ปิดช่อง advisory ของ ROOT_DOMAIN) ·
      demo reset ไม่ล้าง `WebhookEndpoint` (follow-up · จะเป็น blocker ถ้า demo persona ได้ OWNER/ADMIN) ·
      seed-demo hardening · R-2 XFF spoof

### 📌 Case study ของ P5 (บทเรียนถาวร — เหตุผลที่ gate เปลี่ยนเป็นตารางหลักฐาน)
เอกสารที่ไม่เคยถูกเอาไปเทียบกับ prod ผิดได้ **ทั้งสองทิศ**:
- **Phase 37** = *"เขียนว่าผ่านทั้งที่ยังไม่ตรวจ"* (RLS/presence ที่ไม่เคยทำงาน)
- **Phase 36** = *"เขียนว่ายังไม่ทำทั้งที่ทำไปแล้ว"* — บันทึกว่า FeatureFlag `webhooks` ยังไม่เปิด
  ทั้งที่ migration `20260722010000` ผูก `requiredPlan='pro'` ไปแล้วและ demo tenant เป็น `pro`
→ รากเดียวกัน: **checkbox ของเจตนา ไม่ใช่ของหลักฐาน**

## Next Session
### เริ่มต้นด้วย
1. `git ls-remote origin main` — **verify ว่า commit ของ Phase 38 ขึ้น remote จริงหรือยัง** (ห้ามเชื่อว่า push แล้ว)
2. อ่าน `.claude/project-plan.md` (§ ⚠️ ค้าง ข้อ 11 = pointer มาที่ไฟล์นี้)
3. เช็คผลค้าง (ก) + (ข) ก่อน — **Phase 38 + Phase 36 ยังปิดไม่ได้จนกว่าทั้งสองผ่าน**

### Phase ถัดไป
- **Phase 39: P2 + P3** → branch `feature/phase-39-server-env-readiness` จาก main
  - **P2** = `GET /api/health/readiness` สำหรับ **server-side resource เท่านั้น** (⛔ ห้ามมี key ของ `NEXT_PUBLIC_*`)
    — ปิดชั้น 3 ที่ยังไม่มี assertion
  - **P3** = observable fail-soft (`data-presence-state` ให้ smoke assert ได้ว่า "ต่อจริง" ไม่ใช่แค่ "หน้าไม่พัง")
  - ⚠️ ถ้าทำ P2 แล้ว ต้องกลับไปอัปเดตแถว "server env / provider" ใน `CLAUDE.md` § Post-merge gate
    (ตอนนี้เขียนแบบไม่อ้าง endpoint เพราะยังไม่มีจริง)

## References
- Master plan: `.claude/project-plan.md`
- Handoff ก่อนหน้า: `.claude/handoffs/phase-37-gate2-closed-2026-08-04.md`
- ข้อเสนอตั้งต้น P1a–P7: `.claude/specs/post-merge-gate-external-resource-proposal.md`
- Runbook ปิด gate Phase 36: `.claude/specs/phase-38-webhooks-flag-runbook.md`
- Memory: `[[vercel-build-command-override]]`, `[[build-time-env-verify-at-artifact]]`, `[[local-env-shares-prod-infra]]`
