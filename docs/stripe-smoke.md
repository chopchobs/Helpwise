# Stripe Live Smoke Test (Test Mode E2E)

This guide describes how to verify the Stripe billing integration (`src/lib/stripe.ts`,
`src/app/api/billing/checkout/route.ts`, `src/app/api/webhooks/stripe/route.ts`) against a
**real Stripe account in test mode**. None of this can be executed inside the dev sandbox —
run it locally with your own `sk_test_...` credentials.

## Prerequisites

- A Stripe account with **test mode** enabled.
- Test mode API keys:
  - `STRIPE_SECRET_KEY=sk_test_...`
  - `STRIPE_WEBHOOK_SECRET=whsec_...` (obtained from `stripe listen`, see step 2)
- [Stripe CLI](https://stripe.com/docs/stripe-cli) installed and logged in (`stripe login`).
- `DATABASE_URL` pointing at a dev/staging database (never production).
- `NEXT_PUBLIC_ROOT_DOMAIN` set in `.env` (e.g. `helpwise.local` or `localhost:3000`).
- Plans seeded in the database with `stripePriceIdMonthly` / `stripePriceIdYearly` pointing
  at **test-mode** Price IDs. Create the products/prices in the Stripe Dashboard (test mode)
  or via `stripe prices create`, then update the `Plan` rows (via seed script or
  `prisma studio`) so `pricePerMonth` / `pricePerYear` (Int, satang/cents) match the
  `unit_amount` of those Stripe prices exactly.

> ⚠️ Never use `sk_live_` keys for this procedure. The smoke script refuses to run if it
> detects a live key.

---

## Step 1 — Connectivity & Plan/Price reconciliation

Run:

```bash
npm run smoke:stripe
```

This runs `scripts/stripe-smoke.ts`, which:

1. **Safety guard** — refuses to run if `STRIPE_SECRET_KEY` is missing or starts with
   `sk_live_`.
2. **Connectivity** — calls `stripe.balance.retrieve()` to confirm the key works and the
   account is in test mode (`livemode=false`).
3. **Plan ↔ Price reconciliation** — for every active `Plan` with `stripePriceIdMonthly` /
   `stripePriceIdYearly` set, calls `stripe.prices.retrieve(priceId)` and checks:
   - the price exists and is `active`
   - `unit_amount` matches `Plan.pricePerMonth` / `Plan.pricePerYear` exactly (Int vs Int)
   - `recurring.interval` is `month` / `year` as expected
4. **Ephemeral checkout session** — creates a `mode: "subscription"` Checkout Session using
   the first reconciled price, and prints `session.id` + `session.url`. This session is
   never completed, so no customer/subscription is created in Stripe — it simply expires on
   its own (Stripe default ~24h).

The script prints `PASS`/`FAIL` per check and exits with code `0` (all passed) or `1` (at
least one failure). **Fix any reconciliation mismatches before proceeding** — a mismatched
`unit_amount` or inactive price is the most common cause of broken checkout in production.

---

## Step 2 — Full webhook E2E (subscription lifecycle)

1. Start the webhook forwarder in one terminal:

   ```bash
   stripe listen --forward-to localhost:3000/api/webhooks/stripe/
   ```

   Copy the `whsec_...` value it prints into `.env` as `STRIPE_WEBHOOK_SECRET`.

2. Start the app in another terminal:

   ```bash
   npm run dev
   ```

3. As a tenant OWNER/ADMIN, trigger checkout from the UI (`/settings/billing`), or call
   `POST /api/billing/checkout` with `{ "planName": "<plan>", "interval": "monthly" }`.
   Open the returned `url` in a browser.

4. Complete payment with the Stripe test card:

   ```
   Card number: 4242 4242 4242 4242
   Expiry: any future date
   CVC: any 3 digits
   ```

5. Watch the `stripe listen` terminal — you should see `checkout.session.completed`,
   `customer.subscription.created` (and possibly `invoice.paid`) forwarded to
   `/api/webhooks/stripe/` with `200` responses.

6. Verify in the database:
   - `Subscription` row for the tenant: `status=ACTIVE`, `stripeSubscriptionId`,
     `stripeCustomerId`, `currentPriceAmount` (Int), `currentPeriodStart/End` populated.
   - `Tenant.planId` updated to match the plan purchased.
   - `AuditLog` contains `subscription.created` and (if plan changed) `tenant.plan_changed`.
   - Redis: the cached tenant-slug entry (`tenant:slug:{slug}`) should have been invalidated
     (`redis.del`) — confirm by checking the key is absent or re-populated with the new plan
     on next request.

---

## Step 3 — Payment failure / recovery

With `stripe listen` still running:

```bash
stripe trigger invoice.payment_failed
stripe trigger invoice.paid
```

After each trigger, check the `Subscription.status` for the affected tenant:

- `invoice.payment_failed` → webhook retrieves the subscription and syncs — expect
  `status=PAST_DUE` (or `UNPAID` depending on Stripe's subscription status at that point).
- `invoice.paid` → expect `status=ACTIVE` again.

Both handlers use `extractSubscriptionIdFromInvoice()`, which reads
`invoice.parent.subscription_details.subscription` (API `2026-05-27.dahlia` moved this off
the top-level `invoice.subscription` field used in older API versions).

---

## Step 4 — Idempotency check

Re-deliver an already-processed event to confirm `ProcessedStripeEvent` prevents
double-processing:

```bash
stripe events list --limit 5
stripe events resend <event_id>
```

(or use the Stripe Dashboard → Developers → Webhooks → select endpoint → an event → "Resend")

Expected:

- The webhook responds `200 { "data": { "received": true, "action": "duplicate" }, "error": null }`
  if the original event already has `ProcessedStripeEvent.status = "ok"`.
- No duplicate `AuditLog` entries or double subscription updates occur.
- If the original processing had failed (`status = "error"` or stuck `"processing"`), the
  resend should **reprocess** (not be treated as duplicate) — this is intentional so a
  transient failure doesn't permanently block sync.

---

## Stripe API "dahlia" quirks (reference)

These are baked into `src/lib/stripe.ts` and the webhook handler — useful when debugging
unexpected `undefined` fields:

- `current_period_start` / `current_period_end` live on **`SubscriptionItem`**
  (`stripeSub.items.data[0].current_period_start/end`), **not** on the top-level
  `Subscription` object.
- For invoices, the related subscription is at
  `invoice.parent.subscription_details.subscription` (string ID or expanded object), not
  the legacy top-level `invoice.subscription`.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Webhook returns `400 invalid_signature` | `STRIPE_WEBHOOK_SECRET` doesn't match the `stripe listen` session, or raw body was modified (e.g. by a proxy/middleware that re-serializes JSON) | Re-copy `whsec_...` from the current `stripe listen` output into `.env` and restart `npm run dev`. Confirm `proxy.ts` skips `/api/webhooks/` (it does by design). |
| Webhook returns `400 webhook_not_configured` | `STRIPE_WEBHOOK_SECRET` not set and `NODE_ENV !== "development"` | Set `STRIPE_WEBHOOK_SECRET` from `stripe listen`, or run with `NODE_ENV=development` for local-only testing (signature verification is skipped — dev only). |
| `smoke:stripe` reports price `unit_amount mismatch` | `Plan.pricePerMonth`/`pricePerYear` in DB doesn't match the Stripe Price's `unit_amount` | Update the `Plan` row (seed/`prisma studio`) to match the Stripe test-mode price, or create a new Stripe price with the correct amount and update `stripePriceIdMonthly`/`Yearly`. |
| `syncSubscriptionFromStripe` throws "Cannot resolve tenantId" | Checkout session was created without `metadata.tenantId`, or the test event was triggered via `stripe trigger` (which uses Stripe's own fixture data, not your checkout flow) | For `stripe trigger`, this is often expected — those events reference Stripe's sample customers, not real tenants. Focus idempotency/status-sync checks on subscriptions created via your own checkout flow (Step 2). |
| `tenantId mismatch for customer` error | A `stripeCustomerId` already exists in another tenant's `Subscription` row (data inconsistency) | Investigate manually — this is a defense-in-depth guard and should not happen in normal operation. Do not bypass it. |
| Checkout session created in Step 1 lingers in Stripe Dashboard | Expected — ephemeral sessions expire automatically (~24h) since they're never completed | No action needed. |
