# Incident snapshot: QStash region mismatch — dispatch ไม่เคยออกจากระบบ

Date: 2026-08-06 (วินิจฉัย) · เหตุเกิด: 2026-08-05
สถานะ: **วินิจฉัยจบ · ยังไม่แก้** (ข้อ 5 ของแผนต้อง confirm จาก Dev ก่อน)

> 🎯 **เหตุผลที่ต้องมีไฟล์นี้:** พอ fix แล้วเคสนี้ reproduce ไม่ได้อีก แต่มันคือ **test fixture ชิ้นเดียว**
> ที่ตอบได้ว่า *"P2 (readiness) ที่จะออกแบบใน Phase 39 จับเคสนี้ได้จริงไหม"*
> → เกณฑ์ตัดสิน P2: **ถ้า P2 เวอร์ชันที่ออกแบบมา รันกับสภาพใน § 1 แล้วได้ PASS = P2 นั้นใช้ไม่ได้ ต้องออกแบบใหม่**

---

## 1. สภาพ ณ เวลาที่ระบบตายสนิท (สิ่งที่ P2 ต้องจับให้ได้)

| ข้อเท็จจริง | ค่า |
| --- | --- |
| `QSTASH_TOKEN` ตั้งไว้ไหม | ✅ **ตั้งครบ** (len 128) — **และ token ถูกต้อง ใช้งานได้จริง** |
| `QSTASH_CURRENT_SIGNING_KEY` / `NEXT` | ✅ ตั้งครบทั้งคู่ (len 32 ทั้งคู่) |
| `QSTASH_TARGET_BASE_URL` | ✅ `https://acme.gethelpwise.xyz` — **เป็น URL จริง ไม่ใช่ `{slug}` template** |
| `QSTASH_URL` | ❌ **ไม่มีตัวแปรนี้เลย** ← **นี่คือรากของปัญหา** |
| `QSTASH_REGION` | ❌ ไม่มี (ถูกต้องแล้ว — ดู § 4 ว่าทำไมห้ามใส่) |
| `EMAIL_PROVIDER` | ❌ **ไม่มีตัวแปรนี้ใน `.env` เลย** (มีแค่ `EMAIL_FROM_ADDRESS`) → ชั้นซ้อนที่รู้อยู่แล้ว ยังไม่ได้ตรวจฝั่ง Vercel |
| ผลลัพธ์ต่อระบบ | **ตายสนิท** — 3 feature (webhooks / outbound email / SLA sweep) |

> 🔴 **จุดตายของ "เช็คว่า env มีค่า":** ตารางข้างบนคือสภาพตอนระบบตาย — **env ทุกตัวที่โค้ดอ่านมีค่าครบและถูกต้อง**
> gate ที่ตรวจ "ตัวแปรมีค่าไหม / สะกดถูกไหม / ไม่ว่างไหม" จะให้ **PASS ทั้งหมด**
> ตัวแปรที่ผิดคือ **ตัวที่ไม่มีอยู่และไม่มีใครรู้ว่าต้องมี** (`QSTASH_URL`) → **enumerate ตัวแปรที่รู้จักไม่มีทางจับได้**
> ⇒ **P2 ต้องเรียก provider จริง** ไม่มีทางอื่น

## 2. หลักฐานดิบ

### 2.1 error string เต็ม (ไม่ redact)

```
{"error":"user (edd61e81-4b03-406a-b7b0-31b109534581) not found in this region (eu-central-1). Check that you are using the correct endpoint. Learn more: https://upstash.com/docs/qstash/howto/multi-region"}
```

- HTTP status = **`404`**
- `edd61e81-4b03-406a-b7b0-31b109534581` = Upstash user id (**identifier ไม่ใช่ credential** — ปรากฏใน error response อยู่แล้ว)
- ตรงกับ error ที่ `webhook-dispatch.ts` log บน prod เมื่อ 2026-08-05 ทุกตัวอักษร

### 2.2 probe ตรง ๆ (read-only · 2026-08-06)

ยิงด้วย `QSTASH_TOKEN` จาก `.env` เครื่อง (= ชุดเดียวกับ prod):

