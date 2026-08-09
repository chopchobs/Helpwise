# Phase 39 ลำดับ 7 — Rehearsal runbook (ซ้อม reproduce incident §2.3 บน Preview)

> ## ✅ **ซ้อมแล้ว 2026-08-09 — ผล `PROVEN`** (ผลเต็ม + ตารางหลักฐาน → ขั้น **E**)
>
> **แต่ยังปิดลำดับ 7 ไม่ได้ — 2 เรื่อง:**
> 1. 🔴 **ตัว workflow ยังไม่เคยถูกรันเลย** — ซ้อมด้วย `npx tsx scripts/readiness-rehearsal.ts` จากเครื่อง
>    (workflow ยังไม่ถูก register เพราะยังไม่ merge) ⇒ **พิสูจน์แล้วเฉพาะ *สคริปต์* ไม่ใช่ *workflow***
>    ⇒ ดู **§2.9 ข้อ W** · erratum §G ข้อ 12
> 2. ⬜ **ขั้น F (คืนสภาพ) ยังไม่ได้ทำ** — ⛔ ห้ามปล่อย Preview ค้างในสภาพพัง
>
> ⚠️ **ข้อเบี่ยงจาก runbook ระหว่างซ้อมจริงมี 4 ข้อ — อ่าน §2.9 ก่อนซ้อมรอบถัดไป**
> (ลำดับจริง D1 มาก่อน C · ต้อง redeploy สองรอบ · ข้อความปิดท้ายสคริปต์ยังเป็นถ้อยคำของทาง B)

---

## 0. ทำไมต้องซ้อม

Phase 38: QStash region เปลี่ยน ⇒ กลไกพื้นหลังตายสนิท **1 เดือน** โดยทุก gate เขียว
ลำดับ 7 พิสูจน์ว่า **probe ที่เพิ่งสร้างจับเคสนั้นได้จริง** — ไม่ใช่แค่ "มี endpoint แล้ว"
ทำซ้ำได้ทุกครั้งที่แก้ดีไซน์ ไม่ใช่ทดสอบครั้งเดียวตอนส่งมอบ

---

## 1. ⛔ เกณฑ์ตัดสิน — อ่านก่อนทำอย่างอื่น

สคริปต์คืน **3 ค่า ไม่ใช่ 2**:

| ผล | ความหมาย | นับเป็นซ้อมผ่านไหม |
| --- | --- | --- |
| `PROVEN` | **`source = live`** · `status = FAIL` **และ** เนื้อ response มี `not found in this region (eu-central-1)` | ✅ ใช่ |
| `INCONCLUSIVE` | อ่าน marker ไม่ได้เลย — ยังไปไม่ถึงโค้ดเรา (bypass token ผิด / Preview ยังไม่ขึ้น) | ❌ **ห้ามนับผ่าน และห้ามนับไม่ผ่าน** |
| `INVALID` | ได้ `FAIL` **แต่ไม่มี error signature ที่คาด** | ❌ **ซ้อมนี้ไม่ได้พิสูจน์อะไร** |

### 🔴 กฎที่ 0 — **ผลนับได้เมื่อ `"source":"live"` เท่านั้น** *(เพิ่ม 2026-08-09 · ใช้กับทั้ง E1 และ F3)*

> **`"source":"stored"` ⇒ `INCONCLUSIVE` เสมอ — ไม่ว่าจะได้ verdict อะไรมาก็ตาม**

**ทำไม:** `buildAuthorizedReport()` มี **min-interval 300 วินาที** — จอง lock ไม่ได้ ⇒ **ไม่ยิง live probe**
⇒ เสิร์ฟ **snapshot เก่าพร้อม `components` ชุดเดิม** (รวม `qstash.detail` ที่มี error signature ติดอยู่)

⇒ **snapshot ที่เก็บไว้พิสูจน์อะไรเกี่ยวกับ deployment ปัจจุบันไม่ได้เลย**
= **ตระกูลเดียวกับกฎ marker ของ §B(ค)** — *มี response ครบถ้วน แต่ไม่ได้คุยกับสิ่งที่คิดว่ากำลังคุยด้วย*
(marker กัน "ไม่ได้คุยกับโค้ดเรา" · กฎนี้กัน "ไม่ได้คุยกับ**สภาพปัจจุบัน**ของโค้ดเรา")

**ผลที่เกิดจริงถ้าไม่มีกฎนี้ — ที่ F3:**
กด F3 ภายใน 5 นาทีหลัง E1 ⇒ ได้ snapshot ของ E1 ที่ยังมี `eu-central-1` ⇒ ตัดสินเป็น `PROVEN`
⇒ **runbook อ่านว่า "ยังไม่ได้คืนจริง" ทั้งที่คืนไปแล้ว**
· ทิศทางของความผิดพลาดคือ **false alarm ไม่ใช่ false pass** (ไล่ครบแล้ว: snapshot ที่ *ไม่มี* signature
  มาจาก live probe หลังคืนสภาพเท่านั้น เพราะ prod ยังไม่มี route และ cron ยังไม่รัน)
· แต่ยังต้องปิด เพราะ **§G ข้อ 10 ยก F3 ขึ้นเป็นหลักฐาน *หลัก* ของการคืนสภาพไปแล้ว**
  (Sensitive ปิดทางเทียบค่า) ⇒ หลักฐานหลักที่อ่านผิดได้ = รับไม่ได้

**ปฏิบัติ:**
- [ ] หลัง E1 **เว้น > 5 นาทีก่อนกด F3** — หรือเปิด body ดูให้แน่ว่า `"source":"live"`
- [ ] ⚠️ **redeploy (F2) ไม่ช่วย** — lock อยู่บน **Redis** (`readiness:live-lock:v1`) ซึ่ง deployment ทุกตัวใช้ร่วมกัน
      ⇒ "เพิ่ง redeploy แล้วน่าจะวัดสด" **เป็นความเข้าใจผิด** · ตัวที่กำหนดคือนาฬิกาของ lock ไม่ใช่อายุของ deployment

⚠️ สคริปต์ **ยังไม่บังคับกฎนี้เอง** — ตอนนี้เป็นกฎที่คนอ่านต้องบังคับ (เหตุผล → erratum §H-10 · backlog **B-7**)

---

> 🔴 **เหตุผลที่ `status === "FAIL"` เฉย ๆ ใช้เป็นเกณฑ์ไม่ได้:**
> ตอนนี้มีอีกหลายทางที่ทำให้ `FAIL` ได้ — **ตารางยังไม่ถูก apply บน DB ที่ Preview ใช้**,
> heartbeat ยังไม่เคยเต้น, `READINESS_PROBE_TOKEN` ไม่ตรง
> ⇒ ถ้ารับ `FAIL` เฉย ๆ เป็นผ่าน เราจะ **"ซ้อมสำเร็จ" โดยไม่ได้ทดสอบอะไรเลย**
> ⇒ ซึ่งเป็น**ความผิดพลาดชนิดเดียวกับที่ทั้งเฟสนี้ป้องกันอยู่** (ตีความ "มีสัญญาณ" ว่า "ถูกต้อง")

---

## 2. เช็คลิสต์ก่อนกดซ้อม — **ทำตามลำดับ ห้ามสลับ**

