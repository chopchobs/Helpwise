# Phase 38 — Runbook: เปิด FeatureFlag `webhooks` ให้ `acme` + `globex` บน prod

> **เป้าหมาย:** ปิด post-merge gate ที่ค้างจาก Phase 36 (outbound webhooks) — พิสูจน์บน prod จริงว่า
> feature ทำงาน (API ตอบ 200 ไม่ใช่ 403 FEATURE_LOCKED) โดย **เปิดแคบที่สุด = per-tenant override เท่านั้น**
>
> **ผู้รัน:** Dev (รันเอง 100%) — เอกสารนี้เขียนโดย agent ที่ **อ่านโค้ดอย่างเดียว ไม่ได้รัน SQL ใด ๆ**
> ทุกข้อเท็จจริงด้านล่างอ้าง `ไฟล์:บรรทัด` จริงในรีโป (commit ที่อ่าน = branch `feature/phase-38-gate-hardening`)
>
> ⛔ **ข้อจำกัดที่ต้องรู้ก่อนเริ่ม:** `.env` ของเครื่อง Dev ชี้ Supabase **ชุดเดียวกับ prod** →
> ห้ามรัน `prisma migrate` / `db push` / `seed` / `seed-demo` จากเครื่องเพื่อทำงานนี้เด็ดขาด
> งานนี้ใช้ **SQL editor บน Supabase** เท่านั้น
>
> **ข้อจำกัดจาก Dev (verbatim):** *"per-tenant override (TenantFeature) เท่านั้น — ห้าม global default
> และห้ามผูก plan. เปิดที่ plan = เปลี่ยน entitlement ของลูกค้าจริงทุกราย ซึ่งเป็นเรื่อง billing
> ไม่ใช่เรื่องปิด gate งานนี้คือพิสูจน์ว่าฟีเจอร์ทำงานบน prod → เปิดแคบที่สุดที่พิสูจน์ได้พอ"*

---

## 0. สรุปผลการสืบค้น (อ่านก่อน — มี 4 เรื่องที่เปลี่ยนวิธีเดิน)

### 0.1 ไม่มี "ทางที่ถูกต้อง" ผ่าน route/script → **ต้องเดินทาง B (SQL ตรง)**

ค้นทั้งรีโปแล้ว **ไม่มี** admin route / API / script / migration ใดที่ **สร้างหรือแก้ `TenantFeature`** เลย
ตัวตนของ `TenantFeature` ในรีโปมีแค่:

| ที่ | บรรทัด | ทำอะไร |
| --- | --- | --- |
| `prisma/schema.prisma` | 261–272 | นิยาม model |
| `src/lib/features.ts` | 70–92 | **อ่านอย่างเดียว** (`findUnique` → override ชนะเสมอ) |
| `prisma/migrations/20260531113517_init/migration.sql` | 88–97, 277, 280, 388 | สร้างตาราง + unique `(tenantId, featureKey)` |
| `prisma/migrations/20260617000000_rls_tenant_isolation/migration.sql` | 206–218 | RLS policy |

- รายการ API route ทั้งหมด (`find src/app/api -name route.ts`, 58 ไฟล์) **ไม่มี** route ชื่อ `features`/`admin`/`entitlements`
- `scripts/` มีแค่ `scan-client-bundle.ts` และ `stripe-smoke.ts` — ไม่เกี่ยวข้อง
- `prisma/seed.ts:160–183` seed **`FeatureFlag` (global)** เท่านั้น ไม่แตะ `TenantFeature`
- `prisma/seed-demo.ts` ไม่มีคำว่า `tenantFeature` เลย

**สรุป: ทาง B** — ต้อง `INSERT ... ON CONFLICT DO UPDATE` ลง `TenantFeature` ตรง ๆ บน Supabase

### 0.2 ผลกระทบต่อกฎ AuditLog (deviation ที่ต้องบันทึก)

กฎโปรเจกต์: *"ใช้ helper `audit.log()` เสมอ ไม่ create row ตรง ๆ"* (`src/lib/audit.ts:5–6`)

การรัน SQL ตรง = `audit.log()` **ไม่ถูกเรียก** → ไม่มีร่องรอยว่าใครเปิด entitlement ให้ tenant

**การตัดสินใจ:** ยอมรับ deviation นี้ **เฉพาะครั้งนี้** โดย **insert `AuditLog` row เองใน transaction เดียวกัน**
กับการเขียน `TenantFeature` (ดู § 3) เหตุผล:

1. ไม่มี code path ใดในระบบที่เขียน `TenantFeature` ได้เลย → ไม่มีทาง "ใช้ helper" โดยไม่เขียนโค้ดใหม่
2. การเขียน admin route ใหม่เพื่อ operation ครั้งเดียวคือ scope creep + เพิ่ม attack surface
   (route ที่แก้ entitlement ได้ = ของอันตราย ต้องมี design/security review ของตัวเอง)
3. Row ที่ insert เองใช้ **คอลัมน์ชุดเดียวกับที่ `createAuditLog()` เขียน** (`src/lib/audit.ts:143–158`)
   → shape เหมือนกันทุกประการ ต่างแค่ transport
4. `actorType = "system"` เป็นค่าที่ helper รองรับอยู่แล้ว (`src/lib/audit.ts:135–137` — ไม่มี actor id)

