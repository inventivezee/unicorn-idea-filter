"use client";

// Discovery — autonomous idea origination. A subscriber sets guidelines,
// AI agents (multiple vendors, real-browser research) generate ~10 ideas,
// score them through the unicorn instrument (cross-vendor), auto-reframe
// failures once, and publish everything scored into the pipeline. Runs
// continue with the browser closed (cron-advanced); we email when done.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, EmptyState, PageHeader, Section } from "@/components/ui";
import { TASKS_PER_RUN } from "@/lib/discovery/config";
import { useStore } from "@/lib/store";

interface TaskView {
  idx: number;
  status: string;
  model: string;
  error: string | null;
  ideaName: string | null;
  originalId: string | null;
  reframeId: string | null;
  activity?: Array<{ kind: "thought" | "tool"; text: string }>;
  watchUrl?: string | null;
  claimAgeSec?: number | null;
}

interface RunView {
  id: string;
  status: string;
  guidelines: string;
  createdAt: string;
  budget?: { totalTurns?: number; browserMinutes?: number };
  tasks?: TaskView[];
}

const PHASE_LABELS: Record<string, string> = {
  pending: "Queued",
  researching: "Researching market",
  generated: "Idea drafted",
  scoring: "Scoring",
  reframing: "Reframing",
  rescoring: "Rescoring",
  done: "Done",
  failed: "Failed",
};

const INDUSTRY_CHIPS = [
  "AI infrastructure",
  "Fintech",
  "Healthcare",
  "Climate & energy",
  "Developer tools",
  "Logistics",
  "Education",
  "Consumer",
];

