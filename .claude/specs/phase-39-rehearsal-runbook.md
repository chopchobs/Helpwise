# Phase 39 ลำดับ 7 — Rehearsal runbook (ซ้อม reproduce incident §2.3 บน Preview)

> **สถานะ: เตรียมไว้แล้ว ยังไม่รัน** — สคริปต์ + workflow พร้อม แต่รันไม่ได้จนกว่างานมือของ Dev จะครบ
> รัน: GitHub → Actions → **Readiness Rehearsal (Preview)** → Run workflow
> (พิมพ์ `REHEARSE` + URL ของ Preview deployment)

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

- [ ] **A1. push branch `feature/phase-39-server-env-readiness` ขึ้น remote**
      ยืนยัน: `git log --oneline origin/feature/phase-39-server-env-readiness -1` ตรงกับ local
- [ ] **A2. รอ Vercel สร้าง Preview deployment ของ branch นี้จนสถานะ Ready**
      ยืนยัน: Vercel → Deployments → เห็น deployment ของ branch นี้ สถานะ **Ready**
      **จด URL ของ deployment ไว้** (รูปแบบ `https://helpwise-<hash>-<scope>.vercel.app`)

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

#### C0. ❓ ตอบก่อน: `DATABASE_URL` ถูก scope แยกหรือไม่

Vercel → Project Settings → Environment Variables → ดูรายการ `DATABASE_URL` / `DIRECT_URL`

- [ ] **จดผลลงที่นี่:** `DATABASE_URL` มีกี่แถว และ scope อะไรบ้าง (Production / Preview / Development)

⚠️ **ห้ามเดา** — ทั้งสองกรณีเป็นไปได้ และเช็คลิสต์ต่างกัน:

| กรณี | ความหมาย | ต้องทำ |
| --- | --- | --- |
| **กรณี 1 — ค่าเดียวใช้ทุก scope** | Preview ใช้ DB ตัวเดียวกับ production | apply **ครั้งเดียว** · verify ครั้งเดียว · ทำ C1 ชุดเดียว |
| **กรณี 2 — แยก Production / Preview** | Preview มี DB ของตัวเอง | **apply สองที่ · verify สองที่** · ทำ C1 ครบทั้งสองชุด ⛔ ข้ามชุดใดชุดหนึ่งไม่ได้ — ข้าม Preview = ซ้อมได้ `INVALID` · ข้าม Production = gate ปิดไม่ได้ |

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

#### C2–C4 — env ของ probe

- [ ] **C2. ตั้ง `READINESS_PROBE_TOKEN` บน Vercel — scope ที่ Preview เห็น**
      ยืนยัน: หลัง C4 ยิง probe แล้วได้ shape เต็ม (มี `components`) ไม่ใช่ `401`
- [ ] **C3. ตั้ง `READINESS_PROBE_TOKEN` เป็น GitHub secret ค่าเดียวกัน**
      ยืนยัน: เห็นชื่อในรายการ secret
- [ ] **C4. redeploy Preview หลังตั้ง env**
      ⚠️ env ที่เพิ่งตั้งไม่มีผลกับ deployment เดิม — ต้อง redeploy เสมอ
      ยืนยัน: deployment ใหม่สถานะ Ready · **จด URL ใหม่** (URL เปลี่ยนทุก deployment)

### ขั้น D — จัดฉาก incident

> 🔴 **ขั้น D1 คือคลิกที่อันตรายที่สุดของทั้งเฟส**
> พลาดไปโดน Production scope = **สร้าง incident 7 สัปดาห์ของ Phase 38 ขึ้นมาใหม่ด้วยมือ**
> และทำตอนที่ **ระบบเตือนที่สร้างมาทั้งเฟสยังไม่ merge** ⇒ ไม่มีอะไรจับให้เลย
> ⇒ สามข้อล่างเป็น **ขั้นบังคับ** ไม่ใช่ความระมัดระวังส่วนตัว

- [ ] **D0. แคป env ของ Production ก่อนแตะอะไรทั้งสิ้น**
      Vercel → Project Settings → Environment Variables → กรอง scope = **Production**
      ถ่ายภาพหน้าจอ/คัดรายชื่อตัวแปรทั้งหมดเก็บไว้ **นอก Vercel**
      (ไฟล์นี้คือหลักฐานชิ้นเดียวที่บอกได้ว่า "ก่อนหน้านี้มีอะไรบ้าง" — ไม่มี = พิสูจน์ไม่ได้ว่าไม่ได้ทำพัง)
- [ ] **D1. ลบ `QSTASH_URL` ออกจาก Vercel env — เฉพาะ Preview scope**
      ⛔ **ห้ามแตะ Production scope เด็ดขาด** · ก่อนกดลบ อ่าน scope ที่ติดอยู่กับแถวนั้นออกเสียงหนึ่งรอบ
- [ ] **D1b. แคป env ของ Production อีกครั้ง แล้ว *เทียบกับ D0* ว่าเหมือนกันทุกตัว**
      ✅ ผ่านเมื่อ: รายการ Production **ไม่เปลี่ยนเลยแม้แต่ตัวเดียว** — โดยเฉพาะ `QSTASH_URL` ยังอยู่
      ⚠️ นี่คือ verify-by-effect: "ผมกดที่แถวของ Preview" เป็นเจตนา **ไม่ใช่หลักฐาน**
      ⛔ ถ้าไม่เหมือน → **หยุดทันที ตั้งค่ากลับจาก D0 ก่อนทำอย่างอื่น** ห้ามเดินต่อไป D2
- [ ] **D2. redeploy Preview อีกครั้ง (ให้ env ใหม่มีผล)**
      ยืนยัน: Ready · **จด URL ล่าสุด** — อันนี้คือ URL ที่จะใส่ตอนกด workflow

### ขั้น E — ซ้อม

- [ ] **E1. GitHub → Actions → Readiness Rehearsal (Preview) → Run workflow**
      ใส่ `preview_url` = URL จาก D2 · `confirm` = `REHEARSE`
- [ ] **E2. อ่านผล**
      - `PROVEN` ✅ → ไปขั้น F
      - `INCONCLUSIVE` → bypass secret ผิด หรือ Preview ยังไม่ขึ้น → กลับไป B/A
      - `INVALID` → prerequisite ไม่ครบ (มักคือ **C1**) → กลับไปแก้ **ห้ามนับผ่าน**

### ขั้น F — 🔴 คืนสภาพ (ห้ามข้าม)

- [ ] **F1. ตั้ง `QSTASH_URL` กลับคืน Preview scope**
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
