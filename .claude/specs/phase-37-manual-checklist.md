# Phase 37 — Manual Test Checklist (demo personas)

> เขียนโดย `qa-testing` เป็นส่วนหนึ่งของ verdict Phase 37
> ครอบเฉพาะสิ่งที่ **อัตโนมัติไม่ได้** ในโปรเจกต์นี้ (repo ไม่มี `@testing-library/react` / Playwright
> และห้ามติดตั้ง dependency ใหม่ในเฟสนี้) — logic ล้วน ๆ ถูกครอบด้วย vitest แล้ว 1005 tests
>
> **สิ่งที่ automated ครอบแล้ว (ไม่ต้องเดินซ้ำ) — รวม 182 tests:** `demo-persona-ui` 94
> (`resolveDemoNext` 46 เคสรวม property-based, `resolveDemoEntryMode` ตารางเต็ม 12 ช่อง),
> demo-login route 35 (cross-tenant / role / persona ผิดรูป / ไม่รับ tenantId จาก client),
> `/api/auth/agent/me` demoPersona 14, server component `/demo` 16, source-of-truth invariants 23
>
> **สิ่งที่ checklist นี้ครอบ:** พฤติกรรมเบราว์เซอร์จริง (localStorage / clipboard / cookie / Network tab /
> real-time presence ข้ามเบราว์เซอร์) + prerequisite บน prod

**รวม 34 ข้อ · 4 กอง**

| กอง | หัวข้อ | จำนวน | ต้องผ่านก่อน |
| --- | --- | --- | --- |
| **P** | Prerequisite บน prod (read-only check) | 4 | ก่อนเดินกอง A/B/C |
| **A** | Banner / clipboard / localStorage / a11y | 12 | ก่อนปิดเฟส |
| **B** | Entry mode ของ `/demo` | 10 | ก่อนปิดเฟส |
| **C** | Flow หลัก: presence 2 คนพร้อมกัน (สำคัญสุด) | 8 | **ก่อนปิดเฟส (blocker)** |

**สภาพแวดล้อมที่ใช้เดิน:** prod `https://acme.gethelpwise.xyz` + `https://globex.gethelpwise.xyz`
เบราว์เซอร์หลัก = Chrome (Network tab), เบราว์เซอร์รอง = Chrome incognito, และ Safari (สำหรับ A-9)
บันทึกผลด้วยการเติม `[ ]` → `[x]` / `[FAIL]` พร้อมโน้ตสั้น ๆ

---

## กอง P — Prerequisite บน prod (ต้องทำก่อน ห้ามข้าม)

Phase นี้ไม่มี migration แต่มี **external dependency**: persona `secondary` จะ login ได้ก็ต่อเมื่อมี
`User` + `TenantMember(role=AGENT, isActive=true)` ของ `alex@acme.helpwise.com` และ
`dana@globex.helpwise.com` อยู่จริงบน prod DB — ถ้าไม่มี ปุ่ม/ลิงก์ทั้งเฟสจะได้ **503 เงียบ ๆ**
(หน้า "เข้าสู่ demo ไม่สำเร็จ") โดยไม่มี error ที่ชี้สาเหตุ

- [ ] **P-1** รัน read-only query นี้บน prod (Supabase SQL editor หรือ `psql "$DIRECT_URL"`)

  ```sql
  -- read-only: ตรวจ persona secondary ทั้ง 2 คน พร้อม membership + role
  SELECT
    u.email,
    u."isActive"          AS user_active,
    t.slug                AS tenant_slug,
    tm.role,
    tm."isActive"         AS member_active
  FROM "User" u
  LEFT JOIN "TenantMember" tm ON tm."userId" = u.id
  LEFT JOIN "Tenant" t        ON t.id = tm."tenantId"
  WHERE u.email IN ('alex@acme.helpwise.com', 'dana@globex.helpwise.com')
  ORDER BY u.email;
  ```

  **ผ่านเมื่อ** ได้ 2 แถว (อย่างน้อย) ที่เป็น:
  | email | user_active | tenant_slug | role | member_active |
  | --- | --- | --- | --- | --- |
  | `alex@acme.helpwise.com` | `t` | `acme` | `AGENT` | `t` |
  | `dana@globex.helpwise.com` | `t` | `globex` | `AGENT` | `t` |

  **FAIL เมื่อ:** ได้ 0 แถว · `tenant_slug` ไม่ตรงกับ email · `role` ไม่ใช่ `AGENT`
  (route จะ 403) · `user_active`/`member_active` เป็น `f` (route จะ 503)

