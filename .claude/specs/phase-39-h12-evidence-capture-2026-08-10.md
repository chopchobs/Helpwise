# Phase 39 §H-12 — เช็คลิสต์เก็บหลักฐานของจังหวะ deploy (แถว H · I · G)

> 🔴 **จังหวะนี้เกิดครั้งเดียว** — `deployment_status` ตัวจริงจาก merge รอบนี้
> พลาดแล้วต้องรอ deploy รอบหน้า ⇒ **อ่านทั้งไฟล์ก่อนกด merge** ไม่ใช่อ่านตอนเกิดเหตุ
>
> 📌 เกณฑ์ผ่าน/ไม่ผ่านทุกข้อในไฟล์นี้ **ตัดสินไว้ล่วงหน้าก่อนเห็นผล (2026-08-10)** — ห้ามแก้เกณฑ์หลังเห็นผล
> ⛔ **"job เขียว" ไม่ใช่หลักฐานของข้อใดข้อหนึ่งในไฟล์นี้** (§G ข้อ 16) — ทุกแถวขอ **effect**

**ตั้งค่าที่ใช้ร่วมกัน** (รันครั้งเดียวก่อนเริ่ม):

```bash
export GH_REPO=chopchobs/Helpwise
export EVID=~/Desktop/helpwise-evidence-$(date -u +%Y%m%dT%H%M%SZ)   # โฟลเดอร์เก็บหลักฐานดิบ
mkdir -p "$EVID" && echo "$EVID"
```

---

## 🔴 สมมติฐานตั้งต้นที่เปลี่ยนความหมายของทุกแถว

**prod พังอยู่จริงตั้งแต่ 02:12Z** (คนละเรื่องกับ §H-12) ⇒ คาดว่า `verdict=FAIL`

| ผลที่ตามมา | อ่านยังไง |
| --- | --- |
| **แถว H ยังปิดได้** | H วัด *"ความจำข้ามทริกเกอร์"* ไม่ได้วัดว่าระบบปกติ — `FAIL` ไม่กระทบเกณฑ์ |
| 🔑 **และ `FAIL` ทำให้หลักฐานของ H *คมกว่า* กรณีปกติด้วยซ้ำ** | ดูกล่อง "ทำไม prev=FAIL ถึงเป็นหลักฐานชั้นดี" ในแถว H |
| 🔴 **แถว G ปิดด้วย deploy รอบนี้ *ไม่ได้*** | prev=FAIL → verdict=FAIL ⇒ **ไม่มี transition ⇒ ไม่มีข้อความ** ⇒ G ต้องปิดจากเหตุการณ์อื่น (ดูแถว G) |
| ⚠️ **แถว I ปิดได้แค่ครึ่งเดียว** | ครึ่งหลังต้องจงใจทำให้ save ล้ม = การทดลองแยก ไม่ใช่ deploy รอบนี้ (ดูแถว I) |

---

## แถว H — ความจำข้ามทริกเกอร์ (§G ข้อ 15)

### หลักฐานคืออะไร (ไม่ใช่ "job เขียว")

**run ของ `post-deploy` อ่าน state ที่ run ของ `scheduled` เขียนไว้ได้จริง** — พิสูจน์ด้วย 3 ชิ้นที่ต้องได้ครบ:

| # | หลักฐาน | ทำไมชิ้นนี้ถึงนับ |
| --- | --- | --- |
| **H-1** | log บรรทัด `[readiness-check] mode=post-deploy verdict=… prev=…` โดย **`prev` ต้องไม่ใช่ `—`** | `—` คือค่าที่ `readState()` คืนตอน **cache miss** (`scripts/readiness-check.ts:81`) ⇒ **`prev` ที่มีค่า = cache ถูก restore สำเร็จบน event ที่ผูก ref** = อาการที่ §G ข้อ 15 บอกว่าเป็นไปไม่ได้บน `deployment_status` |
| **H-2** | job `dispatch` มี run แยก และ run ที่ถูกสั่งเป็น `event: workflow_dispatch` ที่ `mode=post-deploy` | พิสูจน์ว่าทางอ้อม (ทาง A) ทำงานจริง ไม่ใช่ว่า `check` บังเอิญรันจาก cron |
| **H-3** | cache entry ใหม่ของ run นั้นถูกสร้าง (ดูแถว I) | ความจำต้อง **อ่านได้และเขียนได้** — H-1 พิสูจน์ฝั่งอ่าน · H-3 พิสูจน์ฝั่งเขียน |

