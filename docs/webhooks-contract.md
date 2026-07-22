# Contract — Outbound Webhooks (Phase 36)

> **Single source of truth** สำหรับ schema · payload envelope · signature · retry/DLQ semantics
> `database` (schema/migration), `backend` (lib + producer + worker + CRUD API), `frontend` (settings UI),
> `qa-testing` / `security` (เกณฑ์ block) **ต้องยึดไฟล์นี้** — ห้าม relay ด้วยคำพูด

## หลักการ (บังคับ — กฎสูงสุดของ project)

1. **Tenant isolation**: `WebhookEndpoint` / `WebhookDelivery` เป็น tenant-scoped ทุกแถว. ทุก query ผ่าน `tenantPrisma(ctx.tenantId)`. **ห้ามรับ `tenantId` จาก client**.
2. **Worker รันนอก middleware** (ไม่มี tenant context จาก subdomain) → `tenantId` มาจาก payload ที่ **verify QStash signature แล้วเท่านั้น** (pattern เดียวกับ `/api/jobs/send-email`).
3. **Internal-note isolation**: event `ticket.message_created` dispatch **เฉพาะ `visibility = PUBLIC`** เท่านั้น. INTERNAL note **ห้ามออกนอกระบบเด็ดขาด** — กรองทั้งฝั่ง producer และ **re-check ที่ worker** (ไม่ trust payload ที่ enqueue ไว้).
4. **Audience = agent-only**: CRUD endpoint ทั้งหมดผ่าน `requireAgent({ roles: ["OWNER","ADMIN"] })`. Portal/contact ห้ามแตะ.
5. **Feature gate**: `hasFeature(tenantId, "webhooks", plan)` → ปิด = `403 FEATURE_LOCKED`. **ห้าม hardcode plan check**.
   ฝั่ง producer ให้ gate **ภายใน `dispatchWebhookEvent()` จุดเดียว** (ไม่ใช่ที่ call site แต่ละที่) — call site ลืมไม่ได้ และ tenant ที่ plan ตกชั้นจะหยุดส่งทันทีโดยไม่ต้องแก้ทุก route
6. **SSRF = ภัยหลักของฟีเจอร์นี้** (tenant ป้อน URL ให้ server เราไปยิง) — ดู § SSRF Guard. บังคับ **2 จุด**: create/update-time และ **send-time หลัง DNS resolve** (กัน DNS rebinding).

---

## 1. Prisma schema (เจ้าภาพ: `database`)

### enum

```prisma
enum WebhookEventType {
  TICKET_CREATED            // "ticket.created"
  TICKET_STATUS_CHANGED     // "ticket.status_changed"
  TICKET_ASSIGNED           // "ticket.assigned"
  TICKET_PRIORITY_CHANGED   // "ticket.priority_changed"
  TICKET_MESSAGE_CREATED    // "ticket.message_created" (PUBLIC เท่านั้น)
}

enum WebhookDeliveryStatus {
  PENDING    // enqueue แล้ว ยังไม่สำเร็จ (กำลัง retry ได้)
  SUCCEEDED  // receiver ตอบ 2xx
  FAILED     // attempt ล่าสุดล้ม แต่ยัง retry ได้ (attemptCount < MAX)
  DEAD       // ครบ MAX attempts แล้วยังล้ม = DLQ (replay ด้วยมือได้)
}
```

### model WebhookEndpoint

```prisma
model WebhookEndpoint {
  id       String @id @default(cuid())
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  // ชื่อที่ user ตั้งเพื่อแยกแยะ endpoint
  description String
  // ปลายทาง — https เท่านั้น, ผ่าน SSRF guard (ดู § SSRF)
  url         String
  // HMAC signing secret (plaintext "whsec_...") — return ออก API ครั้งเดียวตอน create/rotate
  // ⚠️ ห้าม return ใน list/get DTO, ห้าม log, ห้ามใส่ใน AuditLog before/after
  secret      String
  // event ที่ subscribe — ว่าง = ไม่ส่งอะไรเลย
  events      WebhookEventType[]
  // ปิดชั่วคราวโดยไม่ลบ (คง delivery history)
  enabled     Boolean @default(true)

  createdByMemberId String?
  createdByMember   TenantMember? @relation("WebhookEndpointCreatedBy", fields: [createdByMemberId], references: [id], onDelete: SetNull)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  deliveries WebhookDelivery[]

  @@unique([tenantId, id]) // target ของ composite FK จาก WebhookDelivery
  @@index([tenantId])
}
```

### model WebhookDelivery

