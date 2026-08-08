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

⚠️ **residual ที่เหลือ และ "ปิดไม่ได้" ไม่ใช่ "ยังไม่ได้ปิด":** หลักฐานข้างบนพิสูจน์ตรงตัวว่า *`.env` = บัญชี US*
และ *token ของ Vercel = token ของ `.env`* การขยายไปถึง *signing key ของ Vercel = ของ `.env`* ยังเป็น inference อีก 1 ขั้น

🔴 **และ inference ขั้นนี้ปิดด้วยการอ่านไม่ได้เลย** — **env ทุกตัวบน Vercel ติดแท็ก Sensitive = write-only
อ่านค่ากลับไม่ได้** (ข้อจำกัดที่เจอมาแล้วในเฟสก่อน และเป็นเหตุผลที่แผนเทียบ hash กับฝั่ง Vercel ถูกยกเลิก)
⇒ **ไม่มีวิธีตรวจแบบอ่านค่า ไม่ว่าจะใช้เวลาเท่าไร** · ทางเดียวที่เหลือคือ **runtime probe** — ปล่อยให้ worker
ทำงานจริงแล้วดูผล: **`401` = คีย์ไม่ตรง · `SUCCEEDED` = คีย์ตรง** (detection ฟรีและทันที ดู § 8.2)

> 📌 **ข้อจำกัดนี้สำคัญต่อการออกแบบ P2 ใน Phase 39** — บนแพลตฟอร์มนี้ *"ตรวจค่า env ว่าถูกไหม" เป็นไปไม่ได้เชิงโครงสร้าง*
> ไม่ใช่แค่ไม่สะดวก ⇒ **runtime probe ไม่ใช่ "ทางเลือกที่ดีที่สุด" แต่เป็น "ทางเดียวที่เหลือ"**

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
  createdAt     2026-08-05 16:03:17.738 UTC

