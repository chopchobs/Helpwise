# Handoff: Phase 39 — Server-env Readiness (P2) · **merged · P2 live บน prod**
Date: 2026-08-09
Next focus: **§H-12 ทาง A** (`deployment_status` → re-dispatch) **+ assertion** — แบบอนุมัติแล้ว **ยังไม่เขียนโค้ด**

> 📌 **ไฟล์นี้เป็น pointer อย่างเดียว** — ห้ามคัดเนื้อจาก erratum / runbook มาสรุปซ้ำ
> และ **ห้ามเดินงานต่อจากสรุปในไฟล์นี้** · ต้องการรายละเอียดเมื่อไร **เปิดต้นทางเสมอ**
> (เฟสนี้โดนบทเรียนนั้น **2 ครั้ง** — ดู Don't Retry ข้อแรก)

---

## Git State

Base branch: **`main` = `b1b572b`** — ⚠️ **แก้ 2026-08-10:** ตอนเขียนไฟล์นี้ base คือ `585ae53` (PR #17)
แต่คอมมิตเอกสาร 3 ตัวด้านล่างตามเข้า `main` แล้วที่ `b1b572b` ⇒ **base ปัจจุบัน = `b1b572b`**
(`585ae53` ยังถูกต้องในฐานะ *"PR #17 merge ที่คอมมิตไหน"* — อย่าแก้จุดนั้น)
remote branch `feature/phase-39-server-env-readiness` **ถูกลบแล้ว** · **local branch ยังอยู่**

| Phase | Branch | Status | Merged |
|-------|--------|--------|--------|
| 39 | `feature/phase-39-server-env-readiness` (local เท่านั้น) | 🟡 merge แล้ว · **ปิด gate ยังไม่ครบ** | ✅ `585ae53` |

Working state:
- Uncommitted/WIP: **ไม่มี (clean)**
- Env/process ที่เปิดค้าง: **ไม่มี**

### ✅ **ปิดแล้ว 2026-08-10** (เดิม: 🔴 ต้อง resolve ก่อนอย่างอื่น) — **3 commit เอกสารไม่ได้ถูก merge เข้า PR #17**

> ✅ **แก้ไปแล้ว:** `b1b572b` (parent เดียว = `585ae53`) นำเนื้อของทั้งสามคอมมิตเข้า `main`
> · verify: `git diff --stat main feature/phase-39-server-env-readiness` → **ว่าง** ⇒ tree เหมือนกันทุกไฟล์
> · `git log main..feature/…` ยังขึ้น 4 commit เพราะเป็น squash **ไม่ใช่ merge จริง** ⇒ ประวัติต่างกัน แต่ **เนื้อหาไม่ต่าง**
> ⇒ **ไม่ต้อง cherry-pick / ไม่ต้องเปิด PR ใหม่** · local branch เหลือค่าแค่ประวัติ
>
> ข้อความเดิมเก็บไว้ด้านล่างเพื่อให้อ่านออกว่าเคยกลัวอะไร:


```
ce331fd [AP] ปิดแบบ §H-12       ← แบบของงานถัดไปทั้งหมด
a7614a3 [AO] ตัดสิน §H-12 ทาง A
0af454c [AN] §G ข้อ 15+16 + §H-5 ERRATUM
```
verify: `git log --oneline origin/main..feature/phase-39-server-env-readiness` → **3 commit** (เอกสารล้วน ไม่มีโค้ด)

> ⛔ **เนื้อหาของงาน session ถัดไป (§H-12) อยู่ในสาม commit นี้เท่านั้น — บน `main` ไม่มี**
> ⇒ ถ้าเริ่มจาก `main` เปล่า ๆ จะไม่เจอแบบที่อนุมัติแล้ว **แล้วออกแบบใหม่ทับของเดิม**
> ⇒ **Dev ตัดสินก่อน:** เปิด PR ใหม่ / cherry-pick เข้า main / ทำงานต่อบน local branch เดิม

⚠️ verify ก่อนเริ่ม:
- [x] `git log --oneline -1 main` → ต้องได้ **`b1b572b`** *(แก้ 2026-08-10 จาก `585ae53`)*
- [x] 3 commit ข้างบนถูกจัดการแล้วหรือยัง → **จัดการแล้ว** (ดูกล่อง ✅ ด้านบน)

---

## 🔴 เตือนก่อนแตะอะไรทั้งสิ้น — **§G ข้อ 9 มีผลจริงแล้ว**

**prod live แล้ว** ⇒ `ReadinessState` / `MechanismHeartbeat` เป็นแถวที่ **ระบบจริงใช้อยู่** และ
`DATABASE_URL` เป็นแถวเดียว *"Production and Preview"*

⇒ **การซ้อมลำดับ 7 ครั้งต่อไปจะเขียนทับสถานะของ production จริง**
⇒ ⛔ **ห้าม dispatch rehearsal ก่อนอ่าน erratum §G ข้อ 9 + rehearsal runbook ขั้น C0-a / F4**
(ตอนซ้อมรอบก่อน blast radius = 0 เพราะ route ยังไม่อยู่บน main — **เงื่อนไขนั้นหมดไปแล้ว**)

---

## Carried Forward

### Decisions (ห้ามรื้อ)
- **§H-12 = งานแรกของ session ถัดไป · ทาง A อนุมัติแล้ว**
  · **B ตก** — repo variable เขียนด้วย `GITHUB_TOKEN` ไม่ได้ ⇒ ต้องใช้ **PAT** = credential ที่หมดอายุเงียบได้
    ⇒ **สร้าง failure mode คลาสเดียวกับที่กำลังแก้** (B เก็บไว้เป็นทางเลือก Phase 40 ถ้าจะย้าย state ออกนอก GitHub)
  · **C ตก** — ยอมรับความเงียบถาวร (แก้เอกสาร ไม่ได้แก้พฤติกรรม)
- **กฎในแบบ (ห้ามตัดออกข้อใดข้อหนึ่ง)** — รายละเอียดครบที่ **erratum §H-12**:
  dispatcher **ห้ามรอผล** + **concurrency group แยก** (2 ชั้นอิสระ) · verify *"มี run ถูกสร้าง"* = **poll มีเพดาน**
  (ไม่ใช่รอจนจบ) · assertion ใช้ **REST API** + retry มีเพดาน (⛔ ไม่ใช้ `actions/cache/restore` — ผู้ตรวจต้องไม่ใช่
  ชิ้นส่วนเดียวกับผู้ถูกตรวจ)
- **ลำดับ 6: ปลายทางแจ้งเตือน ⛔ ห้ามเป็น Discord** — ลำดับ 5 ใช้ไปแล้ว (`SLACK_WEBHOOK_URL` ชี้ Discord) · **แนะนำอีเมล**

ตัดสินก่อนหน้าที่ยังมีผล → erratum **§A** · **§H-1…H-12**

### Constraints & Guardrails
- **§F** = เช็คลิสต์ + gate ทั้งหมด · **ต้องขยายขอบเขต**ให้ครอบ *"ทุกสเต็ปใน workflow ของ P2 ที่ขึ้นเขียวได้โดยไม่ได้ทำงาน"*
- **`CLAUDE.md` § Post-merge gate** — ตารางหลักฐานยังไม่ครบ (ดูด้านล่าง)

### Artifacts
| path | คืออะไร |
|---|---|
| `.claude/specs/phase-39-closing-evidence-2026-08-09.md` | **ตารางหลักฐานปิดเฟส** — เริ่มที่นี่ |
| `.claude/specs/phase-39-design-doc-v2.1-errata-2026-08-08.md` | §E/§F/§G/§H — **§H-12 = แบบของงานถัดไป** |
| `.claude/specs/phase-39-rehearsal-runbook.md` · `phase-39-pinger-runbook.md` | ลำดับ 7 · ลำดับ 6 |
| `.claude/specs/backlog-2026-08-08.md` | B-1…B-10 (**B-1 = งานแรกของ Phase 40**) |

---

## Don't Retry
- 🔴 **เชื่อประโยคจากเอกสารโดยไม่เปิดต้นทาง** — เฟสนี้โดน **2 ครั้ง**: *"ยังไม่ push"* (เท็จ) และ
  *"verify บน prod"* (ไม่ใช่ถ้อยคำของ §F) ⇒ **verify ทีละประโยค** · ครั้งหลัง **CC และ reviewer พลาดพร้อมกัน
  เพราะอ่านจากสำเนาเดียวกัน** ⇒ การตรวจซ้ำจากสำเนาไม่ช่วย (§H-9)
- 🔴 **"สเต็ปเขียว = สเต็ปทำงาน"** — `cache save` ขึ้นเขียวโดยไม่เขียนอะไร · **ครั้งที่ 3 ของคลาสเดียวกันในวันเดียว**
  (§H-4 · §H-8 · §G ข้อ 16)
- **ดึง env ของ Vercel ผ่าน MCP** — ทำไม่ได้ · เป็นงานมือเท่านั้น
- **กด `workflow_dispatch` ของ workflow ที่ยังไม่อยู่บน default branch** — GitHub register เฉพาะบน default branch
- **`prisma migrate dev` / `npm test` เปล่า ๆ จากเครื่อง dev** — `.env` ชี้ prod (B-1) ⇒ ใช้ **`DIRECT_URL= npm test`**
  (⚠️ **workaround ไม่ใช่ guard** — ลืมพิมพ์ = เขียน prod เงียบ ๆ)

---

## Session Summary

### เสร็จแล้ว
- **Phase 39 merge เข้า main** (`585ae53`) · **P2 ทำงานจริงบน prod** — `verdict=OK` · `http 200` ·
  `lastCheckAt 2026-08-09T16:03:49.423Z` ⇒ QStash/Redis/heartbeat/counter ปกติทั้งหมด
- **หลักฐานคำต่อคำ** (ทั้งหมดอยู่ในตารางหลักฐานปิดเฟส — ไม่ทำซ้ำที่นี่):
  · C1 migration `20260808000000` · `finished_at 08:49:06Z` · `rolled_back_at NULL` · 2 ตาราง
  · เศษเทสต์ 6 ตาราง `like 'xtfk\_%'` = **0**
  · ลำดับ 7: **E1 = `PROVEN`** (`http 503` + signature `eu-central-1`) · **F3 = `INVALID`** (คืนสภาพสำเร็จ)
  · `MechanismHeartbeat` เคลียร์ก่อน merge: 1 แถว → **0 rows**
  · post-merge: **Discord alert เข้าจริง** (`FAIL` · post-deploy) · run #8 = `OK`
  · `readiness-probe.expectedIntervalSeconds` = **900** บน prod ⇒ **§G ข้อ 13 มีผลจริง**

### ค้างอยู่ — ตารางหลักฐานปิดเฟส: **11 แถวมีผล · 7 ว่าง · F = N/A**

| แถว | ติดอะไร |
|---|---|
| **H** ความจำข้ามทริกเกอร์ | 🟢 **พร้อมทำ = งานถัดไป** (§H-12 ทาง A) |
| **I** assertion | 🟢 **พร้อมทำ ทำคู่กับ H** |
| **A** workflow dispatch ของลำดับ 7 | 🟢 พร้อมทำ (อยู่บน main แล้ว) — ⛔ **แต่ต้องอ่านคำเตือน §G ข้อ 9 ก่อน** |
| **D** smoke บน prod | 🟢 พร้อมทำ |
| **E** cron รอบแรกเขียนทับ `ReadinessState` | 🟢 พร้อมตรวจ |
| **G** เห็นข้อความจริงในห้อง Discord | 🔴 **ยังว่าง** — closing-evidence แถว G = ⬜ (ตรวจ 2026-08-10) · *"น่าจะปิดได้แล้ว"* ในฉบับก่อนเป็น **การอนุมานจาก session summary ไม่ใช่หลักฐาน** ⇒ ต้อง **เปิดห้องดูข้อความของ `verdictHeadline()` จริง** ก่อนติ๊ก |
| **C** ลำดับ 6 pinger | 🔴 **ติดที่ Dev** — เลือกบริการ + ตั้ง monitor · ⛔ ห้ามใช้ Discord |

---

## Next Session

### เริ่มต้นด้วย
1. อ่าน `.claude/project-plan.md` (Phase 39 อัปเดตแล้ว)
2. `git log --oneline -1 main` → ต้องได้ **`b1b572b`** *(แก้ 2026-08-10)* · 3 commit เอกสาร **ตามเข้า main แล้ว**
3. อ่าน `phase-39-closing-evidence-2026-08-09.md` → รู้ว่าเหลืออะไร
4. อ่าน **erratum §H-12** → แบบที่อนุมัติแล้ว **ทำตาม ไม่ต้องออกแบบใหม่**
5. ⛔ อ่าน **§G ข้อ 9** ก่อนคิดจะ dispatch rehearsal

### งาน
**ไม่ใช่ Phase 40** — ยังเป็นการปิด gate ของ Phase 39
⇒ implement **§H-12** (job `dispatch` แยก · inputs `mode`/`expected_sha` · `permissions: actions: write` ·
concurrency 2 ชั้น · verify run ถูกสร้าง · assertion ผ่าน `gh api …/actions/caches`) แล้วปิดแถว **H + I**
· **Phase 40 เริ่มหลังปิด gate ครบ** — งานแรกคือ **backlog B-1**

---

## References
- Master plan: `.claude/project-plan.md`
- ตารางหลักฐานปิดเฟส: `.claude/specs/phase-39-closing-evidence-2026-08-09.md`
- Handoff ก่อนหน้า: `.claude/handoffs/phase-39-server-env-readiness-2026-08-08.md`
- Backlog: `.claude/specs/backlog-2026-08-08.md`
