# P2 + P3 — กลไกพิสูจน์ว่าระบบยังทำงานจริง

Design response ต่อ Phase 39 Design Brief (2026-08-06) · อ้างอิง incident snapshot Phase 38 · เอกสารออกแบบ ไม่มีโค้ด ไม่มี library

## 0. ขอบเขต

เอกสารนี้ตอบ §5–§9 ของ design brief: ออกแบบ P2 (พิสูจน์ว่า server-side resource ใช้งานได้จริง) และ P3 (fail-soft ที่ observable) ให้ครอบ 4 กลไกใน §3 เท่าที่ทำได้ และระบุตรง ๆ ว่าข้อไหนต้องแยกงาน ไม่มีการเลือก library หรือ implementation — ทุกอย่างอยู่ในระดับกลไกและ data shape

## 1. สรุปแนวทาง

P2 ไม่ใช่ endpoint เดียวที่ตรวจ "ต่อได้ไหม" แต่เป็นกลไกสองชั้นที่แก้คนละปัญหา: **active probe** ที่เรียก provider จริงแบบ read-only (ไม่กินโควตาที่กำลังปกป้อง) เพื่อตอบ "ต่อได้ไหม และเหลือ headroom แค่ไหน" กับ **execution heartbeat** ที่บันทึกทุกครั้งที่กลไกภายใน (sweep, worker) รันจบสำเร็จจริง เพื่อตอบ "มันทำงานจริงหรือแค่ provider ยังไม่ตาย" — เพราะเคสวันนี้พิสูจน์แล้วว่า provider ปกติ (schedule ว่างเปล่าไม่ใช่ QStash พัง) ก็ยังทำให้ feature ไม่เคยรันได้ ทั้งสองชั้นถูกเรียกจาก **GitHub Actions** ซึ่งเป็นโครงสร้างเดียวที่อยู่นอก Vercel และนอก QStash พร้อมกัน แก้ปัญหา circular dependency ใน §6 ข้อ 3 โดยไม่ต้องเพิ่มบริการใหม่ ผลลัพธ์ถูกส่งเป็น alert เข้า Slack/Discord webhook — ช่องทางเดียวที่เหลืออยู่จริงสำหรับทีมขนาดนี้ตาม inventory ใน §1 ของ brief ต้นทุนรวมคือ $0/เดือน ใช้ของที่มีอยู่แล้วทั้งหมด (Postgres, GitHub Actions) บวก webhook ใหม่ 1 ตัว

## 2. ทางเลือก ≥ 2 ทาง

### ทางเลือก A — Active probe endpoint เดี่ยว

endpoint เดียว (`GET /api/ops/readiness`) ที่ยิง read-only call ไปหา provider จริงทุกครั้งที่ถูกเรียก (เช่น `GET /v2/schedules` ของ QStash, ping Redis) แล้วตอบสถานะสด ๆ ณ ขณะนั้น ถูกเรียกโดย GitHub Actions ตามรอบ

### ทางเลือก B — Execution heartbeat ล้วน (passive)

ไม่ probe provider เลย แทนที่ทุก worker/sweep เขียนแถว "รันสำเร็จล่าสุดเมื่อไหร่" ลง DB ทุกครั้งที่จบงานจริง แล้ว endpoint แค่อ่าน DB ว่าห่างจากรอบที่ควรรันกี่นาที เกิน threshold = FAIL ไม่มีการเรียก provider เพิ่มเลย ต้นทุน quota = 0 เป๊ะ

