# Phase 37 · Slice 2 — Demo persona UI (frontend)

> Contract file สำหรับ `frontend` agent. Slice 1 (`backend`) เป็นเจ้าของ
> `src/lib/demo.ts` · `src/lib/demo-personas.ts` · `src/app/api/auth/demo/login/route.ts` ·
> `prisma/seed-demo.ts` · `src/app/api/__tests__/demo-login.test.ts` — **slice 2 ห้ามแตะไฟล์เหล่านี้**

## เป้าหมาย

Phase 35 มี real-time presence/collision แต่ **visitor ที่เปิด portfolio ไม่มีทางเห็นได้ เพราะ demo มี account เดียว**
Slice 1 เปิดทาง login เป็น agent คนที่ 2 (`persona=secondary`, ไม่ใช้ password) แล้ว
Slice 2 = ทำให้ visitor **รู้ว่าต้องทำอะไร** และ **ทำได้จริงโดยไม่เผลอทับ session ตัวเอง**

Flow ที่ Dev เลือก: `/demo` **ยัง auto-login เป็น primary เหมือนเดิม (0 คลิก)** — ตัวชวนไปอยู่ที่ banner ในหน้า ticket
(ไม่ใช่ chooser 2 ปุ่มบน `/demo` — ข้อกำหนดเดิมข้อนี้ถูกแทนที่ด้วยการตัดสินใจนี้)

## A. Banner — ข้อกำหนด 5 ข้อ (Dev กำหนด, บังคับครบ)

1. **ตำแหน่ง: หน้า ticket detail ของ agent ใกล้จุดที่ `PresenceBar` render** — ไม่ใช่ dashboard
   → `src/app/(agent)/(workspace)/tickets/[id]/page.tsx` บริเวณบรรทัด ~1618-1621 (`<PresenceBar …/>`)
   เหตุผล: ต้องอยู่ตรงที่ฟีเจอร์จะโผล่จริง
2. **ห้ามเป็นลิงก์กดได้ธรรมดา** → เป็น **copy link** + ข้อความบอกให้เปิดใน **incognito / อีกเบราว์เซอร์**
   เหตุผล: กดในเบราว์เซอร์เดิม = cookie ทับ session ตัวเอง → เห็น presence ไม่ได้ (ดู C)
3. **ลิงก์ที่ copy ต้องพาไปถึง ticket ใบเดิม** → `/demo?persona=secondary&next=/tickets/<id>` (ดู B)
   ⚠️ **URL ที่ copy ต้องเป็น absolute** ถึงจะ paste ใส่ incognito ได้ = `window.location.origin` + `/demo?persona=secondary&next=/tickets/<id>`
   **`origin` มาจากเบราว์เซอร์เท่านั้น ห้ามประกอบจาก input/env/searchParams** · กฎ "relative เท่านั้น" ใน § B บังคับกับ **ค่าของ param `next`** ไม่ใช่กับ URL ที่ copy
4. **dismissible + จำว่าปิดแล้ว** (localStorage)
   - key ต้องผูกกับ tenant (เช่น `helpwise:demo-persona-banner-dismissed:<tenantSlug>`) ไม่ใช่ key กลางตัวเดียว
   - localStorage อาจ throw (private mode/quota) → **ต้อง try/catch** ถ้าอ่าน/เขียนไม่ได้ให้ถือว่า "ยังไม่ dismiss" (banner แสดงตามปกติ) ห้ามพังทั้งหน้า
5. **ห้าม render ฝั่ง portal** — agent-only เหมือน `PresenceBar`
   (ตำแหน่งใน `(agent)/(workspace)/` แยกจาก `(portal)/` อยู่แล้ว — ห้ามสร้างทางที่ทำให้หลุดไป portal)

