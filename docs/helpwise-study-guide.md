# Helpwise — Study Guide (สรุป 8 หัวข้อ สำหรับสัมภาษณ์)

> ไล่ตั้งแต่ภาพรวม → deploy · แต่ละหัวข้อมี **แก่น · ไฟล์จริง · "ถ้า interviewer ถาม X ตอบ Y" · ต่างจาก single-tenant**
> ใช้คู่กับ `helpwise-dev-glossary.md` (ศัพท์) + `helpwise-interview-stories.md` (STAR)

---

## หัวข้อ 1 — ภาพรวม

**แก่น:** Multi-tenant B2B help desk SaaS — บริษัทลูกค้าหลายเจ้า (tenant) ใช้ระบบเดียวกัน ข้อมูลแยกขาด. มี 2 หน้า: agent workspace (พนักงาน) + customer portal (ลูกค้า). จุดขายไม่ใช่ ticket แต่คือ **isolation** + **internal-note ไม่หลุด portal**.

**Mental model 3 ชั้น:** subdomain → `proxy.ts` resolve tenant → `tenantPrisma` scope ทุก query → Postgres (shared schema + tenantId).

**Stack ทำไม:** Next.js (เสิร์ฟทุกหน้า + API ที่เดียว) · Prisma (type-safe กัน query หลุด scope) · Redis (cache tenant lookup ทุก request) · QStash (serverless-fit) · Stripe webhook (sync ไม่ query ทุก request) · Haiku (ถูก+เร็วพอ summarize).

**ถ้าถาม "Tenant vs Contact":** *"Tenant = ขอบเขตบริษัท. ภายในมี 2 audience: agent (User global) กับ contact (tenant-scoped) ที่ auth context แยกขาดกัน."*

**ต่าง single-tenant:** `SELECT * FROM tickets` ที่เคยปลอดภัย กลายเป็น data breach — ทุก query ต้อง scope tenantId.

---

## หัวข้อ 2 — Multi-tenancy (หัวใจ)

**ไฟล์:** `src/proxy.ts` (resolve) · `src/lib/tenant.ts` (enforce)

**แก่น 2 คำแยกกัน:**
- **Resolution** = ตัดสิน tenant ไหน → `proxy.ts` แกะ subdomain → lookup (Redis→DB) → **overwrite `x-tenant-id` header** (proxy.ts:261-266)
- **Enforcement** = บังคับ query เคารพ tenant → `tenantPrisma(tenantId)` ใช้ `$extends` inject `tenantId` ทุก operation (tenant.ts:132)

**จุดโชว์ความคิด:**
- ทุก return path ที่ไม่ผูก tenant **ลบ** header ที่ client อาจส่ง (`nextWithoutTenantHeaders` proxy.ts:105) — กัน spoof ทางลับ
- `update/upsert` **strip `tenantId` ออกจาก data** (tenant.ts:229,272) — กันย้าย record ข้าม tenant
- `queryRaw` ผ่าน tenantPrisma → **throw** (tenant.ts:194) — เปลี่ยน silent bypass เป็น fail loud

**RLS honest:** scaffold ไว้ (policy ครบ) แต่ **ไม่ active** เพราะ prod ต่อผ่าน **BYPASSRLS role** (`RLS_ENABLED=false` tenant.ts:50). ด่านจริง = application-layer.

**ถ้าถาม "dev ลืม tenantId จะรั่วไหม":** *"tenantPrisma ทำให้ safe path = default path แต่ไม่ใช่ hard guarantee — เลี่ยงไป base prisma ก็รั่ว. ตอนนี้ไม่มี automated guard (ไม่มี eslint rule, RLS ปิด) ด่านคือ code review. จะปิดช่องด้วย lint rule + activate RLS."*

**ต่าง single-tenant:** ต้องสร้าง 2 ด่าน (resolution + enforcement) + ตัดสินใจ trade-off (RLS cost) ที่ single-tenant ไม่มี.

---

## หัวข้อ 3 — Two audiences

**ไฟล์:** `src/lib/auth.ts` — `requireAgent()` / `requireContact()`

**แก่น:** agent กับ contact login ระบบเดียวกัน ต้องแยกขาด ไม่งั้น privilege escalation ข้าม audience. แยก 3 ชั้น:
- **คนละ cookie** (`hw_agent_session` / `hw_contact_session`, auth.ts:38-39)
- **`type` field ใน JWT** — เช็ค `payload.type !== "agent"` throw (auth.ts:179) · JWT valid ไม่พอ ต้องเช็ค type
- **identity ต่างระดับ:** agent token = `userId` (global, **ไม่มี tenantId**) · contact token = `contactId` + `tenantId` (tenant-scoped)

