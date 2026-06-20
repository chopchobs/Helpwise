import { GITHUB_URL } from "@/lib/landing-links";
import GithubIcon from "@/components/landing/GithubIcon";

interface FooterLink {
  label: string;
  href: string;
}

interface FooterColumn {
  title: string;
  links: ReadonlyArray<FooterLink>;
}

const COLUMNS: ReadonlyArray<FooterColumn> = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "#features" },
      { label: "AI", href: "#ai" },
      { label: "Pricing", href: "#pricing" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Docs", href: "#docs" },
      { label: "Architecture", href: "#architecture" },
      { label: "API reference", href: "#api" },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "GitHub", href: GITHUB_URL },
      { label: "About", href: "#about" },
    ],
  },
];

// Footer ของ landing — link columns + project attribution
export default function LandingFooter() {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
          <div className="col-span-2 sm:col-span-1">
            <span className="text-lg font-semibold tracking-tight text-foreground">
              Helpwise
            </span>
            <p className="mt-3 max-w-xs text-sm leading-6 text-secondary">
              A portfolio project demonstrating production-grade multi-tenant SaaS
              architecture.
            </p>
          </div>

          {COLUMNS.map(function renderColumn(column) {
            return (
              <div key={column.title}>
                <h3 className="text-sm font-semibold text-foreground">
                  {column.title}
                </h3>
                <ul className="mt-3 space-y-2">
                  {column.links.map(function renderLink(link) {
                    const isExternal = link.href.startsWith("http");
                    return (
                      <li key={link.label}>
                        <a
                          href={link.href}
                          {...(isExternal
                            ? { target: "_blank", rel: "noopener noreferrer" }
                            : {})}
                          className="text-sm text-secondary transition-colors hover:text-primary-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                        >
                          {link.label}
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-4 border-t border-border pt-6 sm:flex-row sm:items-center">
          <p className="text-sm text-secondary">© 2026 · built by chopchobs</p>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View Helpwise on GitHub"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-secondary transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <GithubIcon className="size-4" />
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