- [ ] **P-2** ตรวจว่า persona `primary` ยังอยู่ (กันกรณี seed เก่าถูกลบ)

  ```sql
  SELECT u.email, t.slug, tm.role, tm."isActive"
  FROM "User" u
  JOIN "TenantMember" tm ON tm."userId" = u.id
  JOIN "Tenant" t        ON t.id = tm."tenantId"
  WHERE u.email IN ('demo@acme.helpwise.com', 'demo@globex.helpwise.com');
  ```
  **ผ่านเมื่อ** ได้ 2 แถว role = `AGENT`, `isActive = t`

- [ ] **P-3** ถ้า P-1 **ไม่ผ่าน** → อ่านคำเตือนด้านล่างให้จบก่อนตัดสินใจ re-seed

  > ⚠️ **กับระเบิดของ `npx tsx prisma/seed-demo.ts` บน prod**
  >
  > `prisma/seed-demo.ts:868-873` **hard-set** `Tenant.ticketCounter = maxTicketNumber`
  > (ค่าคงที่จาก seed: **acme = 1007**, **globex = 1006**) — ไม่ใช่ `GREATEST(counter, max)`
  >
  > ถ้า prod มี ticket ที่ `ticketNumber` **เกิน** 1007 (acme) / 1006 (globex) — ซึ่งเป็นไปได้สูง
  > เพราะเคยมี dev/smoke ticket สะสมใน acme — counter จะ **ถอยหลัง** แล้ว ticket ใบถัดไปที่ agent
  > สร้างจะชน unique constraint `(tenantId, ticketNumber)` → **สร้าง ticket ไม่ได้บน prod**
  >
  > ตรวจก่อนเสมอ (read-only):
  > ```sql
  > SELECT t.slug, t."ticketCounter", MAX(tk."ticketNumber") AS max_ticket
  > FROM "Tenant" t
  > LEFT JOIN "Ticket" tk ON tk."tenantId" = t.id
  > WHERE t.slug IN ('acme','globex')
  > GROUP BY t.slug, t."ticketCounter";
  > ```
  > - `max_ticket > 1007` (acme) หรือ `> 1006` (globex) → **ห้ามรัน seed ตรง ๆ**
  > - ทางเลือกที่ปลอดภัยกว่า: ให้ `database` agent เขียน one-off script ที่ upsert **เฉพาะ**
  >   `User` + `TenantMember` ของ persona secondary 2 คน (ไม่แตะ ticket/counter)
  > - ถ้าจำเป็นต้อง seed จริง ๆ: จด `ticketCounter` + `max_ticket` เดิมไว้ แล้ว restore ค่า counter
  >   กลับเป็น `MAX(ticketNumber)` ที่แท้จริงหลัง seed เสร็จ **ทันที** แล้วทดสอบสร้าง ticket ใหม่ 1 ใบ

- [ ] **P-4** หลังแก้ P-1/P-3 แล้ว รัน P-1 ซ้ำจนได้ผลผ่าน แล้วสร้าง ticket ทดสอบ 1 ใบใน acme
      (`/tickets/new`) เพื่อยืนยันว่า `ticketCounter` ไม่ชน — **FAIL เมื่อ** ได้ error ตอน submit

---

## กอง A — Banner / clipboard / localStorage / a11y (12 ข้อ)