**ทำไม agent token ไม่มี tenantId:** เพราะ tenant มาจาก **subdomain** ไม่ใช่ token. `requireAgent` เอา `getTenantContext()` (subdomain) + verify `TenantMember` ว่า user เป็นสมาชิก tenant นั้น (auth.ts:186-194). token ใบเดียวใช้ได้ทุก tenant ที่เป็นสมาชิก แต่ membership check กั้นทุกครั้ง. role ผูก `TenantMember` (ADMIN ที่นึง VIEWER ที่นึงได้).

**contact double-check 3 ชั้น:** `payload.tenantId === ctx.tenantId` (auth.ts:270) + tenantPrisma scope โหลด contact + `contact.tenantId === ctx.tenantId` (auth.ts:289).

**ถ้าถาม "contact ของ Acme ยิงใส่ Globex":** *"ไม่ทะลุ — บรรทัด 270 เทียบ tenantId ใน token กับ subdomain เด้งก่อน + มี tenantPrisma scope + contact.tenantId check เป็น backstop อีก 2 ชั้น."*

**ต่าง single-tenant:** มี user ประเภทเดียว auth ตัวเดียว. ที่นี่ 2 audience scope ต่างระดับ (global vs tenant-scoped).

---

## หัวข้อ 4 — Request lifecycle

**ไฟล์ตัวอย่าง:** `src/app/api/portal/tickets/[id]/route.ts`

**เส้นเดียวจบ:**
```
subdomain → proxy resolve tenant (x-tenant-id)
→ requireContact: verify cookie + type + tenant match
→ tenantPrisma(tenantId) + requesterContactId   [scope 2 ชั้น]
→ visibility=PUBLIC                              [internal note isolation]
→ 404 ถ้าไม่ใช่ของตัวเอง (ไม่ reveal)
→ { data, error }
```

**2 scope ไม่ซ้ำซ้อน (กับดัก interview):**
- `tenantId` (tenantPrisma) = กันข้าม**บริษัท**
- `requesterContactId` (route:54) = กันข้าม**คนในบริษัทเดียวกัน**
- ไม่ให้ tenant boundary ขึ้นกับ "contactId บังเอิญ unique" → tenantId เป็น systemic guarantee + defense-in-depth

**internal note isolation:** portal query กรอง `visibility: PUBLIC` (route:74) ที่ backend + ไม่ใช้ `_count.attachments` (route:105) กัน existence leak.

**ถ้าถาม "ทำไม 404 ไม่ใช่ 403":** *"403 บอกเป็นนัยว่า ticket มีจริงแต่ห้ามดู → enumeration. 404 ปิดสนิท."*

**ต่าง single-tenant:** มี id ก็ดึงได้. ที่นี่ต้องผ่าน 4 ด่าน (tenant + audience + own-records + visibility) + คิดเรื่อง info leak แม้ตอน error.

---

## หัวข้อ 5 — Features (5 ตัว)

### 5.1 Tickets — `src/lib/tickets.ts`
**Atomic per-tenant ticketNumber:** counter บน `Tenant.ticketCounter` (ไม่ใช้ auto-increment เพราะเป็น sequence รวมทั้งตาราง — แต่ละ tenant ต้องนับเองเริ่มที่ 1). `increment: 1` ใน transaction จับ **row lock** กัน race ไม่ต้อง retry (tickets.ts:200). `@@unique([tenantId,ticketNumber])` = safety net.
**นัยสำคัญ:** ใน `$transaction` ตัว `tx` เป็น base client **ไม่มี $extends** → ต้องใส่ tenantId เอง (tickets.ts:214).
- *ถ้าถาม auto-increment:* "global sequence ต่อตาราง ทำให้เลขกระโดด/ใช้ร่วมข้าม tenant — ผมต้องการเลขรันของแต่ละ tenant เริ่มที่ 1."

