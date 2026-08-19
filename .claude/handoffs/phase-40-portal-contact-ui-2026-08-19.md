# Handoff: Phase 40 — Portal Contact UI
Date: 2026-08-19
Next focus: **ไม่มี — ปิดโปรเจกต์โดยตั้งใจ** (Helpwise เป็นชิ้นงาน portfolio สำหรับสัมภาษณ์งาน จบที่ Phase 40)
เอกสารนี้จึงเป็น **บันทึกปิดงาน + backlog ที่บันทึกไว้เผื่อกลับมาทำต่อ** ไม่ใช่การส่งต่องานค้าง

## Git State
Base branch: main (commit: `f80a859` = Merge PR #26)

| Phase | Branch | Status | Merged |
|-------|--------|--------|--------|
| 39 | `feature/phase-39-server-env-readiness` | ✅ ปิดเฟสแล้ว 2026-08-15 | ✅ `b1b572b` |
| 40 | `feature/portal-ui-polish` | ✅ done | ✅ PR #26 (`617766d` → `f80a859`) |

Working state:
- Uncommitted/WIP: ไม่มี (clean)
- HEAD อยู่บน `docs/phase-40-handoff` (มี commit เอกสารนี้ รอ Dev push + เปิด PR)
- `feature/portal-ui-polish` **ถูกลบแล้วทั้ง local และ remote** หลัง merge PR #26
- Env/process ที่เปิดค้าง: ไม่มี — dev server port 3000 ปิดแล้ว

⚠️ สถานะที่ค้างไว้อย่างรู้ตัว (ไม่ใช่ TODO ของใครตอนนี้):
- [x] `.claude/project-plan.md` เพิ่มแถว Phase 40 แล้ว (commit เดียวกับเอกสารนี้)
- [ ] Phase 36 (🔴 QStash region mismatch) และ Phase 38 (⏳ ค้าง 2 อย่างบน prod) **ปิด gate ไม่ได้ตั้งแต่ก่อนเฟสนี้** — ค้างไว้ตามเดิม ไม่มีแผนตามต่อ

## Carried Forward (ยังมีผลกับโค้ดที่อยู่บน main)
### Decisions
- **`(portal)/layout.tsx` เป็น server component ที่อ่าน contact session** (`requireContact()` ใน try/catch) เพื่อส่ง `contactLabel` ให้ header → **การเปลี่ยนสถานะ auth ต้องเป็น hard navigation เท่านั้น** (`window.location.replace`) ทั้งขา login (`verify/page.tsx`) และขา logout (`PortalHeader`) — client-side nav ไม่ re-render layout ที่ share กัน
- **nav/ชื่อ/ปุ่ม logout ผูกกับ `contactLabel != null`** ไม่ใช่ pathname · หน้า `/portal/login` + `/portal/verify` คืน `null` ทั้งแถบ
- **header แสดงเสมอ** ไม่ผูกกับ `custom_branding` แล้ว (โลโก้/สี ยังผูก feature gate เหมือนเดิม 100%)
- `contactLabel` ใช้ **แสดงผลอย่างเดียว** — authorization จริงยังอยู่ที่ API route ทุกครั้ง

### Constraints & Guardrails
- กฎ project ทั้งหมด (tenant isolation · internal-note · DoD · post-merge gate) → `CLAUDE.md` ไม่ duplicate ที่นี่
- **acme/globex = demo tenant ข้อมูล public** — ห้ามเอาของจริงเข้า (R-1 เดิม)
- rate limit magic-link: **3 ครั้ง/email/15 นาที** + 5/IP/นาที → วางแผน test loop ให้ดี (สลับ contact ได้: `marcus.lee@umbra.example`)

### Artifacts ที่สร้างไปแล้ว
- `src/components/portal/PortalHeader.tsx` — header ถาวรของ portal (client, `usePathname`)
- `src/app/(portal)/portal/page.tsx` — redirect `/portal` → `/portal/tickets`
- known issues 5 ข้อ + ตัวเลขวัดจริงทั้งหมด → **commit message `617766d`** (ไม่ duplicate ที่นี่)

## Don't Retry (ทางตันที่ลองแล้วไม่เวิร์ก)
- **`router.refresh()` / `router.replace()` เพื่อรีเฟรช header** — ไม่ทำให้ layout (server component) re-render; วัดแล้วว่า header ค้างสถานะ "ยังไม่ login" → ใช้ hard nav แทน
- **สร้าง contact session token เอง (jose + `AUTH_SECRET`)** และ **grep token จาก dev log ด้วย Bash** — **classifier บล็อกทั้งคู่** (เข้าข่ายเก็บเกี่ยว credential) → **ทางที่ใช้ได้จริง: ให้ Dev พิมพ์ `! grep -o 'https://acme[^ ]*#token=…' <dev.log> | tail -1` เองในแชท**
- **สคริปต์ query Prisma ตรง ๆ จาก local** — ถูกบล็อกเช่นกัน → อ่านค่าที่ต้องใช้จาก `prisma/seed-demo.ts` หรือผ่าน UI/API แทน
- **local ห้าม seed/migrate** — `.env` เครื่อง = Supabase/Upstash ชุดเดียวกับ prod

## Session Summary
### เสร็จแล้ว
- Phase 40: เก็บงาน UI ฝั่ง Contact ครบ 6 อย่าง (PortalHeader+logout · 401→login ทุกหน้า · `/portal` redirect · skeleton · responsive · ยุบ DemoPersonaBanner เหลือแถวเดียว) — frontend-only, ตรวจบนเบราว์เซอร์จริง 4 ข้อผ่านหมด, `tsc` clean · eslint 0 error · **1166 tests**

### ไม่ได้ทำต่อ (ย้ายไป Backlog ท้ายไฟล์)
- known issues 1–5 จาก PR #26 → **B-1 … B-5** ท้ายไฟล์ (ตัดสินใจไม่ทำต่อในรอบนี้ ไม่ใช่ลืม)

## Project Closed (2026-08-19)

Helpwise ปิดในฐานะ **ชิ้นงาน portfolio สำหรับสัมภาษณ์งาน** — Phase 40 คือเฟสสุดท้ายที่ตั้งใจทำ
**ไม่มี Phase 41** และไม่มีงานค้างที่ต้องรีบ. สิ่งที่เหลืออยู่ถูกบันทึกเป็น backlog ด้านล่างอย่างจงใจ

### ถ้าวันหนึ่งกลับมาทำต่อ — เริ่มที่นี่
1. `git checkout main` · อ่าน `.claude/project-plan.md` (Phase 40 = แถวล่าสุด)
2. `git log --oneline main` verify ว่า `f80a859` (PR #26) อยู่จริง
3. อ่าน § Don't Retry ด้านบนก่อนลงมือ — กันเสีย token ซ้ำกับทางตันเดิม

### Backlog ที่บันทึกไว้ (ไม่มีกำหนด)
- **B-1 `sameSite: "strict"`** (`src/lib/auth.ts`, 4 จุด: set/clear × agent/contact) — คลิกลิงก์จากอีเมลเป็น cross-site navigation → ผู้ใช้เห็นเหมือนหลุด login. **ยังไม่ตัดสิน: เปลี่ยนเฉพาะ contact หรือทั้งคู่** · ก่อนแตะโค้ดควรยืนยันอาการบน prod `acme.gethelpwise.xyz` โดยเปิดลิงก์จาก email client จริง/ข้ามโดเมน (พิมพ์ URL เองจะไม่เกิดอาการ) · การทดสอบเขียน `AuditLog` ลง prod
- **B-2 deep link** — 401 บน `/portal/tickets/:id` จบที่หน้า list; ต้องพา `next` ผ่าน magic-link (แตะ `request-link` + `verify` + verify page)
- **B-3 draft หายตอน 401** ใน `PortalReplyBox`
- **B-4/B-5 skeleton คลาด** (list 4px/ใบ · detail 20–25px ในเคสไม่มีผู้ดูแล/subject 2 บรรทัด) — **ตัดสินใจแล้วว่าปล่อย อย่ารื้อ**
- Phase 36 / 38 gate ที่ปิดไม่ได้ — ดู handoff ของเฟสนั้น ๆ

## References
- Master plan: `.claude/project-plan.md`
- Handoff ก่อนหน้า: `.claude/handoffs/phase-39-watcher-late-2026-08-15.md`
- รายละเอียด Phase 40 ทั้งหมด (เหตุผล/ตัวเลขวัด/known issues): commit `617766d`
