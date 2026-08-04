# Handoff: Phase 37 — Demo personas (visitor-facing multi-agent presence)
Date: 2026-08-03
Next focus: **helpwise-phase37-push-and-gate2** — merge เข้า main แล้ว · **ยังไม่ push** · **Gate 2 (smoke) ยังไม่รัน**

> 🎯 **ทำไมมีเฟสนี้:** Phase 35 มี real-time presence/collision แต่ **ไม่มีใครในโลกเห็นได้ในเดโม่** เพราะ demo มี account เดียว
> เฟสนี้เพิ่ม "agent คนที่ 2" ให้ visitor เปิด 2 เบราว์เซอร์แล้วเห็น collision เอง — ไม่ต้องเชื่อคำอธิบาย

## Git State

**สถานะ ณ 2026-08-03 (verified จาก git จริง ไม่ใช่จากคำบอกเล่า):**
- ✅ **merge แล้ว** — `main` = **`68ad2e1`** (merge commit `--no-ff`, 25 files `+3078/-179`)
- ❌ **ยังไม่ push** — `main...origin/main [ahead 17]` (Dev ทำเอง)
- ❌ **Gate 2 (smoke กอง C + B-7) ยังไม่รัน**
- working tree clean · branch `feature/phase-37-demo-personas` merge เข้า main แล้ว (ลบได้ถ้าต้องการ)
- 🆕 `30ac63a` — **`docs/phase-37-decision-log.md`** (Dev เขียนเอง, 304 บรรทัด, บันทึกการตัดสินใจ 11 บท) = บันทึก **เหตุผล** ของเฟส คู่กับไฟล์นี้ที่เป็น **สถานะ/ปฏิบัติการ**

| Phase | Branch | Status | Merged |
|-------|--------|--------|--------|
| 37 | `feature/phase-37-demo-personas` | ✅ done (security PASS · qa PASS-with-conditions · L-1/L-2 ปิดแล้ว) · ⏳ Gate 2 ยังไม่รัน | ✅ `68ad2e1` — **ยังไม่ push** |

Commit บน branch (เก่า→ใหม่):
```
07ef5c4 docs(spec)  phase 37 slice 2 contract
795fb56 feat(demo)  persona branch — login เป็น agent คนที่ 2 โดยไม่ใช้ password   ← slice 1
cfca965 docs(spec)  § F resolved — demoPersona มาจาก /me
230af13 feat(auth)  /me คืน demoPersona — จำแนก persona ฝั่ง server                ← slice 1b
96d1226 docs(spec)  อุด 5 ช่องโหว่ของ spec
03f00c5 feat(demo)  banner + cookie clobber guard                                  ← slice 2
7949790 docs(spec)  § G บทเรียน
431f17f fix(demo)   auto-login เงียบเมื่อ persona ที่ขอ = persona ของ session
d4b1fd3 test(demo)  qa gate +114 tests + manual checklist
6dee7e3 fix(demo)   /demo ผูก persona กับ tenant ปัจจุบัน (L-1/BUG-37-1)
2380b4b ci          scan client bundle หา server-only secret หลัง build (L-2)
```

**Verified (orchestrator รันเอง ไม่ใช่เชื่อ agent):**
- `npx vitest run` → **1012 passed / 54 files** (baseline main = 846 → **+166**)
- `npx tsc --noEmit` → 0 error (นอก `.next/types/*` ที่เป็น iCloud stray duplicate)
- `npx eslint` ไฟล์ที่แก้ → 0 error · `npx next build` สำเร็จ
- `npm run scan:bundle` → สะอาด (51 ไฟล์ / 5 ค่าต้องห้าม) **และพิสูจน์แล้วว่าจับได้จริง** (ดู § L-2)
- L-1 fix: รัน test ใหม่กับโค้ดเก่า → **fail 7 เคส**, กับโค้ดใหม่ → **pass 23** (พิสูจน์ว่า test จับบั๊กจริง)