### 5.2 SLA — `src/lib/sla.ts` (pure) + ticket PATCH route (pause/resume)
**Business-hours aware:** `addBusinessMinutes` กระโดดข้ามช่วงปิด + timezone จริงด้วย `Intl` (sla.ts:409). loop cap 366 วัน fallback 24/7.
**Pure function:** ไม่ import Prisma → test edge case ได้ครบ + `computeDeadlines` รับ plain data (deterministic).
**Pause/Resume:** เข้า PENDING set `slaPausedAt` / ออก shift deadline **เฉพาะที่ยัง unmet** (`firstRespondedAt===null`) เพราะ pause คือคืนเวลาให้นาฬิกาที่ยังเดิน.
- *ถ้าถาม pure function:* "แยก logic เวลา/timezone เป็น pure function รับ plain data — test ครบทุก edge ไม่ต้อง mock DB."

### 5.3 AI assist — `src/lib/ai.ts` + summarize route
**4 ชั้น security:** (1) lib ไม่แตะ DB — รับ messages ที่ caller ดึงผ่าน tenantPrisma แล้ว (2) **no-tools** — `messages.create` minimal ไม่ส่ง tools (ชั้นแข็งสุด) (3) system prompt "data ไม่ใช่คำสั่ง" (4) **fail-closed** rate limit (route:79) — Redis ล่ม → deny กัน cost บาน.
- *ถ้าถาม prompt injection:* "ชั้นแข็งสุดคือ no-tools + ไม่แตะ DB — หลอกสำเร็จก็ไม่มี capability. ตัด capability > ขอความร่วมมือผ่าน prompt."

### 5.4 Async queue — `src/lib/queue.ts` + send-email worker
**QStash ไม่ใช่ BullMQ:** Vercel serverless ไม่มี process รันค้างให้ BullMQ poll. QStash = **HTTP push queue** ยิง POST เข้า route เรา. ราคา: ต้อง expose public route + **verify signature เอง**.
**worker นอก middleware** → tenantId มาจาก **payload** (เชื่อได้เพราะ verify signature ผ่าน). **idempotent** ด้วย atomic claim (`updateMany where emailSentAt=null`, worker:131) กัน TOCTOU + rollback ถ้าส่งล้ม.
- *ถ้าถาม ทำไมไม่ BullMQ:* "serverless ไม่มี long-running worker. QStash push งานเป็น HTTP + retry — แลกกับต้อง verify signature เอง."

### 5.5 Stripe webhook — `src/app/api/webhooks/stripe/route.ts`
**ไม่ query Stripe ทุก request** — webhook sync เข้า DB แล้ว query จาก DB. **raw body** (`req.text()` ไม่ใช่ `req.json()`) สำหรับ signature verify. **idempotent claim-first** (`ProcessedStripeEvent.eventId @unique`, P2002=เคยเห็น). แยก status `ok` (skip) vs `error` (reprocess) กัน **stuck-processing**. money = `Int`.
- *ถ้าถาม raw body:* "signature คำนวณจาก raw bytes — parse JSON ก่อน byte เพี้ยน verify ไม่ผ่าน."
- *ถ้าถาม stuck-processing:* "ถ้า skip ทุกอันที่เคยเห็น event ที่ fail จะค้างถาวร — เช่นลูกค้าจ่ายแล้วแต่ DB ยัง plan เก่า."

**Pattern ร่วม 5.3-5.5:** verify signature → idempotent → fail-closed → scope ให้ถูก.

---

## หัวข้อ 6 — Security decisions

**Philosophy เดียวร้อยทุกอย่าง: secure by default — ไม่เชื่อ input ที่ client คุมได้ + allowlist + honest.**

1. **Slug validation** (`lib/slug.ts:3` `/^[a-z0-9-]+$/`) — allowlist กัน path-traversal + host-injection + open-redirect ด้วย regex เดียว. *allowlist fail-safe: ลืมเคสก็แค่ block ของถูก ไม่เปิดช่อง.*
2. **Open-redirect prevention** (`demo-url.ts`) — คืน relative `/demo` ไม่ประกอบ URL จาก **Host header** (client-controlled ปลอมได้). ประกอบ URL จาก slug (DB) + rootDomain (env) เท่านั้น.
3. **RLS BYPASSRLS finding** — honest ว่า RLS ยังไม่ enforce. "RLS existing ≠ RLS enforcing." โชว์ maturity.
4. **AI no-tools** — ตัด capability > ขอความร่วมมือ.

- *ถ้าถาม allowlist vs denylist:* "allowlist ลืมเคสก็ block ของถูก. denylist ต้องครบ 100% ซึ่งเป็นไปไม่ได้กับ encoding/unicode."
- *ถ้าถาม Host header:* "client-controlled input ปลอมได้ — เอามาประกอบ redirect = open-redirect. ใช้ relative path หรือค่าจาก DB/env."

