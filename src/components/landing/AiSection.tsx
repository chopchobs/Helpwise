import {
  Sparkles,
  FileText,
  MessageSquareText,
  Tags,
  ShieldCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// AI spotlight section — โชว์ AI capability + จุดยืน safety/trust (suggestions only, tenant-scoped)

interface AiFeature {
  icon: LucideIcon;
  title: string;
  description: string;
}

const AI_FEATURES: AiFeature[] = [
  {
    icon: FileText,
    title: "Summarize thread",
    description:
      "Condense a long back-and-forth ticket into a few lines your agent can read in five seconds.",
  },
  {
    icon: MessageSquareText,
    title: "Suggest reply (draft)",
    description:
      "Draft a reply your agent can edit and send. It's a draft only — never sent automatically.",
  },
  {
    icon: Tags,
    title: "Auto-tag",
    description:
      "Suggest labels from the ticket content, picked only from tags this tenant already uses.",
  },
];

// bullet สรุปตัวอย่างใน visual mock (static)
const MOCK_SUMMARY_POINTS: string[] = [
  "Customer can't log in after the latest password reset.",
  "Reset email arrives but the link returns \"token expired\".",
  "Started this morning; blocking the whole billing team.",
];

const MOCK_SUGGESTED_TAGS: string[] = ["login", "urgent"];

export default function AiSection() {
  return (
    <section id="ai" className="scroll-mt-20 border-b border-border bg-stone">
      <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <p className="inline-flex items-center gap-2 rounded-full bg-primary-tint px-3 py-1 text-sm font-medium text-primary-ink">
            <Sparkles className="size-4" aria-hidden="true" />
            AI assist
          </p>
          <h2 className="mt-4 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            AI that drafts, summarizes, and tags — your agents stay in control.
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg leading-8 text-secondary">
            Speed up the busywork without handing over the wheel. Every AI output
            is a suggestion an agent reviews before anything reaches your customer.
          </p>

          <p className="mx-auto mt-6 inline-flex items-center gap-2 rounded-full bg-success-tint px-4 py-2 text-sm font-semibold text-success">
            <ShieldCheck className="size-4" aria-hidden="true" />
            Suggestions only — never auto-sent. Your data never leaves your
            tenant&apos;s context.
          </p>
        </div>

        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {AI_FEATURES.map(function renderFeature(feature) {
            const Icon = feature.icon;
            return (
              <div
                key={feature.title}
                className="rounded-xl border border-border bg-surface p-6 text-left"
              >
                <span className="inline-flex size-10 items-center justify-center rounded-lg bg-primary-tint text-primary">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <h3 className="mt-4 text-lg font-semibold text-foreground">
                  {feature.title}
                </h3>
                <p className="mt-2 text-sm leading-6 text-secondary">
                  {feature.description}
                </p>
              </div>
            );
          })}
        </div>

        {/* Visual mock — จำลอง "Summarize with AI" → panel ผลลัพธ์ (static, decorative) */}
        <div
          className="mx-auto mt-12 max-w-2xl rounded-2xl border border-border bg-surface p-5 shadow-sm sm:p-6"
          aria-hidden="true"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-semibold text-primary-ink">
                #1042
              </span>
              <span className="text-sm text-muted">Can&apos;t log in</span>
            </div>
            <span className="inline-flex items-center gap-2 rounded-lg bg-primary-strong px-3 py-1.5 text-sm font-semibold text-white">
              <Sparkles className="size-4" />
              Summarize with AI
            </span>
          </div>

          <div className="mt-4 rounded-xl border border-border bg-background p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Sparkles className="size-4 text-primary" />
              AI Summary
            </p>
            <ul className="mt-3 space-y-2">
              {MOCK_SUMMARY_POINTS.map(function renderPoint(point) {
                return (
                  <li
                    key={point}
                    className="flex gap-2 text-sm leading-6 text-secondary"
                  >
                    <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />
                    {point}
                  </li>
                );
              })}
            </ul>

            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <span className="text-xs font-medium text-muted">
                Suggested tags
              </span>
              {MOCK_SUGGESTED_TAGS.map(function renderTag(tag) {
                return (
                  <span
                    key={tag}
                    className="inline-flex items-center rounded-full bg-warning-tint px-2.5 py-0.5 text-xs font-medium text-warning-ink"
                  >
                    {tag}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