เงื่อนไขเพิ่ม:
- **ไม่ render ถ้า session ปัจจุบันเป็น `secondary`** — คนที่เป็น agent2 อยู่แล้วไม่ต้องถูกชวนให้เปิด agent2 ซ้ำ
- render เฉพาะบน demo tenant (`DEMO_TENANT_SLUGS`) เท่านั้น
- ใช้ palette token เท่านั้น (`bg-surface`/`text-secondary`/`text-primary-ink`/…) **ห้าม hardcode hex** · a11y ครบ (ปุ่ม copy มี `aria-label`, สถานะ "คัดลอกแล้ว" ต้องประกาศให้ screen reader)

### A-bis. ปุ่ม copy ต้องมี fallback (บังคับ — Dev เพิ่ม)

`navigator.clipboard` **ต้องการ secure context และ user ปฏิเสธได้** ถ้า copy fail เงียบ visitor จะไม่ได้อะไรเลย
แล้วสรุปว่าฟีเจอร์พัง — ซึ่งเป็น failure mode เดียวกับที่ทั้งเฟสนี้พยายามปิด

- **แสดง URL เป็น text ที่ select ได้ควบคู่เสมอ** (ทางที่ดีที่สุด) หรืออย่างน้อยแสดงเมื่อ copy fail
- ต้อง**ประกาศสถานะให้ screen reader** ทั้งกรณีสำเร็จและล้มเหลว (live region)
- `navigator.clipboard` อาจ **undefined** (ไม่ใช่แค่ reject) → ต้องเช็คก่อนเรียก ห้าม throw หลุด

## B. `next` param — open-redirect hardening (บังคับ)

validate ที่จุดเดียวกับที่ redirect จริง:
- **relative path เท่านั้น**
- ต้อง match `/tickets/<id>` เท่านั้น
- reject: `//…`, `http://`, `https://`, `\`, อะไรก็ตามที่มี host
- **ไม่ผ่าน → fallback `/dashboard` เงียบ ๆ ไม่ต้อง error**
- validate จาก **string ดิบ** ที่รับมา (ห้าม normalize/decode ก่อนตรวจแล้วค่อยใช้ค่าอื่น — ตรวจค่าไหนต้องใช้ค่านั้น)
- แยก logic นี้เป็น **pure function** (เช่น `resolveDemoNext(raw: string | null): string`) เพื่อ unit-test ได้ตรง ๆ — ดู § D

> **Bug class เดียวกับ Story 1** (`src/lib/landing-links.ts:2` / `src/lib/demo-url.ts`): ปุ่ม "Try live demo" เคย hardcode
> `https://acme.{ROOT_DOMAIN}/demo` ทุก host → visitor บน `globex.…` โดนส่งเข้า workspace ของ acme
> แก้ด้วย `resolveDemoUrl()` ที่ resolve จาก Host จริง (บน subdomain คืน relative `/demo` → กัน open-redirect by construction)
> **บทเรียน: อย่าประกอบ URL ปลายทางจาก input ที่ client คุมได้** — รอบนี้กันไว้ตั้งแต่แรกด้วยกฎด้านบน

## C. `/demo` page — cookie clobber guard

- `src/app/(agent)/demo/page.tsx` เปลี่ยนเป็น **server component ที่อ่าน cookie**
  - **ยังไม่มี session** → พฤติกรรมเดิม: auto-POST `/api/auth/demo/login` แล้ว redirect (client child)
  - **มี session อยู่แล้ว** → **render หน้ายืนยัน** แทน auto-POST (บอกว่ากำลังจะสลับเป็นใคร)
- forward `persona` + `next` จาก searchParams ลงไปที่ POST body / ปลายทาง redirect
- ⛔ **ห้ามแตะ route auth เด็ดขาด** — auth path ต้องมี branch เท่าเดิม เพื่อให้ขอบเขต security review แคบตามเดิม
- ⚠️ `page.tsx` วันนี้เป็น `"use client"` ทั้งไฟล์ + POST โดยไม่มี body — ต้องแตกเป็น server page + client child
- ⚠️ **วิธีอ่าน session ฝั่ง server: ใช้ helper ที่มีอยู่แล้วใน `src/lib/auth.ts` เท่านั้น** — ห้ามเขียน verify JWT / อ่าน cookie เอง
  ต้องเป็นแบบ **ไม่ throw เมื่อไม่มี session** (ถ้ามีแต่ตัวที่ throw ให้ห่อ try/catch ที่ page ไม่ใช่ไปแก้ `lib/auth.ts` ซึ่งอยู่นอก scope)
  ถ้า verify ไม่ผ่าน/ไม่มี cookie → ถือว่า "ยังไม่มี session" → auto-POST ตามปกติ (fail-open ไปทางพฤติกรรมเดิม)