**ต่าง single-tenant:** ช่องโหว่พวกนี้ (host injection, tenant spoofing) เกิดเพราะ subdomain = tenant identifier — single-tenant ไม่มี attack surface นี้.

---

## หัวข้อ 7 — Deploy / DevOps

**Pipeline:** push → GitHub Actions CI (lint→typecheck→test→build→audit) → Vercel deploy · Supabase Postgres + `prisma migrate deploy`.

**Supabase:** ให้ pooled (pgbouncer, runtime serverless) + direct (migration — pgbouncer ทำ DDL ไม่ได้). เชื่อมกับ RLS ที่ต้องใช้ transaction-local GUC เพราะ pgbouncer.
**migrate dev vs deploy:** dev สร้าง migration / deploy แค่ apply (prod ต้อง deterministic).
**Wildcard DNS + SSL** (`*.gethelpwise.xyz`) — tenant ใหม่ใช้ subdomain + HTTPS ทันที ไม่ต้องแตะ DNS/cert = **self-service / zero-touch onboarding**. คู่กับ proxy.ts ที่ resolve subdomain→tenantId dynamic.
**CI dummy env** (`ci.yml:9-16`) — lib throw ตอน import ถ้าไม่มี env → ใส่ค่าปลอมให้ compile ผ่าน (ไม่ใช่กัน key รั่ว — key จริงอยู่ Vercel env).
**Security headers** (`next.config.ts`) — CSP, HSTS (prod only), X-Frame-Options DENY, Referrer-Policy.

- *ถ้าถาม wildcard:* "provision tenant ใหม่แบบ zero-touch — subdomain + HTTPS ทันทีโดยไม่แตะ DNS/cert. คู่กับ proxy resolve dynamic."
- *ถ้าถาม dummy env:* "lib throw ตอน import ถ้าไม่มี env — dummy ให้ CI compile/test ผ่าน. secret จริงอยู่ Vercel ไม่เข้า repo."

**ต่าง single-tenant:** wildcard DNS/SSL รองรับ subdomain ไม่จำกัดแบบ self-service + ต้องคิด pgbouncer pooling.

---

## หัวข้อ 8 — Resume + Interview

**Resume:** เพิ่ม helpwise เป็น project แรก (multi-tenant, dual-audience, concurrency, QStash, AI safety, Stripe) · summary four platforms · skills เพิ่ม multi-tenancy/Redis/QStash/RLS/Claude API. → ไฟล์ `Nattapon_Sopontanapat_Resume.docx`

**3 คำถามยากที่ต้องซ้อม:**
- **"AI สร้างเยอะไหม?"** → "ผมออกแบบ architecture + security ทุกอย่างเอง AI เร่งการเขียน judgment เป็นของผม — ชี้ไฟล์ไหนก็ได้เดี๋ยวอธิบาย." (พิสูจน์ด้วยการเปิดโค้ดจริง — นี่คือเหตุผลที่เรียน 8 หัวข้อ)
- **"ช่องโหว่ใหญ่สุด?"** → "application-enforced ไม่ใช่ hard guarantee — เลี่ยง tenantPrisma ก็ leak. ด่านคือ code review จะปิดด้วย lint rule + RLS."
- **"scale 10,000 tenant?"** → "scale ตาม DB + index tenantId. คอขวด Redis lookup (cache) + pgbouncer. โตจริง activate RLS + shard ตาม tenant."

**Growth story:** single-tenant B2B (B2B Wholesale) → multi-tenant (helpwise) = ตั้งใจพัฒนา skill.

---

## เช็กลิสต์ก่อนสัมภาษณ์

- [ ] เปิดไฟล์ไหนก็ได้ที่ interviewer ชี้ แล้วอธิบายได้ว่าทำงานยังไง + ทำไมออกแบบแบบนั้น
- [ ] ท่อง proxy → tenantPrisma → auth guard pipeline ได้
- [ ] อธิบาย RLS BYPASSRLS honest ได้ (จุดแข็ง ไม่ใช่จุดอ่อน)
- [ ] ตอบ "ต่างจาก single-tenant ยังไง" ได้ทุกหัวข้อ
- [ ] จำ pattern verify signature → idempotent → fail-closed → scope
- [ ] ซ้อมคำถาม "AI สร้างเยอะไหม" จนพูดลื่น

*ครบ 8 หัวข้อ — ดูคู่กับ glossary + interview-stories*
