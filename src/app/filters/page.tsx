"use client";

// Custom filter studio: design a personal scoring instrument around the
// founder's actual goals (net profit, hours, years, capital, team, life
// constraints), preview the AI-designed gates/criteria, and manage saved
// filters. Custom filters are private — never published; admins can see them.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { getAnonKey } from "@/lib/anon";
import { useStore } from "@/lib/store";
import { Button, PageHeader, Section } from "@/components/ui";
import type { CustomFilterInputs, CustomFilterSpec } from "@/lib/types";

const MAX_FILTERS = 5;

const inputCls =
  "h-9 w-full rounded border border-zinc-300 bg-white px-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500";

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

export default function FiltersPage() {
  const { state, hydrated, updateSettings } = useStore();
  const router = useRouter();
  const settings = state.settings;

  const [inputs, setInputs] = useState<CustomFilterInputs>({
    netProfitTarget: 1_000_000,
    hoursPerDay: 8,
    yearsToBuild: 5,
    capitalAvailable: "",
    maxTeamSize: "",
    wantsToSell: "maybe",
    otherQualities: "",
  });
  const [designing, setDesigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CustomFilterSpec | null>(null);
  /** When set, "Design" regenerates this existing filter (same id, v+1). */
  const [regenId, setRegenId] = useState<string | null>(null);

  if (!hydrated) return null;

  const filters = settings.customFilters;
  const atCap = filters.length >= MAX_FILTERS && !regenId;

  function patchInputs(patch: Partial<CustomFilterInputs>) {
    setInputs((i) => ({ ...i, ...patch }));
  }

  async function design() {
    if (designing || atCap) return;
    setError(null);
    setDesigning(true);
    setPreview(null);
    try {
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
          provider: settings.provider,
          model: settings.models[settings.provider],
          anonKey: getAnonKey(),
          ...(existing
            ? { existingId: existing.id, existingVersion: existing.version }
            : {}),
        }),
      });
      if (!res.ok) {
        let message = `Couldn't design the filter (HTTP ${res.status}).`;
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === "string" && body.error) message = body.error;
        } catch {
          // Non-JSON error body.
        }
        setError(message);
        return;
      }
      const data = (await res.json()) as { spec?: CustomFilterSpec };
      if (!data.spec) {
        setError("The design came back unusable — try again.");
        return;
      }
      setPreview(data.spec);
    } catch {
      setError("Network error while designing the filter.");
    } finally {
      setDesigning(false);
    }
  }

  function acceptPreview() {
    if (!preview) return;
    const others = filters.filter((f) => f.id !== preview.id);
    // Never silently drop the just-accepted filter: if the list filled up
    // while the preview was open (another tab, restored sync), say so
    // instead of activating a filter that wasn't actually saved.
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
    setPreview(null);
    setRegenId(null);
    router.push("/");
  }

  function startRegenerate(f: CustomFilterSpec) {
    setRegenId(f.id);
    setInputs(f.inputs);
    setPreview(null);
    setError(null);
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

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Your custom filters"
        description="Not everyone wants a unicorn or $20M EBITDA. Tell the AI what you actually want — it designs a scoring instrument around your life. Custom filters are private: never shown in the public database."
      />

      <Section
        title={regenId ? "Redesign this filter" : "Design a new filter"}
        description="State your goals; the AI turns them into gates, weighted criteria, and scoring anchors — the same machinery as the built-in filters, calibrated to you."
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
            {inputs.hoursPerDay} hrs/day anyway, but expect the early years to
            ask more of you.
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
              onChange={(e) => patchInputs({ capitalAvailable: e.target.value })}
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
                  wantsToSell: e.target.value as CustomFilterInputs["wantsToSell"],
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
            disabled={designing || atCap}
          >
            {designing
              ? "Designing…"
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
              }}
              className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline"
            >
              Cancel redesign
            </button>
          ) : null}
          {designing ? (
            <span className="flex items-center gap-2 text-xs text-zinc-500">
              <span
                aria-hidden
                className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-200 border-t-violet-500"
              />
              Turning your goals into gates and criteria…
            </span>
          ) : null}
          {atCap ? (
            <span className="text-xs text-zinc-400">
              Maximum of {MAX_FILTERS} filters — delete one to add another.
            </span>
          ) : null}
        </div>
        {error ? (
          <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        ) : null}
      </Section>

      {preview ? (
        <div className="mt-6">
          <Section
            title={`Preview: ${preview.name}`}
            description={preview.question}
          >
            <div className="space-y-4">
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
                    <li
                      key={c.id}
                      className="flex items-baseline gap-2 text-sm"
                    >
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
                <Button onClick={() => void design()} disabled={designing}>
                  Regenerate
                </Button>
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
                  <Button
                    className="px-2 py-1 text-xs!"
                    onClick={() => startRegenerate(f)}
                  >
                    Redesign
                  </Button>
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
        Custom filters and their verdicts are visible only to you and the site
        admin —{" "}
        <Link href="/privacy" className="underline hover:text-zinc-600">
          privacy policy
        </Link>
        .
      </p>
    </div>
  );
}
