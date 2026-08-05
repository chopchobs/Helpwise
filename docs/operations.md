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
| `NEXT_PUBLIC_ROOT_DOMAIN` | **Yes** | Root domain used for tenant subdomain routing (`{slug}.{domain}`). Never hardcode this elsewhere. | `gethelpwise.xyz` |
| `NEXT_PUBLIC_API_BASE_URL` | **Yes** | Base URL template shown to agents on the Settings → API Keys page. | `https://{slug}.gethelpwise.xyz` |
| `NEXT_PUBLIC_SUPABASE_URL` | **Yes** for realtime presence | Supabase project URL the browser client uses to connect to Realtime presence. **Build-time inlined** — see the note below the table. | `https://[ref].supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Yes** for realtime presence | Supabase anon key (safe to expose to the browser; the actual channel token is minted by `/api/realtime/token`). If unset, presence is disabled **silently** (fail-soft) — no error is surfaced. **Build-time inlined**. | `eyJ...` |
| `SUPABASE_REALTIME_JWT_PRIVATE_KEY` | **Yes** for realtime presence | Server-only PEM private key (EC P-256, alg `ES256`) used to sign short-lived tenant-scoped Realtime tokens. If unset, `/api/realtime/token` returns `500` and the client swallows the error — presence dies silently. Never expose to the client. | `-----BEGIN PRIVATE KEY-----...` |
| `SUPABASE_REALTIME_JWT_KID` | **Yes** for realtime presence | Key id of the signing key above, sent in the JWT header so Supabase picks the right verification key. | `xxxx` |
| `REDIS_URL` | **Yes** | Redis connection string (Upstash). Used for tenant-context cache and rate limiting. (Async jobs use Upstash QStash, not Redis.) | `rediss://default:[password]@[host].upstash.io:6379` |
| `STRIPE_SECRET_KEY` | **Yes** (if billing enabled) | Stripe server-side secret key. | `sk_test_...` / `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | **Yes** in production | Stripe webhook signing secret. Without it, `/api/webhooks/stripe` rejects all requests. | `whsec_...` |
| `EMAIL_PROVIDER` | No | `"postmark"` \| `"sendgrid"` \| empty. Empty = console stub (dev only — emails are logged, not sent). | `postmark` |
| `EMAIL_PROVIDER_API_KEY` | **Yes** if `EMAIL_PROVIDER` set | API key/token for the chosen email provider. | `xxxx` |
| `EMAIL_FROM_ADDRESS` | **Yes** if `EMAIL_PROVIDER` set | From-address for outbound email. | `support@gethelpwise.xyz` |
| `EMAIL_INBOUND_WEBHOOK_SECRET` | **Yes** in production | Shared secret for verifying inbound email webhooks (Postmark). Production rejects all requests if unset; dev allows with a warning. | `xxxx` |
| `QSTASH_TOKEN` | **Yes** in production | Upstash QStash token for publishing background jobs (outbound email, etc.). | `xxxx` |
| `QSTASH_CURRENT_SIGNING_KEY` / `QSTASH_NEXT_SIGNING_KEY` | **Yes** in production | QStash signing keys used to verify job requests (incl. `POST /api/jobs/sla-sweep`). Production rejects unsigned requests; dev allows with a warning. Both support key rotation. | `sig_...` |
| `QSTASH_TARGET_BASE_URL` | **Yes** in production | Public origin QStash calls back into worker routes, e.g. `https://acme.gethelpwise.xyz`. | `https://...` |
| `NODE_ENV` | Set by platform | `development` \| `production`. Controls HSTS, CSP `unsafe-eval`, and several "allow in dev / reject in prod" checks. | `production` |

> **`NEXT_PUBLIC_*` variables are build-time inlined** into the client bundle — they are not
> read at runtime. Setting or changing one on Vercel only takes effect after a **redeploy**,
> and it can only be verified against the **deployed artifact** (`npm run scan:bundle`, which
> scans `.next/static`). Do **not** use a server-side readiness/health endpoint to confirm
> them: that endpoint reads `process.env` at runtime and will report "configured" while the
> deployed bundle still has no value — a false PASS. This is exactly how realtime presence
> stayed dead on production for a month without a single error.

> Stripe Price IDs are **not** environment variables — they live on `Plan.stripePriceIdMonthly`
> / `Plan.stripePriceIdYearly` in the database and are set via `prisma/seed.ts`.

### Emergency bypass: `SCAN_BUNDLE_SKIP_REQUIRED`