> 🔑 **ทำไม `prev=FAIL` ถึงเป็นหลักฐานชั้นดีกว่ากรณีปกติ**
> ก่อน §H-12: post-deploy ได้ `prev=—` เสมอ ⇒ `shouldAlert(undefined, FAIL)` = true ⇒ **แจ้งซ้ำทุก deploy**
> หลัง §H-12: `prev=FAIL` + `verdict=FAIL` ⇒ ไม่มี transition ⇒ **เงียบ** ⇒ log ต้องขึ้น
> `ไม่มี transition — ไม่แจ้ง (transition-only)` (`scripts/readiness-check.ts:278`)
> ⇒ **ความเงียบตรงนี้คือพฤติกรรมใหม่ที่ §H-12 ซื้อมา** — ไม่ใช่ความเงียบที่ต้องสงสัย
> ⚠️ แต่ **ความเงียบเป็นหลักฐานรองเท่านั้น** — หลักฐานหลักคือ H-1 (`prev` มีค่า) ห้ามปิดแถวด้วยความเงียบอย่างเดียว

### คำสั่ง (copy รันได้เลย)

```bash
# 1) หา run ทั้งสองใบ — dispatch (deployment_status) และ check (workflow_dispatch)
gh run list --repo "$GH_REPO" --workflow readiness.yml --limit 10 \
  --json databaseId,event,status,conclusion,createdAt,displayTitle \
  | tee "$EVID/h2-run-list.json"

# 2) จับ run id ของ post-deploy ใบล่าสุด (event=workflow_dispatch)
RUN_ID=$(gh run list --repo "$GH_REPO" --workflow readiness.yml --event workflow_dispatch \
  --limit 1 --json databaseId --jq '.[0].databaseId') && echo "RUN_ID=$RUN_ID"

# 3) 🔑 หลักฐานหลักของแถว H — log เต็มของ run นั้น
gh run view "$RUN_ID" --repo "$GH_REPO" --log > "$EVID/h1-post-deploy-run.log"
grep -E "mode=post-deploy|transition|ส่งแจ้งเตือน" "$EVID/h1-post-deploy-run.log"

# 4) log ของ job dispatch (ฝั่งผู้สั่ง) — ยืนยันว่าไม่ได้รอผลและ verify run created ผ่าน
DISPATCH_ID=$(gh run list --repo "$GH_REPO" --workflow readiness.yml --event deployment_status \
  --limit 1 --json databaseId --jq '.[0].databaseId') && echo "DISPATCH_ID=$DISPATCH_ID"
gh run view "$DISPATCH_ID" --repo "$GH_REPO" --log > "$EVID/h2-dispatch-run.log"
```

### เกณฑ์ผ่าน — **ตัดสินไว้ก่อนเห็นผล**

- ✅ **ผ่าน** เมื่อครบทั้งสาม: log มี `mode=post-deploy` · `prev=` ตามด้วยค่าที่**ไม่ใช่ `—`** · และมี run ของ `dispatch` แยกใบจริง
- ❌ **ไม่ผ่าน** ถ้า `prev=—` ⇒ แปลว่า restore ยังไม่ทำงาน (สาเหตุที่เป็นไปได้: ยังไม่เคยมี scheduled run เขียน cache หลัง merge / ref ไม่ตรง) ⇒ **ห้ามปิดแถว** ให้รอ cron รอบถัดไปเขียน cache แล้วค่อยทดสอบใหม่ด้วยการกด Run workflow เอง
- ⚠️ **เคสก้ำกึ่งที่ต้องอ่านให้ออก:** ถ้า `prev=—` **เพราะยังไม่มี scheduled run ใดสำเร็จหลัง merge เลย** ⇒ นี่คือ *"ยังวัดไม่ได้"* ไม่ใช่ *"วัดแล้วไม่ผ่าน"* ⇒ บันทึกเป็น **INCONCLUSIVE** อย่าบันทึกเป็น FAIL

### 🔴 เดดไลน์

