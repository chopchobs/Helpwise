# Phase 38 — Runbook: ปิด post-merge gate ของ Phase 36 (outbound webhooks) บน prod

> **เป้าหมาย:** พิสูจน์ว่า outbound webhooks **ทำงานจริงบน prod** ผ่าน **เส้นทางเดียวกับที่ลูกค้าจริงเดิน**
> คือ `Tenant.plan` → `x-tenant-plan` (ผ่าน Redis cache ใน proxy) → `hasFeature()` → route
>
> **ขอบเขต: read-only ทั้งหมด** — ⛔ **ไม่มีการเขียน DB แม้แต่คำสั่งเดียว** ไม่มี `INSERT`/`UPDATE`/`DELETE`
> ไม่แตะ `TenantFeature` ไม่แตะ `FeatureFlag` งานนี้คือ **ตรวจสถานะ + smoke** เท่านั้น
>
> **ผู้รัน:** Dev — เอกสารนี้เขียนโดย agent ที่ **อ่านโค้ดอย่างเดียว** ทุกข้อเท็จจริงอ้าง `ไฟล์:บรรทัด` จริง
> (branch `feature/phase-38-gate-hardening`)
>
> ⛔ `.env` ของเครื่อง Dev ชี้ Supabase/Upstash **ชุดเดียวกับ prod** → ห้ามรัน
> `prisma migrate` / `db push` / `seed` / `seed-demo` เพื่อทำงานนี้เด็ดขาด
> SQL ในไฟล์นี้เป็น `SELECT` ล้วน รันบน Supabase SQL editor ได้ปลอดภัย

---

## 0. บันทึกการตัดสินใจ — ทำไม "ทาง A (ไม่แตะ DB)" ไม่ใช่ "ทาง B (ใส่ TenantFeature override)"

> 📌 **อ่านก่อนคิดจะย้อนกลับไปทำ B** — เคยพิจารณาแล้วและ **ถูกปฏิเสธ** ด้วยเหตุผลด้านล่าง

ข้อเสนอเดิม (ทาง B) คือ `INSERT TenantFeature(enabled=true)` ให้ `acme`/`globex` เพื่อบังคับเปิด feature
**Dev ปฏิเสธ** ด้วยเหตุผล (verbatim):

> *"เป้าหมายคือพิสูจน์ว่าฟีเจอร์ทำงานบน prod เส้นทางที่ลูกค้าจริงเดินคือ plan → x-tenant-plan (ผ่าน Redis)
> → hasFeature() ถ้าใส่ TenantFeature override เราจะพิสูจน์ว่า 'override ทำงาน' แล้วปิด gate ทั้งที่เส้นทางจริง
> ยังไม่เคยถูกแตะ = ตรวจคนละชั้นกับที่ค่าถูกใช้จริง ซึ่งเป็นกฎที่ commit `457e40b` เพิ่งเขียนลง CLAUDE.md เมื่อกี้เอง"*
>
> *"ที่คุณบอกว่า 'ไม่ผ่าน Redis cache' เป็นข้อดี — สำหรับงานนี้มันกลับด้าน Redis + plan path
> คือของที่ต้องพิสูจน์ ไม่ใช่ noise ที่ต้องกำจัด"*
>
> *"B แลกมาด้วย deviation `audit.log()` + write ด้วยมือบน prod + override row ที่จะบังคับ acme/globex ตลอดไป
> (วันหลังเปลี่ยน plan แล้วไม่มีผล คนจะงง)"*

**สรุปข้อเสียของ B ที่ทำให้ตกไป:**

| ข้อเสียของ B | รายละเอียด |
| --- | --- |
| ตรวจคนละชั้นกับที่ใช้จริง | override ชนะก่อนทุกอย่าง (`src/lib/features.ts:90–92`) → plan path + Redis cache ไม่เคยถูกทดสอบ |
| deviation กฎ AuditLog | ไม่มี route/script ใดเขียน `TenantFeature` ได้ (ดู § 1.2) → ต้อง `INSERT AuditLog` เอง ขัด `src/lib/audit.ts:5–6` |
| write ด้วยมือบน prod | เพิ่มความเสี่ยงโดยไม่จำเป็นสำหรับงานที่แค่ต้อง "พิสูจน์" |
| override ค้างถาวร | วันหลังเปลี่ยน plan ของ acme/globex แล้ว entitlement ไม่ขยับ — คนมาอ่านทีหลังจะงง |

**ข้อดีของ A ที่ชี้ขาด:** สมมติฐานที่ว่า *"acme/globex เป็น plan `pro` จึงน่าจะเปิดอยู่แล้ว"* เป็นการ **infer
จาก `prisma/seed-demo.ts:589–593, 618–634`** ซึ่งเป็นไฟล์ที่ **ห้ามรันบน prod** →
**ไม่มีใครเคยยืนยันค่า `Tenant.plan` จริงบน prod เลย** ทาง A ตอบคำถามนี้ในตัว (§ 2-2 + § 4)