| แกน | A · Active probe | B · Heartbeat ล้วน |
| --- | --- | --- |
| จับเคส §2.3 (region ผิด แต่ env ครบ) | ✅ จับได้ตรง — เรียก provider จริงจึงเจอ error region ทันที แม้ไม่มี traffic เลย | ⚠️ จับได้ทางอ้อมเท่านั้น ต้องรอให้ worker/sweep พยายามรันจริงก่อนถึงจะไม่มี heartbeat ให้เห็น |
| กินโควตาที่ปกป้องอยู่ไหม (§6 ข้อ 2) | ไม่กิน ถ้าจำกัดเฉพาะ read-only call (list/GET) ซึ่งไม่นับใน publish quota — ต้องระวังไม่หลุดไปเรียก endpoint ที่ publish จริง | ไม่กินเลย เพราะไม่เรียก provider เพิ่มแม้แต่ครั้งเดียว |
| bootstrap gap | ไม่มี — probe ทำงานได้แม้ feature ยังไม่เคยรันสักครั้ง | 🔴 มี — "ไม่เคยมี heartbeat" ต้องถูก treat เป็น FAIL ตั้งแต่ต้น ไม่งั้นจะเหมือน §2.1 เป๊ะ (ไม่เคยเริ่ม = อ่านไม่ออกว่าผิดปกติ) |
| จับ §3 ข้อ 3–4 (near-breach / per-tenant sweep) | ❌ ไม่เห็น — provider (QStash) ปกติดีในสองเคสนี้ ปัญหาอยู่ใน logic ของแอปเอง | ✅ เห็นได้ ถ้าทำ heartbeat ระดับ (tenant, mechanism) ไม่ใช่แค่ระดับ mechanism |
| ต้นทุนสร้าง | ต่ำ — endpoint เดียว ไม่ต้องแก้ business code | สูงกว่า — ต้องแทรก instrumentation ในทุก call site ที่อยากเฝ้า |

**เลือก: hybrid ของทั้งสอง ไม่ใช่เลือกทางเดียว** — เหตุผลคือทั้งสองจับคนละคลาสของความล้มเหลวใน §3 พอดี: A จับ #1–#2 (ปัญหาที่ provider) B จับ #3–#4 (ปัญหาที่ logic ของแอปเอง แม้ provider ปกติ) ทางใดทางหนึ่งเดี่ยว ๆ ครอบได้แค่ครึ่งเดียวของ §3 การเลือกทางเดียวจะขัดกับ §5 ที่บังคับตอบให้ครอบทั้ง 4 ข้อหรือระบุชัดว่าข้อไหนต้องแยกงาน — ถ้าไม่ใช้ B เลย ข้อ 3–4 จะกลายเป็น "ไม่ครอบเลย" ทั้งที่ B ปิดช่องว่างนั้นได้ด้วยต้นทุนที่ยังอยู่ในเพดาน (ดู §7)

## 3. คำตอบ 10 ข้อใน §6 ของ brief

### 1. ใครเรียก และเมื่อไหร่

| จังหวะ | ใครเรียก | จับบั๊กชั้นไหน |
| --- | --- | --- |
| build-time | — (ข้าม) | ตรวจไม่ได้จริง — server env อ่านตอน runtime เท่านั้น (§4 ข้อ 2) ตรวจตอน build = ตรวจผิดชั้น |
| post-deploy (ครั้งเดียวหลัง alias promote) | GitHub Actions step ต่อท้าย deploy | จับ "deploy รอบนี้พังตั้งแต่ต้น" เร็วที่สุด — ถ้ามีตอนมิ.ย. จะเจอ region mismatch ภายในนาที ไม่ใช่ 7 สัปดาห์ |
| ตามรอบ (cron) | GitHub Actions schedule (เช่นทุก 15 นาที) | จับ "พังหลัง deploy" — quota หมดทีหลัง, provider outage, key หมดอายุ ไม่มี deploy ใหม่มา trigger post-deploy check |
| ตอนมีคนเข้าใช้ | — (ข้ามในตอนนี้) | prod มีแค่ 2 demo tenant ไม่มี traffic จริงพอจะเป็นสัญญาณ ทำตอนนี้ = ต้นทุนที่ไม่ได้อะไรเพิ่ม เก็บไว้เป็นตัวเลือกเมื่อมีลูกค้าจริง |