| ของ | หายเมื่อไร | ต้องเก็บภายใน |
| --- | --- | --- |
| log ของ run | Actions log retention (ค่าเริ่มต้น 90 วัน) | ไม่เร่ง — แต่ **เก็บทันที** เพราะยิ่งช้ายิ่งหา run id ยาก (cron เดินทุก 15 นาที) |
| ลำดับของ run ในหน้า list | ถูกดันตกหน้าแรกภายใน ~2 ชม. (cron ทุก 15 นาที) | **ภายใน 1 ชั่วโมง** |

---

## แถว I — assertion "สเต็ปเขียว ≠ สเต็ปทำงาน" (§G ข้อ 16)

> 🔴 **แถวนี้มีสองครึ่ง และ deploy รอบนี้ปิดได้แค่ครึ่งเดียว — พูดให้ตรงตั้งแต่ต้น**
> เกณฑ์ที่ `phase-39-closing-evidence-2026-08-09.md` เขียนไว้คือ *"job **แดง** เมื่อ save ไม่เกิดจริง
> (ทดสอบด้วยการทำให้ save ล้มโดยตั้งใจ)"* ⇒ **นั่นคือครึ่ง I-b ซึ่งเป็นการทดลองแยก**

| ครึ่ง | คืออะไร | ปิดได้ด้วย deploy รอบนี้ไหม |
| --- | --- | --- |
| **I-a** | cache entry **มีอยู่จริง** หลังสเต็ป save — ยืนยันด้วย REST API ซึ่งเป็นคนละชิ้นกับ `actions/cache` | ✅ **ได้** |
| **I-b** | assertion **ทำให้ job แดง** เมื่อ save ไม่เกิด | ❌ **ไม่ได้** — ต้องจงใจทำให้ save ล้ม = งานแยก ต้องให้ Dev ตัดสินก่อน |

### หลักฐาน I-a — คำสั่ง

```bash
# ต้องมี RUN_ID จากแถว H ก่อน
gh api "/repos/$GH_REPO/actions/caches?key=readiness-state-$RUN_ID" \
  | tee "$EVID/i1-cache-entry.json"

# อ่านตัวเลขที่ใช้ตัดสิน
gh api "/repos/$GH_REPO/actions/caches?key=readiness-state-$RUN_ID" --jq '.total_count'

# บริบท: cache ทั้งหมดของ prefix นี้ (ดูว่ามีของ scheduled รอบก่อนอยู่จริง = ต้นทางที่ H-1 อ่าน)
gh api "/repos/$GH_REPO/actions/caches?key=readiness-state-&sort=created_at&direction=desc&per_page=20" \
  | tee "$EVID/i2-cache-list.json"
```

### เกณฑ์ผ่าน — ตัดสินไว้ก่อนเห็นผล

- ✅ **I-a ผ่าน** เมื่อ `total_count >= 1` สำหรับ key `readiness-state-$RUN_ID` **และ** `i2-cache-list.json` มี entry ของรอบก่อนหน้า (พิสูจน์ว่า H-1 มีของให้อ่านจริง ไม่ใช่บังเอิญ)
- ❌ **ไม่ผ่าน** ถ้า `total_count = 0` ทั้งที่สเต็ป `Verify state was actually saved` ขึ้นเขียว ⇒ **นั่นคือ assertion เองพัง** = เรื่องใหญ่กว่าที่กำลังตรวจ ให้หยุดแล้ว escalate
- ⬜ **I-b คงสถานะว่างไว้** พร้อมเขียนในตารางว่า *"ยังไม่ถูกพิสูจน์ — ต้องทดลองแยก"* ⛔ **ห้ามติ๊ก I ทั้งแถวจาก I-a อย่างเดียว**

### 🔴 เดดไลน์ — **แถวนี้เร่งที่สุด**

| ของ | หายเมื่อไร | ต้องเก็บภายใน |
| --- | --- | --- |
| **cache entry** | GitHub evict เมื่อ **ไม่ถูกแตะ 7 วัน** หรือเมื่อ repo เกิน 10 GB | **ภายใน 24 ชม.** (กันเหลือเฟือ) |
| **`ReadinessState` singleton บน prod** | ถูก **เขียนทับโดย cron รอบถัดไป ≤ 15 นาที** (§G ข้อ 9) | 🔴 **ภายใน 15 นาที** ถ้าจะเก็บ snapshot ของรอบ post-deploy |