| endpoint | ผล |
| --- | --- |
| `https://qstash.upstash.io/v2/schedules` (default = EU) | ❌ `404` + error § 2.1 |
| `https://qstash.upstash.io/v2/topics` | ❌ `404` + error § 2.1 |
| **`https://qstash-us-east-1.upstash.io/v2/schedules`** | ✅ **`200`** · body `[]` |
| `https://qstash-us-east-1.upstash.io/v2/topics` | ✅ `200` · `[]` |
| `https://qstash-us-east-1.upstash.io/v2/queues` | ✅ `200` · `[]` |
| `https://qstash-us-east-1.upstash.io/v2/dlq` | ✅ `200` · `{"messages":[]}` |

⇒ **token ใช้ได้สมบูรณ์ — แค่คุยผิดปลายทาง**

### 2.3 signing key ของฝั่ง worker — พิสูจน์แล้วว่าตรง (read-only · 2026-08-06)

`GET https://qstash-us-east-1.upstash.io/v2/keys` → **`200`** เทียบด้วย sha256 12 ตัวแรก (ไม่มีค่าจริงหลุด):

| key | API (us-east-1) | `.env` เครื่อง | ผล |
| --- | --- | --- | --- |
| `current` | `f979dbf734b1` | `f979dbf734b1` | ✅ **ตรง** |
| `next` | `68461172d9e1` | `68461172d9e1` | ✅ **ตรง** |

**ทำไมต้องตรวจข้อนี้ทั้งที่ "ไม่ได้ย้ายบัญชี":** ฝั่ง worker **ไม่เคยถูกพิสูจน์เลยตั้งแต่ Jun 21** —
publish ไม่เคยออก → `/api/jobs/webhook-deliver` ไม่เคยถูกเรียก → signature verification ไม่เคยรันสักครั้ง
เหตุผล *"ไม่ได้ย้ายบัญชี → คีย์ยังถูก"* ตั้งอยู่บนสมมติฐานว่าคนที่ตั้งค่าเมื่อ Jun 21 หยิบคีย์จากบัญชี US เดียวกัน
— **ซึ่งคนคนนั้นเพิ่งพิสูจน์แล้วว่าหยิบ endpoint ผิด region มาแต่แรก** จึงใช้เป็นสมมติฐานไม่ได้
ถ้าคีย์ไม่ตรง อาการหลัง redeploy = **worker `401`** = "ย้ายปัญหา ไม่ได้แก้" + เสีย redeploy รอบสองฟรี ๆ

**ทำไมการเทียบกับ `.env` เครื่องมีความหมายจริง (ไม่ใช่ inference อีกแล้ว):**
probe § 2.2 ยิงด้วย token จาก `.env` เครื่อง (ไม่ผ่าน Vercel เลย) แล้วได้ error **user id เดียวกันเป๊ะ**
กับที่ prod log ไว้ ⇒ **`.env` เครื่องกับ Vercel เป็น QStash ชุดเดียวกันจริง** — เดิมเป็นการอนุมาน ตอนนี้มีหลักฐาน

⚠️ **residual ที่เหลือ (เล็กแต่ต้องพูด):** หลักฐานข้างบนพิสูจน์ตรงตัวว่า *`.env` = บัญชี US* และ *token ของ Vercel = token ของ `.env`*
การขยายไปถึง *signing key ของ Vercel = ของ `.env`* ยังเป็น inference อีก 1 ขั้น
→ ปิดได้ฟรีถ้าต้องการ: Dev copy ค่าจาก Vercel มา `shasum -a 256 | head -c 12` เองแล้วเทียบกับ 2 ค่าในตาราง

### 2.4 แถว DB บน prod (read-only · 2026-08-06)

```
WebhookDelivery: 1 แถวทั้งตาราง
  id            cmsga0l0q000404jrg5fkwbdu
  tenant        acme
  endpointId    cmsg9y3yr000004jltuk8blp1
  eventType     TICKET_CREATED
  status        PENDING
  attemptCount  0          ← worker ไม่เคยเขียน DB
  lastAttemptAt null       ← worker ไม่เคยถูกเรียก
  responseStatus null
  errorMessage  null       ← ไม่มีร่องรอย error ฝั่ง delivery เลย
  createdAt     2026-08-05T09:03:17.738Z

WebhookEndpoint: 1 แถว (acme · cmsg9y3yr000004jltuk8blp1 · createdAt 09:01:22.324Z)  ← ยังอยู่ (ตั้งใจ ดู § 5)
status counts: PENDING=1  (ไม่มี FAILED/DEAD/SUCCEEDED เลย)
```

