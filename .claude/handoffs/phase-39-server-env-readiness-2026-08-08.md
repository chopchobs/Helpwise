# Handoff: Phase 39 — Server-env Readiness (P2)
Date: 2026-08-08
Next focus: **ปลดบล็อกลำดับ 6–7** — งานมือของ Dev บน Vercel/GitHub แล้วปิด post-merge gate

> 📌 **ไฟล์นี้เป็น pointer อย่างเดียว** — ห้ามคัดเนื้อจาก erratum / runbook มาสรุปซ้ำที่นี่
> และ **ห้ามเดินงานต่อจากสรุปในไฟล์นี้** · เหตุผล: `incident §8.3` พังเพราะข้อความถูกคัดข้ามเอกสาร
> แล้วมีคนเดินต่อโดยไม่กลับไปดูต้นทาง (ดู erratum §B) — **ต้องการรายละเอียดเมื่อไร เปิดต้นทางเสมอ**

---

## Git State

Base branch: **main = `7b29db0` = `origin/main`** (sync แล้ว ไม่มีอะไรค้าง push บน main)

| Phase | Branch | Status | Merged |
|-------|--------|--------|--------|
| 39 | `feature/phase-39-server-env-readiness` | 🔄 in progress (**ahead main 19 commits · push แล้ว**) | ❌ |

Working state:
- Uncommitted/WIP: **ไม่มี (clean)**
- Env/process ที่เปิดค้าง: **ไม่มี** — ไม่ได้รัน migration, ไม่ได้แตะ Vercel/GitHub settings

