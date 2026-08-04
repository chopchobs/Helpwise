# Phase 37 — Gate 2 Run Sheet (กอง C + B-7)

> เรียงใหม่จาก `.claude/specs/phase-37-manual-checklist.md` ให้เดินได้ต่อเนื่องรอบเดียว
> ขอบเขต = **ขั้นต่ำที่ปิดเฟสได้** ตาม `.claude/project-plan.md` § ⚠️ ค้าง ข้อ 7: **กอง C 8 ข้อ + B-7**
> Gate 1 (prerequisite prod / กอง P) **ผ่านแล้ว 2026-08-03** → ไม่ต้องเดินซ้ำ
> กอง A + B ที่เหลือ = ไม่ block การปิดเฟส (เดินทีหลังได้)

**สถานะก่อนเริ่ม (verified):** `git rev-list --count origin/main..main` = **0** (push แล้ว) · `main` = `893fc4d`

**เวลาโดยประมาณ:** ~35–45 นาที (Leg 0 ~5 · Leg 1 ~10 · Leg 2 ~25)

---

## Leg 0 — Pre-flight (5 นาที, ทำก่อนเปิดหน้าต่างทดสอบ)

- [ ] **0-1** ยืนยันว่า Vercel deploy ที่ live = commit `893fc4d` (หรือใหม่กว่า) และ build เขียวครบ
      รวม step ใหม่ **`scan:bundle`** — ถ้า step นี้แดง **หยุดทันที** (แปลว่ามี server-only secret หลุด client bundle)
- [ ] **0-2** เปิด `https://acme.gethelpwise.xyz/` แล้วดู Console — ต้องไม่มี error แดงตั้งต้น
      (จดไว้ถ้ามี เพื่อไม่ไปสับสนกับ error ของ presence ใน C-5)
- [ ] **0-3** เตรียมหน้าต่าง 3 บาน วางไว้ล่วงหน้า
      | ชื่อ | คืออะไร | ใช้กับ |
      | --- | --- | --- |
      | **W1** | Chrome โปรไฟล์ปกติ | กอง C ฝั่ง Demo Agent |
      | **W2** | Chrome incognito | กอง C ฝั่ง Alex Rivera |
      | **W3** | **Safari** (แยกจาก Chrome เพื่อไม่กวน cookie ของ W1/W2) | **B-7** |
- [ ] **0-4** W1 + W2: เปิด DevTools → Network → ติ๊ก **Preserve log** + filter `demo/login`
      (Network เป็นหลักฐานของ B-7 และ C-4 — ห้ามลืม)
      ⛔ **ห้ามปิด DevTools ตลอดการเดิน** — `Preserve log` เก็บได้เฉพาะสิ่งที่เกิด **ขณะ DevTools เปิดอยู่**
      **ไม่ย้อนเก็บของที่พลาดไปแล้ว** (บทเรียนรอบจริง: หลักฐานของ C-1 กับ C-4 หายเพราะปิด DevTools
      ระหว่างทาง → ต้องเดินซ้ำ)

- [ ] **0-5** เตรียม **local dev** ไว้สำหรับ **C-8c**: `npm run dev` → เปิด `http://acme.localhost:3000`
      · เปิด terminal ของ dev server ค้างไว้ (ต้องอ่าน magic link จาก console)

> ⛔ **ห้าม seed อะไรทั้งสิ้นในขั้นตอนนี้** — เครื่อง dev **ไม่ได้แยกจาก prod**:
> `.env` ชี้ Supabase pooler `aws-1-ap-southeast-1` (ref `postgres.vygcqpktvjtynbboloex`)
> และ Upstash `trusty-bulldog-71443` · **ไม่มี local DB แยกเลย**
> → `npx tsx prisma/seed-demo.ts` จากเครื่อง = **ยิงเข้า prod โดยตรง** = สิ่งที่ `project-plan.md` ข้อ 6
> ห้ามเด็ดขาด (`ticketCounter` hard-set → ถอยหลัง → สร้าง ticket ไม่ได้ทั้ง tenant)
> **local dev ในไฟล์นี้ = แค่ web server ที่อ่านข้อมูล prod เท่านั้น ไม่ใช่สภาพแวดล้อมทดสอบแยก**

> ℹ️ Leg 1 (B-7) กับ Leg 2 (กอง C) **ไม่ผูกกัน** — สลับลำดับได้ถ้าติดขัด แต่ค่า default คือ B-7 ก่อน

---

## Leg 1 — B-7 (P0 blocker): agent จริงเปิด `/demo` ต้องเห็นหน้ายืนยันเสมอ

**ทำไมต้องมาก่อน:** ถ้า fail = session ของ agent จริงถูก demo ทับ = **blocker ระดับ High**
ส่งกลับ `backend`/`frontend` ทันที ไม่ต้องเสียเวลาเดินกอง C

### Subject = `owner@acme.test` (ตัดสินแล้ว — Dev จำ password ได้)