ตรงกับตัวชี้ขาดที่ handoff Phase 38 ทำนายไว้เป๊ะ: `PENDING + attemptCount=0 + lastAttemptAt IS NULL` = **worker ไม่เคยถูกเรียก** (ถ้าถูกเรียกแล้วล้มจะเป็น `FAILED`/`DEAD` + `errorMessage` เสมอ)

## 3. Root cause (ยืนยันแล้ว ไม่ใช่สมมติฐาน)

**บัญชี Upstash อยู่ region `US_EAST_1` แต่ SDK ยิงไป `EU_CENTRAL_1`**

กลไกจาก source ของ `@upstash/qstash@2.11.1` (`chunk-T3Z5YUS4.mjs`):

```js
var DEFAULT_QSTASH_URL = "https://qstash.upstash.io";   // = EU
// ...
baseUrl: config?.baseUrl ?? defaultCreds.QSTASH_URL ?? DEFAULT_QSTASH_URL
```

`src/lib/queue.ts:242` เรียก `new Client({ token })` — **ส่งแต่ `token` ไม่ส่ง `baseUrl`**
→ ตกไปที่ `process.env.QSTASH_URL` → **ไม่มีตัวแปรนี้** → ตกไปที่ default = **EU** → publish ถูกปฏิเสธ 404

### สมมติฐานที่ถูกตัดทิ้งแล้ว (จากแผน review ของ Dev)
- ~~(ข) token เสียหายตอน paste เข้า Vercel~~ — **ตัดทิ้ง** token จาก `.env` เครื่อง (ไม่ผ่าน Vercel เลย) ให้ error เดียวกันเป๊ะ
- ~~(ค) token ผิดชนิด (หยิบ REST token ของ Redis)~~ — **ตัดทิ้ง** token เดียวกันได้ `200` ที่ endpoint US
- ⇒ เหลือ **(ก) region mismatch** ทางเดียว **และเป็นที่ปลายทาง ไม่ใช่ที่ credential**

## 4. สิ่งที่ handoff Phase 38 เขียนไว้ผิด — ห้ามทำตาม

| handoff เขียนว่า | ข้อเท็จจริง |
| --- | --- |
| "ออก `QSTASH_TOKEN` ใหม่จากบัญชีปัจจุบัน" | ❌ **ไม่จำเป็นเลย** — token เดิมใช้ได้ 100% การออกใหม่คือความเสี่ยงที่สร้างขึ้นเปล่า ๆ |
| "⚠️ ต้องเปลี่ยน `QSTASH_CURRENT/NEXT_SIGNING_KEY` ให้เป็นชุดเดียวกับ token" | ❌ **ห้ามแตะ** — **พิสูจน์ด้วย `GET /v2/keys` แล้วว่าตรงทั้งคู่ (§ 2.3)** ไม่ใช่แค่อนุมานจาก "ไม่ได้ย้ายบัญชี" |
| "`QSTASH_TARGET_BASE_URL` อาจยังเป็น `{slug}` template" | ❌ ไม่จริง — เป็น URL จริงอยู่แล้ว (§ 1) |
| "อาจต้องแก้โค้ดเพราะไม่ได้ตั้ง `baseUrl`" | ❌ **ไม่ต้องแก้โค้ด** — `QSTASH_URL` env ครอบได้ (§ 3) |

### ⛔ ห้ามใช้ `QSTASH_REGION` (migration mode)
SDK จะเปลี่ยนไปอ่าน **ตัวแปร prefix ทั้งชุด** (`US_EAST_1_QSTASH_URL`, `US_EAST_1_QSTASH_TOKEN`,
`US_EAST_1_QSTASH_CURRENT_SIGNING_KEY`, `US_EAST_1_QSTASH_NEXT_SIGNING_KEY`)
และในโหมดนั้น **`token` ที่โค้ดส่งเข้า `new Client({token})` จะถูก override ทิ้ง** (return ก่อนถึง fallback)
→ ตั้งครึ่ง ๆ กลาง ๆ = พังหนักกว่าเดิม · **`QSTASH_URL` ตัวเดียวคือทางที่แคบและปลอดภัยที่สุด**

## 5. ผลข้างเคียงที่เจอระหว่างทาง (ไม่ใช่เรื่องเดียวกัน)

