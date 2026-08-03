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
4. **dismissible + จำว่าปิดแล้ว** (localStorage)
5. **ห้าม render ฝั่ง portal** — agent-only เหมือน `PresenceBar`
   (ตำแหน่งใน `(agent)/(workspace)/` แยกจาก `(portal)/` อยู่แล้ว — ห้ามสร้างทางที่ทำให้หลุดไป portal)

เงื่อนไขเพิ่ม:
- **ไม่ render ถ้า session ปัจจุบันเป็น `secondary`** — คนที่เป็น agent2 อยู่แล้วไม่ต้องถูกชวนให้เปิด agent2 ซ้ำ
- render เฉพาะบน demo tenant (`DEMO_TENANT_SLUGS`) เท่านั้น
- ใช้ palette token เท่านั้น (`bg-surface`/`text-secondary`/`text-primary-ink`/…) **ห้าม hardcode hex** · a11y ครบ (ปุ่ม copy มี `aria-label`, สถานะ "คัดลอกแล้ว" ต้องประกาศให้ screen reader)

## B. `next` param — open-redirect hardening (บังคับ)

validate ที่จุดเดียวกับที่ redirect จริง:
- **relative path เท่านั้น**
- ต้อง match `/tickets/<id>` เท่านั้น
- reject: `//…`, `http://`, `https://`, `\`, อะไรก็ตามที่มี host
- **ไม่ผ่าน → fallback `/dashboard` เงียบ ๆ ไม่ต้อง error**

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
- ⚠️ **`DEMO_PASSWORD` ห้ามติด client bundle** — server component ส่งลง client child ได้แค่ `key` + `name`
  (`src/lib/landing-links.ts:2` เคยเขียนว่า demo.ts มี server-only code ซึ่ง stale ไปแล้ว — Phase 37 ทำให้กลับมามีความหมายอีกแบบ: demo.ts มี `DEMO_PASSWORD`. อัปเดต comment บรรทัดนั้นให้ตรงความจริงใหม่ — นี่คือการแก้ที่ถูกขอ ไม่ใช่ drive-by)

## D. Tests

- `next` param: valid `/tickets/<id>` ผ่าน · `//evil.com`, `http://evil.com`, `https://evil.com`, `\\evil.com`,
  `/tickets/<id>/../../settings`, path อื่น, ค่าว่าง → fallback `/dashboard` (รวมชุดเดียวกับ test "param ประหลาด")
- banner: ไม่ render เมื่อ (ไม่ใช่ demo tenant / persona ปัจจุบัน = secondary / เคย dismiss แล้ว)
- banner: ลิงก์ที่ copy มี ticket id ใบเดิม
- `/demo` ที่มี session อยู่แล้ว → เห็นหน้ายืนยัน ไม่ auto-POST

## E. File scope (frontend)

`src/app/(agent)/demo/page.tsx` (+ client child ใหม่) · `src/app/(agent)/(workspace)/tickets/[id]/page.tsx` (จุด mount) ·
component banner ใหม่ (เช่น `src/components/ui/DemoPersonaBanner.tsx`) · `src/lib/landing-links.ts` (comment ข้อ C เท่านั้น) · tests

## F. ⚠️ Open decision (ต้องให้ Dev ตัดสินก่อน frontend เริ่ม)

Banner ต้องรู้ว่า **session ปัจจุบันเป็น primary หรือ secondary** แต่ ticket detail page เป็น client component ทั้งไฟล์
→ วิธีเดียวที่ทำฝั่ง client ได้คือเทียบ **email** ของ session กับ persona list = ต้องมี email ของ persona ใน client bundle
ซึ่งชนกับกฎ "ส่งแค่ key + name"

- **(A)** ยอมให้ persona **email** (ไม่ใช่ password) อยู่ใน client bundle — email demo โชว์อยู่แล้วใน user menu ของ demo เอง (`(workspace)/layout.tsx:476`) จึงไม่ใช่ข้อมูลลับ · ไม่ต้องแตะ backend
- **(B)** เพิ่ม `demoPersona: "primary" | "secondary" | null` ใน `/api/auth/agent/me` แล้ว banner อ่านจาก session — client bundle สะอาด แต่**ขยาย scope กลับไปที่ backend (slice 1b)**