```prisma
model WebhookDelivery {
  id       String @id @default(cuid())
  tenantId String
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  // composite FK [tenantId, endpointId] -> WebhookEndpoint[tenantId, id]
  // DB บังคับว่า delivery ต้องอยู่ tenant เดียวกับ endpoint (กัน cross-tenant FK — ดู Phase 34)
  endpointId String
  endpoint   WebhookEndpoint @relation(fields: [tenantId, endpointId], references: [tenantId, id], onDelete: Cascade)

  eventType WebhookEventType
  // id ของ "event" ที่ receiver ใช้ dedupe — 1 event → หลาย delivery (หลาย endpoint) ใช้ eventId เดียวกัน
  eventId   String
  // payload envelope เต็มที่จะส่ง (snapshot ณ เวลา enqueue — ไม่ re-query ตอน retry)
  payload   Json

  status       WebhookDeliveryStatus @default(PENDING)
  attemptCount Int                   @default(0)
  lastAttemptAt DateTime?
  // ผลลัพธ์ attempt ล่าสุด (ไว้ debug ใน UI)
  responseStatus Int?
  // ตัด 500 ตัวอักษรก่อนเก็บ (กัน payload ใหญ่/PII เกินจำเป็น)
  responseBody   String?
  errorMessage   String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([tenantId])
  @@index([tenantId, endpointId])
  @@index([tenantId, status])   // DLQ view: WHERE status = 'DEAD'
  @@index([tenantId, eventId])
}
```

> `Tenant` model ต้องเพิ่ม back-relation `webhookEndpoints WebhookEndpoint[]` + `webhookDeliveries WebhookDelivery[]`,
> `TenantMember` เพิ่ม `webhookEndpointsCreated WebhookEndpoint[] @relation("WebhookEndpointCreatedBy")`.

### Feature flag migration (แยกไฟล์ migration)

```sql
INSERT INTO "FeatureFlag" ("id", "key", "description", "defaultEnabled", "requiredPlan", "createdAt", "updatedAt")
VALUES ('cmflag_webhooks_0001', 'webhooks', 'Outbound webhooks for ticket events', false, 'pro', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
```
+ เพิ่ม entry เดียวกันใน `prisma/seed.ts` (array flags) ให้ตรงกัน

---

## 2. Payload envelope (เจ้าภาพ: `backend`)

`Content-Type: application/json` · body = envelope นี้ **เป๊ะ** (signature คำนวณจาก raw body ตัวนี้)

```jsonc
{
  "id": "<WebhookDelivery.eventId>",      // receiver ใช้ dedupe (idempotency key)
  "type": "ticket.status_changed",        // wire name (ดูตาราง § 3)
  "createdAt": "2026-07-22T10:00:00.000Z",// ISO8601 UTC — เวลาที่ event เกิด
  "tenantId": "<cuid>",
  "data": { /* ตาม event type */ }
}
```

### data — ticket.* (created / status_changed / assigned / priority_changed)

```jsonc
{
  "ticket": {
    "id": "<cuid>",
    "ticketNumber": 1042,
    "subject": "…",
    "status": "OPEN",
    "priority": "HIGH",
    "assigneeMemberId": "<cuid>|null",
    "requesterContactId": "<cuid>",
    "channel": "portal",
    "createdAt": "…", "updatedAt": "…"
  },
  // มีเฉพาะ status_changed / assigned / priority_changed
  "changes": { "status": { "from": "NEW", "to": "OPEN" } }
}
```
`assigned` → `"changes": { "assigneeMemberId": { "from": null, "to": "<cuid>" } }`
`priority_changed` → `"changes": { "priority": { "from": "NORMAL", "to": "HIGH" } }`

### data — ticket.message_created (PUBLIC เท่านั้น)

```jsonc
{
  "ticket": { "id": "<cuid>", "ticketNumber": 1042, "subject": "…" },
  "message": {
    "id": "<cuid>",
    "visibility": "PUBLIC",              // ค่านี้ต้องเป็น PUBLIC เสมอ — ไม่งั้นคือ bug
    "authorType": "agent" | "contact",
    "authorId": "<cuid>",                // TenantMember.id หรือ Contact.id ตาม authorType
    "body": "…",
    "createdAt": "…"
  }
}
```

> **ห้ามใส่**: secret, api key, ข้อมูล tenant อื่น, contact email/PII เกินที่ระบุข้างบน, internal note ทุกกรณี

---

## 3. Event type mapping

| enum | wire `type` | trigger point |
|---|---|---|
| `TICKET_CREATED` | `ticket.created` | `POST /api/tickets`, `POST /api/v1/tickets`, `POST /api/portal/tickets`, inbound email สร้าง ticket ใหม่ |
| `TICKET_STATUS_CHANGED` | `ticket.status_changed` | `PATCH /api/tickets/[id]` เมื่อ status เปลี่ยนจริง |
| `TICKET_ASSIGNED` | `ticket.assigned` | `PATCH /api/tickets/[id]` เมื่อ assigneeId เปลี่ยนจริง |
| `TICKET_PRIORITY_CHANGED` | `ticket.priority_changed` | `PATCH /api/tickets/[id]` เมื่อ priority เปลี่ยนจริง |
| `TICKET_MESSAGE_CREATED` | `ticket.message_created` | `POST /api/tickets/[id]/messages`, `POST /api/portal/tickets/[id]/messages`, inbound email ที่ append เข้า ticket เดิม — **ทุกเส้นทางเฉพาะ visibility=PUBLIC** |

