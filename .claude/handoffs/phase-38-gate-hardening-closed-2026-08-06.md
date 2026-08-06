# Handoff: Phase 38 — Post-merge Gate Hardening (**ปิดครบแล้ว**) + Phase 36 ปิด gate
Date: 2026-08-06
Next focus: **Phase 39 — P2 (readiness ที่ probe provider จริง) + P3 (observable fail-soft)**

## Git State
Base branch: `main` — local = remote = **`e750f17`** (verify แล้วด้วย `git ls-remote origin main`)

| Phase | Branch | Status | Merged |
|-------|--------|--------|--------|
| 36 | `feature/phase-36-outbound-webhooks` | ✅ **ปิด gate แล้ว** (ตารางหลักฐาน 8/9 + known gap) | ✅ `af79bff` |
| 37 | `feature/phase-37-demo-personas` | ✅ ปิดครบ (Gate 1+2) | ✅ `68ad2e1` |
| 38 | `feature/phase-38-gate-hardening` | ✅ **ปิดครบ** — ค้าง (ก) และ (ข) ปิดหมดแล้ว | ✅ `1eafba3` |

Working state:
- Uncommitted: **ไม่มี (clean)**
- Env/process ค้าง: **ไม่มี** (ไม่มี migration ในเฟสนี้ · ไม่ได้แตะ schema)
- ⚠️ **prod เปลี่ยนไป 2 อย่างในเซสชันนี้** (ไม่ใช่โค้ด): Vercel env `QSTASH_URL` (Prod+Preview) ·
  QStash schedule `scd_6JnXmVttr2Nyt3d4dyd5yKRskkT3`

⚠️ ต้อง verify ก่อนเริ่ม context ถัดไป: **ไม่มีของค้าง** — ทุกข้อของ Phase 38 ปิดด้วยหลักฐานแล้ว

## Carried Forward
### Decisions
- **`QSTASH_URL` = `https://qstash-us-east-1.upstash.io`** — บัญชี Upstash อยู่ `us-east-1` แต่ SDK default ไป EU
  ⛔ **ห้ามใช้ `QSTASH_REGION`** (migration mode) — override token ที่โค้ดส่งเข้า `new Client({token})` ทิ้ง
- **ไม่แตะ signing key** — `GET /v2/keys` พิสูจน์แล้วว่าตรง · **paste secret ด้วยมือ = failure mode เดียวกับที่ทำให้เกิดเคสนี้**
  และทำให้ `401` แยกไม่ออกว่า "คีย์ผิด" หรือ "paste พลาด" → ตัวแปรเดียว = attribution สะอาด
- **cron `*/5`** ไม่ใช่ `*/3` — quota Free 1,000/วัน · retry นับด้วย · `*/3` พังต่อเนื่อง = 1,920 msg/วัน
- **ห้ามรวบ env หลายตัวใน redeploy รอบเดียว** — *เอาของที่ยังไม่ verify ไปปนกับของที่ verify แล้ว = ทำลายสัญญาณของ verify*
- **known gap ต้องระบุขอบเขตให้แคบที่สุดที่ยังจริง** — gap ที่เขียนกว้างเกินกลายเป็นข้อมูลผิดอีกแบบ
  (เคสจริง: near-breach probabilistic **แต่ breach ยิง 100% เสมอ** — ห้ามเขียนรวมว่า "SLA ไม่น่าเชื่อถือ")

### Constraints & Guardrails (ยังบังคับใช้)
- 🔴 **`.env` เครื่อง = Supabase/Upstash ชุดเดียวกับ prod** → ⛔ ห้าม seed/migrate/write จาก local
  · `QSTASH_URL` ใน `.env` ถูก **comment ไว้โดยตั้งใจ** (เปิด = local publish เข้า QStash prod ได้จริง)
- 🆕 **หลักฐานที่ผูก FK `onDelete: Cascade` ต้องบันทึกออกนอก DB ก่อนเก็บกวาดเสมอ** (`CLAUDE.md` § Post-merge gate)
- 🆕 **`interval ≤ 0.2 × window สั้นสุด`** ก่อนเปลี่ยน cron ของ sla-sweep (`docs/operations.md`)
- **Vercel env ทุกตัวติดแท็ก Sensitive = write-only อ่านค่ากลับไม่ได้** → verify ได้ทาง **runtime probe เท่านั้น**
- `git push` = งานของ Dev เท่านั้น (hook บล็อก)

