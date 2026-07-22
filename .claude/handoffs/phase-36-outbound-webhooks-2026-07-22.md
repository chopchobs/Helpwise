# Handoff: Phase 36 — Outbound Webhooks (Portfolio #2)
Date: 2026-07-22
Next focus: **รัน security gate ให้จบ** (ยังไม่เคยรันสำเร็จ) → merge เข้า main → Dev push + apply migration

## Git State
Base branch: main (HEAD: `5990232`)
Phase 36 ทำบน `feature/phase-36-outbound-webhooks` — **13 commits ยังไม่ merge**

| Phase | Branch | Status | Merged |
|-------|--------|--------|--------|
| 36 | feature/phase-36-outbound-webhooks | 🔄 รอ security gate (qa PASS-with-conditions, เงื่อนไขปิดครบแล้ว) | ❌ |

Commits: `41a6df6` schema+migration · `73c1598` core lib · `b5e1ff0` producer+worker · `18f47ee` feature gate+hooks · `4877e18` contract path · `2772813` management API · `f92a4c2` settings UI · `895262b` docs+drift fix · `7827728` portal dispatch · `1ff3703` trailing-dot SSRF fix · `85a0327` await+qa conditions · `babb43c` parallel fan-out · `9f9a7eb` plan

Working state:
- Uncommitted: `NATTAPON_Resume_TH.docx` (ไฟล์ส่วนตัว **อย่า commit**)
- **ยังไม่ push** (hook block `git push` ให้ Claudy — Dev รัน `!git push origin feature/phase-36-outbound-webhooks` เอง)
- Verified ล่าสุด: **825 tests pass** · `tsc --noEmit` 0 error · `eslint` clean · `npm run build` สำเร็จ

⚠️ ต้อง verify ก่อนเริ่ม context ถัดไป:
- [ ] `git log --oneline main..HEAD` — คาดเห็น 13 commit
- [ ] `npx vitest run` — คาด 825 pass
- [ ] `npx prisma migrate status` — คาดเห็น migration ค้าง 3 ตัว (ดู ⚠️ ด้านล่าง)

## Carried Forward
### Decisions
- **Path แยกสองต้นไม้**: `/api/webhook-endpoints` + `/api/webhook-deliveries` = outbound management (agent OWNER/ADMIN) · `/api/webhooks/{stripe,email}` = **inbound ของเดิม**. อย่าเอา `[id]` ไปใส่ใน `api/webhooks/`
- **`await dispatchWebhookEvent` ทุก call site — ห้ามกลับไป `void`**: บน serverless งานที่ไม่ถูก await ก่อน return response โดนตัดกลางคัน → delivery row ไม่เกิด / job ไม่ publish **โดยไม่มี log** (dispatcher swallow error) = event หายเงียบ. dispatcher ไม่ throw จึงทำ request พังไม่ได้
- **Feature gate อยู่ใน dispatcher จุดเดียว** (`hasFeature(tenantId,"webhooks")`) ไม่ใช่ที่ call site
- **Replay รับทุก status ที่ยังไม่ `SUCCEEDED`** (ไม่ใช่แค่ `DEAD`) — ปิดเคส delivery ค้าง `PENDING` เพราะ publish ล้ม
- **`WebhookEndpoint.secret` = plaintext ใน DB โดยจำเป็น** (ต้องใช้ HMAC sign) — กันด้วยการไม่ให้อยู่ใน select/DTO/audit/log/response แทน encryption-at-rest
- **Portal เป็น trigger point ด้วย** (เพิ่มทีหลัง — contract รอบแรกตกไป) ลูกค้าเปิด ticket/ตอบผ่าน portal ต้องยิง event; guard `requireContact()` + own-record scope ไม่ถูกแตะ

### Constraints & Guardrails
- **SSRF ต้อง 2 ชั้นเสมอ**: `validateWebhookUrl()` static ตอน create/update **และ** `assertSafeDestination()` (resolve DNS → เช็ค IP) **ทุก attempt ตอนส่ง** กัน DNS rebinding
- `normalizeHostname` ตัด trailing dot (`\.+$`) — **อย่าถอดออก** (ไม่งั้น `localhost.` / `metadata.google.internal.` หลุด deny-list ชั้นแรก)
- `fetch` ต้อง `redirect: "manual"` (3xx = ล้มเหลว) + timeout 10s
- Internal-note isolation **4 ชั้น**: call-site gate → dispatcher guard → `buildMessageEventPayload` throw → worker re-check จาก payload จริง. **อย่าถอดชั้นใดออก**
- Contract = source of truth: `docs/webhooks-contract.md`