**Follow-up ที่ควรเปิดเป็นงานแยก (ไม่ทำในงานนี้):** ถ้าอนาคตต้องเปิด/ปิด flag ราย tenant บ่อยขึ้น
→ ทำ **script** (ไม่ใช่ route สาธารณะ) ที่เรียก `audit.log()` จริง แล้วเลิกใช้ SQL ตรง

### 0.3 ⚠️ ตรวจก่อนว่า flag "ยังปิดจริงไหม" — อาจเปิดอยู่แล้วจาก plan

`prisma/migrations/20260722010000_add_webhooks_feature_flag/migration.sql:6–17` insert
`FeatureFlag('webhooks', defaultEnabled=false, requiredPlan='pro')`

และ `prisma/seed-demo.ts:589–593, 618–634` ตั้ง **acme/globex เป็น plan `pro`**

ตรรกะ `hasFeature()` (`src/lib/features.ts:100–106`) → ถ้าไม่มี override และ `requiredPlan='pro'`
จะเทียบ plan: `isPlanSufficient('pro','pro')` = **true** (`src/lib/features.ts:36–43`)

**แปลว่า:** ถ้า prod ของ acme/globex เป็น plan `pro` จริง feature **อาจเปิดอยู่แล้วโดยไม่ต้องทำอะไร**
(ที่ Phase 36 ยังปิด gate ไม่ได้ อาจเป็นเพราะไม่เคยมีใคร *ยืนยัน* ไม่ใช่เพราะมันปิดจริง)

→ **Pre-check § 2 จะบอกคำตอบ** และถึงจะเปิดอยู่แล้ว **ก็ยังควรใส่ override** เพราะ:
- override ทำให้ผลลัพธ์ **deterministic** ไม่ผูกกับ plan/billing (ตรงตามคำสั่ง Dev)
- plan มาจาก header `x-tenant-plan` ที่ **cache ใน Redis** (`src/lib/tenant.ts:95, 105`) → path ที่ผ่าน plan
  ขึ้นกับ cache; ส่วน `TenantFeature` **ไม่มี cache เลย** (`src/lib/features.ts` ไม่ import redis) → เห็นผลทันที

### 0.4 ⚠️ Demo login ให้ role = `AGENT` เท่านั้น → **smoke ด้วย demo persona จะได้ 403 ตลอด**

- ทุก webhook route บังคับ `requireAgent({ roles: ["OWNER", "ADMIN"] })`
  (`src/app/api/webhook-endpoints/route.ts:98, 136` · `src/app/api/webhook-deliveries/route.ts:100`)
- แต่ demo member ถูก seed เป็น `AGENT` เสมอ (`prisma/seed-demo.ts:674, 678, 698, 702`)
  และ `/api/auth/demo/login` ยัง **บังคับซ้ำ** ว่า `role === "AGENT"`
  (`src/app/api/auth/demo/login/route.ts:19–21`)

→ **Dev ต้องใช้บัญชี OWNER/ADMIN จริงของ acme/globex ในการ smoke** ไม่ใช่ปุ่ม demo login
Pre-check § 2 มี query หา member ที่ใช้ได้ **ถ้าไม่มีเลย = blocker ต้องแก้ก่อน smoke** (ดู § 5.0)

⚠️ **ต้องแยก 403 สองแบบให้ออก** — ทั้งคู่เป็น 403 แต่คนละสาเหตุ:

| `error.code` | แปลว่า | อ้างอิง |
| --- | --- | --- |
| `FORBIDDEN` | role ไม่ถึง OWNER/ADMIN (หรือ auth ไม่ผ่าน) — **ไม่เกี่ยวกับ flag** | `src/lib/auth.ts:106–111` |
| `FEATURE_LOCKED` | flag ปิดอยู่ — **นี่คือตัวที่ runbook นี้ต้องทำให้หาย** | `src/app/api/webhook-endpoints/route.ts:104–110` |

---

## 1. ผลการตรวจ demo reset vs `WebhookEndpoint` (Dev สั่งเช็คโดยตรง)

### คำตอบ: **`prisma/seed-demo.ts` ไม่ล้าง `WebhookEndpoint` — และไม่ล้างอะไรเลยทั้งไฟล์**

หลักฐาน:
- `grep -n "deleteMany\|\.delete(" prisma/seed-demo.ts` → **ไม่มีผลลัพธ์แม้แต่บรรทัดเดียว** (ไฟล์ยาว 891 บรรทัด)
- header ของไฟล์ระบุชัด: *"idempotent: upsert ทุก record ตาม unique key"* (`prisma/seed-demo.ts:8–9`)
  ทุก write เป็น `upsert` (`:618, :639, :662, :672, :685, :696, :717, :733, :749, :783, :828, :856`)
- คำว่า `webhook` ปรากฏใน `seed-demo.ts` แค่ที่เดียวคือ **เนื้อความ ticket ตัวอย่าง** (`prisma/seed-demo.ts:212`)
  ไม่ใช่โค้ดจัดการ `WebhookEndpoint`
- **ไม่มี "demo reset" script/route อยู่ในระบบเลย** — `package.json:8–22` ไม่มี npm script สำหรับ seed-demo/reset
  และไม่มี API route ที่ reset demo