### เตรียม
เปิด Chrome (โปรไฟล์ปกติ) → `https://acme.gethelpwise.xyz/demo` → รอ auto-login → เข้า `/tickets`
→ เปิด ticket ใบใดก็ได้ (จดเลข/URL ไว้ เรียกว่า **T-acme**)

- [ ] **A-1 — banner โผล่บน acme (primary)**
      ที่หน้า **T-acme** ต้องเห็นกล่องพื้น `bg-stone` ใต้แถบ presence หัวข้อ
      **"อยากเห็น real-time presence ไหม?"** พร้อม `<code>` ที่แสดง URL เต็ม
      `https://acme.gethelpwise.xyz/demo?persona=secondary&next=/tickets/<id ของ T-acme>`
      **FAIL เมื่อ:** ไม่เห็น banner · `<id>` ไม่ตรงกับ ticket ที่เปิดอยู่ · URL ขึ้น host อื่น/`http://`

- [ ] **A-2 — banner โผล่บน globex ด้วย**
      ทำซ้ำ A-1 ที่ `https://globex.gethelpwise.xyz/demo` → เปิด ticket (**T-globex**)
      URL ใน banner ต้องเป็น `https://globex.gethelpwise.xyz/...` (ไม่ใช่ acme)
      **FAIL เมื่อ:** host ใน URL เป็นของอีก tenant

- [ ] **A-3 — banner ไม่โผล่เมื่อเป็น secondary**
      ใน incognito เปิด URL ที่ copy จาก A-1 → login เป็น Alex → ที่หน้า ticket **ต้องไม่มี banner**
      **FAIL เมื่อ:** ยังเห็นกล่องชวนเปิด agent คนที่ 2 (จะชวนวน)

- [ ] **A-4 — banner ไม่โผล่บน tenant จริง**
      login เป็น agent ของ tenant จริง (ไม่ใช่ acme/globex) → เปิด ticket ใดก็ได้ → **ต้องไม่มี banner**
      **FAIL เมื่อ:** banner โผล่บน tenant ลูกค้าจริง (ถือเป็น bug ระดับ High — demo UI รั่วสู่ลูกค้า)

- [ ] **A-5 — copy ทำงานจริง**
      กด **"คัดลอกลิงก์"** → ต้องเห็นข้อความ **"คัดลอกลิงก์แล้ว"** ใต้ปุ่ม → paste ในช่อง address bar
      แล้วได้ URL ตรงกับที่แสดงใน `<code>` เป๊ะ
      **FAIL เมื่อ:** clipboard ว่าง · ได้ค่าอื่น · ไม่มีข้อความยืนยัน

- [ ] **A-6 — clipboard ถูกปฏิเสธ → ยัง degrade ได้**
      Chrome → ไอคอนแม่กุญแจข้าง URL → Site settings → **Clipboard = Block** → reload หน้า ticket
      → กดปุ่มคัดลอก
      ต้องเห็น **"คัดลอกอัตโนมัติไม่ได้ กรุณาเลือกลิงก์ด้านบนแล้วคัดลอกเอง"** และ **คลิกที่ `<code>` 1 ครั้ง
      ต้อง select ทั้ง URL** (`select-all`) → Cmd+C ได้ URL ครบ
      **FAIL เมื่อ:** หน้า error/ค้าง · ไม่มีข้อความบอก · คลิกแล้ว select ได้ไม่ครบ URL
      (อย่าลืมตั้ง Clipboard กลับเป็น Ask หลังทดสอบ)

