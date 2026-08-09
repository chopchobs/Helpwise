# Phase 39 — ตารางหลักฐานปิดเฟส

> เอกสารนี้คือ **"ตารางหลักฐาน external resource"** ตามที่ `CLAUDE.md` § Post-merge gate บังคับไว้
> — *"ไม่ใช่ checkbox ของเจตนา"*
>
> 🔴 **กฎเดียวของไฟล์นี้: ห้ามเติมช่องที่ยังไม่มีผลด้วยเจตนา**
> ไม่มีผล = **เว้นว่างไว้** · ช่องว่างที่ซื่อสัตย์อ่านง่ายกว่าช่องที่เต็มด้วยความตั้งใจ
> และ *"ตั้งใจจะทำ"* ที่ถูกเขียนลงช่องหลักฐาน จะอ่านเหมือน *"ทำแล้ว"* ในอีกสามสัปดาห์

**สถานะ:** 🔄 **ยังปิดไม่ได้** — มีแถวที่ยังว่าง (ดูตารางที่ 2)
**อัปเดตล่าสุด:** 2026-08-09

---

## 1. แถวที่มีผลแล้ว ✅

| # | resource | วิธีตรวจบน prod | ผลที่ได้ | วันที่ |
| --- | --- | --- | --- | --- |
| 1 | **migration row** | `select migration_name, finished_at, rolled_back_at from _prisma_migrations where migration_name = '20260808000000_add_readiness_heartbeat'` | `finished_at` ไม่ null · `rolled_back_at` เป็น null | 2026-08-09 |
| 2 | **migration effect** (ไม่ใช่แค่แถวใน `_prisma_migrations`) | `select table_name from information_schema.tables where table_schema='public' and table_name in ('MechanismHeartbeat','ReadinessState')` | **2 แถว** | 2026-08-09 |
| 3 | **เศษ integration test บน prod** (6 ตาราง) | query `xtfk\_%` ทั้ง 6 ตาราง — เก็บไว้ที่ rehearsal runbook **C1e** | `Tenant` 0 · `User` 0 · `Contact` 0 · `TenantMember` 0 · `Ticket` 0 · `TicketMessage` 0 | 2026-08-09 |
| 4 | **Vercel Deployment Protection** | `get_project_deployment_protection` (อ่านค่า setting ตรง ๆ ไม่ใช่อนุมาน) | `ssoProtection.enabled=true` · `deploymentType=`**`all_except_custom_domains`** · `passwordProtection=false` · `trustedIps=false` | 2026-08-09 |
| 5 | **rehearsal — ตัวสคริปต์ + probe** | `npx tsx scripts/readiness-rehearsal.ts` ยิง Preview ของ `c5c17f0` | **`PROVEN`** — `FAIL` + signature `not found in this region (eu-central-1)` | 2026-08-09 |
| 6 | **ตัวกรอง `deployment_status` ของลำดับ 5** | อ่าน run history ของ *Readiness (P2)* บน GitHub Actions | trigger 4 ครั้งจาก Preview → **`Skipped` ทั้ง 4** ตาม `if` ที่ `readiness.yml:54-57` (`success && Production`) | 2026-08-09 |

### หมายเหตุที่ต้องอ่านคู่กับตาราง

- **แถว 5 ครอบเฉพาะ *สคริปต์* ไม่ใช่ *workflow*** — ดูแถว A ของตารางที่ 2 (§G ข้อ 12)
- **แถว 5 ยืนยันแถว 1–2 ซ้ำโดยอ้อม:** ถ้าตารางยังไม่ถูก apply → `readMechanismHeartbeats()` โยน →
  stage `[probe]` → คืน component เดียว → **ไม่มี qstash signature** → ต้องได้ `INVALID`
  ⇒ **การได้ signature = แอปอ่าน `MechanismHeartbeat` บน prod DB ได้จริง**
- **แถว 4 เป็น "ค่า ณ 2026-08-09"** ไม่ใช่การรับประกัน — ไม่มีอะไรเฝ้าว่ามันเปลี่ยน (§G ข้อ 7 · backlog B-4)

---

## 2. แถวที่ยังว่าง — **ยังปิดเฟสไม่ได้จนกว่าจะครบ** ⬜

