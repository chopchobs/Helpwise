import { GITHUB_URL } from "@/lib/landing-links";
import HeroMockup from "@/components/landing/HeroMockup";
import GithubIcon from "@/components/landing/GithubIcon";

interface HeroProps {
  demoUrl: string;
}

// Hero section — headline + subhead + CTA + static product mockup
export default function Hero({ demoUrl }: HeroProps) {
  return (
    <section className="border-b border-border bg-background">
      <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
            The multi-tenant help desk your customers never see coming.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-secondary">
            Helpwise gives B2B teams a shared inbox, SLA tracking, and AI-assisted
            replies — with airtight tenant isolation baked in at the database level.
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href={demoUrl}
              className="inline-flex w-full items-center justify-center rounded-lg bg-primary-strong px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-primary-strong-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:w-auto"
            >
              Try the live demo →
            </a>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface px-6 py-3 text-base font-semibold text-foreground transition-colors hover:bg-stone focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:w-auto"
            >
              <GithubIcon className="size-5" />
              View on GitHub
            </a>
          </div>

          <p className="mt-4 text-sm text-secondary">
            Two demo workspaces ready to explore — acme &amp; globex
          </p>
        </div>

        <div className="mt-14">
          <HeroMockup />
        </div>
      </div>
    </section>
  );
}
