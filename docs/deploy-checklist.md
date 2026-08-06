# Helpwise — Vercel Deploy Checklist

> Runbook สำหรับ deploy Helpwise (multi-tenant SaaS help desk) ขึ้น Vercel production
> งานทั้งหมดเป็น **manual โดย Dev** (provision cloud / DNS / console).
> อ้างอิงกฎเต็มที่ `CLAUDE.md`; รายละเอียด env แต่ละตัวดู `.env.example`

---

## 0. ตัดสินก่อนอย่างอื่น — DNS

Demo flow ออกแบบให้ปุ่มยิงไป **tenant subdomain** (`acme.gethelpwise.xyz/demo`) เพราะ demo-login + login
ต้องมี tenant context. `src/proxy.ts` resolve tenant จาก `{slug}.NEXT_PUBLIC_ROOT_DOMAIN` บน Host header.

| Option | demo subdomain ใช้ได้? | งาน |
|---|---|---|
| **A — Custom domain + wildcard (แนะนำ)** | ✅ | จด domain → add `gethelpwise.xyz` + `*.gethelpwise.xyz` ที่ Vercel → `NEXT_PUBLIC_ROOT_DOMAIN=gethelpwise.xyz` |
| B — `*.vercel.app` เปล่า | ❌ | Vercel ไม่ให้ wildcard ใต้ `vercel.app` → subdomain demo พัง ต้อง refactor เป็น path-based (นอก scope) |

➡️ **เลือก Option A** — ทั้งระบบพึ่ง subdomain; vercel.app เปล่า demo ไม่ได้

> ⚠️ **Wildcard cert gotcha:** Vercel ออก wildcard SSL (`*.gethelpwise.xyz`) อัตโนมัติได้ก็ต่อเมื่อทำ
> DNS-01 challenge ได้ → **ชี้ nameservers ของ domain มาที่ Vercel** (ใช้ Vercel DNS).
> ถ้าคง external DNS + แค่ CNAME wildcard → cert wildcard มักไม่ออกอัตโนมัติ.

---

## 1. Provision external services (ทำก่อน เพราะต้องเอา URL/secret ไปใส่ env)

- [ ] **Supabase** — project + connection strings (pooled + direct) + สร้าง **private storage bucket** สำหรับไฟล์แนบ
- [ ] **Upstash Redis** — tenant cache + AI rate-limit (fail-closed)
- [ ] **Upstash QStash** — token + signing keys (outbound email + sla-sweep)
- [ ] **Stripe** — account + (ภายหลัง) webhook endpoint
- [ ] **Email provider** (Postmark/SendGrid) — API key + verified sender
- [ ] **Anthropic** — API key เฉพาะ demo + **ตั้ง org spend cap (ดู §2)**

---

## 2. Anthropic org spend cap (guardrail — ทำก่อน deploy)

Demo creds เป็น **public-by-design** (role=AGENT) → ใครก็ยิง AI endpoint ได้.
มี Redis rate-limit fail-closed แต่ควรมี hard cap เป็น backstop:

- [ ] Console → **Settings → Limits / Billing** → ตั้ง **monthly spend limit** (แนะนำ **$5–20/เดือน**)
- [ ] ตั้ง email alert ที่ ~50%/80%
- [ ] ใช้ **API key แยกเฉพาะ demo** (revoke/monitor ง่าย)

---

## 3. Vercel Environment Variables (scope: Production)

### Landing / Demo (ห้ามลืม — fallback เป็น `"#"` = ปุ่มตาย)
- [ ] `NEXT_PUBLIC_DEMO_URL` = `https://acme.gethelpwise.xyz/demo`
- [ ] `NEXT_PUBLIC_SIGNIN_URL` = `https://acme.gethelpwise.xyz/login`
- [ ] `NEXT_PUBLIC_ROOT_DOMAIN` = `gethelpwise.xyz` *(หัวใจ subdomain routing — ต้องตรง domain จริง)*
- [ ] `NEXT_PUBLIC_API_BASE_URL` = `https://{slug}.gethelpwise.xyz`

### Realtime presence (Supabase — ห้ามลืม: พลาดแล้ว feature ตายเงียบ ไม่มี error ให้เห็น)
- [ ] `NEXT_PUBLIC_SUPABASE_URL` = `https://[ref].supabase.co` *(client env)*
- [ ] `NEXT_PUBLIC_SUPABASE_ANON_KEY` *(client env — anon key เท่านั้น ห้ามใช้ service role key)*
- [ ] `SUPABASE_REALTIME_JWT_PRIVATE_KEY` *(server-only — PEM private key EC P-256 / ES256 จาก Supabase → JWT Signing Keys)*
- [ ] `SUPABASE_REALTIME_JWT_KID` *(server-only — key id ของ signing key ตัวเดียวกัน)*