login ที่ `https://acme.gethelpwise.xyz/login` · เป็นแค่การ **login ไม่ใช่การแตะ/แก้** account
(ไม่ขัดข้อ "อย่าเพิ่งแตะ" ของ open item) · `demoPersona = null` + `role = OWNER` (ไม่อยู่ใน persona allowlist)

> 🔁 **ของจริง: ต้องใช้ "ทาง A′" ที่ไม่มีในตัวเลือกเดิม** (2026-08-04)
> ทาง A ตกเพราะ **จำ password ไม่ได้ + repo ไม่มี password-reset route** → ทางที่ใช้จริงคือ
> **สร้าง bcrypt hash เอง แล้ว `update` `passwordHash` ของ `owner@acme.test` ผ่าน Supabase**
> = **prod write ที่ไม่มีใครวางแผนไว้** (run sheet เดิมมีแต่ A/B/C)
> **ทำไมยังดีกว่าทาง B:** ไม่เพิ่มแถวใหม่ (baseline Gate 1 ไม่เสีย) **และปิด standing risk ไปในตัว** —
> บัญชี OWNER บน tenant ที่ public โดยสมบูรณ์ซึ่ง **ไม่มีใครรู้ password** อันตรายกว่าบัญชีที่ Dev คุม password อยู่
> → open item `owner@acme.test` เปลี่ยนสถานะแล้ว (ดู `project-plan.md` ข้อ 7)
> **บทเรียนสำหรับ run sheet ครั้งหน้า:** ถ้า subject ของ smoke เป็นบัญชีที่ "เคยสร้างมือ"
> ให้ถามตั้งแต่ pre-flight ว่า **credential ยังใช้ได้จริงไหม** อย่าเพิ่งเชื่อว่า "จำได้"

> ✅ **ทำไมทางนี้ตรงเจตนา P0 ที่สุด (ไม่ใช่แค่ทางที่สะดวก):**
> บน **tenant จริง** `/demo` โดน demo-slug guard → **404** (นั่นคือเคส B-10 ต่างหาก)
> แปลว่า **เส้นเดียวที่ session จริงมีโอกาสถูก demo ทับได้จริง = บน demo tenant เท่านั้น**
> → `owner@acme.test` (agent จริงที่ไม่ใช่ persona บน acme) คือ subject ที่ตรงกับ threat ของ B-7 พอดี

### เดิน

- [ ] **B7-1** W3 (Safari): login `owner@acme.test` ที่ `https://acme.gethelpwise.xyz/login` → เข้าถึง `/dashboard` ได้
- [ ] **B7-2** W3: เปิด Web Inspector → Storage → Cookies → **จดค่า `hw_agent_session` ปัจจุบัน**
      ⛔ **ห้ามจด 12 ตัวแรก** — ค่าเป็น **JWT** ทุกใบขึ้นต้น `eyJhbGciOiJIUzI1Ni…` เหมือนกันหมด
      → เทียบ prefix = **false pass เสมอ** · ให้เทียบ **ค่าเต็ม** (paste ลง text editor) หรืออย่างน้อย **12 ตัวท้าย**
      : `______________________`
- [ ] **B7-3** W3: เปิด Network tab ค้างไว้ → พิมพ์ `https://acme.gethelpwise.xyz/demo`
- [ ] **B7-4 ✅ เกณฑ์ผ่าน (ต้องครบทั้ง 3 ข้อ)**
      1. เห็น **หน้ายืนยัน** — ข้อความจริงคือ **"สลับเป็น Demo Agent?"** (ชื่อ persona ปลายทาง
         ไม่ใช่ "สลับเป็น บัญชี demo อีกคน?" ตามที่ checklist เดิมเขียน) พร้อมชื่อ/อีเมลของ session จริงที่ใช้อยู่
      2. Network **ไม่มี** `POST /api/auth/demo/login` เลย
      3. cookie `hw_agent_session` **ค่าเดิมไม่เปลี่ยน** (เทียบกับ B7-2)
- [ ] **B7-5** กดลิงก์ **"ใช้บัญชีเดิมต่อ"** → ยังเป็น subject คนเดิม ไม่มี POST (ยืนยันว่าหน้ายืนยันไม่ใช่ทางเดียวไปสู่การถูกทับ)
- [ ] **B7-6** cleanup: logout W3 (ไม่มี prod write ให้ revert — subject เป็นบัญชีที่มีอยู่แล้ว)

**FAIL (ข้อใดข้อหนึ่ง) → หยุดทั้ง Gate 2:** auto-login ทับทันที · มี POST · cookie เปลี่ยนค่า · session จริงหลุด/ถูก logout
→ blocker **High** ตามตาราง verdict ของ checklist → escalate + ส่งกลับ `backend`/`frontend`

---

## Leg 2 — กอง C: presence 2 คนพร้อมกัน (acceptance จริงของทั้งเฟส)