WebhookEndpoint: 1 แถว (acme · cmsg9y3yr000004jltuk8blp1 · createdAt 2026-08-05 16:01:22.324 UTC)
status counts: PENDING=1  (ไม่มี FAILED/DEAD/SUCCEEDED เลย)
```

> ⚠️ **กับดักเวลาอ่าน timestamp ของโปรเจกต์นี้ (เจอจริงในเซสชันนี้):** คอลัมน์เวลาทั้งหมดเป็น
> **`timestamp without time zone`** (DB `TimeZone = UTC` เก็บ wall clock เป็น UTC ถูกต้อง)
> แต่ **`node-pg` แปลงเป็น `Date` โดยตีความว่าเป็น local time ของเครื่องที่รัน** → บนเครื่อง `+0700`
> ค่าที่พิมพ์ออกมาจะ **เลื่อน −7 ชั่วโมง** และดูเหมือน UTC เพราะมี `Z` ต่อท้าย
> ✅ **อ่านให้ถูกต้องด้วย `"createdAt"::text`** (เอา wall clock ดิบ ไม่ผ่าน driver)
> 📌 รอบแรกของเซสชันนี้รายงานเป็น `09:03:17.738Z` / `09:01:22.324Z` ซึ่ง **ผิด** — แก้แล้วด้านบน
>
> ✅ **ยืนยันแล้วว่าระบบไม่ได้เพี้ยน — อย่าไปไล่แก้โค้ด:** response ของ API คืน `10:58:50.567Z`
> และ QStash Console แสดง `17:58:47` (UTC+7) — **ตรงกันเป๊ะ** ⇒ Prisma อ่าน/เขียนถูกต้องทั้งสองทาง
> ความเพี้ยนเกิด **เฉพาะตอน query ตรงผ่าน `node-pg` จากสคริปต์วินิจฉัย** เท่านั้น

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

#### 5.1.1 ⚠️ known gap ที่เจอตอนกำหนด cron — near-breach ทำงานแบบ **ไม่คงเส้นคงวา** (ไม่ใช่ blocker)

> ⛔ **ไม่เกี่ยวกับ Phase 36 (webhooks) ที่กำลังปิด gate** — เป็นข้อจำกัดเชิงออกแบบของ SLA sweep
> บันทึกเป็น known gap + backlog + วัตถุดิบ design แล้วเดินต่อ **ห้ามเอามาค้าง Phase 36**

**ชั้นที่ 1 — ข้อเท็จจริง (ยืนยันจาก prod ไม่ใช่จากค่า default ในโค้ด):**
`SlaPolicy` ของ acme + globex (`"Standard SLA"` · `isDefault=true`) มีค่า **ตรงกับ `DEFAULT_SLA_MINUTES` เป๊ะ**
(FR: Urg 15 · High 60 · Norm 240 · Low 480) · `FeatureFlag sla_policies` = `defaultEnabled=false` + `requiredPlan='pro'`
และทั้งสอง tenant เป็น `pro` ⇒ **flag เปิดผ่าน plan path ⇒ near-breach รันจริง** (ไม่ได้ถูกปิดอยู่)
⇒ ตัวคุมคือ **URGENT first-response 15 นาที → หน้าต่างเตือน 3 นาที**
⇒ ที่ `*/5`: **URGENT ยิงราว 60% ของเคส · HIGH ขึ้นไปครบ 100%**

**ชั้นที่ 2 — ทำไมแก้ด้วย cron ไม่ได้:**
ต้องใช้ `*/3` = 480 msg/วัน = **48% ของโควตา Free** ⇒ เพิ่มความเสี่ยง **quota exhaustion**
ซึ่งเป็น **ตัวจุดชนวนตายเงียบตัวถัดไป** (โควตาหมด → publish ถูกปฏิเสธเงียบ ๆ = failure class เดียวกับ § 3)
⇒ แลกช่องบน demo tenant ที่ไม่มีลูกค้าจริง กับความเสี่ยงที่กระทบ **ทุก feature ที่ผ่าน queue** — **ไม่คุ้ม**

**ชั้นที่ 3 — ทางแก้จริงคือเปลี่ยนกลไก ไม่ใช่จูนค่า:**
**polling + one-shot flag** (`claim` ที่ `sla-sweep/route.ts:221-222`) ไม่เหมาะกับหน้าต่างสั้นโดยธรรมชาติ —
ต่อให้จูน cron ยังไงก็ยังเป็น **ความน่าจะเป็น** ⇒ ต้องเป็น **per-ticket scheduling** (ตั้งเวลาตอนคำนวณ `dueAt`)
ไม่ใช่ sweep ⇒ **เข้า design brief ของ Claude Design ไม่ใช่งานเฟสนี้**

**เกร็ดที่ทำให้วินิจฉัยยากขึ้นอีก:** `remaining` วัดเป็น **business minutes** (`:218`, `:261`) →
ถ้าจังหวะข้ามเส้นตกตอนปิดทำการ หน้าต่างจะกว้างข้ามคืนแล้ว**เตือนล่วงหน้าเป็นชั่วโมง** ส่วนเคสกลางวันเหลือ 3 นาทีตามเดิม
⇒ **พฤติกรรมไม่คงเส้นคงวาในสายตาผู้ใช้** ⇒ ตอกย้ำว่าทางแก้คือเปลี่ยนกลไก ไม่ใช่จูน cron

> 🔑 **บทเรียนที่ต่อยอดจากเคสหลัก: non-determinism วินิจฉัยยากกว่าพังสนิท**
> feature ที่ทำงาน *บางครั้ง* ดูเหมือนสุขภาพดี — คนเห็น notification โผล่ครั้งหนึ่งแล้วสรุปว่าปกติ
> ⛔ **ห้ามใช้ "เคยเห็น near-breach เตือน" เป็นหลักฐานว่าครอบคลุม**
> (ญาติกับบทเรียนแกนของเคสนี้: `201` ของ API ไม่ใช่หลักฐานว่า delivery สำเร็จ)

**สิ่งที่ *ไม่* ได้รับผลกระทบ — อย่าเข้าใจว่า SLA ทั้งระบบไม่น่าเชื่อถือ:**
**breach detection ยิงเสมอ 100% ทุกค่า cron** เพราะเงื่อนไข `dueAt < now` เป็น **monotonic**
(เลยกำหนดแล้วเป็นจริงตลอดไปจนกว่าจะถูก flag) — cron มีผลแค่ **latency (≤ interval)**
⇒ breach flag + `AuditLog` + notification ของ core SLA ปลอดภัย · เรื่อง cadence เป็นประเด็นของ **near-breach เท่านั้น**

### 5.2 DLQ / queues / topics ว่างทั้งหมด
ไม่มี message ตกค้างฝั่ง QStash → **ไม่มีอะไรให้กู้** ของค้างมีแค่แถว `PENDING` ใน DB ของเราเอง

### 5.3 endpoint + delivery `PENDING` — ยังไม่ลบ (ตั้งใจ)
เป็น **เครื่องมือวัดผลชิ้นเดียว** ที่พิสูจน์ว่า fix ได้ผลจริง (replay → ต้องได้ `SUCCEEDED`)
ความเสี่ยง = **ศูนย์จริง** — bin ไม่เคยได้รับ payload สักครั้ง (§ 2.4: `attemptCount=0`)
⏰ **deadline: bin ที่ webhook.site หมดอายุเอง ~7 วัน → ~2026-08-12** เลยจากนั้นต้องทำ § 4-2 ใหม่ทั้งชุด

## 6. Backlog ที่เกิดจากเคสนี้

- [ ] **ไม่มี sweep/cron เก็บ `WebhookDelivery` ที่ค้าง `PENDING`** — แก้ QStash แล้วของค้างไม่หายเอง
      ต้อง replay ด้วยมือทีละอัน · วันนี้มี 1 อันเลยไม่เจ็บ แต่ต้องเป็นงานแยกก่อนจะสะสม
- [x] ~~**สร้าง QStash schedule ของ SLA sweep**~~ ✅ **เสร็จแล้ว 2026-08-06** — verify 2 ชั้นผ่าน (§ 10)
- [ ] 🔴 **ไม่มีการเฝ้า QStash quota** — sweep พังต่อเนื่องที่ `*/5` = **1,152 msg/วัน เกินโควตา 1,000**
      ⇒ โควตาหมด → publish ตายเงียบ → ลาก webhooks + email ตายตาม (§ 10.3 มีตัวเลขรองรับ)
- [ ] **เปลี่ยน near-breach จาก polling เป็น per-ticket scheduling** (§ 5.1.1 ชั้นที่ 3) —
      งานออกแบบ ไม่ใช่งาน ops · เข้า design brief คู่กับ P2
- [ ] 🔴 **sla-sweep ไม่มี per-tenant checkpoint** (§ 10.2.1) — timeout กลางทาง = tenant ท้าย ๆ ไม่มีวันถูก sweep
      · baseline 27 วิ / 2 tenant · มองเห็นทางเดียวคือ DLQ ที่ไม่มีใครเฝ้า
- [ ] **ตรวจ `EMAIL_PROVIDER` ฝั่ง Vercel** — `.env` เครื่องไม่มีเลย → คาดว่า prod ก็ไม่มี (ชั้นซ้อน)
- [ ] **P2 ต้อง probe provider จริง** — ดูเกณฑ์ตัดสินหัวไฟล์

## 7. เกณฑ์ verify หลังแก้ (สัญญาณสะอาดเรียงจากมากไปน้อย)

1. **webhooks** — replay delivery `cmsga0l0q000404jrg5fkwbdu` → ต้องได้ `SUCCEEDED` · fail-loud อยู่แล้ว ✅ สัญญาณสะอาดสุด
2. **outbound email** — `TicketMessage.emailSentAt` ต้องไม่เป็น `null` ⚠️ ยังถูก confound ด้วย `EMAIL_PROVIDER` จนกว่าจะ probe email provider จริง
3. **SLA sweep** — ⛔ **ใช้ verify การแก้นี้ไม่ได้** (§ 5.1) เป็นงานแยก

## 8. แผนการแก้ + decision ที่ตกลงแล้ว (2026-08-06)

### 8.1 การแก้ = ตัวแปรเดียว

```
QSTASH_URL = https://qstash-us-east-1.upstash.io      # Vercel · Production + Preview
```
**ไม่แตะ** `QSTASH_TOKEN` · `QSTASH_CURRENT/NEXT_SIGNING_KEY` (§ 2.3 พิสูจน์แล้ว) · `QSTASH_TARGET_BASE_URL`
⛔ **ห้ามใช้ `QSTASH_REGION`** (§ 4)

⚠️ **ต้องตั้งทั้ง Production และ Preview** ให้ตรงกับ env ตัวอื่นในโปรเจกต์ — ถ้าตั้งแค่ Production
deployment ฝั่ง Preview จะยังยิงไป EU = **ซ่อนบั๊กเดิมไว้อีกที่หนึ่ง** แล้วจะโผล่มาตอนที่ไม่มีใครคาด

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

### 8.2.1 ทำไมถึง **ไม่** เขียนทับ signing key ไปด้วยเลย (แม้จะ "เผื่อไว้" ได้ฟรี)

ระหว่างทางเคยพิจารณาจะ paste คีย์จาก `GET /v2/keys` ทับลง Vercel ไปเลยเพื่อปิดสมมติฐาน § 2.3 — **ตัดสินว่าไม่ทำ**

| | เขียนทับ signing key ด้วย | ตั้ง `QSTASH_URL` ตัวเดียว (เลือกอันนี้) |
| --- | --- | --- |
| ปิด residual § 2.3 | ✅ | ❌ (แต่ detection ฟรี ดูล่าง) |
| **ความเสี่ยงใหม่ที่สร้างขึ้นเอง** | 🔴 **paste secret ด้วยมือ** — เกิน/ตกหล่น/ติด whitespace = **สร้าง `401` ขึ้นมาเองทั้งที่เดิมไม่มี** | ไม่มี |
| attribution ตอน verify | ❌ 2 ตัวแปร — ถ้า `401` แยกไม่ออกว่า "คีย์เดิมผิด" หรือ "paste พลาด" | ✅ **ตัวแปรเดียว สะอาด** |

> 🔑 **paste secret ด้วยมือคือ failure mode เดียวกับที่ทำให้เกิดเรื่องนี้ตั้งแต่แรก** (คนตั้งค่าหยิบค่าผิดมาแต่แรก)
> — ไม่คุ้มที่จะจ่ายความเสี่ยงใหม่เพื่อปิดสมมติฐานที่โอกาสผิดต่ำ **ในเมื่อ detection ของสาขานั้นฟรีและทันทีอยู่แล้ว**

**สาขาที่ตัดสินไว้ล่วงหน้า (ห้ามวินิจฉัยใหม่):**
- replay ได้ **`401`** → นั่นคือสาขา signing key → เอาคีย์จาก `GET /v2/keys` ไปตั้ง แล้ว redeploy **ทันที**
- ตั้งแล้วยังได้ `401` อีก → **escalate ห้ามเดาต่อ** (เพดาน 2 สมมติฐาน)

### 8.3 แก้นิยาม "verify by effect" ให้ทำได้จริง

`CLAUDE.md` § Post-merge gate สั่งให้ตรวจที่ชั้นเดียวกับที่ค่าถูกใช้จริง — สำหรับ **runtime env**
**ไม่มี artifact ให้สแกน** (ต่างจาก `NEXT_PUBLIC_*` ที่ `scan:bundle` ได้)
⇒ **"verify by effect" กับ "verify feature" เป็นขั้นเดียวกัน ไม่ใช่สองขั้น**
การประดิษฐ์ขั้น "ยืนยันว่า deployment ถือค่าใหม่" แยกออกมา = **กับดัก "ตรวจผิดชั้น" ของ `CLAUDE.md` เอง** (คนละทิศ)

สิ่งที่ตรวจได้จริงและควรตรวจเพิ่ม: **deployment ใหม่ถูก promote เป็น production alias จริงไหม** — ไม่ใช่แค่ขึ้น `Ready`

**ผลจริง 2026-08-06 — ตรวจได้แค่ระดับ API ไม่ใช่ระดับ effect:**
- ✅ ระดับ API: `latestDeployment` = `dpl_9Z2hmapaaoZyL5GPZMzZFqSLxV93` (commit `b637277`) · `READY` · `target=production`
- ❌ **ระดับ effect ทำไม่ได้เชิงโครงสร้าง** — วิธีที่ตั้งใจใช้คือเทียบ static chunk hash ระหว่าง production alias
  กับ deployment URL แต่ **`*.vercel.app` ทุก host ตอบ `302` ทุก path** (รวม `/_next/static/*`) เพราะ `src/proxy.ts`
  จับ host ที่ไม่ใช่ tenant แล้ว redirect ทิ้ง ⇒ ไม่มีทางเทียบ build ระหว่างสองที่อยู่ได้เลย
  📌 **ข้อจำกัดถาวรของโปรเจกต์นี้** — ใครจะออกแบบ gate ที่ต้องเทียบ artifact ข้าม host ต้องรู้ข้อนี้ก่อน

> ### 📌 ERRATUM 2026-08-08 — คำอธิบายสาเหตุของ `302` ข้างบนผิด (ข้อความเดิมคงไว้ตามที่เขียนไว้ ไม่ลบ)
>
> **ผิดตรงไหน:** การ attribute `302` ไปที่ `src/proxy.ts` **ไม่ถูกต้อง** — ตรวจโค้ดยืนยันแล้วว่า
> `grep -n "redirect" src/proxy.ts next.config.ts` เจอผลลัพธ์เดียวคือ **คอมเมนต์** ที่ `src/proxy.ts:11`
> (*"ไม่รองรับ request rewrite/redirect แบบ edge granularity (ไม่มี NextResponse.rewrite)"*)
> ⇒ **ไม่มี `NextResponse.redirect` อยู่ในโค้ดเลยสักบรรทัด** และ `next.config.ts` ก็ไม่มี redirect config
> · พฤติกรรมจริงของ host ที่ไม่ใช่ `{slug}.gethelpwise.xyz` คือ `slug = null` → `nextWithoutTenantHeaders()`
> → **ผ่านไปเฉย ๆ ไม่ redirect**
>
> **สาเหตุจริงของ `302`:** **Vercel Deployment Protection** (SSO บน `*.vercel.app`)
> ✅ **confirm แล้ว 2026-08-08 (Dev ตรวจใน Vercel Project Settings)** — Vercel Authentication = **ON** โหมด **"Standard Protection"**
> · วัดเพิ่มได้ว่า `https://gethelpwise.xyz/api/health` → **200** และ `https://acme.gethelpwise.xyz/api/health` → **200**
> ขณะที่ `*.vercel.app` → **302** (ค่าที่บันทึกไว้ข้างบน)
> ⇒ **อนุมานจากการวัด 3 จุดนี้** ว่า Standard Protection ครอบ deployment URL / preview แต่ไม่ครอบโดเมน production ของโปรเจกต์
> (เป็นการอนุมานจากผลวัด **ไม่ใช่ข้อความจากเอกสาร Vercel**) · หลักฐานเต็มชุด → erratum §G ข้อ 5
>
> **ข้อสังเกตเดิมยังคงอยู่:** *"เทียบ artifact ข้าม host (production alias ↔ deployment URL) ทำไม่ได้"*
> ยังเป็นข้อจำกัดจริง — เปลี่ยนแค่ **เหตุผล** · ผลต่างที่สำคัญ: proxy แก้ที่โค้ดของเรา แต่ Deployment Protection
> แก้ที่ Vercel setting / bypass token ⇒ ถ้าไม่แก้บันทึกนี้ คนถัดไปจะไปแก้โค้ดที่ไม่ใช่ต้นเหตุ
>
> **อ้างอิง:** `.claude/specs/phase-39-design-doc-v2.1-errata-2026-08-08.md` §B (E-1)

⛔ **สิ่งที่ห้ามใช้เป็นหลักฐาน:** `project.updatedAt` ขยับหลัง `deployment.created` ~85 วินาที
**ไม่ชี้ขาดอะไรเลย** — เข้ากับ *"ตั้ง env หลัง deploy"* และ *"build ปกติจบแล้วอัปเดต alias"* (build ก่อนหน้าใช้ 1m 5s)
ได้พอ ๆ กัน **แยกสองสมมติฐานไม่ออก** · เคยถูกยกมาเป็น "บ่งชี้" ในบทสนทนา — เป็นการตีความเกินหลักฐาน

### 8.3.1 ลดตัวแปรก่อนวัด ไม่ใช่วัดแล้วมาแยกทีหลัง

Dev ยืนยันว่าตั้ง `QSTASH_URL` **ก่อน** push `b637277` (deployment ที่ live จึงควรถือค่าใหม่อยู่แล้ว)
แต่ยัง **redeploy ซ้ำก่อน replay** — เหตุผลที่ถูกต้องคือ **replay เป็นการทดสอบที่อยากรันครั้งเดียวจบ**
ถ้าไม่ redeploy ผลจะมีได้ 3 สาขา (`SUCCEEDED` / `401` signing key / **env ไม่ติด**)
redeploy ตัดสาขาที่สามทิ้งก่อน ⇒ เหลือ 2 สาขาที่ตีความง่าย · **ไม่ใช่เพราะสงสัยว่า env ไม่ติด**

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

## 9. ผลการแก้ — ✅ ผ่าน (2026-08-06)

ตั้ง `QSTASH_URL = https://qstash-us-east-1.upstash.io` (Production + Preview) → redeploy → replay

### 9.1 หลักฐาน

**DB — ตัวชี้ขาด 3 field พลิกครบ** (`WebhookDelivery cmsga0l0q000404jrg5fkwbdu`):

| field | ก่อน (baseline 2026-08-06 10:58:45 UTC) | หลัง |
| --- | --- | --- |
| `status` | `PENDING` | ✅ **`SUCCEEDED`** |
| `attemptCount` | `0` | ✅ **`1`** |
| `lastAttemptAt` | `null` | ✅ **`2026-08-06 10:58:50.567`** |
| `responseStatus` | `null` | ✅ **`200`** |
| `errorMessage` | `null` | `null` |

⛔ **ห้ามบันทึก `responseBody`** ที่ใดก็ตาม — มี URL ของ bin ติดมาด้วย (runbook § 4-2 ห้ามไว้)

**Upstash Console (US Region · us-east-1) → Logs:**
`Aug 6 17:58:47 (UTC+7 = 10:58:47 UTC) · DELIVERED · acme.gethelpwise.xyz/api/jobs/webhook-deliver · 3s`
ตรงกับ `date` header ของ replay (`10:58:47 GMT`) และกับ `AuditLog webhook.delivery_replayed` (`10:58:47.326` UTC) = **request เดียวกัน**

### 9.2 สิ่งที่ปิดไปพร้อมกัน 3 ชั้น

1. **publish ออกจากระบบได้จริง** — root cause § 3 ถูกแก้แล้ว
2. **worker ถูกเรียกครั้งแรกตั้งแต่ Jun 21** — `/api/jobs/webhook-deliver` ไม่เคยรันมาก่อนเลย
3. 🔑 **signature verification ผ่าน** ⇒ **residual § 2.3 ปิดสนิทด้วยหลักฐาน ไม่ใช่การอนุมาน**
   — `DELIVERED` แปลว่า worker ตอบ 2xx · ถ้า signing key บน Vercel ไม่ตรงบัญชี US จะได้ `401` + retry
   **นี่คือ runtime probe ที่ § 2.3 บอกว่าเป็นทางเดียวที่เหลือ — และมันทำงาน**
   (ยืนยันไม่ได้ด้วยการเทียบค่า env เพราะ Vercel Sensitive อ่านไม่ได้ · ปิดด้วย effect แทน)

### 9.3 ทำไม **ไม่** สร้าง ticket ใหม่ทดสอบซ้ำ

- log 5 ส.ค. พิสูจน์แล้วว่า `dispatchWebhookEvent` **เดินไปถึงจุด publish จริง** (error region ถูก log ที่นั่น)
- 6 ส.ค. พิสูจน์แล้วว่า **publish → worker → `SUCCEEDED`** ทำงานครบ
- ⇒ **ต่อกันครบสายโดย composition** — ไม่มีช่วงไหนเหลือที่ยังไม่ถูกพิสูจน์
- สร้าง ticket ใหม่ = **เพิ่มขยะถาวรบน demo tenant** (§ 6 ของ runbook ไม่มีอะไรล้างให้) แลกกับความมั่นใจที่มีอยู่แล้ว

### 9.4 เก็บกวาด (Dev ทำเอง 2026-08-06)

| รายการ | สถานะ |
| --- | --- |
| `DELETE /api/webhook-endpoints/cmsg9y3yr000004jltuk8blp1` | ✅ `{"deleted":true}` — ผ่าน **API ไม่ใช่ SQL** เพื่อให้ `audit.log()` ทำงาน (`AuditLog webhook.endpoint_deleted` 2026-08-06 11:04:14.545 UTC) |
| `GET /api/webhook-endpoints` | ✅ `{"data":{"endpoints":[]},"error":null}` · verify อิสระจาก DB: `WebhookEndpoint` = 0 แถว |
| bin ที่ webhook.site | ⚠️ **ลบ payload ในนั้นแล้ว แต่ตัว bin ยังอยู่** (ลบไม่ได้เพราะไม่ได้ login) — ไม่จำเป็นแล้วเพราะ endpoint ถูกลบ ⇒ ไม่มีอะไรยิงเข้าได้อีก · bin ว่างและจะหมดอายุเองใน ~7 วัน · **อย่าเขียนว่า "ลบ bin แล้ว"** |
| cookie jar + password | ✅ ลบ/unset แล้ว |

> 📌 **ผลข้างเคียงที่ต้องรู้: แถวหลักฐานถูกลบไปด้วย** — `WebhookDelivery` มี `onDelete: Cascade` ผูกกับ
> `WebhookEndpoint` ⇒ ลบ endpoint แล้ว **delivery row หายตามทันที** (ยืนยันแล้ว: `WebhookDelivery` = 0 แถว)
> ⇒ **ตัวเลขใน § 9.1 คือบันทึกเดียวที่เหลืออยู่ของเหตุการณ์นี้** — เหตุผลที่ต้องมี snapshot ก่อนเก็บกวาด
> ⇒ ผลพลอยได้: ไม่มี `PENDING` ค้างเหลือในระบบแล้ว (แต่ backlog "ไม่มี sweep" ยังคงอยู่ ดู § 6)

## 10. SLA sweep schedule — สร้างแล้วและ verify ผ่าน (2026-08-06)

> ⏰ **บันทึกทันทีที่เห็นผล** — QStash log retention = **3 วัน** ⇒ หลัง **2026-08-09** หลักฐานนี้หายจากต้นทาง
> เอกสารนี้จะเป็นบันทึกเดียวที่เหลือ (กฎเดียวกับ FK cascade ใน `CLAUDE.md` § Post-merge gate)

### 10.1 ชั้นที่ 1 · schedule มีอยู่จริง (`GET /v2/schedules` → `200`)

```
scheduleId   scd_6JnXmVttr2Nyt3d4dyd5yKRskkT3
cron         */5 * * * *          (UTC)
destination  https://acme.gethelpwise.xyz/api/jobs/sla-sweep
method       POST
retries      3  (default)
isPaused     false
createdAt    2026-08-06T15:26:46.790Z
```
⇒ เดิม `/v2/schedules` = `[]` (§ 5.1) — **ปิด known gap "SLA sweep ไม่มี schedule" แล้ว**

### 10.2 ชั้นที่ 2 · invocation จริงตามรอบ (`GET /v2/events` → `200`)

| time (UTC) | state | responseStatus |
| --- | --- | --- |
| `2026-08-06T15:30:00.905Z` | `CREATED` | — |
| `2026-08-06T15:30:00.995Z` | `ACTIVE` | — |
| **`2026-08-06T15:30:28.012Z`** | ✅ **`DELIVERED`** | ✅ **`200`** |

`messageId msg_7YoJxFpwkEy4DbXxJvcLMuMHjufJu2DkLzmjTKrePD2FN9eMzQRAJ` · `scheduleId` ตรงกับ § 10.1
⇒ trigger ตรงนาทีที่ 30 พอดี = **cron ทำงานจริง ไม่ใช่แค่ schedule ถูกสร้าง**

> 🔑 **`responseStatus 200` = signature verification ของ `/api/jobs/sla-sweep` ผ่าน**
> route นี้ **fail-closed** (`verifyQStashSignature` ไม่ผ่าน → `401`) ⇒ `200` พิสูจน์ว่าคีย์ถูกต้อง
> · เป็นการทดสอบ **route ที่สอง** (คนละ route กับ `webhook-deliver` แต่ใช้ signing key ชุดเดียวกัน)
> · และเป็นครั้งแรกที่ `/api/jobs/sla-sweep` เคยถูกเรียกสำเร็จเลย

### 🔴 10.2.1 · `ACTIVE → DELIVERED` = 27 วินาที — ไม่ใช่แค่ข้อสังเกต แต่เป็นบั๊กเชิงโครงสร้างที่รอเวลา

**baseline: 27 วินาที / 2 tenant** (`15:30:00.995 → 15:30:28.012`, cold start + loop ทุก tenant ทีละราย)
ยังห่างเพดาน Free (max HTTP response duration 15 นาที) มาก **แต่ตัวเลขไม่ใช่ประเด็น — โครงสร้างต่างหาก:**

`sla-sweep` **วนทุก tenant ใน invocation เดียวโดยไม่มี per-tenant progress/checkpoint** ⇒
1. ชน Vercel timeout เมื่อไร → **ตายกลางทาง** ⇒ tenant **หลังจุดนั้นไม่เคยถูก sweep เลย**
2. **retry เริ่มจาก tenant แรกใหม่ทุกครั้ง** ⇒ ถ้าเวลารวมเกิน timeout ตลอด **tenant ท้าย ๆ ไม่มีวันถึง**
3. สิ่งเดียวที่มองเห็นอาการได้คือ **QStash DLQ** ซึ่ง **ไม่มีใครเฝ้า + retention แค่ 3 วัน**

⇒ **จะชน timeout ก่อนชนโควตา** เมื่อจำนวน tenant โต · **วันนี้ไม่เจ็บ (2 tenant) แต่โตแล้วเจ็บแบบเงียบ**
⇒ **คลาสเดียวกับ per-ticket scheduling (§ 5.1.1) และ quota (§ 10.3): กลไกที่ดูเหมือนทำงานแต่พิสูจน์ไม่ได้**
⇒ ใช้ **27 วินาที / 2 tenant เป็น baseline เทียบ** เมื่อ tenant เพิ่ม

**หมายเหตุ:** Console เติม `Content-Type: application/json` ให้เอง — ไม่กระทบ เพราะ route verify ด้วย **rawBody** ไม่ได้ parse body

### 10.3 🔴 ตัวเลขที่ทำให้ backlog "ไม่มีการเฝ้า quota" ไม่ใช่ความเสี่ยงลอย ๆ

**retry default = 3** ⇒ ถ้า sweep พังต่อเนื่อง (เช่น DB ล่ม → route คืน `500`):

| cron | ปกติ (msg/วัน) | **กรณีพังต่อเนื่อง** `× (1+3)` | เทียบโควตา Free = 1,000 |
| --- | --- | --- | --- |
| `*/15` | 96 | 384 | 38% |
| **`*/5` (ปัจจุบัน)** | 288 | **1,152** | 🔴 **เกินโควตา — หมดภายในวันเดียว** |
| `*/3` | 480 | **1,920** | 🔴 เกินเกือบ 2 เท่า |

⇒ **โควตาหมด = publish ถูกปฏิเสธเงียบ ๆ ⇒ ลาก webhooks + outbound email ตายตามทั้งหมด**
= **failure class เดียวกับ § 3 เป๊ะ** แต่ **หายากกว่า** เพราะ "เคยทำงานแล้ว"
⇒ เป็นเหตุผลเพิ่มอีกชั้นว่าทำไม `*/3` รับไม่ได้ (พังต่อเนื่อง = 1,920)
⇒ และเป็นเหตุผลว่าทำไม **การเฝ้า quota ต้องเป็นงานจริง ไม่ใช่ความตั้งใจ** (ดู § 6)

---

## References
- Handoff: `.claude/handoffs/phase-38-gate-hardening-merged-2026-08-05.md`
- Runbook: `.claude/specs/phase-38-webhooks-flag-runbook.md` (§ 4-2 ข้อ 4 แก้ให้เป็นเงื่อนไขแล้ว 2026-08-06)
- Upstash multi-region: https://upstash.com/docs/qstash/howto/multi-region
- โค้ดที่เกี่ยว: `src/lib/queue.ts:242` · `src/lib/webhook-dispatch.ts:128,149,164`