- [ ] **A-7 — clipboard API ไม่มีเลย (non-secure context)**
      รัน `npm run dev` แล้วเข้าจาก **IP ของเครื่องในวง LAN** (เช่น `http://192.168.x.x:3000` — ไม่ใช่
      `localhost` เพราะ localhost ถือเป็น secure context) ด้วย tenant host header/subdomain ที่ใช้ dev
      → `navigator.clipboard` = undefined → กดปุ่มต้องได้ข้อความ fallback เดียวกับ A-6 ไม่มี JS error
      ใน console **FAIL เมื่อ:** เห็น `TypeError` ใน console หรือหน้าเพี้ยน
      *(ถ้า setup LAN ไม่สะดวก ใช้ DevTools Console: `Object.defineProperty(navigator,'clipboard',{value:undefined})`
      ก่อนกดปุ่ม — ได้ผลเทียบเท่า)*

- [ ] **A-8 — dismiss แล้ว persist ข้าม reload**
      ที่ **T-acme** กด **X (ปิดคำแนะนำนี้)** → banner หายทันที → กด reload (F5) → **ยังต้องไม่มี banner**
      → เปิด ticket **ใบอื่น** ของ acme → **ยังต้องไม่มี banner** (dismiss เป็นระดับ tenant)
      ตรวจ DevTools → Application → Local Storage → ต้องมี key
      `helpwise:demo-persona-banner-dismissed:acme` = `1`
      **FAIL เมื่อ:** banner กลับมาหลัง reload · key ผิดชื่อ · ไม่มี key

- [ ] **A-9 — dismiss แยกตาม tenant**
      หลัง A-8 (ปิดที่ acme แล้ว) → ไป `https://globex.gethelpwise.xyz/demo` → เปิด ticket
      → **banner ต้องยังโผล่** (เพราะ key คนละตัว)
      **FAIL เมื่อ:** banner ที่ globex หายไปด้วย (แปลว่า key ไม่ผูก tenant)

- [ ] **A-10 — Safari private mode (localStorage ถูกบล็อก)**
      เปิด Safari → Private Window → `https://acme.gethelpwise.xyz/demo` → เปิด ticket
      → banner ต้องแสดงตามปกติ → กด X → banner หาย (แค่ไม่ persist ก็ไม่เป็นไร)
      → reload → banner กลับมาได้ (ยอมรับได้) แต่ **ต้องไม่มี error** และหน้าต้องใช้งานได้ครบ
      **FAIL เมื่อ:** หน้าขาว/หน้า error · console มี `QuotaExceededError`/`SecurityError` ที่ไม่ถูก catch
      · กด X แล้วไม่มีอะไรเกิดขึ้น

- [ ] **A-11 — screen reader ได้ยินผลการคัดลอก**
      macOS: VoiceOver (Cmd+F5) → โฟกัสปุ่ม "คัดลอกลิงก์" (ต้องอ่านว่า
      *"คัดลอกลิงก์สำหรับเปิดเป็น agent คนที่ 2"*) → กด Enter → VoiceOver ต้อง **ประกาศ**
      "คัดลอกลิงก์แล้ว" (live region) และปุ่ม X ต้องอ่านว่า "ปิดคำแนะนำนี้"
      ทำซ้ำในสภาพ clipboard ถูก block (A-6) → ต้องประกาศข้อความ fallback ด้วย
      **FAIL เมื่อ:** ไม่มีการประกาศ · ปุ่มถูกอ่านว่า "button" เฉย ๆ

- [ ] **A-12 — axe บนหน้า ticket ที่มี banner**
      ติดตั้ง axe DevTools extension → หน้า **T-acme** (banner แสดงอยู่) → Scan all of my page
      **ผ่านเมื่อ:** ไม่มี issue ระดับ **Critical/Serious** ที่มาจาก node ภายใน banner
      (ตรวจ contrast ของ `text-primary-ink` บน `bg-surface` และปุ่ม `bg-primary-strong` + text ขาว
      ต้องผ่าน 4.5:1) **FAIL เมื่อ:** มี Critical/Serious ที่ชี้ไปที่ banner
      *(issue เดิมของหน้า ticket ที่ไม่เกี่ยวกับ banner → บันทึกไว้ ไม่ block เฟสนี้)*

---

## กอง B — Entry mode ของ `/demo` (10 ข้อ)

