# Helpwise Outbound Webhooks

A guide for developers who need to build an endpoint that receives webhooks from Helpwise

Outbound webhooks are how Helpwise **sends an HTTP POST to your system** every time something
happens to a ticket in your workspace (a new ticket is created, a status changes, a new message
arrives, and so on) — use them instead of polling `GET /api/v1/tickets` on a schedule. They fit
well for syncing data into an internal system, pushing notifications into Slack, or triggering
your own automation.

- **Direction:** Helpwise → your system (outbound only — this is not the inbound email webhook)
- **Required plan:** the `webhooks` feature — **pro** plan and above
- **Permission to configure:** a workspace member with the **OWNER** or **ADMIN** role
- **Format:** `POST` · `Content-Type: application/json` · the body is the same envelope for every event

> If your workspace plan is downgraded below pro, Helpwise **stops sending webhooks immediately**
> without deleting the endpoints you configured — once you upgrade again, sending resumes (events
> that happened in between are not sent retroactively).

---

## 1. Getting started

1. Log in to your agent workspace (`https://{slug}.gethelpwise.xyz`).
2. Go to **Settings → Webhooks**.
3. Click **Create endpoint** and fill in:
   - **Description** — a name that helps you tell endpoints apart (1–80 characters)
   - **URL** — the destination that receives the POST. It must be `https://` and reachable from
     the public internet (see the limits in [§ 8](#8-destination-url-requirements)).
   - **Events** — select at least one event to subscribe to
4. Copy the **signing secret** (`whsec_…`) shown after the endpoint is created.

> ⚠️ **The signing secret is shown only once**, at creation time (and when you click rotate).
> Store it in your secret manager / env var immediately. If you lose it, click **Rotate secret**
> to generate a new value (the old value stops working immediately).

From then on the endpoint starts receiving events right away. You can review every delivery under
**Settings → Webhooks → Deliveries** (it shows the HTTP status, the first 500 characters of the
response body that Helpwise stores, and the error message).

To pause an endpoint, toggle `enabled` — Helpwise stops sending but keeps the delivery history.

---

## 2. Events

| Event (`type`) | Sent when |
| --- | --- |
| `ticket.created` | A new ticket is created (by an agent, by a customer through the portal, through `POST /api/v1/tickets`, or by an inbound email that opens a new ticket) |
| `ticket.status_changed` | The status of a ticket actually changes |
| `ticket.assigned` | The assignee of a ticket actually changes |
| `ticket.priority_changed` | The priority of a ticket actually changes |
| `ticket.message_created` | A new public message is added to the thread — from an agent replying in the workspace, a customer replying through the portal, or an inbound customer email. **Only `visibility: PUBLIC`** |

Important notes

- Every channel emits events: the agent workspace · the customer portal · `POST /api/v1/tickets` ·
  inbound email. Use `channel` in the payload (`portal` / `email` / `api` / `agent`) to tell where
  the event came from, and `message.authorType` (`agent` / `contact`) to tell who wrote the message.
- If you change several fields in a single update (for example both status and priority), you get
  **several separate events, each with its own `id`** — not one event that bundles every change.
- Events are sent only to endpoints that have `enabled = true` and subscribe to that event.
- The enum values for `status` / `priority` match the [Public API Reference](./api.md#enums):
  `NEW | OPEN | PENDING | ON_HOLD | SOLVED | CLOSED` and `LOW | NORMAL | HIGH | URGENT`

### Envelope

Every event uses the same structure; only `data` differs by `type`.

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Event ID — use it as your **idempotency key** (matches the `X-Helpwise-Event-Id` header) |
| `type` | string | The event name from the table above |
| `createdAt` | string | ISO 8601 UTC — when the event happened |
| `tenantId` | string | ID of the workspace that owns the event |
| `data` | object | The event details |

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

`channel` tells you how the ticket came in, for example `portal`, `email`, `api`, `agent`.
`assigneeMemberId` can be `null` while nobody owns the ticket yet.
`ticket.created` has **no** `changes` field.

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

`data.ticket` is the snapshot **after** the change, while `changes` gives the before/after values
of the fields that changed.

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

`assigneeMemberId` is the ID of a workspace member (not a global user ID).

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

- `data.ticket` in this event is a short form — it only has `id`, `ticketNumber`, `subject`
- `message.visibility` is always `"PUBLIC"` (see [§ 9](#9-what-helpwise-never-sends))
- `message.authorType` is either `"agent"` or `"contact"`, and `message.authorId` is the member ID
  or the contact ID depending on `authorType`

---

## 3. HTTP headers you receive

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `User-Agent` | `Helpwise-Webhooks/1.0` |
| `X-Helpwise-Event` | The event name, for example `ticket.created` (matches `type` in the body) |
| `X-Helpwise-Event-Id` | Event ID (matches `id` in the body) — use it to dedupe |
| `X-Helpwise-Delivery-Id` | ID of this delivery — different for each endpoint that receives the same event |
| `X-Helpwise-Attempt` | Attempt number, starting at `1`, up to `5` |
| `X-Helpwise-Signature` | HMAC signature in the form `t=<unixSeconds>,v1=<hexHmac>` |

---

## 4. Verifying the signature

**Verify every request** before you process it. Otherwise anyone who knows your URL can forge events.

### Scheme

```
signedPayload = "{t}.{rawBody}"
v1            = HMAC_SHA256(secret, signedPayload)   →  lowercase hex
header        = "t={t},v1={v1}"
```

- `t` = the unix timestamp (whole seconds) at which Helpwise signed and sent this request
- `rawBody` = the **raw** request body, byte for byte
- `secret` = the whole signing secret string including the `whsec_` prefix (interpreted as UTF-8)
- `v1` = the HMAC-SHA256 as 64 lowercase hex characters

> ⚠️ **The three most common mistakes**
> 1. **You must use the raw body** — do not `JSON.parse` and then `JSON.stringify` before signing.
>    Key order or whitespace can change, and a single different byte breaks the signature
>    (in Express you need `express.raw()`).
> 2. **Compare in constant time** (`crypto.timingSafeEqual`, `hmac.compare_digest`), not with `===`.
> 3. **Reject timestamps that are too old** — the recommended value is **300 seconds**, to prevent
>    replay attacks.

### Node.js / TypeScript example

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

/** The same value Helpwise recommends — 5 minutes */
const TOLERANCE_SECONDS = 300;

interface ParsedSignature {
  t: number;
  v1: string;
}

/** Parse the "t=...,v1=..." header — returns null when the format is wrong */
function parseSignatureHeader(header: string): ParsedSignature | null {
  let t: number | null = null;
  let v1: string | null = null;

  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === "t" && /^\d+$/.test(value)) t = Number(value);
    // v1 must be a sha256 hex digest (64 chars) — anything else is malformed
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

  // replay window — stops an old but correctly signed request from being resent
  if (Math.abs(nowSeconds - parsed.t) > TOLERANCE_SECONDS) return false;

  const expected = Buffer.from(
    createHmac("sha256", secret)
      .update(`${parsed.t}.${rawBody}`)
      .digest("hex"),
    "utf8"
  );
  const actual = Buffer.from(parsed.v1, "utf8");

  // timingSafeEqual throws when the lengths differ, so check length first
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
```

Here is how to wire it up with Express — note `express.raw()`, which makes `req.body` a `Buffer`
instead of an object.

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

    // Respond 2xx right away, then process asynchronously (the Helpwise timeout is 10 seconds)
    res.status(200).send("ok");
    void enqueueForProcessing(event);
  }
);
```

### Python example

```python
import hashlib
import hmac
import re
import time

TOLERANCE_SECONDS = 300
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def parse_signature_header(header: str):
    """Parse the 't=...,v1=...' header — returns None when the format is wrong"""
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

Here is how to use it with Flask (`request.get_data()` returns the raw bytes before JSON parsing).

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
    enqueue_for_processing(event)   # process outside the request
    return "ok", 200
```

---

## 5. Idempotency

Helpwise guarantees **at-least-once** delivery, not exactly-once — you may receive the same event
again on a retry, when your endpoint answers so slowly that it times out even though it did process
the event, or when an admin replays it from the DLQ.

How to handle it: use the envelope's **`id`** (the same value as the `X-Helpwise-Event-Id` header)
as your idempotency key.

- Store every `id` you have processed successfully (in a table / Redis with a unique index) — when
  you see it again, respond `200` and skip.
- **A retry of the same event always reuses the same `id`**, including a replay from the DLQ.
- If one event goes to several endpoints, every endpoint receives the **same** `id` but a
  **different** `X-Helpwise-Delivery-Id` — if you dedupe across several endpoints together, key on
  the pair `(your endpoint, id)` rather than on `id` alone.
- Helpwise **does not guarantee ordering** of events — sort them yourself using `createdAt`, and
  check whether the state you already have is newer before you overwrite it.

---

## 6. Retries and the DLQ

| Result from your endpoint | How Helpwise reads it |
| --- | --- |
| `2xx` | Success — done, no retry |
| `3xx` | **Failure** — Helpwise does not follow redirects |
| `4xx` / `5xx` | Failure — retried |
| No response within **10 seconds** | Failure (timeout) — retried |
| Connection error / TLS error | Failure — retried |

- Helpwise sends at most **5 attempts per delivery** (the first attempt plus 4 retries), spaced by
  the backoff of the internal queue. Check the current attempt number in the `X-Helpwise-Attempt`
  header.
- After 5 attempts without success, the delivery moves to the **`DEAD`** status (it enters the
  dead-letter queue) and automatic retries stop.
- A `DEAD` delivery (as well as one still stuck in `FAILED`/`PENDING`) **can be replayed manually**
  from **Settings → Webhooks → Deliveries**. Helpwise resends the original payload (the snapshot
  taken when the event happened — it does not re-query the data) with the same `id`, but the
  signature and `t` belong to the new attempt.

> 💡 **Respond 2xx as fast as you can** — the timeout is 10 seconds. Verify the signature, push the
> event onto your own queue, respond `200` immediately, then do the real processing asynchronously.
> Heavy work (calling other APIs, writing to several tables) done inline risks a timeout, which
> turns into unnecessary retries.
>
> If you deliberately want to "drop" an event you do not care about, respond `200`, not `4xx` —
> a `4xx` counts as a failure and is retried until it lands in the DLQ.

---

## 7. Managing endpoints through the API

Besides the Settings page, you can manage endpoints through a REST API. This API uses your **agent
session** (not the Bearer API key of [`/api/v1`](./api.md#authentication)) and is restricted to the
**OWNER**/**ADMIN** roles on a plan that includes the `webhooks` feature. Every response uses the
`{ data, error }` shape, like the rest of the Helpwise API.

| Method + path | Purpose |
| --- | --- |
| `GET /api/webhook-endpoints` | List every endpoint (**does not return** the signing secret) |
| `POST /api/webhook-endpoints` | Create an endpoint — returns `{ endpoint, plaintextSecret }` once |
| `PATCH /api/webhook-endpoints/{id}` | Update description / url / events / enabled |
| `DELETE /api/webhook-endpoints/{id}` | Delete an endpoint together with its delivery history |
| `POST /api/webhook-endpoints/{id}/rotate-secret` | Rotate the secret — returns the new value once |
| `GET /api/webhook-deliveries?endpointId=&status=` | Review the delivery history (DLQ = `status=DEAD`) |
| `POST /api/webhook-deliveries/{id}/replay` | Resend a delivery that has not succeeded |

Common error codes

| Status | `error.code` | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | The body failed validation (for example, no event was selected) |
| 400 | `INVALID_WEBHOOK_URL` | The destination URL does not meet the requirements in § 8 |
| 403 | `FEATURE_LOCKED` | The current plan does not include the `webhooks` feature |
| 409 | `ALREADY_SUCCEEDED` | You tried to replay a delivery that already succeeded |

> `/api/webhooks/*` is the route group for **inbound** webhooks (Stripe, inbound email) that
> Helpwise receives — a different set from the outbound webhooks in this document. Do not mix them up.

---

## 8. Destination URL requirements

Helpwise is the party sending HTTP requests to the URL you enter, so it enforces strict SSRF
protection. Your destination URL must:

- use the **`https`** scheme only, on port **443** (or with no port specified)
- point at a **public** host that resolves from the internet

URLs that are always rejected

- IPs or hostnames that point at an internal network: `127.0.0.0/8`, `0.0.0.0/8`, `10.0.0.0/8`,
  `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (including the cloud metadata address
  `169.254.169.254`), `100.64.0.0/10`
- Internal IPv6: `::1`, `fc00::/7`, `fe80::/10`, and the IPv4-mapped forms of the ranges above
- The hostnames `localhost`, `*.localhost`, `*.internal`, `metadata.google.internal`

The check runs at **2 points**: when you create or update the endpoint, and **before every actual
send, after DNS resolution** (to stop DNS rebinding). If your domain is later repointed at an
internal IP, that delivery is marked **`DEAD` immediately with no retry**, with the error
`blocked_destination`.

Other limits worth knowing

- **Redirects are not followed** — a `3xx` response counts as a failure, so configure the final
  destination URL from the start.
- You cannot set custom headers — authenticate using the secret through the signature instead
  (if you need an extra token, you can put it in the URL path).
- The TLS certificate must be valid.

---

## 9. What Helpwise never sends

- **Internal notes are never sent through a webhook, under any circumstances** — the
  `ticket.message_created` event fires only for messages with `visibility: PUBLIC` (Helpwise filters
  when it builds the event and checks again right before the actual send; if it finds a message that
  is not PUBLIC, it cancels the delivery instead of sending it).
- **No contact PII in the payload** — no email address, name, or phone number of the requester, only
  `requesterContactId` / `authorId` so you can look them up through the [Public API](./api.md) if
  you need to.
- **No attachments** — the payload contains no attached files and no attachment URLs.
- **No data from other workspaces** — your endpoint receives only events for its own `tenantId`.
- The payload contains no API keys, secrets, or credentials of any kind.

---

## 10. Troubleshooting

**Signature verification fails on every request**

1. Check that you really use the **raw body** — the number one cause is a framework that already
   parsed the JSON (Express needs `express.raw({ type: "application/json" })`, placed before
   `express.json()` for this path; a Next.js route handler needs `await request.text()`, not
   `await request.json()`).
2. Check that you take `t` **from the header** to build `"{t}.{rawBody}"`, not the current time of
   your own machine.
3. Check that the secret you use includes the full `whsec_` prefix and has no whitespace or newline
   picked up while copying.
4. If you clicked **Rotate secret**, the old value no longer works — update the secret in your system.

**The signature used to pass but sometimes fails**

Your server clock may have drifted, pushing `|now - t|` past 300 seconds — enable NTP sync.

**No events arrive at all**

1. The endpoint is disabled (`enabled = false`) or has been deleted.
2. You did not subscribe to that event type when you created it — fix it under Settings → Webhooks.
3. The workspace plan is below **pro** — Helpwise goes silent immediately and no delivery is created
   at all.
4. The change did not qualify. For example, a PATCH that sends the same values (no real change) does
   not fire an event, and a message that is an internal note does not fire `ticket.message_created`.

**A delivery shows the `DEAD` status**

Check `responseStatus` / `errorMessage` on the Deliveries page.

| `errorMessage` | Cause |
| --- | --- |
| `http_4xx` / `http_5xx` | The endpoint returned non-2xx for all 5 attempts — check the response body Helpwise stored |
| `http_3xx` | The endpoint redirects elsewhere (Helpwise does not follow) — configure the final destination URL instead |
| `blocked_destination:*` | The URL resolves to an internal IP, or DNS resolution failed (§ 8) |
| A timeout/network message | The endpoint took longer than 10 seconds to respond, or was unreachable |
| `internal_note_blocked` | Helpwise cancelled the send because the message was not `PUBLIC` — this is safe and by design, no action needed |

Once you fix the root cause, click **Replay** to resend that delivery (Helpwise reuses the same
`id`, so your system can still dedupe).

---

**See also:** [Helpwise Public API Reference](./api.md) — for pulling extra ticket details after you
receive an event