→ กล่าวคือ **"demo reset" ในความหมายของ "ล้างของที่ visitor สร้าง" ไม่มีอยู่จริงในโปรเจกต์นี้**
seed-demo เป็น *upsert-only reconciler* ที่ reconcile เฉพาะ key ของตัวเอง อะไรที่ visitor สร้างขึ้นใหม่จะ **ค้างตลอดไป**

### ความเสี่ยงที่ตามมา (ประเมินแล้ว)

`acme`/`globex` เป็น demo public (`src/lib/demo.ts:8–13` — creds public-by-design) →
**visitor คนใดก็ได้** (ถ้าได้สิทธิ์ OWNER/ADMIN) สร้าง `WebhookEndpoint` ชี้ไป URL ของตัวเองได้ แล้ว
**endpoint นั้นจะค้างถาวรและรับ payload ของ demo tenant ต่อไปเรื่อย ๆ ไม่มีวันหมดอายุ**
ข้อมูลเป็น demo ไม่ใช่ของจริง (R-1) แต่มันคือ **outbound traffic จาก infra เราไปหา URL ที่เราควบคุมไม่ได้**

**แต่ — ปัจจัยที่ลดความเสี่ยงลงมาก (ตรวจแล้ว):**

1. สร้าง endpoint ได้เฉพาะ **OWNER/ADMIN** (`src/app/api/webhook-endpoints/route.ts:136`)
   แต่ demo login ให้แค่ `AGENT` และ **บังคับซ้ำที่ route** (`src/app/api/auth/demo/login/route.ts:19–21`)
   → **visitor ที่เข้าทางปุ่ม demo ปกติ สร้าง endpoint ไม่ได้เลย (ได้ 403 FORBIDDEN)**
2. cap 10 endpoint ต่อ tenant (`src/lib/webhook-dispatch.ts:39` + เช็คที่ `route.ts:205–214`)
   → fan-out จำกัด ไม่ระเบิด
3. rate limit สร้าง 20 ครั้ง/ชม./tenant (`src/app/api/webhook-endpoints/route.ts:30–31, 151–158`)
4. SSRF guard บังคับ https สาธารณะ (`validateWebhookUrl`, เรียกที่ `route.ts:188`)

### ข้อเสนอ (⛔ **ห้าม implement ในงานนี้** — เขียนเป็นข้อเสนอเท่านั้น)

**ทางแก้ที่เล็กที่สุด (เรียงจากเล็กไปใหญ่):**

- **S1 (เล็กสุด, manual):** ไม่แตะโค้ดเลย — เพิ่มข้อ "ตรวจ `WebhookEndpoint` ของ demo tenant" เข้า
  operational checklist รายเดือน + SQL ลบแบบ scope ต่อ tenant (มีให้แล้วใน § 6.2 ของไฟล์นี้)
  เหมาะเพราะปัจจุบัน visitor สร้างไม่ได้อยู่แล้ว (ปัจจัยข้อ 1)
- **S2 (เล็ก, ~10 บรรทัดใน `prisma/seed-demo.ts`):** เพิ่ม `deleteMany` ของ `WebhookEndpoint`
  **เฉพาะ `tenantId` ของ demo tenant ที่กำลัง loop อยู่** ก่อน upsert
  ⚠️ ผลข้างเคียงที่รู้แล้ว: `WebhookDelivery` ผูก composite FK `onDelete: Cascade`
  (`prisma/schema.prisma:796`) → ลบ endpoint = ประวัติ delivery หายตาม (ยอมรับได้บน demo tenant)
  ⚠️ และ seed-demo **ห้ามรันจากเครื่อง Dev** (ชี้ prod) → ประโยชน์จริงเกิดต่อเมื่อมี pipeline seed แยก
- **S3 (ใหญ่, เกิน scope):** TTL/expiry บน `WebhookEndpoint` ของ demo tenant + cron ล้าง

**ควรเป็น blocker ของการเปิด flag ไหม → ไม่ (เป็น follow-up แยก)**

เหตุผล: ช่องทางที่ทำให้ความเสี่ยงเกิดจริง คือ "visitor สร้าง endpoint ได้" ซึ่ง **ถูกปิดด้วย role gate
OWNER/ADMIN อยู่แล้ว 2 ชั้น** (route + demo-login guard) การเปิด flag ไม่ได้เปิดช่องนั้นเพิ่ม —
มันแค่ทำให้ **บัญชี OWNER/ADMIN ที่มีอยู่แล้ว** ใช้ฟีเจอร์ได้ ซึ่งคือคนของเราเอง

**เงื่อนไขที่จะกลับมาเป็น blocker ทันที:** ถ้ามีการ (ก) ให้ demo persona เป็น OWNER/ADMIN, หรือ
(ข) ผ่อน role gate ของ `/api/webhook-endpoints` ลงมาที่ `AGENT` → ต้องทำ S2 ก่อน

**Action ที่ต้องทำในงานนี้แทน:** § 6.1 บังคับให้ Dev **ลบ endpoint ที่สร้างตอน smoke ทิ้งทุกครั้ง**
(อย่าปล่อยค้าง เพราะไม่มีอะไรมาล้างให้)

---

## 2. Pre-check — read-only ทั้งหมด (⛔ ห้ามข้าม)

รันบน **Supabase SQL editor** ของ prod ทีละ block แล้ว **จดผลไว้** ก่อนแตะอะไร

### 2-1 · FeatureFlag `webhooks` มีจริงไหม + ค่าปัจจุบัน

