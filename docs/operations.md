# Operations Runbook

This runbook covers environment configuration, database migrations, third-party
integrations, and the production deployment checklist for Helpwise.

## Environment Variables

Copy `.env.example` to `.env` and fill in the values below. Variables marked
**Required** must be set in production or the corresponding feature/route will reject
requests (or, for `AUTH_SECRET`, the app will fail to start).

| Variable | Required | Description | Example |
| --- | --- | --- | --- |
| `AUTH_SECRET` | **Yes** | Secret used to sign/verify session JWTs (HS256). **Must be at least 32 characters** — the app throws on startup otherwise. Generate with `openssl rand -base64 48`. | `Q3x...` (48+ char random string) |
| `DATABASE_URL` | **Yes** | Pooled PostgreSQL connection (pgbouncer, port `6543`). Used at runtime via the `@prisma/adapter-pg` driver adapter. | `postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres?pgbouncer=true` |
| `DIRECT_URL` | **Yes** | Direct PostgreSQL connection (port `5432`, no pooler). Used by `prisma migrate` / `prisma db seed`. | `postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres` |
| `NEXT_PUBLIC_ROOT_DOMAIN` | **Yes** | Root domain used for tenant subdomain routing (`{slug}.{domain}`). Never hardcode this elsewhere. | `helpwise.com` |
| `NEXT_PUBLIC_API_BASE_URL` | **Yes** | Base URL template shown to agents on the Settings → API Keys page. | `https://{slug}.helpwise.com` |
| `REDIS_URL` | **Yes** | Redis connection string (Upstash). Used for tenant-context cache, rate limiting, and BullMQ queues. | `rediss://default:[password]@[host].upstash.io:6379` |
| `STRIPE_SECRET_KEY` | **Yes** (if billing enabled) | Stripe server-side secret key. | `sk_test_...` / `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | **Yes** in production | Stripe webhook signing secret. Without it, `/api/webhooks/stripe` rejects all requests. | `whsec_...` |
| `EMAIL_PROVIDER` | No | `"postmark"` \| `"sendgrid"` \| empty. Empty = console stub (dev only — emails are logged, not sent). | `postmark` |
| `EMAIL_PROVIDER_API_KEY` | **Yes** if `EMAIL_PROVIDER` set | API key/token for the chosen email provider. | `xxxx` |
| `EMAIL_FROM_ADDRESS` | **Yes** if `EMAIL_PROVIDER` set | From-address for outbound email. | `support@helpwise.com` |
| `EMAIL_INBOUND_WEBHOOK_SECRET` | **Yes** in production | Shared secret for verifying inbound email webhooks (Postmark). Production rejects all requests if unset; dev allows with a warning. | `xxxx` |
| `SLA_SWEEP_SECRET` | **Yes** in production | Bearer secret for `POST /api/jobs/sla-sweep`. Production rejects requests if unset; dev allows with a warning. | `xxxx` |
| `NODE_ENV` | Set by platform | `development` \| `production`. Controls HSTS, CSP `unsafe-eval`, and several "allow in dev / reject in prod" checks. | `production` |

> Stripe Price IDs are **not** environment variables — they live on `Plan.stripePriceIdMonthly`
> / `Plan.stripePriceIdYearly` in the database and are set via `prisma/seed.ts`.

---

## Database & Migrations

Helpwise uses **Prisma 7** with Supabase PostgreSQL. The connection URL is **not** in
`schema.prisma` — it's configured in `prisma.config.ts`:

- **Runtime** (the app itself): `DATABASE_URL` (pooled, pgbouncer, port `6543`) via the
  `@prisma/adapter-pg` driver adapter (`src/lib/prisma.ts`).
- **Migrations / seed CLI**: `DIRECT_URL` (direct connection, port `5432`). Migrations
  require a direct connection and cannot run through the pgbouncer pooler.
- `prisma.config.ts` loads `.env` explicitly via `dotenv/config` — Prisma 7 does not
  auto-load `.env` for config files.

### Applying migrations

In **production / CI**, always use `migrate deploy` (non-interactive, no TTY required):

```bash
npx prisma migrate deploy
npx prisma generate
npx prisma db seed
```

> **Do not use `prisma migrate dev` in production or CI** — it requires an interactive
> TTY and is intended for local development only (`npm run db:migrate`).

### Local development

```bash
npm run db:migrate   # prisma migrate dev — creates new migrations interactively
npm run db:generate  # regenerate Prisma client after schema changes
npm run db:studio    # browse data with Prisma Studio
```

`prisma db seed` (configured to run `tsx prisma/seed.ts`) seeds reference data such as
`Plan` records and `FeatureFlag` defaults. Run it after every fresh migration in a new
environment.

---

## Redis

Redis (Upstash, `REDIS_URL`) is used for:

- **Tenant context cache** — subdomain → tenant lookup (`src/proxy.ts`)
- **Rate limiting** — fixed-window counters (`src/lib/rate-limit.ts`)
- **BullMQ queues** — async jobs (outbound email, SLA breach checks, inbound email processing)

Rate limiting is **fail-open**: if Redis is unreachable, requests are allowed through
rather than blocked. This means Redis downtime does not cause an outage, but it does
temporarily disable rate limiting and tenant-plan caching.

When a tenant's plan changes (see Billing below), the cached `x-tenant-plan` value in
Redis must be invalidated so the new plan takes effect immediately.

---

## Stripe Webhooks

The webhook endpoint is `POST /api/webhooks/stripe`. It is a cross-tenant system route
(no `x-tenant-id` context) that verifies the Stripe signature before touching the
database, and is idempotent via `ProcessedStripeEvent.eventId`.

### Local development

Use the Stripe CLI to forward events to your local server:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Copy the `whsec_...` value the CLI prints into `STRIPE_WEBHOOK_SECRET` in your `.env`.

### Production

1. In the Stripe Dashboard, add a webhook endpoint pointing to:
   `https://{your-root-domain}/api/webhooks/stripe`