เลือกอย่างเดียวพลาดอะไร: post-deploy อย่างเดียวพลาดความเสื่อมหลัง deploy (quota ค่อย ๆ หมด) ส่วน cron อย่างเดียวพลาดว่า "deploy ล่าสุดพังตั้งแต่วินาทีแรก" ช้าไปเท่าความถี่ cron — ทั้งสองจังหวะจำเป็นพร้อมกัน ไม่ใช่เลือกใดเลือกหนึ่ง

### 2. ไม่กินทรัพยากรที่ตัวเองปกป้อง

แยก call เป็น 2 ประเภทตาม provider: **read/list call** (เช่น `GET /v2/schedules`, `/v2/queues`, `/v2/keys`) ซึ่งเป็น metadata ไม่ใช่ message dispatch — นี่คือ call แบบเดียวกับที่ incident เองใช้วินิจฉัยแบบ read-only ใน §2.2–2.3 ของ phase-38 (ระบุ "read-only" ไว้ชัดเจน) จึงยืนยันได้ว่าไม่กินโควตา publish 1,000/วัน · ห้าม probe ด้วยการ publish message จริงเด็ดขาด (นั่นคือรูปแบบที่ §6 ข้อ 2 เตือนไว้) headroom ของ quota เอง (ซึ่งไม่มี API มาตรฐานให้ query โดยตรงสำหรับ free tier) วัดด้วยการ self-meter แทน — นับจำนวนครั้งที่แอปเรียก publish จริงเองสะสมต่อวันไว้ใน Postgres (มีอยู่แล้ว) ไม่ต้องถาม provider เพิ่ม จุดอ่อนที่ต้องบอกตรง ๆ : ตัวเลขนี้นับเฉพาะ publish ที่แอปเรียกเอง ไม่รวม retry ที่ QStash ทำฝั่งมันเอง (retry นับโควตาจริงแต่แอปไม่เห็น) — เป็น proxy ที่ conservative ผิดทาง (underestimate การใช้จริง) ไม่ใช่ over-estimate จึงไม่ทำให้ false-PASS แต่ต้องบันทึกไว้เป็นข้อจำกัดที่รู้ตัว

### 3. Circular dependency — ใครเฝ้าคนเฝ้า

ตัวกำหนดจังหวะ (scheduler) ต้องไม่ใช่ QStash — ใช้ GitHub Actions ซึ่ง inventory ใน §1 ของ brief ยืนยันแล้วว่า "อยู่นอก Vercel และนอก QStash = ไม่ตายพร้อมกัน" ถ้า QStash ตายทั้งบริการ: probe (ทางเลือก A) จะได้ error จาก provider ตรง ๆ → GitHub Actions เห็น response ผิดปกติ (หรือ timeout) → alert ยิงเข้า Slack ได้ตามปกติ เพราะ GitHub Actions เองไม่ได้พึ่ง QStash ในการรันตามรอบ นี่คือคำตอบของเกณฑ์ §8 ข้อ 3 โดยตรง

### 4. Probe ล้มแล้วบอกใคร

ช่องทางเดียวที่ผ่านเกณฑ์ทั้งหมดของ brief เอง (ไม่ใช่อีเมล — circular ตาม §1 ของ brief, ไม่ใช่ on-call — ทีมไม่รับ): Slack/Discord incoming webhook ต้นทุนตามที่ inventory ระบุไว้แล้วคือ webhook 1 ตัว + env 1 ตัว ฟรี GitHub Actions step ที่ตรวจ FAIL แล้ว POST เข้า webhook นี้โดยตรง เสริมอีกชั้นแบบไม่มีต้นทุนเพิ่ม: ถ้า workflow เอง crash (ไม่ใช่ probe fail แต่ workflow รันไม่จบ) GitHub จะส่ง notification ของตัวเองไปหา repo collaborators โดยอัตโนมัติอยู่แล้ว — เป็น safety net ชั้นสุดท้ายที่ไม่ต้องตั้งอะไรเพิ่ม (ดูข้อ 10)

### 5. แยก "ต่อไม่ได้" ออกจาก "ต่อได้แต่ใกล้หมดโควตา"

