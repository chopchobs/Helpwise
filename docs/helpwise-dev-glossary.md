# Helpwise — Dev Glossary (ศัพท์ช่างสำหรับสัมภาษณ์)

> รวมศัพท์ที่ใช้ในโปรเจกต์ helpwise + ที่ dev คุยกันบ่อย
> แต่ละคำ: **ความหมายสั้น · ตัวอย่างใน helpwise · ประโยคพูดจริง**
> เป้าหมาย: ฟังแล้วเข้าใจ + หยิบมาใช้ตอนสัมภาษณ์ได้

---

## 1. Multi-tenancy & Isolation

### Tenant
บริษัทลูกค้า 1 เจ้าที่เช่าใช้ระบบ (Acme, Globex) — เป็น **ขอบเขตข้อมูล** ไม่ใช่ "คน"
- helpwise: แยกข้อมูลด้วยคอลัมน์ `tenantId` ทุกตาราง
- พูด: *"แต่ละ tenant คือ boundary ของข้อมูล ห้าม leak ข้ามกัน"*

### Multi-tenancy
สถาปัตยกรรมที่ลูกค้าหลายเจ้าใช้ระบบ/ฐานข้อมูลเดียวกัน แต่ข้อมูลแยกขาด
- helpwise ใช้แบบ **shared database, shared schema** (DB เดียว ตารางเดียว แยกด้วย `tenantId`)
- ทางเลือกอื่น: database-per-tenant, schema-per-tenant

### Tenant isolation
การรับประกันว่า tenant A เห็นข้อมูล tenant B ไม่ได้ — กฎสูงสุดของ helpwise
- พูด: *"cross-tenant data leak คือ critical bug ที่ร้ายแรงที่สุด"*

### Application-enforced isolation
การบังคับแยกข้อมูลที่ **ชั้นแอป (โค้ด)** ไม่ใช่ที่ DB — ผ่าน `tenantPrisma()` ที่ inject `tenantId` ทุก query
- จุดอ่อน: บังคับได้เฉพาะคนที่ใช้ `tenantPrisma` (ถ้าเลี่ยงไปใช้ raw query = หลุด)

### RLS (Row-Level Security)
ฟีเจอร์ของ PostgreSQL ที่ให้ **DB เอง** กรอง row ตาม policy — เป็น isolation ที่ชั้น DB (แข็งกว่า app-layer เพราะกันได้แม้ query ลืม scope)
- helpwise: scaffold ไว้แต่ **ยังไม่ active** (เพราะ app ต่อผ่าน BYPASSRLS role)

### BYPASSRLS
สิทธิ์ของ DB role ที่ทำให้ RLS policy **ถูกข้าม** — role ที่มีสิทธิ์นี้มองเห็นทุก row
- helpwise: prod ต่อด้วย role นี้ → RLS เลยยังไม่ enforce จริง
- พูด: *"RLS scaffolded as defense-in-depth but not active — app connects via BYPASSRLS role"*

### Enforce / Enforcement
"บังคับใช้กฎ" ให้เกิดผลจริง ระบบไม่ยอมให้ฝ่าฝืน (ต่างจากแค่เขียนเอกสารห้าม)
- เทียบ: ป้ายห้ามจอด (ไม่ enforce) vs ที่กั้นรถ (enforce)

---

## 2. Security Concepts

### Defense-in-depth
ป้องกันหลายชั้นซ้อน — ชั้นนึงพังอีกชั้นยังกัน
- helpwise: contact ที่ยิงผิด tenant โดน 3 ชั้นกัน (token check + tenantPrisma scope + tenantId compare)
- พูด: *"ถ้าด่านนึงพลาด ยังมีด่านถัดไปกันอยู่"*

### Fail-closed vs Fail-open
พฤติกรรมเมื่อ dependency (เช่น Redis) ล่ม
- **fail-closed** = ปฏิเสธ (เน้น safety) → helpwise: AI rate-limit (ถ้าปล่อยผ่าน = ค่า API บาน)
- **fail-open** = ปล่อยผ่าน (เน้น availability) → helpwise: tenant lookup (ปล่อยผ่าน = แค่ query DB แทน cache)
- พูด: *"เลือกตาม cost ของการปล่อยผ่านเมื่อ dependency ล่ม"*

### Blast radius
"ขอบเขตความเสียหาย" ถ้าระบบโดนเจาะ — ออกแบบให้เล็กที่สุด
- helpwise: AI ไม่มี tools → ต่อให้โดน prompt injection ผลแย่สุดแค่ "สรุปมั่ว" ไม่ถึงขั้นลบ data

