# Helpwise Public API Reference

The Helpwise public REST API lets you manage support tickets programmatically. It is
available to tenants on the **Enterprise** plan.

- **Base URL:** `https://{slug}.{ROOT_DOMAIN}/api/v1` — replace `{slug}` with your
  tenant's subdomain (e.g. `acme`) and `{ROOT_DOMAIN}` with your Helpwise domain
  (e.g. `gethelpwise.xyz`), so `https://acme.gethelpwise.xyz/api/v1`.
- **Format:** All requests and responses use JSON.
- **Versioning:** The current version is `v1`.

## Authentication

All `/api/v1/*` endpoints require an API key, sent as a Bearer token:

```
Authorization: Bearer hw_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Getting an API key

1. Log in to the Helpwise agent workspace for your tenant.
2. Go to **Settings → API Keys**.
3. Click **Create API Key**, give it a name, and copy the generated key.

> **The plaintext key is shown only once, at creation time.** Helpwise stores only a hash
> of the key — if you lose it, revoke it and create a new one.

Requirements:

- Your account must have the **OWNER** or **ADMIN** role for the tenant.
- Your tenant's plan must include the `api_access` feature (Enterprise plan).
- API keys are managed through the agent workspace UI (`/api/api-keys`), which uses your
  agent session — not the Bearer-token auth described here.

### Authentication errors

| Status | `error.code` | Cause |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | Missing `Authorization` header, malformed header, or invalid/revoked API key |
| 403 | `FORBIDDEN` | The tenant's current plan does not include `api_access` |

## Rate Limits

Two layers of rate limiting apply, both backed by Redis with a fixed 60-second window:

| Layer | Limit | Keyed by |
| --- | --- | --- |
| Pre-authentication | 100 requests / 60s | Client IP (before the API key is checked) |
| Per API key | 120 requests / 60s | API key ID |

When a limit is exceeded, the API returns:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 42
Content-Type: application/json

{
  "data": null,
  "error": {
    "code": "RATE_LIMITED",
    "message": "..."
  }
}
```

The `Retry-After` header (seconds) tells you how long to wait before retrying.

## Response Envelope

Every response — success or error — follows the same shape:

```json
{
  "data": { },
  "error": null
}
```

On error, `data` is `null` and `error` contains a machine-readable `code` and a
human-readable `message`:

```json
{
  "data": null,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "subject ต้องมีอย่างน้อย 3 ตัวอักษร"
  }
}
```

### Error codes

| HTTP status | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_JSON` | Request body is not valid JSON |
| 400 | `VALIDATION_ERROR` | Request body or query parameters failed validation |
| 400 | `CONTACT_NOT_FOUND` | `requesterContactId` does not belong to this tenant |
| 401 | `UNAUTHORIZED` | API key missing, invalid, or revoked |
| 403 | `FORBIDDEN` | Plan does not include `api_access` |
| 404 | `NOT_FOUND` | Resource does not exist (or belongs to another tenant) |
| 429 | `RATE_LIMITED` | Rate limit exceeded — see `Retry-After` header |

## Enums

**Ticket status** (`status`):

```
NEW | OPEN | PENDING | ON_HOLD | SOLVED | CLOSED
```

**Ticket priority** (`priority`):

```
LOW | NORMAL | HIGH | URGENT
```

---

## Endpoints

### `GET /api/v1/tickets`

List tickets for your tenant, with optional filters and pagination.

#### Query parameters

| Parameter | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `status` | string | No | — | One of the ticket status enum values |
| `priority` | string | No | — | One of the ticket priority enum values |
| `page` | integer | No | `1` | Minimum `1` |
| `limit` | integer | No | `20` | Minimum `1`, maximum `100` |

#### Example request

```bash
curl -s "https://acme.gethelpwise.xyz/api/v1/tickets?status=OPEN&priority=HIGH&page=1&limit=20" \
  -H "Authorization: Bearer hw_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

#### Example response — `200 OK`

```json
{
  "data": {
    "tickets": [
      {
        "id": "clx1a2b3c4d5e6f7g8h9i0j1",
        "ticketNumber": 1024,
        "subject": "Cannot access invoice history",
        "status": "OPEN",
        "priority": "HIGH",
        "createdAt": "2026-06-01T08:30:00.000Z",
        "updatedAt": "2026-06-02T10:15:00.000Z",
        "requester": {
          "email": "jane@customer.com",
          "name": "Jane Doe"
        }
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 1,
      "totalPages": 1
    }
  },
  "error": null
}
```

`requester` is `null` if the ticket has no associated contact.