> 🔴 **บทเรียนจริง (2026-08-04):** 4 ตัวนี้ไม่เคยถูกตั้งบน Vercel Production เพราะ**ไม่เคยอยู่ใน checklist นี้**
> → presence **ตายเงียบบน prod 1 เดือน**: ไม่มี client env = `getRealtimeClient()` คืน `null` แล้วหยุดเงียบ ๆ (fail-soft),
> ไม่มี JWT key = `/api/realtime/token` 500 แต่ client กลืน error → **ไม่มีสัญญาณใดให้เห็นเลย**

> ⚠️ **`NEXT_PUBLIC_*` ทุกตัวเป็น build-time inlined** — ค่าถูกฝังเข้า client bundle ตอน build ไม่ได้อ่านตอน runtime
> → **ตั้ง/แก้ค่าบน Vercel แล้วต้อง redeploy ถึงจะมีผล** (แก้ค่าเฉย ๆ ไม่พอ)
> verify ได้ที่ **artifact เท่านั้น** — `npm run scan:bundle` (สแกน `.next/static` ว่าค่าโผล่จริง)
> ⛔ **ห้ามใช้ readiness/health endpoint ยืนยัน `NEXT_PUBLIC_*`** — endpoint อ่าน `process.env` ฝั่ง server ตอน runtime
> จึงตอบว่า "ตั้งแล้ว" ได้ทั้งที่ bundle ที่ deploy อยู่ยังไม่มีค่า = **false PASS**

### Core (build/runtime)
- [ ] `DATABASE_URL` — pooled (pgbouncer)
- [ ] `DIRECT_URL` — direct (สำหรับ migrate)
- [ ] `AUTH_SECRET` — **generate ใหม่** (`openssl rand -base64 48`, ≥32 ตัว)
- [ ] `REDIS_URL` — Upstash
- [ ] `RLS_ENABLED` = **`false`** *(เปิด `true` เฉพาะหลัง apply migration FORCE RLS เท่านั้น)*

### AI
- [ ] `ANTHROPIC_API_KEY` *(ตั้ง spend cap ก่อน — §2)*

### Queue (QStash)
- [ ] `QSTASH_TOKEN`
- [ ] 🔴 **`QSTASH_URL`** — **บังคับถ้าบัญชี Upstash อยู่ region `us-east-1`** = `https://qstash-us-east-1.upstash.io`
      · SDK **default ไปที่ EU** (`https://qstash.upstash.io`) เมื่อไม่ตั้งตัวแปรนี้ → publish ถูกปฏิเสธ `404`
        `user (...) not found in this region (eu-central-1)` **แบบเงียบ** (fail-soft ทั้ง webhooks และ outbound email)
      · ตรวจว่าตั้งถูกไหมด้วย `GET {QSTASH_URL}/v2/schedules` + `Authorization: Bearer $QSTASH_TOKEN` → ต้องได้ `200`
      · ⛔ **ห้ามใช้ `QSTASH_REGION`** (migration mode) — SDK จะสลับไปอ่านตัวแปร prefix `US_EAST_1_QSTASH_*` ทั้งชุด
        และ **override token ที่โค้ดส่งเข้า `new Client({token})` ทิ้ง** → ตั้งครึ่ง ๆ พังหนักกว่าเดิม
      · ตั้งทั้ง **Production และ Preview** — ตั้งแค่ Production = ซ่อนบั๊กเดิมไว้ที่ Preview
      · 📌 บทเรียน 2026-08-05: ตัวแปรนี้ **ไม่เคยอยู่ในเช็คลิสต์** → ไม่มีใครรู้ว่าต้องมี → webhooks/outbound email/
        SLA sweep ตายเงียบ ~1.5 เดือน ทั้งที่ env ทุกตัวที่รู้จัก "มีค่าครบและถูกต้อง"
- [ ] `QSTASH_CURRENT_SIGNING_KEY` + `QSTASH_NEXT_SIGNING_KEY` *(ต้องเป็นของบัญชี/region เดียวกับ `QSTASH_TOKEN` — ดึงค่าที่ถูกได้จาก `GET {QSTASH_URL}/v2/keys`)*
- [ ] `QSTASH_TARGET_BASE_URL` = `https://acme.gethelpwise.xyz` *(URL จริง ไม่ใช่ `{slug}` template)*