⚠️ ต้อง verify ก่อนเริ่ม context ถัดไป:
- [ ] `git rev-list --count origin/main..main` → ตอนเขียน handoff = **17** · ถ้าได้ **0** = push แล้ว
- [ ] `git log --oneline -1 main` → ควรเป็น `68ad2e1` หรือใหม่กว่า
- [ ] **Gate 2 รันหรือยัง** (ดู § แผนเดินต่อ ข้อ 3) — **ยังไม่รัน ณ ตอนเขียน**

## สิ่งที่เฟสนี้ทำ

| Slice | ได้อะไร | ไฟล์หลัก |
|---|---|---|
| 1 | persona ที่ 2 login ได้โดย**ไม่ใช้ password** — `POST /api/auth/demo/login` body `{ persona?: "primary"\|"secondary" }` (ไม่ส่ง = primary) | `src/lib/demo-personas.ts` (ใหม่, client-safe) · `src/lib/demo.ts` · `demo/login/route.ts` · `prisma/seed-demo.ts` |
| 1b | `GET /api/auth/agent/me` คืน `demoPersona: "primary"\|"secondary"\|null` (จำแนกฝั่ง server) | `agent/me/route.ts` · `src/types/ticket.ts` |
| 2 | banner ชวนเปิด agent คนที่ 2 (copy-link + incognito) ข้าง `PresenceBar` · `/demo` เป็น server component ที่ตัดสิน auto/confirm/redirect · `resolveDemoNext()` กัน open-redirect | `DemoPersonaBanner.tsx` · `demo/page.tsx` + `DemoLoginClient.tsx` · `src/lib/demo-persona-ui.ts` |
| L-1/L-2 | ปิด finding จาก security/qa | `demo/page.tsx` · `scripts/scan-client-bundle.ts` + `ci.yml` |

## Carried Forward

### Decisions (ยังมีผล)
- **persona `secondary` ไม่มี password โดยตั้งใจ** — `DEMO_PASSWORD` public อยู่ใน repo แล้ว password จึงไม่ใช่ด่านจริง. การใส่ hash ของ password สาธารณะให้ agent2 จะทำให้ agent2 login ผ่าน `/api/auth/agent/login` **ปกติ** ได้ด้วย = surface กว้างกว่า. ด่านจริง = demo-slug guard (404) + membership active + `role === "AGENT"` (403)
- **การจำแนกตัวตนอยู่ฝั่ง server เสมอ** — client ไม่เคยเทียบ email เอง (ทางเลือก B). client bundle จึงไม่มีทั้ง password และ email ของ persona
- **`/demo` ยัง auto-login 0 คลิก** — ตัวชวนอยู่ที่ banner ไม่ใช่ chooser 2 ปุ่ม. guard `confirm` โผล่เฉพาะเมื่อ **จะทับ session จริง** (persona ที่ขอ = persona ปัจจุบัน → redirect เงียบ)
- **`next` param: relative + `/tickets/<id>` เท่านั้น** ไม่ผ่าน → `/dashboard` เงียบ · **URL ที่ copy เป็น absolute** โดย `origin` มาจากเบราว์เซอร์เท่านั้น
- **ไม่ติดตั้ง `@testing-library/react`** — logic ที่ทดสอบได้ถูกดึงเป็น pure function แทน; ที่เหลือเป็น manual checklist

### Constraints & Guardrails
- ⛔ client component **ห้าม import `@/lib/demo`** (มี `DEMO_PASSWORD`) — ใช้ `@/lib/demo-personas` · **CI บังคับแล้วผ่าน `npm run scan:bundle`**
- ⛔ `prisma/seed-demo.ts` รันด้วย `tsx` → ไฟล์ที่ seed import **ห้ามมี `@/...` import**
- persona ต้อง resolve ด้วย **`key`/`email` + `tenantSlug` คู่กันเสมอ** ทั้ง 3 จุด (`demo-login:106` · `me:101` · `demo/page.tsx`) — นี่คือ invariant ที่ L-1 เคยหลุด