### Prompt injection
การโจมตี LLM ด้วยการฝังคำสั่งในข้อความ (เช่น "ignore all instructions")
- helpwise กัน: no-tools + lib ไม่แตะ DB → LLM ไม่มี capability ทำ action แม้ถูกหลอก

### Tenant spoofing
การปลอม `tenantId` เพื่อเข้าถึงข้อมูล tenant อื่น
- helpwise กัน: `proxy.ts` เขียนทับ `x-tenant-id` header เสมอ ห้ามเชื่อ client

### Information leak / Enumeration
การเผยข้อมูลโดยไม่ตั้งใจ ทำให้คนเดา/ไล่หาได้
- helpwise: หา ticket ไม่เจอคืน **404 ไม่ใช่ 403** (403 = บอกว่า "มีอยู่จริงแต่ห้ามดู")

### XSS (Cross-Site Scripting)
แฮกเกอร์ฝัง JS ในหน้าเว็บเพื่อขโมยข้อมูล
- helpwise กัน: cookie ตั้ง `httpOnly` (JS อ่าน cookie ไม่ได้) + escape HTML ก่อนใส่ email

### CSRF (Cross-Site Request Forgery)
หลอกให้ browser ผู้ใช้ยิง request ที่ไม่ตั้งใจ
- helpwise กัน: cookie ตั้ง `sameSite: strict`

### Signature verification
เช็คว่า request มาจากแหล่งที่อ้างจริง ด้วยลายเซ็นจาก secret key ที่แชร์กัน
- helpwise: verify QStash signature + Stripe webhook signature ก่อนทำงาน

### Allowlist vs Denylist
- **allowlist** = อนุญาตเฉพาะที่รู้ว่าปลอดภัย อย่างอื่นปฏิเสธหมด → **fail-safe**
- **denylist** = ไล่บล็อกของอันตราย (เผลอลืมตัวเดียว = ช่องโหว่)
- helpwise: slug ใช้ `/^[a-z0-9-]+$/` (allowlist) ปลอดภัยกว่าไล่บล็อก `.` `/` `@`
- พูด: *"allowlist ลืมเคสไหนก็แค่ block ของถูกต้อง ไม่ใช่เปิดช่อง"*

### Fail-safe
ออกแบบให้ "เมื่อพลาด ให้พลาดไปทางปลอดภัย" — allowlist, fail-closed คือตัวอย่าง

### Client-controlled input / Trust boundary
input ที่ฝั่ง client กำหนดค่าได้เอง → อยู่ฝั่ง "ไม่เชื่อ" ของเส้น trust boundary
- ตัวอย่าง: `Host` header, query param, request body, tenantId จาก client — **ปลอมได้**
- helpwise: ห้ามเอา Host header มาประกอบ redirect URL (open-redirect) / ห้ามเชื่อ tenantId จาก client
- พูด: *"อย่าเอา input ที่ client คุมได้มาประกอบ URL หรือใช้ตัดสินใจ security"*

### Open-redirect
ช่องโหว่ที่หลอกให้เว็บ redirect ไปเว็บอันตราย ด้วยค่าที่ผู้โจมตีคุมได้ (ใช้ทำ phishing)
- helpwise กัน: ใช้ relative path `/demo` + ประกอบ URL จาก slug (DB) + rootDomain (env) เท่านั้น

---

## 3. Concurrency & Data Integrity

### Race condition
บั๊กที่เกิดเมื่อ 2 operation รันพร้อมกันแล้วผลเพี้ยน
- helpwise: 2 agent สร้าง ticket พร้อมกัน → เลข ticketNumber อาจชน

### Atomic
operation ที่ "เกิดทั้งหมดหรือไม่เกิดเลย" แบ่งครึ่งไม่ได้ — กัน race
- helpwise: `ticketCounter: { increment: 1 }` เป็น atomic increment

### Row lock
DB ล็อก row ไว้ระหว่าง transaction → request อื่นต้องรอ → serialize
- helpwise: lock บน Tenant row ตอน increment counter → ticketNumber ไม่ชน

### TOCTOU (Time-Of-Check to Time-Of-Use)
race ชนิดหนึ่ง: ตอน "เช็ค" กับตอน "ใช้" มีช่องว่าง คนอื่นแทรกได้
- helpwise: เช็ค `emailSentAt === null` แล้วค่อย set → 2 worker เช็คเห็น null พร้อมกัน → ส่งซ้ำ
- แก้ด้วย: conditional `updateMany` (atomic claim) — มีแค่ตัวเดียวที่ `count === 1`