> เปลี่ยนหลายฟิลด์ใน PATCH เดียว → ยิงหลาย event (แยก eventId คนละตัว)
>
> ⚠️ **Portal (contact audience) ต้องยิง event ด้วย** — ticket ที่ลูกค้าเปิดเองผ่าน portal และข้อความที่ลูกค้าตอบ
> เป็น event ที่ integrator คาดหวังมากที่สุด. `dispatchWebhookEvent` เป็น **agent-side side-effect**
> ไม่ได้ทำให้ contact เห็นอะไรเพิ่ม — endpoint เป็นของ tenant ไม่ใช่ของ contact
> (`authorType: "contact"` สำหรับข้อความจาก portal)

---

## 4. HTTP headers ที่ส่งออก

| header | ค่า |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `Helpwise-Webhooks/1.0` |
| `X-Helpwise-Event` | wire type เช่น `ticket.created` |
| `X-Helpwise-Event-Id` | `WebhookDelivery.eventId` |
| `X-Helpwise-Delivery-Id` | `WebhookDelivery.id` |
| `X-Helpwise-Attempt` | เลข attempt (1-based) |
| `X-Helpwise-Signature` | `t=<unixSeconds>,v1=<hexHmac>` |

### Signature scheme (Stripe-style)

```
signedPayload = `${t}.${rawBody}`          // t = unix seconds (integer)
v1            = HMAC_SHA256(secret, signedPayload)  → hex lowercase
header        = `t=${t},v1=${v1}`
```
- `secret` = plaintext `WebhookEndpoint.secret` (utf8 ทั้งสตริง รวม prefix `whsec_`)
- `rawBody` = JSON string ที่ส่งจริง byte-per-byte (serialize **ครั้งเดียว** แล้วใช้ทั้ง sign และ send)
- ฝั่ง receiver ควร: เทียบแบบ constant-time + reject ถ้า `|now - t| > 300s` (replay window) — ระบุใน docs
- secret format: `whsec_` + `randomBytes(32).toString("base64url")`

---

## 5. Retry / DLQ semantics

- Transport = **Upstash QStash** (reuse `src/lib/queue.ts` pattern) → worker route `POST /api/jobs/webhook-deliver`
- publish ด้วย `retries: 4` (รวม attempt แรก = สูงสุด **5 attempts**) → `MAX_ATTEMPTS = 5`
- worker แต่ละครั้ง: `attemptCount += 1` → ยิง HTTP POST ไป endpoint.url (timeout **10s**)
  - receiver ตอบ **2xx** → `status = SUCCEEDED`, บันทึก responseStatus → return **200**
  - ล้ม (non-2xx / timeout / network / SSRF re-check ไม่ผ่าน) และ `attemptCount < MAX_ATTEMPTS`
    → `status = FAILED` + errorMessage → return **500** (ให้ QStash retry ตาม backoff ของมัน)
  - ล้ม และ `attemptCount >= MAX_ATTEMPTS` → `status = DEAD` (เข้า DLQ) → return **200** (หยุด retry)
- **idempotent**: ถ้า delivery ปัจจุบัน `status === "SUCCEEDED"` แล้ว → skip ทันที return 200 (`{ skipped: "already_succeeded" }`)
- **endpoint ถูกลบ / `enabled = false` ตอน worker รัน** → skip return 200 (`{ skipped: "endpoint_disabled" }`)
- **Replay (DLQ)**: `POST /api/webhook-deliveries/[id]/replay` → รับ delivery ที่ `status !== SUCCEEDED`
  (ครอบ `DEAD` = DLQ จริง, `FAILED`, และ `PENDING` ที่ค้างเพราะ publish ไป QStash ไม่สำเร็จ)
  → reset `attemptCount = 0`, `status = PENDING`, publish job ใหม่ (payload เดิม ไม่ re-query — snapshot)
  → `409 ALREADY_SUCCEEDED` ถ้า delivery สำเร็จไปแล้ว
  > replay ตอน QStash ยัง retry ตัวเดิมค้างอยู่ = ยิงซ้ำได้ — รับได้เพราะ receiver dedupe ด้วย `eventId` (§ 2)

### QStash job payload (producer → worker)