```sql
SELECT "key", "defaultEnabled", "requiredPlan", "createdAt"
FROM "FeatureFlag"
WHERE "key" = 'webhooks';
```

**คาดหวัง:** 1 แถว · `defaultEnabled = false` · `requiredPlan = 'pro'`
(ตรงกับ `prisma/migrations/20260722010000_add_webhooks_feature_flag/migration.sql:6–17`)

- ⚠️ **ถ้าได้ 0 แถว** = migration `20260722010000` ยังไม่ apply บน prod → **หยุด** นี่เป็นปัญหาคนละเรื่อง
  (migration ค้าง) ต้องแก้ก่อน แล้วค่อยกลับมา
- ⚠️ **ถ้า `defaultEnabled = true`** = มีคนเปิด global ไว้ → **หยุด** แล้วรายงาน ขัดคำสั่ง Dev
  (ต้องเป็น per-tenant override เท่านั้น)

### 2-2 · tenant id + plan ของ acme/globex (**ห้ามเดา id — ต้องดึงจากที่นี่**)

```sql
SELECT t."id" AS tenant_id, t."slug", t."isActive", p."name" AS plan_name
FROM "Tenant" t
JOIN "Plan" p ON p."id" = t."planId"
WHERE t."slug" IN ('acme', 'globex')
ORDER BY t."slug";
```

**จดไว้:** `tenant_id` ของแต่ละ slug (จะใช้ต่อทุกขั้น) และ `plan_name`

> 📌 ถ้า `plan_name = 'pro'` ทั้งคู่ → ตาม § 0.3 feature **น่าจะเปิดอยู่แล้ว** ผ่าน layer 2
> ให้ทำต่อตามปกติ (override ทำให้ deterministic) แต่ **บันทึกข้อเท็จจริงนี้ไว้ในรายงานปิด gate**
> ว่า "ไม่ได้ปิดอยู่จริงมาตั้งแต่แรก" — สำคัญต่อการสรุปว่าทำไม Phase 36 ค้าง

### 2-3 · TenantFeature วันนี้เป็นอะไร (ทั้งระบบ สำหรับ key นี้)

```sql
SELECT tf."tenantId", t."slug", tf."featureKey", tf."enabled", tf."createdAt", tf."updatedAt"
FROM "TenantFeature" tf
JOIN "Tenant" t ON t."id" = tf."tenantId"
WHERE tf."featureKey" = 'webhooks'
ORDER BY t."slug";
```

**คาดหวัง:** 0 แถว (ยังไม่เคยมีใครตั้ง override)
ถ้ามีแถวอยู่แล้ว → จดค่าเดิมไว้ **ก่อน** ทำ § 3 (ต้องใช้ตอน rollback)

### 2-4 · หา member OWNER/ADMIN ที่ใช้ smoke ได้ (จาก § 0.4)

```sql
SELECT t."slug", tm."id" AS member_id, tm."role", tm."isActive", u."email"
FROM "TenantMember" tm
JOIN "Tenant" t ON t."id" = tm."tenantId"
JOIN "User" u ON u."id" = tm."userId"
WHERE t."slug" IN ('acme', 'globex')
  AND tm."role" IN ('OWNER', 'ADMIN')
  AND tm."isActive" = true
ORDER BY t."slug", tm."role";
```

- **ถ้าได้ ≥ 1 แถวต่อ tenant** → ใช้ email นั้น login ปกติที่ `/login` ของ subdomain นั้น (ต้องรู้ password)
- **⛔ ถ้าได้ 0 แถว** → **smoke ไม่ผ่านแน่นอน** ไม่ว่า flag จะเปิดหรือไม่ (จะได้ `FORBIDDEN`)
  → **หยุดที่นี่แล้ว escalate** อย่าเพิ่งเขียน § 3 ดู § 5.0 ประกอบ

### 2-5 · หา tenant สำหรับ negative test (ต้องยังได้ 403 `FEATURE_LOCKED`)

```sql
SELECT t."slug", t."id" AS tenant_id, p."name" AS plan_name, t."isActive"
FROM "Tenant" t
JOIN "Plan" p ON p."id" = t."planId"
LEFT JOIN "TenantFeature" tf
       ON tf."tenantId" = t."id" AND tf."featureKey" = 'webhooks'
WHERE t."slug" NOT IN ('acme', 'globex')
  AND tf."id" IS NULL
ORDER BY p."name", t."slug";
```

⚠️ **เลือก tenant ที่ `plan_name` ต่ำกว่า `pro` เท่านั้น** (`starter` หรือ `growth` —
ลำดับ plan ที่โค้ดใช้อยู่ที่ `src/lib/features.ts:25–30`) เพราะ tenant ที่ plan ≥ `pro`
จะผ่าน layer 2 และได้ 200 อยู่แล้วโดยไม่เกี่ยวกับ override → **พิสูจน์อะไรไม่ได้**

- ถ้าไม่มี tenant ที่ plan < `pro` เลย → ข้าม negative test แบบ HTTP แล้วใช้ **§ 5.3 ทางเลือก B**
  (พิสูจน์ด้วย SQL ว่ามี override เพียง 2 แถว) แล้วบันทึกข้อจำกัดนี้ไว้

### 2-6 · (แนะนำ) ยืนยัน RLS ของ webhook tables apply แล้ว — เกี่ยวกับ gate เดียวกัน