> 🔴 **แก้ 2026-08-09 — ฉบับแรกของไฟล์นี้เขียนผิดสองที่** (ต้นทางอยู่ใน commit message ของ `277be73` เอง):
> · *"ahead 18 commits"* → ของจริง **19**
> · *"ยังไม่ push"* → **push แล้ว** · verify: `git rev-parse feature/…` = `git rev-parse origin/feature/…` = **`277be73`**
>   · Vercel มี Preview deployment **`dpl_584Ys5Vdy6gF6f4dkCERRJBPsEvv`** state **READY** (sha `277be73`, PR #17)
> ⇒ ผลพลอยได้: **runbook ขั้น A1 + A2 ผ่านแล้ว** (ติ๊กพร้อม deployment id เป็นหลักฐานใน rehearsal runbook แล้ว)
> ⇒ บทเรียนของความผิดนี้ → **erratum §H-9** + Don't Retry ด้านล่าง

⚠️ ต้อง verify ก่อนเริ่ม context ถัดไป:
- [ ] §F gate: **ห้าม merge เข้า main จนกว่าลำดับ 4–5 จะ verify บน prod** (ยังไม่มีอะไรขึ้น prod เลย)

---

## ลำดับการอ่านของ session ถัดไป (ห้ามข้าม ห้ามสลับ)

| # | ไฟล์ | อ่านเพื่อ |
|---|---|---|
| 1 | ไฟล์นี้ | สถานะ + สิ่งที่บล็อกอยู่ |
| 2 | `.claude/specs/phase-39-design-doc-v2.1-errata-2026-08-08.md` **§E / §F / §G / §H** | ลำดับงาน · gate · สิ่งที่ยังไม่ครอบ · การเบี่ยงตอน implement |
| 3 | `.claude/specs/phase-39-rehearsal-runbook.md` | **เช็คลิสต์ 19 ข้อของลำดับ 7** — อยู่ที่นั่นทั้งหมด ไม่ทำซ้ำที่นี่ |
| 4 | `.claude/specs/phase-39-pinger-runbook.md` | ลำดับ 6 |

เอกสารอ้างอิงเดิม: brief `phase-39-design-brief-2026-08-06.md` · incident `phase-38-qstash-region-incident-2026-08-06.md` (§8.3 อ่านพร้อม blockquote ERRATUM เสมอ) · v2 `phase-39-design-doc-v2-2026-08-07.md` · **v1 เก็บเป็นประวัติ ห้ามใช้เป็นฐานงาน**

---

## สถานะจริง

**ลำดับ 1–5 เขียนเสร็จ + test ผ่านครบ — แต่ยังไม่มีอะไรขึ้น prod เลยสักอย่าง**
(1123 tests / 62 files · tsc clean · eslint 0 error · build + `scan:bundle` ผ่าน)

| ลำดับ | สถานะ |
|---|---|
| 1–5 | ✅ โค้ด + test เสร็จ · ❌ ยังไม่ verify บน prod |
| 6 | ⏳ บล็อก — รอ Dev เลือกบริการ + ตั้ง monitor |
| 7 | ⏳ บล็อก — รอ **C0** (ดูด้านล่าง) |

### 🚧 ข้อที่บล็อกทุกอย่างอยู่ตอนนี้: **C0 — สองคำถาม ไม่ใช่คำถามเดียว** *(แก้ 2026-08-09)*

> **C0-a:** `DATABASE_URL` ถูก scope แยก Production/Preview หรือใช้ค่าเดียวกัน?
> **C0-b:** 🔴 **`QSTASH_URL` มีกี่แถว scope อะไร** — ตัวที่ขั้น D1 จะไปแตะคือตัวนี้ ไม่ใช่ `DATABASE_URL`
> **ทุกขั้นหลังจากนั้นแตกเป็นสองกรณีตามคำตอบ** — ตารางสองกรณีของทั้งคู่อยู่ที่ rehearsal runbook ขั้น C
> ⛔ ห้ามเดา · ⛔ **ห้ามเสนอทาง Vercel MCP** — ทดสอบแล้ว 2026-08-09: MCP อ่าน env ไม่ได้เลย (ดู Don't Retry)

### ⚠️ คลิกที่อันตรายที่สุด: ขั้น D1 — **เปลี่ยนเป็น "แก้ scope" ไม่ใช่ "Delete" แล้ว** *(2026-08-09)*

เดิม runbook สั่ง **ลบ** `QSTASH_URL` ของ Preview โดย**สมมติเอาเองว่ามีแถว Preview แยกอยู่**
incident §8.1 บันทึกแค่ว่าตั้ง *"Production + Preview"* ซึ่งบน Vercel เป็นได้ทั้ง **2 แถวแยก** และ **1 แถวติ๊กสองช่อง**
⇒ ถ้าเป็นแบบหลัง **กด Delete = ลบของ Production ไปด้วย = สร้าง incident 7 สัปดาห์ขึ้นมาใหม่จริง**
ตอนที่ระบบเตือนยังไม่ merge (ไม่มีอะไรจับให้)

⇒ **D1 ตอนนี้คือ uncheck ช่อง Preview** (reversible — F1 กลายเป็นติ๊กกลับ ไม่ใช่พิมพ์ค่าเดิมใหม่)
⇒ **D0 / D1 / D1b ยังเป็นขั้นบังคับ** และ **D0 ต้องแคปค่าเต็มของ `QSTASH_URL` ด้วย ไม่ใช่แค่รายชื่อตัวแปร**

---

## Carried Forward

### Decisions (ตัดสินรอบนี้ — ห้ามรื้อ)
- **`?staleAfter=` ตกด้วยเหตุผลเชิงหลักการ** — input ที่มีผลต่อคำพิพากษาบน endpoint ที่ไม่ auth (erratum §H-7)
- **ลำดับ 6 ยอมรับ threshold 30 นาที** — คุณค่าของชั้นนอกคือ **อยู่คนละ failure domain** ไม่ใช่ threshold ที่ต่างกัน (§H-7 · §G ข้อ 8)
- **ขั้น C = post-merge gate จริง** ไม่ใช่ prep ของการซ้อม
- **guard 3 ชั้นของ rehearsal** — เซต host ตัดกันเป็นเซตว่าง + predicate มี test ค้ำ + `workflow_dispatch` ต้องพิมพ์ `REHEARSE` (§H-6)
- **เกณฑ์ซ้อม 3 ค่า** `PROVEN` / `INCONCLUSIVE` / `INVALID` — **`status === "FAIL"` ไม่ใช่หลักฐาน**

ตัดสินก่อนหน้าที่ยังมีผล → erratum **§A** (ห้ามรื้อ 5 ข้อ) · **§H-1…H-7** (การเบี่ยงตอน implement)

### Constraints & Guardrails
- **§F** = เช็คลิสต์ implement + gate ทั้งหมด (รวมกฎ "ทุก `catch` ในไฟล์ของ P2 ต้องมีทางออกไปถึงสถานะ")
- **`CLAUDE.md` § Post-merge gate** — ตารางหลักฐาน external resource ยังต้องทำครบทุกแถว

### Artifacts
| path | คืออะไร |
|---|---|
| `src/lib/readiness.ts` · `src/app/api/health/readiness/route.ts` | probe endpoint (ลำดับ 2) |
| `src/lib/inbound-counter.ts` | counter 2 ตัว (ลำดับ 3) |
| `src/lib/heartbeat.ts` · `prisma/migrations/20260808000000_add_readiness_heartbeat/` | heartbeat + state table (ลำดับ 4) — **migration ยังไม่ apply ที่ไหนเลย** |
| `src/lib/readiness-verdict.ts` · `scripts/readiness-check.ts` · `.github/workflows/readiness.yml` | ผู้เฝ้า (ลำดับ 5) |
| `scripts/readiness-rehearsal.ts` · `.github/workflows/readiness-rehearsal.yml` | ซ้อม (ลำดับ 7) — **ยังไม่รัน** |

---

## Don't Retry
- 🔴 **เชื่อประโยคจาก handoff เพราะ verify ประโยคข้าง ๆ ผ่านแล้ว** — **verify ข้อความจาก handoff ทีละประโยค:
  verify ประโยคหนึ่งผ่าน ไม่ทำให้ประโยคข้าง ๆ ในย่อหน้าเดียวกันเชื่อถือได้**
  · เกิดจริง 2026-08-09: verify "18 commits" แล้วแก้เป็น 19 ถูกต้อง แต่หยิบ "ยังไม่ push" จากประโยคเดียวกัน
    มาใช้ต่อโดยไม่ verify (ของจริง push แล้ว · `git rev-parse` สองคำสั่งก็จบ) — **รูปทรงของ §B ซ้ำ ในเซสชันที่มีหน้าที่กันมันเอง**
  · รายละเอียด → erratum **§H-9**
- 🔴 **ดึง environment variables ของ Vercel ผ่าน MCP** — ทดสอบแล้ว 2026-08-09 **ทำไม่ได้**
  `get_project` คืนแค่ `id`/`name`/`framework`/`nodeVersion`/`latestDeployment`/`domains` และชุด tool ทั้งหมด
  **ไม่มีตัวอ่าน env เลยสักตัว** ⇒ **C0-a/C0-b เป็นงานมือของ Dev อย่างเดียว ห้ามเสนอทาง MCP ซ้ำ**
- **ผ่อน `assertProductionHost()` ให้ยิง `*.vercel.app` ได้** — guard นี้เป็นชั้นกัน false-PASS ตัวใหญ่ที่สุด · ทางที่ใช้แทนคือเส้นทาง rehearsal แยก (§H-6)
- **เพิ่ม trigger เข้า `readiness-rehearsal.yml`** — `workflow_dispatch` อย่างเดียวคือชั้นที่ 3 ของ guard
- **เก็บ state ของ workflow ใน `ReadinessState`** — ผู้เฝ้าต้องไม่ใช้ชิ้นส่วนเดียวกับผู้ถูกเฝ้า (§H-5)
- **`prisma migrate dev` จากเครื่อง dev** — `.env` ชี้ prod (backlog B-1) · migration รอบนี้เขียน SQL ด้วยมือ

---

## Session Summary

### เสร็จแล้ว
- **ลำดับ 1–5 ของ erratum §E** — probe endpoint, counter, heartbeat + ย้าย snapshot ไป Postgres, GitHub Actions ผู้เฝ้า
- **ปิด open item §G ข้อ 5** (Deployment Protection confirm) + เพิ่ม **§G ข้อ 7–8** · **§H-1…H-7**
- **เตรียมลำดับ 6–7 ครบ** — script + workflow + runbook 2 ฉบับ (ยังไม่รัน)
- **backlog แยกไฟล์** `.claude/specs/backlog-2026-08-08.md` (B-1, B-2)

### ค้างอยู่ / Open Questions
- [ ] **C0-a** — `DATABASE_URL` แยก scope หรือไม่ (บล็อกทุกอย่าง)
- [ ] **C0-b** — `QSTASH_URL` มีกี่แถว scope อะไร (บล็อกขั้น D — ตัวที่จะไปแตะจริง)
      · **ทำพร้อม D0 ในการเปิดหน้า Environment Variables รอบเดียว**
- [ ] ลำดับ 6 — Dev เลือกบริการ pinger · **ปิดได้แค่บางส่วนก่อน merge** (วิธี B เท่านั้น — pinger runbook ข้อ 5)
- [ ] ลำดับ 7 — เช็คลิสต์ของ rehearsal runbook (A1/A2 ✅ แล้ว · ที่เหลือส่วนใหญ่เป็นงานมือของ Dev)
- [ ] post-merge gate ของเฟส + อัปเดตแถว "server env / provider" ใน `CLAUDE.md`

---

## Next Session

### เริ่มต้นด้วย
1. อ่าน `.claude/project-plan.md`
2. รัน `git log --oneline main` verify ว่า branch ที่บอกว่า merge merge จริง
3. ตรวจ ⚠️ + Working state ด้านบน
4. **ถาม Dev ผล C0 ก่อนวางแผนอะไรทั้งสิ้น**

### Phase ถัดไป
ยังอยู่ **Phase 39** — ปิดลำดับ 6–7 + post-merge gate บน branch เดิม
Phase 40 (P3 + heartbeat per-tenant) เริ่มหลัง Phase 39 merge เท่านั้น

---

## ของค้างนอก Phase 39 (ยกมา ไม่ขยายความที่นี่)
- **backlog B-1** — `.env` เครื่อง dev ชี้ Supabase ตัวเดียวกับ prod · integration test เขียนลง prod ทุกครั้งที่รัน `npm test` · `DIRECT_URL` มาก่อน `TEST_DATABASE_URL` ⇒ ตั้ง env เฉย ๆ ไม่ช่วย
- **backlog B-2** — `prisma migrate deploy` ไม่อยู่ใน build pipeline
- **`EMAIL_PROVIDER`** ยังไม่เลือก provider
- **`src/app/globals.css`** — `--font-sans` เป็น Geist แต่ `body` ทับด้วย Arial · Geist ไม่มี glyph ไทย
  ⚠️ **ลบกฎ `body` เฉย ๆ = ไทยพังกว่าเดิม** ต้องเลือกฟอนต์ไทยก่อน
- **design system doc v0.1** ยังไม่เข้ารีโป

---

## References
- Master plan: `.claude/project-plan.md`
- Handoff ก่อนหน้า: `.claude/handoffs/phase-39-erratum-approved-2026-08-08.md`
- Backlog: `.claude/specs/backlog-2026-08-08.md`
