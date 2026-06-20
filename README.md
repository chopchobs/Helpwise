# Helpwise

Helpwise is a multi-tenant SaaS help desk / ticketing platform for B2B companies. Each
tenant (customer company) gets an internal agent workspace and a public customer portal,
fully isolated from other tenants via a shared-database, shared-schema architecture
(`tenantId`-scoped queries on every tenant model).

## Tech Stack

- **Framework:** Next.js 16.2 (App Router) + TypeScript
- **Database:** Prisma 7 + PostgreSQL (Supabase)
- **Styling:** Tailwind CSS v4
- **UI:** Shadcn UI, Radix UI
- **State:** Zustand
- **Forms & Validation:** React Hook Form + Zod
- **Cache / queues:** Redis (Upstash)
- **Billing:** Stripe (Subscriptions + Webhooks)
- **Email:** Postmark/SendGrid (outbound + inbound parse webhook)
- **Testing:** Vitest

## Getting Started

### Prerequisites

- Node.js 20+
- A PostgreSQL database (Supabase recommended — provides both pooled and direct connection strings)
- A Redis instance (Upstash recommended)
- Stripe account (for billing features)

### Setup

1. Clone the repository and install dependencies:

   ```bash
   git clone <repo-url>
   cd helpwise
   npm install
   ```

2. Copy the environment template and fill in your values:

   ```bash
   cp .env.example .env
   ```

   See [`docs/operations.md`](docs/operations.md) for a full reference of every environment
   variable, including how to generate `AUTH_SECRET` and where to get Supabase/Stripe/Redis
   credentials.

3. Apply database migrations, generate the Prisma client, and seed reference data
   (plans, feature flags):

   ```bash
   npx prisma migrate deploy
   npx prisma generate
   npx prisma db seed
   ```

4. Start the dev server:

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000). Tenant-specific pages are served
   from subdomains (`{slug}.localhost:3000` in development, `{slug}.helpwise.com` in
   production) — see `src/proxy.ts` for tenant resolution.

## npm Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run build` | Build for production |
| `npm run start` | Start the production server |
| `npm run lint` | Run ESLint |
| `npm run test` | Run the test suite once (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run db:generate` | Generate the Prisma client |
| `npm run db:migrate` | Create/apply migrations in development (`prisma migrate dev`, requires TTY) |
| `npm run db:deploy` | Apply migrations non-interactively (`prisma migrate deploy`, use in CI/prod) |
| `npm run db:studio` | Open Prisma Studio |

## Project Structure

```
src/
  app/
    (agent)/      Internal agent workspace — requires agent login + tenant membership
    (portal)/     Public customer portal — contacts see only their own tickets
    (marketing)/  Landing pages, pricing (no tenant context)
    (admin)/      Super-admin (cross-tenant management)
    api/          API routes — every route enforces tenant context + audience guard
    api/v1/       Public REST API (API-key auth) — see docs/api.md
    api/webhooks/ Stripe + inbound email webhooks (signature-verified, idempotent)
  lib/
    tenant.ts     Tenant context resolution + tenantPrisma()
    prisma.ts     Base Prisma client
    auth.ts       requireAgent() / requireContact() audience guards
    api-auth.ts   requireApiKey() guard for the public API
    features.ts   hasFeature() — plan + per-tenant feature flags
    audit.ts      audit.log() — immutable audit trail
    email.ts      Inbound parsing / outbound sending / threading
    sla.ts        SLA deadline calculation (business hours aware)
    rate-limit.ts Redis-backed rate limiting
  proxy.ts        Tenant resolution from subdomain (Node runtime)
prisma/
  schema.prisma   Database schema
  migrations/     Migration history
  seed.ts         Seed script (plans, feature flags)
```

## Documentation

- [`docs/api.md`](docs/api.md) — Public REST API reference (authentication, endpoints,
  rate limits, error codes) for integrators
- [`docs/operations.md`](docs/operations.md) — Operations runbook (environment variables,
  database migrations, webhook setup, SLA sweep cron, deployment checklist)
- [`CLAUDE.md`](CLAUDE.md) — Architecture, multi-tenancy rules, and conventions for
  contributors

  ![alt text](public/helpwise-architecture.svg)