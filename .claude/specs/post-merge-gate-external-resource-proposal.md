# ข้อเสนอ: ทำให้ post-merge gate จับ "external resource ไม่ถูก provision" ได้จริง

> เขียน 2026-08-04 หลัง **C-5 FAIL** ของ Gate 2 Phase 37 — ยังเป็น **ข้อเสนอ รอ Dev ตัดสิน** ยังไม่ implement
> บริบทเต็ม → `.claude/specs/phase-37-gate2-run-sheet.md` § ผลการเดิน

## ปัญหาที่ต้องแก้ (ไม่ใช่ปัญหาโค้ด)

เกิดซ้ำ **2 รอบใน 1 เดือน กับ feature เดียวกัน คนละ resource**:

| รอบ | resource / defect | สาเหตุ | ตรวจไม่เจอเพราะ |
| --- | --- | --- | --- |
| 1 (2026-07-23) | RLS policy บน `realtime.messages` | migration ล้ม 42501 แล้วถูกถอด | เชื่อ `migrate status` ไม่ได้ query `pg_policies` |
| 2 (2026-08-04) | `NEXT_PUBLIC_SUPABASE_URL` / `ANON_KEY` บน Vercel | ไม่เคยถูกตั้ง + ไม่อยู่ใน deploy checklist | **fail-soft → ไม่มีสัญญาณใด ๆ** |
| 3 (2026-08-04) | `SUPABASE_REALTIME_JWT_PRIVATE_KEY` / `KID` บน Vercel | ไม่เคยถูกตั้ง | token route 500 แต่ **client กลืน error** (`fetchRealtimeToken` คืน `null`) |
| 4 (2026-08-04) | 🔴 **CSP `connect-src` ไม่รองรับ Supabase — บั๊กโค้ด** | Phase 35 เพิ่ม WebSocket แต่ไม่แก้ CSP ของ Phase 13 | ไม่มี test ตัวไหนรู้ว่าเบราว์เซอร์บล็อกอะไร → **ต้องเปิดเบราว์เซอร์จริงเท่านั้น** |

> รอบ 2-4 **ซ้อนกันอยู่ในอาการเดียว** — แก้ชั้นบนแล้วชั้นถัดไปถึงโผล่ ไม่มีทางเห็นพร้อมกัน
> และรอบ 4 พิสูจน์ว่า gate นี้ไม่ได้จับแค่ "resource ไม่ provision" แต่จับ **defect จริงที่ทดสอบด้วยโค้ดไม่ได้**

**แกนของปัญหา 3 ข้อ:**
1. **Fail-soft ที่ถูกต้องเชิงวิศวกรรม กลายเป็นตัวกลบหลักฐาน** — `getRealtimeClient()` return `null`
   แล้ว `start()` return เงียบ ๆ ถูกต้องแล้วสำหรับ *ผู้ใช้* (ticket ยังใช้งานได้) แต่สำหรับ *ผู้ดูแล*
   มันแปลว่า feature ตายโดยไม่มีใครรู้ 1 เดือน
2. **Gate ข้อ "external resource provision แล้ว" เป็น checkbox ของเจตนา ไม่ใช่ของหลักฐาน** —
   ไม่มีใครระบุว่า "resource นี้ ตรวจด้วยคำสั่งอะไร ผลที่ถือว่าผ่านหน้าตายังไง"
3. **`.env.example` ไม่ใช่ deploy checklist** — ตัวแปรใหม่ถูกเพิ่มใน `.env.example` (ตอนพัฒนา)
   แต่ไม่มีอะไรบังคับให้ไปโผล่ใน `docs/deploy-checklist.md` (ตอน deploy) → drift เงียบ

**หลักการที่ควรยึด:** *fail-soft ต่อผู้ใช้ · **fail-loud ต่อผู้ดูแล*** และ
***1 external resource = 1 assertion ที่รันบน prod ได้ และ "ดัง" เมื่อไม่ผ่าน***

---

## ⛔ ก่อนอ่านข้อเสนอ: `NEXT_PUBLIC_*` **verify ที่ระดับ artifact เท่านั้น**

`NEXT_PUBLIC_*` ถูก **inline เข้า client bundle ตอน build** ไม่ได้อ่านตอน runtime
→ **การถามฝั่ง server ว่า "ตั้ง env หรือยัง" ตอบคำถามผิดข้อ** ตัวที่ต้องพิสูจน์คือ *ค่าที่อยู่ใน artifact ที่ deploy จริง*
มีแค่ 2 ทางที่ทำได้: **P1a** (สแกน bundle) และ **P1b** (guard ตอน build ด้วย env ชุดที่ใช้ inline จริง)
— ดู P2 § ข้อจำกัด ว่าทำไม readiness endpoint ใช้กับเรื่องนี้ไม่ได้