แต่ละข้อมี "วิธียืนยัน" ที่ทำได้จริง — ✅ ได้ก็ต่อเมื่อยืนยันแล้ว **ไม่ใช่เพราะทำแล้วคิดว่าน่าจะได้**

### ขั้น A — ให้มี Preview ที่มีโค้ดของ Phase 39

- [x] **A1. push branch `feature/phase-39-server-env-readiness` ขึ้น remote** — ✅ **2026-08-09**
      ยืนยัน (รันจริง ไม่ใช่การอ้างจากเอกสาร):
      `git rev-parse feature/phase-39-server-env-readiness` = `git rev-parse origin/feature/…` = **`277be73`**
- [x] **A2. Vercel สร้าง Preview deployment ของ branch นี้แล้ว สถานะ Ready** — ✅ **พิสูจน์แล้วว่ากลไกทำงาน 2026-08-09**

      > 🔑 **A2 คือ "deployment *ล่าสุด* ของ branch นี้" — ไม่ใช่ deployment id ตายตัว**
      > สิ่งที่ A2 พิสูจน์คือ **Vercel สร้าง Preview ให้ branch นี้อัตโนมัติจริง** (ไม่ใช่ว่า id นี้จะใช้ตลอดไป)

      หลักฐาน ณ วันที่พิสูจน์: `dpl_584Ys5Vdy6gF6f4dkCERRJBPsEvv` · READY · sha **`277be73`** · PR #17

      ⚠️ **id นี้จะล้าสมัยทันทีที่ push (A3) และทุกครั้งที่ redeploy (C4 / D2)**
      ⇒ **ทุกครั้งที่จะซ้อม ให้เปิด Vercel → Deployments → หยิบตัวล่าสุดของ branch นี้ใหม่เสมอ**
      แล้วเช็คสองอย่างก่อนใช้:
      - [ ] state = **Ready**
      - [ ] **sha ตรงกับ `git rev-parse HEAD`** — ⛔ ถ้ายังเป็น `277be73` แปลว่า A3 ยังไม่เสร็จ **ห้ามซ้อม**

      ⚠️ **URL เปลี่ยนทุก deployment** — จดใหม่ทุกครั้ง ห้ามใช้ URL ที่จดไว้รอบก่อน
- [x] **A3. push commit ล่าสุด — ขั้นบังคับ ต้องเสร็จ *ก่อน* C4** — ✅ **2026-08-09**
      ทำแล้ว: push ถึง **`c5c17f0`** → Preview ที่ใช้ซ้อมจริงคือ redeploy ของ `c5c17f0`
      (`https://helpwise-fmgvtv0xj-chopchats-projects.vercel.app`)
      ⇒ **ได้โค้ดที่มีการแก้ §H-8 แล้ว** ⇒ ตาราง `[stage]` ของขั้น E2 ใช้ได้จริง
      ⚠️ **ยังเป็นขั้นบังคับสำหรับการซ้อมรอบถัดไปทุกครั้ง** — ตรวจ sha ของ deployment ก่อนใช้เสมอ

### ขั้น B — ทำให้ยิงเข้า Preview ได้ (Deployment Protection)

- [ ] **B1. generate Protection Bypass secret**
      Vercel → Project Settings → Deployment Protection → **Protection Bypass for Automation** → `+ Add Secret`
      *(confirm แล้วว่ามีให้ใช้บน plan ปัจจุบัน — erratum §G ข้อ 5)*
- [ ] **B2. ตั้งเป็น GitHub secret ชื่อ `VERCEL_AUTOMATION_BYPASS_SECRET`**
      GitHub → Settings → Secrets and variables → Actions
      ยืนยัน: เห็นชื่อ secret ในรายการ (ค่าดูไม่ได้ — ยืนยันได้แค่ว่ามี)

### ขั้น C — 🔴 รัน **post-merge gate ของ migration จริง** (ไม่ใช่ prep ของการซ้อม)

> **ตัดสิน 2026-08-08:** migration นี้ต้องลง prod อยู่แล้วตอนปิดเฟส — ไม่ใช่ทางอ้อมที่สร้างเพื่อการซ้อม
> `safety class GREEN` (CREATE TABLE ล้วน ไม่มี FK ไม่แตะของเดิม) · **ตารางว่างที่ยังไม่มีโค้ดใช้ = ไม่มีผล**
> · Prisma ควร apply ก่อนโค้ดที่ใช้มันอยู่แล้ว
> ⇒ **รันขั้น gate จริงตรงนี้เลย เก็บผลเป็นหลักฐานปิดเฟส** แล้วการซ้อมได้ประโยชน์ตามมา — ไม่ต้องทำสองรอบ

#### C0. ❓ ตอบก่อน — **สองคำถาม ไม่ใช่คำถามเดียว** (เปิดหน้าเดียวตอบครบ)

> 🔴 **ต้องเป็นงานมือของ Dev เท่านั้น** — ทดสอบแล้ว 2026-08-09: **Vercel MCP อ่าน environment variables ไม่ได้**
> `get_project` คืนแค่ `id` / `name` / `framework` / `nodeVersion` / `latestDeployment` / `domains`
> และชุด tool ทั้งหมดของ Vercel MCP **ไม่มีตัวอ่าน env เลยสักตัว**
> ⇒ ⛔ **ห้ามเสนอทาง MCP ซ้ำอีก** และห้ามเดาค่าจากที่อื่น

**เปิดครั้งเดียว:** Vercel → Project Settings → Environment Variables
แล้วตอบ **C0-a + C0-b + ทำ D0 ให้จบในรอบเดียว** (สามอย่างนี้อยู่หน้าเดียวกัน — ไม่มีเหตุให้เปิดสามรอบ)

##### C0-a. `DATABASE_URL` ถูก scope แยกหรือไม่

- [x] **ตอบแล้ว 2026-08-09 (Dev อ่านจากหน้า Vercel):**
      `DATABASE_URL` และ `DIRECT_URL` — **อย่างละ 1 แถว · scope = "Production and Preview"**
      ⇒ 🔴 **กรณี 1 — Preview ใช้ DB ตัวเดียวกับ production**

⚠️ **ห้ามเดา** — ทั้งสองกรณีเป็นไปได้ และเช็คลิสต์ต่างกัน:

| กรณี | ความหมาย | ต้องทำ |
| --- | --- | --- |
| ✅ **กรณี 1 — ค่าเดียวใช้ทุก scope** ← **ของจริง** | Preview ใช้ DB ตัวเดียวกับ production | apply **ครั้งเดียว** · verify ครั้งเดียว · ทำ C1 ชุดเดียว · ⚠️ **แต่มีผลข้างเคียงด้านล่าง — อ่านก่อน** |
| ~~กรณี 2 — แยก Production / Preview~~ | ~~Preview มี DB ของตัวเอง~~ | **ตัดออก** — ไม่ใช่กรณีของโปรเจกต์นี้ (เก็บไว้เพื่อให้อ่านย้อนได้ว่าเคยเผื่อไว้) |