`npm run scan:bundle` runs as part of the production build and fails the build when a
**required** `NEXT_PUBLIC_*` value is missing from `.next/static`, so a red scan blocks
every deploy — including an urgent hotfix. To ship anyway, set
`SCAN_BUNDLE_SKIP_REQUIRED=1` on Vercel (scope: **Production**) and redeploy. This is the
only supported bypass — do not invent another flag name, comment the script out, or edit
the build command. It disables **only** the REQUIRED-value check; the secret-leak
(FORBIDDEN) check still runs and **must never be bypassed** — a build that leaks a server
secret into the client bundle is not shippable under any deadline. The bypass does not skip
the scan: the script still scans the artifact and prints the missing values, then prints
`⚠️⚠️⚠️ [scan:bundle] GATE OVERRIDDEN — SCAN_BUNDLE_SKIP_REQUIRED=1 ⚠️⚠️⚠️` and exits `0`.
That warning is the audit trail the post-merge gate reads back, so never suppress it.

Use it for urgent hotfixes only, and treat it as an incident with an owner and an expiry —
not an open-ended deferral:

1. Set `SCAN_BUNDLE_SKIP_REQUIRED=1` (Production) → redeploy → ship the hotfix.
2. Fix the underlying missing/stale `NEXT_PUBLIC_*` value (set it on Vercel, then redeploy
   so it is inlined into a fresh artifact).
3. **Remove the env var immediately after the hotfix is out**, redeploy, and confirm the
   build log shows `✅ [scan:bundle] สะอาด …` **including the `และยืนยัน … ค่า NEXT_PUBLIC_*`
   clause** and no `GATE OVERRIDDEN` line. A bypassed build omits that clause on purpose —
   it verified nothing.
4. Record who set it and the date it must be gone by. A bypass left in place is a live bug
   that nobody is counting yet — the `/portal` 404 shipped that way, as a TODO with no
   expiry date.

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

> Async jobs (outbound email, SLA breach sweep) run on **Upstash QStash**, not Redis — see "SLA Sweep Cron" below.

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
recipient address (e.g. `support@{slug}.gethelpwise.xyz`).

- Verified via `EMAIL_INBOUND_WEBHOOK_SECRET` (HTTP Basic Auth password or
  `X-Webhook-Secret` header, depending on provider configuration).
- Idempotent via `ProcessedInboundEmail` (unique on `tenantId` + `messageId`) — the
  email provider may deliver the same webhook more than once.
- All inbound messages are created with `visibility: PUBLIC` (never `INTERNAL`).

### Setup

1. In Postmark (or your configured provider), set the inbound webhook URL to:
   `https://{slug}.gethelpwise.xyz/api/webhooks/email`
2. Set `EMAIL_INBOUND_WEBHOOK_SECRET` to a shared secret and configure the provider to
   send it via Basic Auth or `X-Webhook-Secret`.

> In production, requests without a valid secret are rejected (`401`). In development,
> requests without a secret are allowed through with a console warning.

---

## SLA Sweep Cron

`POST /api/jobs/sla-sweep` is a cross-tenant system job that scans all tenants for SLA
breaches (first-response and resolution deadlines). It is intended to be called
periodically by an **Upstash QStash schedule**.

- Authenticated via **QStash signature verification** (`QSTASH_CURRENT_SIGNING_KEY` /
  `QSTASH_NEXT_SIGNING_KEY`). There is no separate sweep secret.
- In production, requests with an invalid/missing signature are rejected (`401`,
  fail-closed). In development, requests are allowed through with a console warning.
- The sweep is idempotent: a ticket already flagged as breached is not re-flagged on
  subsequent runs.
- The response contains only aggregate counts — no tenant-specific data is exposed.

Schedule: create a QStash schedule that `POST`s to
`{QSTASH_TARGET_BASE_URL}/api/jobs/sla-sweep` (e.g. every 5 minutes). QStash signs each
request automatically; no manual `Authorization` header is needed.

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
- [ ] `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, and
      `QSTASH_TARGET_BASE_URL` are set, and a QStash schedule is configured to call
      `POST /api/jobs/sla-sweep`
- [ ] `NODE_ENV=production` is set (enables HSTS and removes `'unsafe-eval'` from CSP)
- [ ] The deployment runs behind a trusted proxy/edge that overwrites `x-forwarded-for`
      (see above)
- [ ] `NEXT_PUBLIC_ROOT_DOMAIN` and `NEXT_PUBLIC_API_BASE_URL` match the production domain
- [ ] `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
      `SUPABASE_REALTIME_JWT_PRIVATE_KEY`, and `SUPABASE_REALTIME_JWT_KID` are set (realtime
      presence fails **silently** without them)
- [ ] Every `NEXT_PUBLIC_*` value was set **before** the current build, and the deployment has
      been **redeployed** since the last change — verified against the artifact with
      `npm run scan:bundle`, not via a server endpoint