### 3 บทเรียน (§ G ของ `.claude/specs/phase-37-slice-2-demo-persona-banner.md`)
1. **Trailing-newline bypass ของ `$` ใน JS regex** — `/^\/tickets\/\w+$/.test("/tickets/abc\n")` = **true** → ค่าที่มี newline หลุดไปเป็นปลายทาง redirect ได้. ปิดด้วย `(?![\s\S])` (ดู `TICKET_PATH_PATTERN`). **ใช้กับทุก validator ที่ตรวจ path/URL จาก input** — `frontend` agent จับได้เอง ไม่ได้อยู่ใน spec
2. **พิสูจน์ "ห้ามหลุด client bundle" ที่ระดับ artifact ไม่ใช่ระดับ source** — grep source ว่า "ไม่มี import" พิสูจน์ได้แค่เจตนา bundler เท่านั้นที่บอกความจริง → กลายเป็น `npm run scan:bundle` ใน CI แล้ว
3. **Bug class ซ้ำรอบที่ 2** — Story 1 (`resolveDemoUrl`, ปุ่ม Try live demo เคย hardcode `acme.{ROOT_DOMAIN}` ทุก host → visitor บน globex โดนส่งเข้า workspace acme) กับ `next` param ของเฟสนี้ = *"อย่าประกอบ URL ปลายทางจาก input ที่ client คุมได้"* รอบนี้กันตั้งแต่ออกแบบ

### Findings ที่ปิดแล้วในเฟสนี้
- **L-1 / BUG-37-1** (security + qa เจอโดยอิสระ) — `demo/page.tsx` จำแนก persona ด้วย email อย่างเดียว ไม่ bind tenant → cross-membership ทำให้เข้าเส้น `redirect` ทั้งที่ยังไม่ได้ login เป็น persona ของ tenant นั้น (`?next=/tickets/X` พาไป ticket อีก tenant → 404) **ปิดแล้ว `6dee7e3`** (lookup slug จาก `ctx.tenantId` 1 query บน cold path; lookup ล้มเหลว → `confirm` ปลอดภัยไว้ก่อน)
- **L-2** — ไม่มีอะไรบังคับกฎ server-only นอกจากคอมเมนต์ **ปิดแล้ว `2380b4b`** (Dev เลือก CI bundle-scan แทนติดตั้ง `server-only` เพื่อไม่เพิ่ม dependency)

### ⚠️ Risk ที่ยอมรับไว้ — Dev ต้องรู้
- **R-1 (สำคัญสุด, ต้องจัดการก่อน deploy):** ตอนนี้ **`POST {"persona":"secondary"}` เปล่า ๆ = ได้ session AGENT ทันที** (เดิมยังต้อง "รู้ว่าต้องส่ง password") → blast radius จริง = **ทุกอย่างใน `acme`/`globex` ถือว่า public ทั้งหมด** ต่อกับ memory `seed-demo-idempotency-acme-cruft` (acme เคยมี dev/smoke junk) → **cleanup เป็นเรื่อง exposure ไม่ใช่แค่ความสวยของ demo** และต้องยืนยันว่าไม่มีบัญชีจริง/ข้อมูลจริงของใครอยู่ใน 2 tenant นี้
- **R-2 (pre-existing ทั้ง repo):** `getClientIp()` เชื่อ `x-forwarded-for` ตัวแรก → spoof header = key ใหม่ = rate-limit ไม่จริง. ผลที่นี่ = resource abuse ระดับต่ำ (~3 query/req) ไม่ใช่ privilege issue. ถ้าจะปิดควรปิดระดับ project (หยิบ IP จากท้าย XFF ตามจำนวน trusted proxy)
- **R-3 (pre-existing):** login-CSRF บน `/api/auth/demo/login` — เว็บอื่นสั่ง POST ข้าม site ให้เหยื่อ "กลายเป็น demo agent" ได้ (`sameSite: strict` กันการ**ส่ง** cookie ไม่ได้กันการ**set**). impact ≈ 0 เพราะจำกัดใน demo tenant ที่ public อยู่แล้ว. **ถ้าอนาคตมี endpoint mint session แบบ credential-less เพิ่ม ต้องคิดเรื่อง Origin check**
- **Info:** `seed-demo.ts:690` hash agent2 จาก `${slug}-agent2-${Date.now()}` (entropy จำกัด) — pre-existing บน main ไม่ใช่ regression; ถ้าจะแตะใช้ `crypto.randomUUID()`