```jsonc
{ "tenantId": "<cuid>", "deliveryId": "<WebhookDelivery.id>" }
```
> ผอมที่สุด — worker โหลด payload/endpoint จาก DB ด้วย `tenantPrisma(tenantId)` เอง
> worker path constant: `WEBHOOK_DELIVER_WORKER_PATH = "/api/jobs/webhook-deliver"`

---

## 6. SSRF Guard (บังคับ — เจ้าภาพ `backend`, เกณฑ์ block ของ `security`)

`validateWebhookUrl(url)` ต้อง **reject** ทั้งตอน create/update และ **ตอนส่งจริงหลัง DNS resolve**:

1. scheme ≠ `https:` → reject (ยกเว้น `NODE_ENV !== "production"` อนุญาต `http:` เพื่อ dev เท่านั้น — flag ไว้ชัด)
2. hostname เป็น IP literal ที่อยู่ในช่วงต้องห้าม หรือ resolve (dns.lookup all) แล้วได้ IP ในช่วงต้องห้าม:
   - `127.0.0.0/8`, `0.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (**cloud metadata `169.254.169.254`**), `100.64.0.0/10` (CGNAT)
   - IPv6: `::1`, `fc00::/7` (ULA), `fe80::/10` (link-local), IPv4-mapped `::ffff:0:0/96` → unmap แล้วเช็คซ้ำ
3. hostname `localhost`, `*.localhost`, `*.internal`, `metadata.google.internal` → reject
4. port ต้องเป็น 443 (หรือ default) — dev อนุญาต port อื่นได้
5. **ห้าม follow redirect** ตอนส่ง (`redirect: "manual"`) — redirect เป็นทางอ้อมของ SSRF; 3xx = ล้มเหลว (retry-able)
6. ตอนส่ง: resolve DNS เอง → เช็ค IP → **ถ้าไม่ผ่านให้ fail delivery ทันที** (`errorMessage: "blocked_destination"`), ไม่ต้อง retry (mark DEAD เลย)

> รายละเอียด response ของ receiver **ห้าม** สะท้อนกลับ UI มากกว่า `responseStatus` + `responseBody` (truncate 500 ตัว) — กัน SSRF ใช้ระบบเป็น proxy อ่านข้อมูลภายใน

---

## 7. REST API (agent-only, OWNER/ADMIN, feature-gated) — รูปแบบ `{ data, error }` เสมอ

> ⚠️ **path เป็น `/api/webhook-endpoints` + `/api/webhook-deliveries` ไม่ใช่ `/api/webhooks`** —
> `src/app/api/webhooks/` ถูกใช้โดย **inbound** webhook อยู่แล้ว (`webhooks/stripe`, `webhooks/email`)
> การเพิ่ม `[id]` segment เข้าไปทำให้ route tree ปนกันระหว่าง inbound (รับเข้า, verify signature ของ provider)
> กับ outbound management (agent-only CRUD) — แยก path กันคนละต้นไม้เพื่อไม่ให้เผลอ

| method + path | หน้าที่ | หมายเหตุ |
|---|---|---|
| `GET /api/webhook-endpoints` | list endpoints | **ไม่คืน `secret`** |
| `POST /api/webhook-endpoints` | สร้าง endpoint | คืน `{ endpoint, plaintextSecret }` **ครั้งเดียว** |
| `PATCH /api/webhook-endpoints/[id]` | แก้ description/url/events/enabled | url ที่แก้ต้องผ่าน SSRF guard ซ้ำ |
| `DELETE /api/webhook-endpoints/[id]` | ลบ endpoint | cascade ลบ deliveries |
| `POST /api/webhook-endpoints/[id]/rotate-secret` | หมุน secret | คืน plaintext ใหม่ครั้งเดียว |
| `GET /api/webhook-deliveries?endpointId=&status=` | list delivery (paginate `take` ≤ 50) | DLQ = `status=DEAD` |
| `POST /api/webhook-deliveries/[id]/replay` | re-enqueue delivery ที่ยังไม่สำเร็จ | 409 ถ้า `SUCCEEDED` |

**DTO** (`src/types/webhook.ts`) — `WebhookEndpointDTO` (ไม่มี field `secret`), `WebhookDeliveryDTO`

**AuditLog actions** (ผ่าน `audit.log()` เท่านั้น, **ห้าม log secret**):
`webhook.endpoint_created` · `webhook.endpoint_updated` · `webhook.endpoint_deleted` · `webhook.secret_rotated` · `webhook.delivery_replayed`

---

## 8. Env vars ที่ต้องมี (ไม่มีตัวใหม่นอกจากที่ระบุ)

reuse ของเดิม: `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `QSTASH_TARGET_BASE_URL`
**ไม่เพิ่ม env ใหม่** — MAX_ATTEMPTS / timeout เป็น constant ในโค้ด