---

## 1. ข้อเท็จจริงพื้นฐานที่สืบค้นแล้ว (ใช้ตีความผลลัพธ์)

### 1.1 ตรรกะ feature gate (`src/lib/features.ts`)

`hasFeature(tenantId, key, tenantPlan)` (`:64–110`) ตัดสินตามลำดับ:

1. `TenantFeature` override → ถ้ามีแถว **ชนะทุกอย่าง** (`:70–78`, `:90–92`)
2. ไม่มี `FeatureFlag` record → `false` (safe default, `:95–97`)
3. มี `requiredPlan` → เทียบ plan (`:100–106`) ด้วย `isPlanSufficient` (`:36–43`)
   ลำดับ plan: `starter=0 · growth=1 · pro=2 · enterprise=3` (`:25–30`)
4. ไม่มี `requiredPlan` → ใช้ `defaultEnabled` (`:109`)

`tenantPlan` ที่ route ส่งเข้ามาคือ `ctx.plan` ซึ่งมาจาก header `x-tenant-plan` ที่ proxy inject
(`src/lib/tenant.ts:95`, fallback `"starter"` ที่ `:105`) — **นี่คือจุดที่ Redis cache เข้ามาเกี่ยว**
(`src/proxy.ts` lookup tenant + cache) → **เส้นทางที่ต้องพิสูจน์**

`FEATURE_KEYS.WEBHOOKS = "webhooks"` (`src/lib/features.ts:137`)

### 1.2 ไม่มี admin route/script ใดจัดการ `TenantFeature`

ตัวตนของ `TenantFeature` ในรีโปมีแค่ 4 จุด และ **ไม่มีจุดใดเขียนข้อมูล**:

| ที่ | บรรทัด | ทำอะไร |
| --- | --- | --- |
| `prisma/schema.prisma` | 261–272 | นิยาม model + unique `(tenantId, featureKey)` |
| `src/lib/features.ts` | 70–78 | **อ่านอย่างเดียว** (`findUnique`) |
| `prisma/migrations/20260531113517_init/migration.sql` | 88–97, 277, 280, 388 | สร้างตาราง |
| `prisma/migrations/20260617000000_rls_tenant_isolation/migration.sql` | 206–218 | RLS policy |

- API route ทั้งหมด (`find src/app/api -name route.ts` = 58 ไฟล์) ไม่มี route `features`/`admin`/`entitlements`
- `scripts/` มีแค่ `scan-client-bundle.ts`, `stripe-smoke.ts`
- `prisma/seed.ts:160–183` seed แค่ `FeatureFlag` (global) — ไม่แตะ `TenantFeature`

→ ข้อเท็จจริงนี้คือเหตุผลหนึ่งที่ B ต้องใช้ SQL มือ + insert AuditLog เอง (และเป็นเหตุผลที่ B ตกไป)

### 1.3 Guard ของ webhook routes

| route | ไฟล์:บรรทัด | role ที่ต้องมี | feature gate |
| --- | --- | --- | --- |
| `GET /api/webhook-endpoints` | `src/app/api/webhook-endpoints/route.ts:96` | `requireAgent({roles:["OWNER","ADMIN"]})` `:98` | `:102–111` |
| `POST /api/webhook-endpoints` | `:134` | `:136` | `:139–148` |
| `PATCH` / `DELETE /api/webhook-endpoints/[id]` | `src/app/api/webhook-endpoints/[id]/route.ts:98, 234` | OWNER/ADMIN | มี |
| `GET /api/webhook-deliveries` | `src/app/api/webhook-deliveries/route.ts:98` | `:100` | `:103` |

### 1.4 ⚠️ ปุ่ม demo login ใช้ smoke งานนี้ไม่ได้

- demo member ถูก seed เป็น `AGENT` เสมอ (`prisma/seed-demo.ts:674, 678, 698, 702`)
- `/api/auth/demo/login` **บังคับซ้ำ** ว่า `role === "AGENT"` (`src/app/api/auth/demo/login/route.ts:19–21`)
- webhook routes ต้อง `OWNER`/`ADMIN` → demo session จะได้ **`403 FORBIDDEN` เสมอ ไม่เกี่ยวกับ flag**

→ smoke ต้องใช้บัญชี **OWNER จริง**: `owner@acme.test`

### 1.5 แยก 403 สองแบบ (สำคัญที่สุดต่อการอ่านผล)

ทั้งคู่เป็น HTTP `403` — **ต้องดู `error.code` ใน response body เท่านั้น**

