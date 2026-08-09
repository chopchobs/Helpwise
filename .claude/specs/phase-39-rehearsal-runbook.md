# Phase 39 ลำดับ 7 — Rehearsal runbook (ซ้อม reproduce incident §2.3 บน Preview)

> **สถานะ: เตรียมไว้แล้ว ยังไม่รัน** — สคริปต์ + workflow พร้อม แต่รันไม่ได้จนกว่างานมือของ Dev จะครบ
> รัน: GitHub → Actions → **Readiness Rehearsal (Preview)** → Run workflow
> (พิมพ์ `REHEARSE` + URL ของ Preview deployment)

> 🔴 **อ่านก่อนเริ่ม — `6e70c55` ยังไม่ push (สถานะ ณ 2026-08-09)**
>
> Preview `dpl_584Ys5…` ที่มีอยู่ตอนนี้ build จาก **`277be73`** = **โค้ดก่อนแก้ §H-8**
> ⇒ ถ้าซ้อมด้วย Preview ตัวนี้แล้วได้ `INVALID` มันจะยังรายงานว่า **"redis unavailable"**
> **ตรงจุดที่เพิ่งแก้ให้ชี้ถูกพอดี** ⇒ ตาราง `[stage]` ในขั้น E2 จะใช้ไม่ได้ และจะส่งคนไปแก้ Redis ที่ไม่ได้พัง
>
> ⇒ **push ให้เสร็จก่อนถึง C4** (C4 redeploy อยู่แล้ว — ไม่มีขั้นตอนเพิ่ม แค่ต้องมาก่อน)
> ⛔ อย่าเพิ่งซ้อมด้วย deployment ที่ยังเป็น `277be73`

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
| `PROVEN` | `status = FAIL` **และ** เนื้อ response มี `not found in this region (eu-central-1)` | ✅ ใช่ |
| `INCONCLUSIVE` | อ่าน marker ไม่ได้เลย — ยังไปไม่ถึงโค้ดเรา (bypass token ผิด / Preview ยังไม่ขึ้น) | ❌ **ห้ามนับผ่าน และห้ามนับไม่ผ่าน** |
| `INVALID` | ได้ `FAIL` **แต่ไม่มี error signature ที่คาด** | ❌ **ซ้อมนี้ไม่ได้พิสูจน์อะไร** |

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
- [x] **A2. Vercel สร้าง Preview deployment ของ branch นี้แล้ว สถานะ Ready** — ✅ **2026-08-09**
      หลักฐาน: deployment **`dpl_584Ys5Vdy6gF6f4dkCERRJBPsEvv`** · state **READY**
      · `githubCommitRef` = branch นี้ · sha `277be73` · `githubPrId` 17
      ⚠️ **URL ของ deployment นี้ใช้ซ้ำไม่ได้หลัง C4/D2** — ทุก redeploy ได้ URL ใหม่ ต้องจดใหม่ทุกครั้ง
- [ ] **A3. 🔴 push commit ล่าสุด (`6e70c55` ขึ้นไป) — ขั้นบังคับ ต้องเสร็จ *ก่อน* C4**
      `dpl_584Ys5…` ของ A2 เป็นโค้ดของ `277be73` ซึ่ง **ยังไม่มีการแก้ §H-8**
      ⇒ ซ้อมด้วยมันแล้วได้ `INVALID` จะรายงาน `"redis unavailable"` เหมือนเดิม = **ผลผิดตรงจุดที่เพิ่งแก้**
      ยืนยัน: `git rev-parse HEAD` = `git rev-parse origin/feature/phase-39-server-env-readiness`
      · **แล้ว Preview ที่ใช้ซ้อมต้องเป็น deployment ที่ build จาก sha นั้น** (ไม่ใช่ `277be73`)

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

- [ ] **จดผล:** `DATABASE_URL` (+ `DIRECT_URL`) มีกี่แถว และแต่ละแถวติ๊ก scope อะไรบ้าง

⚠️ **ห้ามเดา** — ทั้งสองกรณีเป็นไปได้ และเช็คลิสต์ต่างกัน:

| กรณี | ความหมาย | ต้องทำ |
| --- | --- | --- |
| **กรณี 1 — ค่าเดียวใช้ทุก scope** | Preview ใช้ DB ตัวเดียวกับ production | apply **ครั้งเดียว** · verify ครั้งเดียว · ทำ C1 ชุดเดียว · ⚠️ **แต่มีผลข้างเคียงด้านล่าง — อ่านก่อน** |
| **กรณี 2 — แยก Production / Preview** | Preview มี DB ของตัวเอง | **apply สองที่ · verify สองที่** · ทำ C1 ครบทั้งสองชุด ⛔ ข้ามชุดใดชุดหนึ่งไม่ได้ — ข้าม Preview = ซ้อมได้ `INVALID` · ข้าม Production = gate ปิดไม่ได้ |

