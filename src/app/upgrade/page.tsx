"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button, PageHeader, Section } from "@/components/ui";
import {
  FREE_ANALYSES_PER_DAY,
  SUBSCRIPTION_PRICE_LABEL,
} from "@/lib/entitlements";
import { useStore } from "@/lib/store";

const REASONS: Record<string, string> = {
  quota:
    "You've used all your free AI analyses for now. Subscribe for unlimited analyses.",
  premium:
    "That model is available to subscribers. Subscribe to use the premium models.",
  private:
    "Keeping an idea out of the public database is a subscriber feature.",
  discovery:
    "Autonomous idea discovery is a subscriber feature — AI agents research the market and deliver scored ideas to your pipeline.",
};

const BENEFITS = [
  {
    title: "Unlimited AI analyses",
    body: `Free accounts get ${FREE_ANALYSES_PER_DAY} analyses a day; anonymous visitors get 3 a day. Subscribers run as many as they need (fair use).`,
  },
  {
    title: "Premium reasoning",
    body: "Claude Fable 5, plus GPT-5.5 at xhigh reasoning effort. The free tier runs Sonnet 5 and GPT-5.5 at medium effort.",
  },
  {
    title: "Private ideas",
    body: "Keep any idea out of the public Explore database — yours to see, no one else's.",
  },
  {
    title: "Unlimited web search",
    body: "Subscriber analyses search the live web as much as the idea needs to verify market size, competitors, and timing. The free tier is capped at 5 searches per analysis.",
  },
];

export default function UpgradePage() {
  return (
    <Suspense fallback={null}>
      <UpgradeInner />
    </Suspense>
  );
}

function UpgradeInner() {
  const { cloud, hydrated, entitlements } = useStore();
  const router = useRouter();
  const searchParams = useSearchParams();
  const reason = searchParams.get("reason");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upgrade() {
    if (!entitlements.signedIn) {
      router.push("/signin");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/stripe/checkout", { method: "POST" });
      const data = (await res.json().catch(() => null)) as {
        url?: string;
        error?: string;
      } | null;
      if (res.ok && data?.url) {
        window.location.href = data.url;
        return;
      }
      setError(data?.error ?? "Couldn't start checkout — try again.");
    } catch {
      setError("Couldn't start checkout — try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!hydrated) return null;

  if (!cloud) {
    return (
      <div>
        <PageHeader title="Upgrade" />
        <Section title="Not available">
          <p className="text-sm text-zinc-600">
            Subscriptions aren&apos;t configured on this deployment.
          </p>
        </Section>
      </div>
    );
  }

  if (entitlements.subscribed) {
    return (
      <div>
        <PageHeader
          title="You're a subscriber"
          description="Unlimited analyses, premium models, and private ideas are unlocked."
        />
        <Section title="Manage">
          <p className="mb-3 text-sm text-zinc-600">
            Manage or cancel your subscription from Settings.
          </p>
          <Link href="/settings">
            <Button variant="primary">Go to Settings</Button>
          </Link>
        </Section>
      </div>
    );
  }

  const remaining = entitlements.analysesRemaining;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Upgrade to Pro"
        description={`Unlimited AI analyses, premium models, and private ideas — ${SUBSCRIPTION_PRICE_LABEL}.`}
      />

      {reason && REASONS[reason] ? (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {REASONS[reason]}
          {reason === "quota" &&
          remaining !== null &&
          entitlements.signedIn ? (
            <span className="mt-1 block text-xs">
              You have {remaining} of {FREE_ANALYSES_PER_DAY} free analyses
              left today.
            </span>
          ) : null}
        </div>
      ) : null}

      <Section
        title={`Pro — ${SUBSCRIPTION_PRICE_LABEL}`}
        description="Cancel anytime from Settings."
      >
        <ul className="space-y-3">
          {BENEFITS.map((b) => (
            <li key={b.title} className="flex gap-2.5">
              <span
                aria-hidden
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-teal-600"
              />
              <span>
                <span className="block text-sm font-medium text-zinc-900">
                  {b.title}
                </span>
                <span className="block text-xs text-zinc-500">{b.body}</span>
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button variant="primary" onClick={() => void upgrade()} disabled={busy}>
            {busy
              ? "Starting checkout…"
              : entitlements.signedIn
                ? `Subscribe — ${SUBSCRIPTION_PRICE_LABEL}`
                : "Sign in to subscribe"}
          </Button>
          <Link
            href="/"
            className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline"
          >
            Not now — back to the app
          </Link>
        </div>
        {error ? (
          <p className="mt-3 text-xs text-red-600">{error}</p>
        ) : null}
      </Section>

      <p className="mt-4 text-center text-xs text-zinc-400">
        You can keep using the free tier — {FREE_ANALYSES_PER_DAY} analyses a
        day with Sonnet 5 and GPT-5.5 at medium effort.
      </p>
    </div>
  );
}