```sql
SELECT tablename, policyname FROM pg_policies
WHERE tablename IN ('WebhookEndpoint', 'WebhookDelivery', 'TenantFeature');
```

คาดหวัง: มี policy `tenant_isolation` ครบทั้ง 3 ตาราง
(`prisma/migrations/20260723000000_webhooks_rls/migration.sql:37, 53` ·
`prisma/migrations/20260617000000_rls_tenant_isolation/migration.sql:206–218`)

---

## 3. ขั้นตอนเปิด flag (ทาง B — SQL ตรง + AuditLog ใน transaction เดียว)

> **หลักการที่ SQL ชุดนี้ยึด:**
> - ทุกคำสั่งมี **tenant scope ชัดเจน** ผ่าน sub-select `WHERE "slug" = '...'` — **ไม่มี UPDATE/DELETE
>   ที่ไม่มี scope** และ **ไม่มีการ hardcode tenant id** (กันพิมพ์ id ผิดแล้วไปโดน tenant อื่น)
> - **idempotent**: รันซ้ำได้ไม่พัง (`ON CONFLICT`)
> - `AuditLog` เขียนใน **transaction เดียวกัน** → ไม่มีสภาพ "เปลี่ยน entitlement แต่ไม่มีร่องรอย"
> - `AuditLog` เป็น **INSERT อย่างเดียว** ไม่มี UPDATE/DELETE (immutable ตาม `src/lib/audit.ts:5`)
>   และ **ไม่มี PII** ใน `after`/`metadata` (มีแค่ featureKey/enabled/เหตุผล)

### 3-1 · รันทีละ tenant — **acme**

```sql
BEGIN;

-- (ก) เปิด override ให้ acme เท่านั้น — idempotent
INSERT INTO "TenantFeature" ("id", "tenantId", "featureKey", "enabled", "createdAt", "updatedAt")
SELECT
  'tf_phase38_webhooks_' || t."slug",   -- deterministic id → รันซ้ำชนกับตัวเองเสมอ ไม่สร้างขยะ
  t."id",
  'webhooks',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP                      -- ⚠️ updatedAt ไม่มี DB default (Prisma จัดการ) → ต้องใส่เอง
FROM "Tenant" t
WHERE t."slug" = 'acme'                  -- ← tenant scope
ON CONFLICT ("tenantId", "featureKey")
DO UPDATE SET "enabled" = EXCLUDED."enabled",
              "updatedAt" = CURRENT_TIMESTAMP;

-- (ข) AuditLog — deviation จากกฎ "ใช้ audit.log() เสมอ" (เหตุผลบันทึกไว้ที่ § 0.2 ของ runbook นี้)
--     คอลัมน์ตรงกับที่ createAuditLog() เขียนทุกช่อง (src/lib/audit.ts:143-158)
INSERT INTO "AuditLog" (
  "id", "tenantId", "actorType", "actorUserId", "actorMemberId", "actorContactId",
  "targetType", "targetId", "action", "before", "after", "metadata", "ticketId", "createdAt"
)
SELECT
  'audit_phase38_webhooks_' || t."slug",
  t."id",
  'system',                              -- actorType ที่ helper รองรับ (src/lib/audit.ts:135-137)
  NULL, NULL, NULL,
  'tenant_feature',
  'webhooks',
  'tenant_feature.enabled',
  '{"enabled": null, "source": "plan_default"}'::jsonb,
  '{"enabled": true, "source": "tenant_override"}'::jsonb,
  '{"phase": "38", "reason": "post-merge gate Phase 36 — prove outbound webhooks on prod", "method": "manual SQL (no admin route exists)", "runbook": ".claude/specs/phase-38-webhooks-flag-runbook.md"}'::jsonb,
  NULL,
  CURRENT_TIMESTAMP
FROM "Tenant" t
WHERE t."slug" = 'acme'                  -- ← tenant scope
ON CONFLICT ("id") DO NOTHING;           -- รันซ้ำ = ไม่เพิ่มแถว (immutable, ห้าม UPDATE)

COMMIT;
```

### 3-2 · รันซ้ำอีกรอบสำหรับ **globex**

ใช้ block เดียวกับ § 3-1 แต่เปลี่ยน `'acme'` → `'globex'` **ทั้ง 2 แห่ง** (บรรทัด `WHERE t."slug"`)
id ทั้งสองตัวสร้างจาก `|| t."slug"` อยู่แล้ว → ไม่ชนกัน

> 💡 **รันทีละ tenant ตั้งใจ** — ไม่ใช้ `IN ('acme','globex')` เพื่อให้เห็นว่าแต่ละครั้งกระทบ 1 tenant
> และถ้าพลาดกลางทาง rollback ได้ทีละตัว

### 3-3 · ถ้าเจอ error RLS (`new row violates row-level security policy`)

`TenantFeature`/`AuditLog` เป็น `ENABLE ROW LEVEL SECURITY` แต่ **ไม่ได้ `FORCE`**
(`prisma/migrations/20260617000000_rls_tenant_isolation/migration.sql:207, 222` — เทียบกับ
`Ticket` ที่ FORCE ที่บรรทัด 36) → role ที่เป็น table owner จะ bypass ได้ตามปกติ **จึงไม่ควรเจอ error นี้**

