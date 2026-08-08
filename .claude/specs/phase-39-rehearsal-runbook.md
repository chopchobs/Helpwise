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

### ขั้น C — 🔴 ทำให้ Preview อยู่ในสภาพที่ probe ทำงานได้จริง

> **ขั้นนี้คือข้อที่ยังไม่มีใครเขียนไว้ในดีไซน์เดิม — และเป็นข้อที่ทำให้ซ้อมอ่านผิดได้ง่ายที่สุด**

- [ ] **C1. `prisma migrate deploy` ต้องถูก apply กับ DB ที่ Preview ใช้**
      ⚠️ migrate **ไม่ได้อยู่ใน build pipeline** (ตรวจแล้ว — erratum §F · backlog B-2)
      ⇒ deploy สำเร็จได้โดยที่ตาราง `MechanismHeartbeat` / `ReadinessState` ยังไม่มี
      **ถ้าไม่ทำข้อนี้:** probe จะ `FAIL` เพราะอ่านตารางไม่ได้ ⇒ ได้ `INVALID`
      (สคริปต์จับให้ — แต่ถ้าเกณฑ์เป็นแค่ "FAIL" จะอ่านผิดว่าซ้อมสำเร็จ)
      ยืนยัน: query `_prisma_migrations` ของ DB นั้นตรง ๆ — `20260808000000_add_readiness_heartbeat`
      มี `finished_at` ไม่ null และ `rolled_back_at` null
      ⛔ **ห้ามเชื่อ `prisma migrate status`** (รายงานผิดเมื่อมี failed migration)
      ❓ **ต้องตอบก่อน:** Preview ใช้ DB ตัวเดียวกับ production หรือไม่
      — ถ้าใช่ ข้อนี้ = apply migration ลง prod จริง ⇒ **เป็นการตัดสินใจของ Dev ไม่ใช่ขั้นตอนอัตโนมัติ**
      (เกี่ยวกับ backlog B-1 โดยตรง)
- [ ] **C2. ตั้ง `READINESS_PROBE_TOKEN` บน Vercel — scope ที่ Preview เห็น**
      ยืนยัน: หลัง C4 ยิง probe แล้วได้ shape เต็ม (มี `components`) ไม่ใช่ `401`
- [ ] **C3. ตั้ง `READINESS_PROBE_TOKEN` เป็น GitHub secret ค่าเดียวกัน**
      ยืนยัน: เห็นชื่อในรายการ secret
- [ ] **C4. redeploy Preview หลังตั้ง env**
      ⚠️ env ที่เพิ่งตั้งไม่มีผลกับ deployment เดิม — ต้อง redeploy เสมอ
      ยืนยัน: deployment ใหม่สถานะ Ready · **จด URL ใหม่** (URL เปลี่ยนทุก deployment)

### ขั้น D — จัดฉาก incident

- [ ] **D1. ลบ `QSTASH_URL` ออกจาก Vercel env — เฉพาะ Preview scope**
      ⛔ **ห้ามแตะ Production scope เด็ดขาด**
      ยืนยัน: ในหน้า Environment Variables เห็นว่า `QSTASH_URL` ยังมีอยู่ที่ Production
      และหายไปจาก Preview
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
- ไม่ได้พิสูจน์อะไรเกี่ยวกับ **production** เลย — Preview scope ล้วน
  ⇒ post-merge gate ของเฟสนี้ยังต้องทำแยกครบทุกแถว (`CLAUDE.md` § Post-merge gate)