### Artifacts
- `.claude/specs/phase-38-qstash-region-incident-2026-08-06.md` — **incident snapshot + test fixture ของ P2**
  (§1 สภาพตอนระบบตาย · §3 root cause · §8 decisions · §9 ผลการแก้ · §10 schedule + ตัวเลข quota)
- `.claude/specs/phase-38-webhooks-flag-runbook.md` §5.0 — **ตารางหลักฐาน Phase 36 ที่กรอกครบ**
- `CLAUDE.md` · `docs/operations.md` · `docs/deploy-checklist.md` — ปิดช่องที่ทำให้เกิดเคสนี้

## Don't Retry
- **อย่าเช็คว่า "env มีค่าไหม" แล้วสรุปว่าผ่าน** — เคสนี้ env ทุกตัวที่รู้จักมีค่าครบและถูกต้อง ระบบยังตายสนิท
  ตัวแปรที่ผิดคือ **ตัวที่ไม่มีอยู่และไม่มีใครรู้ว่าต้องมี** → gate ที่ enumerate ตัวแปรที่รู้จักจับไม่ได้เลย
- **อย่าใช้ status code ของ API เป็นหลักฐานว่า delivery สำเร็จ** — `201`+`201` เคยดูเหมือนผ่านทั้งที่ตายสนิท
  เกณฑ์ต้องเป็น `WebhookDelivery.status = SUCCEEDED` ใน DB
- **อย่าเทียบ build ข้าม host ด้วย static chunk** — `proxy.ts` redirect ทุก path บน `*.vercel.app` รวม `/_next/static/*`
- **อย่าอ่าน timestamp ผ่าน `node-pg` ตรง ๆ** — คอลัมน์เป็น `timestamp without time zone` → เลื่อนตาม TZ เครื่อง
  ใช้ `"createdAt"::text` · **ระบบไม่ได้เพี้ยน อย่าไปไล่แก้โค้ด**
- **อย่าใช้ `project.updatedAt` ของ Vercel เป็นหลักฐานว่า env ติด/ไม่ติด deployment** — แยกสมมติฐานไม่ออก
- **อย่าให้ password ผ่าน argv** (`printf` ใน process substitution) — ใช้ heredoc + `--data @-` ตาม runbook §3

## Session Summary
### เสร็จแล้ว
- **QStash region mismatch แก้จบ** — root cause = `QSTASH_URL` ไม่เคยถูกตั้ง (SDK default → EU)
  · แก้ด้วย env ตัวเดียว ไม่แตะโค้ด · delivery พลิก `PENDING/0/null` → **`SUCCEEDED/1/200`**
- **Phase 36 ปิด gate** — 8/9 แถวผ่านด้วยหลักฐานจริงบน prod · 1 known gap (negative test ทำไม่ได้: acme/globex เป็น `pro` ทั้งคู่)
- **SLA sweep schedule สร้าง + verify 2 ชั้น** — `DELIVERED` + `responseStatus 200` = signature verify ผ่านบน route ที่สอง
- **ปิดช่องกันเกิดซ้ำ** — `QSTASH_URL` เข้า deploy-checklist · กฎ FK cascade · สูตร cron

### ⚠️ handoff รอบก่อน (`phase-38-gate-hardening-merged-2026-08-05.md`) เขียนผิด 3 จุด — **อย่าเชื่อไฟล์นั้น**
1. ❌ *"ออก `QSTASH_TOKEN` ใหม่"* — token เดิมถูกต้อง 100% (ได้ `200` ที่ endpoint US)
2. ❌ *"ต้องเปลี่ยน signing key ให้เป็นชุดเดียวกับ token"* — ตรงอยู่แล้ว พิสูจน์ด้วย `GET /v2/keys`
3. ❌ *"`QSTASH_TARGET_BASE_URL` อาจยังเป็น `{slug}` template"* — เป็น URL จริงอยู่แล้ว

### ค้างอยู่ / Backlog
- [ ] 🔴 **ไม่มีการเฝ้า QStash quota** — sweep พังต่อเนื่องที่ `*/5` = **1,152 msg/วัน เกินโควตา 1,000**
      → publish ตายเงียบ → ลาก webhooks + email ตายตาม (**failure class เดียวกับที่เพิ่งแก้ แต่หายากกว่าเพราะเคยทำงาน**)