> ลำดับนี้เท่ากับ C-1…C-8 เดิม (มันเรียงถูกอยู่แล้ว) เพิ่มแค่ **C-0 reset** และจุดเก็บหลักฐาน
> ทั้ง 8 ข้อคือ blocker — fail ข้อใดข้อหนึ่ง = เฟสไม่บรรลุ requirement

### C-0 — reset ก่อนเริ่ม (กันผลตกค้างจากเทสต์รอบก่อน)
- [ ] W1: Application → **Local Storage** → ลบ key `helpwise:demo-persona-banner-dismissed:acme` (ถ้ามี)
- [ ] W1: Application → **Cookies** → clear ของ `acme.gethelpwise.xyz` ทั้งหมด
- [ ] W2: ปิด incognito เดิมทิ้ง แล้วเปิดหน้าต่าง incognito **ใหม่** (ให้ session สะอาดจริง)

### เดิน (W1 = Chrome ปกติ · W2 = incognito)

- [ ] **C-1** W1 → `https://acme.gethelpwise.xyz/demo`
      **ผ่านเมื่อ:** เข้าเป็น **Demo Agent** ที่ `/dashboard` · Network มี `POST /api/auth/demo/login` = **200 ครั้งเดียว**
- [ ] **C-2** W1 → `/tickets` → เปิด ticket ใบใดก็ได้ = **T-acme**
      จดไว้: ticket # `______` · id ใน URL `______________`
      **ผ่านเมื่อ:** เห็น banner "อยากเห็น real-time presence ไหม?" ใต้แถบ presence
      *(ถ้าไม่เห็น banner → กลับไปทำ C-0 ข้อแรก แล้ว reload)*
- [ ] **C-3** W1 → กด **"คัดลอกลิงก์"** → เห็น **"คัดลอกลิงก์แล้ว"**
      **ตรวจก่อนไปต่อ:** URL ที่ copy ต้องเป็น `https://acme.gethelpwise.xyz/demo?persona=secondary&next=/tickets/<id ของ T-acme>`
      (ถ้า id ไม่ตรงกับที่จดใน C-2 = FAIL ตั้งแต่ตรงนี้ ไม่ต้องไป C-4)
- [ ] **C-4** W2 → paste ลิงก์ → Enter
      **ผ่านเมื่อ:** spinner สั้น ๆ → ลงเอยที่ **`/tickets/<T-acme>` ใบเดียวกับ W1** (เทียบเลข ticket + หัวข้อ)
      · nav มุมบน = **Alex Rivera** · Network `POST` = 200 ครั้งเดียว
      **FAIL เมื่อ:** ไป `/dashboard` · เข้าเป็น Demo Agent · 404 · หน้า "เข้าสู่ demo ไม่สำเร็จ"
      *(ถ้าได้ 503/"เข้าสู่ demo ไม่สำเร็จ" — Gate 1 ผ่านแล้วจึงไม่น่าใช่ prerequisite แต่ให้รัน SQL ของ Gate 1 ซ้ำก่อนโทษโค้ด)*
- [**FAIL** — รอบที่ 1, 2026-08-04 · ดู § ผลการเดิน ด้านล่าง · **จะเดินซ้ำหลังตั้ง env + redeploy**]
      **C-5** ภายใน ~5 วินาที: W1 เห็น **Alex Rivera** ในแถบ presence **และ** W2 เห็น **Demo Agent**
      **FAIL เมื่อ:** ฝั่งใดฝั่งหนึ่งไม่เห็น → เปิด Console ทั้ง 2 ฝั่งหา error ของ realtime channel แล้วแนบมาด้วย
      *(บริบท: presence เพิ่งจะ live บน prod ตั้งแต่ 2026-07-23 หลัง RLS policy ถูก apply — ข้อนี้กลืน backlog "smoke presence Phase 35" ไปด้วย)*
- [ ] **C-6** W2 พิมพ์ในช่องตอบกลับ (ยังไม่ส่ง) → W1 เห็นสถานะ **กำลังพิมพ์** ของ Alex ในไม่กี่วินาที
      → หยุดพิมพ์ ~5 วิ → สถานะหายไป **FAIL เมื่อ:** ไม่ขึ้นเลย · ขึ้นแล้วค้างถาวร
- [ ] **C-7** ให้ W1 + W2 อยู่ในโหมดพิมพ์ตอบ ticket เดียวกันพร้อมกัน → เห็น **collision banner** อย่างน้อยฝั่งหนึ่ง
      **FAIL เมื่อ:** ไม่เตือนเลยทั้งสองฝั่ง
      ℹ️ **ของจริงดีกว่าที่ checklist สมมติ:** C-6 กับ C-7 **ไม่ใช่ UI คนละตัว** — เป็น **แถบเดียวกัน**
      ที่ขึ้นเตือน *"ระวังตอบซ้ำ"* ตั้งแต่มีคนพิมพ์คนเดียว (ไม่ต้องรอให้ชนกันจริง) → เดิน C-6 แล้วจะเห็น C-7 ต่อเนื่องกัน