## แผนเดินต่อของ Dev (สั่งได้ทันที)

### 1. ~~Merge~~ ✅ เสร็จแล้ว (`68ad2e1`) → เหลือ **push อย่างเดียว**
```
git push origin main          # ahead 17 commit
```
หลัง push ดู CI ต้องเขียวครบ: lint / tsc / test (**1012**) / build / **scan:bundle** (step ใหม่ของเฟสนี้ — ถ้าแดงที่ step นี้แปลว่ามี secret หลุด client bundle)

### 2. Deploy
Vercel auto-deploy จาก `main` — **ไม่มี migration ในเฟสนี้** ไม่ต้องรัน `db:deploy`

### 3. Post-merge gate (2 ข้อ — ปิดเฟสไม่ได้จนกว่าจะผ่าน)

**Gate 1 — prerequisite บน prod (read-only ก่อน ห้าม re-seed มั่ว)**
```sql
-- persona secondary ต้องมีจริง ไม่งั้น login → 503 และทั้งเฟสไม่มีผลใด ๆ บน prod
select u.email, u."isActive", t.slug, m.role, m."isActive" as member_active
from "User" u
join "TenantMember" m on m."userId" = u.id
join "Tenant" t on t.id = m."tenantId"
where u.email in ('alex@acme.helpwise.com','dana@globex.helpwise.com',
                  'demo@acme.helpwise.com','demo@globex.helpwise.com');
-- ต้องได้ 4 แถว · role = AGENT · isActive ทั้ง user และ member = true
```
- ❌ **ถ้าไม่ครบ:** อย่ารัน `seed-demo.ts` ทั้งก้อน — **มีกับระเบิด** `prisma/seed-demo.ts:868-871` hard-set `ticketCounter = 1007 (acme) / 1006 (globex)` (ไม่ใช่ `max()`) ถ้า prod มี ticket เลขเกินนั้น counter จะถอยหลัง → ชน unique `(tenantId, ticketNumber)` → **สร้าง ticket ใหม่ไม่ได้ทั้ง tenant**
  → ใช้ **one-off upsert เฉพาะ User + TenantMember** แทน (qa แนะนำ) หรือถ้าจะ re-seed จริงต้องเช็คก่อน:
  ```sql
  select t.slug, t."ticketCounter", max(k."ticketNumber") as max_ticket
  from "Tenant" t left join "Ticket" k on k."tenantId" = t.id
  where t.slug in ('acme','globex') group by t.slug, t."ticketCounter";
  ```
  แล้ว `update "Tenant" set "ticketCounter" = <max_ticket>` ตามหลัง seed ถ้าเกิน · และ seed ยังทับ `Tenant.settings` (branding) + `Subscription` ด้วย

**Gate 2 — smoke บน prod จริง**
เดิน `.claude/specs/phase-37-manual-checklist.md` (**34 ข้อ / 4 กอง**: P prerequisite 4 · A banner/clipboard/a11y 12 · B entry mode 10 · C flow presence 8)
ขั้นต่ำที่ต้องผ่านก่อนปิดเฟส:
- **กอง C ทั้งหมด** = acceptance จริงของเฟส (primary → copy → incognito → Alex → ticket ใบเดิม → **เห็น presence 2 คน + typing + collision**)
- **B-7 (P0)** — agent จริงเปิด `/demo` ต้องเห็นหน้ายืนยันเสมอ **ห้าม auto-login ทับ session จริง**
- **R-1** — cleanup/ตรวจข้อมูลใน acme+globex ว่าไม่มีของจริงหลงอยู่