> 🔴 **ผลข้างเคียงของกรณี 1 ที่ต้องรู้ก่อนกดซ้อม — "ง่ายกว่า" ไม่ได้แปลว่า "ปลอดภัยกว่า"**
>
> `writeSnapshot()` upsert แถว `ReadinessState` id `"singleton"` **แถวเดียวทั้งระบบ ไม่มี scope ของ environment**
> (`src/lib/readiness.ts` — และ `recordHeartbeat("readiness-probe")` ก็เป็นแถว global เช่นกัน)
> ⇒ **กรณี 1 = การซ้อมบน Preview เขียนสถานะ `FAIL` ทับแถวเดียวกับที่ endpoint สาธารณะของ production เสิร์ฟ**
>
> **ตอนนี้ blast radius = 0** — verify แล้ว 2026-08-09:
> · route ยังไม่อยู่บน main (`git show main:src/app/api/health/readiness/route.ts` → ไม่มีไฟล์)
> · `schedule:` ของ GitHub Actions รันเฉพาะ default branch ⇒ ชั้นในยังไม่เคยเขียน/อ่านแถวนี้
> ⇒ **หน้าต่างนี้คือช่วงที่ซ้อมปลอดภัยที่สุดที่จะมี** — ซ้อมตอนนี้ ไม่ใช่ตอนหลัง
>
> ⚠️ **หลัง merge ข้อนี้ไม่จริงอีกต่อไป** — ซ้อมซ้ำหลัง merge **ต้องกลับมาอ่านย่อหน้านี้ก่อนเสมอ**
> (ทางแก้จริง = แยก snapshot ตาม environment → **Phase 40** · ⛔ ห้ามแก้ในเฟสนี้ · ดู backlog B-3)

##### C0-b. 🔴 `QSTASH_URL` มี **กี่แถว** และแต่ละแถว scope อะไร

- [ ] **จดผล:** `QSTASH_URL` มีกี่แถว · แถวไหนติ๊ก Production / Preview / Development บ้าง

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
      - [ ] 🔴 **แคป *ค่าเต็ม* ของ `QSTASH_URL` ด้วย ไม่ใช่แค่รายชื่อตัวแปร** (กด Reveal แล้วคัดค่าออกมา)
            เหตุผล: รายชื่อบอกได้แค่ว่า "แถวยังอยู่" — ถ้าค่าถูกแก้ผิด รายชื่อยังเหมือนเดิมทุกประการ
            และเป็น**ทางกลับทางเดียว**ถ้าเกิดพลาดจนแถวหาย

- [ ] **D1. ทำให้ Preview ไม่เห็น `QSTASH_URL` — โดย *แก้ scope* ไม่ใช่ *Delete***
      🔑 **ตัดสิน 2026-08-09: ห้ามใช้ Delete** — Delete เป็น operation ที่กลับคืนด้วยการ**พิมพ์ค่าเดิมใหม่**
      (พิมพ์เอง = ช่องพลาดเพิ่มอีกชั้นตอนคืนสภาพ) และในกรณี ข ยัง**ลบของ Production ไปพร้อมกัน**
      ⇒ **uncheck ช่อง Preview** = reversible ด้วยการติ๊กกลับ ไม่ต้องพิมพ์ค่าใด ๆ

      ทำตามกรณีที่ตอบไว้ใน **C0-b**:

      - [ ] **กรณี ก (2 แถวแยก scope):** เปิดแถวที่ติ๊ก **Preview** → uncheck **Preview** → Save
            ⛔ ห้ามแตะแถวที่ติ๊ก Production เด็ดขาด
      - [ ] **กรณี ข (1 แถวติ๊กสองช่อง):** ตามลำดับนี้ ห้ามสลับ
            1. **ยืนยันค่าเดิม** ที่คัดไว้ใน D0 ว่าตรงกับค่าที่เห็นในแถวนั้น (ถ้าไม่ตรง — หยุด ยังไม่ต้องแก้อะไร)
            2. แก้แถวเดิมให้ **เหลือติ๊กเฉพาะ Production** (uncheck Preview) → Save
            3. ⛔ **ห้ามกด Delete แล้วสร้างใหม่** — ระหว่างสองจังหวะนั้น Production ไม่มีค่านี้อยู่จริง

      · ก่อน Save: อ่าน scope ที่ติ๊กอยู่กับแถวนั้นออกเสียงหนึ่งรอบ