- [ ] **C-8a** W2 ส่งข้อความ **PUBLIC** → W1 เห็นข้อความใหม่ (reload ได้ถ้าไม่ real-time)
      ℹ️ **ขอบเขตของ Phase 35 (ไม่ใช่บั๊ก):** realtime ครอบเฉพาะ **presence + typing/collision** เท่านั้น
      **รายการข้อความไม่ sync แบบ realtime — ต้อง reload** ตามที่ checklist อนุญาตไว้แล้ว
- [ ] **C-8b** W1 เพิ่ม **internal note** ที่ ticket ใบเดิม
### C-8c — internal-note isolation บน **ข้อมูล prod จริง** (ยกระดับเป็น prod smoke แล้ว)

> **กลไก:** ใช้ local dev เป็นแค่ *ตัวออกลิงก์* เพราะ `NODE_ENV=development` → `email.ts:175` log magic link
> ออก console (บน prod ไม่ log) · ลิงก์ประกอบจาก `NEXT_PUBLIC_ROOT_DOMAIN` = `gethelpwise.xyz`
> (`request-link/route.ts:141-142`) → **ชี้ portal prod** · token hash ลง **Redis ตัวเดียวกับที่ prod verify**
> · `EMAIL_PROVIDER` comment ไว้ (`.env:87`) → console stub ไม่ส่งอีเมลจริง
> · ใช้อีเมล contact **ที่มีอยู่แล้ว** → `upsert` เข้าทาง `update: {}` **ไม่สร้าง Contact ใหม่** baseline Gate 1 ไม่เสีย
> **ระดับ claim ที่เขียนได้จริง:** *"ไม่มี prod write ที่เพิ่มแถว/เปลี่ยนสถานะข้อมูล"* (ไม่ใช่ "ไม่มี prod write เลย")
> — `Contact.updatedAt` ถูก bump 1 ครั้ง (`schema.prisma:289` เป็น `@updatedAt`) · token ถูก consume ใน Redis
> · portal session cookie ถูก set — ทั้งหมด ephemeral

- [ ] **C-8c-0 · จดอีเมล contact เจ้าของ T-acme** (จาก ticket ใน W1: ช่อง requester)
      `______________________` — **ยิงให้ถูกตั้งแต่ครั้งแรก อย่าลองมั่ว** (ดูกับดัก rate limit ด้านล่าง)
- [ ] **C-8c-1 · Checkpoint 1 — DB ชุดเดียวกันไหม**
      หลัง C-8b เขียน internal note บน prod แล้ว → query จาก local (`npx prisma studio` หรือ script อ่านอย่างเดียว)
      หา `TicketMessage` ของ T-acme
      **ผ่านเมื่อ:** เห็นทั้งข้อความ PUBLIC จาก C-8a และ internal note จาก C-8b → **local ↔ prod = DB เดียวกัน ยืนยันแล้ว**
      **ไม่เห็น:** = คนละ DB → หยุดเส้นนี้ กลับไปใช้ known gap (ดู "ถ้าล้ม" ด้านล่าง)
- [ ] **C-8c-2 · ขอ magic link จาก local**
      `http://acme.localhost:3000/portal/login` → ใส่อีเมลจาก C-8c-0 → submit **ครั้งเดียว**
      → อ่าน terminal ของ dev server หา `[email:magic-link] → link: https://acme.gethelpwise.xyz/portal/verify#token=…`
- [ ] **C-8c-3 · Checkpoint 2 — Redis ชุดเดียวกันไหม**
      เปิดลิงก์นั้นในเบราว์เซอร์ (จะไปโผล่ **`acme.gethelpwise.xyz/portal/verify`**)
      **ผ่านเมื่อ:** verify สำเร็จ เข้า portal ได้ → **token ที่ local เขียน ถูก prod อ่านเจอ = Redis เดียวกัน ยืนยันแล้ว**
      *(ลิงก์อายุ 15 นาที + ใช้ได้ครั้งเดียว — เปิดทันที อย่าเปิดซ้ำ)*
- [ ] **C-8c-4 · ตัดสิน**
      ใน portal เปิด ticket ใบเดิม (T-acme) → เห็นข้อความ **PUBLIC จาก C-8a**
      → **ต้องไม่เห็น internal note จาก C-8b**
      **FAIL = Critical ตาม `CLAUDE.md`** → หยุดทุกอย่าง escalate ทันที