| # | resource | วิธีตรวจ | ผลที่ถือว่าผ่าน | ผล |
| --- | --- | --- | --- | --- |
| A | **workflow ของลำดับ 7** (`confirm=REHEARSE` · secrets ผ่าน Actions · `npm ci` · step ordering) | **หลัง merge** — dispatch *Readiness Rehearsal (Preview)* หนึ่งครั้ง | workflow รันจบโดยชั้น `confirm` ทำงานถูก | ⬜ |
| B | **ขั้น F — คืนสภาพ** | F1 (ลบแถว branch-scoped ที่สร้างใน D1 ทาง A) → F2 redeploy → **F3** | **F3 ต้องได้ผลที่ *ไม่ใช่* `PROVEN`** · และ body ต้องเป็น `"source":"live"` (กฎที่ 0) | ⬜ |
| C | **ลำดับ 6 — external pinger** | ตั้ง monitor + พิสูจน์ว่าดังจริง (`phase-39-pinger-runbook.md` ข้อ 5) | pinger แจ้งเตือนถึงปลายทางจริง · **ปลายทางคนละช่องกับ Slack ของลำดับ 5** | ⬜ |
| D | **smoke ของจริงบน prod** | เรียก `/api/health/readiness` บนโดเมน production หลัง merge อย่างน้อย 1 path | ได้ marker + สถานะที่อ่านได้ (ไม่ใช่ `302`/SSO page) | ⬜ |
| E | **cron รอบแรกหลัง merge เขียนทับ `ReadinessState`** | §F: ห้ามเชื่อค่าในตารางจนกว่า cron รอบแรกจะเขียน | `lastCheckAt` ขยับหลัง Run workflow | ⬜ |

> ⚠️ **แถว C มีเงื่อนไขพิเศษ:** ถ้าปิดด้วย **วิธี B** (ทดสอบ keyword) อย่างเดียว
> **ต้องบันทึกใน §G ว่าเคส `STALE` จริงยังไม่เคยถูกพิสูจน์ end-to-end** — ไม่ใช่ติ๊กผ่านเฉย ๆ
>
> ⚠️ **แถว E ผูกกับ §G ข้อ 9** — `ReadinessState` ไม่มี scope ของ environment และ Preview
> เขียนทับได้ (DB ตัวเดียวกัน) ⇒ ค่าที่ค้างอยู่ตอนนี้อาจเป็นของการซ้อม

---

## 3. ข้อจำกัดที่รู้ตัว — **ต้องอ่านคู่กับตารางทั้งสอง**

ตารางด้านบนบอกว่า *"อะไรถูกพิสูจน์แล้ว"* — ส่วนนี้บอกว่า **"อะไรที่พิสูจน์ไม่ได้ และรู้ตัวว่าพิสูจน์ไม่ได้"**
ทั้งหมดมีต้นทางอยู่ใน erratum §G · ไม่คัดเนื้อมาซ้ำที่นี่

| ข้อ | สาระย่อ |
| --- | --- |
| §G ข้อ 9 | `ReadinessState` ไม่มี scope ของ environment — Preview เขียนทับสถานะของ prod ได้ (backlog B-3) |
| §G ข้อ 10 | env ที่เป็น `Sensitive` **ตรวจ "ค่า" ไม่ได้** — verify ได้แค่ระดับแถว/scope ⇒ D1b อ่อนกว่าที่ตั้งใจ |
| §G ข้อ 11 | min-interval ทำให้ผลซ้อมอ่านผิดได้ถ้าไม่ดู `source` — **กฎบังคับด้วยคน** (backlog B-7 · §H-10) |
| §G ข้อ 12 | workflow ของลำดับ 7 ยังไม่เคยถูกรัน — พิสูจน์แล้วเฉพาะสคริปต์ (= แถว A ด้านบน) |
| §G ข้อ 7 | ไม่มีอะไรเฝ้าว่าโหมด Deployment Protection เปลี่ยน (backlog B-4) |
| §G ข้อ 8 | ไม่มีการเตือนแบบไล่ระดับระหว่างสองชั้น (ผลของ §H-7) |

---

## 4. อ้างอิง

- ลำดับงาน + gate: `phase-39-design-doc-v2.1-errata-2026-08-08.md` **§E / §F / §G / §H**
- ขั้นตอนการซ้อม + ผลดิบ: `phase-39-rehearsal-runbook.md`
- ลำดับ 6: `phase-39-pinger-runbook.md`
- หนี้ที่ยกไป Phase 40: `backlog-2026-08-08.md` (**B-1** · B-3 · B-4 · B-5 · B-6 · B-7)