| `error.code` | มาจากไหน | แปลว่า |
| --- | --- | --- |
| `FORBIDDEN` | `src/lib/auth.ts:106–111` (`AuthError` statusCode 403) | **role ไม่ถึง OWNER/ADMIN** → smoke ตั้งผิด **ไม่ใช่ผลของ feature** |
| `FEATURE_LOCKED` | `src/app/api/webhook-endpoints/route.ts:104–110` | ผ่าน role แล้ว แต่ **feature ปิด/plan ไม่ถึง** |

ทุก API ของโปรเจกต์ตอบรูปแบบ `{ data, error }` เสมอ → อ่าน `error.code` จาก body ได้ตรง ๆ

---

## 2. Pre-check — read-only SQL ทั้งหมด (⛔ ห้ามข้าม)

รันบน **Supabase SQL editor** ของ prod ทีละ block แล้ว **จดผลไว้**
ทุก query เป็น `SELECT` และ scope ด้วย `slug` เสมอ (ไม่มี tenant id ที่เดามาใส่ — ให้ query ดึงเอง)

### 2-1 · `FeatureFlag('webhooks')` มีจริงไหม + ค่าปัจจุบัน

```sql
SELECT "key", "defaultEnabled", "requiredPlan", "createdAt"
FROM "FeatureFlag"
WHERE "key" = 'webhooks';
```

**คาดหวัง:** 1 แถว · `defaultEnabled = false` · `requiredPlan = 'pro'`
(ตรงกับ `prisma/migrations/20260722010000_add_webhooks_feature_flag/migration.sql:6–17`)

- **0 แถว** → migration `20260722010000` ยังไม่ apply บน prod → **หยุด** นี่คือปัญหา migration ค้าง
  (คนละเรื่องกับ runbook นี้) ต้องแก้ก่อน แล้วจึงกลับมา
- `defaultEnabled = true` → มีคนเปิด global ไว้ → บันทึกไว้ ผลของ smoke จะตีความต่างออกไป

### 2-2 · ⭐ `Tenant.plan` **จริงบน prod** ของ acme/globex (คำถามที่ยังไม่เคยมีใครตอบ)

```sql
SELECT t."slug", t."isActive", p."name" AS plan_name, t."updatedAt"
FROM "Tenant" t
JOIN "Plan" p ON p."id" = t."planId"
WHERE t."slug" IN ('acme', 'globex')
ORDER BY t."slug";
```

**ทำไมสำคัญ:** ที่ผ่านมาเราแค่ *infer* ว่าเป็น `pro` จาก `prisma/seed-demo.ts:589–593, 618–634`
ซึ่งเป็นไฟล์ที่ **ห้ามรันบน prod** → ค่าจริงยังไม่เคยถูกยืนยัน

**การตีความ** (เทียบ `requiredPlan` จาก § 2-1 ผ่านลำดับ plan `src/lib/features.ts:25–30`):

| `plan_name` | คาดว่า smoke § 4-1 จะได้ |
| --- | --- |
| `pro` หรือ `enterprise` | `200` — feature เปิดอยู่แล้วผ่าน plan path |
| `starter` หรือ `growth` | `403 FEATURE_LOCKED` → **หยุดแล้ว escalate** อย่าเพิ่งแก้อะไร (การเปลี่ยน plan = เรื่อง billing) |

### 2-3 · มี `TenantFeature` override ค้างอยู่ไหม (ต้องรู้ก่อนตีความผล)

```sql
SELECT t."slug", tf."featureKey", tf."enabled", tf."createdAt", tf."updatedAt"
FROM "TenantFeature" tf
JOIN "Tenant" t ON t."id" = tf."tenantId"
WHERE tf."featureKey" = 'webhooks'
ORDER BY t."slug";
```

**คาดหวัง: 0 แถว** — ถ้าเป็น 0 แปลว่า smoke ที่ได้ 200 คือการพิสูจน์ **plan path จริง** (เป้าหมายของงานนี้)

⚠️ ถ้ามีแถว → **หยุด** แล้วรายงาน เพราะแปลว่ามีคนใส่ override ไว้ก่อนหน้า →
ผล smoke จะพิสูจน์แค่ "override ทำงาน" ไม่ใช่ plan path (คือปัญหาเดียวกับที่ทาง B ถูกปฏิเสธ)
⛔ **ห้ามลบแถวนั้นเองในงานนี้** — งานนี้ read-only ให้ escalate ก่อน

### 2-4 · ยืนยันว่ามี OWNER/ADMIN ให้ smoke จริง

```sql
SELECT t."slug", tm."role", tm."isActive", u."email", u."isActive" AS user_active
FROM "TenantMember" tm
JOIN "Tenant" t ON t."id" = tm."tenantId"
JOIN "User" u ON u."id" = tm."userId"
WHERE t."slug" IN ('acme', 'globex')
  AND tm."role" IN ('OWNER', 'ADMIN')
ORDER BY t."slug", tm."role";
```