> 🔴 **ผลข้างเคียงของกรณี 1 — ตอนนี้เป็น *ข้อเท็จจริงที่ยืนยันแล้ว* ไม่ใช่ความเป็นไปได้อีกต่อไป**
> *(อัปเดต 2026-08-09 หลัง C0-a ตอบว่า "แถวเดียว Production and Preview")*
>
> `writeSnapshot()` upsert แถว `ReadinessState` id `"singleton"` **แถวเดียวทั้งระบบ ไม่มี scope ของ environment**
> (`src/lib/readiness.ts` — และ `recordHeartbeat("readiness-probe")` ก็เป็นแถว global เช่นกัน)
> ⇒ 🔴 **การซ้อมบน Preview *จะ* เขียนสถานะ `FAIL` ทับแถวเดียวกับที่ endpoint สาธารณะของ production เสิร์ฟ**
> **— แน่นอน ไม่ใช่ "ถ้า"** เพราะ Preview กับ Production ต่อ DB ตัวเดียวกันที่ยืนยันแล้ว
>
> **ตอนนี้ blast radius = 0** — verify แล้ว 2026-08-09:
> · route ยังไม่อยู่บน main (`git show main:src/app/api/health/readiness/route.ts` → ไม่มีไฟล์)
> · `schedule:` ของ GitHub Actions รันเฉพาะ default branch ⇒ ชั้นในยังไม่เคยเขียน/อ่านแถวนี้
> ⇒ **หน้าต่างนี้คือช่วงที่ซ้อมปลอดภัยที่สุดที่จะมี** — ซ้อมตอนนี้ ไม่ใช่ตอนหลัง
>
> ⚠️ **หลัง merge ข้อนี้ไม่จริงอีกต่อไป** — ซ้อมซ้ำหลัง merge **ต้องกลับมาอ่านย่อหน้านี้ก่อนเสมอ**
> (ทางแก้จริง = แยก snapshot ตาม environment → **Phase 40** · ⛔ ห้ามแก้ในเฟสนี้ · ดู backlog B-3)

##### C0-b. 🔴 `QSTASH_URL` มี **กี่แถว** และแต่ละแถว scope อะไร

- [x] **ตอบแล้ว 2026-08-09 (Dev อ่านจากหน้า Vercel):**
      `QSTASH_URL` — **1 แถว · scope = "Production and Preview"**
      ⇒ 🔴 **กรณี ข — แถวเดียวติ๊กสองช่อง** ⇒ **กด Delete = ลบของ Production ไปด้วย ⛔ ห้ามเด็ดขาด**

⚠️ **runbook ฉบับก่อนสมมติเอาเองว่ามีแถว Preview แยกอยู่ — สมมติฐานนั้นไม่มีหลักฐานรองรับ**
incident §8.1 บันทึกว่าตั้งไว้ **"Production + Preview"** ซึ่งบน Vercel เป็นได้ทั้งสองแบบ:

| กรณี | สิ่งที่เห็นบนหน้า | ทำอะไรใน D1 |
| --- | --- | --- |
| **กรณี ก — 2 แถวแยก scope** | แถวหนึ่งติ๊ก Production · อีกแถวติ๊ก Preview | แก้ **แถวของ Preview เท่านั้น** — uncheck Preview (ไม่ใช่ Delete) |
| **กรณี ข — 1 แถวติ๊กสองช่อง** | แถวเดียว ติ๊กทั้ง Production และ Preview | ⛔ **กด Delete = ลบของ Production ไปด้วย = สร้าง incident ขึ้นมาใหม่จริง** ⇒ ต้อง **แก้แถวนั้นให้เหลือ Production เท่านั้น** |

⇒ **นี่คือเหตุผลที่ C0-b เป็น gate คู่กับ C0-a** — ตอบไม่ได้ = เดินไป D1 ไม่ได้

#### C1. apply + verify (ทำตามกรณีที่ตอบใน C0)

**C1a — apply**
- [ ] Production DB: `DATABASE_URL=<prod> npx prisma migrate deploy`
- [ ] *(กรณี 2 เท่านั้น)* Preview DB: `DATABASE_URL=<preview> npx prisma migrate deploy`

⚠️ migrate **ไม่ได้อยู่ใน build pipeline** (ตรวจแล้ว — erratum §F · backlog B-2) ⇒ deploy สำเร็จได้
โดยตารางยังไม่ถูกสร้าง · นี่คือเหตุผลที่ขั้นนี้ต้องทำด้วยมือและต้องมีหลักฐาน

**C1b — verify แถวใน `_prisma_migrations`** *(ทำกับทุก DB ที่ apply)*
```sql
select migration_name, finished_at, rolled_back_at
from _prisma_migrations
where migration_name = '20260808000000_add_readiness_heartbeat';
```
- [ ] ✅ ผ่านเมื่อ: `finished_at` **ไม่ null** และ `rolled_back_at` **เป็น null**
- ⛔ **ห้ามเชื่อ `prisma migrate status`** — รายงานผิดเมื่อมี failed migration

**C1c — verify ผลของ migration ไม่ใช่แค่แถวใน `_prisma_migrations`** *(ทำกับทุก DB ที่ apply)*
```sql
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('MechanismHeartbeat', 'ReadinessState');
```
- [ ] ✅ ผ่านเมื่อ: ได้ **2 แถว**

**C1d — เก็บหลักฐาน**
- [ ] คัดผลลัพธ์ของ C1b + C1c (ต่อ DB) ใส่เป็น**ตารางหลักฐาน**ในเอกสารปิดเฟส
      ตาม `CLAUDE.md` § Post-merge gate ("ตารางหลักฐาน external resource — ไม่ใช่ checkbox ของเจตนา")
      ⇒ **เอกสารปิดเฟส = `phase-39-closing-evidence-2026-08-09.md`** (สร้างแล้ว · แถว 1–2)

**C1e — 🔴 เศษของ integration test บน prod: ต้อง *วัด* ไม่ใช่เชื่อว่า `afterAll` รันแล้ว**

`src/lib/__tests__/isolation/composite-fk.integration.test.ts` **อยู่ใน `include` ของ `vitest.config.ts` ตามปกติ**
⇒ **ทุกครั้งที่รัน gate `npm test` มันเขียนแถวจริงลง production database** (backlog **B-1**)

> ⚠️ **เหตุผลที่ต้องวัดจริง ไม่ใช่ติ๊กว่า "cleanup มีอยู่แล้ว":**
> cleanup ใน `afterAll` **ทุกบรรทัดลงท้ายด้วย `.catch(() => {})`** ⇒ **ล้มได้เงียบสนิท**
> ทั้งไฟล์จะยังรายงานว่า test ผ่าน โดยที่แถวยังอยู่ครบ — นี่คือ fail-silent รูปทรงเดียวกับที่ทั้งเฟสนี้แก้อยู่
> ⇒ **"ผ่าน 7/7" ไม่ใช่หลักฐานว่าเก็บกวาดสำเร็จ** · หลักฐานเดียวคือ query นับของจริง

**ผลที่วัดแล้ว — Supabase SQL editor (Primary Database) · 2026-08-09 · โดย Dev**

| ตาราง | เงื่อนไข | จำนวนแถวที่พบ | ผ่าน? |
| --- | --- | --- | --- |
| `Tenant` | `id like 'xtfk\_%'` | **0** | ✅ |
| `User` | `id like 'xtfk\_%'` | **0** | ✅ |
| `Contact` | `id like 'xtfk\_%'` | **0** | ✅ |
| `TenantMember` | `id like 'xtfk\_%'` | **0** | ✅ |
| `Ticket` | `id like 'xtfk\_%'` | **0** | ✅ |
| `TicketMessage` | `id like 'xtfk\_%'` | **0** | ✅ |