## P1a — ต่อยอด `scripts/scan-client-bundle.ts` ให้มีโหมด "ค่าที่ต้องมี" (⭐⭐ แนะนำสูงสุด)

**ทำไมข้อนี้สูงสุด:** ใช้ของที่มีอยู่แล้ว · CI มี step นี้ในไปป์ไลน์อยู่แล้ว · และมันคือ
**บทเรียนข้อ 2 ของ Phase 37 ที่เราเขียนไว้เองเป๊ะ ๆ** — *"พิสูจน์ที่ระดับ artifact ไม่ใช่ระดับ source"*
(`scan-client-bundle.ts:7-10`) รอบนี้แค่ใช้กับทิศกลับด้าน

- วันนี้ script มี `FORBIDDEN: ForbiddenValue[]` = "ค่าที่ต้องไม่พบใน `.next/static`" (`:24-46`)
- เพิ่ม `REQUIRED: RequiredValue[]` = **"ค่าที่ต้องพบ"** — assert ว่า `NEXT_PUBLIC_SUPABASE_URL`
  โผล่ใน bundle จริง (match ด้วย host เช่น `.supabase.co` ไม่ต้องเทียบ key เต็ม)
- ไม่พบ = exit non-zero พร้อม hint ว่า *"ตั้งบน Vercel แล้ว **redeploy** ด้วย — แก้ค่าเฉย ๆ ไม่พอ"*
- โครงเดิมใช้ซ้ำได้ทั้งหมด (`walk()` + อ่านไฟล์ + รายงาน) → งานจริงคือเพิ่ม list + loop ที่สอง

> 🚩 **กับดักที่ต้องออกแบบให้ถูก ไม่งั้นพลาดซ้ำแบบเดิม:**
> **build ของ GitHub Actions ≠ artifact ที่ deploy** — CI build ด้วย env ของ CI ส่วนที่ผู้ใช้เจอ
> build ด้วย env ของ **Vercel Production**. ถ้า assert เฉพาะใน `ci.yml` เราจะได้ CI เขียว
> ทั้งที่ Vercel ยังไม่ตั้ง env = **ตรวจผิดสภาพแวดล้อม ซึ่งคือ shape เดียวกับบั๊กที่กำลังแก้อยู่**
> → ต้องผูกเข้ากับ **build ของ Vercel เอง** (เช่น `"build": "next build && npm run scan:bundle"`
> ใน `package.json`) และให้โหมด REQUIRED บังคับเฉพาะเมื่อ `VERCEL_ENV === "production"`
> (ไม่งั้น CI/preview ที่ไม่มี env จะแดงโดยไม่จำเป็น)

## P1b — Build-time guard: `NEXT_PUBLIC_*` ที่จำเป็นต้องมีตอน build

**ทำไมข้อนี้ก่อน:** มันทำให้ bug *class* นี้ **deploy ไม่ออกอีกเลย** ไม่ต้องพึ่งวินัยคน
และมี precedent ในโปรเจกต์อยู่แล้ว (`npm run scan:bundle` ของ Phase 37 ที่เกิดจากปัญหาแบบเดียวกัน:
"กฎที่ไม่มีอะไรบังคับ = กฎที่จะหลุด")