**ต้องเห็น:** `owner@acme.test` เป็น `OWNER` ของ `acme` · `tm."isActive" = true` · `user_active = true`
(login route เช็คทั้ง `User.isActive` ที่ `src/app/api/auth/agent/login/route.ts:120–127`
และ membership + `isActive` ที่ `:129–137`)

- ถ้า `globex` ไม่มี OWNER/ADMIN → smoke ได้เฉพาะ `acme` และบันทึกเป็น known gap
  (ไม่ใช่ blocker — tenant เดียวก็พิสูจน์ plan path ได้แล้ว)

### 2-5 · หา tenant สำหรับ negative test (**เช็คก่อนว่ามีจริง — ห้ามแต่งขั้นตอนที่รันไม่ได้**)

```sql
SELECT t."slug", p."name" AS plan_name, t."isActive",
       (tf."id" IS NOT NULL) AS has_webhooks_override
FROM "Tenant" t
JOIN "Plan" p ON p."id" = t."planId"
LEFT JOIN "TenantFeature" tf
       ON tf."tenantId" = t."id" AND tf."featureKey" = 'webhooks'
WHERE t."slug" NOT IN ('acme', 'globex')
ORDER BY p."name", t."slug";
```

จากนั้นหา **OWNER/ADMIN ของ tenant เหล่านั้น** (ต้องมี ไม่งั้นจะได้ `FORBIDDEN` แทน `FEATURE_LOCKED`):

```sql
SELECT t."slug", p."name" AS plan_name, tm."role", u."email"
FROM "TenantMember" tm
JOIN "Tenant" t ON t."id" = tm."tenantId"
JOIN "Plan" p ON p."id" = t."planId"
JOIN "User" u ON u."id" = tm."userId"
WHERE t."slug" NOT IN ('acme', 'globex')
  AND tm."role" IN ('OWNER', 'ADMIN')
  AND tm."isActive" = true
ORDER BY p."name", t."slug";
```

**negative test จะทำได้จริงก็ต่อเมื่อครบทั้ง 3 ข้อ:**
1. มี tenant ที่ `plan_name` ∈ (`starter`, `growth`) — ต่ำกว่า `requiredPlan='pro'`
2. tenant นั้น **ไม่มี** override (`has_webhooks_override = false`)
3. Dev **เข้าถึงบัญชี OWNER/ADMIN ของ tenant นั้นได้จริง** (รู้ credentials / เป็นบัญชีของ Dev เอง)

⛔ **ถ้าไม่ครบ → ห้ามเปลี่ยน plan ของ tenant ใดเพื่อทดสอบ และห้ามแต่งขั้นตอนที่รันไม่ได้จริง**
ให้บันทึกเป็น **known gap** ตามแบบฟอร์ม § 5.3 แล้วเดินต่อ

---

## 3. เตรียม session (OWNER จริง — ⛔ ไม่ใช่ปุ่ม demo login)

**Route login จริง:** `POST /api/auth/agent/login` (`src/app/api/auth/agent/login/route.ts:45`)
body = `{ "email": "...", "password": "..." }` (schema `:31–34`)
หน้า UI คู่กัน: `/login` (`src/app/(agent)/login/page.tsx`)

**Cookie ที่ได้:** `hw_agent_session` (`src/lib/auth.ts:39`)
attributes: `httpOnly` · `secure` (prod) · `sameSite=strict` · `path=/` · อายุ **8 ชม.**
(`src/lib/auth.ts:378–385`, `COOKIE_MAX_AGE_SECONDS` `:371`)

> ⛔ **ห้าม echo / paste / commit ค่า cookie หรือ password ลงไฟล์ / chat / handoff ใด ๆ**
> cookie นี้ใช้แทนตัวตน OWNER ได้ตรง ๆ

### ทางที่ 1 (แนะนำ) — curl cookie jar ล้วน ไม่ต้องเปิด browser

`acme.gethelpwise.xyz` เป็น DNS จริงบน prod (root domain `NEXT_PUBLIC_ROOT_DOMAIN`
default `gethelpwise.xyz` — `src/proxy.ts:203`) → ยิงตรงได้ **ไม่ต้อง override Host**
และ cookie jar จะผูก domain ให้ถูกต้องอัตโนมัติ

```bash
JAR=$(mktemp)            # เก็บ cookie ชั่วคราว
read -s HW_PASS          # พิมพ์ password ของ owner@acme.test แล้ว Enter (ไม่โชว์บนจอ)

curl -sS -i -c "$JAR" \
  -X POST https://acme.gethelpwise.xyz/api/auth/agent/login \
  -H "Content-Type: application/json" \
  --data "$(printf '{"email":"owner@acme.test","password":"%s"}' "$HW_PASS")"
```

**ผ่านเมื่อ:** `200` + response header มี `Set-Cookie: hw_agent_session=...`