⇒ ✅ **ไม่มีเศษตกค้างบน prod ณ 2026-08-09** — ครบทั้ง 6 ตารางที่ `afterAll` แตะ

> 🔑 **ทำไมต้องครบ 6 ตาราง ไม่ใช่เช็คแค่ `Tenant`:**
> **`User` เป็น global model — ไม่มี `tenantId`** (ตาม `CLAUDE.md`: global models = `User`, `Plan`, `FeatureFlag`)
> ⇒ ลบ `Tenant` **ไม่ cascade ไปถึง `User`** และการเช็คจากฝั่ง tenant **มองไม่เห็นมันเลย**
> ⇒ เช็คแค่ `Tenant` = ได้ 0 แถวแล้วสบายใจ ทั้งที่ `User` อาจค้างอยู่ · `afterAll` จึงลบ `User` ด้วย `id` แยกต่างหาก
> (บรรทัด 150 ของไฟล์เทสต์) — **ตัวเช็คต้องเดินตามตรรกะเดียวกับตัวลบ ไม่ใช่ตามสัญชาตญาณเรื่อง tenant**

**query สำหรับรันซ้ำ — ทำทุกครั้งก่อนเก็บหลักฐานปิด gate** (เศษเกิดใหม่ได้ทุกครั้งที่มีคนรัน `npm test`)

```sql
select 'Tenant'        as t, count(*) from "Tenant"        where id like 'xtfk\_%'
union all select 'User',         count(*) from "User"          where id like 'xtfk\_%'
union all select 'Contact',      count(*) from "Contact"       where id like 'xtfk\_%'
union all select 'TenantMember', count(*) from "TenantMember"  where id like 'xtfk\_%'
union all select 'Ticket',       count(*) from "Ticket"        where id like 'xtfk\_%'
union all select 'TicketMessage',count(*) from "TicketMessage" where id like 'xtfk\_%';
```

- [ ] ✅ ผ่านเมื่อ: **ทุกแถวเป็น 0** · ถ้าไม่ใช่ → มีเศษค้าง ต้องเก็บกวาดก่อน แล้วบันทึกว่าเจอเท่าไร

#### C2–C4 — env ของ probe

- [ ] **C2. ตั้ง `READINESS_PROBE_TOKEN` บน Vercel — scope ที่ Preview เห็น**
      ยืนยัน: หลัง C4 ยิง probe แล้วได้ shape เต็ม (มี `components`) ไม่ใช่ `401`
- [ ] **C3. ตั้ง `READINESS_PROBE_TOKEN` เป็น GitHub secret ค่าเดียวกัน**
      ยืนยัน: เห็นชื่อในรายการ secret
- [ ] **C4. redeploy Preview หลังตั้ง env**
      ⚠️ env ที่เพิ่งตั้งไม่มีผลกับ deployment เดิม — ต้อง redeploy เสมอ
      🔴 **ก่อนกด: เช็คว่า A3 (push) เสร็จแล้ว** — ไม่งั้น redeploy ออกมาเป็นโค้ดเก่าที่ยังไม่มีการแก้ §H-8
      ยืนยัน: deployment ใหม่สถานะ Ready · **sha ตรงกับ `git rev-parse HEAD`** · **จด URL ใหม่** (URL เปลี่ยนทุก deployment)

### ขั้น D — จัดฉาก incident

> 🔴 **ขั้น D1 คือคลิกที่อันตรายที่สุดของทั้งเฟส**
> พลาดไปโดน Production scope = **สร้าง incident 7 สัปดาห์ของ Phase 38 ขึ้นมาใหม่ด้วยมือ**
> และทำตอนที่ **ระบบเตือนที่สร้างมาทั้งเฟสยังไม่ merge** ⇒ ไม่มีอะไรจับให้เลย
> ⇒ สามข้อล่างเป็น **ขั้นบังคับ** ไม่ใช่ความระมัดระวังส่วนตัว

- [ ] **D0. แคป env ของ Production ก่อนแตะอะไรทั้งสิ้น** *(ทำพร้อม C0-a/C0-b ในการเปิดหน้ารอบเดียว)*
      Vercel → Project Settings → Environment Variables → กรอง scope = **Production**
      ถ่ายภาพหน้าจอ/คัดรายชื่อตัวแปรทั้งหมดเก็บไว้ **นอก Vercel**
      (ไฟล์นี้คือหลักฐานชิ้นเดียวที่บอกได้ว่า "ก่อนหน้านี้มีอะไรบ้าง" — ไม่มี = พิสูจน์ไม่ได้ว่าไม่ได้ทำพัง)
      > 🔴 **แก้ 2026-08-09 — ข้อ "กด Reveal คัดค่าเต็ม" ที่เคยเขียนไว้ตรงนี้ *ทำไม่ได้จริง* จึงถอดออก**
      >
      > `DATABASE_URL` · `DIRECT_URL` · `QSTASH_URL` **ติดป้าย `Sensitive` ทั้งสามตัว**
      > เอกสาร Vercel: *"Sensitive variables are hidden in the Vercel Dashboard"* ⇒ **ไม่มีปุ่ม Reveal ให้กด**
      > ⇒ **อ่านค่ากลับไม่ได้เลยโดยการออกแบบของ Vercel** — ไม่ใช่เพราะสิทธิ์ไม่พอหรือหาปุ่มไม่เจอ
      >
      > ⚠️ **เขียนไว้ตรง ๆ แทนที่จะเขียนขั้นตอนที่ทำไม่ได้** — ขั้นตอนที่ทำไม่ได้จะถูกติ๊กผ่านไปเฉย ๆ
      > แล้วกลายเป็นหลักฐานปลอม ซึ่งแย่กว่าการยอมรับว่าหลักฐานอ่อน (ลง erratum **§G ข้อ 10**)

      - [ ] **แคปได้แค่: รายชื่อตัวแปร + scope ที่ติ๊กของแต่ละแถว** (ค่าจริงอ่านไม่ได้ — ดูกล่องด้านบน)
      - [ ] 🔑 **จดไว้ว่า "ค่าที่ใช้กู้" อยู่ที่ไหน — เพราะ Vercel ไม่ใช่แหล่งกู้ได้อีกต่อไป**

            ```
            QSTASH_URL = https://qstash-us-east-1.upstash.io
            ```
            **แหล่ง: `phase-38-qstash-region-incident-2026-08-06.md` §8.1**

            ⚠️ **นี่คือแหล่งกู้ *แหล่งเดียวที่มี*** — ตรวจแล้ว 2026-08-09: `.env` ของเครื่อง dev
            **ไม่มี `QSTASH_URL`** (มีแต่ `QSTASH_TARGET_BASE_URL` / `QSTASH_TOKEN` /
            `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY`)
            ⇒ ถ้าแถวบน Vercel หาย **ไม่มีที่อื่นให้ copy ค่ามาแปะ** นอกจากบรรทัดนี้

- [ ] **D1. ทำให้ Preview ยิงไป EU — เลือก *ทาง A* หรือ *ทาง B***

      C0-b ตอบแล้วว่าเป็น **กรณี ข (1 แถว ติ๊กสองช่อง)** ⇒ **⛔ Delete ตายตัว: ลบ = Production หายไปด้วย**
      เหลือสองทาง และ **ทาง A ไม่ต้องเปิดแถวนั้นเลยแม้แต่ครั้งเดียว**

