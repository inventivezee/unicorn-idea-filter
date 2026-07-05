"use client";

// Custom filter studio: design a personal scoring instrument around the
// founder's actual goals. Designing is a subscriber feature (account
// required) and runs a three-model chain in the background — GPT-5.5 Pro at
// highest effort, reviewed by Claude Fable 5 at max effort, finalized by
// GPT-5.5 Pro — which takes 10-15+ minutes per GPT stage. Progress lives in
// a server-side draft, so the founder can leave and resume any time.
// Unfinished goal forms autosave as drafts too. Custom filters are private —
// never published; admins can see them (and all drafts).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { Button, PageHeader, Section } from "@/components/ui";
import type { CustomFilterInputs, CustomFilterSpec } from "@/lib/types";

const MAX_FILTERS = 5;
const POLL_MS = 20_000;
const AUTOSAVE_MS = 1500;

const inputCls =
  "h-9 w-full rounded border border-zinc-300 bg-white px-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500";

const DEFAULT_INPUTS: CustomFilterInputs = {
  netProfitTarget: 1_000_000,
  hoursPerDay: 8,
  yearsToBuild: 5,
  capitalAvailable: "",
  maxTeamSize: "",
  wantsToSell: "maybe",
  otherQualities: "",
};

interface FilterDraft {
  id: string;
  status: "draft" | "designing" | "ready" | "failed";
  payload: {
    inputs?: CustomFilterInputs;
    existingId?: string;
    existingVersion?: number;
    chain?: { stage?: number; error?: string; startedAt?: string };
    resultSpec?: CustomFilterSpec;
  };
  updated_at: string;
}

interface JobStatus {
  status: "draft" | "designing" | "ready" | "failed";
  stage: number;
  startedAt: string | null;
  stageStartedAt: string | null;
  error: string | null;
  spec: CustomFilterSpec | null;
}

const STAGE_COPY: Record<number, { title: string; note: string }> = {
  1: {
    title: "Stage 1 of 3 — ChatGPT 5.5 Pro designs your instrument",
    note: "Running at its highest effort — this stage typically takes 10–15 minutes.",
  },
  2: {
    title: "Stage 2 of 3 — Claude Fable 5 reviews the design",
    note: "An adversarial review at max effort: checking your numbers are encoded, the math adds up, and nothing overlaps.",
  },
  3: {
    title: "Stage 3 of 3 — ChatGPT 5.5 Pro finalizes",
    note: "Reconciling both versions into the final instrument — typically another 10–15 minutes.",
  },
};

function NumField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  prefix,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  prefix?: string;
  suffix?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-600">
        {label}
      </span>
      <div className="flex items-center gap-1.5">
        {prefix ? <span className="text-sm text-zinc-500">{prefix}</span> : null}
        <input
          type="number"
          value={Number.isFinite(value) ? value : ""}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const n = e.target.valueAsNumber;
            onChange(Number.isNaN(n) ? min : n);
          }}
          className={`${inputCls} tnum`}
        />
        {suffix ? (
          <span className="whitespace-nowrap text-sm text-zinc-500">
            {suffix}
          </span>
        ) : null}
      </div>
    </label>
  );
}

function Elapsed({ since }: { since: string | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!since) return null;
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 60_000));
  return (
    <span className="tnum text-xs text-zinc-400">
      {mins < 1 ? "just started" : `${mins} min elapsed`}
    </span>
  );
}