ถ้าเจอจริง ให้ใส่บรรทัดนี้ **ต่อจาก `BEGIN;` ทันที** แล้วรันใหม่ (bypass มีผลเฉพาะใน transaction นี้):

```sql
SELECT set_config('app.rls_bypass', 'on', true);  -- true = transaction-local
```

(ค่านี้คือ escape hatch ที่ policy รองรับอยู่แล้ว — เห็นได้ที่ migration บรรทัด 211, 216)
ความปลอดภัยยังอยู่ เพราะทุก statement ด้านบน scope ด้วย `WHERE t."slug" = '...'` อยู่แล้ว

### 3-4 · Verify ทันทีหลัง commit (read-only)

```sql
SELECT t."slug", tf."featureKey", tf."enabled", tf."updatedAt"
FROM "TenantFeature" tf
JOIN "Tenant" t ON t."id" = tf."tenantId"
WHERE tf."featureKey" = 'webhooks'
ORDER BY t."slug";
```

**ผ่านเมื่อ:** ได้ **2 แถวเท่านั้น** — `acme` และ `globex` · `enabled = true` ทั้งคู่
⚠️ ถ้าได้ > 2 แถว = เผลอเปิดให้ tenant อื่น → ไป § 4 ทันที

```sql
SELECT t."slug", a."action", a."actorType", a."targetType", a."targetId", a."after", a."createdAt"
FROM "AuditLog" a
JOIN "Tenant" t ON t."id" = a."tenantId"
WHERE a."targetType" = 'tenant_feature' AND a."targetId" = 'webhooks'
ORDER BY t."slug";
```

**ผ่านเมื่อ:** 2 แถว (acme, globex) · `actorType='system'` · `after` มี `"enabled": true`

---

## 4. Rollback (ถ้าพัง / ต้องปิดกลับ)

> ปิดกลับมี 2 ระดับ — **เลือกระดับ 1 ก่อนเสมอ**

### 4-1 · ระดับ 1 (แนะนำ): พลิก override เป็น `false` — เก็บร่องรอยไว้

```sql
BEGIN;

UPDATE "TenantFeature" tf
SET "enabled" = false, "updatedAt" = CURRENT_TIMESTAMP
FROM "Tenant" t
WHERE tf."tenantId" = t."id"             -- ← tenant scope (join)
  AND t."slug" = 'acme'                  -- ← เปลี่ยนเป็น 'globex' แล้วรันซ้ำอีกรอบ
  AND tf."featureKey" = 'webhooks';

INSERT INTO "AuditLog" (
  "id", "tenantId", "actorType", "targetType", "targetId",
  "action", "before", "after", "metadata", "createdAt"
)
SELECT
  'audit_phase38_webhooks_rollback_' || t."slug",
  t."id", 'system', 'tenant_feature', 'webhooks',
  'tenant_feature.disabled',
  '{"enabled": true, "source": "tenant_override"}'::jsonb,
  '{"enabled": false, "source": "tenant_override"}'::jsonb,
  '{"phase": "38", "reason": "rollback", "runbook": ".claude/specs/phase-38-webhooks-flag-runbook.md"}'::jsonb,
  CURRENT_TIMESTAMP
FROM "Tenant" t
WHERE t."slug" = 'acme'
ON CONFLICT ("id") DO NOTHING;

COMMIT;
```

`enabled = false` เป็น **override ที่ชนะ layer plan ด้วย** (`src/lib/features.ts:90–92`)
→ ปิดได้จริงแม้ tenant จะ plan `pro`

### 4-2 · ระดับ 2: ลบแถว override ทิ้ง (กลับไปตัดสินตาม plan เหมือนเดิม 100%)

⚠️ ใช้เมื่อต้องการคืนสภาพ "เหมือนไม่เคยทำ" เท่านั้น — **ห้ามลบ `AuditLog`** (immutable)

```sql
DELETE FROM "TenantFeature" tf
USING "Tenant" t
WHERE tf."tenantId" = t."id"
  AND t."slug" IN ('acme', 'globex')     -- ← tenant scope บังคับ ห้ามตัดออก
  AND tf."featureKey" = 'webhooks';      -- ← key scope บังคับ ห้ามตัดออก
```

📌 ถ้า § 2-3 พบว่ามี override เดิมอยู่ก่อนแล้ว → **อย่าใช้ § 4-2** ให้ใช้ § 4-1 แล้วเซ็ตกลับเป็นค่าเดิมที่จดไว้

---

## 5. เกณฑ์ผ่าน (post-merge gate) — smoke บน prod จริง

> 📌 โปรเจกต์นี้ resolve tenant จาก **Host header** (`src/proxy.ts:203`, root domain
> `NEXT_PUBLIC_ROOT_DOMAIN` default `gethelpwise.xyz`) → ใช้ `curl -H "Host: ..."` เท่านั้น
> **ห้ามใช้ Node `fetch`** (undici ดรอป Host header — บทเรียนเดิมของโปรเจกต์)

### 5-0 · เตรียม session cookie (⛔ ต้องเป็น OWNER/ADMIN)

- ใช้ email จาก **§ 2-4** login ที่หน้า agent login ของ subdomain นั้น (เช่น `https://acme.gethelpwise.xyz`)
- เปิด DevTools → Application → Cookies → คัดลอกค่า cookie ชื่อ **`hw_agent_session`**
  (`src/lib/auth.ts:39`) — httpOnly จึงต้องอ่านจาก DevTools ไม่ใช่จาก JS