- `scripts/check-public-env.ts` + `npm run check:env` → รันใน `ci.yml` **และ** ผูกกับ `prebuild`
- source of truth ไฟล์เดียว: แยก `NEXT_PUBLIC_*` เป็น **required** (ไม่มีค่า = feature ตาย)
  กับ **optional** (มี `??` fallback ที่ยอมรับได้)
  - required วันนี้: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_ROOT_DOMAIN`
  - optional วันนี้: `NEXT_PUBLIC_DEMO_URL`, `NEXT_PUBLIC_SIGNIN_URL`, `NEXT_PUBLIC_API_BASE_URL`
    (มี fallback ที่ `landing-links.ts:9-10`, `api-keys/page.tsx:424`)
- สแกน `src/` หา `NEXT_PUBLIC_[A-Z_]+` ทั้งหมด → **ตัวใหม่ที่ไม่ได้ถูกจัดหมวด = fail**
  (บังคับให้คนเพิ่ม env ต้องประกาศเจตนาว่า required หรือ optional)
- บน Vercel Production ที่ตัวแปร required หาย → **build แดง** แทนที่จะ deploy สำเร็จแล้วตายเงียบ

> ⚠️ ข้อจำกัด: guard นี้อยู่ที่ **ต้นทาง** ของ build — ถ้ารันด้วย env ชุดเดียวกับที่ inline จริง
> (คือรันบน Vercel ไม่ใช่แค่ CI) ก็เชื่อได้ · แต่ยังจับ "ตั้งผิดค่า" ไม่ได้ → **P1a แข็งแรงกว่า**
> เพราะดูผลลัพธ์จริงใน artifact. ถ้าทำได้ทั้งคู่ P1a มาก่อน

## P2 — Runtime readiness endpoint: `GET /api/health/readiness` (สำหรับ resource **ฝั่ง server เท่านั้น**)

ตอบ **สถานะจริงของ runtime ที่ deploy อยู่** ไม่ใช่ของ repo:

```jsonc
{ "data": { "email":   { "provider": "console" },   // ← จับ scaffold ที่ยังไม่ wire ได้
            "queue":   { "configured": true },
            "storage": { "bucket": "configured" },
            "redis":   { "configured": true } }, "error": null }
// ⛔ ห้ามมี key "presence" หรือ NEXT_PUBLIC_* ใด ๆ ในนี้ — ดูกล่องข้างล่าง
```

> ⛔ **ห้ามใช้ P2 ยืนยัน `NEXT_PUBLIC_*` เด็ดขาด — มันจะให้ false PASS กับ bug class นี้โดยตรง**
>
> readiness เป็น **server-side route** → อ่าน `process.env` **ตอน runtime**
> แต่ `NEXT_PUBLIC_*` ถูก **inline เข้า client bundle ตอน build**
> → ถ้าตั้ง env ใน dashboard แล้ว **ยังไม่ redeploy** (= สถานะของ prod ณ 2026-08-04 เป๊ะ ๆ)
> readiness จะรายงาน **`configured: true`** ขณะที่ client bundle ยังไม่มีค่า
> = **presence ยังตายอยู่ แต่ gate บอกผ่าน** — แย่กว่าไม่มี gate เพราะสร้างความมั่นใจปลอม
>
> P2 จึงจำกัดขอบเขตไว้ที่ resource ที่ **server อ่านตอน runtime จริง ๆ** เท่านั้น:
> `EMAIL_PROVIDER` · queue/QStash · storage bucket · Redis · provider key ต่าง ๆ
> ส่วน `NEXT_PUBLIC_*` → **P1a / P1b เท่านั้น**

- อ่านเฉพาะ **การมี/ไม่มี + host** ห้ามคืนค่า secret ใด ๆ · ไม่ต้อง auth ก็ได้ถ้าเนื้อหาไม่ระบุความลับ
  (ถ้าไม่สบายใจ → ใส่ agent guard ก็ยังใช้ smoke ได้)
- ค่าที่ได้เอาไป assert ใน smoke ได้ตรง ๆ: `curl -s https://acme.gethelpwise.xyz/api/health/readiness | jq -e '.data.presence.configured == true'`
- จับได้มากกว่า P1: provider key ที่หายเฉพาะ prod, bucket ที่ยังไม่ provision, `EMAIL_PROVIDER` ที่ยัง
  เป็น `console` (ซึ่งวันนี้ **ล้มเงียบ** ที่ `email.ts:58-71` + `request-link/route.ts:145-150`)

## P3 — ทำให้ fail-soft "ดัง" โดยไม่ทำร้าย UX

- `PresenceBar` ใส่ `data-presence-state="disabled|connecting|live"` → smoke ฝั่งเบราว์เซอร์
  assert ได้ว่า **ต่อจริง** ไม่ใช่แค่ "หน้าไม่พัง" (ตรงกับสิ่งที่ Dev ขอ)
- บน demo tenant (`acme`/`globex`) เท่านั้น: แสดง badge จาง ๆ ว่า "presence ปิดอยู่" — visitor-facing
  demo ที่ feature ตายเงียบคือความเสียหายทางธุรกิจโดยตรง (นี่คือเหตุผลที่มี Phase 37)
- คง `console.warn` ไว้ + เพิ่ม log ฝั่ง server ตอน `/api/realtime/token` **ไม่เคยถูกเรียกเลย**
  ก็เป็นสัญญาณอ้อมที่ดู Vercel runtime log เจอ

## P4 — ปิดช่องโหว่ deploy checklist (ทำได้ทันที ต้นทุนต่ำสุด)

