// Tech strip — text-based stack list (ไม่พึ่ง logo asset ภายนอก)
const STACK: ReadonlyArray<string> = [
  "Next.js",
  "TypeScript",
  "PostgreSQL",
  "Prisma",
  "Redis",
  "Stripe",
  "Anthropic",
];

export default function TechStrip() {
  return (
    <section className="border-b border-border bg-stone">
      <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
        <p className="text-center text-sm font-medium uppercase tracking-wide text-secondary">
          Built on a modern, production-grade stack
        </p>
        <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
          {STACK.map(function renderTech(name) {
            return (
              <li
                key={name}
                className="text-base font-semibold text-secondary"
              >
                {name}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