> 🪤 **กับดักที่ต้องรู้ก่อนกด: rate limit ใช้ Redis ร่วมกับ prod**
> `request-link/route.ts:84-91` — limit **3 ครั้ง / 15 นาที** ต่อ (`tenantId` + `email` ตัวพิมพ์เล็ก)
> เกิน limit → คืน `{ sent: true }` **เงียบ ๆ โดยไม่เรียก `sendMagicLink` เลย** = **ไม่มีลิงก์ใน console**
> (ชั้นที่ 1 ตาม IP อีก 5 ครั้ง/นาที — `route.ts:51-57` ชั้นนี้คืน 429 จริง เห็นได้ใน Network)
>
> ⚠️ **failure mode นี้หน้าตาเหมือน "config ไม่ตรง / วิธีนี้ใช้ไม่ได้" เป๊ะ ๆ**
> → **ถ้า console ไม่มีลิงก์ ให้สงสัย rate limit ก่อนเสมอ อย่าเพิ่งสรุปว่า Redis คนละชุดหรือ C-8c พัง**
> ทางแก้: **รอ 15 นาทีแล้วยิงใหม่** หรือใช้ **contact อีกคนใน acme** (ถ้า ticket ใบนั้นมีเจ้าของคนอื่น
> — key ผูกกับ email จึงเป็นคนละ counter) · **ห้ามยิงรัวเพื่อ "ลองดู"** เพราะเผา budget 3 ครั้งใน 15 นาทีทิ้ง
> หมายเหตุ: ถ้าโดน rate limit จะ return **ก่อน** `contact.upsert` (`route.ts:89-91` มาก่อน `:111`)
> → ไม่มีผลข้างเคียงกับข้อมูล แค่เสียเวลารอ

> **ถ้าล้มที่ Checkpoint 1 หรือ 2 (คนละ DB / คนละ Redis) — fallback**
> เปลี่ยน host ในลิงก์เป็น `http://acme.localhost:3000/portal/verify#token=…` แล้วเดิน C-8c-4 ต่อ
> → ยัง**ตัดสิน internal-note isolation ได้**เหมือนเดิม เพียงลด claim เหลือ "ไม่ผ่าน prod HTTP path"
> แล้วบันทึกเป็น known gap พร้อมเหตุผล
>
> ⛔ **ทางที่ถูกตัดถาวร — อย่าเสนอซ้ำ:** *"แก้อีเมล contact ชั่วคราวเป็น inbox จริงแล้วขอ magic link บน prod"*
> (1) `email.ts:58-71` provider default `console` + `NODE_ENV=production` → `sendEmail()` **throw** แต่
> `route.ts:145-150` catch แล้วยังคืน `{ sent: true }` → **ล้มเงียบสนิท ไม่มีสัญญาณ**
> (2) `route.ts:111` `contact.upsert` → อีเมลใหม่ = **สร้าง Contact ใหม่ใน acme** (พัง baseline Gate 1
> "contact นอก seed = 0") และ contact ใหม่ **ไม่ได้เป็นเจ้าของ T-acme** อยู่ดี
> (3) `route.ts:126-131` เก็บแค่ `sha256(token)` — ตัวดิบไม่เคย persist → ไม่มีทางลัด read-only ดึงลิงก์

---

## ✅ ผลสรุป — Gate 2 **ผ่านครบ** (2026-08-04)

| รายการ | ผล |
| --- | --- |
| **B-7 (P0)** | ✅ ผ่านครบ 3 เกณฑ์ (หน้ายืนยัน · ไม่มี POST · cookie ไม่เปลี่ยนค่า) — subject = `owner@acme.test` ผ่าน **ทาง A′** |
| **C-1 … C-8** | ✅ ผ่านทั้งหมด (C-5/C-6/C-7 ผ่านในรอบที่ 2 หลังแก้ 3 ชั้น) |
| **C-8c** | ✅ **prod smoke เต็มตัว** — Checkpoint 1 (DB) + Checkpoint 2 (Redis) ผ่านทั้งคู่ → **ไม่ต้องบันทึกเป็น known gap** |

**หลักฐานเด่นของ C-8c (แข็งกว่าที่ checklist ขอ):**
portal แสดง **"การสนทนา (2 ข้อความ)"** ขณะที่ฝั่ง agent มี **4** → **ตัวนับเป็น 2 ไม่ใช่ "4 แล้วซ่อน 2"**
= พิสูจน์ว่ากรองที่ **ระดับ query** ไม่ใช่ระดับ UI ตรงตามกฎ `CLAUDE.md`
แถม: portal list แสดงเฉพาะ **#1001 / #1004 ของ Jane** ไม่ใช่ 7 ใบของ acme → own-records scope ทำงานจริง

**C-5 รอบที่ 2 — presence ทำงานจริงครั้งแรกบน prod:**
WS `101` + `phx_reply {"status":"ok"}` + `presence_diff` joins ·
UI: W1 เห็น **"AR กำลังดูอยู่"** · W2 เห็น **"DA กำลังดูอยู่"**
→ **backlog "smoke presence Phase 35" ปิดแล้ว**

---

## 📋 ผลการเดิน — รอบที่ 1 (2026-08-04, live = `7eec335`) — เก็บไว้เป็นบันทึกสาเหตุ

**สถานะรอบนั้น: C-5 FAIL — 3 ชั้นซ้อน (แก้แล้วทั้งหมด ผ่านในรอบที่ 2)**