### Idempotent
ทำซ้ำกี่ครั้งผลเหมือนทำครั้งเดียว — สำคัญมากกับ webhook/queue ที่ retry ได้
- helpwise: QStash retry ส่ง email ซ้ำได้ → ต้อง idempotent กันส่งเมลซ้ำ
- พูด: *"webhook ต้อง idempotent เพราะ provider ส่งซ้ำได้"*

### At-least-once delivery
queue/webhook garantee ว่าส่งงาน "อย่างน้อย 1 ครั้ง" (อาจมากกว่า) → ผู้รับต้อง idempotent เอง

### Claim-first
"จอง" งานก่อนทำ ด้วยการ insert/update ที่มี unique constraint → ตัวแรกชนะ ตัวซ้ำรู้ว่ามาแล้ว
- helpwise: Stripe webhook `create ProcessedStripeEvent(eventId @unique)` — P2002 = เคยเห็นแล้ว
- helpwise: send-email `updateMany where emailSentAt=null` — count===1 คือตัวชนะ

### Stuck-processing
บั๊กที่ event fail แล้วถูก mark "เคยเห็น" → retry มาก็ skip → **ค้างถาวร ไม่มีวันสำเร็จ**
- helpwise กัน: แยก status `ok` (skip) กับ `error`/`processing` (reprocess) → fail แล้วยัง retry ได้
- ตัวอย่างพัง: ลูกค้าจ่ายเงินแล้วแต่ DB ยัง plan เก่า เพราะ sync fail แล้วโดน skip ถาวร

### Non-2xx retry policy (webhook)
status code สื่อสารกับ sender ว่าจะ retry ไหม
- **400** = ผิดถาวร (signature ผิด) → อย่า retry · **200** = สำเร็จ/duplicate → ไม่ต้อง retry · **500** = ชั่วคราว → retry

---

## 4. Architecture & Code Design

### Deep module
interface เล็ก (เรียกง่าย) ซ่อนความซับซ้อนไว้ข้างใน — จาก "A Philosophy of Software Design"
- helpwise: `lib/queue.ts` เปิดแค่ 2-3 ฟังก์ชัน ซ่อน signature/retry/fallback ไว้ข้างใน

### Separation of concerns
แยกแต่ละส่วนให้รับผิดชอบเรื่องเดียว
- helpwise: `lib/sla.ts` = pure logic คำนวณเวลา / route = อ่านเขียน DB → แยกกัน

### Pure function
ฟังก์ชันที่ input เดียวกัน → output เดียวกันเสมอ ไม่มี side-effect ไม่แตะ DB/network
- helpwise: `computeDeadlines()` รับ plain data คืน plain value → test ง่าย deterministic

### Dependency injection
ส่ง dependency เข้ามาเป็น argument แทนที่จะให้ฟังก์ชันไปหาเอง
- helpwise: `tickets.ts` รับ `db` (tenantPrisma) เป็น argument → test/reuse ง่าย

### Deterministic
ผลลัพธ์คาดเดาได้แน่นอนจาก input → test ได้ด้วย assert ตรงๆ

### Service layer
ชั้นที่รวม business logic ให้ route หลายตัว reuse ได้
- helpwise: `lib/tickets.ts` (createTicketWithNumber ฯลฯ) เรียกได้จากทั้ง agent + portal route

---

## 5. Auth & Identity

### Audience
กลุ่มผู้ใช้ที่ต้องแยก context กัน
- helpwise: **Agent** (พนักงาน, global User) vs **Contact** (ลูกค้า, tenant-scoped)

### Audience guard
ฟังก์ชันที่บังคับว่า endpoint นี้สำหรับ audience ไหน
- helpwise: `requireAgent()` / `requireContact()` — token คนละ type ปนกันไม่ได้

### JWT (JSON Web Token)
token ที่เซ็นด้วย secret — เก็บ identity (เช่น userId) แบบ verify ได้ว่าไม่ถูกแก้
- helpwise: เก็บใน httpOnly cookie, payload มี `type: "agent" | "contact"`

### httpOnly cookie
cookie ที่ JavaScript อ่านไม่ได้ (อ่านได้แค่ server) → กัน XSS ขโมย token