2. Subscribe to subscription/invoice lifecycle events (subscription created/updated/deleted,
   invoice paid/payment failed, etc.).
3. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

> Without `STRIPE_WEBHOOK_SECRET` set, the endpoint rejects all requests with `400` outside
> of dev.

---

## Inbound Email Webhook

The inbound email endpoint is `POST /api/webhooks/email`. It is also a cross-tenant
system route — it has no `x-tenant-id` header and resolves the tenant itself from the
recipient address (e.g. `support@{slug}.helpwise.com`).

- Verified via `EMAIL_INBOUND_WEBHOOK_SECRET` (HTTP Basic Auth password or
  `X-Webhook-Secret` header, depending on provider configuration).
- Idempotent via `ProcessedInboundEmail` (unique on `tenantId` + `messageId`) — the
  email provider may deliver the same webhook more than once.
- All inbound messages are created with `visibility: PUBLIC` (never `INTERNAL`).

### Setup

1. In Postmark (or your configured provider), set the inbound webhook URL to:
   `https://{slug}.helpwise.com/api/webhooks/email`
2. Set `EMAIL_INBOUND_WEBHOOK_SECRET` to a shared secret and configure the provider to
   send it via Basic Auth or `X-Webhook-Secret`.

> In production, requests without a valid secret are rejected (`401`). In development,
> requests without a secret are allowed through with a console warning.

---

## SLA Sweep Cron

`POST /api/jobs/sla-sweep` is a cross-tenant system job that scans all tenants for SLA
breaches (first-response and resolution deadlines). It is intended to be called
periodically by an external scheduler (e.g. Vercel Cron, Upstash QStash).

- Authenticated via `SLA_SWEEP_SECRET` as a Bearer token (or `X-Sweep-Secret` header).
- In production, requests without a valid secret are rejected (`401`). In development,
  requests without a secret are allowed through with a console warning.
- The sweep is idempotent: a ticket already flagged as breached is not re-flagged on
  subsequent runs.
- The response contains only aggregate counts — no tenant-specific data is exposed.

Schedule example (cron syntax, run every 5 minutes):

