"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { GateStatus } from "@/lib/engine";
import type { Decision } from "@/lib/types";
import { useStore } from "@/lib/store";

/**
 * "Auto-saved" indicator. Watches `value`; after a real change it briefly
 * shows "Saving…" then settles. Edits persist to local storage immediately, so
 * the settled state is honest — but in cloud mode, if the background sync is
 * currently failing it reads "Saved on this device" (amber) rather than the
 * green "Auto-saved", so it never overstates that the cloud write succeeded.
 * Silent until the first real change after mount (compares against the mount
 * value, so React StrictMode's double effect invoke can't flash a false save).
 */
export function AutoSavedFlag({ value }: { value: string }) {
  const { cloud, syncError } = useStore();
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current === value) return; // no real change (also covers StrictMode)
    prev.current = value;
    setStatus("saving");
    const t = setTimeout(() => setStatus("saved"), 600);
    return () => clearTimeout(t);
  }, [value]);
  if (status === "idle") return null;

  if (status === "saving") {
    return (
      <span
        className="flex items-center gap-1 whitespace-nowrap text-xs text-zinc-500"
        aria-live="polite"
      >
        <span
          aria-hidden
          className="inline-block h-3 w-3 animate-spin rounded-full border border-zinc-200 border-t-teal-600"
        />
        Saving…
      </span>
    );
  }

  const syncFailing = cloud && syncError !== null;
  return (
    <span
      className={`flex items-center gap-1 whitespace-nowrap text-xs ${
        syncFailing ? "text-amber-700" : "text-teal-600"
      }`}
      aria-live="polite"
      title={
        syncFailing
          ? "Saved on this device — cloud sync is currently retrying (see the banner above)."
          : undefined
      }
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" aria-hidden>
        <path
          d="M3 8.5 6.5 12 13 4.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {syncFailing ? "Saved on this device" : "Auto-saved"}
    </span>
  );
}

/** Decision chip colors per spec: BUILD teal, VALIDATE blue, PARK grey,
 *  KILL/REFRAME red outline, KILL red, PENDING muted. */
const DECISION_STYLES: Record<Decision, string> = {
  "BUILD / INCUBATE": "bg-teal-600 text-white",
  "VALIDATE FAST": "bg-blue-600 text-white",
  "PARK / NARROW": "bg-zinc-200 text-zinc-700",
  "KILL / REFRAME": "border border-red-600 bg-white text-red-600",
  KILL: "bg-red-600 text-white",
  "PENDING GATES": "bg-zinc-100 text-zinc-400",
  "PENDING SCORES": "bg-zinc-100 text-zinc-400",
};

export function DecisionChip({ decision }: { decision: Decision | null }) {
  if (!decision) return <span className="text-zinc-300">—</span>;
  return (
    <span
      className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${DECISION_STYLES[decision]}`}
    >
      {decision}
    </span>
  );
}

const GATE_STATUS_STYLES: Record<GateStatus, string> = {
  PASS: "bg-teal-50 text-teal-700 border-teal-200",
  FAIL: "bg-red-50 text-red-700 border-red-200",
  PENDING: "bg-zinc-50 text-zinc-500 border-zinc-200",
};

export function GateStatusChip({
  status,
  detail,
}: {
  status: GateStatus;
  detail?: string;
}) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded border px-2 py-0.5 text-xs font-medium ${GATE_STATUS_STYLES[status]}`}
    >
      {status}
      {detail ? ` ${detail}` : ""}
    </span>
  );
}

/** Amber killer-flaw marker (no emoji — a drawn triangle). */
export function FlagIcon({ title }: { title?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="inline-block h-4 w-4 align-[-2px] text-amber-500"
      aria-label={title ?? "killer-flaw flag"}
      role="img"
    >
      {title ? <title>{title}</title> : null}
      <path
        d="M8 2 L14.5 13.5 H1.5 Z"
        fill="currentColor"
        stroke="none"
      />
      <rect x="7.3" y="6" width="1.4" height="4" rx="0.7" fill="white" />
      <circle cx="8" cy="11.6" r="0.8" fill="white" />
    </svg>
  );
}

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-xs text-zinc-500">{description}</p>
          ) : null}
        </div>
        {actions}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 text-sm text-zinc-500">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </div>
  );
}

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
}) {
  const styles = {
    primary:
      "bg-teal-600 text-white hover:bg-teal-700 disabled:bg-teal-300",
    secondary:
      "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 disabled:text-zinc-300",
    danger:
      "border border-red-300 bg-white text-red-600 hover:bg-red-50 disabled:text-red-300",
  }[variant];
  return (
    <button
      className={`rounded px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles} ${className}`}
      {...props}
    />
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 bg-white px-6 py-12 text-center text-sm text-zinc-500">
      {children}
    </div>
  );
}

/** Format a 0–100 score to one decimal, or an em dash when absent. */
export function fmtScore(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toFixed(1);
}