### Stripe / Email / Storage
- [ ] `STRIPE_SECRET_KEY` (`sk_live_...`)
- [ ] `STRIPE_WEBHOOK_SECRET` *(ได้หลังสร้าง endpoint — §7)*
- [ ] `EMAIL_PROVIDER` + `EMAIL_PROVIDER_API_KEY` + `EMAIL_FROM_ADDRESS` + `EMAIL_INBOUND_WEBHOOK_SECRET`
- [ ] `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + `SUPABASE_STORAGE_BUCKET`

> ❌ **อย่า set `SLA_SWEEP_SECRET`** — deprecated (sla-sweep verify ด้วย QStash signature แล้ว)
> 🔐 secrets ทุกตัว: generate ใหม่สำหรับ prod อย่า reuse จาก dev

---

## 4. Database migrations (กับ prod DB ผ่าน `DIRECT_URL`)

- [ ] `npx prisma migrate deploy` — มี migration Phase 28 ค้าง:
      `20260619000000_add_notification`, `20260619010000_add_sla_notification`

---

## 5. Seed demo data (acme / globex)

> ⚠️ ลำดับ 3 step — `seed-demo.ts` ต้องมี Plan `"pro"` อยู่ก่อน ไม่งั้น fail.
> รัน `prisma db seed` **คั่นกลาง** ระหว่าง migrate กับ demo seed เสมอ

```bash
npx prisma migrate deploy   # §4 — apply schema
npx prisma db seed          # seed Plans + FeatureFlags (prerequisite ของ demo)
npx tsx prisma/seed-demo.ts # demo data acme/globex (idempotent)
```

- [ ] verify acme = 7 demo ticket, ไม่มี dev/smoke junk

---

## 6. Push → Vercel build

- [ ] `git push` (commit ค้าง: login redirect fix + env/docs)
- [ ] Vercel auto-build — **CI gate ต้องเขียว** (lint + tsc + test + build)
- [ ] ถ้า build พังด้วยไฟล์ iCloud stray (`* 2.ts`) → ลบทีละไฟล์ก่อน push

---

## 7. Webhooks (ทำหลัง deploy ได้ prod URL แล้ว)

- [ ] **Stripe** — สร้าง webhook endpoint `https://.../api/webhooks/stripe/` → เอา signing secret ใส่ `STRIPE_WEBHOOK_SECRET` → redeploy
- [ ] **Inbound email** — ตั้ง webhook URL `https://{slug}.gethelpwise.xyz/api/webhooks/email/` ที่ provider
- [ ] **QStash schedule** — สร้าง cron `*/15 * * * *` · `POST` · ยิง `https://acme.gethelpwise.xyz/api/jobs/sla-sweep`
      · body เว้นว่าง · **ไม่ต้องใส่ header ใด ๆ** (QStash เซ็นให้เอง)
      · ⚠️ URL ต้องตรงเป๊ะกับ `QSTASH_TARGET_BASE_URL` + path — route pin URL ตอน verify signature → ผิดแม้ trailing slash = `401` ทุกครั้ง
      · cadence เลือก `*/15` (96 msg/วัน) ไม่ใช่ `*/5` (288) เพราะ Free plan = **1,000 msg/วัน และ retry นับด้วย** — ดู `docs/operations.md` § SLA Sweep Cron
      · **verify หลังสร้าง:** `GET {QSTASH_URL}/v2/events` ต้องเห็น `DELIVERED → /api/jobs/sla-sweep` ตามรอบ (log retention 3 วัน)

---

## 8. Verify production

- [ ] **`SCAN_BUNDLE_SKIP_REQUIRED` ไม่ถูกตั้งค้างบน Vercel (Production)** — ถ้ามี = bypass ค้างจากเหตุการณ์ก่อน ต้องถอดแล้ว redeploy (build log ต้องเห็น `✅ [scan:bundle] สะอาด …` ที่มีข้อความยืนยันจำนวนค่า ไม่ใช่ `GATE OVERRIDDEN`)
- [ ] `acme.gethelpwise.xyz` resolve + cert (apex + wildcard) Active
- [ ] ปุ่ม "Try live demo" → `/demo` → auto-login → **`/dashboard`**
- [ ] login ปกติ → **`/dashboard`**
- [ ] AI endpoint ทำงาน; Redis down → fail-closed (deny)
- [ ] Stripe test event → 200 + idempotent

---

## Notes

- **RLS_ENABLED** คง `false` ตอน deploy แรก — เปิดเฉพาะตอน activate RLS พร้อม migrate FORCE RLS (memory `rls-hardening-phase27`)
- งานทั้งหมด manual โดย Dev — Claudy/subagent แตะแค่ source control + code