| ผลอื่น | แปลว่า | อ้างอิง |
| --- | --- | --- |
| `401` + `"code":"LOGIN_FAILED"` | email/password ผิด **หรือ** user inactive **หรือ** ไม่ได้เป็น member ของ tenant นี้ (ข้อความเดียวกันโดยตั้งใจ กัน enumeration) | `route.ts:102–107, 112–117, 121–127, 137–141` |
| `429` | ชน rate limit 10 req/60s ต่อ IP | `route.ts:48–56` |
| `404` | subdomain resolve tenant ไม่ได้ | `src/proxy.ts` |

จบงานแล้วลบทิ้ง: `rm -f "$JAR"; unset HW_PASS`

### ทางที่ 2 (สำรอง) — ยิงตรงไปที่ Vercel deployment URL ด้วย Host header

ใช้เมื่อต้องทดสอบ deployment ที่ยังไม่ผูก DNS

> ⚠️ **ห้ามใช้ Node `fetch`** — undici ดรอป Host header (บทเรียนเดิมของโปรเจกต์) ต้องใช้ `curl -H "Host: ..."`
> ⚠️ โหมดนี้ cookie jar จะผูก cookie กับ **host ของ URL** ไม่ใช่ค่าใน `-H "Host:"` →
> ต้อง **ส่ง cookie เองด้วย `-H "Cookie: ..."`** แทน `-b jar`

```bash
curl -sS -i -H "Host: acme.gethelpwise.xyz" \
  -H "Cookie: hw_agent_session=<TOKEN>" \
  https://<deployment-host>/api/webhook-endpoints
```

หา `<TOKEN>`: login ที่ `https://acme.gethelpwise.xyz/login` → DevTools → Application → Cookies →
`hw_agent_session` (httpOnly จึงอ่านจาก JS ไม่ได้ ต้องดูใน DevTools)

---

## 4. Smoke — เส้นทางจริงที่ลูกค้าเดิน

### 4-1 · Positive: `GET /api/webhook-endpoints` บน `acme`

```bash
curl -sS -i -b "$JAR" https://acme.gethelpwise.xyz/api/webhook-endpoints
```

**อ่านผลจาก `error.code` ใน body เสมอ ไม่ใช่แค่ status:**

| ผลลัพธ์ | แปลว่า | ทำอะไรต่อ |
| --- | --- | --- |
| `200` + `{"data":{"endpoints":[...]},"error":null}` (`route.ts:122`) | ✅ **ผ่าน** — plan path + Redis + gate ทำงานครบบน prod | ไป § 4-2 |
| `403` + `"code":"FEATURE_LOCKED"` (`route.ts:104–110`) | plan ไม่ถึง `pro` หรือ flag ปิด | เทียบ § 2-1 / § 2-2 → ถ้า plan จริง < `pro` ให้ **หยุด escalate** (เรื่อง billing) |
| `403` + `"code":"FORBIDDEN"` (`src/lib/auth.ts:106–111`) | ⚠️ **smoke ตั้งผิด** — role ไม่ถึง OWNER/ADMIN (เช่นเผลอใช้ demo session) | กลับไป § 2-4 / § 3 ใช้ `owner@acme.test` |
| `401` + `"code":"UNAUTHORIZED"` | cookie หมดอายุ (8 ชม.) หรือไม่ได้แนบ | login ใหม่ (§ 3) |

ทำซ้ำกับ **`globex`** (`https://globex.gethelpwise.xyz/...` + **login แยก session** เพราะ cookie ผูกกับ
subdomain) — ข้ามได้ถ้า § 2-4 พบว่า globex ไม่มี OWNER/ADMIN (บันทึกเป็น gap)

### 4-2 · End-to-end (ยืนยันว่า "ทำงาน" ไม่ใช่แค่ "ไม่ 403")

1. **สร้าง endpoint** ชี้ไป request-bin สาธารณะที่ Dev คุมเอง
   ต้องเป็น **https สาธารณะ** เพราะ SSRF guard บล็อก private/loopback/CGNAT/metadata
   (`validateWebhookUrl` เรียกที่ `src/app/api/webhook-endpoints/route.ts:188–198`)

   ```bash
   curl -sS -i -b "$JAR" -X POST https://acme.gethelpwise.xyz/api/webhook-endpoints \
     -H "Content-Type: application/json" \
     -d '{"description":"phase38 smoke","url":"https://<your-request-bin>","events":["TICKET_CREATED"]}'
   ```

   **ผ่านเมื่อ:** `201` + body มี `plaintextSecret` (`route.ts:248–251`)
   ⛔ **ห้าม copy `plaintextSecret` ไปไว้ที่ใด** — คือ HMAC signing secret (`prisma/schema.prisma:762–764`)

   | ผลอื่น | แปลว่า | อ้างอิง |
   | --- | --- | --- |
   | `400` + `"code":"INVALID_WEBHOOK_URL"` | URL ไม่ผ่าน SSRF guard | `route.ts:191–197` |
   | `409` + `"code":"ENDPOINT_LIMIT_REACHED"` | ครบ cap 10 endpoint/tenant | `src/lib/webhook-dispatch.ts:39`, `route.ts:206–214` |
   | `429` | ชน rate limit 20 create/ชม./tenant | `route.ts:30–31, 151–158` |

