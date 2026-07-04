"use client";

import Link from "next/link";
import { useState } from "react";
import { CRITERIA, GATES } from "@/lib/criteria";
import {
  adjustedScore,
  decision,
  gateStatus,
  killerFlags,
  rawScore,
  KILLER_FLAG_COPY,
} from "@/lib/engine";
import { useStore } from "@/lib/store";
import type { Idea } from "@/lib/types";
import {
  DecisionChip,
  EmptyState,
  FlagIcon,
  GateStatusChip,
  PageHeader,
  Section,
  fmtScore,
} from "@/components/ui";

const MAX_SELECTED = 3;

function ideaName(idea: Idea): string {
  return idea.name || "(untitled)";
}

/**
 * Value to highlight as "best" in a row of cells, or null when no cell should
 * be highlighted. `requireDiffering` (per-criterion rows): needs at least two
 * scores that differ. Totals rows: highest non-null wins unless every column
 * shows the same value.
 */
function bestOf(
  values: Array<number | null>,
  requireDiffering: boolean,
): number | null {
  const nonNull = values.filter((v): v is number => v !== null);
  if (nonNull.length === 0) return null;
  const max = Math.max(...nonNull);
  const distinct = new Set(nonNull).size;
  if (requireDiffering) {
    return nonNull.length >= 2 && distinct >= 2 ? max : null;
  }
  return nonNull.length === values.length && distinct === 1 ? null : max;
}

function IdeaHeaderLink({ idea }: { idea: Idea }) {
  return (
    <Link
      href={`/idea/${idea.id}`}
      className="font-semibold text-zinc-900 hover:text-teal-700 hover:underline"
    >
      {ideaName(idea)}
    </Link>
  );
}

function DeltaCell({ a, b }: { a: number | null; b: number | null }) {
  if (a === null || b === null) return <span className="text-zinc-300">—</span>;
  const d = b - a;
  const cls = d > 0 ? "text-teal-700" : d < 0 ? "text-red-600" : "text-zinc-400";
  return (
    <span className={`tnum ${cls}`}>
      {d > 0 ? `+${d}` : String(d)}
    </span>
  );
}

const TH = "px-3 py-2 text-left text-xs font-medium text-zinc-500";
const TD = "px-3 py-2 align-middle";