- ✅ **0-1** CI เขียวทั้ง 2 check (Vercel deploy + build-and-test) · live = `7eec335`
- 🔴 **C-5 FAIL** — presence ไม่ทำงานทั้ง 2 ฝั่ง (ticket `#1001`, W2 incognito, prod)

### C-5 — root cause: **3 ชั้นซ้อนกัน** (ไม่ใช่สาเหตุเดียว)

> 🔑 **ลักษณะสำคัญ: แก้ชั้นบนแล้วชั้นถัดไปถึงจะโผล่ — ไม่มีทางเห็นพร้อมกัน**
> แต่ละชั้นบังคลื่นชั้นถัดไปไว้หมด จึงต้อง redeploy + เดินซ้ำทีละชั้น

| ชั้น | สาเหตุ | อาการที่เห็น | ประเภท |
| --- | --- | --- | --- |
| **1** | `NEXT_PUBLIC_SUPABASE_URL` / `ANON_KEY` ไม่ได้ตั้งบน Vercel | **เงียบสนิท** — `/api/realtime/token` ไม่เคยถูกยิง | config (fail-soft กลบ) |
| **2** | `SUPABASE_REALTIME_JWT_PRIVATE_KEY` / `KID` ไม่ได้ตั้งบน Vercel | token route **500** แต่ **client กลืน error** (`fetchRealtimeToken` คืน `null` ไม่ throw) | config (fail-soft กลบ) |
| **3** | **CSP `connect-src 'self'` ไม่รองรับ Supabase** (`next.config.ts:17` เดิม) | Console: `violates … "connect-src 'self'" … blocked` — WebSocket ถูกบล็อกทุกครั้ง | 🔴 **บั๊กโค้ด** |

**ชั้น 3 = defect จริงจาก Phase 35** — Phase 13 ตั้ง CSP ไว้ · Phase 35 เพิ่ม realtime presence
แต่ **ไม่เคยแก้ CSP ให้รองรับ** · และ `connect-src` **ไม่ได้ถูก gate ด้วย `isProd`** (ต่างจาก `'unsafe-eval'`)
→ **presence ถูกบล็อกบน local dev ด้วย = ฟีเจอร์นี้ไม่เคยทำงานได้ที่ไหนเลยตั้งแต่ Phase 35 merge**
ไม่ใช่แค่ตายบน prod

**Fix (commit นี้):** derive origin จาก `NEXT_PUBLIC_SUPABASE_URL` ตอน build → `https:` + `wss:`
ไม่ใช้ wildcard `https://*.supabase.co` · ผลจริงเมื่อมี env:
`connect-src 'self' https://<ref>.supabase.co wss://<ref>.supabase.co`

> ⚠️ **fix นี้มี fail-silent ซ้ำอีกชั้น:** ถ้า env หายตอน build → ได้ `connect-src 'self'` เงียบ ๆ เหมือนเดิม
> → **P1a/P1b ไม่ใช่ optional อีกต่อไป แต่เป็นคู่บังคับของ fix นี้** (เขียนกำกับไว้ในคอมเมนต์ของ `next.config.ts` แล้ว)

### ผลต่อ verdict ของ Gate 2

Gate 2 ไม่ได้เจอแค่ "external resource ไม่ถูก provision" (ชั้น 1-2) แต่เจอ **defect จริงในโค้ด (ชั้น 3)
ที่ทุก gate ก่อนหน้าไม่จับ** — เพราะ acceptance ของ Phase 35 คือ *"เปิด 2 เบราว์เซอร์แล้วดู"*
ซึ่งถูก defer เป็น backlog มา 2 สัปดาห์และ **ไม่เคยมีใครรัน**
→ ยืนยันคุณค่าของ post-merge gate: **unit test + code review + security audit ไม่มีทางจับ CSP-vs-WebSocket ได้เลย**

### หลักฐานเดิม (ชั้น 1 — รอบแรกที่พบ)

**หลักฐานหน้างาน:**
- `PresenceBar` ไม่ render ทั้ง 2 ฝั่ง (`others` = 0)
- Network filter `realtime` = **0 request** → `/api/realtime/token` **ไม่เคยถูกยิงเลย**
- Console warn: `[realtime] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY ไม่ได้ตั้ง — presence ถูกปิด`

**เส้นทางในโค้ด (verify แล้ว):**
`getRealtimeClient()` (`src/lib/supabase-realtime-client.ts:24-38`) อ่าน `NEXT_PUBLIC_SUPABASE_URL` /
`NEXT_PUBLIC_SUPABASE_ANON_KEY` ไม่เจอ → warn ครั้งเดียว → **return `null`**
→ `useTicketPresence.ts:197-199` `start()` เจอ `if (!c) return; // fail-soft` → **ไม่ยิง token · ไม่เปิด channel · ไม่ throw = ตายเงียบ**