เปิด DevTools → tab **Network** → ติ๊ก **Preserve log** + filter `demo/login` ทุกข้อในกองนี้

- [ ] **B-1 — ไม่มี session → auto-login (พฤติกรรมเดิม)**
      ลบ cookie ทั้งหมดของ `acme.gethelpwise.xyz` (Application → Cookies → clear)
      → เปิด `https://acme.gethelpwise.xyz/demo`
      **ต้องเห็น:** spinner "กำลังเข้าสู่ demo workspace…" → มี **POST `/api/auth/demo/login` = 200**
      1 ครั้ง → ลงเอยที่ `/dashboard` และ nav แสดงชื่อ **Demo Agent**
      **FAIL เมื่อ:** เห็นหน้ายืนยัน · POST มากกว่า 1 ครั้ง · ค้างที่ spinner

- [ ] **B-2 — primary อยู่แล้ว เปิด `/demo` ซ้ำ → redirect เงียบ ไม่มี POST**
      (ต่อจาก B-1) พิมพ์ `https://acme.gethelpwise.xyz/demo` ใหม่
      **ต้องเห็น:** ไปโผล่ `/dashboard` และใน Network **ต้องไม่มี** `POST /api/auth/demo/login` เลย
      และ **ไม่มี flash** ของ spinner (ถ้าตาไม่ทันให้ throttle เป็น Slow 3G แล้วดูซ้ำ)
      **FAIL เมื่อ:** มี POST · เห็นสปินเนอร์แว่บ · เห็นหน้ายืนยัน

- [ ] **B-3 — secondary อยู่แล้ว paste ลิงก์ banner ซ้ำ → ถึง ticket ใบเดิม ไม่มี POST**
      ใน incognito ที่ login เป็น Alex อยู่แล้ว (จาก A-3) → paste URL เดิมจาก banner
      (`/demo?persona=secondary&next=/tickets/<T-acme>`) ที่ address bar → Enter
      **ต้องเห็น:** ไปที่ `/tickets/<T-acme>` **ใบเดิม** และ **ไม่มี POST** ใน Network
      **FAIL เมื่อ:** ไปโผล่ `/dashboard` แทน · มี POST · ถูก logout

- [ ] **B-4 — primary + `?persona=secondary` → หน้ายืนยัน (ไม่ POST อัตโนมัติ)**
      ในเบราว์เซอร์หลัก (เป็น Demo Agent อยู่) → เปิด
      `https://acme.gethelpwise.xyz/demo?persona=secondary&next=/tickets/<T-acme>`
      **ต้องเห็น:** หน้า **"สลับเป็น Alex Rivera?"** + ข้อความว่ากำลังใช้งานในชื่อ *Demo Agent* +
      คำแนะนำให้เปิดใน incognito + ปุ่ม "สลับเป็น Alex Rivera" + ลิงก์ "ใช้บัญชีเดิมต่อ"
      และ Network **ยังไม่มี POST**
      **FAIL เมื่อ:** auto-login ทับทันที (นี่คือ P0 ของ slice นี้) · ชื่อ persona ปลายทางผิด (เช่นขึ้น Dana Wu)

- [ ] **B-5 — ปุ่ม "ใช้บัญชีเดิมต่อ" ไม่ทับ session**
      ที่หน้าจาก B-4 กดลิงก์ **"ใช้บัญชีเดิมต่อ"** → ต้องไปที่ `/tickets/<T-acme>` โดย **ยังเป็น Demo Agent**
      และไม่มี POST **FAIL เมื่อ:** ชื่อใน nav เปลี่ยนเป็น Alex · ไปหน้าอื่น