## Don't Retry
- **อย่าให้ agent2 ใช้ hash ของ `DEMO_PASSWORD`** — ทำให้ agent2 login ผ่าน `/api/auth/agent/login` ปกติได้ = ขยาย surface โดยไม่ได้แก้อะไร (พิจารณาแล้วปฏิเสธ)
- **อย่าทำ chooser 2 ปุ่มบน `/demo`** — เสีย 0 คลิกของ visitor ทุกคน (พิจารณาแล้วเลือก banner แทน)
- **อย่าส่ง persona list/email ไป client แล้วให้ client เทียบเอง** (ทางเลือก A) — client กลายเป็นผู้ตัดสินตัวตน + drift เงียบเมื่อมีคนแก้ email
- **อย่ารัน `seed-demo.ts` บน prod โดยไม่เช็ค `ticketCounter` ก่อน** (ดู Gate 1)
- **อย่าติดตั้ง `@testing-library/react` เพื่อเทสต์ banner** — ตัดสินใจแล้วว่าใช้ pure function + manual checklist

## Session Summary

### เสร็จแล้ว
- Phase 37 ครบ 4 slice: persona branch (ไม่ใช้ password) · `demoPersona` ฝั่ง server · banner + cookie clobber guard + open-redirect hardening · L-1/L-2 ปิด
- gate: **security PASS** (ไม่มี Critical/High; fuzz `resolveDemoNext` 31 payload คัดมือ + random 300k เคส ไม่มี bypass) · **qa PASS-with-conditions** (+114 tests, manual checklist 34 ข้อ)
- CI ได้ step ใหม่ที่ generalize ได้: `scan:bundle` (ค่าต้องห้ามดึงจาก source of truth ไม่ hardcode ซ้ำ)

### ✅ Gate 1 ผ่านแล้ว (Dev รัน SQL audit เอง 2026-08-03 — read-only)
- **persona ครบ 4 แถว verdict = OK** (`demo@acme` / `alex@acme` / `demo@globex` / `dana@globex` — User + TenantMember role=AGENT, active ทั้งคู่) → **persona `secondary` ใช้งานได้จริงบน prod ไม่ต้อง re-seed**
- **R-1 data audit สะอาด:** contact นอก seed = 0 · ticket นอก seed = 0 · **ApiKey = 0 · WebhookEndpoint = 0 · Attachment = 0** ทั้ง acme และ globex
- **`ticketCounter` ตรง `MAX(ticketNumber)` พอดี** (acme 1007/1007 · globex 1006/1006) → กับระเบิด re-seed ยังไม่ทำงาน แต่กฎในข้อ 6 ของ project-plan ยังมีผลถ้าจะ re-seed ในอนาคต

### ✅ อัปเดต 2026-08-04 — Gate 2 ผ่านครบ + open item เปลี่ยนสถานะ

- **Gate 2 ผ่าน:** B-7 (P0) ✅ · C-1…C-8 ✅ · **C-8c = prod smoke เต็มตัว** (Checkpoint DB + Redis ผ่านทั้งคู่)
  → `.claude/specs/phase-37-gate2-run-sheet.md` · **backlog smoke presence Phase 35 ปิดแล้ว**
- **C-5 รอบแรก FAIL จาก 3 ชั้นซ้อน** (env client · env JWT · 🔴 CSP `connect-src` = บั๊กโค้ดจาก Phase 35,
  แก้แล้ว `fd8cb08`) → ข้อเสนอเชิงระบบ `.claude/specs/post-merge-gate-external-resource-proposal.md`
- **`owner@acme.test` — ใช้เป็น subject ของ B-7 ผ่าน "ทาง A′"**: จำ password ไม่ได้ + ไม่มี password-reset route
  → สร้าง bcrypt hash เอง แล้ว `update passwordHash` ผ่าน Supabase (prod write ที่ไม่ได้วางแผน แต่ไม่เพิ่มแถวใหม่)
  → **standing risk ปิดไปในตัว — Dev คุม credential แล้ว** · ตัวเลือกอื่น (deactivate / ลด role / ถอด membership)
  ยังเปิดอยู่แต่ไม่เร่งด่วน · **ข้อความ "อย่าเพิ่งแตะ" ด้านล่างเป็นบริบทเดิมก่อน 2026-08-04**
