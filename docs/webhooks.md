# Helpwise Outbound Webhooks

คู่มือสำหรับนักพัฒนาที่จะเขียน endpoint รับ webhook จาก Helpwise

Outbound webhook คือการที่ Helpwise **ยิง HTTP POST ไปหาระบบของคุณ** ทุกครั้งที่เกิดเหตุการณ์
กับ ticket ใน workspace ของคุณ (สร้าง ticket ใหม่, เปลี่ยนสถานะ, มีข้อความใหม่ ฯลฯ) — ใช้แทนการ
poll `GET /api/v1/tickets` เป็นรอบ ๆ เหมาะกับการ sync ข้อมูลเข้าระบบภายใน, ส่งแจ้งเตือนเข้า Slack,
หรือ trigger automation ของคุณเอง

- **ทิศทาง:** Helpwise → ระบบของคุณ (outbound เท่านั้น — คนละเรื่องกับ inbound email webhook)
- **Plan ที่ต้องมี:** feature `webhooks` — plan ระดับ **pro** ขึ้นไป
- **สิทธิ์ที่ใช้ตั้งค่า:** สมาชิก workspace ที่มี role **OWNER** หรือ **ADMIN**
- **รูปแบบ:** `POST` · `Content-Type: application/json` · body เป็น envelope เดียวกันทุก event

> ถ้า plan ของ workspace ถูกลดชั้นลงต่ำกว่า pro ระบบจะ **หยุดส่ง webhook ทันที** โดยไม่ลบ endpoint
> ที่ตั้งไว้ — เมื่ออัปเกรดกลับ ระบบจะเริ่มส่งใหม่ (event ที่เกิดระหว่างนั้นไม่ถูกส่งย้อนหลัง)

---

## 1. เริ่มต้นใช้งาน

