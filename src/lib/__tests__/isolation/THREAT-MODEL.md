# Tenant-Isolation Threat Model — Fuzz Suite Contract

> Source of truth สำหรับ attack cases: [`threat-model.ts`](./threat-model.ts) (`ATTACK_CASES`).
> เอกสารนี้อธิบาย "ทำไม" แต่ละแกนสำคัญ + map แกน → ไฟล์/layer ที่บังคับใช้.

## กฎสูงสุด (ทุก invariant ต้องจริงโดยไม่พึ่ง RLS)

- **Cross-tenant leak = Critical** — ทุกข้อมูลเป็นของ tenant เดียว (แยกด้วยคอลัมน์ `tenantId`, shared DB + shared schema).
- **Internal-note leak = Critical เท่ากัน** — `TicketMessage.visibility=INTERNAL` ห้ามหลุดฝั่ง portal/v1 API.
- ⚠️ **RLS (Phase 27) ปิดอยู่** (`RLS_ENABLED` default `off`). Defense จริง = **app-layer injection ใน `tenantPrisma`** + guard ในแต่ละ route. RLS เป็น defense-in-depth ที่ยังไม่ activate → test ทั้งหมดต้อง assume RLS off.

## 8 Axes

| Axis | ทำไมสำคัญ | Layer/ไฟล์ที่บังคับใช้ |
|---|---|---|
| **cross-tenant-read** | อ่านข้อมูล tenant อื่น = data breach. read op ทุกตัวต้องถูก scope | `src/lib/tenant.ts` — inject `where.tenantId` (find*/count/aggregate/groupBy). ⚠️ nested include **ไม่** ถูก inject → พึ่ง FK integrity |
| **cross-tenant-write** | แก้/สร้างข้อมูลใน tenant อื่น = integrity breach | `src/lib/tenant.ts` — inject `where.tenantId` (update/updateMany), `data.tenantId` (create/createMany). ⚠️ nested `connect` ไม่ถูก scope |
| **cross-tenant-delete** | ลบข้าม tenant = mass data loss (โดยเฉพาะ `deleteMany({})`) | `src/lib/tenant.ts` — inject `where.tenantId` (delete/deleteMany) |
| **tenant-move (B-1)** | ย้าย record ข้าม tenant ด้วย `data.tenantId` = ทั้ง leak + integrity | `src/lib/tenant.ts` — **strip `tenantId` ออกจาก `data`** ใน update/updateMany + upsert.update; override ใน create/createMany + upsert.create |
| **internal-note-leak** | โน้ต agent หลุดถึงลูกค้า = Critical | Route-level filter `where: { visibility: PUBLIC }` ใน `api/portal/tickets/[id]`, `api/portal/tickets` (`_count`), `api/v1/tickets/[id]`, `api/portal/attachments/[id]` (parent message visibility). **ไม่ centralize ใน extension** |
| **contact-own-records** | contact เห็น ticket ของ contact อื่นใน tenant เดียว = leak ชั้นใน | Route-level `where: { requesterContactId: session.contact.id }` ใน portal routes; attachment เช็ค `ticket.requesterContactId`. fail → **404** (ไม่ 403 เพื่อไม่ reveal) |
| **audience-confusion** | agent/contact token ปนกัน = privilege escalation | `src/lib/auth.ts` — `requireAgent` (type==='agent' + `TenantMember` isActive + role), `requireContact` (type==='contact' + double-check `payload.tenantId===ctx.tenantId` + `contact.tenantId===ctx.tenantId`) |
| **tenantid-from-client** | เชื่อ tenantId จาก client = tenant spoofing | `getTenantContext()` อ่านจาก `x-tenant-id` header ที่ **proxy เขียนทับเสมอ** (`src/proxy.ts`); schema/route ไม่รับ tenantId จาก body/query/path |

## หมายเหตุความเปราะ (flag ให้ qa)

1. **nested read/write ไม่ถูก extension scope** (XT-READ-04, XT-WRITE-05) — inject ทำเฉพาะ top-level. relation isolation พึ่ง FK integrity ล้วน.
2. **visibility filter ไม่ centralize** (NOTE-LEAK-05) — endpoint ใหม่ที่ลืม `where: { visibility: PUBLIC }` จะ leak เงียบ ๆ. ต้องมี property test ครอบทุก message-returning surface.
3. **unhandled Prisma op** — op ที่ไม่อยู่ใน branch ของ extension ไม่ถูก inject tenantId (แค่ `console.warn` + พึ่ง RLS ที่ปิดอยู่). ควร guard ว่า op ที่ codebase ใช้จริงอยู่ใน branch ครบ.
4. **filtered-findUnique** (XT-READ-02) — ต้องยืนยันว่า Prisma apply `tenantId` ที่ inject เข้า `findUnique.where` เป็น filter จริง (คืน null เมื่อไม่ตรง).

## วิธี consume (qa)

```ts
import { ATTACK_CASES, casesByAxis, fuzzableCases, suspectedWeaknessCases } from "./threat-model";
// เดินลูป ATTACK_CASES → generate fixture ต่าง tenant/contact → assert ตาม `invariant`
// fuzzableCases() → property-based (สุ่ม input); ที่เหลือ → table-driven
// suspectedWeaknessCases() → ตั้งใจพิสูจน์/หักล้าง (ดู SUSPECTED_WEAKNESSES)
```