สถานะต้องเป็น 3 ระดับ ไม่ใช่ boolean: **OK** (connect สำเร็จ + headroom เหนือ threshold) · **DEGRADED** (connect สำเร็จ แต่ self-metered counter เกิน threshold ที่ตั้งไว้ห่างจาก 0 พอสมควร เช่น ใช้ไปแล้วเกิน 80% ของโควตารู้จัก) · **FAIL** (connect ไม่สำเร็จเลย) การตั้ง threshold ให้ห่างจาก 100% พอสมควรทำให้เคส "เหลือ 0.1%" ตกอยู่ใน DEGRADED (หรือ FAIL ถ้าตั้งเพดานสองชั้น) มาก่อนจะถึงศูนย์แน่นอน — นี่คือคำตอบของเกณฑ์ §8 ข้อ 2 โดยตรง

### 6. Auth ของ endpoint

แยกเป็น 2 response shape: (ก) เรียกแบบไม่ auth ได้ผลลัพธ์แค่คำเดียว (`ok / degraded / fail`) ไม่มีชื่อ provider ไม่มี error message — เทียบเท่า status page สาธารณะทั่วไป ไม่เปิดเผยอะไรที่ใช้โจมตีได้ (ข) รายละเอียดเต็ม (error string, ชื่อ mechanism ที่ล้ม) ต้องแนบ shared-secret header ต้นทุน = env ใหม่ 1 ตัว ทั้งสองฝั่ง (Vercel + GitHub Actions secret) GitHub Actions ใช้ (ข) เพราะเป็นผู้ใช้เดียวที่ต้องรู้รายละเอียดพอจะเขียนข้อความ alert ที่มีประโยชน์ ไม่ใช้ QStash signature เป็น auth เพราะ circular ตรงตามที่ §6 ข้อ 6 เตือนไว้เอง (endpoint นี้ต้องตอบได้แม้ QStash ตายสนิท)

### 7. กัน alert fatigue

แจ้งเฉพาะตอน**เปลี่ยนสถานะ** (transition) ไม่ใช่ทุกครั้งที่ poll — เก็บสถานะล่าสุดไว้ 1 ค่า (DB แถวเดียวก็พอ) เทียบกับผลรอบนี้ ถ้าเหมือนเดิมไม่ส่งอะไร ส่งเฉพาะ OK→DEGRADED, DEGRADED→FAIL, และ FAIL→OK (recovery ก็ต้องแจ้ง ไม่งั้นจะไม่รู้ว่าจบปัญหาแล้วหรือยัง) กฎเดียวนี้ตัด noise ส่วนใหญ่ทิ้งได้เพราะสถานะปกติควรอยู่นิ่งเป็นส่วนใหญ่ของเวลา

### 8. เส้นแบ่งกับ Sentry / Better Stack / Checkly

**Sentry (error tracking)** ตอบโจทย์นี้ไม่ได้โดยธรรมชาติ — ปัญหาทั้งหมดใน §3 คือ error ที่ถูก*กลืนโดยเจตนา* (fail-soft ที่ถูกต้อง) Sentry เห็นเฉพาะสิ่งที่ throw ออกมาไม่ถูกจับ ถ้าจะให้ Sentry เห็นก็ต้องเพิ่มจุด capture ที่ catch block เอง ซึ่งพอทำถึงขั้นนั้นก็เขียนลง DB ของตัวเองได้เลยโดยไม่ต้องเพิ่ม vendor **Checkly / Better Stack (synthetic monitoring)** ตรงกับ pattern ที่ต้องการที่สุด (external pinger + alert) แต่เป็น vendor ใหม่ที่ต้องเรียนรู้และผูก account — สิ่งที่มันให้ (dashboard, escalation policy, status page) เกินความจำเป็นของทีมคนเดียวไม่มี on-call ในขณะที่ GitHub Actions + Slack webhook ทำ pattern เดียวกันได้ที่ $0 ด้วยของที่มีอยู่แล้ว **ข้อสรุป: ไม่ใช้วันนี้ ไม่ใช่เพราะไม่เหมาะ แต่เพราะสิ่งที่มันให้เกินสิ่งที่ทีมขนาดนี้ใช้ได้จริง** — ถ้ามีลูกค้าจริง + on-call rotation เมื่อไหร่ ควรกลับมาพิจารณาใหม่

