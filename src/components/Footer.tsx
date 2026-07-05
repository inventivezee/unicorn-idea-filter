import Link from "next/link";
import { Logo } from "@/components/Logo";

export function Footer() {
  const year = 2026; // Date APIs are unavailable at build; bump when needed.
  return (
    <footer className="mt-auto border-t border-zinc-200 bg-white">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 px-4 py-5 text-xs text-zinc-400 sm:flex-row sm:px-6">
        <div className="flex items-center gap-2">
          <Logo className="h-4 w-4" title="Unicorn Idea Filter" />
          <span>© {year} Innovate Abundance LLC</span>
        </div>
        <nav className="flex items-center gap-4">
          <Link
            href="/terms"
            className="transition-colors hover:text-zinc-700"
          >
            Terms
          </Link>
          <Link
            href="/privacy"
            className="transition-colors hover:text-zinc-700"
          >
            Privacy
          </Link>
        </nav>
      </div>
    </footer>
  );
}