1. ล็อกอินเข้า agent workspace ของคุณ (`https://{slug}.gethelpwise.xyz`)
2. ไปที่ **Settings → Webhooks**
3. กด **Create endpoint** แล้วกรอก
   - **Description** — ชื่อไว้แยกแยะ endpoint (1–80 ตัวอักษร)
   - **URL** — ปลายทางที่จะรับ POST ต้องเป็น `https://` และเข้าถึงได้จากอินเทอร์เน็ตสาธารณะ
     (ดูข้อจำกัดใน [§ 8](#8-ข้อกำหนดของ-url-ปลายทาง))
   - **Events** — เลือกอย่างน้อย 1 event ที่จะ subscribe
4. คัดลอก **signing secret** (`whsec_…`) ที่แสดงหลังสร้างเสร็จ

> ⚠️ **Signing secret แสดงให้เห็นเพียงครั้งเดียว** ตอนสร้าง (และตอนกด rotate) เท่านั้น
> เก็บลง secret manager / env var ของระบบคุณทันที ถ้าทำหาย ให้กด **Rotate secret**
> เพื่อสร้างค่าใหม่ (ค่าเดิมจะใช้ไม่ได้ทันที)

หลังจากนั้น endpoint จะเริ่มรับ event ทันที ผลการส่งทุกครั้งดูได้ที่หน้า **Settings → Webhooks →
Deliveries** (มี HTTP status, response body ที่ระบบเก็บไว้ 500 ตัวอักษรแรก, และ error message)

ปิด endpoint ชั่วคราวได้ด้วยการ toggle `enabled` — ระบบจะหยุดส่งแต่ยังเก็บประวัติ delivery ไว้

---

## 2. Event ที่ส่งได้

| Event (`type`) | ยิงเมื่อ |
| --- | --- |
| `ticket.created` | มี ticket ใหม่ (agent สร้าง, สร้างผ่าน `POST /api/v1/tickets`, หรือ inbound email สร้าง ticket ใหม่) |
| `ticket.status_changed` | สถานะของ ticket เปลี่ยนจริง |
| `ticket.assigned` | ผู้รับผิดชอบ (assignee) ของ ticket เปลี่ยนจริง |
| `ticket.priority_changed` | ความสำคัญ (priority) ของ ticket เปลี่ยนจริง |
| `ticket.message_created` | มีข้อความสาธารณะใหม่ในเธรด — จาก agent ที่ตอบใน workspace หรือจากอีเมลขาเข้าของลูกค้า **เฉพาะ `visibility: PUBLIC`** |

หมายเหตุสำคัญ

- **ข้อจำกัดปัจจุบัน:** ticket และข้อความที่ลูกค้าสร้างเองผ่าน **portal** ยังไม่ยิง event
  (`ticket.created` / `ticket.message_created`) — ช่องทางที่ยิง event แล้วคือ agent workspace,
  `POST /api/v1/tickets` และอีเมลขาเข้า ถ้าคุณต้องการ event จาก portal ด้วย โปรดติดต่อทีมงาน
- ถ้าแก้หลายฟิลด์ในการอัปเดตครั้งเดียว (เช่น เปลี่ยนทั้ง status และ priority) จะได้ **หลาย event
  แยกกัน คนละ `id`** ไม่ใช่ event เดียวรวมทุกการเปลี่ยนแปลง
- event จะถูกส่งไปยัง endpoint ที่ `enabled = true` และ subscribe event นั้นไว้เท่านั้น
- ค่า enum ของ `status` / `priority` ตรงกับ [Public API Reference](./api.md#enums):
  `NEW | OPEN | PENDING | ON_HOLD | SOLVED | CLOSED` และ `LOW | NORMAL | HIGH | URGENT`

### Envelope

ทุก event ใช้โครงเดียวกัน โดย `data` ต่างกันตาม `type`

| Field | Type | คำอธิบาย |
| --- | --- | --- |
| `id` | string | Event ID — ใช้เป็น **idempotency key** (ตรงกับ header `X-Helpwise-Event-Id`) |
| `type` | string | ชื่อ event ตามตารางด้านบน |
| `createdAt` | string | ISO 8601 UTC — เวลาที่ event เกิดขึ้น |
| `tenantId` | string | ID ของ workspace เจ้าของ event |
| `data` | object | รายละเอียดของ event |

### `ticket.created`

```json
{
  "id": "evt_2f6c7a1e-6f1b-4f0a-9a2e-5c8d3b1a7e40",
  "type": "ticket.created",
  "createdAt": "2026-07-22T10:00:00.000Z",
  "tenantId": "clx0t3n4nt00000000000001",
  "data": {
    "ticket": {
      "id": "clx1a2b3c4d5e6f7g8h9i0j1",
      "ticketNumber": 1042,
      "subject": "Cannot access invoice history",
      "status": "NEW",
      "priority": "HIGH",
      "assigneeMemberId": null,
      "requesterContactId": "clxc0nt4ct0000000000000a",
      "channel": "portal",
      "createdAt": "2026-07-22T10:00:00.000Z",
      "updatedAt": "2026-07-22T10:00:00.000Z"
    }
  }
}
```

`channel` บอกช่องทางที่ ticket เข้ามา เช่น `portal`, `email`, `api`, `agent`
`assigneeMemberId` เป็น `null` ได้เมื่อยังไม่มีคนรับผิดชอบ
`ticket.created` **ไม่มี** field `changes`

### `ticket.status_changed`

```json
{
  "id": "evt_8a41c0d2-9b77-4c31-8f2a-1de4c6b90f13",
  "type": "ticket.status_changed",
  "createdAt": "2026-07-22T10:05:00.000Z",
  "tenantId": "clx0t3n4nt00000000000001",
  "data": {
    "ticket": {
      "id": "clx1a2b3c4d5e6f7g8h9i0j1",
      "ticketNumber": 1042,
      "subject": "Cannot access invoice history",
      "status": "OPEN",
      "priority": "HIGH",
      "assigneeMemberId": null,
      "requesterContactId": "clxc0nt4ct0000000000000a",
      "channel": "portal",
      "createdAt": "2026-07-22T10:00:00.000Z",
      "updatedAt": "2026-07-22T10:05:00.000Z"
    },
    "changes": {
      "status": { "from": "NEW", "to": "OPEN" }
    }
  }
}
```

`data.ticket` คือ snapshot **หลัง** การเปลี่ยนแปลง ส่วน `changes` บอกค่าก่อน/หลังของฟิลด์ที่เปลี่ยน

### `ticket.assigned`

```json
{
  "id": "evt_51b0d9f4-3a2c-4d8e-b7f1-90c2a4e6d811",
  "type": "ticket.assigned",
  "createdAt": "2026-07-22T10:07:30.000Z",
  "tenantId": "clx0t3n4nt00000000000001",
  "data": {
    "ticket": {
      "id": "clx1a2b3c4d5e6f7g8h9i0j1",
      "ticketNumber": 1042,
      "subject": "Cannot access invoice history",
      "status": "OPEN",
      "priority": "HIGH",
      "assigneeMemberId": "clxm3mb3r00000000000000b",
      "requesterContactId": "clxc0nt4ct0000000000000a",
      "channel": "portal",
      "createdAt": "2026-07-22T10:00:00.000Z",
      "updatedAt": "2026-07-22T10:07:30.000Z"
    },
    "changes": {
      "assigneeMemberId": { "from": null, "to": "clxm3mb3r00000000000000b" }
    }
  }
}
```

`assigneeMemberId` คือ ID ของสมาชิก workspace (ไม่ใช่ user ID ระดับ global)

### `ticket.priority_changed`

```json
{
  "id": "evt_c73e8b15-2f44-4a90-8e6b-77d1c0f5a239",
  "type": "ticket.priority_changed",
  "createdAt": "2026-07-22T10:12:00.000Z",
  "tenantId": "clx0t3n4nt00000000000001",
  "data": {
    "ticket": {
      "id": "clx1a2b3c4d5e6f7g8h9i0j1",
      "ticketNumber": 1042,
      "subject": "Cannot access invoice history",
      "status": "OPEN",
      "priority": "URGENT",
      "assigneeMemberId": "clxm3mb3r00000000000000b",
      "requesterContactId": "clxc0nt4ct0000000000000a",
      "channel": "portal",
      "createdAt": "2026-07-22T10:00:00.000Z",
      "updatedAt": "2026-07-22T10:12:00.000Z"
    },
    "changes": {
      "priority": { "from": "HIGH", "to": "URGENT" }
    }
  }
}
```

### `ticket.message_created`

```json
{
  "id": "evt_0d92f7ab-58c3-4e11-9f60-3b8a2c4d5e6f",
  "type": "ticket.message_created",
  "createdAt": "2026-07-22T10:20:00.000Z",
  "tenantId": "clx0t3n4nt00000000000001",
  "data": {
    "ticket": {
      "id": "clx1a2b3c4d5e6f7g8h9i0j1",
      "ticketNumber": 1042,
      "subject": "Cannot access invoice history"
    },
    "message": {
      "id": "clxm3ssag300000000000001",
      "visibility": "PUBLIC",
      "authorType": "agent",
      "authorId": "clxm3mb3r00000000000000b",
      "body": "Thanks for reaching out — looking into this now.",
      "createdAt": "2026-07-22T10:20:00.000Z"
    }
  }
}
```

- `data.ticket` ของ event นี้เป็นแบบย่อ — มีแค่ `id`, `ticketNumber`, `subject`
- `message.visibility` เป็น `"PUBLIC"` เสมอ (ดู [§ 9](#9-ข้อมูลที่ระบบไม่ส่งออก))
- `message.authorType` เป็น `"agent"` หรือ `"contact"` และ `message.authorId` คือ member ID
  หรือ contact ID ตามค่า `authorType`

---

## 3. HTTP headers ที่จะได้รับ

| Header | ค่า |
| --- | --- |
| `Content-Type` | `application/json` |
| `User-Agent` | `Helpwise-Webhooks/1.0` |
| `X-Helpwise-Event` | ชื่อ event เช่น `ticket.created` (ตรงกับ `type` ใน body) |
| `X-Helpwise-Event-Id` | Event ID (ตรงกับ `id` ใน body) — ใช้ dedupe |
| `X-Helpwise-Delivery-Id` | ID ของการส่งครั้งนี้ — ต่างกันในแต่ละ endpoint ที่รับ event เดียวกัน |
| `X-Helpwise-Attempt` | ลำดับความพยายามส่ง เริ่มที่ `1` สูงสุด `5` |
| `X-Helpwise-Signature` | ลายเซ็น HMAC รูปแบบ `t=<unixSeconds>,v1=<hexHmac>` |

---

## 4. การตรวจสอบ signature

**ต้องตรวจทุก request** ก่อนประมวลผล ไม่งั้นใครก็ตามที่รู้ URL ของคุณสามารถปลอม event ได้

### Scheme

```
signedPayload = "{t}.{rawBody}"
v1            = HMAC_SHA256(secret, signedPayload)   →  hex ตัวพิมพ์เล็ก
header        = "t={t},v1={v1}"
```

- `t` = unix timestamp (วินาที, จำนวนเต็ม) ที่ระบบเซ็นและส่ง request นี้
- `rawBody` = request body **ดิบ** ทั้งก้อน byte ต่อ byte
- `secret` = signing secret ทั้งสตริงรวม prefix `whsec_` (ตีความเป็น UTF-8)
- `v1` = HMAC-SHA256 เป็น hex ตัวพิมพ์เล็ก 64 ตัวอักษร

> ⚠️ **สามข้อที่พลาดกันบ่อยที่สุด**
> 1. **ต้องใช้ raw body** — อย่า `JSON.parse` แล้ว `JSON.stringify` กลับมาเซ็น ลำดับ key/ช่องว่าง
>    อาจเปลี่ยนไปแม้แต่ byte เดียว ลายเซ็นก็ไม่ตรงแล้ว (ใน Express ต้องใช้ `express.raw()`)
> 2. **เทียบแบบ constant-time** (`crypto.timingSafeEqual`, `hmac.compare_digest`) ไม่ใช่ `===`
> 3. **ปฏิเสธ timestamp ที่เก่าเกินไป** — ค่าที่แนะนำคือ **300 วินาที** เพื่อกัน replay attack

### ตัวอย่าง Node.js / TypeScript

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

/** ค่าเดียวกับที่ Helpwise แนะนำ — 5 นาที */
const TOLERANCE_SECONDS = 300;

interface ParsedSignature {
  t: number;
  v1: string;
}

/** แยก header "t=...,v1=..." — คืน null ถ้ารูปแบบผิด */
function parseSignatureHeader(header: string): ParsedSignature | null {
  let t: number | null = null;
  let v1: string | null = null;

  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t" && /^\d+$/.test(value)) t = Number(value);
    // v1 ต้องเป็น hex ของ sha256 (64 ตัว) — รูปแบบอื่นถือว่า malformed
    else if (key === "v1" && /^[0-9a-f]{64}$/.test(value)) v1 = value;
  }

  return t !== null && v1 !== null ? { t, v1 } : null;
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  header: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  if (!header) return false;

  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;

  // replay window — กันเอา request เก่าที่เซ็นถูกต้องมายิงซ้ำ
  if (Math.abs(nowSeconds - parsed.t) > TOLERANCE_SECONDS) return false;

  const expected = Buffer.from(
    createHmac("sha256", secret)
      .update(`${parsed.t}.${rawBody}`)
      .digest("hex"),
    "utf8"
  );
  const actual = Buffer.from(parsed.v1, "utf8");

  // timingSafeEqual throw ถ้าความยาวต่างกัน จึงเช็ค length ก่อน
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
```

ตัวอย่างการต่อกับ Express — สังเกต `express.raw()` ที่ทำให้ `req.body` เป็น `Buffer` ไม่ใช่ object

```ts
import express from "express";

const app = express();
const SIGNING_SECRET = process.env.HELPWISE_WEBHOOK_SECRET ?? "";

app.post(
  "/webhooks/helpwise",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const rawBody = (req.body as Buffer).toString("utf8");
    const signature = req.header("X-Helpwise-Signature");

    if (!verifyWebhookSignature(SIGNING_SECRET, rawBody, signature)) {
      return res.status(401).send("invalid signature");
    }

    const event = JSON.parse(rawBody);

    // ตอบ 2xx ทันที แล้วค่อยประมวลผลแบบ async (timeout ฝั่ง Helpwise = 10 วินาที)
    res.status(200).send("ok");
    void enqueueForProcessing(event);
  }
);
```

### ตัวอย่าง Python

```python
import hashlib
import hmac
import re
import time

TOLERANCE_SECONDS = 300
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def parse_signature_header(header: str):
    """แยก header 't=...,v1=...' — คืน None ถ้ารูปแบบผิด"""
    t = None
    v1 = None
    for part in header.split(","):
        key, sep, value = part.partition("=")
        if not sep:
            continue
        key = key.strip()
        value = value.strip()
        if key == "t" and value.isdigit():
            t = int(value)
        elif key == "v1" and _HEX64.match(value):
            v1 = value
    return (t, v1) if t is not None and v1 is not None else None


def verify_webhook_signature(secret: str, raw_body: bytes, header: str, now: int | None = None) -> bool:
    parsed = parse_signature_header(header or "")
    if parsed is None:
        return False
    t, v1 = parsed

    now = int(time.time()) if now is None else now
    # replay window
    if abs(now - t) > TOLERANCE_SECONDS:
        return False

    signed_payload = str(t).encode("utf-8") + b"." + raw_body
    expected = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
    # constant-time compare
    return hmac.compare_digest(expected, v1)
```

ตัวอย่างการใช้กับ Flask (`request.get_data()` คืน raw bytes ก่อน parse JSON)

```python
import json
import os
from flask import Flask, request

app = Flask(__name__)
SIGNING_SECRET = os.environ["HELPWISE_WEBHOOK_SECRET"]


@app.post("/webhooks/helpwise")
def helpwise_webhook():
    raw_body = request.get_data()
    signature = request.headers.get("X-Helpwise-Signature", "")

    if not verify_webhook_signature(SIGNING_SECRET, raw_body, signature):
        return "invalid signature", 401

    event = json.loads(raw_body)
    enqueue_for_processing(event)   # ประมวลผลนอก request
    return "ok", 200
```

---

## 5. Idempotency

ระบบรับประกันการส่ง **อย่างน้อยหนึ่งครั้ง (at-least-once)** ไม่ใช่ exactly-once — คุณอาจได้ event
เดิมซ้ำเมื่อมี retry, เมื่อ endpoint ของคุณตอบช้าจน timeout แต่จริง ๆ ประมวลผลไปแล้ว หรือเมื่อ
admin กด replay จาก DLQ

วิธีจัดการ: ใช้ **`id` ของ envelope** (ค่าเดียวกับ header `X-Helpwise-Event-Id`) เป็น idempotency key

- เก็บ `id` ที่เคยประมวลผลสำเร็จไว้ (ตาราง/Redis ที่มี unique index) — เจอซ้ำให้ตอบ `200` แล้วข้าม
- **retry ของ event เดิมใช้ `id` เดิมเสมอ** รวมถึงการ replay จาก DLQ
- ถ้า event เดียวถูกส่งไปหลาย endpoint ทุก endpoint จะได้ `id` **เดียวกัน** แต่
  `X-Helpwise-Delivery-Id` **ต่างกัน** — ถ้าคุณ dedupe รวมกันหลาย endpoint ให้ใช้คู่
  `(endpoint ของคุณ, id)` ไม่ใช่ `id` เดี่ยว ๆ
- ระบบ **ไม่รับประกันลำดับ** ของ event — ให้ใช้ `createdAt` ในการเรียงลำดับเอง และเช็คว่า state
  ที่คุณมีอยู่ใหม่กว่าหรือไม่ ก่อนเขียนทับ

---

## 6. Retry และ DLQ

| ผลลัพธ์จาก endpoint ของคุณ | ระบบตีความว่า |
| --- | --- |
| `2xx` | สำเร็จ — จบ ไม่ retry |
| `3xx` | **ล้มเหลว** — ระบบไม่ follow redirect |
| `4xx` / `5xx` | ล้มเหลว — retry |
| ไม่ตอบภายใน **10 วินาที** | ล้มเหลว (timeout) — retry |
| เชื่อมต่อไม่ได้ / TLS ผิดพลาด | ล้มเหลว — retry |

- ส่งสูงสุด **5 ครั้งต่อ delivery** (ครั้งแรก + retry อีก 4 ครั้ง) เว้นระยะแบบ backoff โดยคิวของระบบ
  ดูลำดับครั้งปัจจุบันได้จาก header `X-Helpwise-Attempt`
- ครบ 5 ครั้งแล้วยังไม่สำเร็จ → delivery เปลี่ยนสถานะเป็น **`DEAD`** (เข้า dead-letter queue)
  และหยุด retry อัตโนมัติ
- delivery ที่ `DEAD` (รวมถึงที่ยัง `FAILED`/`PENDING` ค้างอยู่) **กด Replay ด้วยมือได้** จาก
  **Settings → Webhooks → Deliveries** ระบบจะส่ง payload เดิมซ้ำ (snapshot ณ เวลาที่ event เกิด
  ไม่ query ข้อมูลใหม่) ด้วย `id` เดิม แต่ลายเซ็นและ `t` จะเป็นของรอบใหม่

> 💡 **ตอบ 2xx ให้เร็วที่สุด** — timeout อยู่ที่ 10 วินาที ควรตรวจ signature → บันทึก event ลงคิว
> ของคุณ → ตอบ `200` ทันที แล้วประมวลผลจริงแบบ async งานหนัก (เรียก API ต่อ, เขียน DB หลายตาราง)
> ที่ทำในคำขอตรง ๆ เสี่ยง timeout จนกลายเป็น retry ซ้ำโดยไม่จำเป็น
>
> ถ้าคุณตั้งใจจะ "ทิ้ง" event ที่ไม่สนใจ ให้ตอบ `200` ไม่ใช่ `4xx` — `4xx` จะถูกนับเป็นความล้มเหลว
> และไล่ retry จนเข้า DLQ

---

## 7. จัดการ endpoint ผ่าน API

นอกจากหน้า Settings ยัง จัดการผ่าน REST API ได้ — API ชุดนี้ใช้ **session ของ agent** (ไม่ใช่
Bearer API key แบบ [`/api/v1`](./api.md#authentication)) และจำกัดเฉพาะ role **OWNER**/**ADMIN**
ที่ plan มี feature `webhooks` ทุก response ใช้รูปแบบ `{ data, error }` เหมือน API อื่นของ Helpwise

| Method + path | หน้าที่ |
| --- | --- |
| `GET /api/webhook-endpoints` | list endpoint ทั้งหมด (**ไม่คืน** signing secret) |
| `POST /api/webhook-endpoints` | สร้าง endpoint — คืน `{ endpoint, plaintextSecret }` ครั้งเดียว |
| `PATCH /api/webhook-endpoints/{id}` | แก้ description / url / events / enabled |
| `DELETE /api/webhook-endpoints/{id}` | ลบ endpoint พร้อมประวัติ delivery |
| `POST /api/webhook-endpoints/{id}/rotate-secret` | หมุน secret — คืนค่าใหม่ครั้งเดียว |
| `GET /api/webhook-deliveries?endpointId=&status=` | ดูประวัติการส่ง (DLQ = `status=DEAD`) |
| `POST /api/webhook-deliveries/{id}/replay` | ส่ง delivery ที่ยังไม่สำเร็จซ้ำ |

Error code ที่พบบ่อย

| Status | `error.code` | ความหมาย |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | ข้อมูลใน body ไม่ผ่าน validation (เช่น ไม่ได้เลือก event) |
| 400 | `INVALID_WEBHOOK_URL` | URL ปลายทางไม่ผ่านข้อกำหนดใน § 8 |
| 403 | `FEATURE_LOCKED` | plan ปัจจุบันไม่มี feature `webhooks` |
| 409 | `ALREADY_SUCCEEDED` | สั่ง replay delivery ที่ส่งสำเร็จไปแล้ว |

> `/api/webhooks/*` เป็นเส้นทางของ **inbound** webhook (Stripe, inbound email) ที่ Helpwise เป็นผู้รับ
> — คนละชุดกับ outbound webhook ในเอกสารนี้ อย่าสับสน

---

## 8. ข้อกำหนดของ URL ปลายทาง

Helpwise เป็นฝ่ายยิง HTTP ไปยัง URL ที่คุณกรอก จึงต้องมีการป้องกัน SSRF อย่างเข้มงวด — URL ปลายทางต้อง

- ใช้ scheme **`https`** เท่านั้น และพอร์ต **443** (หรือไม่ระบุพอร์ต)
- ชี้ไปยัง host **สาธารณะ** ที่ resolve ได้จากอินเทอร์เน็ต

URL ที่ถูกปฏิเสธเสมอ

- IP หรือชื่อโฮสต์ที่ชี้ไปยังเครือข่ายภายใน: `127.0.0.0/8`, `0.0.0.0/8`, `10.0.0.0/8`,
  `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (รวม cloud metadata `169.254.169.254`),
  `100.64.0.0/10`
- IPv6 ภายใน: `::1`, `fc00::/7`, `fe80::/10` และรูปแบบ IPv4-mapped ของช่วงข้างบน
- ชื่อโฮสต์ `localhost`, `*.localhost`, `*.internal`, `metadata.google.internal`

การตรวจเกิดขึ้น **2 จุด**: ตอนสร้าง/แก้ endpoint และ **ทุกครั้งก่อนส่งจริงหลัง resolve DNS**
(กัน DNS rebinding) ถ้าโดเมนของคุณถูกเปลี่ยนให้ชี้ไป IP ภายในภายหลัง delivery นั้นจะถูก mark เป็น
**`DEAD` ทันทีโดยไม่ retry** พร้อม error `blocked_destination`

ข้อจำกัดอื่นที่ควรรู้

- **ไม่ follow redirect** — ตอบ `3xx` ถือว่าล้มเหลว ให้ตั้ง URL ปลายทางสุดท้ายไว้ตั้งแต่ต้น
- ตั้ง custom header เองไม่ได้ — ใช้ค่า secret ในการ authenticate ผ่าน signature แทน
  (ถ้าต้องการโทเคนเพิ่ม ใส่ไว้ใน path ของ URL ได้)
- ใบรับรอง TLS ต้อง valid

---

## 9. ข้อมูลที่ระบบไม่ส่งออก

- **Internal note ไม่เคยถูกส่งผ่าน webhook เด็ดขาด** — event `ticket.message_created` ยิงเฉพาะ
  ข้อความที่ `visibility: PUBLIC` เท่านั้น (ระบบกรองทั้งตอนสร้าง event และตรวจซ้ำอีกครั้งก่อนส่งจริง;
  ถ้าเจอข้อความที่ไม่ใช่ PUBLIC ระบบจะยกเลิก delivery ทิ้งแทนที่จะส่ง)
- **ไม่มี PII ของ contact ใน payload** — ไม่มีอีเมล, ชื่อ, หรือเบอร์โทรของผู้แจ้ง มีเพียง
  `requesterContactId` / `authorId` ให้คุณนำไป lookup ต่อผ่าน [Public API](./api.md) ถ้าจำเป็น
- **ไม่มี attachment** — payload ไม่มีไฟล์แนบหรือ URL ของไฟล์แนบ
- **ไม่มีข้อมูลของ workspace อื่น** — endpoint ของคุณได้รับเฉพาะ event ของ `tenantId` ตัวเอง
- payload ไม่มี API key, secret หรือข้อมูล credential ใด ๆ

---

## 10. Troubleshooting

**ตรวจ signature ไม่ผ่านทุก request**

1. เช็คว่าใช้ **raw body** จริงไหม — สาเหตุอันดับหนึ่งคือ framework parse JSON ไปแล้ว
   (Express ต้อง `express.raw({ type: "application/json" })` และต้องมาก่อน `express.json()`
   สำหรับ path นี้; Next.js route handler ใช้ `await request.text()` ไม่ใช่ `await request.json()`)
2. เช็คว่าใช้ `t` **จากใน header** มาต่อเป็น `"{t}.{rawBody}"` ไม่ใช่เวลาปัจจุบันของเครื่องคุณ
3. เช็คว่า secret ที่ใช้รวม prefix `whsec_` ครบ และไม่มีช่องว่าง/ขึ้นบรรทัดใหม่ติดมาจากการ copy
4. ถ้าเคยกด **Rotate secret** ค่าเดิมใช้ไม่ได้แล้ว — ต้องอัปเดต secret ในระบบคุณ

**Signature เคยผ่าน แต่บางครั้งไม่ผ่าน**

นาฬิกาของเซิร์ฟเวอร์คุณอาจเพี้ยน ทำให้ `|now - t|` เกิน 300 วินาที — เปิด NTP sync

**ไม่ได้รับ event เลย**

1. endpoint ถูกปิด (`enabled = false`) หรือถูกลบไปแล้ว
2. ไม่ได้ subscribe event ชนิดนั้นไว้ตอนสร้าง — แก้ได้ที่ Settings → Webhooks
3. plan ของ workspace ต่ำกว่า **pro** — ระบบจะเงียบทันทีโดยไม่มี delivery ถูกสร้างเลย
4. เหตุการณ์นั้นไม่เข้าเงื่อนไข เช่น PATCH ที่ส่งค่าเดิม (ไม่มีการเปลี่ยนแปลงจริง) จะไม่ยิง event
   และข้อความที่เป็น internal note จะไม่ยิง `ticket.message_created`

**Delivery ขึ้นสถานะ `DEAD`**

ดู `responseStatus` / `errorMessage` ในหน้า Deliveries

| `errorMessage` | สาเหตุ |
| --- | --- |
| `http_4xx` / `http_5xx` | endpoint ตอบ non-2xx ครบ 5 ครั้ง — ดู response body ที่ระบบเก็บไว้ |
| `http_3xx` | endpoint redirect ไปที่อื่น (ระบบไม่ follow) — ตั้ง URL ปลายทางสุดท้ายแทน |
| `blocked_destination:*` | URL resolve ไปยัง IP ภายใน หรือ resolve DNS ไม่ได้ (§ 8) |
| ข้อความ timeout/network | endpoint ตอบช้าเกิน 10 วินาที หรือเชื่อมต่อไม่ได้ |
| `internal_note_blocked` | ระบบยกเลิกการส่งเพราะข้อความไม่ใช่ `PUBLIC` — ปลอดภัยตามที่ออกแบบ ไม่ต้องดำเนินการใด ๆ |

แก้ต้นเหตุแล้วกด **Replay** เพื่อส่ง delivery นั้นซ้ำได้ (ระบบจะใช้ `id` เดิม ระบบของคุณจึง dedupe ได้)

---

**ดูเพิ่ม:** [Helpwise Public API Reference](./api.md) — สำหรับดึงรายละเอียด ticket เพิ่มเติมหลังได้รับ event