### Artifacts
- schema: `prisma/schema.prisma` (`WebhookEndpoint`/`WebhookDelivery` + composite FK `[tenantId, endpointId]`), migration `20260722000000` + `20260722010000`
- lib: `src/lib/webhooks.ts` · `src/lib/webhook-dispatch.ts` · `src/lib/queue.ts` (ส่วนท้าย) · `src/types/webhook.ts`
- worker: `src/app/api/jobs/webhook-deliver/route.ts`
- API: `src/app/api/webhook-endpoints/**` · `src/app/api/webhook-deliveries/**`
- UI: `src/app/(agent)/(workspace)/settings/webhooks/page.tsx` · `src/components/ui/WebhookDeliveryBadge.tsx`
- docs: `docs/webhooks-contract.md` (internal) · `docs/webhooks.md` (receiver-facing)
- tests: `webhooks.test.ts` · `webhook-dispatch.test.ts` · `webhook-deliver.test.ts` · `webhook-endpoints.test.ts` · `webhook-deliveries.test.ts` · `webhook-triggers.test.ts` · `webhook-inbound-triggers.test.ts`

## Don't Retry
- **`/api/webhooks/[id]` เป็น path ของ outbound** — ชนกับ inbound stripe/email ที่มีอยู่ (ตัดสินไปแล้ว ใช้ `/api/webhook-endpoints`)
- **`void dispatchWebhookEvent`** — เปลี่ยนเป็น await แล้วด้วยเหตุผล serverless อย่ากลับไป
- **สร้าง in-memory Prisma engine ใหม่สำหรับเทส** — ของเดิมอยู่ที่ `src/lib/__tests__/isolation/_engine.ts` (Phase 34)
- **SSRF bypass vector ที่ทดสอบแล้ว 26 ตัว → 0 bypass** (octal/decimal/hex/short-form/userinfo/fragment/IPv4-mapped/trailing-dot/private/CGNAT/ULA/link-local/http-on-prod/non-443) ไม่ต้องรันซ้ำ — สคริปต์อยู่ที่ scratchpad `ssrf-audit.ts` / `ssrf-edge.ts`

## Session Summary
### เสร็จแล้ว
- Portfolio #2 ครบทุก slice: schema+migration · core lib (HMAC + SSRF) · producer+worker (QStash retry/DLQ) · feature gate + hook 8 call site · management API + DLQ replay · settings UI · receiver docs
- `qa-testing` verdict **PASS-WITH-CONDITIONS** — DoD 8/8 ผ่าน, ไม่พบ Critical/High. เงื่อนไข blocking 3 ข้อ (G1 inbound-email test · G2 v1 test · F1 await) **ปิดครบแล้ว**

### ⚠️ ค้างอยู่ — ต้องทำก่อน merge
- [ ] **`security` audit ยังไม่เคยรันจบ** — subagent ล้ม 4 ครั้ง (API transport error ×3 + session limit ×1)
  - ที่ Claudy verify เองแล้ว: SSRF bypass matrix (0 bypass) · secret ไม่หลุด select/DTO/audit/response · **ไม่มี `dangerouslySetInnerHTML`** ในไฟล์ใหม่ · UI render แค่ `responseStatus` (ตัวเลข)
  - **ที่ยังไม่มีใครตรวจ**: portal audience หลังเพิ่ม dispatch · cross-tenant ที่ระดับ worker · rate-limit/DoS ของ management API · audit snapshot มี PII เกินจำเป็นไหม
- [ ] **Dev push branch** → `!git push origin feature/phase-36-outbound-webhooks` (blocked สำหรับ Claudy)
- [ ] **apply migration** — `prisma migrate status` มีค้าง **3 ตัว**: `20260721000000_realtime_presence_rls` (Phase 35 — น่าจะ apply ด้วยมือผ่าน SQL editor จึงไม่ถูกบันทึกใน `_prisma_migrations`; ใครรัน `migrate deploy` จะได้ตัวนี้พ่วง แต่ idempotent) + `20260722000000` + `20260722010000` ของ Phase 36
- [ ] **เปิด FeatureFlag `webhooks`** ให้ tenant ที่ต้องการ (default `false`, `requiredPlan: pro`)