### 9. Multi-tenancy

Readiness เป็น global โดยธรรมชาติ (provider connectivity, quota) จึงต้อง**ไม่เดินผ่าน tenant-scoped query pipeline** ตาม §4 ข้อ 6 — endpoint ต้องอยู่นอกเส้นทาง resolve tenant จาก subdomain (proxy ที่ redirect ทุก path บน host ที่ไม่ใช่ tenant ตามที่ phase-38 §8.3 อธิบายไว้ ต้อง special-case path นี้ให้ผ่านโดยไม่ redirect และไม่ต้อง resolve tenant) heartbeat ระดับ per-tenant (สำหรับ §3 ข้อ 4) เก็บ tenantId เป็น attribute ของข้อมูล operational ไม่ใช่ tenant-owned data — อ่านผ่าน query ภายในของ ops path เท่านั้น ไม่ผ่าน helper ที่บังคับ tenant scope ของแอปหลัก เป็นข้อยกเว้นที่ต้องระบุไว้ชัดว่าทำไมถึงไม่ scope (metadata เกี่ยวกับ tenant ไม่ใช่ข้อมูลของ tenant)

### 10. ใครรู้ว่า P2 เองยังไม่ตาย

ห่วงโซ่หยุดที่ GitHub Actions เอง เพราะเป็นจุดที่ไม่มีอะไรถูกๆ ให้เฝ้าซ้อนได้อีกแล้วในเพดาน $0 — ถ้า workflow รันไม่จบ GitHub จะแจ้ง repo collaborators เองโดยไม่ต้องตั้งค่าเพิ่ม (native failure notification) จุดที่**ยังไม่ครอบและต้องบอกตรง ๆ**: scheduled workflow ของ GitHub Actions จะถูกปิดอัตโนมัติถ้า repository ไม่มี activity ใด ๆ นานเกิน ~60 วัน — ถ้าเกิดกับ repo นี้ (ซึ่งมีแค่ 1 คน + AI ดูแล ไม่การันตีว่า commit ถี่พอ) จะไม่มีอะไรแจ้งเตือนเลยว่า cron หยุดทำงาน เป็นช่องว่างจริงที่ยังไม่มีทางปิดที่ $0 (การปิดจริงต้องมีตัวเฝ้านอก GitHub ซึ่งเสียเงิน) — ทางบรรเทาเดียวที่ทำได้ฟรีคือจดเป็นเช็คลิสต์ให้มีคน/AI ตรวจ 1 ครั้งต่อเดือนว่า workflow run ล่าสุดยังขึ้นอยู่ (นับเป็นส่วนหนึ่งของงบดูแล ≤15 นาที/สัปดาห์)

## 4. ครอบ §3 ข้อไหนบ้าง

| # | กลไก | ครอบโดย | สถานะ |
| --- | --- | --- | --- |
| 1 | publish ถูกปฏิเสธที่ต้นทาง | Active probe (A) — read-only call ไปที่ provider เดียวกับที่ publish ใช้ | ✅ ครอบเต็ม |
| 2 | QStash quota หมด | Self-metered counter ใน probe (มี caveat เรื่อง retry ที่นับไม่ได้ — ดูข้อ 2 ใน §3) | ⚠️ ครอบบางส่วน (conservative proxy ไม่ใช่ตัวเลขจริง 100%) |
| 3 | SLA near-breach หน้าต่างแคบ (probabilistic) | Heartbeat (B) ทำให้ "อัตราการยิงเตือนสำเร็จ" เป็นตัวเลขที่มองเห็นได้ แทนที่จะเป็น "เคยเห็นเตือนครั้งหนึ่งแล้วสรุปว่าปกติ" | ⚠️ ครอบแค่ observability ไม่ใช่ fix — ตัวกลไก (polling window) ยังต้องเปลี่ยนเป็น per-ticket scheduling ตามที่ phase-38 §5.1.1 ระบุไว้ว่าเป็นงานออกแบบแยก ไม่ใช่ P2/P3 |
| 4 | sweep ไม่มี per-tenant checkpoint | Heartbeat ระดับ (tenant, mechanism) — เห็นได้ว่า mechanism ทำงาน (heartbeat ระดับบนสด) แต่ tenant ท้าย ๆ ไม่เคยได้ heartbeat | ⚠️ ครอบแค่ observability — ทำให้เห็นว่า tenant ไหนถูกทิ้ง แต่ไม่ได้เพิ่ม checkpoint/resume logic ให้ sweep เอง (นั่นเป็นงาน engineering แยก) |