---

### `GET /api/v1/tickets/:id`

Get a single ticket, including its public messages.

> Internal notes (`visibility: INTERNAL`) are **never** returned by this endpoint —
> only messages with `visibility: PUBLIC` are included.

#### Path parameters

| Parameter | Type | Description |
| --- | --- | --- |
| `id` | string | Ticket ID |

#### Example request

```bash
curl -s "https://acme.gethelpwise.xyz/api/v1/tickets/clx1a2b3c4d5e6f7g8h9i0j1" \
  -H "Authorization: Bearer hw_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

#### Example response — `200 OK`

```json
{
  "data": {
    "id": "clx1a2b3c4d5e6f7g8h9i0j1",
    "ticketNumber": 1024,
    "subject": "Cannot access invoice history",
    "status": "OPEN",
    "priority": "HIGH",
    "createdAt": "2026-06-01T08:30:00.000Z",
    "updatedAt": "2026-06-02T10:15:00.000Z",
    "requester": {
      "email": "jane@customer.com",
      "name": "Jane Doe"
    },
    "messages": [
      {
        "id": "clxm1message0001",
        "body": "I can't see any of my past invoices on the billing page.",
        "createdAt": "2026-06-01T08:30:00.000Z",
        "author": {
          "type": "contact",
          "name": "Jane Doe"
        }
      },
      {
        "id": "clxm1message0002",
        "body": "Thanks for reaching out — looking into this now.",
        "createdAt": "2026-06-01T09:00:00.000Z",
        "author": {
          "type": "agent",
          "name": "Alex Smith"
        }
      }
    ]
  },
  "error": null
}
```

#### Example response — `404 Not Found`

```json
{
  "data": null,
  "error": {
    "code": "NOT_FOUND",
    "message": "ไม่พบ ticket ที่ระบุ"
  }
}
```

This is also returned if the ticket belongs to a different tenant.

---

### `POST /api/v1/tickets`

Create a new ticket.

#### Body parameters

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `subject` | string | Yes | 3–200 characters |
| `requesterEmail` | string | One of `requesterEmail` / `requesterContactId` required | Email of the requesting contact. If no contact with this email exists for the tenant, one is created. |
| `requesterContactId` | string | One of `requesterEmail` / `requesterContactId` required | ID of an existing contact belonging to your tenant |
| `requesterName` | string | No | Used as the contact's name if a new contact is created (or to fill in a missing name on an existing contact) |
| `priority` | string | No | One of the ticket priority enum values. Defaults to the tenant's default priority if omitted. |
| `message` | object | No | `{ "body": "..." }` — initial message body, 1–50,000 characters |

> Messages created via the API are always `visibility: PUBLIC`. The API cannot create
> internal notes.

#### Example request

```bash
curl -s -X POST "https://acme.gethelpwise.xyz/api/v1/tickets" \
  -H "Authorization: Bearer hw_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "subject": "Cannot access invoice history",
    "requesterEmail": "jane@customer.com",
    "requesterName": "Jane Doe",
    "priority": "HIGH",
    "message": {
      "body": "I can'\''t see any of my past invoices on the billing page."
    }
  }'
```

#### Example response — `201 Created`

```json
{
  "data": {
    "id": "clx1a2b3c4d5e6f7g8h9i0j1",
    "ticketNumber": 1025,
    "subject": "Cannot access invoice history",
    "status": "NEW",
    "priority": "HIGH",
    "createdAt": "2026-06-11T12:00:00.000Z",
    "updatedAt": "2026-06-11T12:00:00.000Z",
    "requester": {
      "email": "jane@customer.com",
      "name": "Jane Doe"
    }
  },
  "error": null
}
```

#### Example response — `400 Bad Request` (validation error)

```json
{
  "data": null,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "subject ต้องมีอย่างน้อย 3 ตัวอักษร"
  }
}
```

#### Example response — `400 Bad Request` (unknown contact)

```json
{
  "data": null,
  "error": {
    "code": "CONTACT_NOT_FOUND",
    "message": "ไม่พบ contact ที่ระบุใน workspace นี้"
  }
}
```

---

## Managing API Keys

API keys are managed through the agent workspace UI under **Settings → API Keys**
(`/api/api-keys`), which is session-authenticated and restricted to **OWNER**/**ADMIN**
roles. This is separate from the Bearer-token authentication used by the `/api/v1`
endpoints above.

- Creating a key returns the plaintext value once — store it securely.
- Revoking a key takes effect immediately; subsequent requests with that key return
  `401 UNAUTHORIZED`.