- เพิ่ม `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` เข้า `docs/deploy-checklist.md`
  และตาราง env ของ `docs/operations.md` (**วันนี้ไม่มีทั้งสองไฟล์** — คือสาเหตุตรง ๆ ที่ไม่มีใครตั้ง)
- ระบุชัดว่าเป็น **build-time inlined** → *แก้ค่าแล้วต้อง redeploy ถึงจะมีผล*
- P1 จะบังคับข้อนี้อัตโนมัติในอนาคต (ตัวแปรใหม่ที่ไม่ถูกจัดหมวด = build fail)

## P6 — CSP ต้องเดินคู่กับ "external origin ที่ feature ใหม่ใช้" (เพิ่ม 2026-08-04 หลังเจอชั้น 3)

**ที่มา:** Phase 13 ตั้ง CSP · Phase 35 เพิ่ม WebSocket ไป Supabase แต่ไม่แก้ `connect-src`
→ presence **ไม่เคยทำงานได้ทั้ง prod และ local dev** (`connect-src` ไม่ได้ถูก gate ด้วย `isProd`)
ทุก gate ในโค้ดไม่จับ เพราะไม่มี unit test ตัวไหนรู้จัก "เบราว์เซอร์จริงบล็อกอะไร"

- **P6a (ถูกที่สุด, ทำเลย):** unit test ของ `buildCsp()` — assert ว่าเมื่อมี `NEXT_PUBLIC_SUPABASE_URL`
  แล้ว `connect-src` ต้องมีทั้ง `https://` และ `wss://` ของ origin นั้น · จับ regression ทันทีถ้ามีคน
  แก้ CSP ทีหลัง (แต่ **ไม่จับ** กรณี env หายตอน build — นั่นเป็นงานของ P1a)
- **P6b:** เพิ่มบรรทัดใน DoD/PR checklist: *"feature นี้เรียก origin ภายนอกใหม่หรือไม่
  (WebSocket / fetch / img / iframe)? ถ้าใช่ → อัปเดต CSP directive ที่เกี่ยวข้อง"*
- **P6c:** สังเกตให้ครบว่า CSP directive ไหน **ไม่ได้ gate ด้วย `isProd`** — พวกนี้พังบน dev ด้วย
  จึงควรถูกจับตั้งแต่เครื่อง dev ถ้ามีใครเปิดฟีเจอร์นั้นดูจริงสักครั้ง

## P7 — จับ TODO ที่อยู่บน **user-facing path** (เพิ่ม 2026-08-04 หลังเจอ `/portal` 404)

**ที่มา:** `portal/verify/page.tsx:73-74` เขียน `router.push("/portal")` พร้อม TODO ว่า *"เปลี่ยนเป็น
`/portal/tickets` เมื่อสร้างแล้ว"* — `/portal/tickets` ถูกสร้างไปนานแล้ว แต่ **TODO ไม่เคยถูกทบทวน**
→ contact ทุกคนเจอ **404 หลัง login สำเร็จ** ตั้งแต่ Phase 3

**นี่คือ failure mode คนละแบบกับ P1-P6 — และ gate ที่มีอยู่จับไม่ได้เลย:**

| | presence (P1-P6) | `/portal` 404 (P7) |
| --- | --- | --- |
| สาเหตุ | **ไม่มีใครรู้** ว่าพัง | **รู้ตั้งแต่เขียน** แล้ว defer |
| กลไกที่พลาด | ไม่มี assertion บน prod | **deferral ไม่มีวันหมดอายุ ไม่มีใครทบทวน** |
| ยาที่ใช้ได้ | smoke / artifact check | **ทำให้ deferral มีเจ้าของและวันตาย** |

- **P7a (อัตโนมัติ, ถูกที่สุด):** script + CI — grep `TODO`/`FIXME` ใน `src/app/**/page.tsx`
  และ `src/app/**/route.ts` แล้ว **cross-check กับ route ที่มีอยู่จริง**: ถ้า TODO อ้างถึง path
  (เช่น `"/portal"`, `/portal/tickets`) ให้ยืนยันว่า **path ที่โค้ดใช้อยู่จริงมี `page.tsx` รองรับ**
  ไม่งั้น fail — จับเคสนี้ได้ตรง ๆ โดยไม่ต้องพึ่งคนอ่าน TODO