- [ ] **B-6 — ปุ่ม "สลับเป็น …" ทำงาน (ตั้งใจทับ)**
      กลับไป B-4 อีกครั้ง → กดปุ่ม **"สลับเป็น Alex Rivera"** → เห็น spinner → มี **POST = 200**
      1 ครั้ง → ไปที่ `/tickets/<T-acme>` และ nav แสดงชื่อ **Alex Rivera**
      **FAIL เมื่อ:** ไม่เปลี่ยนชื่อ · ไป `/dashboard` แทนที่จะเป็น ticket ใบเดิม · POST ซ้ำหลายครั้ง
      *(หลังข้อนี้ให้ล้าง cookie แล้ว /demo ใหม่เพื่อกลับเป็น primary ก่อนไปข้อถัดไป)*

- [ ] **B-7 — P0: agent จริงเปิด `/demo` → ต้องเห็นหน้ายืนยันเสมอ**
      ใช้เบราว์เซอร์/โปรไฟล์ที่ login เป็น **agent จริงของ tenant จริง** อยู่ → เปิด
      `https://<tenant-จริง>.gethelpwise.xyz/demo`
      **ต้องเห็น:** หน้ายืนยัน (ข้อความ "สลับเป็น บัญชี demo อีกคน?" + ชื่อ/อีเมลของ session จริง)
      และ **ต้องไม่มี POST** และ **cookie `hw_agent_session` ต้องไม่เปลี่ยนค่า** (ดู Application → Cookies)
      **FAIL เมื่อ:** auto-login ทับ session จริง หรือ session จริงหลุด/ถูก logout
      → **ถือเป็น blocker ระดับ High ทันที**

- [ ] **B-8 — cookie หมดอายุ/เสีย → กลับไป auto**
      เป็น Demo Agent อยู่ → DevTools → Application → Cookies → แก้ค่า `hw_agent_session`
      เป็นขยะ (เช่น `xxx`) → เปิด `https://acme.gethelpwise.xyz/demo`
      **ต้องเห็น:** auto-login ตามปกติ (มี POST 1 ครั้ง = 200) → `/dashboard` เป็น Demo Agent
      **FAIL เมื่อ:** ค้างที่หน้ายืนยัน · ขึ้นหน้า error · redirect วน

- [ ] **B-9 — `next` ที่อันตราย ต้องไม่พาออกนอก origin**
      ทดสอบทั้งกรณี **มี** และ **ไม่มี** session:
      `…/demo?persona=secondary&next=https://example.com` และ `…/demo?next=//example.com`
      **ต้องเห็น:** ลงเอยที่ `/dashboard` ของ tenant เดิมเสมอ ไม่มีการออกนอก origin
      **FAIL เมื่อ:** เบราว์เซอร์เด้งไป example.com

- [ ] **B-10 — `/demo` บน tenant จริง (ไม่มี session) → ไม่มีทางได้ session demo**
      logout ให้หมด → เปิด `https://<tenant-จริง>.gethelpwise.xyz/demo`
      **ต้องเห็น:** POST ตอบ **404** และหน้าแสดง "เข้าสู่ demo ไม่สำเร็จ" + ลิงก์ไปหน้า login
      และ **ไม่มี cookie `hw_agent_session` ถูก set**
      **FAIL เมื่อ:** ได้ session ใด ๆ · เห็นข้อความที่ leak ว่ามี/ไม่มี user ในระบบ

---

## กอง C — Flow หลักของทั้งเฟส: presence 2 คนพร้อมกัน (8 ข้อ — blocker)

> นี่คือเหตุผลที่ทั้งเฟสนี้มีอยู่ ถ้ากองนี้ไม่ผ่าน = เฟสไม่บรรลุ requirement
> ใช้ 2 หน้าต่าง: **W1** = Chrome ปกติ, **W2** = Chrome incognito วางคู่กันบนจอเดียว

- [ ] **C-1** W1: ล้าง cookie ของ `acme.gethelpwise.xyz` → เปิด `https://acme.gethelpwise.xyz/demo`
      → ต้องเข้าเป็น **Demo Agent** ที่ `/dashboard`