- ⚠️ **`DEMO_PASSWORD` ห้ามติด client bundle** — server component ส่งลง client child ได้แค่ `key` + `name`
  (`src/lib/landing-links.ts:2` เคยเขียนว่า demo.ts มี server-only code ซึ่ง stale ไปแล้ว — Phase 37 ทำให้กลับมามีความหมายอีกแบบ: demo.ts มี `DEMO_PASSWORD`. อัปเดต comment บรรทัดนั้นให้ตรงความจริงใหม่ — นี่คือการแก้ที่ถูกขอ ไม่ใช่ drive-by)

## D. Tests

**บังคับ (ไม่มีข้อแก้ตัว — เป็น pure function):**
- `resolveDemoNext()`: valid `/tickets/<id>` ผ่าน · `//evil.com`, `http://evil.com`, `https://evil.com`, `\\evil.com`,
  `/\evil.com`, `/tickets/<id>/../../settings`, `/settings/api-keys`, `""`, `null`, ค่าที่มี `@`/`%2F`/newline
  → fallback `/dashboard` (ชุดเดียวกับ test "param ประหลาด")

**หมายเหตุ (orchestrator ตรวจให้แล้ว 2026-08-03):** repo นี้ **ไม่มี `@testing-library/react` และไม่มีไฟล์ `*.test.tsx` เลย**
→ ให้ไปทางเส้น "ไม่มี infra" ด้านล่างได้เลย เคสต่อไปนี้เป็น manual/optional ไม่ต้องฝืนสร้าง infra ใหม่:
- banner: ไม่ render เมื่อ (`demoPersona !== "primary"` / ไม่ใช่ demo tenant / เคย dismiss แล้ว)
- banner: URL ที่ copy มี ticket id ใบเดิม + เป็น absolute
- banner: `navigator.clipboard` undefined หรือ reject → ยังเห็น URL เป็น text และมีการประกาศสถานะ
- `/demo` ที่มี session อยู่แล้ว → เห็นหน้ายืนยัน ไม่ auto-POST

**ถ้าไม่มี infra:** ห้ามติดตั้ง dependency ใหม่เอง · ห้ามข้ามเงียบ ๆ — ให้ดึง logic ที่ทดสอบได้ (validate `next`, ตัดสินใจ
show/hide banner, ประกอบ URL) ออกมาเป็น pure function แล้ว unit-test ให้ครบ **แล้วรายงานกลับว่าเคสไหนเหลือเป็น manual**

## E. File scope (frontend)

`src/app/(agent)/demo/page.tsx` (+ client child ใหม่) · `src/app/(agent)/(workspace)/tickets/[id]/page.tsx` (จุด mount) ·
component banner ใหม่ (เช่น `src/components/ui/DemoPersonaBanner.tsx`) · `src/lib/landing-links.ts` (comment ข้อ C เท่านั้น) · tests

## F. ✅ RESOLVED — Dev เลือก (B): `demoPersona` มาจาก server

`GET /api/auth/agent/me` คืน field เพิ่ม **`demoPersona: "primary" | "secondary" | null`** (slice 1b)
banner อ่านจาก session ไม่ต้องเทียบ email เอง → **client ไม่ต้องรู้จัก email ของ persona เลย**

เหตุผลของ Dev: (A) ทำให้ client กลายเป็นผู้ตัดสินว่าใครเป็นใคร และวันที่มีคนแก้ email มันจะเงียบ —
การจำแนกตัวตนควรอยู่ฝั่ง server (ประเด็นไม่ใช่ว่า email ลับไหม — มันไม่ลับ)
ส่วนข้อกังวลเรื่องขยาย surface: `/me` เป็น read-only session info คนละชั้นกับ mint path ของ demo-login

