# helpwise — Interview Stories & Resume Material

> Framed from the real production deployment + debugging session.
> Resume bullets and answers are in English (standard for tech resumes); deliver them in Thai if your interview is in Thai.

---

## Project summary (one-liner)

A production multi-tenant B2B help desk SaaS (Next.js, Prisma/PostgreSQL, Vercel) with subdomain-per-tenant isolation, AI-assisted ticket triage, and SLA tracking — deployed live at gethelpwise.xyz with two explorable demo workspaces (acme, globex).

---

## Resume bullets (ready to paste)

- Designed and shipped a multi-tenant B2B help desk SaaS (Next.js App Router, Prisma/PostgreSQL, Vercel) with subdomain-based tenant routing and application-enforced isolation; live across two demo workspaces.
- Built AI-assisted ticket features (thread summarization, suggested replies, auto-tagging) on the Anthropic API using tenant-scoped prompts and tool-free calls to limit prompt-injection blast radius.
- Owned the full production deploy end to end: provisioned Supabase Postgres, ran Prisma migrations against prod, configured wildcard DNS + automatic SSL on a custom domain, and managed environment configuration on Vercel.
- Implemented defense-in-depth tenant isolation (per-request tenantId scoping + PostgreSQL Row-Level Security scaffolding) and documented the trust model accurately after finding the DB role bypassed RLS.
- Found and fixed production bugs during QA, including an open-redirect-safe fix for a tenant-aware demo entry point.

---

## Interview stories (STAR)

### Story 1 — "Tell me about a bug you debugged in production"

- **Situation:** After deploying, during QA I found the demo entry on `globex.gethelpwise.xyz` sent users into the `acme` workspace and showed acme's data.
- **Task:** Decide first whether this was a data-isolation breach (critical) or a routing bug, then fix it without breaking the working acme path.
- **Action:** Rather than guess, I traced the real code across the demo-login route, the seed data, the post-login redirect, and the tenant-resolution proxy. The backend auth was already tenant-aware and globex had its own seeded demo agent — the actual cause was the landing page's "Try live demo" button using a hardcoded acme URL on every host. I made the button resolve its destination from the request Host: a relative `/demo` link on tenant subdomains (which also prevents open-redirect by construction, since a relative path can't leave the origin) and the acme fallback only on the root domain.
- **Result:** globex now enters its own workspace with its own data; acme unchanged. I also confirmed it was never an isolation breach — the user was just authenticated into the wrong tenant by a misrouted link.
- **Why it lands:** methodical debugging (read code, don't guess), telling a UX bug apart from a security bug, and security-by-construction thinking.

### Story 2 — "Tell me about a time you were honest about a limitation"

- **Situation:** My landing page claimed "defense in depth — app-level scoping + PostgreSQL Row-Level Security."
- **Task:** Verify the RLS claim before putting the project in front of recruiters.
- **Action:** I checked whether RLS actually enforced at the database. It didn't — the Postgres connection role had `BYPASSRLS`, so the policies were inert regardless of the feature flag; the real isolation came from application-layer tenantId scoping. Instead of overclaiming, I reworded the site, README, and architecture diagram to "application-enforced isolation + RLS scaffolded as defense-in-depth," and documented what true RLS would require (a non-bypassing role, cross-tenant DB tests, load testing).
- **Result:** An accurate, defensible claim — and a sharp talking point about the difference between RLS *existing* and RLS *enforcing*.
- **Why it lands:** intellectual honesty + deep Postgres knowledge (BYPASSRLS surprises most people).

### Story 3 — "Walk me through taking something to production"

- **Situation:** helpwise was built locally and needed to be live on a real domain with working tenant subdomains.
- **Task:** Get it from local to a public, HTTPS, multi-tenant production deployment.
- **Action:** Provisioned managed Postgres (Supabase), ran Prisma migrations against prod using the direct (non-pooled) connection because pgbouncer can't run DDL, seeded demo data, set production env vars on Vercel, and attached a custom domain. The multi-tenant requirement meant a wildcard subdomain (`*.gethelpwise.xyz`), so I delegated the domain's nameservers to Vercel to get automatic wildcard SSL — a plain A record wouldn't cover subdomains. Verified isolation by confirming acme and globex served separate data.
- **Result:** Live, HTTPS, multi-tenant deployment with two explorable workspaces.
- **Why it lands:** real DevOps range (DNS, SSL, env, migrations) and understanding *why* (wildcard needs nameserver delegation; pooled vs direct DB URLs).

### Story 4 (bonus) — "How do you make sure you fixed the whole problem, not just one symptom?"

- When I fixed the hardcoded demo link, I asked whether the "Sign in" link had the same bug class. It did — an environment variable I'd set was overriding a safe relative fallback and pointing Sign in at acme on every host. I removed the override so the code's correct default applied. One QA pass, two bugs of the same class closed.
- **Why it lands:** shows you fix *classes* of bugs, not just the one ticket.

---

## Anticipated questions

**"Did you build this with AI? How much is actually yours?"**
Be honest and confident: "I built it using a multi-agent orchestration system I designed myself — a coordinator plus specialized sub-agents for frontend, backend, database, security review, and docs. I made every architecture and security decision, did the QA and debugging, and owned the deployment. The AI accelerated implementation; the engineering judgment is mine." Then prove it by walking through any file they point to. (This is exactly why understanding the codebase cold matters — see next steps.)

**"How does tenant isolation work?"**
Know this cold: subdomain → proxy resolves the tenant from the Host header → injects a tenantId → every query is scoped through a tenant-aware Prisma client; RLS is scaffolded as defense-in-depth but currently not enforcing because of the connection role, which I documented honestly.

**"What would you do differently / what's next?"**
Enable true RLS with a non-bypassing role; finish inbound email→ticket; add a second demo-workspace entry on the root landing.

---

## Talking points to know cold

- Multi-tenancy model: shared DB + shared schema + tenantId column + subdomain routing
- Why wildcard DNS needs nameserver delegation (for automatic wildcard SSL)
- DIRECT_URL vs pooled connection for migrations (pgbouncer can't run DDL)
- Open-redirect prevention via relative URLs and slug validation (`/^[a-z0-9-]+$/`)
- AI safety: tenant-scoped prompts + tool-free calls to limit prompt-injection blast radius
- RLS *existing* vs *enforcing* (the BYPASSRLS gotcha)

---

## Next step to be interview-ready

Open the new chat (Opus + connect the helpwise folder) and learn each layer from the real code, so you can explain any file an interviewer points at. These stories are the "what happened"; the code walkthrough is the "how it works."