export default function ComparePage() {
  const { state, hydrated } = useStore();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  if (!hydrated) return null;

  const { ideas } = state;
  const weights = state.settings.weights;

  // Preserve click order: first pick is A, second is B (drives the delta column).
  const selected = selectedIds
    .map((id) => ideas.find((i) => i.id === id))
    .filter((i): i is Idea => i !== undefined);
  const atLimit = selected.length >= MAX_SELECTED;
  const twoWay = selected.length === 2;

  function toggle(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : prev.length >= MAX_SELECTED
          ? prev
          : [...prev, id],
    );
  }

  const derived = selected.map((idea) => {
    const raw = rawScore(idea.scores, weights);
    return {
      idea,
      raw,
      adjusted: adjustedScore(raw, idea.confidence),
      decision: decision({
        name: idea.name,
        gates: idea.gates,
        scores: idea.scores,
        confidence: idea.confidence,
        weights,
      }),
      gateStatus: gateStatus(idea.gates),
      flags: new Set(killerFlags(idea.scores, weights)),
    };
  });

  const bestRaw = bestOf(derived.map((d) => d.raw), false);
  const bestAdjusted = bestOf(derived.map((d) => d.adjusted), false);
  const abLabels = ["A", "B", "C"];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Compare"
        description="Side-by-side totals, per-criterion scores, and gates for 2–3 ideas."
      />

      <Section
        title="Select ideas"
        description="Tap to toggle. Selection order sets column order."
        actions={
          <span
            className={`text-xs ${
              atLimit ? "font-medium text-amber-600" : "text-zinc-400"
            }`}
          >
            pick 2–3 · {selected.length} selected
          </span>
        }
      >
        {ideas.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No ideas yet. Add some on the{" "}
            <Link href="/" className="text-teal-700 hover:underline">
              Pipeline
            </Link>{" "}
            first.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {ideas.map((idea) => {
              const isSelected = selectedIds.includes(idea.id);
              const disabled = !isSelected && atLimit;
              return (
                <button
                  key={idea.id}
                  type="button"
                  onClick={() => toggle(idea.id)}
                  disabled={disabled}
                  aria-pressed={isSelected}
                  title={disabled ? "pick 2–3" : undefined}
                  className={`min-h-8 rounded-full border px-3 py-1 text-sm transition-colors ${
                    isSelected
                      ? "border-teal-600 bg-teal-50 font-medium text-teal-700"
                      : disabled
                        ? "cursor-not-allowed border-zinc-200 bg-white text-zinc-300"
                        : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
                  }`}
                >
                  {ideaName(idea)}
                </button>
              );
            })}
          </div>
        )}
      </Section>

      {selected.length < 2 ? (
        <EmptyState>
          Pick at least two ideas above to compare them side by side.
        </EmptyState>
      ) : (
        <>
          <Section title="Totals">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[26rem] border-collapse text-sm">
                <thead>
                  <tr>
                    <th className={`${TH} min-w-[8rem]`} scope="col" />
                    {derived.map((d) => (
                      <th
                        key={d.idea.id}
                        className={`${TH} min-w-[8rem]`}
                        scope="col"
                      >
                        <IdeaHeaderLink idea={d.idea} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-zinc-100">
                    <th className={`${TH} font-medium`} scope="row">
                      Raw score
                    </th>
                    {derived.map((d) => (
                      <td
                        key={d.idea.id}
                        className={`${TD} tnum ${
                          d.raw !== null && d.raw === bestRaw
                            ? "font-semibold text-teal-700"
                            : d.raw === null
                              ? "text-zinc-300"
                              : "text-zinc-700"
                        }`}
                      >
                        {fmtScore(d.raw)}
                      </td>
                    ))}
                  </tr>
                  <tr className="border-t border-zinc-100">
                    <th className={`${TH} font-medium`} scope="row">
                      Adjusted
                    </th>
                    {derived.map((d) => (
                      <td
                        key={d.idea.id}
                        className={`${TD} tnum ${
                          d.adjusted !== null && d.adjusted === bestAdjusted
                            ? "font-semibold text-teal-700"
                            : d.adjusted === null
                              ? "text-zinc-300"
                              : "text-zinc-700"
                        }`}
                      >
                        {fmtScore(d.adjusted)}
                      </td>
                    ))}
                  </tr>
                  <tr className="border-t border-zinc-100">
                    <th className={`${TH} font-medium`} scope="row">
                      Decision
                    </th>
                    {derived.map((d) => (
                      <td key={d.idea.id} className={TD}>
                        <DecisionChip decision={d.decision} />
                      </td>
                    ))}
                  </tr>
                  <tr className="border-t border-zinc-100">
                    <th className={`${TH} font-medium`} scope="row">
                      Gate status
                    </th>
                    {derived.map((d) => (
                      <td key={d.idea.id} className={TD}>
                        <GateStatusChip status={d.gateStatus} />
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </Section>

          <Section
            title="Per-criterion scores"
            description={
              twoWay
                ? "0–5 per criterion. Δ = B − A. Flag: " + KILLER_FLAG_COPY
                : "0–5 per criterion. Flag: " + KILLER_FLAG_COPY
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[30rem] border-collapse text-sm">
                <thead>
                  <tr>
                    <th className={`${TH} min-w-[12rem]`} scope="col">
                      Criterion
                    </th>
                    {derived.map((d, i) => (
                      <th
                        key={d.idea.id}
                        className={`${TH} min-w-[6rem]`}
                        scope="col"
                      >
                        {twoWay ? (
                          <span className="mr-1.5 font-normal text-zinc-400">
                            {abLabels[i]}
                          </span>
                        ) : null}
                        <IdeaHeaderLink idea={d.idea} />
                      </th>
                    ))}
                    {twoWay ? (
                      <th className={`${TH} min-w-[4rem]`} scope="col">
                        Δ B−A
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {CRITERIA.map((criterion) => {
                    const rowScores = derived.map(
                      (d) => d.idea.scores[criterion.id],
                    );
                    const best = bestOf(rowScores, true);
                    return (
                      <tr key={criterion.id} className="border-t border-zinc-100">
                        <th className={`${TH} font-medium`} scope="row">
                          {criterion.label}
                          <span className="ml-1.5 whitespace-nowrap font-normal text-zinc-400">
                            w <span className="tnum">{weights[criterion.id]}</span>
                          </span>
                        </th>
                        {derived.map((d, i) => {
                          const score = rowScores[i];
                          return (
                            <td key={d.idea.id} className={TD}>
                              <span
                                className={`tnum ${
                                  score !== null && score === best
                                    ? "font-semibold text-teal-700"
                                    : score === null
                                      ? "text-zinc-300"
                                      : "text-zinc-700"
                                }`}
                              >
                                {score === null ? "—" : score}
                              </span>
                              {d.flags.has(criterion.id) ? (
                                <span className="ml-1">
                                  <FlagIcon title={KILLER_FLAG_COPY} />
                                </span>
                              ) : null}
                            </td>
                          );
                        })}
                        {twoWay ? (
                          <td className={TD}>
                            <DeltaCell a={rowScores[0]} b={rowScores[1]} />
                          </td>
                        ) : null}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Gates">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[26rem] border-collapse text-sm">
                <thead>
                  <tr>
                    <th className={`${TH} min-w-[12rem]`} scope="col">
                      Gate
                    </th>
                    {derived.map((d) => (
                      <th
                        key={d.idea.id}
                        className={`${TH} min-w-[6rem]`}
                        scope="col"
                      >
                        <IdeaHeaderLink idea={d.idea} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {GATES.map((gate) => (
                    <tr key={gate.id} className="border-t border-zinc-100">
                      <th className={`${TH} font-medium`} scope="row">
                        {gate.label}
                      </th>
                      {derived.map((d) => {
                        const v = d.idea.gates[gate.id];
                        return (
                          <td key={d.idea.id} className={TD}>
                            {v === "Y" ? (
                              <span className="text-teal-700">Y</span>
                            ) : v === "N" ? (
                              <span className="font-semibold text-red-600">
                                N
                              </span>
                            ) : (
                              <span className="text-zinc-300">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