กฎของ (B): derive จาก `DEMO_PERSONAS` ตัวเดียวกับ slice 1 (ห้ามมี list ที่สอง) · tenant ไม่ใช่ demo → `null`
(ไม่ throw ไม่ 403) · ห้าม return email/password · **additive field เท่านั้น response shape เดิมห้ามเปลี่ยน**

> ✅ **slice 1b เสร็จแล้ว** — commit `230af13` บน branch เดียวกัน (`feature/phase-37-demo-personas`)
> `json.data.demoPersona` ใช้ได้ทันที ไม่ต้องรอ merge อะไรทั้งนั้น
> `"primary"` → แสดง banner · `"secondary"` → ห้ามแสดง · `null` (ไม่ใช่ demo tenant/persona) → ห้ามแสดง
> type อยู่ที่ `MeResponse["data"].demoPersona` ใน `src/types/ticket.ts` แล้ว

### (เก็บไว้เป็นบันทึก) ทางเลือกที่ไม่ได้เลือก

Banner ต้องรู้ว่า **session ปัจจุบันเป็น primary หรือ secondary** แต่ ticket detail page เป็น client component ทั้งไฟล์
→ วิธีเดียวที่ทำฝั่ง client ได้คือเทียบ **email** ของ session กับ persona list = ต้องมี email ของ persona ใน client bundle
ซึ่งชนกับกฎ "ส่งแค่ key + name"

- **(A)** ยอมให้ persona **email** (ไม่ใช่ password) อยู่ใน client bundle — email demo โชว์อยู่แล้วใน user menu ของ demo เอง (`(workspace)/layout.tsx:476`) จึงไม่ใช่ข้อมูลลับ · ไม่ต้องแตะ backend
- **(B)** เพิ่ม `demoPersona: "primary" | "secondary" | null` ใน `/api/auth/agent/me` แล้ว banner อ่านจาก session — client bundle สะอาด แต่**ขยาย scope กลับไปที่ backend (slice 1b)**

---

## G. บทเรียนที่ต้องยกเข้า handoff ตอนปิดเฟส (Dev สั่งจด)

1. **Trailing-newline bypass ของ `$` ใน JS regex** — `$` ยัง match ก่อน newline ตัวสุดท้ายได้
   (`/^\/tickets\/\w+$/.test("/tickets/abc\n")` = **true**) → ค่าที่มี newline หลุดไปเป็นปลายทาง redirect ได้
   วิธีปิด: ใช้ `(?![\s\S])` แทน `$` (ดู `src/lib/demo-persona-ui.ts` → `TICKET_PATH_PATTERN`)
   **ไม่ได้อยู่ใน spec — `frontend` agent จับได้เอง**. ใช้กับทุก validator ที่ตรวจ path/URL จาก input

2. **พิสูจน์ "ห้ามหลุด client bundle" ที่ระดับ artifact ไม่ใช่ระดับ source** — grep หา secret ใน build output จริง:
   ```
   npx next build
   grep -rl "<ค่า secret>"    .next/static/     # ต้องว่าง
   grep -rl "<persona email>" .next/static/     # ต้องว่าง
   ```
   การ grep source ว่า "ไม่มี import" พิสูจน์ได้แค่เจตนา — ตัว bundler เท่านั้นที่บอกความจริง
   ควรเป็นขั้นตอนมาตรฐานทุกครั้งที่มีกฎ server-only/client-safe ในเฟสนั้น

3. **Bug class เดียวกันซ้ำรอบที่ 2:** Story 1 (`resolveDemoUrl`) กับ `next` param ของเฟสนี้ = *"อย่าประกอบ URL
   ปลายทางจาก input ที่ client คุมได้"* — รอบนี้กันไว้ตั้งแต่ออกแบบ (§ B) ไม่ได้มาแก้ทีหลัง