---

##### 🟢 ทาง A (แนะนำ) — **เพิ่มแถวใหม่ที่ scope แคบกว่า ไม่แตะแถวเดิม**

      แนวคิด: แทนที่จะ*เอาค่าที่ถูกออก* ให้*ทับด้วยค่าที่ผิด*ที่ scope แคบกว่า
      ⇒ **ไม่เคยเปิดแถวที่ Production ใช้เลย ⇒ คลิกที่อันตรายที่สุดของทั้งเฟสหายไปทั้งอัน**

      - [ ] **A-1. เพิ่มตัวแปรใหม่** `QSTASH_URL` = `https://qstash.upstash.io`
            scope **Preview** → จำกัด branch **`feature/phase-39-server-env-readiness`**
            (CLI: `vercel env add QSTASH_URL preview feature/phase-39-server-env-readiness`)

      > 🔑 **ทำไมค่านี้ถึงเทียบเท่ากับ "ไม่มีตัวแปร":** `https://qstash.upstash.io` คือ **EU default
      > ที่ SDK fallback ไปอยู่แล้วเมื่อไม่ได้ตั้ง `QSTASH_URL`** ⇒ สภาพ runtime เหมือนกันเป๊ะ
      > · และไม่ใช่การอนุมาน — incident **§2.2 วัดมาแล้วโดยตรง**: `https://qstash.upstash.io/v2/schedules`
      >   → `404` + error signature ของ §2.1 ⇒ **`EXPECTED_ERROR_SIGNATURE` ของสคริปต์ยังตรง**

      - [ ] **A-2. 🔴 verify ด้วย *ผล* ไม่ใช่ด้วยเอกสาร — สองข้อนี้ยังไม่เคยพิสูจน์บนโปรเจกต์นี้**
            - [ ] UI/CLI **ยอมให้มี key ซ้ำ** แบบ branch-scoped จริงไหม (อาจปฏิเสธว่า key ซ้ำ)
            - [ ] แถว branch-scoped **precedence ชนะ** แถว "Production and Preview" จริงไหม
            ⛔ **ห้ามเดาจากเอกสารของ Vercel** — หลักการเดียวกับ §G ข้อ 5 (แยก "ผลการวัด" ออกจาก "พฤติกรรมของ Vercel")

      > ✅ **ทาง A ลองได้อย่างปลอดภัย — นี่คือเหตุผลหลักที่แนะนำ:**
      > ถ้า precedence ไม่ทำงานตามที่คิด Preview จะยังยิงไป us-east-1 ⇒ probe ไม่ FAIL ⇒ ผลซ้อมออกมาเป็น
      > **`INVALID` ไม่ใช่ `PROVEN`** ⇒ **เกณฑ์ 3 ค่า (ข้อ 1) กันการอ่านผิดไว้ให้แล้ว**
      > ⇒ **ความล้มเหลวของทาง A มีราคาแค่ "ซ้อมไม่ผ่าน" ไม่ใช่ "Production พัง"**

      - [ ] **A-3. F1 ของทาง A = ลบแถวที่ตัวเองเพิ่งสร้าง** — **ลบของที่ตัวเองสร้าง ≠ ลบของเดิม**
            ไม่ต้องพิมพ์ค่าใด ๆ กลับ · แถวเดิมไม่เคยถูกแตะตั้งแต่ต้น

---

##### 🟠 ทาง B (fallback — ใช้เมื่อ A-2 พิสูจน์ไม่ผ่าน) — **uncheck Preview บนแถวเดิม**

      - [ ] **B-1. 🔴 เปิด dialog แก้ scope แล้ว *ดูก่อน* ว่ามันบังคับกรอกค่าใหม่หรือไม่ — ยังไม่ Save**
            เหตุผล: ตัวแปรเป็น **Sensitive** ⇒ ค่าเดิมอ่านกลับไม่ได้ ⇒ **เป็นไปได้ที่ช่องค่าจะโผล่มาว่าง**
            และการ Save ทั้งที่ว่าง = **ทำ Production พังทันที** ตรงจุดที่พยายามหลีกเลี่ยงมาทั้งเฟส
            - [ ] ถ้า **ไม่บังคับกรอกค่า** → uncheck **Preview** → Save (ปลอดภัย เดินต่อได้)
            - [ ] ถ้า **บังคับกรอกค่า** → ต้องวางค่าจาก incident §8.1
                  (`https://qstash-us-east-1.upstash.io`) ลงไปเอง
                  ⚠️ **นับเป็นการเบี่ยงจาก runbook ที่ต้องบันทึก** — เพราะตอนนี้ความถูกต้องของค่าบน Production
                  ขึ้นกับ **การพิมพ์ของมนุษย์** ไม่ใช่การที่ค่าเดิมไม่เคยถูกแตะ
      - [ ] **B-2.** ⛔ **ห้ามกด Delete แล้วสร้างใหม่** — ระหว่างสองจังหวะนั้น Production ไม่มีค่านี้อยู่จริง
      - [ ] **B-3.** ก่อน Save: อ่าน scope ที่ติ๊กอยู่กับแถวนั้นออกเสียงหนึ่งรอบ
- [ ] **D1b. แคป env ของ Production อีกครั้ง แล้ว *เทียบกับ D0***
      ✅ ผ่านเมื่อ: รายการ Production **ไม่เปลี่ยนเลยแม้แต่ตัวเดียว** — โดยเฉพาะ **`QSTASH_URL` ยังอยู่
      และยังติ๊ก Production**
      ⚠️ นี่คือ verify-by-effect: "ผมกดที่แถวของ Preview" เป็นเจตนา **ไม่ใช่หลักฐาน**

      > 🔴 **หลักฐานขั้นนี้อ่อนกว่าที่ตั้งใจไว้ — เขียนตรง ๆ ดีกว่าเขียนให้ดูสมบูรณ์** *(แก้ 2026-08-09)*
      >
      > ฉบับก่อนสั่งให้ **เทียบค่าตัวต่อตัว** กับค่าเต็มที่คัดไว้ใน D0 — **ทำไม่ได้จริง**
      > เพราะตัวแปรเป็น **Sensitive** ⇒ Vercel ซ่อนค่าไว้ ⇒ ไม่มีทั้งค่าใน D0 ให้เทียบ และค่าตอนนี้ให้อ่าน
      >
      > ⇒ **สิ่งที่ D1b พิสูจน์ได้จริงมีแค่: "แถวยังอยู่ + ยังติ๊ก Production"**
      > ⇒ **สิ่งที่พิสูจน์ไม่ได้: ค่าข้างในยังถูกต้องหรือไม่** — ถ้าใครเผลอ Save ค่าที่ผิดลงไป **D1b จับไม่ได้**
      >
      > 🔑 **นี่คือเหตุผลเชิงโครงสร้างที่ทาง A เหนือกว่าทาง B:** ทาง A ไม่เคยเปิดแถวนั้น ⇒ ค่าไม่มีทางเปลี่ยน
      > ⇒ **ไม่ต้องพึ่งหลักฐานที่อ่อนตัวนี้ตั้งแต่แรก** · ส่วนทาง B ต้องยอมรับช่องว่างนี้ตรง ๆ
      > (ลง erratum **§G ข้อ 10** เป็นข้อจำกัดที่รู้ตัว)
      ⛔ ถ้าไม่เหมือน → **หยุดทันที ตั้งค่ากลับจาก D0 ก่อนทำอย่างอื่น** ห้ามเดินต่อไป D2
