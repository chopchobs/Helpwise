import { DEMO_URL, GITHUB_URL } from "@/lib/landing-links";
import GithubIcon from "@/components/landing/GithubIcon";

// Final CTA band — full-width terracotta, text ขาวบน bg-primary-strong (AA)
export default function FinalCta() {
  return (
    <section className="bg-primary-strong">
      <div className="mx-auto w-full max-w-6xl px-4 py-16 text-center sm:px-6">
        <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
          See it in action.
        </h2>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a
            href={DEMO_URL}
            className="inline-flex w-full items-center justify-center rounded-lg bg-white px-6 py-3 text-base font-semibold text-primary-ink transition-colors hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:w-auto"
          >
            Try the live demo
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-white/70 px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:w-auto"
          >
            <GithubIcon className="size-5" />
            View on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