export default function DiscoverPage() {
  const { cloud, hydrated, entitlements } = useStore();
  const [runs, setRuns] = useState<RunView[]>([]);
  const [guidelines, setGuidelines] = useState("");
  const [useBackground, setUseBackground] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeRun = runs.find((r) => r.status === "running") ?? null;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/discovery");
      if (!res.ok) return;
      const data = (await res.json()) as { runs?: RunView[] };
      let runs = data.runs ?? [];
      // The active run gets the detailed view (activity feed + live browser
      // links) from its own endpoint.
      const activeId = runs.find((r) => r.status === "running")?.id;
      if (activeId) {
        const detail = await fetch(`/api/discovery/${activeId}`);
        if (detail.ok) {
          const d = (await detail.json()) as RunView;
          runs = runs.map((r) => (r.id === activeId ? { ...r, ...d } : r));
        }
      }
      setRuns(runs);
    } catch {
      // Transient — next poll retries.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!cloud || !entitlements.signedIn) {
      setLoaded(true);
      return;
    }
    void refresh();
  }, [cloud, entitlements.signedIn, refresh]);

  // Poll while a run is active (read-only — the server cron does the work).
  useEffect(() => {
    if (!activeRun) return;
    pollTimer.current = setTimeout(() => void refresh(), 10_000);
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [activeRun, runs, refresh]);

  async function startRun() {
    setError(null);
    setStarting(true);
    try {
      const res = await fetch("/api/discovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guidelines, useFounderBackground: useBackground }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) {
        setError(data?.error ?? `Couldn't start the run (HTTP ${res.status}).`);
        return;
      }
      await refresh();
    } catch {
      setError("Network error — try again.");
    } finally {
      setStarting(false);
    }
  }

  async function cancelRun(id: string) {
    try {
      await fetch(`/api/discovery/${id}`, { method: "DELETE" });
      await refresh();
    } catch {
      // Next poll shows the truth.
    }
  }

  if (!hydrated) return null;

  // ------------------------------------------------------------------ gating
  if (!cloud) {
    return (
      <div>
        <PageHeader title="Discover" />
        <Section title="Needs the cloud deployment">
          <p className="text-sm text-zinc-600">
            Autonomous discovery runs AI agents with live browser research —
            it&apos;s only available on the cloud deployment.
          </p>
        </Section>
      </div>
    );
  }
  if (!entitlements.signedIn) {
    return (
      <div>
        <Header />
        <Section title="Sign in to start">
          <p className="mb-3 text-sm text-zinc-600">
            Discovery runs belong to your account — the ideas land in your
            pipeline.
          </p>
          <Link href="/signin">
            <Button variant="primary">Sign in</Button>
          </Link>
        </Section>
      </div>
    );
  }
  if (!entitlements.subscribed && !entitlements.isAdmin) {
    return (
      <div>
        <Header />
        <Section title="A subscriber feature">
          <p className="mb-3 text-sm text-zinc-600">
            AI agents research the market in a real browser, originate ideas,
            score them through the unicorn instrument, and deliver everything
            to your pipeline — fully autonomously.
          </p>
          <Link href="/upgrade?reason=discovery">
            <Button variant="primary">Upgrade to run discovery</Button>
          </Link>
        </Section>
      </div>
    );
  }

  // ------------------------------------------------------------------ main
  return (
    <div>
      <Header />

      {activeRun ? (
        <ActiveRun run={activeRun} onCancel={() => void cancelRun(activeRun.id)} />
      ) : (
        <Section
          title="Start a discovery run"
          description={`Generates ~${TASKS_PER_RUN} candidate ideas across model vendors with live browser research, scores each one, and publishes the results to your pipeline. Runs take a while — close the tab, we'll email you.`}
        >
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-500">
              Industries / areas to explore
            </span>
            <textarea
              rows={3}
              maxLength={20000}
              value={guidelines}
              onChange={(e) => setGuidelines(e.target.value)}
              placeholder="e.g. vertical AI for healthcare back-offices; climate fintech; anything touching construction"
              className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
            />
          </label>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {INDUSTRY_CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() =>
                  setGuidelines((g) => (g ? `${g}, ${chip}` : chip))
                }
                className="rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-0.5 text-xs text-zinc-600 hover:border-cyan-300 hover:text-cyan-700"
              >
                {chip}
              </button>
            ))}
          </div>
          <label className="mt-4 flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={useBackground}
              onChange={(e) => setUseBackground(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-cyan-600"
            />
            <span className="text-sm text-zinc-700">
              Use my founder background
              <span className="block text-xs text-zinc-500">
                Ideas get aimed at what you could credibly build. Public idea
                text only ever references your background in anonymised terms.
              </span>
            </span>
          </label>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              className="bg-cyan-600 hover:bg-cyan-700 disabled:bg-cyan-300"
              onClick={() => void startRun()}
              disabled={starting}
            >
              {starting ? "Starting…" : "Start discovery"}
            </Button>
            <span className="text-xs text-zinc-400">
              One run at a time; scored ideas publish to Explore.
            </span>
          </div>
          {error ? (
            <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </p>
          ) : null}
        </Section>
      )}

      <Section title="Past runs">
        {!loaded ? null : runs.filter((r) => r.status !== "running").length ===
          0 ? (
          <EmptyState>No discovery runs yet.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {runs
              .filter((r) => r.status !== "running")
              .map((run) => (
                <li
                  key={run.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2"
                >
                  <div className="min-w-0">
                    <span
                      className={`mr-2 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        run.status === "done"
                          ? "bg-cyan-50 text-cyan-700"
                          : "bg-zinc-100 text-zinc-500"
                      }`}
                    >
                      {run.status}
                    </span>
                    <span className="text-sm text-zinc-700">
                      {run.guidelines || "Open exploration"}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-zinc-500">
                    {run.tasks ? (
                      <span>
                        {run.tasks.filter((t) => t.status === "done").length}/
                        {run.tasks.length} ideas
                      </span>
                    ) : null}
                    <span>
                      {new Date(run.createdAt).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                  {run.tasks?.some((t) => t.originalId && t.status === "done") ? (
                    <div className="w-full text-xs">
                      {run.tasks
                        .filter((t) => t.status === "done" && t.ideaName)
                        .map((t) => (
                          <Link
                            key={t.idx}
                            href={`/idea/${t.originalId}`}
                            className="mr-3 text-cyan-700 underline-offset-2 hover:underline"
                          >
                            {t.ideaName}
                          </Link>
                        ))}
                    </div>
                  ) : null}
                </li>
              ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Header() {
  return (
    <PageHeader
      title="Discover"
      description="Fully autonomous idea origination: multi-vendor AI agents research the live web, generate candidates, score them against the unicorn bar (never with the model family that wrote them), reframe what fails, and publish everything scored."
    />
  );
}

function ActiveRun({
  run,
  onCancel,
}: {
  run: RunView;
  onCancel: () => void;
}) {
  const tasks = run.tasks ?? [];
  const [watchIdx, setWatchIdx] = useState<number | null>(null);
  const [viewNonce, setViewNonce] = useState(0);
  const watched = tasks.find((t) => t.idx === watchIdx) ?? null;
  const terminal = tasks.filter(
    (t) => t.status === "done" || t.status === "failed",
  ).length;
  return (
    <Section
      title="Discovery in progress"
      description="You can close this tab — the run continues on our servers and we'll email you when it finishes."
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-zinc-600">
          <span
            aria-hidden
            className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-200 border-t-cyan-600"
          />
          {terminal}/{tasks.length || "…"} candidates finished
          {run.guidelines ? ` — ${run.guidelines.slice(0, 80)}` : ""}
        </div>
        <Button className="px-2 py-1 text-xs!" onClick={onCancel}>
          Cancel run
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {tasks.map((t) => (
          <div
            key={t.idx}
            className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-2.5"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[10px] text-zinc-400">
                {t.model.split("/").pop()}
              </span>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  t.status === "done"
                    ? "bg-cyan-50 text-cyan-700"
                    : t.status === "failed"
                      ? "bg-red-50 text-red-600"
                      : "bg-zinc-100 text-zinc-600"
                }`}
              >
                {PHASE_LABELS[t.status] ?? t.status}
              </span>
            </div>
            <p className="mt-1 truncate text-sm text-zinc-800">
              {t.ideaName ??
                (t.status === "failed"
                  ? (t.error ?? "Failed")
                  : "Working…")}
            </p>
            {t.error && t.status !== "failed" ? (
              <p className="mt-0.5 text-[11px] leading-snug text-amber-700">
                ⚠ {t.error.slice(0, 140)}
              </p>
            ) : null}
            {t.activity && t.activity.length > 0 ? (
              <div className="mt-1.5 space-y-0.5 border-l-2 border-cyan-100 pl-2">
                {t.activity.slice(-3).map((a, i) => (
                  <p
                    key={i}
                    className="truncate text-[11px] leading-snug text-zinc-500"
                    title={a.text}
                  >
                    {a.kind === "tool" ? "🔎 " : "💭 "}
                    {a.text}
                  </p>
                ))}
              </div>
            ) : null}
            <div className="mt-1 flex items-center gap-3">
              {t.status === "done" && t.originalId ? (
                <Link
                  href={`/idea/${t.originalId}`}
                  className="text-xs text-cyan-700 underline-offset-2 hover:underline"
                >
                  Open idea →
                </Link>
              ) : null}
              {t.watchUrl ? (
                <button
                  type="button"
                  onClick={() =>
                    setWatchIdx((cur) => (cur === t.idx ? null : t.idx))
                  }
                  className="text-xs text-cyan-700 underline-offset-2 hover:underline"
                >
                  {watchIdx === t.idx ? "Hide agent view" : "Watch agent ▸"}
                </button>
              ) : null}
            </div>
          </div>
        ))}
        {tasks.length === 0 ? (
          <p className="text-sm text-zinc-500">Spinning up candidates…</p>
        ) : null}
      </div>

      {watched?.watchUrl ? (
        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-xs font-medium text-zinc-600">
              Agent view — {watched.model.split("/").pop()}
              {watched.ideaName ? ` · ${watched.ideaName}` : ""}
              <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-normal text-zinc-500">
                view-only
              </span>
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setViewNonce((n) => n + 1)}
                className="text-xs text-zinc-500 hover:text-zinc-900"
                title="Reload the view if it looks blank"
              >
                ⟳ Reload view
              </button>
              <button
                type="button"
                onClick={() => setWatchIdx(null)}
                className="text-xs text-zinc-500 hover:text-zinc-900"
              >
                ✕ Close
              </button>
            </div>
          </div>
          <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-zinc-200 bg-zinc-900">
            {/* pointer-events-none makes the live view strictly view-only —
                the agent drives; the viewer can never click through. */}
            <iframe
              key={`${watched.idx}-${viewNonce}`}
              src={watched.watchUrl}
              className="pointer-events-none h-full w-full border-0"
              sandbox="allow-scripts allow-same-origin"
              title="Agent browser (view-only)"
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-3 py-1.5 text-[11px] text-white/90">
              The agent is driving this browser — watching{" "}
              {watched.model.split("/").pop()} research live.
            </div>
          </div>
        </div>
      ) : null}
    </Section>
  );
}