### Dev ตัดสินแล้ว (ปิดแล้ว — อย่ายกกลับมาถามซ้ำ)
- ✅ **encryption-at-rest ของ `WebhookEndpoint.secret` = DEFERRED (backlog) ไม่ใช่ blocker ก่อน merge**
  เหตุผล: secret ต้องอยู่ในรูปที่ถอดกลับได้เพื่อ HMAC sign ทุก delivery (ต่างจาก API key ที่ hash ทางเดียวพอ) ·
  ผู้ให้บริการเทียบเคียง (Stripe, Svix) เก็บ signing secret แบบเดียวกัน · ชั้นป้องกันปัจจุบันคือ **ไม่ให้ secret
  อยู่ใน select/DTO/audit/log/response เลย** (verify แล้ว) → ความเสี่ยงที่เหลือคือผู้ที่อ่าน DB ได้โดยตรง
  ซึ่งถ้าถึงขั้นนั้นก็เข้าถึงข้อมูล tenant อื่นได้อยู่แล้ว ไม่ได้แย่ลงเพราะฟีเจอร์นี้
- ✅ **แปล `docs/webhooks.md` เป็นอังกฤษ = next action ข้อแรกของ session หน้า** (ให้เข้าชุดกับ `docs/api.md`)
  เป็น **งานเต็มก้อน 577 บรรทัด** — ตั้งใจให้เป็นงานหลักตอนเปิด context ใหม่ **ไม่ใช่งานปิดท้าย session**
  ⚠️ ตอนแปลต้องคง parity ของโค้ดตัวอย่าง verify signature กับ `verifyWebhookSignature` ใน `src/lib/webhooks.ts`
  (ของเดิม verify มาแล้ว 17 case) และคงคำเตือน "rotate-secret ไม่มี grace period" ไว้

### Open Questions ที่ยังเหลือ
- **rotate-secret ไม่มี grace period** — delivery ที่ retry ค้างจะถูกเซ็นด้วย secret ใหม่ทันที receiver ที่ยังไม่อัปเดตจะ verify ไม่ผ่าน (เขียนเตือนไว้ใน docs แล้ว — จะทำ dual-secret window ไหม ยังไม่ตัดสิน)

### Backlog ที่ระบุไว้แล้ว (non-blocking)
- **ถอด `responseBody` ออกจาก select/DTO ของ `GET /api/webhook-deliveries`** — API คืนมาแต่ **UI ไม่ได้ใช้เลย** ลดพื้นที่โจมตีได้ฟรี (`src/app/api/webhook-deliveries/route.ts:53,84` + `src/types/webhook.ts:131`)
- qa gap G3–G10: e2e ต่อครบเส้น (producer→payload ที่ persist→worker→body ที่ยิงจริง) · cross-tenant ที่พิสูจน์จาก store จริงไม่ใช่ mock-returns-null · lifecycle เต็ม PENDING→FAILED×4→DEAD→replay→SUCCEEDED · test ของ `publishWebhookDeliveryJob` (`retries: 4`) · signature round-trip กับ unicode ไทย/emoji · eventId ต่างกันจริงเมื่อ PATCH หลายฟิลด์
- worker branch `internal_note_blocked` ไม่ตั้ง `attemptCount`/`lastAttemptAt` (cosmetic ใน DLQ UI)
- `replay` ไม่ล้าง `lastAttemptAt` (cosmetic)
- concurrency cap ของ fan-out (tenant ที่มี endpoint สิบขึ้นจะเปิด connection เป็น burst)
- retention/partition ของ `WebhookDelivery` (โตตามปริมาณ event)

## Next Session
### เริ่มต้นด้วย
1. อ่าน `.claude/project-plan.md` + handoff นี้
2. `git log --oneline main..HEAD` + `npx vitest run` verify state (คาด 15 commit / 825 pass)
3. **งานหลักข้อแรก: แปล `docs/webhooks.md` เป็นอังกฤษ** (Dev สั่งไว้ — งานเต็มก้อน 577 บรรทัด, เจ้าภาพ `docs-writer`)
4. **รัน `security` gate ให้จบ** — ใช้ scope แบบ read-only ไม่ให้เขียนไฟล์/รันสคริปต์ (รูปแบบนี้ทำให้ `qa-testing` ที่ล้มซ้ำ ๆ ทำงานจบได้)
5. ปิด finding ที่ security เจอ → merge → Dev push + apply migration

### Phase ถัดไป
- หลัง merge Phase 36 → Portfolio item ถัดไป (ยังไม่เลือก — #1 fuzz suite และ #2 webhooks, #3 realtime ทำไปแล้ว)

## References
- Master plan: `.claude/project-plan.md`
- Contract: `docs/webhooks-contract.md` · Receiver guide: `docs/webhooks.md`
- Handoff ก่อนหน้า: `.claude/handoffs/phase-35-realtime-presence-2026-07-22.md`
- Memory: `[[outbound-webhooks-phase36]]`, `[[phase28-deferred-hardening]]` (QStash pattern), `[[tenantprisma-nested-write-gap]]` (composite FK)