### Own-records scope
กรองให้เห็นเฉพาะ record ของตัวเอง (แคบกว่า tenant อีกชั้น)
- helpwise: portal query กรอง `requesterContactId = contact.id` → ลูกค้าเห็นแค่ ticket ตัวเอง

### Source of truth
แหล่งข้อมูลที่เชื่อถือได้แหล่งเดียว เมื่อมีหลายที่เก็บค่าเดียวกัน
- helpwise: tenantId source of truth = header จาก proxy (ไม่ใช่ tenantId ใน token)

---

## 6. Infrastructure & Ops

### Serverless
รันโค้ดแบบไม่มี server รันค้าง — function เกิดตอนมี request แล้วตาย (Vercel)
- ผล: ไม่มี process รันค้างถือ worker → ใช้ BullMQ ไม่ได้ → เลือก QStash

### Push vs Pull queue
- **Pull** (BullMQ): worker เรา **ดึง** งานจาก queue (ต้องมี process รันค้าง)
- **Push** (QStash): queue **ยิง** งานเข้า HTTP route เรา (fit serverless แต่ต้อง verify signature)

### Worker route
endpoint ที่ queue ยิงงานเข้ามาให้ทำ async
- helpwise: `/api/jobs/send-email` — อยู่นอก middleware → tenantId มาจาก payload (verified)

### Webhook
HTTP callback ที่ service ภายนอกยิงเข้ามาแจ้งเหตุการณ์
- helpwise: Stripe webhook (billing), email inbound webhook → ต้อง verify signature + idempotent

### Cache
เก็บผลที่ query บ่อยไว้ที่เร็วกว่า (Redis) ลด hit DB
- helpwise: cache tenant lookup จาก slug (เกิดทุก request)

### Negative cache
cache "ผลที่ไม่เจอ" ด้วย เพื่อกัน DB ถูก flood ด้วย query มั่ว
- helpwise: slug ไม่เจอ cache sentinel `__NOT_FOUND__` 30 วิ

### Feature flag / Feature gate
สวิตช์เปิด/ปิดฟีเจอร์ตาม plan หรือ tenant โดยไม่ hardcode
- helpwise: `hasFeature(tenantId, 'sla_policies')` — ห้าม `if (plan === 'PRO')` ตรงๆ

### Kill-switch
flag ที่ปิดฟีเจอร์/พฤติกรรมได้ทันทีโดยไม่ต้อง redeploy
- helpwise: `RLS_ENABLED` — เปิด/ปิด RLS ได้ทันที

### Environment (dev / staging / prod)
สภาพแวดล้อมที่โค้ดรัน
- **dev** = เครื่องเราตอนเขียนโค้ด (`localhost`) · **staging** = ทดสอบเหมือน prod · **prod (production)** = ตัวจริง ผู้ใช้จริงเข้า (`gethelpwise.xyz`)
- helpwise: เช็ค `NODE_ENV === "production"` เพื่อแยกพฤติกรรม (fail-closed, HSTS, cookie secure เฉพาะ prod)

### Wildcard DNS / SSL
DNS record + SSL cert ตัวเดียว (`*.gethelpwise.xyz`) ครอบ **ทุก** subdomain ล่วงหน้า
- helpwise: tenant ใหม่ใช้ subdomain + HTTPS ได้ทันที ไม่ต้องตั้ง DNS/cert ทีละราย

### Self-service onboarding / Zero-touch provisioning
ลูกค้าสมัครเองแล้วใช้ได้เลย ไม่ต้องรอ admin ไป config
- helpwise: wildcard DNS/SSL + `proxy.ts` resolve subdomain→tenantId แบบ dynamic → subdomain ใหม่ทำงานเองโดยไม่แตะ infra

### Dummy env (CI)
ค่า env ปลอมที่หน้าตาถูก format ใส่ใน CI เพื่อให้ build/test compile ผ่าน
- helpwise: `lib/{stripe,prisma,redis}.ts` throw ตอน import ถ้าไม่มี env → ใส่ dummy กัน throw
- ⚠️ ไม่ใช่ "กัน key รั่ว" — key จริงอยู่ Vercel env ไม่เข้า repo/CI ตั้งแต่แรก

### Connection pooling (pgbouncer)
share DB connection ระหว่างหลาย request (serverless เกิด-ตายเยอะ)
- helpwise: runtime ใช้ **pooled** (pgbouncer) / migration ใช้ **direct** (pgbouncer ทำ DDL/session-level ไม่ได้)
- เกี่ยวกับ RLS: `set_config(..., true)` ต้องเป็น transaction-local เพราะ pgbouncer คืน connection ทันที