- [ ] **D2. redeploy Preview อีกครั้ง (ให้ env ใหม่มีผล)**
      ยืนยัน: Ready · **จด URL ล่าสุด** — อันนี้คือ URL ที่จะใส่ตอนกด workflow

### ขั้น E — ซ้อม

## ✅ ผลจริง — **`PROVEN` · 2026-08-09**

**target:** `https://helpwise-fmgvtv0xj-chopchats-projects.vercel.app` (redeploy ของ `c5c17f0` · Preview · READY)

**ผลดิบ (คัดตามที่พิมพ์ออกมา ไม่เรียบเรียง):**

```
probe: http 503: FAIL
✅ FAIL พร้อม error signature ตรงกับ incident §2.1
[rehearsal] ผล: PROVEN
```

### ตารางหลักฐาน — ผลเดียวนี้ปิด 5 อย่างพร้อมกัน

| # | สิ่งที่ถูกพิสูจน์ | หลักฐานที่ทำให้สรุปได้ |
| --- | --- | --- |
| 1 | 🎯 **probe จับ "สาเหตุจริง" ได้ ไม่ใช่แค่ "พัง"** — เกณฑ์ตัดสินของทั้งเฟส | `FAIL` **พร้อม** error signature `not found in this region (eu-central-1)` · ถ้าได้ `FAIL` เฉย ๆ = `INVALID` ตามข้อ 1 |
| 2 | ✅ **A-2 ปิดแล้ว** — branch-scoped preview var **precedence ชนะ** แถว "Production and Preview" | Preview ยิงไป EU จริง (ได้ signature) ทั้งที่แถวเดิมยังตั้ง us-east-1 อยู่ ⇒ **ทาง A ของ D1 ใช้ได้จริง** |
| 3 | ✅ **bypass secret ถูกต้อง** | ได้ `marker` ในเนื้อ response = ทะลุ Deployment Protection ถึงโค้ดเราจริง (ไม่ใช่ `INCONCLUSIVE`) |
| 4 | ✅ **`READINESS_PROBE_TOKEN` ตรงกันสองฝั่ง** | ได้ shape ที่ auth (มี `components`) ไม่ใช่ `401` |
| 5 | ✅ **C1 ถูกยืนยันซ้ำโดยอ้อม** — ตารางถูก apply บน DB จริง | ถ้าตารางยังไม่มี → `readMechanismHeartbeats()` โยน → stage **`[probe]`** → คืน component เดียว → **ไม่มี `qstash` signature** → ต้องได้ `INVALID` · **การได้ signature = แอปอ่าน `MechanismHeartbeat` บน prod DB ได้จริง** |

> 🔑 **ข้อ 5 คือเหตุผลที่ตาราง stage ของ §H-8 มีค่ามากกว่าความสวยงามของข้อความ** — มันทำให้ผลบวก
> ของการซ้อม**กลายเป็นหลักฐานของ prerequisite ไปด้วยในตัว** โดยไม่ต้องออกแบบการทดสอบเพิ่ม
> (ก่อนแก้ §H-8 เคสตารางหายจะออกมาเป็น "redis unavailable" ซึ่งอนุมานอะไรกลับไม่ได้เลย)

### 🎁 หลักฐานฟรีที่เก็บได้ระหว่างทาง — **ตัวกรองของลำดับ 5 ทำงานถูก**

หน้า GitHub Actions มี **"Readiness (P2)"** ถูก trigger จาก `deployment_status` ของ Vercel **4 ครั้ง**
ระหว่างการเตรียม/ซ้อม — **ทุกครั้งจบที่ `1s / Skipped`**

| | |
| --- | --- |
| กลไก | job-level `if` ที่ `.github/workflows/readiness.yml:54-57` กรอง `state == 'success' && environment == 'Production'` |
| ของเราคือ | **Preview** ⇒ ไม่ผ่านตัวกรอง ⇒ skip |
| ⇒ พิสูจน์ 2 อย่าง | (ก) **ตัวกรองของลำดับ 5 ทำงานถูกต้องบน GitHub จริง** ไม่ใช่แค่ในไฟล์ · (ข) **ไม่มีอะไรไปแตะ production ระหว่างการซ้อม** |

> 💡 ได้มา**โดยไม่ต้องออกแบบการทดสอบใด ๆ** — deployment_status ยิงเข้ามาเองตามธรรมชาติของการ redeploy
> ⇒ เก็บเข้าตารางหลักฐานปิดเฟส (`phase-39-closing-evidence-2026-08-09.md`)

---

- [ ] **E1. GitHub → Actions → Readiness Rehearsal (Preview) → Run workflow**
      ใส่ `preview_url` = URL จาก D2 · `confirm` = `REHEARSE`
      ⚠️ **ของจริง 2026-08-09 ไม่ได้ทำทางนี้** — workflow ยังไม่ถูก register (ดูกล่อง "ข้อเบี่ยง" ท้ายไฟล์)
- [ ] **E2. อ่านผล — `INCONCLUSIVE` มีสองสาเหตุคนละเรื่อง ต้องแยกด้วย `detail` ที่พิมพ์ออกมา**

| ผล | `detail` ที่พิมพ์ | แปลว่า | กลับไปทำอะไร |
| --- | --- | --- | --- |
| `PROVEN` | — | ✅ | ไปขั้น **F** |
| `INCONCLUSIVE` | **มี `http 401`** | **ถึงโค้ดเราแล้ว** (มี marker) แต่ `READINESS_PROBE_TOKEN` ไม่ตรง — **ไม่ใช่ปัญหา bypass** | **C2 / C3** (token สองฝั่งตรงกันไหม) + **C4** (env ใหม่ต้อง redeploy ก่อนถึงมีผล) |
| `INCONCLUSIVE` | ไม่มี marker (`body is not JSON` / `marker mismatch` / `empty body`) | Deployment Protection กินไปก่อนถึงแอป / Preview ยังไม่ขึ้น | **B / A** |
| `INVALID` | — | prerequisite ไม่ครบ | **อ่าน `components` ในเนื้อ response — ตอนนี้มันชี้ตัวการได้เองแล้ว** ดูตารางถัดไป · ⛔ **ห้ามนับผ่าน** |

**`INVALID` → เปิด body ดู `components` แล้วอ่าน prefix `[stage]` ใน `detail`** *(ผลของการแก้ §H-8)*

ก่อนหน้านี้ทุกความพังออกมาเป็น `redis` เหมือนกันหมด ⇒ ทำได้แค่เดาว่า "มักคือ C1"
ตอนนี้ body บอกเองว่าพังที่ขั้นไหน:

| component key | prefix ใน `detail` | พังตรงไหน | ไปแก้ที่ |
| --- | --- | --- | --- |
| `redis` | `[lock]` | จอง slot ของ min-interval ไม่ได้ = **Redis** เอง | `REDIS_URL` ของ scope ที่ Preview เห็น |
| `probe` | `[probe]` | live probe **โยนกลางทาง** | 🔴 **ส่วนใหญ่คือ C1** — ดู "กับดัก" ด้านล่าง |
| `store` | `[write]` | วัดสำเร็จแล้ว แต่ **เขียน snapshot ไม่ลง** | ตาราง `ReadinessState` (C1) |
| `store` | `[read]` | ชน min-interval แล้ว **อ่าน snapshot ที่เก็บไว้ไม่ได้** | ตาราง `ReadinessState` (C1) · หรือรอ 5 นาทีให้ lock หมดอายุแล้วซ้อมใหม่ |

> 🔴 **กับดักชื่อ — อ่านก่อนสรุป:**
> **"ตารางยังไม่ถูก apply" (เคส C1 ที่พบบ่อยที่สุด) จะออกมาที่ stage `probe` ไม่ใช่ `write`**
> เพราะ `readMechanismHeartbeats()` อยู่ใน `Promise.all` ของ `runLiveProbe()` ⇒ **Prisma โยนตั้งแต่ตรงนั้น
> ก่อนที่การทำงานจะเดินไปถึง `writeSnapshot()` เลย**
>
> ⇒ **เห็น component key ชื่อ `probe` อย่าเพิ่งนึกว่าเป็น QStash** — ให้อ่าน `detail` เสมอ
> (เจอ `relation "MechanismHeartbeat" does not exist` = C1 ชัด ๆ ไม่ใช่ปัญหา QStash แม้แต่นิดเดียว)
> · ที่จริงในทางกลับกัน: QStash พังจะ**ไม่**มาโผล่ที่ `[probe]` เลย เพราะ `probeQStashReadOnly()`
>   จับ error เองแล้วรายงานเป็น `components.qstash.status = "error"` บนเส้นทางปกติ
> · ตัวเดียวที่โยนขึ้นมาถึง `[probe]` ได้จริงคือ **การอ่านตาราง heartbeat** (ตั้งใจไม่จับ — ต้องขึ้นถึงสถานะ)

> 🟡 **`heartbeat_missing (sla-sweep)` จะติดอยู่ใน `reasons` ทุกครั้งบน Preview — และนั่นถูกต้อง ไม่ใช่อาการพัง**
>
> `SCHEDULED_MECHANISMS` = `["sla-sweep", "readiness-probe"]` แต่ **`recordHeartbeat("sla-sweep")`
> ยังไม่อยู่บน `main`** (verify: `git show main:src/app/api/jobs/sla-sweep/route.ts | grep -c recordHeartbeat` → **0**)
> ⇒ QStash schedule ยิงไปที่ production ซึ่งรันโค้ดของ `main` ⇒ **ไม่มีใครเต้นให้ `sla-sweep` เลย**
> ⇒ `absent = ["sla-sweep"]` ⇒ `status = "missing"` ⇒ `FAIL` **ถาวรจนกว่าจะ merge**
> — **เป็นพฤติกรรมที่ §F บังคับไว้เอง** ("ไม่พบ heartbeat = FAIL เสมอ ห้าม fallback เป็น PASS")
>
> ⇒ 🔑 **อย่าใช้ `reasons` เป็นตัวตัดสินผลซ้อม** — `heartbeat_missing` จะอยู่ตรงนั้นเสมอ
> ⇒ **ตัวชี้ขาดคือ `components.qstash.detail` อย่างเดียว** (error signature อยู่ที่นั่น คนละที่กับ heartbeat)
> ⇒ ไม่กระทบ `PROVEN` เลย · และ **เห็น `heartbeat_missing` ไม่ได้แปลว่า C1 ล้ม** (C1 ล้มจะโผล่เป็น
>   `[probe]` พร้อมข้อความของ Prisma ตามตาราง stage ด้านบน)
>
> ✅ **อาการนี้จะหายเองหลัง merge + sweep รอบแรก** — ไม่ต้องแก้อะไรตอนนี้

> ทำไม 401 ถึงออกมาเป็น `INCONCLUSIVE` ไม่ใช่ `FAIL`: route ตอบ **marker + `error`** โดย**ไม่มี field `status`**
> ⇒ `classifyProbeResponse()` เข้ากฎ *"marker ok but status is not a known value"* ⇒ `INCONCLUSIVE` ถูกต้องตามนิยาม
> · สคริปต์พิมพ์ hint แยกสองทางนี้ให้แล้ว (`scripts/readiness-rehearsal.ts` — `evaluate()`)

### ขั้น F — 🔴 คืนสภาพ (ห้ามข้าม)

- [ ] **F1. คืนสภาพ — ทำตามทางที่เลือกไว้ใน D1**
      - [ ] **ถ้าใช้ทาง A:** **ลบแถว branch-scoped ที่ตัวเองเพิ่งสร้าง** — จบ
            ⇒ ไม่ต้องพิมพ์ค่าใด ๆ · แถวเดิมของ Production ไม่เคยถูกแตะตั้งแต่ต้น (นี่คือทั้งประเด็นของทาง A)
      - [ ] **ถ้าใช้ทาง B:** **ติ๊ก Preview กลับ** ที่แถวเดิม
            ⛔ ห้ามสร้างแถวใหม่ · ถ้า dialog บังคับกรอกค่า ให้ใช้ค่าจาก incident §8.1
            (`https://qstash-us-east-1.upstash.io`) **และบันทึกว่าเบี่ยง**
            ⚠️ ค่าที่พิมพ์กลับไป **verify ด้วยตาไม่ได้** (Sensitive) ⇒ ต้องพึ่ง **F3** เป็นหลักฐานแทน
- [ ] **F2. redeploy Preview**
- [ ] **F3. ยืนยันว่าคืนแล้วจริง** — กด workflow ซ้ำอีกครั้ง ต้องได้ผล **ไม่ใช่** `PROVEN`
      (ถ้ายังได้ `PROVEN` แปลว่ายังไม่ได้คืนจริง)
      ⚠️ ข้อนี้คือ verify-by-effect — "ตั้งกลับแล้ว" เป็นเจตนา ไม่ใช่หลักฐาน
      ⚠️ **และตอนนี้มันคือหลักฐาน *หลัก* ของการคืนสภาพ** — เพราะ Sensitive ทำให้ D1b เทียบค่าไม่ได้ (§G ข้อ 10)

      - [ ] 🔴 **ก่อนกด: เว้นจาก E1 ให้เกิน 5 นาที** (min-interval) — **ดูกฎที่ 0 ในข้อ 1**
      - [ ] 🔴 **เปิด body เช็คว่า `"source":"live"`** — ถ้าเป็น `"stored"` ⇒ **ผลนี้ใช้ไม่ได้ ให้รอแล้วกดใหม่**
            (`stored` = กำลังอ่าน snapshot ของ E1 ซึ่งยังมี signature ติดอยู่ ⇒ จะอ่านว่า "ยังไม่คืน" ทั้งที่คืนแล้ว)
      - [ ] ⚠️ **redeploy ที่ F2 ไม่ล้าง lock** — lock อยู่บน Redis ที่ทุก deployment ใช้ร่วมกัน

---

## 2.9 🔴 ข้อเบี่ยงจาก runbook ในการซ้อมจริง 2026-08-09 — **บันทึกไว้ ห้ามข้ามเงียบ**