- [ ] **C-2** W1: ไป `/tickets` → เปิด ticket ใบใดก็ได้ (**T-acme**) → เห็น banner (ถ้าเคย dismiss
      ให้ลบ key `helpwise:demo-persona-banner-dismissed:acme` ใน Local Storage ก่อน)

- [ ] **C-3** W1: กด **"คัดลอกลิงก์"** → เห็น "คัดลอกลิงก์แล้ว"

- [ ] **C-4** W2 (incognito): paste ลิงก์ → Enter
      **ต้องเห็น:** spinner สั้น ๆ → เข้าสู่ **`/tickets/<T-acme>` ใบเดียวกับ W1** (เทียบเลข ticket
      + หัวข้อให้ตรง) และ nav มุมบนแสดงชื่อ **Alex Rivera** (ไม่ใช่ Demo Agent)
      **FAIL เมื่อ:** ไปโผล่ `/dashboard` · เข้าเป็น Demo Agent · 404 · หน้า error demo

- [ ] **C-5 — presence เห็นกัน 2 ทาง**
      ภายใน ~5 วินาที: W1 ต้องเห็น avatar/ชื่อ **Alex Rivera** ในแถบ presence และ W2 ต้องเห็น
      **Demo Agent** เช่นกัน
      **FAIL เมื่อ:** ฝั่งใดฝั่งหนึ่งไม่เห็นอีกคน (ตรวจ console หา error ของ realtime channel ด้วย)

- [ ] **C-6 — typing indicator**
      W2: พิมพ์ข้อความในช่องตอบกลับ (ยังไม่ส่ง) → W1 ต้องเห็นสถานะ **กำลังพิมพ์** ของ Alex ภายในไม่กี่วินาที
      แล้วหยุดพิมพ์ ~5 วินาที → สถานะต้องหายไป
      **FAIL เมื่อ:** ไม่ขึ้นเลย · ขึ้นแล้วค้างถาวร

- [ ] **C-7 — collision banner**
      ให้ทั้ง W1 และ W2 อยู่ในโหมดพิมพ์ตอบ ticket เดียวกันพร้อมกัน → ต้องเห็น collision banner
      (เตือนว่ามี agent อีกคนกำลังตอบ) อย่างน้อยฝั่งหนึ่ง
      **FAIL เมื่อ:** ไม่มีการเตือนเลยทั้งสองฝั่ง

- [ ] **C-8 — ส่งข้อความจริงแล้วเห็นสองฝั่ง + ไม่มี internal note รั่ว**
      W2 ส่งข้อความ **PUBLIC** → W1 เห็นข้อความใหม่ (reload ได้ถ้าไม่ real-time)
      → W1 เพิ่ม **internal note** → เปิด portal ของ contact เจ้าของ ticket ใบนี้
      (`/portal/tickets/<…>` ด้วย magic link ของ contact) → **ต้องไม่เห็น internal note**
      **FAIL เมื่อ:** internal note โผล่ที่ portal → **Critical ตาม CLAUDE.md** หยุดทันทีแล้วรายงาน

---

## สรุปเกณฑ์ verdict ของ checklist นี้

| ผลลัพธ์ | การตัดสิน |
| --- | --- |
| P ทั้งหมดผ่าน + C ทั้งหมดผ่าน + A/B ไม่มี FAIL | ปิดเฟสได้ |
| B-7 หรือ A-4 FAIL | **blocker (High)** — session จริง/tenant จริงถูกกระทบ ส่งกลับ `backend`/`frontend` |
| C-4/C-5 FAIL แต่ P-1 ไม่ผ่าน | ยังไม่ใช่บั๊กโค้ด — แก้ prerequisite (กอง P) ก่อนแล้วเดินใหม่ |
| C-8 internal note รั่ว | **Critical** — หยุดทุกอย่าง escalate ทันที |
| A-6/A-7/A-10/A-11 FAIL | Medium — degrade path ของ demo UI ไม่ครบ ส่งกลับ `frontend` |
