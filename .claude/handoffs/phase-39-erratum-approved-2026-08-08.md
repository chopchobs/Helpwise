# Phase 39 — erratum ผ่านรีวิวแล้ว รอ confirm Deployment Protection ก่อนตัด branch (2026-08-08)

> 📌 **ไฟล์นี้เป็น pointer อย่างเดียว** — เนื้อหาการออกแบบทั้งหมดอยู่ในเอกสารต้นทาง
> **ห้ามคัดข้อความจาก v2 / erratum มาสรุปซ้ำที่นี่** และห้ามเดินงานต่อจากสรุปในไฟล์นี้
> เหตุผล: `incident §8.3` พังเพราะข้อความถูกคัดข้ามเอกสารแล้วมีคนเดินต่อโดยไม่กลับไปดูต้นทาง
> (ดู erratum §B) — **ห้ามทำซ้ำ** · ต้องการรายละเอียดเมื่อไร **เปิดเอกสารต้นทางเสมอ**

---

## สถานะ git

- **main = `c6b63d0`** `docs(spec): erratum v2.1 Phase 39 — แก้ E-1/E-2/E-3 + ปิด open item · ผ่านรีวิวแล้ว`
  · **ยังไม่ push** (`main...origin/main [ahead 1]` ตอนเขียนไฟล์นี้; หลัง commit handoff นี้จะเป็น **ahead 2**) — Dev push เอง
- **ยังไม่ตัด branch · ยังไม่มีโค้ดสักบรรทัด**
- ไฟล์ที่ `c6b63d0` แตะ:

| ไฟล์ | การเปลี่ยนแปลง |
| --- | --- |
| `.claude/specs/phase-39-design-doc-v2.1-errata-2026-08-08.md` | **ไฟล์ใหม่** |
| `.claude/specs/phase-38-qstash-region-incident-2026-08-06.md` | **แทรก blockquote `ERRATUM 2026-08-08` ใน §8.3** (ข้อความเดิมคงไว้ครบ ไม่ลบ) |

---

## ลำดับการอ่านของ session ถัดไป (ห้ามข้าม ห้ามสลับ)

| # | ไฟล์ | อ่านเพื่อ |
| --- | --- | --- |
| 1 | `.claude/specs/phase-39-design-brief-2026-08-06.md` | โจทย์ + เกณฑ์ตัดสิน §8 |
| 2 | `.claude/specs/phase-38-qstash-region-incident-2026-08-06.md` | incident ต้นเรื่อง — **อ่าน §8.3 พร้อม blockquote `ERRATUM 2026-08-08` เสมอ ห้ามอ่านเฉพาะข้อความเดิม** |
| 3 | `.claude/specs/phase-39-design-doc-v2-2026-08-07.md` | design doc v2 (โครงหลัก) |
| 4 | `.claude/specs/phase-39-design-doc-v2.1-errata-2026-08-08.md` | **erratum — override v2 เฉพาะจุดที่ระบุ · จุดที่ไม่ได้พูดถึงยึด v2 เดิม** |

`.claude/specs/phase-39-design-doc-2026-08-07.md` (**v1**) เก็บไว้เป็นประวัติ — **ห้ามลบ ห้ามใช้เป็นฐานงาน**

---

## 🚧 สิ่งเดียวที่บล็อกอยู่

**confirm ค่า Deployment Protection ของ Preview ใน Vercel Project Settings** — เป็นงานของ Dev ทำไม่ได้จากรีโป

| ผล confirm | ต้องทำอะไรต่อ |
| --- | --- |
| **ปิดอยู่** | erratum **§B(ค) ตกทั้งข้อ** + **blockquote erratum note ใน incident §8.3 ต้องแก้ตาม** |
| **เปิดอยู่** | ใช้ **ทาง A (bypass token)** ตาม erratum §B(ค) |

⚠️ จนกว่าจะ confirm — **Deployment Protection ยังเป็นสมมติฐาน ห้ามเขียน/อ้างเป็นข้อเท็จจริงที่ไหนทั้งสิ้น**

---

## ตัดสินแล้ว — ห้ามรื้อ

1. **ลด scope เหลือ P2** · **P3 + heartbeat per-tenant → Phase 40**
2. **รับ external pinger ฟรี 1 ตัว**
3. **path ของ probe = `/api/health/readiness`** (ไม่แตะ `src/proxy.ts`)
4. **ต้นทุน 12–14 ชม. — ติดป้ายว่าเกินเพดานแล้ว ห้ามเกลี่ยตัวเลขลง**
5. 4 อย่างเดิมจาก v2 ยังไม่รื้อ (hybrid A+B · GitHub Actions เป็น scheduler · transition-only รวม recovery · ประกาศช่องโหว่ 60-day auto-disable) — รายละเอียดที่ erratum §A

---

## ขั้นถัดไป

1. Dev push `c6b63d0` + handoff นี้
2. Dev confirm Deployment Protection (ตารางข้างบน)
3. ตัด branch **`feature/phase-39-server-env-readiness`**
4. **ลำดับงาน 7 ข้อ → erratum §E** · **เช็คลิสต์ implement → erratum §F**
   ⛔ **ห้ามลอกสองส่วนนี้มาไว้ที่ไหนอีก — เปิดอ่านจาก erratum เสมอ**
5. **ทำ P2 เสร็จต้องอัปเดตแถว "server env / provider"** ใน `CLAUDE.md` § Post-merge gate (เป็นข้อหนึ่งใน erratum §F)

---

## ของค้างนอก Phase 39 (ยกมาจาก handoff เดิม — ไม่ขยายความที่นี่)

- **`EMAIL_PROVIDER` ยังไม่เลือก provider** (เริ่มที่การตัดสินใจ ไม่ใช่การตั้ง env)
- **sla-sweep ไม่มี per-tenant checkpoint**
- **design system doc v0.1 ยังไม่เข้ารีโป**
- **`src/app/globals.css`: `--font-sans` เป็น Geist (บรรทัด 94) แต่ `body` ทับด้วย Arial (บรรทัด 101) และ Geist ไม่มี glyph ไทย**