**สาเหตุ:** `NEXT_PUBLIC_*` ถูก **inline ตอน build** → ต้องตั้งบน Vercel **แล้ว redeploy** ถึงมีผล
(แก้ env เฉย ๆ ไม่พอ — build เดิมฝังค่า `undefined` ไปแล้ว)

**🔎 สาเหตุเชิงกลไกที่ทำให้ไม่มีใครตั้ง (เจอเพิ่มตอน verify):**
ทั้งสองตัวมีอยู่ใน `.env.example:38-43` แต่ **ไม่มีอยู่ใน `docs/deploy-checklist.md` และ `docs/operations.md` เลย**
— ต่างจาก `NEXT_PUBLIC_ROOT_DOMAIN` / `DEMO_URL` / `SIGNIN_URL` / `API_BASE_URL` ที่อยู่ในเช็คลิสต์ครบ
→ **deploy checklist มีช่องโหว่ตรงกับ resource ที่ตาย** (และอีก 4 ตัวมี `??` fallback ทั้งหมด จึงไม่เคยพังให้เห็น)

### ผลที่ใหญ่กว่า Gate 2

**Phase 35 presence ไม่เคยทำงานบน prod เลยตั้งแต่ต้น** — ไม่ใช่แค่ช่วงก่อน RLS policy apply
`project-plan.md` ข้อ 0 ที่เขียนว่า *"realtime.messages = 2 policy = presence LIVE บน prod แล้ว"* → **ผิด**
policy พร้อมจริง แต่ **client ต่อไม่ได้ตั้งแต่แรก** (แก้ข้อความในข้อ 0 แล้ว 2026-08-04)

**บทเรียน Phase 35 ซ้ำรอบที่ 2 — คนละ resource:**
| รอบ | resource ที่ไม่ได้ provision | อาการ |
| --- | --- | --- |
| 1 (2026-07-23) | migration/RLS policy ไม่ apply | presence ตายเงียบ |
| 2 (2026-08-04) | `NEXT_PUBLIC_SUPABASE_*` ไม่ตั้งบน Vercel | presence ตายเงียบ |

ทั้งคู่ **ผ่าน gate ในโค้ดครบ** แต่ข้อ *"external resource provision แล้ว"* ของ post-merge gate
**ไม่เคยถูกตรวจด้วยหลักฐานจริง** + **fail-soft ทำให้ไม่มีสัญญาณ** → ข้อเสนอแก้เชิงระบบอยู่ใน
`.claude/specs/post-merge-gate-external-resource-proposal.md`

### 🔴 บั๊กที่เจอระหว่างเดิน — **ไม่เกี่ยวกับ Phase 37 แต่ severity สูงกว่า**

`src/app/(portal)/portal/verify/page.tsx:73-74`
```
// TODO Phase (Portal Dashboard): เปลี่ยน "/portal" เป็น "/portal/tickets" เมื่อสร้างแล้ว
setTimeout(() => router.push("/portal"), 1200);
```
- `/portal` **ไม่มี `page.tsx`** และ `git log --all` ยืนยันว่า **ไม่เคยมีในประวัติ repo**
- → **contact ทุกคนที่ login ผ่าน magic link เจอ 404 ทันทีหลัง verify สำเร็จ** (session ถูกสร้างแล้ว
  แค่ปลายทาง redirect ผิด) — เป็นแบบนี้ตั้งแต่ **Phase 3**
- **นี่คือ entry point เดียวของ portal ลูกค้า** = user-facing path ตายมาหลายเดือน
- ✅ **verify เพิ่ม:** `/portal/tickets/page.tsx` **มีอยู่แล้ว** (เงื่อนไขใน TODO บรรลุไปนานแล้ว)
  และ `"/portal"` ถูกอ้างอิง **จุดเดียวในทั้ง repo** → fix = แก้ 1 บรรทัด ไม่มี dependency

**ต่างจากเคส presence ในเชิงสาเหตุ:** presence = *"ไม่มีใครรู้"* · อันนี้ = ***"รู้ตั้งแต่เขียน
เขียน TODO ทิ้งไว้ แล้ว deferral ไม่เคยถูกทบทวน"*** → ข้อเสนอ **P7** ใน
`.claude/specs/post-merge-gate-external-resource-proposal.md`