- ⛔ **ห้ามใช้ปุ่ม demo login** — ได้ role `AGENT` → จะเจอ `403 FORBIDDEN` เสมอ (§ 0.4)
- ⛔ **ห้ามวางค่า cookie ลงในเอกสาร/handoff/commit ใด ๆ** — มันคือ session token

```bash
# ตั้ง env ชั่วคราวใน shell (อย่า echo, อย่า commit)
read -s HW_COOKIE   # วาง value ของ hw_agent_session แล้ว Enter
```

### 5-1 · Positive — tenant ที่เปิด flag ต้องได้ **200**

**Endpoint จริงจากรีโป:** `GET /api/webhook-endpoints`
(`src/app/api/webhook-endpoints/route.ts:96` — auth `requireAgent({roles:["OWNER","ADMIN"]})` บรรทัด 98,
feature gate บรรทัด 102–111, ตอบ 200 บรรทัด 122)

```bash
curl -sS -i \
  -H "Host: acme.gethelpwise.xyz" \
  -H "Cookie: hw_agent_session=$HW_COOKIE" \
  https://acme.gethelpwise.xyz/api/webhook-endpoints
```

ทำซ้ำกับ `globex` (เปลี่ยน Host + URL + ใช้ cookie ของ session globex — **คนละ session**)

| ผลลัพธ์ | แปลว่า | ทำอะไรต่อ |
| --- | --- | --- |
| `200` + `{"data":{"endpoints":[...]},"error":null}` | ✅ **ผ่าน** | ไปข้อ 5-2 |
| `403` + `"code":"FEATURE_LOCKED"` | ❌ flag ยังไม่มีผล | กลับไป § 3-4 verify แถว; ถ้าแถวถูกแล้วให้ตรวจว่ายิงถูก tenant จริง |
| `403` + `"code":"FORBIDDEN"` | ⚠️ **ไม่ใช่ปัญหา flag** — role ไม่ถึง OWNER/ADMIN | กลับไป § 2-4 / § 5-0 หา account ที่ถูก |
| `401` + `"code":"UNAUTHORIZED"` | cookie หมดอายุ/ผิด (อายุ 8 ชม. — `src/lib/auth.ts:371`) | login ใหม่ |

### 5-2 · End-to-end (แนะนำ — พิสูจน์ว่า "ทำงาน" ไม่ใช่แค่ "ไม่ 403")

1. **สร้าง endpoint** ชี้ไป request-bin สาธารณะที่ Dev คุมเอง (ต้องเป็น **https** + สาธารณะ
   เพราะ SSRF guard บล็อก private/loopback/CGNAT/metadata — `route.ts:188–198`)

   ```bash
   curl -sS -i -X POST \
     -H "Host: acme.gethelpwise.xyz" \
     -H "Cookie: hw_agent_session=$HW_COOKIE" \
     -H "Content-Type: application/json" \
     -d '{"description":"phase38 smoke","url":"https://<your-request-bin>","events":["TICKET_CREATED"]}' \
     https://acme.gethelpwise.xyz/api/webhook-endpoints
   ```

   **ผ่านเมื่อ:** `201` + body มี `plaintextSecret` (`route.ts:248–251`)
   ⛔ **ห้าม copy `plaintextSecret` ไปวางในเอกสาร/chat/commit** — มันคือ signing secret

   | ผลอื่น | แปลว่า |
   | --- | --- |
   | `400 INVALID_WEBHOOK_URL` | URL ไม่ผ่าน SSRF guard → ใช้ https สาธารณะจริง |
   | `409 ENDPOINT_LIMIT_REACHED` | ครบ 10 endpoint แล้ว (`src/lib/webhook-dispatch.ts:39`) → ลบของเก่าก่อน |
   | `429` | ชน rate limit 20/ชม. (`route.ts:30–31`) → รอ |

2. **ทริกเกอร์ event** — สร้าง ticket ใหม่บน tenant นั้นผ่าน UI agent
   (`POST /api/tickets` → `dispatchWebhookEvent` ที่ `src/app/api/tickets/route.ts:495`)
   → ควรเห็น request เข้า request-bin ของ Dev

3. **ดูประวัติ delivery** — `GET /api/webhook-deliveries`
   (`src/app/api/webhook-deliveries/route.ts:98`, gate เดียวกัน บรรทัด 100–103)
   หรือดูใน UI ที่ `/settings/webhooks` (`src/app/(agent)/(workspace)/settings/webhooks/page.tsx`)

   **ผ่านเมื่อ:** มี delivery ที่ `status = SUCCEEDED`

4. ⛔ **ลบ endpoint smoke ทิ้งทันทีเมื่อจบ** (สำคัญ — ไม่มีอะไรมาล้างให้ ดู § 1 และ § 6.1)

   ```bash
   curl -sS -i -X DELETE \
     -H "Host: acme.gethelpwise.xyz" \
     -H "Cookie: hw_agent_session=$HW_COOKIE" \
     https://acme.gethelpwise.xyz/api/webhook-endpoints/<ENDPOINT_ID>
   ```
   (`src/app/api/webhook-endpoints/[id]/route.ts:234`)

### 5-3 · Negative — พิสูจน์ว่า override **แคบจริง** ไม่ได้เปิดทั้งระบบ