2. **ทริกเกอร์ event** — สร้าง ticket ใหม่บน `acme` ผ่าน UI agent
   (`POST /api/tickets` → `dispatchWebhookEvent` ที่ `src/app/api/tickets/route.ts:495`)
   → ควรเห็น request เข้า request-bin
   ⚠️ ตาม R-1 (`acme`/`globex` เป็น demo public) → **เนื้อหา ticket ต้องเป็นข้อมูลทดสอบเท่านั้น**

3. **ดูประวัติ delivery**

   ```bash
   curl -sS -i -b "$JAR" https://acme.gethelpwise.xyz/api/webhook-deliveries
   ```
   (`src/app/api/webhook-deliveries/route.ts:98`; gate เดียวกัน `:100, :103`)
   หรือดูใน UI ที่ `/settings/webhooks` (`src/app/(agent)/(workspace)/settings/webhooks/page.tsx`)

   **ผ่านเมื่อ:** มี delivery `status = SUCCEEDED` (enum `prisma/schema.prisma:101–104`)

4. ⛔ **ลบ endpoint ที่สร้างตอน smoke ทิ้งทันที** (บังคับ — เหตุผลใน § 6)

   ```bash
   curl -sS -i -b "$JAR" -X DELETE \
     https://acme.gethelpwise.xyz/api/webhook-endpoints/<ENDPOINT_ID>
   ```
   (`src/app/api/webhook-endpoints/[id]/route.ts:234`)
   จากนั้นเรียก `GET /api/webhook-endpoints` ซ้ำ → ต้อง **ไม่มี** endpoint ของ smoke เหลือ

### 4-3 · Negative: tenant ที่ plan ไม่ถึง `pro` ต้องยังได้ `FEATURE_LOCKED`

**ทำได้ก็ต่อเมื่อ § 2-5 ครบทั้ง 3 เงื่อนไข** — ถ้าไม่ครบ ข้ามไป § 5.3 (known gap)

```bash
# login เป็น OWNER/ADMIN ของ tenant นั้นก่อน (§ 3 ทางที่ 1 เปลี่ยน subdomain + email)
curl -sS -i -b "$JAR_OTHER" https://<other-slug>.gethelpwise.xyz/api/webhook-endpoints
```

| ผลลัพธ์ | สรุป |
| --- | --- |
| `403` + `"code":"FEATURE_LOCKED"` | ✅ **ผ่าน** — plan gate ทำงานจริง ไม่ได้เปิดทั้งระบบ |
| `403` + `"code":"FORBIDDEN"` | ❌ **ไม่นับ** — ตกที่ role ก่อนถึง feature gate → หา account ที่ role ถูก |
| `200` | ⚠️ **ผิดคาด** — plan ต่ำกว่า `pro` ไม่ควรผ่าน → **escalate ทันที** (อาจมี override ค้าง — เช็ค § 2-3 / `has_webhooks_override` ใน § 2-5) |

---

## 5. เกณฑ์ปิด post-merge gate ของ Phase 36

รูปแบบตาม `CLAUDE.md` § Post-merge gate

| resource | วิธีตรวจบน prod | ผลที่ถือว่าผ่าน |
| --- | --- | --- |
| migration `20260722010000_add_webhooks_feature_flag` | SQL § 2-1 | 1 แถว `key='webhooks'` · `defaultEnabled=false` · `requiredPlan='pro'` |
| migration `20260723000000_webhooks_rls` — **effect ไม่ใช่แค่แถวใน `_prisma_migrations`** | SQL § 5.1 | `pg_policies` มี `tenant_isolation` บน `WebhookEndpoint` + `WebhookDelivery` และ `relforcerowsecurity = true` ทั้งคู่ |
| entitlement ของ `acme` (external resource = plan) | SQL § 2-2 | `plan_name` ≥ `pro` ตามลำดับ `src/lib/features.ts:25–30` |
| ไม่มี override บังหน้า plan path | SQL § 2-3 | `TenantFeature` featureKey `webhooks` = **0 แถว** |
| smoke read path (`GET /api/webhook-endpoints`) | § 4-1 | `200` + `{"data":{"endpoints":[...]},"error":null}` (ไม่ใช่ 403 ใด ๆ) |
| smoke write path (`POST /api/webhook-endpoints`) | § 4-2 ข้อ 1 | `201` + มี `plaintextSecret` |
| smoke end-to-end delivery | § 4-2 ข้อ 2–3 + SQL § 5.2 | มี `WebhookDelivery` `status=SUCCEEDED` ≥ 1 บน `acme` |
| cleanup หลัง smoke | § 4-2 ข้อ 4 + SQL § 6.1 | ไม่มี endpoint ของ smoke เหลือ |
| negative: plan gate ยังแคบ | § 4-3 | `403` + `FEATURE_LOCKED` **หรือ** บันทึก known gap ตาม § 5.3 |