export default function FiltersPage() {
  const { state, hydrated, cloud, entitlements, updateSettings } = useStore();
  const router = useRouter();
  const settings = state.settings;

  const [inputs, setInputs] = useState<CustomFilterInputs>(DEFAULT_INPUTS);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CustomFilterSpec | null>(null);
  /** When set, "Design" regenerates this existing filter (same id, v+1). */
  const [regenId, setRegenId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  /** The running/finished background job (a filter draft in the DB). */
  const [job, setJob] = useState<{ draftId: string; s: JobStatus } | null>(
    null,
  );
  /** The autosaved goals draft (status "draft") backing the form. */
  const draftIdRef = useRef<string | null>(null);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);
  const loadedRef = useRef(false);

  const eligible =
    cloud && entitlements.signedIn && (entitlements.subscribed || entitlements.isAdmin);

  // -----------------------------------------------------------------------
  // Boot: restore the newest saved goals draft and any running/ready job.
  // -----------------------------------------------------------------------
  const filtersRef = useRef(settings.customFilters);
  filtersRef.current = settings.customFilters;

  useEffect(() => {
    if (!hydrated || !eligible || loadedRef.current) return;
    loadedRef.current = true;
    void (async () => {
      try {
        const res = await fetch("/api/drafts?kind=filter");
        if (!res.ok) return;
        const data = (await res.json()) as { drafts?: FilterDraft[] };
        const drafts = data.drafts ?? [];
        const validRegen = (id?: string) =>
          id && filtersRef.current.some((f) => f.id === id) ? id : null;
        // A ready row whose EXACT spec (id + version + createdAt — version
        // alone can collide when a stale tab regenerates) already lives in
        // settings was accepted; the row is kept at accept time until
        // settings demonstrably persisted — seeing it here proves that.
        const accepted = (d: FilterDraft) =>
          d.status === "ready" &&
          d.payload.resultSpec &&
          filtersRef.current.some(
            (f) =>
              f.id === d.payload.resultSpec!.id &&
              f.version === d.payload.resultSpec!.version &&
              f.createdAt === d.payload.resultSpec!.createdAt,
          );
        const surfaceable = drafts.filter(
          (d) =>
            (d.status === "designing" ||
              d.status === "ready" ||
              d.status === "failed") &&
            !accepted(d),
        );
        // Newest of designing > ready > failed becomes THE job. Only rows we
        // can PROVE are done with get cleaned up: accepted-ready rows and
        // superseded failed rows — never an unaccepted ready design (another
        // device may be reviewing it) and never a designing row.
        const byPriority = (st: string) =>
          st === "designing" ? 0 : st === "ready" ? 1 : 2;
        surfaceable.sort(
          (a, b) =>
            byPriority(a.status) - byPriority(b.status) ||
            b.updated_at.localeCompare(a.updated_at),
        );
        const active = surfaceable[0];
        const cleanup = drafts.filter(
          (d) =>
            accepted(d) || (d.status === "failed" && d.id !== active?.id),
        );
        for (const d of cleanup) {
          // expect= makes this a conditional delete: a no-op if another tab
          // flipped the row (e.g. failed → designing via Try again) between
          // our snapshot and this request.
          void fetch(
            `/api/drafts/${d.id}?expect=${encodeURIComponent(d.status)}`,
            { method: "DELETE" },
          ).catch(() => {});
        }
        if (active) {
          if (active.payload.inputs) setInputs(active.payload.inputs);
          setRegenId(validRegen(active.payload.existingId));
          setJob({
            draftId: active.id,
            s: {
              status: active.status as JobStatus["status"],
              stage: active.payload.chain?.stage ?? 1,
              startedAt: active.payload.chain?.startedAt ?? null,
              stageStartedAt: null,
              error: active.payload.chain?.error ?? null,
              spec: active.payload.resultSpec ?? null,
            },
          });
          if (active.status === "ready" && active.payload.resultSpec) {
            setPreview(active.payload.resultSpec);
          }
          return;
        }
        const saved = drafts.find((d) => d.status === "draft");
        if (saved) {
          draftIdRef.current = saved.id;
          if (saved.payload.inputs) setInputs(saved.payload.inputs);
          setRegenId(validRegen(saved.payload.existingId));
        }
      } catch {
        // Draft restore is best-effort.
      }
    })();
  }, [hydrated, eligible]);

  // -----------------------------------------------------------------------
  // Autosave the goals form as a draft (create on first edit, then PATCH).
  // -----------------------------------------------------------------------
  const scheduleAutosave = useCallback(() => {
    if (!eligible) return;
    dirtyRef.current = true;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => void flushAutosave(), AUTOSAVE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible]);

  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const regenRef = useRef(regenId);
  regenRef.current = regenId;
  // All saves run through one promise chain, so a debounced flush and a
  // design()-triggered flush can never interleave (double-create / lost id).
  const flushChainRef = useRef<Promise<void>>(Promise.resolve());

  function flushAutosave(): Promise<void> {
    const run = async () => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      const regen = regenRef.current;
      const existing = regen
        ? filtersRef.current.find((f) => f.id === regen)
        : undefined;
      const payload = {
        inputs: inputsRef.current,
        ...(existing
          ? { existingId: existing.id, existingVersion: existing.version }
          : {}),
      };
      try {
        if (draftIdRef.current) {
          const res = await fetch(`/api/drafts/${draftIdRef.current}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ payload }),
          });
          if (res.ok) return;
          if (res.status === 404 || res.status === 409) {
            // Row gone, or upgraded into a running job — stop writing to it.
            draftIdRef.current = null;
          } else {
            dirtyRef.current = true; // real failure — retry later
            return;
          }
        }
        const res = await fetch("/api/drafts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "filter", payload }),
        });
        if (res.ok) {
          const data = (await res.json()) as { draft?: { id?: string } };
          if (data.draft?.id) draftIdRef.current = data.draft.id;
        } else {
          dirtyRef.current = true;
        }
      } catch {
        dirtyRef.current = true; // retry on the next edit
      }
    };
    const next = flushChainRef.current.then(run, run);
    flushChainRef.current = next;
    return next;
  }

  function patchInputs(patch: Partial<CustomFilterInputs>) {
    setInputs((i) => ({ ...i, ...patch }));
    scheduleAutosave();
  }

  // -----------------------------------------------------------------------
  // Poll the running job; each poll also advances the chain server-side.
  // -----------------------------------------------------------------------
  const [pollWarning, setPollWarning] = useState<string | null>(null);
  useEffect(() => {
    if (!job || job.s.status !== "designing") return;
    let cancelled = false;
    let misses = 0;
    const poll = async () => {
      try {
        const res = await fetch(
          `/api/filter-design/status?draft=${encodeURIComponent(job.draftId)}`,
        );
        if (cancelled) return;
        if (!res.ok) {
          if (res.status === 404) {
            // The job row is gone — cancelled from another tab, most likely.
            setJob(null);
            setPreview(null);
            setError(
              "This design is no longer available — it may have been cancelled in another tab.",
            );
            return;
          }
          if (res.status === 401) {
            setPollWarning(
              "Your session expired — sign in again to keep the design advancing.",
            );
            return;
          }
          misses += 1;
          if (misses >= 5) {
            setPollWarning(
              "Having trouble checking progress — still retrying every 20 seconds.",
            );
          }
          return;
        }
        misses = 0;
        setPollWarning(null);
        const s = (await res.json()) as JobStatus;
        if (cancelled) return;
        setJob({ draftId: job.draftId, s });
        if (s.status === "ready" && s.spec) setPreview(s.spec);
      } catch {
        misses += 1;
        if (misses >= 5 && !cancelled) {
          setPollWarning(
            "Having trouble checking progress — still retrying every 20 seconds.",
          );
        }
      }
    };
    void poll();
    const t = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.draftId, job?.s.status]);

  if (!hydrated) return null;

  const filters = settings.customFilters;
  const atCap = filters.length >= MAX_FILTERS && !regenId;
  const designing = job?.s.status === "designing";

  async function design() {
    if (starting || designing || atCap || !eligible) return;
    setError(null);
    setStarting(true);
    setPreview(null);
    try {
      await flushAutosave();
      const existing = regenId
        ? filters.find((f) => f.id === regenId)
        : undefined;
      const res = await fetch("/api/filter-design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputs,
          founderBackground: settings.founderBackground,
          coFounders: settings.coFounders
            .filter((c) => c.background.trim())
            .map((c) => ({ name: c.name, background: c.background })),
          ...(draftIdRef.current ? { draftId: draftIdRef.current } : {}),
          ...(existing
            ? { existingId: existing.id, existingVersion: existing.version }
            : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        draftId?: string;
        error?: string;
        upgrade?: boolean;
        signin?: boolean;
      };
      if (!res.ok) {
        if (data.signin) {
          router.push("/signin");
          return;
        }
        if (data.upgrade || res.status === 402) {
          router.push("/upgrade?reason=premium");
          return;
        }
        if (res.status === 409 && data.draftId) {
          // A design is already running — attach to it.
          setJob({
            draftId: data.draftId,
            s: {
              status: "designing",
              stage: 1,
              startedAt: null,
              stageStartedAt: null,
              error: null,
              spec: null,
            },
          });
          return;
        }
        setError(data.error ?? `Couldn't start the design (HTTP ${res.status}).`);
        return;
      }
      if (!data.draftId) {
        setError("The design didn't start — try again.");
        return;
      }
      // The goals draft row was upgraded into the job.
      if (draftIdRef.current === data.draftId) draftIdRef.current = null;
      setJob({
        draftId: data.draftId,
        s: {
          status: "designing",
          stage: 1,
          startedAt: new Date().toISOString(),
          stageStartedAt: new Date().toISOString(),
          error: null,
          spec: null,
        },
      });
    } catch {
      setError("Network error while starting the design.");
    } finally {
      setStarting(false);
    }
  }

  async function discardJob() {
    if (!job) return;
    const id = job.draftId;
    setJob(null);
    setPreview(null);
    try {
      await fetch(`/api/drafts/${id}`, { method: "DELETE" });
    } catch {
      // Best-effort cleanup.
    }
  }

  function acceptPreview() {
    if (!preview) return;
    const others = filters.filter((f) => f.id !== preview.id);
    if (others.length >= MAX_FILTERS) {
      setError(
        `You already have ${MAX_FILTERS} filters — delete one below, then accept this design.`,
      );
      return;
    }
    updateSettings({
      customFilters: [...others, preview],
      filterMode: "custom",
      activeCustomFilterId: preview.id,
    });
    // Deliberately NOT deleting the ready draft here: the settings write is
    // a debounced background sync that can fail. The next /filters boot
    // deletes the row once the filter is provably in settings.
    setJob(null);
    setPreview(null);
    setRegenId(null);
    router.push("/");
  }

  function startRegenerate(f: CustomFilterSpec) {
    setRegenId(f.id);
    setInputs(f.inputs);
    setPreview(null);
    setError(null);
    scheduleAutosave();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function deleteFilter(id: string) {
    const f = filters.find((x) => x.id === id);
    if (
      !window.confirm(
        `Delete "${f?.name ?? "this filter"}"? Ideas keep their old verdicts (marked as from a deleted filter).`,
      )
    ) {
      return;
    }
    const next = filters.filter((x) => x.id !== id);
    updateSettings({
      customFilters: next,
      ...(settings.activeCustomFilterId === id
        ? { filterMode: "unicorn" as const, activeCustomFilterId: null }
        : {}),
    });
    if (regenId === id) setRegenId(null);
  }

  const lowHours = inputs.hoursPerDay < 8;
  const stageCopy = STAGE_COPY[job?.s.stage ?? 1] ?? STAGE_COPY[1];

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Your custom filters"
        description="Not everyone wants a unicorn or $20M EBITDA. Tell the AI what you actually want — it designs a scoring instrument around your life. Custom filters are private: never shown in the public database."
      />

      {!eligible ? (
        <Section
          title="Design your own filter"
          description="A subscriber feature: your goals are turned into a personal scoring instrument by a three-model design chain — ChatGPT 5.5 Pro at highest effort, adversarially reviewed by Claude Fable 5 at max effort, then finalized by ChatGPT 5.5 Pro."
        >
          {!cloud ? (
            <p className="text-sm text-zinc-600">
              This deployment runs without cloud accounts, so custom filter
              design isn&apos;t available here.
            </p>
          ) : !entitlements.signedIn ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={() => router.push("/signin")}>
                Sign up / Sign in
              </Button>
              <span className="text-xs text-zinc-500">
                Designing a filter requires an account, so your filters and
                drafts follow you across devices.
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                onClick={() => router.push("/upgrade?reason=premium")}
              >
                Upgrade — $19/month
              </Button>
              <span className="text-xs text-zinc-500">
                The design chain runs the most capable models at their highest
                effort — it&apos;s a subscriber feature.
              </span>
            </div>
          )}
        </Section>
      ) : null}

      {eligible && designing ? (
        <Section
          title="Designing your filter…"
          description="A three-model chain is at work. You can close this tab — or your whole browser — the design keeps running on the server (checked every minute) and will be waiting here when you come back."
        >
          <div className="space-y-3">
            {[1, 2, 3].map((n) => {
              const current = (job?.s.stage ?? 1) === n;
              const done = (job?.s.stage ?? 1) > n;
              const copy = STAGE_COPY[n];
              return (
                <div key={n} className="flex items-start gap-3">
                  <span
                    aria-hidden
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                      done
                        ? "bg-violet-500 text-white"
                        : current
                          ? "border-2 border-violet-500 text-violet-600"
                          : "border border-zinc-300 text-zinc-400"
                    }`}
                  >
                    {done ? "✓" : n}
                  </span>
                  <div className="min-w-0">
                    <p
                      className={`text-sm ${
                        current
                          ? "font-medium text-zinc-900"
                          : done
                            ? "text-zinc-600"
                            : "text-zinc-400"
                      }`}
                    >
                      {copy.title}
                    </p>
                    {current ? (
                      <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                        <span
                          aria-hidden
                          className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-zinc-200 border-t-violet-500"
                        />
                        {copy.note}{" "}
                        <Elapsed since={job?.s.stageStartedAt ?? job?.s.startedAt ?? null} />
                      </p>
                    ) : null}
                  </div>
                </div>
              );
            })}
            <p className="border-t border-zinc-100 pt-3 text-xs text-zinc-400">
              Started <Elapsed since={job?.s.startedAt ?? null} /> · checking
              progress every 20 seconds.
            </p>
            {pollWarning ? (
              <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {pollWarning}
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => void discardJob()}
              className="text-xs text-zinc-400 underline-offset-2 hover:text-red-600 hover:underline"
            >
              Cancel this design
            </button>
          </div>
        </Section>
      ) : null}

      {eligible && !designing && !preview ? (
        <Section
          title={regenId ? "Redesign this filter" : "Design a new filter"}
          description="State your goals; a three-model chain (ChatGPT 5.5 Pro → Claude Fable 5 review → ChatGPT 5.5 Pro final pass) turns them into gates, weighted criteria, and scoring anchors. The full run takes roughly 20–40 minutes — your form autosaves as a draft."
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <NumField
              label="Target net profit / year"
              value={inputs.netProfitTarget}
              onChange={(v) => patchInputs({ netProfitTarget: v })}
              min={1000}
              max={1_000_000_000}
              step={50_000}
              prefix="$"
            />
            <NumField
              label="Hours / day you want to work"
              value={inputs.hoursPerDay}
              onChange={(v) => patchInputs({ hoursPerDay: v })}
              min={1}
              max={24}
              suffix="hrs"
            />
            <NumField
              label="Years to build it"
              value={inputs.yearsToBuild}
              onChange={(v) => patchInputs({ yearsToBuild: v })}
              min={1}
              max={50}
              suffix="yrs"
            />
          </div>
          {lowHours ? (
            <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Just a kind heads-up: in the building phase a startup typically
              demands quite a bit more than 8 hours a day — 8 is the suggested
              minimum. We&apos;ll design your filter around{" "}
              {inputs.hoursPerDay} hrs/day anyway, but expect the early years
              to ask more of you.
            </p>
          ) : null}

          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-zinc-600">
                Capital you can invest
              </span>
              <input
                type="text"
                value={inputs.capitalAvailable}
                onChange={(e) =>
                  patchInputs({ capitalAvailable: e.target.value })
                }
                placeholder="e.g. $25k, none"
                className={inputCls}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-zinc-600">
                Max team size
              </span>
              <input
                type="text"
                value={inputs.maxTeamSize}
                onChange={(e) => patchInputs({ maxTeamSize: e.target.value })}
                placeholder="e.g. solo, 2–3 people"
                className={inputCls}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-zinc-600">
                Want to sell it one day?
              </span>
              <select
                value={inputs.wantsToSell}
                onChange={(e) =>
                  patchInputs({
                    wantsToSell: e.target
                      .value as CustomFilterInputs["wantsToSell"],
                  })
                }
                className={inputCls}
              >
                <option value="maybe">Maybe</option>
                <option value="yes">Yes</option>
                <option value="no">No — keep it forever</option>
              </select>
            </label>
          </div>

          <label className="mt-4 block">
            <span className="mb-1 block text-xs font-medium text-zinc-600">
              Anything else that matters to you
            </span>
            <textarea
              rows={3}
              value={inputs.otherQualities}
              onChange={(e) => patchInputs({ otherQualities: e.target.value })}
              placeholder="e.g. fully remote, no investors ever, mostly passive by year 5, no phone calls, something I'd be proud to tell my kids about…"
              className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
            />
          </label>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              onClick={() => void design()}
              disabled={starting || atCap}
            >
              {starting
                ? "Starting…"
                : regenId
                  ? "Redesign filter"
                  : "Design my filter"}
            </Button>
            {regenId ? (
              <button
                type="button"
                onClick={() => {
                  setRegenId(null);
                  setPreview(null);
                  scheduleAutosave();
                }}
                className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline"
              >
                Cancel redesign
              </button>
            ) : null}
            {atCap ? (
              <span className="text-xs text-zinc-400">
                Maximum of {MAX_FILTERS} filters — delete one to add another.
              </span>
            ) : null}
            <span className="text-xs text-zinc-400">
              Heads-up: the first stage alone typically takes 10–15 minutes.
            </span>
          </div>
          {error ? (
            <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </p>
          ) : null}
        </Section>
      ) : null}

      {eligible && job?.s.status === "failed" ? (
        <div className="mt-6">
          <Section title="The design failed">
            <p className="text-sm text-red-700">
              {job.s.error ?? "Something went wrong in the design chain."}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                onClick={() => {
                  draftIdRef.current = job.draftId;
                  setJob(null);
                  void design();
                }}
              >
                Try again
              </Button>
              <button
                type="button"
                onClick={() => void discardJob()}
                className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline"
              >
                Discard
              </button>
            </div>
          </Section>
        </div>
      ) : null}

      {preview ? (
        <div className="mt-6">
          <Section
            title={`Preview: ${preview.name}`}
            description={preview.question}
          >
            <div className="space-y-4">
              <p className="rounded border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-800">
                Designed by ChatGPT 5.5 Pro, adversarially reviewed by Claude
                Fable 5, finalized by ChatGPT 5.5 Pro.
              </p>
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                  Gates (any N kills)
                </h3>
                <ul className="mt-1.5 space-y-1.5">
                  {preview.gates.map((g) => (
                    <li key={g.id} className="text-sm">
                      <span className="font-medium text-zinc-800">
                        {g.label}
                      </span>
                      <span className="block text-xs text-zinc-500">
                        Y — {g.yMeans} · N — {g.nMeans}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                  Criteria (weights sum to 100)
                </h3>
                <ul className="mt-1.5 space-y-1">
                  {preview.criteria.map((c) => (
                    <li key={c.id} className="flex items-baseline gap-2 text-sm">
                      <span className="tnum w-8 shrink-0 text-right font-semibold text-violet-600">
                        {c.weight}
                      </span>
                      <span className="text-zinc-800">{c.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex flex-wrap items-center gap-3 border-t border-zinc-100 pt-3">
                <Button variant="primary" onClick={acceptPreview}>
                  Use this filter
                </Button>
                <Button
                  onClick={() => {
                    if (job) draftIdRef.current = job.draftId;
                    setJob(null);
                    setPreview(null);
                    void design();
                  }}
                  disabled={starting}
                >
                  Regenerate
                </Button>
                <button
                  type="button"
                  onClick={() => void discardJob()}
                  className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline"
                >
                  Discard
                </button>
                <span className="text-xs text-zinc-400">
                  Accepting switches you to this filter.
                </span>
              </div>
            </div>
          </Section>
        </div>
      ) : null}

      {filters.length > 0 ? (
        <div className="mt-6">
          <Section
            title="Your filters"
            description="Switch between them from the top-left dropdown."
          >
            <ul className="divide-y divide-zinc-100">
              {filters.map((f) => (
                <li
                  key={f.id}
                  className="flex flex-wrap items-center gap-2 py-2.5"
                >
                  <span
                    aria-hidden
                    className="h-2 w-2 shrink-0 rounded-full bg-violet-500"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-zinc-900">
                      {f.name}
                      <span className="ml-1.5 text-[10px] font-normal text-zinc-400">
                        v{f.version}
                      </span>
                    </p>
                    <p className="truncate text-xs text-zinc-500">
                      {f.question}
                    </p>
                  </div>
                  {eligible ? (
                    <Button
                      className="px-2 py-1 text-xs!"
                      onClick={() => startRegenerate(f)}
                    >
                      Redesign
                    </Button>
                  ) : null}
                  <Button
                    variant="danger"
                    className="px-2 py-1 text-xs!"
                    onClick={() => deleteFilter(f.id)}
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      ) : null}

      <p className="mt-6 text-center text-xs text-zinc-400">
        Custom filters, their verdicts, and drafts are visible only to you and
        the site admin —{" "}
        <Link href="/privacy" className="underline hover:text-zinc-600">
          privacy policy
        </Link>
        .
      </p>
    </div>
  );
}