สรุปตรง ๆ: P2+P3 ครอบ #1 เต็ม, ครอบ #2 ด้วยตัวเลข proxy ที่มี caveat, ให้ observability กับ #3–#4 แต่ไม่แก้ root cause ของทั้งคู่ — การแก้ #3 (per-ticket scheduling) และ #4 (checkpoint/resume ใน sweep) เป็นงานออกแบบกลไกคนละชิ้น ควรเป็น phase ถัดไป ไม่ใช่ส่วนหนึ่งของ P2/P3

## 5. ทดสอบดีไซน์นี้เองกับเกณฑ์ §8

### ข้อ 1 (หลัก) — รันกับสภาพ §2.3 แล้วต้องไม่ PASS

สภาพ §2.3: env ทุกตัวที่รู้จักครบและถูกต้อง แต่ `QSTASH_URL` ไม่มี → SDK ตกไปใช้ default endpoint (EU) แต่บัญชีอยู่ US → probe ของ A เรียก `GET /v2/schedules` (หรือ endpoint read-only เดียวกัน) ด้วย client ตัวเดียวกับที่โค้ด production ใช้จริง (ไม่ประกอบ URL เองแยกต่างหาก — ต้องใช้ code path เดียวกับที่ publish ใช้ ไม่งั้นตรวจคนละอินสแตนซ์) → ได้ `404 user not found in this region (eu-central-1)` เป๊ะตามที่เกิดจริง → **ผลคือ FAIL ไม่ใช่ PASS** เพราะ probe ไม่เคยเช็คว่า "ตัวแปรมีค่าไหม" เลย มันเช็คว่า "เรียก provider นี้แล้วสำเร็จไหม" ซึ่งเป็นคนละคำถามกับที่ §7 ปฏิเสธไปแล้ว

**วิธี reproduce สภาพ §2.3 มาทดสอบจริง (ไม่ใช่แค่เจตนา):** ไม่ต้องรอ incident ใหม่ — ใช้ Vercel **Preview environment** ซึ่งตาม phase-38 §8.1 ใช้ QStash account/token ชุดเดียวกับ Production อยู่แล้ว (บันทึกไว้ชัดว่าต้องตั้งทั้ง Production และ Preview ให้ตรงกัน) ทำได้ดังนี้:

1. ไปที่ Vercel env ของ Preview scope เอา `QSTASH_URL` ออก (ลบเฉพาะ scope Preview ไม่แตะ Production)
2. trigger deploy ของ Preview (เช่น push ไป branch ที่ไม่ใช่ main หรือ redeploy preview ล่าสุด)
3. ยิง probe endpoint ไปที่ URL ของ Preview deployment นั้นตรง ๆ
4. ผลที่ต้องได้: `FAIL` พร้อม error signature เดียวกับ §2.1 ของ phase-38 (`not found in this region (eu-central-1)`) — ถ้าออกมาเป็น `OK` แปลว่าดีไซน์นี้ผิด ต้องแก้ก่อนใช้จริง
5. ตั้ง `QSTASH_URL` กลับคืน Preview แล้ว redeploy อีกครั้งเพื่อปิดช่องว่างไว้ ไม่ปล่อย Preview ค้างอยู่ในสภาพพัง