### 5.1 · SQL ตรวจ effect ของ RLS migration (read-only)

```sql
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE tablename IN ('WebhookEndpoint', 'WebhookDelivery')
ORDER BY tablename;
```

คาดหวัง: policy `tenant_isolation` ครบทั้ง 2 ตาราง

```sql
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE relname IN ('WebhookEndpoint', 'WebhookDelivery');
```

คาดหวัง: `relrowsecurity = true` และ `relforcerowsecurity = true` ทั้งคู่
(migration ตั้ง FORCE ที่ `prisma/migrations/20260723000000_webhooks_rls/migration.sql:37, 53`)

### 5.2 · SQL ยืนยันหลักฐาน delivery (read-only, tenant scope)

```sql
SELECT t."slug", wd."status", wd."createdAt"
FROM "WebhookDelivery" wd
JOIN "Tenant" t ON t."id" = wd."tenantId"
WHERE t."slug" = 'acme'                      -- ← tenant scope
ORDER BY wd."createdAt" DESC
LIMIT 20;
```

### 5.3 · แบบฟอร์มบันทึก known gap (ใช้เมื่อ negative test ทำไม่ได้จริง)

ถ้า § 2-5 ไม่ครบเงื่อนไข ให้เขียนลงรายงานปิด gate แบบนี้ (เติมค่าจริงจากผล query):

```
Known gap — negative test (§ 4-3) ทำไม่ได้บน prod
เหตุผล: [ ] ไม่มี tenant ที่ plan < 'pro'
        [ ] tenant ที่มีอยู่ถูกใส่ TenantFeature override ไว้
        [ ] ไม่มี / เข้าถึงบัญชี OWNER-ADMIN ของ tenant นั้นไม่ได้
หลักฐานประกอบ: ผล query § 2-5 (จำนวน tenant ต่อ plan) — แนบผลจริง
ชดเชยด้วย: ผล § 2-1 (defaultEnabled = false) + § 2-3 (override 0 แถว)
          → ยืนยันว่าไม่ได้เปิดทั้งระบบ แม้พิสูจน์ฝั่ง negative ทาง HTTP ไม่ได้
⛔ ไม่ชดเชยด้วยการเปลี่ยน plan ของ tenant ใดเพื่อทดสอบ (เป็น entitlement/billing ของลูกค้าจริง)
```

---

## 6. หมายเหตุ — demo reset **ไม่ล้าง** `WebhookEndpoint` (follow-up ไม่ใช่ blocker)

### ข้อเท็จจริง

- `prisma/seed-demo.ts` ยาว **891 บรรทัด** และ **ไม่มี `deleteMany` / `.delete(` แม้แต่บรรทัดเดียว**
- เป็น **upsert-only reconciler** — header ระบุเอง: *"idempotent: upsert ทุก record ตาม unique key"*
  (`prisma/seed-demo.ts:8–9`) · write ทุกจุดเป็น `upsert`
  (`:618, 639, 662, 672, 685, 696, 717, 733, 749, 783, 828, 856`)
- คำว่า `webhook` ใน `seed-demo.ts` โผล่ **ที่เดียว** คือเนื้อความ ticket ตัวอย่าง (`:212`) ไม่ใช่โค้ดจัดการ
- **ไม่มี demo-reset script/route ในระบบเลย** — `package.json:8–22` ไม่มี npm script สำหรับ seed-demo/reset

→ **อะไรที่ถูกสร้างขึ้นบน demo tenant จะค้างถาวร** ไม่มีอะไรมาล้างให้

### ความเสี่ยง

`acme`/`globex` เป็น demo public (`src/lib/demo.ts:8–13` — creds public-by-design) →
ถ้ามีใครสร้าง `WebhookEndpoint` ชี้ไป URL ของตัวเอง มันจะรับ payload ของ demo tenant
**ต่อไปเรื่อย ๆ ไม่มีวันหมดอายุ** = outbound traffic ที่เราไม่ได้ตั้งใจส่งและควบคุมไม่ได้

### ทำไม **ไม่ใช่ blocker** ของงานนี้

ช่องที่ทำให้เสี่ยงจริง (visitor สร้าง endpoint ได้) **ถูกปิดอยู่แล้ว 2 ชั้น**:

1. route บังคับ OWNER/ADMIN (`src/app/api/webhook-endpoints/route.ts:136`)
2. demo login บังคับ `role === "AGENT"` (`src/app/api/auth/demo/login/route.ts:19–21`)
   + seed ตั้ง AGENT (`prisma/seed-demo.ts:674, 678, 698, 702`)

บวก cap 10 endpoint/tenant (`src/lib/webhook-dispatch.ts:39`), rate limit 20/ชม.
(`src/app/api/webhook-endpoints/route.ts:30–31`) และ SSRF guard (`:188`)

**เงื่อนไขที่จะกลายเป็น blocker ทันที:** (ก) ให้ demo persona เป็น OWNER/ADMIN หรือ
(ข) ผ่อน role gate ของ `/api/webhook-endpoints` ลงมาที่ `AGENT` → ต้องทำ S2 ก่อน

### ข้อเสนอทางแก้ (⛔ **ห้าม implement ในงานนี้** — เป็นข้อเสนอเท่านั้น)

- **S1 (เล็กสุด, ไม่แตะโค้ด):** เพิ่มข้อ "ตรวจ `WebhookEndpoint` ของ demo tenant" ในรายการตรวจเป็นระยะ
  ใช้ query read-only § 6.1 — เหมาะที่สุดกับสถานะปัจจุบัน (visitor สร้างไม่ได้อยู่แล้ว)
- **S2 (~10 บรรทัดใน `prisma/seed-demo.ts`):** `deleteMany` `WebhookEndpoint` **เฉพาะ `tenantId` ของ
  demo tenant ที่กำลัง loop** ก่อน upsert
  ⚠️ ผลข้างเคียงที่รู้แล้ว: `WebhookDelivery` ผูก composite FK `onDelete: Cascade`
  (`prisma/schema.prisma:796`) → ลบ endpoint = ประวัติ delivery หายตาม (ยอมรับได้บน demo tenant)
  ⚠️ และ seed-demo **ห้ามรันจากเครื่อง Dev** (ชี้ prod) → ประโยชน์จริงเกิดต่อเมื่อมี pipeline seed แยก
- **S3 (เกิน scope):** TTL/expiry บน `WebhookEndpoint` ของ demo tenant + cron ล้าง

### 6.1 · SQL ตรวจ (read-only, tenant scope) — ใช้หลัง smoke และเป็นระยะ

```sql
SELECT t."slug", we."id", we."description", we."url", we."enabled", we."createdAt"
FROM "WebhookEndpoint" we
JOIN "Tenant" t ON t."id" = we."tenantId"
WHERE t."slug" IN ('acme', 'globex')          -- ← tenant scope
ORDER BY t."slug", we."createdAt" DESC;
```

**หลัง smoke ต้องไม่มี endpoint ของ smoke เหลือ** (ถูกลบไปแล้วที่ § 4-2 ข้อ 4)
ถ้ามีของค้างที่ไม่รู้ที่มา → ลบผ่าน **API** `DELETE /api/webhook-endpoints/[id]`
(`src/app/api/webhook-endpoints/[id]/route.ts:234`) **ไม่ใช่ SQL** — เพื่อให้ `audit.log()` ถูกเรียกตามกฎ

---

## 7. Checklist สรุป (ติ๊กตามลำดับ)

- [ ] § 2-1 `FeatureFlag('webhooks')` มีจริง · `defaultEnabled=false` · `requiredPlan='pro'`
- [ ] § 2-2 บันทึก **`plan_name` จริงบน prod** ของ acme/globex (คำถามที่ยังไม่เคยถูกตอบ)
- [ ] § 2-3 `TenantFeature` featureKey `webhooks` = 0 แถว (ถ้าไม่ใช่ → หยุด escalate)
- [ ] § 2-4 ยืนยัน `owner@acme.test` เป็น OWNER + active
- [ ] § 2-5 ตรวจว่ามี tenant สำหรับ negative test จริงไหม (ครบ 3 เงื่อนไข)
- [ ] § 3 login สำเร็จ ได้ `hw_agent_session`
- [ ] § 4-1 `GET /api/webhook-endpoints` = **200** (ไม่ใช่ `FEATURE_LOCKED` / `FORBIDDEN`)
- [ ] § 4-2 create `201` → ticket ใหม่ → delivery `SUCCEEDED`
- [ ] § 4-2 ข้อ 4 **ลบ endpoint smoke แล้ว** + § 6.1 ยืนยันว่าไม่เหลือ
- [ ] § 4-3 negative test ผ่าน **หรือ** บันทึก known gap ตาม § 5.3
- [ ] § 5.1 RLS policy + `relforcerowsecurity` ของ webhook tables ครบ
- [ ] ลบ cookie jar / unset password (`rm -f "$JAR"; unset HW_PASS`)