### สิ่งที่ต้องเดินซ้ำ — หลัง deploy fix ชั้น 3 *(ทำแล้ว ผ่านครบในรอบที่ 2)*
- **C-5, C-6, C-7** (C-6/C-7 ใช้ channel เดียวกัน — รอบที่ 1 ยังตัดสินไม่ได้)
- **pre-check ก่อนเดินซ้ำ (ไล่ทีละชั้น เพื่อไม่ให้ชั้นล่างซ่อนอีก):**
  1. ชั้น 1 — Console **ไม่มี** warn `[realtime] … ไม่ได้ตั้ง` ✅ (ผ่านแล้วหลัง redeploy)
  2. ชั้น 2 — Network เห็น `POST /api/realtime/token` = **200** (ไม่ใช่ 500) ✅ (ผ่านแล้ว)
  3. ชั้น 3 — Console **ไม่มี** `violates … connect-src` และเห็น WebSocket `wss://<ref>.supabase.co`
     ใน Network tab **WS** ที่สถานะ `101 Switching Protocols`
  4. ตรวจ header จริงของ deploy ใหม่:
     `curl -sI https://acme.gethelpwise.xyz/ | grep -i content-security-policy`
     → ต้องเห็น `connect-src 'self' https://<ref>.supabase.co wss://<ref>.supabase.co`
     **ถ้ายังเป็น `connect-src 'self'` เปล่า ๆ = env หายตอน build → อย่าเดินต่อ** (นี่คือ fail-silent
     ของ fix เอง — ดูคำเตือนด้านบน)

---

## บันทึกผล & เกณฑ์ปิดเฟส

| เงื่อนไข | ผล |
| --- | --- |
| **B-7 ผ่าน + C-1…C-8 ผ่าน** (C-8c ผ่านทั้ง 2 checkpoint = prod smoke เต็มใบ) | ✅ **Gate 2 ผ่าน → ปิด Phase 37 ได้** |
| B-7 + C ผ่าน แต่ C-8c ต้องใช้ fallback (คนละ DB/Redis) | ✅ ปิดเฟสได้ + บันทึก known gap "C-8c ไม่ผ่าน prod HTTP path" |
| B-7 FAIL | 🔴 blocker **High** — session จริงถูกกระทบ → หยุด · ส่งกลับ `backend`/`frontend` |
| C-4 / C-5 FAIL | 🔴 เฟสไม่บรรลุ requirement → เก็บ console error + Network มาวิเคราะห์ก่อนโทษ layer ไหน |
| C-8c internal note รั่ว | ⛔ **Critical** — หยุดทุกอย่าง escalate ทันที |
| C-6 / C-7 FAIL แต่ C-5 ผ่าน | 🟡 presence ทำงานแต่ layer typing/collision มีปัญหา → Medium ส่งกลับ `frontend` |

**หลังเดินเสร็จ ให้ทำ 3 อย่าง:**
1. เติมผลลงไฟล์นี้ (`[ ]` → `[x]` / `[FAIL]` + โน้ตสั้น) แล้ว commit
2. อัปเดต `.claude/project-plan.md` § ⚠️ ค้าง **ข้อ 7** — Gate 2 จาก ⏳ เป็น ✅/❌
   (และปิด backlog "smoke presence Phase 35" ในข้อ 0 ถ้า C-5 ผ่าน)
3. บันทึกผล **Checkpoint 1/2 ของ C-8c** ลง handoff/plan — ถ้าผ่านทั้งคู่ให้บันทึกเป็นข้อเท็จจริงถาวรว่า
   **`.env` เครื่อง dev ใช้ Supabase + Upstash ชุดเดียวกับ prod (ไม่มี local DB แยก)** พร้อมผลที่ตามมา:
   ⛔ ห้าม seed/migrate จาก local · rate limit + cache ใช้ counter ร่วมกับ prod
   *(เป็น **ผลพลอยได้จาก config ไม่ใช่เส้นทางที่ออกแบบไว้** — ถ้าวันหนึ่งแยก env จริง C-8c จะกลับไปเป็น local-only)*
   และคงเหตุผล ⛔ "อย่าเสนอแก้อีเมล contact ชั่วคราวซ้ำ" ไว้
4. Open item ที่ยังค้างเหมือนเดิม ไม่ถูกปิดโดย Gate 2: `owner@acme.test` · **A-4** (ต้องใช้ tenant จริง) ·
   R-1 policy (ห้ามเอาของจริงเข้า acme/globex) · FeatureFlag `webhooks`

---

## สิ่งที่ **ไม่ต้อง** ทำในรอบนี้ (กันหลงเดินเกิน)
- กอง **P** — Gate 1 ผ่านแล้ว 2026-08-03 (persona 4/4 · ticketCounter ตรง max)
- กอง **A** (12 ข้อ) + **B** ที่เหลือ 9 ข้อ — ไม่ block การปิดเฟส เดินรอบหลังได้
  - ⛔ **A-4 ห้ามนับว่าผ่านจากรอบนี้** — `owner@acme.test` อยู่บน **acme ซึ่งเป็น demo tenant**
    สิ่งที่สังเกตได้ตอนเดิน B-7 คือเคส *"banner ไม่โผล่เมื่อ `demoPersona = null`"* ซึ่ง **คนละเคสกับ A-4**
    (A-4 = banner ต้องไม่โผล่บน **tenant จริง**) → A-4 ยังค้าง ต้องเดินด้วย tenant จริงเท่านั้น
- **อย่ารัน `prisma/seed-demo.ts` บน prod** ไม่ว่ากรณีใด (project-plan ข้อ 6 — กับระเบิด `ticketCounter`)