```sql
-- (ถ้าต้องการ snapshot ของ ReadinessState ที่รอบ post-deploy เขียน — ต้องรันภายใน 15 นาที)
select id, status, "lastCheckAt", "updatedAt" from "ReadinessState";
select mechanism, "lastBeatAt" from "MechanismHeartbeat" order by mechanism;
```

---

## แถว G — เห็นข้อความจริงในห้อง Discord

> 🔴 **การค้นพบสำคัญ: G ไม่ผูกกับ deploy รอบนี้เลย — และไม่มีทางปิดด้วย deploy รอบนี้**
> prod อยู่ที่ `FAIL` แล้ว ⇒ post-deploy จะได้ `prev=FAIL → verdict=FAIL` ⇒ **ไม่มี transition ⇒ ไม่ส่งอะไร**
> ⇒ ถ้าเปิดห้องแล้วไม่เห็นข้อความใหม่ **นั่นถูกต้องตามดีไซน์** ⛔ **ห้ามอ่านว่า "ช่องเตือนพัง"**

### หลักฐานที่ปิด G ได้จริง — มาจาก transition ที่ **เกิดไปแล้ว**

`OK → FAIL` ตอน ~02:12Z คือ transition จริง ⇒ `shouldAlert()` = true ⇒ ต้องมีข้อความถูกส่งไปแล้ว
⇒ **หลักฐานของ G มีอยู่แล้วในห้อง Discord ตั้งแต่ก่อน deploy** — ไปยืนยันได้ทันที ไม่ต้องรออะไร

| # | หลักฐาน | ทำอย่างไร |
| --- | --- | --- |
| **G-1** | ข้อความในห้อง Discord ที่ขึ้นต้นด้วย `🔴 readiness FAIL — ระบบพัง ไปดูว่าอะไรพัง` (`src/lib/readiness-verdict.ts:192`) | เปิดห้องจริง · **screenshot + คัดข้อความเป็น text** เก็บที่ `$EVID/g1-discord.txt` |
| **G-2** | บรรทัดที่สองของข้อความต้องเป็น `(scheduled · OK → FAIL)` — รูปแบบมาจาก `scripts/readiness-check.ts:265` + `:269` | อยู่ใน screenshot เดียวกัน |
| **G-3** | log ของ run ที่ส่ง ต้องมี `[readiness-check] ส่งแจ้งเตือนแล้ว` (`scripts/readiness-check.ts:271`) | `gh run view <id> --log` ของ run รอบ 02:12Z |

```bash
# หา run ที่เกิด transition (ช่วง 02:12Z) แล้วดึง log มาคู่กับ screenshot
gh run list --repo "$GH_REPO" --workflow readiness.yml --limit 40 \
  --json databaseId,event,conclusion,createdAt \
  --jq '.[] | select(.createdAt >= "2026-08-10T01:50:00Z" and .createdAt <= "2026-08-10T02:40:00Z")' \
  | tee "$EVID/g3-transition-runs.json"
```

### เกณฑ์ผ่าน — ตัดสินไว้ก่อนเห็นผล

- ✅ **ผ่าน** เมื่อ **เห็นข้อความจริงในห้อง** (G-1) **และ** log มี `ส่งแจ้งเตือนแล้ว` (G-3) — **ต้องได้ทั้งคู่**
  · G-3 อย่างเดียวไม่พอ: `notifySlack()` เช็คแค่ `res.ok` ⇒ Discord ตอบ `204` ได้โดยไม่ขึ้นข้อความ (ดูคอมเมนต์ที่ `scripts/readiness-check.ts:140-146`)
  · G-1 อย่างเดียวไม่พอ: ต้องผูกข้อความกับ run ที่ส่งได้
- ❌ **ไม่ผ่าน** ถ้า log ขึ้น `แจ้งเตือนส่งไม่ออก` ⇒ webhook พัง ⇒ เป็น finding ใหม่ ไม่ใช่แค่แถวว่าง
- ⚠️ ถ้าไม่มี run ไหนในหน้าต่างนั้นเลย ⇒ **cron ไม่ได้รัน** = finding ที่ใหญ่กว่า G ⇒ escalate ทันที

### เดดไลน์

ข้อความ Discord **ไม่หายตามเวลา** ⇒ ไม่เร่ง · แต่ log ของ run รอบ 02:12Z อยู่ใต้ retention เดียวกับแถว H

---

## 🔴 ลำดับบังคับตอนเก็บกวาด (กฎของ `CLAUDE.md` § Post-merge gate)