- [ ] 🔴 **`EMAIL_PROVIDER` ไม่มีบน Vercel** — outbound email อาจยังตายอีกชั้น · เริ่มที่ *"ตัดสินว่าจะใช้ provider ไหน"* ไม่ใช่ *"ตั้ง env"*
- [ ] **ไม่มี sweep เก็บ `WebhookDelivery` ที่ค้าง `PENDING`** (ตอนนี้ 0 แถว แต่กลไกยังไม่มี)
- [ ] **near-breach เป็น per-ticket scheduling แทน polling** — ที่ `*/5` URGENT ยิง ~60% · แก้ด้วย cron ไม่ได้ (design)
- [ ] 🔴 **sla-sweep ไม่มี per-tenant checkpoint** — วนทุก tenant ใน invocation เดียว ถ้าชน Vercel timeout
      จะ**ตายกลางทาง** → tenant หลังจุดนั้นไม่เคยถูก sweep และ **retry เริ่มจาก tenant แรกใหม่ทุกครั้ง**
      ⇒ **tenant ท้าย ๆ ไม่มีวันถึง** · มองเห็นทางเดียวคือ QStash DLQ ซึ่ง**ไม่มีใครเฝ้า + retention 3 วัน**
      · baseline วันนี้: **27 วินาที / 2 tenant** (`ACTIVE → DELIVERED` 2026-08-06T15:30) — ยังห่างเพดาน
      แต่ **จะชน timeout ก่อนชนโควตา** เมื่อ tenant โต · **วันนี้ไม่เจ็บ โตแล้วเจ็บแบบเงียบ**
- [ ] backlog เดิมที่ยังอยู่: session เพิกถอนไม่ได้ (JWT ไร้สถานะ) · ไม่มี password-reset route · `globex` ไม่มี OWNER/ADMIN

## Next Session
### เริ่มต้นด้วย
1. อ่าน `.claude/project-plan.md`
2. `git log --oneline main` verify ว่า `e750f17` อยู่จริง
3. อ่าน `.claude/specs/phase-38-qstash-region-incident-2026-08-06.md` — **วัตถุดิบหลักของ P2**
   ⏰ §10 มีหลักฐานที่ QStash log จะหมดอายุ **2026-08-09** (เอกสารเป็นบันทึกเดียวที่เหลือหลังจากนั้น)

### Phase ถัดไป
- **Phase 39: P2 + P3** → branch `feature/phase-39-server-env-readiness` จาก main
  - **P2** = readiness สำหรับ **server-side resource เท่านั้น** (⛔ ห้ามมี key ของ `NEXT_PUBLIC_*`)
    🔴 **เกณฑ์ตัดสิน P2:** ถ้า P2 รันกับสภาพใน incident §1 แล้วได้ **PASS** = ออกแบบใหม่
    🔴 **ต้อง probe provider จริง** — เป็น *ทางเดียวที่เหลือ* ไม่ใช่ทางเลือกที่ดีที่สุด (Vercel Sensitive อ่านค่าไม่ได้)
    · prototype ที่พิสูจน์แล้วในเซสชันนี้: `GET {QSTASH_URL}/v2/schedules` + `GET /v2/keys`
  - **P3** = observable fail-soft (`data-presence-state` ให้ smoke assert ว่า "ต่อจริง")
  - ⚠️ ทำ P2 แล้วต้องกลับไปอัปเดตแถว "server env / provider" ใน `CLAUDE.md` § Post-merge gate
- **Residual จาก Phase 38 ที่ยังไม่ปิด:** บั๊ก presence 4 ชั้น — ปิดแล้วชั้น 2 (client env) + ชั้น 4 (CSP)
  **ชั้น 3 (`SUPABASE_REALTIME_JWT_PRIVATE_KEY`/`KID` = server env) ยังไม่มี assertion** ← P2 ต้องปิดข้อนี้

## References
- Master plan: `.claude/project-plan.md`
- **Design brief สำหรับ Claude Design (Phase 39):** `.claude/specs/phase-39-design-brief-2026-08-06.md`
  — self-contained · มีเกณฑ์ตัดสิน §8 + ทางที่ถูกปฏิเสธแล้ว §7 (ห้ามเสนอซ้ำ)
- Incident snapshot (วัตถุดิบ P2): `.claude/specs/phase-38-qstash-region-incident-2026-08-06.md`
- Runbook + ตารางหลักฐาน Phase 36: `.claude/specs/phase-38-webhooks-flag-runbook.md` §5.0
- Handoff ก่อนหน้า: `.claude/handoffs/phase-38-gate-hardening-merged-2026-08-05.md` ⚠️ **มีข้อมูลผิด 3 จุด — ดู § Session Summary**
- ข้อเสนอตั้งต้น P1a–P7: `.claude/specs/post-merge-gate-external-resource-proposal.md`