**ทางเลือก A (ดีที่สุด — พิสูจน์ผ่าน HTTP):**
ใช้ tenant จาก § 2-5 ที่ **plan < `pro` และไม่มี override** — login เป็น OWNER/ADMIN ของ tenant นั้น แล้ว:

```bash
curl -sS -i \
  -H "Host: <other-slug>.gethelpwise.xyz" \
  -H "Cookie: hw_agent_session=$HW_COOKIE_OTHER" \
  https://<other-slug>.gethelpwise.xyz/api/webhook-endpoints
```

**ผ่านเมื่อ:** `403` + `"code":"FEATURE_LOCKED"` (**ต้องเป็น `FEATURE_LOCKED` ไม่ใช่ `FORBIDDEN`** —
`FORBIDDEN` แปลว่าโดนตีตกที่ role ก่อนถึง feature gate → **พิสูจน์เรื่อง flag ไม่ได้**)
**ไม่ผ่านเมื่อ:** ได้ `200` → แปลว่าเปิดกว้างเกิน → ไป § 4 ทันทีแล้ว escalate

**ทางเลือก B (ถ้าไม่มี tenant plan < pro / ไม่มี OWNER account ของ tenant อื่น):**
พิสูจน์ด้วย SQL แทน + บันทึกข้อจำกัดไว้ในรายงาน

```sql
-- ต้องได้ 2 แถวเท่านั้น (acme, globex) — ไม่มี tenant อื่นถูกแตะ
SELECT t."slug", tf."enabled"
FROM "TenantFeature" tf JOIN "Tenant" t ON t."id" = tf."tenantId"
WHERE tf."featureKey" = 'webhooks';

-- global ต้องยังปิด: defaultEnabled = false
SELECT "key", "defaultEnabled", "requiredPlan" FROM "FeatureFlag" WHERE "key" = 'webhooks';
```

### 5-4 · สรุปเกณฑ์ปิด gate

- [ ] § 3-4 — `TenantFeature` มี **2 แถวเท่านั้น** (acme, globex) `enabled=true`
- [ ] § 3-4 — `AuditLog` มี 2 แถว `targetType='tenant_feature'`, `actorType='system'`
- [ ] § 5-1 — `GET /api/webhook-endpoints` ได้ **200** ทั้ง acme และ globex
- [ ] § 5-2 — สร้าง endpoint ได้ `201` + มี delivery `SUCCEEDED` อย่างน้อย 1 (end-to-end จริงบน prod)
- [ ] § 5-2 ข้อ 4 — **ลบ endpoint smoke ทิ้งแล้ว**
- [ ] § 5-3 — negative test ผ่าน (`FEATURE_LOCKED` บน tenant อื่น หรือทางเลือก B + บันทึกข้อจำกัด)
- [ ] § 2-1 — `FeatureFlag.defaultEnabled` ยังเป็น `false` (ไม่ได้เผลอเปิด global)

---

## 6. หมายเหตุความเสี่ยง (ต่อจาก § 1)

### 6.1 ⛔ ต้องลบ endpoint ที่สร้างตอน smoke ทิ้งเสมอ

ไม่มี seed/reset/cron ใดในระบบล้าง `WebhookEndpoint` เลย (§ 1) → **อะไรที่สร้างทิ้งไว้ = อยู่ถาวร**
และจะยิง payload ของ demo tenant ออกไปเรื่อย ๆ ทุกครั้งที่มี ticket ใหม่

### 6.2 SQL ตรวจ/ล้าง `WebhookEndpoint` ของ demo tenant (ใช้ตอน audit เป็นระยะ)

```sql
-- ตรวจ (read-only) — ควรว่างหลังจบ smoke
SELECT t."slug", we."id", we."description", we."url", we."enabled", we."createdAt"
FROM "WebhookEndpoint" we
JOIN "Tenant" t ON t."id" = we."tenantId"
WHERE t."slug" IN ('acme', 'globex')
ORDER BY t."slug", we."createdAt" DESC;
```

```sql
-- ล้างเฉพาะ demo tenant (ใช้เมื่อจำเป็น — ⚠️ tenant scope บังคับ ห้ามตัด WHERE ออก)
-- ⚠️ WebhookDelivery ผูกด้วย composite FK onDelete: Cascade (prisma/schema.prisma:796)
--    → ลบ endpoint = ประวัติ delivery ของมันหายตามไปด้วย (ยอมรับได้เพราะเป็น demo tenant)
DELETE FROM "WebhookEndpoint" we
USING "Tenant" t
WHERE we."tenantId" = t."id"
  AND t."slug" IN ('acme', 'globex');
```

### 6.3 R-1 — acme/globex เป็น demo public

ห้ามนำข้อมูลจริง/URL ภายในองค์กร/ระบบ production ของใครมาผูกกับ 2 tenant นี้
URL ที่ใช้ smoke ต้องเป็น request-bin ทิ้งขว้างที่ไม่มีข้อมูลสำคัญ

### 6.4 หลัง smoke เสร็จ

Feature ยังเปิดค้างอยู่ที่ acme/globex ต่อไป (ตั้งใจ — เพื่อให้ demo แสดงฟีเจอร์ได้)
ถ้าไม่ต้องการให้เปิดค้าง ให้เดิน § 4-1 หลังเก็บหลักฐานครบ