> *"หลักฐานที่ผูก FK `onDelete: Cascade` กับของที่ต้องเก็บกวาด ต้องถูกบันทึกออกนอก DB ก่อนเก็บกวาดเสมอ"*
> **ลำดับบังคับ: บันทึกหลักฐาน → verify ว่าบันทึกครบ → แล้วจึงลบ**

### รอบนี้: **ไม่มีอะไรต้องเก็บกวาด** — และเหตุผลสำคัญกว่าตัวคำตอบ

| ของที่ถูกเขียน | ต้องลบไหม | ทำไม |
| --- | --- | --- |
| `ReadinessState` · `MechanismHeartbeat` บน prod | ❌ **ห้ามลบ** | ต่างจากตอนซ้อม (แถว 8 ของ closing-evidence) — ตอนนั้นเป็นแถวที่ **Preview** เขียนปนเข้ามา · **ตอนนี้ P2 live บน prod แล้ว ⇒ แถวเหล่านี้คือสถานะจริงที่ระบบใช้อยู่** ลบ = ทำให้ระบบลืมว่าตัวเองเคยเต้น ⇒ รอบถัดไปอ่านเป็น `missing` |
| cache entry `readiness-state-*` | ❌ **ห้ามลบ** | มันคือ **ความจำที่ทั้ง §H-12 สร้างขึ้นมา** และเป็นหลักฐานของแถว I-a |
| run / log บน Actions | ❌ ไม่ลบ | หลักฐานของทั้ง H และ G |

### ⚠️ ที่กฎนี้จะมีผลจริงคือ **ตอนทำ I-b** (การทดลองทำให้ save ล้ม) — เขียนไว้ล่วงหน้าเพราะตอนนั้นจะรีบ

1. **บันทึกก่อน:** `gh run view <id> --log` ของ run ที่ทดลอง + `gh api …/actions/caches?key=…` (ทั้งก่อนและหลัง) ลงไฟล์
2. **verify ว่าบันทึกครบ:** เปิดไฟล์ดูจริงว่ามีบรรทัด `::error::cache entry … ไม่มีอยู่จริง` อยู่ในนั้น — **ไม่ใช่แค่เห็นว่าไฟล์ถูกสร้าง**
3. **แล้วจึงลบ** cache entry ที่สร้างขึ้นเพื่อการทดลอง (ถ้ามี) — `gh api -X DELETE "/repos/$GH_REPO/actions/caches?key=…"`

⛔ **ห้ามสลับลำดับ** — cache entry ที่ถูกลบไปกู้กลับไม่ได้ และมันคือหลักฐานชิ้นเดียวที่พิสูจน์ว่า assertion ทำงาน
(บทเรียนจริงของโปรเจกต์: ลบ `WebhookEndpoint` ของ smoke แล้ว `WebhookDelivery` ที่เป็นหลักฐานหายตามทันที)

---

## สรุปสิ่งที่ต้องทำ ณ วินาที deploy

| ลำดับ | ทำอะไร | เดดไลน์ |
| --- | --- | --- |
| 1 | `export GH_REPO` / `EVID` (บนสุดของไฟล์นี้) | ก่อน merge |
| 2 | (ถ้าต้องการ) snapshot `ReadinessState` + `MechanismHeartbeat` | 🔴 **≤ 15 นาที** หลัง post-deploy run |
| 3 | ดึง log ของ run `dispatch` + run `post-deploy` (แถว H) | ≤ 1 ชม. |
| 4 | ดึง cache entry ผ่าน REST API (แถว I-a) | ≤ 24 ชม. |
| 5 | เปิดห้อง Discord เก็บ G-1/G-2 + log G-3 ของ transition 02:12Z | ไม่เร่ง (ทำได้ตั้งแต่ตอนนี้) |
| 6 | เขียนผลลง `phase-39-closing-evidence-2026-08-09.md` — **เฉพาะแถวที่มีผลจริง** | หลังเก็บครบ |

⛔ **ข้อ 6: ห้ามเติมช่องที่ยังไม่มีผลด้วยเจตนา** — กฎข้อแรกของไฟล์ closing-evidence
⇒ I-b และ (ถ้า `prev=—`) H ต้องคงเป็น ⬜ พร้อมเหตุผล ไม่ใช่ติ๊กผ่านเพราะ "เดี๋ยวก็ทำ"