- [ ] **D1b. แคป env ของ Production อีกครั้ง แล้ว *เทียบกับ D0* ว่าเหมือนกันทุกตัว**
      ✅ ผ่านเมื่อ: รายการ Production **ไม่เปลี่ยนเลยแม้แต่ตัวเดียว** — โดยเฉพาะ `QSTASH_URL` ยังอยู่
      **และค่าของมันตรงกับค่าเต็มที่คัดไว้ใน D0 แบบตัวต่อตัว** (กรณี ข ต้องเทียบค่า ไม่ใช่เทียบแค่ว่าแถวยังอยู่ —
      แถวเดียวกันถูกแก้ ⇒ รายชื่อเหมือนเดิมเป๊ะแต่ค่าเพี้ยน)
      ⚠️ นี่คือ verify-by-effect: "ผมกดที่แถวของ Preview" เป็นเจตนา **ไม่ใช่หลักฐาน**
      ⛔ ถ้าไม่เหมือน → **หยุดทันที ตั้งค่ากลับจาก D0 ก่อนทำอย่างอื่น** ห้ามเดินต่อไป D2
- [ ] **D2. redeploy Preview อีกครั้ง (ให้ env ใหม่มีผล)**
      ยืนยัน: Ready · **จด URL ล่าสุด** — อันนี้คือ URL ที่จะใส่ตอนกด workflow

### ขั้น E — ซ้อม

- [ ] **E1. GitHub → Actions → Readiness Rehearsal (Preview) → Run workflow**
      ใส่ `preview_url` = URL จาก D2 · `confirm` = `REHEARSE`
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

> ทำไม 401 ถึงออกมาเป็น `INCONCLUSIVE` ไม่ใช่ `FAIL`: route ตอบ **marker + `error`** โดย**ไม่มี field `status`**
> ⇒ `classifyProbeResponse()` เข้ากฎ *"marker ok but status is not a known value"* ⇒ `INCONCLUSIVE` ถูกต้องตามนิยาม
> · สคริปต์พิมพ์ hint แยกสองทางนี้ให้แล้ว (`scripts/readiness-rehearsal.ts` — `evaluate()`)

### ขั้น F — 🔴 คืนสภาพ (ห้ามข้าม)

- [ ] **F1. คืน `QSTASH_URL` ให้ Preview — โดย *ติ๊ก Preview กลับ* ที่แถวเดิม**
      ⛔ **ห้ามพิมพ์ค่าใหม่ ห้ามสร้างแถวใหม่** — D1 ออกแบบให้คืนด้วยการติ๊กกลับพอดี
      (ถ้าต้องพิมพ์ค่าเอง แปลว่าที่ D1 ไปกด Delete มา ⇒ ใช้ค่าเต็มจาก **D0** แล้วบันทึกว่าเบี่ยงจาก runbook)
- [ ] **F2. redeploy Preview**
- [ ] **F3. ยืนยันว่าคืนแล้วจริง** — กด workflow ซ้ำอีกครั้ง ต้องได้ผล **ไม่ใช่** `PROVEN`
      (ถ้ายังได้ `PROVEN` แปลว่ายังไม่ได้คืนจริง)
      ⚠️ ข้อนี้คือ verify-by-effect — "ตั้งกลับแล้ว" เป็นเจตนา ไม่ใช่หลักฐาน

---

## 3. สิ่งที่ซ้อมนี้ **ไม่** ครอบ

- ไม่ได้พิสูจน์ว่า cron ของลำดับ 5 ทำงาน (คนละ trigger คนละเส้นทาง)
- ไม่ได้พิสูจน์ว่า external pinger ของลำดับ 6 ดังจริง (ดู `phase-39-pinger-runbook.md` ข้อ 5)
- **การซ้อมเอง (ขั้น D–F) ไม่ได้พิสูจน์อะไรเกี่ยวกับ production เลย** — Preview scope ล้วน
  ⚠️ ข้อยกเว้นเดียว: **ขั้น C เป็น gate จริงของ production** (migration + หลักฐาน) ไม่ใช่ prep ของการซ้อม
  ⇒ ผลของ C นับเป็นหลักฐานปิดเฟสได้ · ส่วนแถวอื่นของ post-merge gate ยังต้องทำแยกครบ
  (`CLAUDE.md` § Post-merge gate — server env / provider · FeatureFlag · smoke บน prod)
