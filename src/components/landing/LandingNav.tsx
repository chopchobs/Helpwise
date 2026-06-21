import Link from "next/link";
import { GITHUB_URL, SIGNIN_URL } from "@/lib/landing-links";
import GithubIcon from "@/components/landing/GithubIcon";

interface LandingNavProps {
  demoUrl: string;
}

// Nav bar ของ landing — sticky top, server component (ไม่มี interactivity)
// ลิงก์กลางซ่อนบน mobile เพื่อกัน nav ล้น (mobile-first, ไม่มี hamburger ตาม scope)
export default function LandingNav({ demoUrl }: LandingNavProps) {
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-surface/95 backdrop-blur">
      <nav
        aria-label="Primary"
        className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 sm:px-6"
      >
        <Link
          href="/"
          className="text-lg font-semibold tracking-tight text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          Helpwise
        </Link>

        <div className="hidden items-center gap-6 text-sm font-medium text-secondary md:flex">
          <a
            href="#ai"
            className="transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            AI
          </a>
          <a
            href="#architecture"
            className="transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            Architecture
          </a>
        </div>

        <div className="flex items-center gap-2 sm:gap-4">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden items-center gap-1.5 text-sm font-medium text-secondary transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:flex"
          >
            <GithubIcon className="size-4" />
            View on GitHub
          </a>
          <a
            href={SIGNIN_URL}
            className="hidden text-sm font-medium text-secondary transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:inline-flex"
          >
            Sign in
          </a>
          <a
            href={demoUrl}
            className="inline-flex items-center justify-center rounded-lg bg-primary-strong px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-strong-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            Try live demo
          </a>
        </div>
      </nav>
    </header>
  );
}
