"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { Logo } from "@/components/Logo";

const LINKS = [
  { href: "/", label: "Pipeline" },
  { href: "/explore", label: "Explore" },
  { href: "/compare", label: "Compare" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/settings", label: "Settings" },
];

/** Compare/Dashboard read the unicorn instrument — hidden in cash-cow mode. */
const CASHCOW_LINKS = LINKS.filter(
  (l) => l.href !== "/compare" && l.href !== "/dashboard",
);

const FILTER_META = {
  unicorn: {
    label: "Unicorn Idea Filter",
    question: "Venture-scale, category-defining, possibly public?",
    dot: "bg-teal-600",
  },
  cashcow: {
    label: "Cash Cow Filter",
    question: "$20M+ EBITDA/year with durable enterprise value?",
    dot: "bg-amber-500",
  },
} as const;

/** Top-left brand — a dropdown that switches between the two instruments. */
function FilterSwitcher() {
  const { state, updateSettings, settingsHydrated } = useStore();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const mode = state.settings.filterMode;
  const meta = FILTER_META[mode];

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

  // Before settings are readable render the static brand so SSR markup matches.
  if (!settingsHydrated) {
    return (
      <span className="shrink-0 py-3 text-sm font-semibold tracking-tight text-zinc-900">
        Unicorn Idea Filter
      </span>
    );
  }

  return (
    <div ref={menuRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 py-3 text-sm font-semibold tracking-tight text-zinc-900"
      >
        <span aria-hidden className={`h-2 w-2 rounded-full ${meta.dot}`} />
        {meta.label}
        <svg
          viewBox="0 0 16 16"
          className={`h-3 w-3 text-zinc-400 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          aria-hidden
        >
          <path
            d="M4 6.5 8 10.5 12 6.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-30 w-72 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg">
          {(Object.keys(FILTER_META) as (keyof typeof FILTER_META)[]).map(
            (key) => {
              const m = FILTER_META[key];
              const active = key === mode;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    if (active) return;
                    updateSettings({ filterMode: key });
                    // Compare/Dashboard are unicorn-only — don't strand the
                    // user on a page whose nav link just disappeared.
                    if (
                      key === "cashcow" &&
                      (pathname.startsWith("/compare") ||
                        pathname.startsWith("/dashboard"))
                    ) {
                      router.push("/");
                    }
                  }}
                  className={`block w-full px-3 py-2 text-left transition-colors ${
                    active ? "bg-zinc-50" : "hover:bg-zinc-50"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className={`h-2 w-2 shrink-0 rounded-full ${m.dot}`}
                    />
                    <span className="text-sm font-medium text-zinc-900">
                      {m.label}
                    </span>
                    {active ? (
                      <span className="ml-auto text-[10px] font-medium text-zinc-400">
                        current
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block pl-4 text-xs text-zinc-500">
                    {m.question}
                  </span>
                </button>
              );
            },
          )}
          <p className="border-t border-zinc-100 px-3 pb-1 pt-1.5 text-[10px] text-zinc-400">
            Same ideas, different instrument — each filter keeps its own gates,
            scores, and AI analysis.
          </p>
        </div>
      ) : null}
    </div>
  );
}

const EXIT_HREF = "/exit-reference";
const EXIT_LABEL = "Exit calculations & References";

/** Sign-in link / account menu — desktop only (mobile uses the drawer). */
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
        className="whitespace-nowrap py-3 text-xs font-medium text-teal-700 transition-colors hover:text-teal-800"
      >
        Sign up / Sign in
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

