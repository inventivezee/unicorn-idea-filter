"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Pipeline" },
  { href: "/compare", label: "Compare" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const pathname = usePathname();

  function isActive(href: string) {
    if (href === "/") return pathname === "/" || pathname.startsWith("/idea/");
    return pathname.startsWith(href);
  }

  const exitActive =
    pathname.startsWith("/exit-reference") ||
    pathname.startsWith("/outcome-math") ||
    pathname.startsWith("/reference");

  return (
    <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white/90 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link
          href="/"
          className="shrink-0 py-3 text-sm font-semibold tracking-tight text-zinc-900"
        >
          Unicorn Idea Filter
        </Link>
        <nav className="-mb-px flex flex-1 items-center gap-1 overflow-x-auto">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`whitespace-nowrap border-b-2 px-3 py-3 text-sm transition-colors ${
                isActive(link.href)
                  ? "border-teal-600 font-medium text-teal-700"
                  : "border-transparent text-zinc-500 hover:text-zinc-900"
              }`}
            >
              {link.label}
            </Link>
          ))}
          {/* Background reading, not the working surface — parked at the far right. */}
          <Link
            href="/exit-reference"
            className={`ml-auto whitespace-nowrap border-b-2 py-3 pl-6 pr-1 text-xs transition-colors ${
              exitActive
                ? "border-teal-600 font-medium text-teal-700"
                : "border-transparent text-zinc-400 hover:text-zinc-700"
            }`}
          >
            Exit calculations &amp; References
          </Link>
        </nav>
      </div>
    </header>
  );
}