### 5.1 🔴 SLA sweep ไม่มี schedule อยู่จริง — เป็นบั๊กคนละตัว
`GET /v2/schedules` ที่ endpoint **ที่ถูก** (US, `200`) → **`[]` ว่างเปล่า**
⇒ schedule ที่ควรชี้ `/api/jobs/sla-sweep` **ไม่เคยถูกสร้าง** ไม่ใช่ "สร้างแล้วแต่ยิงไม่ออก"
⇒ **แก้ `QSTASH_URL` แล้ว SLA sweep จะยังไม่ทำงาน** — ต้องสร้าง schedule เป็นงาน ops แยก
⇒ และ **"ไม่เห็น invocation หลัง fix" ไม่ใช่สัญญาณเรื่อง token เลย** — ห้ามใช้ verify การแก้ครั้งนี้

### 5.2 DLQ / queues / topics ว่างทั้งหมด
ไม่มี message ตกค้างฝั่ง QStash → **ไม่มีอะไรให้กู้** ของค้างมีแค่แถว `PENDING` ใน DB ของเราเอง

### 5.3 endpoint + delivery `PENDING` — ยังไม่ลบ (ตั้งใจ)
เป็น **เครื่องมือวัดผลชิ้นเดียว** ที่พิสูจน์ว่า fix ได้ผลจริง (replay → ต้องได้ `SUCCEEDED`)
ความเสี่ยง = **ศูนย์จริง** — bin ไม่เคยได้รับ payload สักครั้ง (§ 2.4: `attemptCount=0`)
⏰ **deadline: bin ที่ webhook.site หมดอายุเอง ~7 วัน → ~2026-08-12** เลยจากนั้นต้องทำ § 4-2 ใหม่ทั้งชุด

## 6. Backlog ที่เกิดจากเคสนี้

- [ ] **ไม่มี sweep/cron เก็บ `WebhookDelivery` ที่ค้าง `PENDING`** — แก้ QStash แล้วของค้างไม่หายเอง
      ต้อง replay ด้วยมือทีละอัน · วันนี้มี 1 อันเลยไม่เจ็บ แต่ต้องเป็นงานแยกก่อนจะสะสม
- [ ] **สร้าง QStash schedule ของ SLA sweep** (§ 5.1) — งาน ops แยก
- [ ] **ตรวจ `EMAIL_PROVIDER` ฝั่ง Vercel** — `.env` เครื่องไม่มีเลย → คาดว่า prod ก็ไม่มี (ชั้นซ้อน)
- [ ] **P2 ต้อง probe provider จริง** — ดูเกณฑ์ตัดสินหัวไฟล์

## 7. เกณฑ์ verify หลังแก้ (สัญญาณสะอาดเรียงจากมากไปน้อย)

1. **webhooks** — replay delivery `cmsga0l0q000404jrg5fkwbdu` → ต้องได้ `SUCCEEDED` · fail-loud อยู่แล้ว ✅ สัญญาณสะอาดสุด
2. **outbound email** — `TicketMessage.emailSentAt` ต้องไม่เป็น `null` ⚠️ ยังถูก confound ด้วย `EMAIL_PROVIDER` จนกว่าจะ probe email provider จริง
3. **SLA sweep** — ⛔ **ใช้ verify การแก้นี้ไม่ได้** (§ 5.1) เป็นงานแยก

## 8. แผนการแก้ + decision ที่ตกลงแล้ว (2026-08-06)

### 8.1 การแก้ = ตัวแปรเดียว

```
QSTASH_URL = https://qstash-us-east-1.upstash.io      # Vercel · Production
```
**ไม่แตะ** `QSTASH_TOKEN` · `QSTASH_CURRENT/NEXT_SIGNING_KEY` (§ 2.3 พิสูจน์แล้ว) · `QSTASH_TARGET_BASE_URL`
⛔ **ห้ามใช้ `QSTASH_REGION`** (§ 4)

**ความเสี่ยงของการแก้นี้ = ศูนย์:** ตอนนี้ **ไม่มีอะไรทำงานผ่าน QStash อยู่เลย** (publish ไม่เคยออกสักครั้ง ·
schedule ว่าง · DLQ/queues/topics ว่าง) ⇒ **ไม่มี regression ให้เสีย · worst case คือเท่าเดิม**