### CI/CD (Continuous Integration/Deployment)
รัน lint/typecheck/test/build อัตโนมัติทุก push → deploy อัตโนมัติ
- helpwise: GitHub Actions (`ci.yml`) → Vercel deploy

### Security headers
HTTP header ที่ browser บังคับใช้เพื่อกัน attack
- **CSP** (กัน XSS) · **HSTS** (บังคับ HTTPS) · **X-Frame-Options: DENY** (กัน clickjacking) · **Referrer-Policy** (กัน URL รั่ว)

---

## 7. Domain Terms (Help Desk)

### SLA (Service Level Agreement)
สัญญาระดับบริการ เช่น "ตอบกลับใน 4 ชม." (first-response) + "ปิดเคสใน Y ชม." (resolution)

### Business hours aware
นับเวลาเฉพาะช่วงทำการ (จ-ศ 9-17) ไม่ใช่ 24/7
- helpwise: `addBusinessMinutes()` กระโดดข้ามช่วงปิด + timezone ต่อ tenant

### Internal note isolation
โน้ตระหว่าง agent (`visibility: INTERNAL`) ห้ามหลุดไปฝั่งลูกค้า — กรอง `visibility=PUBLIC` ที่ backend
- พูด: *"กรองที่ query ไม่ใช่ซ่อนใน UI"*

### Threading (email)
จับคู่ email reply กลับเข้า ticket เดิม ด้วย `Message-ID` / `In-Reply-To` / `References` header

### DPA (Data Processing Agreement)
สัญญาทางกฎหมายเรื่องการประมวลผลข้อมูลกับ sub-processor (เช่น ส่ง data ลูกค้าให้ Anthropic)
- helpwise: comment ยอมรับว่า prod จริงต้องมี DPA + consent ตาม PDPA/GDPR

---

## 8. คำพูดติดปากเวลาคุยกับ Dev / Interviewer

- *"ตรงนี้เรา **scope by tenantId** ทุก query"*
- *"อันนี้ต้อง **idempotent** เพราะ retry ได้"*
- *"เลือก **fail-closed** เพราะ cost ของการปล่อยผ่านสูง"*
- *"นี่เป็น **defense-in-depth** — ด่านนึงพังยังมีอีกด่าน"*
- *"แยกเป็น **pure function** เพื่อให้ **testable**"*
- *"กันด้วยการ **ตัด capability** ดีกว่า **ขอความร่วมมือ**"* (no-tools vs prompt guardrail)
- *"**source of truth** คือ X ไม่ใช่ Y"*
- *"เรา **fail loud** ดีกว่า **fail silent**"* (throw error แทนปล่อยเงียบ)
- *"นี่คือ **trade-off** ระหว่าง availability กับ safety"*
- *"ผมกัน **class ของบั๊ก** ไม่ใช่แค่ตัวเดียว"* (fix bug class, ไม่ใช่ symptom เดียว)
- *"RLS **existing** ไม่เท่ากับ RLS **enforcing**"* (BYPASSRLS gotcha)
- *"อันนี้ **fail-safe** — พลาดไปทางปลอดภัย"*
- *"provision tenant ใหม่ได้แบบ **zero-touch**"*

---

## 9. ประโยคปิดจ๊อบสำหรับคำถามยาก (Interview)

**"AI สร้างเยอะแค่ไหน?"**
> "ผมออกแบบ architecture + security decision ทุกอย่างเอง AI เร่งการเขียน แต่ judgment เป็นของผม — ชี้ไฟล์ไหนก็ได้ เดี๋ยวอธิบายว่าทำงานยังไงและทำไมออกแบบแบบนั้น"

**"ช่องโหว่ที่ใหญ่สุดตอนนี้?"**
> "application-enforced isolation ไม่ใช่ hard guarantee — เลี่ยง tenantPrisma ไปใช้ base prisma ก็ leak ได้ ตอนนี้ด่านคือ code review จะปิดช่องด้วย eslint rule + activate RLS"

**"scale ถึง 10,000 tenant ไหวไหม?"**
> "scale ตาม DB + index บน tenantId คอขวดคือ Redis lookup (cache แล้ว) + pgbouncer pooling. โตจริงจะ activate RLS เป็น hard guarantee + พิจารณา shard ตาม tenant"

---

*ครบ 8 หัวข้อแล้ว — ใช้คู่กับ `helpwise-interview-stories.md` (STAR stories)*