- **P7b (กว้างกว่า, ทำคู่กันได้):** ตรวจว่า **ทุก `router.push()` / `redirect()` ที่เป็น string literal
  ชี้ไป route ที่มีอยู่จริง** — เป็น static check ที่ Next.js ไม่มีให้ (typedRoutes ช่วยได้บางส่วน
  แต่โปรเจกต์นี้ยังไม่ได้เปิด → **ทางเลือกที่ควรพิจารณาคู่กัน: เปิด `typedRoutes` ของ Next 16**
  ซึ่งจะทำให้ `router.push("/portal")` **compile ไม่ผ่าน** ตั้งแต่แรก = แก้ที่รากที่สุด)
- **P7c (นโยบาย):** TODO ที่อยู่บน user-facing path ต้องมี **เจ้าของ + phase ที่จะแก้** และถูกยกมา
  ทบทวนใน handoff ของทุก phase — TODO ที่ไม่มีวันตาย = bug ที่ยังไม่ถูกนับ

## P5 — เปลี่ยนถ้อยคำของ post-merge gate ใน `CLAUDE.md`

จาก checkbox ลอย ๆ *"external resource ที่ feature ต้องใช้ provision แล้ว"* → บังคับให้ **แต่ละ phase
เขียนตารางหลักฐาน** ก่อนปิด phase:

| resource | คำสั่ง/วิธีตรวจบน prod | ผลที่ถือว่าผ่าน |
| --- | --- | --- |
| RLS policy | `select * from pg_policies where tablename='messages'` | ≥ 2 แถว |
| **client env (`NEXT_PUBLIC_*`)** | **สแกน artifact ที่ deploy (P1a)** — ไม่ใช่ถาม server | ค่าโผล่ใน `.next/static` จริง |
| server env / provider | `curl …/api/health/readiness \| jq -e '.data.email.provider != "console"'` | ผ่าน |
| FeatureFlag | เรียก API ของ feature นั้น | 200 ไม่ใช่ 403 |

> กฎประจำตาราง: **ต้องตรวจที่ชั้นเดียวกับที่ค่าถูกใช้จริง** — build-time value ตรวจที่ artifact,
> runtime value ตรวจที่ runtime. ตรวจผิดชั้น = false PASS (ดู P2 § ข้อจำกัด)

พร้อมกฎเสริม: **ถ้า feature ใดออกแบบให้ fail-soft → phase นั้นต้องมี assertion ที่ยืนยัน happy path
บน prod เสมอ** (เพราะ fail-soft = ไม่มี error ให้เห็นโดยธรรมชาติ)

---

## ลำดับที่แนะนำ + เจ้าภาพ

| ลำดับ | ข้อ | เจ้าภาพ | ขนาด | ได้อะไร |
| --- | --- | --- | --- | --- |
| 1 | **P4** docs | `docs-writer` | XS | ปิดช่องที่ทำให้พลาดรอบนี้ทันที |
| 2 | **P1a** โหมด REQUIRED ใน `scan-client-bundle.ts` (+ ผูกกับ build ของ Vercel) | `devops` | S | พิสูจน์ที่ artifact จริง — ทางเดียวที่ verify `NEXT_PUBLIC_*` ได้ |
| 3 | **P5** gate wording (+ กฎ "ตรวจที่ชั้นเดียวกับที่ค่าถูกใช้") | `docs-writer` | XS | เปลี่ยน gate จากเจตนา → หลักฐาน |
| 4 | **P2** readiness endpoint (server-side resource เท่านั้น) | `backend` | S–M | จับ provider/queue/bucket ที่ล้มเงียบ |
| 5 | **P3** observable fail-soft | `frontend` | S | smoke assert ได้ว่า "ต่อจริง" |
| — | **P1b** build guard | `devops` | S | ทับซ้อนกับ P1a เป็นส่วนใหญ่ — ทำก็ต่อเมื่ออยาก fail ตั้งแต่ก่อน build |
| 6 | **P6a** test `buildCsp()` | `qa-testing` | XS | กัน CSP regression |
| 7 | **P7a/P7b** TODO + route ที่ไม่มีอยู่จริง (พิจารณาเปิด `typedRoutes`) | `devops` / `frontend` | S | จับ failure mode "รู้แล้ว defer จนลืม" ที่ P1-P6 จับไม่ได้ |

**ถ้าเลือกได้แค่ 2 ข้อ:** P4 (ทันที) + **P1a** (กันซ้ำถาวร ด้วยของที่มีอยู่แล้ว)
**ทำเป็น phase ของตัวเอง หรือแทรกก่อนปิด Phase 37 ก็ได้** — แต่ **ไม่ควรผูกเป็นเงื่อนไขปิด Phase 37**
เพราะ Gate 2 รอแค่ env + redeploy + เดิน C-5/C-6/C-7 ซ้ำ