ทั้งหมดนี้ทำได้ที่ $0 ใช้เวลา <5 นาที ไม่กระทบ Production traffic เลย เพราะเป็น scope Preview ล้วน — เป็น rehearsal ที่ทำซ้ำได้ทุกครั้งที่แก้ดีไซน์ ไม่ใช่แค่ทดสอบครั้งเดียวตอนส่งมอบ

### ข้อ 2 — โควตาเหลือ 0.1% ต้องไม่ PASS

ผ่าน ถ้า threshold ของ DEGRADED ตั้งไว้สูงกว่า 0.1% มาก (เช่น 80% ใช้ไปแล้ว) — 0.1% เหลือ (คือใช้ไป 99.9%) จะตกอยู่ใน DEGRADED (หรือ FAIL ถ้าตั้งสองเพดาน) มาก่อนถึงจุดวิกฤตแน่นอน ข้อควรระวังที่ต้องระบุไว้: threshold ต้องตั้งจากตัวเลข usage จริง (§3 ของ phase-38: cron ปกติ 288/วัน = 28.8%, พังต่อเนื่อง 1,152/วัน = 115.2%) ไม่ใช่เดาลอย ๆ — 80% เป็นจุดที่ยังเหลือ margin พอให้คนตอบสนองทันก่อนพัง

### ข้อ 3 — QStash ตายทั้งบริการต้องยังส่งเสียงได้

ผ่าน — ตอบไว้แล้วใน §3 ข้อ 3 ด้านบน (scheduler = GitHub Actions ไม่ใช่ QStash)

### ข้อ 4 — รู้ได้ยังไงว่า P2 เองยังไม่ตาย

ตอบไว้แล้วใน §3 ข้อ 10 — พร้อมช่องว่างที่ระบุตรง ๆ ว่ายังไม่ปิด (60-day auto-disable ของ GitHub Actions)

### ข้อ 5 — ต้นทุนต้องระบุ + เพดาน $0 / ≤1 วัน / ≤15 นาทีต่อสัปดาห์

| ส่วน | เงิน/เดือน | เวลาสร้าง | ดูแลต่อเนื่อง |
| --- | --- | --- | --- |
| Probe endpoint (A) + quota counter | $0 | ~ครึ่งวัน | ต่ำ — event-driven |
| GitHub Actions workflow + Slack webhook | $0 | ~1–2 ชม. | ตรวจ workflow ยังรันอยู่ 1 ครั้ง/เดือน (~5 นาที/เดือน) |
| Heartbeat table (mechanism-level เท่านั้น) | $0 | ~2–3 ชม. | ต่ำ |
| Heartbeat ระดับ per-tenant + generalized fail-soft event log (ครอบ §3 ข้อ 3–4 เต็มที่) | $0 | 🔴 เกิน 1 วัน — ต้องแทรก instrumentation หลาย call site | ต่ำหลังสร้างเสร็จ |

**ติดป้ายเกินเพดานตรงนี้:** แถวสุดท้ายเกิน 1 วัน — ตัดให้ลงมาในเพดานได้โดยทำเฉพาะ mechanism-level heartbeat ก่อน (ครอบแค่ "มันรันไหม" ระดับระบบ) แล้วค่อยขยายเป็น per-tenant ในรอบถัดไป (ดู §6 ลำดับงาน) เงินและ headcount ทุกส่วนอยู่ในเพดาน $0 อยู่แล้วเพราะใช้ของที่มีอยู่ทั้งหมด

## 6. ลำดับงานที่ทำได้จริง