### 8.2 Decision: ห้ามรวบ env หลายตัวใน redeploy รอบเดียว (ถอนคำแนะนำเดิม)

คำแนะนำ *"รวม env ให้ครบแล้ว redeploy รอบเดียว"* ใน handoff Phase 38 **ใช้ได้เฉพาะตอนที่ทุกตัวเป็นส่วนของ
การแก้เดียวกันที่วินิจฉัยเสร็จแล้ว** ตอนนี้ไม่ใช่:
- `QSTASH_URL` = การแก้ที่ **ยืนยันแล้ว** (root cause ชัด · ค่าที่ถูกรู้แน่)
- `EMAIL_PROVIDER` = **บั๊กคนละตัวที่ยังไม่รู้ค่าที่ถูก** (ยังไม่ตัดสินด้วยซ้ำว่าจะใช้ provider ไหน key อยู่ไหน)

> 🔑 **หลักที่ได้จากเคสนี้: เอาของที่ยังไม่ verify ไปปนกับของที่ verify แล้ว = ทำลายสัญญาณของ verify**
> ถ้าแก้พร้อมกันแล้ว replay ยังไม่ผ่าน จะแยกไม่ออกว่าเป็นเพราะอะไร

เช่นเดียวกัน **SLA schedule สร้างหลัง verify ผ่าน** — สร้างก่อน = เพิ่มตัวแปรที่สองในรอบที่ควรมีตัวแปรเดียว

### 8.3 แก้นิยาม "verify by effect" ให้ทำได้จริง

`CLAUDE.md` § Post-merge gate สั่งให้ตรวจที่ชั้นเดียวกับที่ค่าถูกใช้จริง — สำหรับ **runtime env**
**ไม่มี artifact ให้สแกน** (ต่างจาก `NEXT_PUBLIC_*` ที่ `scan:bundle` ได้)
⇒ **"verify by effect" กับ "verify feature" เป็นขั้นเดียวกัน ไม่ใช่สองขั้น**
การประดิษฐ์ขั้น "ยืนยันว่า deployment ถือค่าใหม่" แยกออกมา = **กับดัก "ตรวจผิดชั้น" ของ `CLAUDE.md` เอง** (คนละทิศ)

สิ่งที่ตรวจได้จริงและควรตรวจเพิ่ม: **deployment ใหม่ถูก promote เป็น production alias จริงไหม** — ไม่ใช่แค่ขึ้น `Ready`

### 8.4 ลำดับที่เหลือ

| # | งาน | สถานะ |
| --- | --- | --- |
| 1 | `GET /v2/keys` + เทียบ hash | ✅ **เสร็จ — ตรงทั้งคู่** (§ 2.3) |
| 2 | ตั้ง `QSTASH_URL` → redeploy → ยืนยัน production alias | ⏸️ **รอ confirm จาก Dev** |
| 3 | verify: replay delivery `cmsga0l0q000404jrg5fkwbdu` → ต้องได้ `SUCCEEDED` | ⏳ |
| 4 | สร้าง QStash schedule ของ SLA sweep + verify invocation | ⏳ (หลังข้อ 3) |
| 5 | เก็บกวาด endpoint + bin | ⏳ ⏰ ~2026-08-12 |
| 6 | ปิด gate Phase 36 + อัปเดต handoff / project-plan | ⏳ |
| 7 | backlog: `EMAIL_PROVIDER` · sweep เก็บ `PENDING` ค้าง | ⏳ |

**นิยาม "เสร็จ" ของงานนี้:** § 4-2 ผ่าน → ตารางหลักฐาน Phase 36 ครบตาม runbook § 5 → **ปิด gate Phase 36** →
อัปเดต handoff + project-plan → จด backlog
⚠️ **แก้ QStash เสร็จยังไม่ใช่เสร็จ ถ้ายังไม่ปิด gate**

---

## References
- Handoff: `.claude/handoffs/phase-38-gate-hardening-merged-2026-08-05.md`
- Runbook: `.claude/specs/phase-38-webhooks-flag-runbook.md` (§ 4-2 ข้อ 4 แก้ให้เป็นเงื่อนไขแล้ว 2026-08-06)
- Upstash multi-region: https://upstash.com/docs/qstash/howto/multi-region
- โค้ดที่เกี่ยว: `src/lib/queue.ts:242` · `src/lib/webhook-dispatch.ts:128,149,164`