### 🔴 W. **workflow ของลำดับ 7 ยังไม่เคยถูกรันเลยสักครั้ง** — ข้อเบี่ยงที่ใหญ่ที่สุด

**"Readiness Rehearsal (Preview)" ไม่โผล่ในหน้า GitHub Actions** — เพราะ `workflow_dispatch`
จะถูก **register ก็ต่อเมื่อไฟล์อยู่บน default branch** แต่ **§F ห้าม merge**
⇒ Dev รัน **`npx tsx scripts/readiness-rehearsal.ts` จากเครื่องแทน**

| | |
| --- | --- |
| ✅ **พิสูจน์แล้วจริง** | **ตัวสคริปต์** · guard `assertPreviewHost()` · เกณฑ์ 3 ค่า · ตรรกะ `classifyProbeResponse` · error signature |
| ❌ **ยังไม่เคยถูกพิสูจน์เลย** | **ตัว workflow เอง** — ชั้น `confirm != 'REHEARSE'` (`readiness-rehearsal.yml:37`) · การดึง secrets ผ่าน Actions · `npm ci` · ลำดับ step |

> ⚠️ **แยกให้ขาด: "probe ทำงาน" ≠ "workflow ทำงาน"** — สิ่งที่ยังไม่รู้คือ **plumbing** ไม่ใช่ตรรกะ
> ⇒ ⛔ **ห้ามเขียนสรุปว่า "ลำดับ 7 ผ่านครบ"** — ผ่านเฉพาะส่วนที่รันได้จริง

- [ ] **ขั้นบังคับหลัง merge:** dispatch workflow **หนึ่งครั้ง** เพื่อพิสูจน์ plumbing
      ⚠️ **ไม่ใช่เพื่อพิสูจน์ probe** (พิสูจน์แล้ว) — เพื่อพิสูจน์ว่า **ชั้น `confirm` + secrets + step ordering ใช้ได้จริง**
      ⇒ ลง `CLAUDE.md` § Post-merge gate + เอกสารปิดเฟส (ยังเป็นช่องว่าง)

> 🔑 **ผลข้างเคียงของดีไซน์ที่ไม่ได้เผื่อไว้** (ลง erratum §H-6):
> **ชั้นที่ 3 ของ guard** (*"`workflow_dispatch` อย่างเดียว ⇒ cron เรียกไม่ได้เพราะไม่มี trigger ให้เรียก"*)
> **กันทุกคนจริง ๆ รวมถึงเจ้าของเฟสเองด้วย** — ตราบใดที่ยังไม่ merge
> ⇒ guard ทำงานถูกต้องตามที่ออกแบบทุกประการ · แค่**ดีไซน์ไม่ได้คิดว่าจะต้องใช้มันก่อน merge**

### X-1. ลำดับจริงเป็น **D1 → C1 → C2/C3 → C4** (D1 มาก่อน C)

**ทำไมเบี่ยง:** การพิสูจน์ **A-2** (branch-scoped precedence) ทำได้ทางเดียวคือ **สร้างแถวจริงแล้วดูผล**
⇒ D1 (สร้างแถว) กลายเป็นสิ่งที่ต้องทำก่อน เพื่อรู้ว่าจะเดินทาง A หรือ B ต่อ

**ทำไมไม่เสียหาย — ไม่ใช่ "ก็ผ่านมาแล้วนี่":**
· ทาง A **ไม่แตะแถวของ Production เลย** ⇒ ความเสี่ยงที่ลำดับ D0→D1→D1b ออกแบบมากันไม่มีอยู่ตั้งแต่แรก
· ขั้น C เป็น **post-merge gate ของ migration** ซึ่ง**ไม่ขึ้นกับสภาพของ Preview** ⇒ ทำก่อนหรือหลังให้ผลเดียวกัน
· และ C1 ยัง**ถูกยืนยันโดยอ้อมจากผลซ้อมเอง** (ตารางหลักฐาน ข้อ 5)

⇒ **สำหรับทาง A: ลำดับที่ถูกคือ D1 ก่อน** (ไม่ใช่การเบี่ยงที่ต้องแก้กลับ) · ⛔ **แต่ถ้าใช้ทาง B ลำดับเดิมยังบังคับ**
เพราะทาง B ต้องมี D0 เป็นหลักฐานก่อนแตะแถวที่ Production ใช้

### X-2. ต้อง redeploy Preview **สองรอบ** — "push แล้ว" ไม่พอ

C4 เขียนไว้แล้วว่าต้อง redeploy หลังตั้ง env แต่**ไม่ได้เน้นจุดที่พลาดง่ายที่สุด**:

> 🔑 **push ทำให้เกิด deployment ที่มี *โค้ด* ใหม่ — แต่ env ที่ตั้ง *หลัง* จาก deployment นั้นขึ้น จะยังไม่มีผล**
> ⇒ ตั้ง `READINESS_PROBE_TOKEN` (C2) หลัง push ⇒ **ต้อง redeploy อีกรอบ**
> ⇒ ลำดับที่ปลอดภัย: push → ตั้ง env ให้ครบ → **redeploy เป็นขั้นสุดท้ายเสมอ** → ค่อยจดURL

### X-3. ข้อความปิดท้ายของสคริปต์ยังเป็นถ้อยคำของ **ทาง B**

`scripts/readiness-rehearsal.ts` พิมพ์ *"อย่าลืม: ตั้ง `QSTASH_URL` กลับคืน Preview scope"*
⇒ **ผิดสำหรับทาง A** — ของจริงคือ **ลบแถวที่เพิ่งสร้างขึ้นมา** ไม่ใช่ตั้งอะไรกลับ
⇒ คนที่ทำตามข้อความนี้ตรง ๆ จะไปเปิดแถวที่ Production ใช้ **ซึ่งเป็นสิ่งที่ทาง A ตั้งใจเลี่ยงทั้งหมด**

⛔ **ยังไม่แก้โค้ดในเฟสนี้** — ลง backlog คู่กับ **B-7** (แก้ทีเดียวตอนเปิดเฟสหน้า)
· ระหว่างนี้ **F1 ในรันบุ๊กเป็นข้อความที่ถูกต้อง** ⇒ ให้เชื่อ runbook ไม่ใช่ข้อความท้ายสคริปต์

---

## 3. สิ่งที่ซ้อมนี้ **ไม่** ครอบ

- ไม่ได้พิสูจน์ว่า cron ของลำดับ 5 ทำงาน (คนละ trigger คนละเส้นทาง)
- ไม่ได้พิสูจน์ว่า external pinger ของลำดับ 6 ดังจริง (ดู `phase-39-pinger-runbook.md` ข้อ 5)
- **การซ้อมเอง (ขั้น D–F) ไม่ได้พิสูจน์อะไรเกี่ยวกับ production เลย** — Preview scope ล้วน
  ⚠️ ข้อยกเว้นเดียว: **ขั้น C เป็น gate จริงของ production** (migration + หลักฐาน) ไม่ใช่ prep ของการซ้อม
  ⇒ ผลของ C นับเป็นหลักฐานปิดเฟสได้ · ส่วนแถวอื่นของ post-merge gate ยังต้องทำแยกครบ
  (`CLAUDE.md` § Post-merge gate — server env / provider · FeatureFlag · smoke บน prod)
