import { GitBranch, ShieldCheck, Layers, Bot } from "lucide-react";
import { GITHUB_URL, GITHUB_README_URL } from "@/lib/landing-links";

interface Highlight {
  icon: typeof GitBranch;
  text: string;
}

const HIGHLIGHTS: Highlight[] = [
  { icon: GitBranch, text: "27+ phases, each on its own branch" },
  {
    icon: ShieldCheck,
    text: "Definition-of-Done gated reviews (code-review · QA · security)",
  },
  {
    icon: Layers,
    text: "Multi-tenant from day one — app-level scoping + PostgreSQL Row-Level Security",
  },
  {
    icon: Bot,
    text: "AI with tenant-scoped prompts + prompt-injection defense",
  },
];

// "Under the hood" — engineering credibility section สำหรับ recruiter/engineer
export default function UnderTheHood() {
  return (
    <section
      id="architecture"
      className="scroll-mt-20 border-y border-border bg-stone"
    >
      <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            Built by an engineer who sweats the details.
          </h2>
        </div>

        {/* architecture diagram — กรอบ card ให้ diagram อ่านง่าย */}
        <div className="mx-auto mt-12 w-full max-w-4xl rounded-xl border border-border bg-surface p-4">
          {/* plain <img> ตั้งใจ — เลี่ยง next/image dangerouslyAllowSVG กับ SVG diagram */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/helpwise-architecture.svg"
            alt="Helpwise system architecture: subdomain routing, multi-tenant Postgres with RLS, QStash queue, Anthropic AI"
            loading="lazy"
            className="mx-auto h-auto w-full max-w-4xl"
          />
        </div>

        {/* engineering highlights */}
        <ul className="mx-auto mt-12 grid max-w-4xl gap-4 sm:grid-cols-2">
          {HIGHLIGHTS.map(({ icon: Icon, text }) => (
            <li
              key={text}
              className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4"
            >
              <Icon
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-primary"
              />
              <span className="text-base text-secondary">{text}</span>
            </li>
          ))}
        </ul>

        <div className="mt-12 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a
            href={GITHUB_README_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-full items-center justify-center rounded-lg bg-primary-strong px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-primary-strong-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:w-auto"
          >
            Read the architecture →
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-full items-center justify-center rounded-lg border border-border bg-surface px-6 py-3 text-base font-semibold text-primary-ink transition-colors hover:bg-stone focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:w-auto"
          >
            View source on GitHub →
          </a>
        </div>
      </div>
    </section>
  );
}