| ลำดับ | งาน | ต้องมีก่อน |
| --- | --- | --- |
| 1 | Probe endpoint A (read-only QStash call + Redis ping) + response 3 ระดับ + auth 2 ชั้น | — |
| 2 | Self-metered quota counter + threshold DEGRADED | 1 (ต้องมี endpoint ให้ผูกผลลัพธ์) |
| 3 | GitHub Actions: post-deploy step + cron ตามรอบ + Slack webhook + กฎแจ้งเฉพาะ transition | 1–2 (ต้องมี endpoint ให้เรียกก่อน) |
| 4 | รัน rehearsal reproduce §2.3 บน Preview (ดู §5) ยืนยันว่า FAIL จริง | 1–3 ต้องขึ้น production/preview แล้ว |
| 5 | Heartbeat table ระดับ mechanism (sla-sweep, webhook worker) + endpoint อ่านมารวมกับ A | 1 (ใช้ endpoint เดียวกัน) |
| 6 (แยก phase — เกินเพดาน 1 วัน) | ขยาย heartbeat เป็น per-tenant + generalized fail-soft event log ในทุก catch block ของ §3 | 5 |
| — (แยกงานคนละชิ้น ไม่ใช่ P2/P3) | Per-ticket scheduling (แทน near-breach polling) · per-tenant checkpoint/resume ใน sweep | ไม่ต้องรอ P2/P3 — ทำคู่ขนานได้เลย |

## 7. ไม่ซ้ำ §7 — เช็คสั้น ๆ

ไม่มีข้อไหนใน §7 ที่เห็นว่าถูกปฏิเสธเพราะเข้าใจผิด — เห็นด้วยกับเหตุผลเดิมทั้ง 9 ข้อ ดีไซน์นี้เลี่ยงแต่ละข้อโดยตรง: ไม่เช็คค่า env (เรียก provider จริงเสมอ) · ไม่อ่าน env จาก Vercel มาเทียบ (ไม่แตะ Vercel API เลย) · ไม่มี NEXT_PUBLIC_* ใน endpoint นี้ · ไม่ผูกกับ CI (เรียก URL ของ deployment จริงที่ live ไม่ใช่ container ตอน build) · ไม่ผูกกับ package.json build (ไม่ใช่ build-time gate) · ไม่ใช้ docs เป็น gate (เป็น loop อัตโนมัติที่รันจริงทุกรอบ) · ไม่มี escape hatch แบบคำแนะนำในเอกสาร · ค่าเริ่มต้นเมื่อไม่พบ heartbeat คือ FAIL เสมอ ไม่ใช่ PASS (กัน fallback ที่เขียวปลอม)

## 8. สิ่งที่ดีไซน์นี้ยังไม่ครอบ

- ไม่แก้ root cause ของ §3 ข้อ 3 (near-breach polling window แคบ) — ต้องเปลี่ยนเป็น per-ticket scheduling ตามที่ phase-38 §5.1.1 ระบุไว้แล้วว่าเป็นงานออกแบบแยก
- ไม่แก้ root cause ของ §3 ข้อ 4 (sweep ไม่มี checkpoint) — ต้องเพิ่ม resume logic ให้ sweep เอง เป็นงาน engineering แยก ไม่ใช่ observability
- quota headroom เป็นตัวเลข proxy จากการ self-meter ไม่ใช่ตัวเลขจริงจาก provider (ไม่มี API ให้ query โดยตรงบน free tier) — underestimate เมื่อมี retry ฝั่ง QStash เอง
- ไม่ครอบ Postmark/SendGrid เพราะยังไม่ตัดสินใจเลือก provider ตามที่ §1 ของ brief ระบุไว้ — เพิ่ม probe ของ email ได้ทันทีที่ตัดสินใจแล้ว โดยใช้ pattern เดียวกัน
- 60-day auto-disable ของ GitHub Actions scheduled workflow ยังไม่มีทางปิดที่ $0 — บรรเทาได้ด้วยเช็คลิสต์รายเดือนเท่านั้น ไม่ใช่กลไกอัตโนมัติ
- ไม่ครอบ traffic-triggered check (ตอนมีคนเข้าใช้จริง) เพราะ prod วันนี้ไม่มี traffic จริงพอเป็นสัญญาณ — ควรกลับมาออกแบบเมื่อมีลูกค้าจริง