- 🔴 **บั๊กใหม่ที่เจอระหว่างเดิน (ยังไม่แก้):** `/portal` 404 หลัง magic-link verify —
  `portal/verify/page.tsx:73-74` push ไป `/portal` ที่ไม่มีอยู่จริง ตั้งแต่ Phase 3 → `project-plan.md` ข้อ 9

### 🟡 Open item (บริบทเดิม ก่อน 2026-08-04) — `owner@acme.test`
`owner@acme.test` เป็น `TenantMember(OWNER, active)` ของ **acme** สร้างเมื่อ 2026-05-31 · Dev grep แล้ว **ไม่มีในโค้ด/seed เลย** = สร้างมือผ่าน signup

- **ไม่ใช่ช่องโหว่:** visitor เข้าไม่ถึง — demo-login บังคับ `role === "AGENT"` (OWNER → 403) และ persona allowlist ไม่มี email นี้ · `demoPersona` ของมัน = `null`
- **แต่เป็น standing risk:** เป็นบัญชี OWNER ที่ยังมีสิทธิ์เต็มใน tenant ที่ตอนนี้ **public โดยสมบูรณ์** (ใครก็ login เป็น AGENT ได้) ถ้า password ของมันอ่อน/รั่ว = ได้สิทธิ์ OWNER ของ acme
- ทางเลือกเมื่อจะตัดสิน: ปล่อยไว้ (ยอมรับ) / ตั้ง `isActive = false` / ลด role เป็น AGENT / ถอด membership ออก — **ทั้งหมดต้องเช็คก่อนว่าไม่มีอะไรผูกกับ member row นี้ (assignee ของ ticket, ผู้เขียน message, AuditLog actor)**
- 💡 ใช้ประโยชน์ได้ก่อนตัดสินใจ: บัญชีนี้คือ **subject ที่เหมาะที่สุดสำหรับ B-7** (agent ที่ `demoPersona = null` บน demo tenant → ต้องเห็นหน้ายืนยันเสมอ ห้าม auto-login ทับ) โดยไม่ต้องมี tenant จริงบน prod

### ค้างอยู่ / Open Questions
- [x] ~~Gate 1~~ **ผ่านแล้ว** · [x] ~~Gate 2 (กอง C + B-7)~~ **ผ่านแล้ว 2026-08-04**
- [x] ~~ตัดสินใจเรื่อง `owner@acme.test`~~ — credential กลับมาอยู่ในมือ Dev แล้ว (ทาง A′)
- [ ] 🔴 **ตัดสินใจ: `/portal` 404 — hotfix แยก (แนะนำ) หรือรวมใน Phase 37** (แก้ 1 บรรทัด)
- [ ] **R-1 cleanup acme/globex** ก่อนเปิดให้คนนอกใช้จริง
- [ ] Backlog เดิมที่ยังค้าง: smoke presence Phase 35 (จะถูกกลืนโดยกอง C ของเฟสนี้พอดี) · เปิด FeatureFlag `webhooks` ให้ tenant · Backlog Phase 36 (LOW) · seed-demo hardening (`ticketCounter` เป็น `max()`, `settings` merge, `--dry-run`)
- **Open Q:** R-2 (XFF spoof → rate-limit ไม่จริง) เป็น pre-existing ระดับ project — จะทำเป็นเฟสของตัวเองไหม

## References
- **Decision log (เหตุผล 11 บท):** `docs/phase-37-decision-log.md` (`30ac63a`)
- Master plan: `.claude/project-plan.md` (§ ⚠️ ค้าง ข้อ 6 = กับระเบิด seed-demo)
- Spec + บทเรียน: `.claude/specs/phase-37-slice-2-demo-persona-banner.md` (§ G)
- Manual checklist: `.claude/specs/phase-37-manual-checklist.md`
- Handoff ก่อนหน้า: `.claude/handoffs/phase-36-outbound-webhooks-merged-2026-07-24.md`
- Memory: `[[seed-demo-idempotency-acme-cruft]]`, `[[real-domain-gethelpwise-xyz]]`, `[[ci-lint-gate]]`