```
*/5 * * * * curl -X POST https://your-app.example.com/api/jobs/sla-sweep \
  -H "Authorization: Bearer $SLA_SWEEP_SECRET"
```

---

## Trusted Proxy / `x-forwarded-for`

The pre-auth rate limiter for the public API (`getClientIp`, `src/lib/rate-limit.ts`)
keys on the client IP, read from the `x-forwarded-for` header (falling back to
`x-real-ip`, then `"unknown"`).

> **This assumes the app runs behind a trusted edge/proxy (e.g. Vercel) that overwrites
> `x-forwarded-for` with the real client IP and strips any client-supplied value.**
>
> If you self-host behind a custom reverse proxy, ensure that proxy strips/overwrites
> `x-forwarded-for` before forwarding to the app. Otherwise, a client can spoof their IP
> in this header and bypass IP-keyed rate limiting (this affects rate limiting only —
> not authentication or tenant isolation).

---

## Security Headers & CSP

Security headers are configured centrally in `next.config.ts` and applied to all routes:
`Referrer-Policy`, `Content-Security-Policy`, `X-Content-Type-Options`,
`X-Frame-Options`, `Permissions-Policy`, and (production only) `Strict-Transport-Security`
(HSTS, `max-age=63072000; includeSubDomains; preload`).

Notes:

- The CSP includes `script-src 'self' 'unsafe-inline'` (plus `'unsafe-eval'` in
  development for HMR). The `'unsafe-inline'` is required for Next.js's inline hydration
  scripts.
- **Known limitation — nonce-based CSP is not feasible with the current architecture.**
  A nonce-based CSP (`script-src 'nonce-…' 'strict-dynamic'`) was implemented and tested,
  but Next.js's automatic nonce propagation does **not** work when the nonce/CSP is set
  from `src/proxy.ts` (the Next.js 16.2 Node-runtime proxy this project uses for tenant
  resolution, instead of `middleware.ts`). Verified empirically: the per-request CSP
  header carried a valid nonce, but Next emitted statically-rendered pages whose
  `<script>` tags had **no** `nonce` attribute (0 of 17 on `/login`) — under
  `'strict-dynamic'` every script is then blocked and the app breaks at runtime (the
  production build still succeeds, so this is not caught by `next build`). Removing
  `'unsafe-inline'` for scripts therefore requires either forcing app-wide dynamic
  rendering (losing static optimization, and still unverified through `proxy.ts`) or a
  separate Edge `middleware.ts` layer for CSP — both deferred. The remaining CSP
  directives (`object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`,
  `form-action 'self'`) still meaningfully reduce attack surface.
- `img-src` allows `https:`/`data:`/`blob:` because the customer portal renders
  tenant-supplied logos/branding from arbitrary external hosts.
- HSTS is only sent when `NODE_ENV=production`, so local development over HTTP is not
  penalized by browser HSTS caching.

---

## Production Deployment Checklist

Before deploying (or promoting) to production:

- [ ] All **Required** environment variables from the table above are set, including
      `AUTH_SECRET` (≥ 32 characters, generated via `openssl rand -base64 48`)
- [ ] `DATABASE_URL` points to the **pooled** (port `6543`) connection string, and
      `DIRECT_URL` to the **direct** (port `5432`) connection string
- [ ] `npx prisma migrate deploy` has been run against the target database
- [ ] `npx prisma db seed` has been run (plans, feature flags present)
- [ ] `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are set, and the Stripe Dashboard
      webhook endpoint is configured and pointing at this deployment
- [ ] `EMAIL_INBOUND_WEBHOOK_SECRET` is set and the email provider's inbound webhook is
      configured with the matching secret
- [ ] `SLA_SWEEP_SECRET` is set and the external scheduler is configured to call
      `POST /api/jobs/sla-sweep` with it
- [ ] `NODE_ENV=production` is set (enables HSTS and removes `'unsafe-eval'` from CSP)
- [ ] The deployment runs behind a trusted proxy/edge that overwrites `x-forwarded-for`
      (see above)
- [ ] `NEXT_PUBLIC_ROOT_DOMAIN` and `NEXT_PUBLIC_API_BASE_URL` match the production domain