/** Auth rows for the mobile drawer (flat, full-width). */
function MobileAuth({ onNavigate }: { onNavigate: () => void }) {
  const { cloud, hydrated, entitlements, signOut } = useStore();
  if (!cloud || !hydrated) return null;

  if (!entitlements.signedIn) {
    return (
      <Link
        href="/signin"
        onClick={onNavigate}
        className="block rounded-md px-3 py-2.5 text-sm font-medium text-teal-700 hover:bg-zinc-50"
      >
        Sign up / Sign in
      </Link>
    );
  }

  return (
    <>
      <div className="truncate px-3 py-1.5 text-xs text-zinc-400">
        {entitlements.email}
      </div>
      {entitlements.isAdmin ? (
        <Link
          href="/admin"
          onClick={onNavigate}
          className="block rounded-md px-3 py-2.5 text-sm text-zinc-700 hover:bg-zinc-50"
        >
          Admin
        </Link>
      ) : null}
      <button
        type="button"
        onClick={() => {
          onNavigate();
          void signOut();
        }}
        className="block w-full rounded-md px-3 py-2.5 text-left text-sm text-red-600 hover:bg-red-50"
      >
        Sign out
      </button>
    </>
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
      <span className="tnum">{count}</span> analyzing
    </Link>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden>
      {open ? (
        <path
          d="M6 6l12 12M18 6L6 18"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M4 7h16M4 12h16M4 17h16"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

export function Nav() {
  const pathname = usePathname();
  const {
    state,
    settingsHydrated,
    syncError,
    pendingLocalImport,
    importLocalIdeas,
  } = useStore();
  const cashcowMode =
    settingsHydrated && state.settings.filterMode === "cashcow";
  const navLinks = cashcowMode ? CASHCOW_LINKS : LINKS;
  const accent = cashcowMode
    ? { border: "border-amber-500", text: "text-amber-700", bg: "bg-amber-50" }
    : { border: "border-teal-600", text: "text-teal-700", bg: "bg-teal-50" };
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close the drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

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
        <div className="flex shrink-0 items-center gap-2">
          <Link href="/" aria-label="Home" className="flex items-center">
            <Logo className="h-6 w-6" />
          </Link>
          <FilterSwitcher />
        </div>

        {/* Desktop nav — only once there's room for every item (see the long
            exit link); tablets and phones use the drawer. */}
        <nav className="-mb-px hidden flex-1 items-center gap-1 overflow-x-auto lg:flex">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`whitespace-nowrap border-b-2 px-3 py-3 text-sm transition-colors ${
                isActive(link.href)
                  ? `${accent.border} font-medium ${accent.text}`
                  : "border-transparent text-zinc-500 hover:text-zinc-900"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Push the right-hand cluster to the edge below the desktop breakpoint. */}
        <div className="flex-1 lg:hidden" />

        <AnalyzingIndicator />

        {/* Desktop-only: account control + de-emphasized exit link. */}
        <div className="hidden items-center gap-4 lg:flex">
          <AuthControl />
          <Link
            href={EXIT_HREF}
            className={`-mb-px whitespace-nowrap border-b-2 py-3 pr-1 text-xs transition-colors ${
              exitActive
                ? "border-teal-600 font-medium text-teal-700"
                : "border-transparent text-zinc-400 hover:text-zinc-700"
            }`}
          >
            {EXIT_LABEL}
          </Link>
        </div>

        {/* Mobile hamburger */}
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          aria-expanded={mobileOpen}
          className="-mr-1 shrink-0 rounded-md p-2 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 lg:hidden"
        >
          <MenuIcon open={mobileOpen} />
        </button>
      </div>

      {/* Mobile / tablet drawer */}
      {mobileOpen ? (
        <nav className="border-t border-zinc-200 bg-white lg:hidden">
          <div className="mx-auto w-full max-w-6xl space-y-0.5 px-2 py-2">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className={`block rounded-md px-3 py-2.5 text-sm transition-colors ${
                  isActive(link.href)
                    ? `${accent.bg} font-medium ${accent.text}`
                    : "text-zinc-700 hover:bg-zinc-50"
                }`}
              >
                {link.label}
              </Link>
            ))}
            <Link
              href={EXIT_HREF}
              onClick={() => setMobileOpen(false)}
              className={`block rounded-md px-3 py-2.5 text-sm transition-colors ${
                exitActive
                  ? "bg-teal-50 font-medium text-teal-700"
                  : "text-zinc-500 hover:bg-zinc-50"
              }`}
            >
              {EXIT_LABEL}
            </Link>
            <div className="my-1 border-t border-zinc-100" />
            <MobileAuth onNavigate={() => setMobileOpen(false)} />
          </div>
        </nav>
      ) : null}

      {syncError !== null ? (
        <div className="border-t border-amber-100 bg-amber-50">
          <div className="mx-auto w-full max-w-6xl px-4 py-1.5 text-xs text-amber-800 sm:px-6">
            Cloud sync issue: {syncError} — unsaved changes live only in this
            tab and are retried. Keep the tab open until this clears.
          </div>
        </div>
      ) : null}
      {pendingLocalImport > 0 ? (
        <div className="border-t border-teal-100 bg-teal-50">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-3 px-4 py-1.5 text-xs text-teal-800 sm:px-6">
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
