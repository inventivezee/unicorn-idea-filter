"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";

const LINKS = [
  { href: "/", label: "Pipeline" },
  { href: "/explore", label: "Explore" },
  { href: "/compare", label: "Compare" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/settings", label: "Settings" },
];

/** Sign-in link / account menu — rendered only in cloud mode. */
function AuthControl() {
  const { cloud, hydrated, entitlements, signOut } = useStore();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  if (!cloud || !hydrated) return null;

  if (!entitlements.signedIn) {
    return (
      <Link
        href="/signin"
        className="whitespace-nowrap py-3 text-xs text-zinc-600 transition-colors hover:text-zinc-900"
      >
        Sign in
      </Link>
    );
  }

  const email = entitlements.email ?? "";
  const prefix = email.includes("@")
    ? email.slice(0, email.indexOf("@"))
    : email || "account";

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 whitespace-nowrap py-3 text-xs text-zinc-600 transition-colors hover:text-zinc-900"
      >
        <span
          aria-hidden
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            entitlements.subscribed ? "bg-teal-600" : "bg-zinc-300"
          }`}
        />
        {prefix}
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-30 w-52 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg">
          <div className="truncate border-b border-zinc-100 px-3 py-1.5 text-xs text-zinc-500">
            {email}
          </div>
          <Link
            href="/settings"
            onClick={() => setOpen(false)}
            className="block px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
          >
            Settings
          </Link>
          {entitlements.isAdmin ? (
            <Link
              href="/admin"
              onClick={() => setOpen(false)}
              className="block px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
            >
              Admin
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
            className="block w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-red-50"
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** App-wide "N analyzing" pill — visible from any page while requests run. */
function AnalyzingIndicator() {
  const { analyzing } = useStore();
  const count = Object.keys(analyzing).length;
  if (count === 0) return null;
  return (
    <Link
      href="/"
      title="AI requests are running in the background. Click to see which ideas."
      className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-teal-200 bg-teal-50 px-2 py-1 text-xs font-medium text-teal-700 transition-colors hover:bg-teal-100"
    >
      <span
        aria-hidden
        className="inline-block h-3 w-3 animate-spin rounded-full border border-teal-300 border-t-teal-600"
      />
      {count} analyzing
    </Link>
  );
}

export function Nav() {
  const pathname = usePathname();
  const { syncError, pendingLocalImport, importLocalIdeas } = useStore();

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
        </nav>
        {/* Right-aligned cluster: auth control, then background reading.
            Kept outside the scrollable nav so the account dropdown isn't
            clipped by overflow-x-auto. */}
        <AnalyzingIndicator />
        <AuthControl />
        <Link
          href="/exit-reference"
          className={`-mb-px whitespace-nowrap border-b-2 py-3 pr-1 text-xs transition-colors ${
            exitActive
              ? "border-teal-600 font-medium text-teal-700"
              : "border-transparent text-zinc-400 hover:text-zinc-700"
          }`}
        >
          Exit calculations &amp; References
        </Link>
      </div>
      {syncError !== null ? (
        <div className="border-t border-amber-100 bg-amber-50">
          <div className="mx-auto w-full max-w-6xl px-4 py-1.5 text-xs text-amber-800 sm:px-6">
            Cloud sync issue: {syncError} — changes are kept locally and
            retried.
          </div>
        </div>
      ) : null}
      {pendingLocalImport > 0 ? (
        <div className="border-t border-teal-100 bg-teal-50">
          <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-1.5 text-xs text-teal-800 sm:px-6">
            <span>
              {pendingLocalImport} ideas from this browser aren&apos;t in the
              cloud yet.
            </span>
            <button
              type="button"
              onClick={() => void importLocalIdeas()}
              className="rounded border border-teal-300 bg-white px-2 py-0.5 font-medium text-teal-700 transition-colors hover:bg-teal-100"
            >
              Import now
            </button>
          </div>
        </div>
      ) : null}
    </header>
  );
}
