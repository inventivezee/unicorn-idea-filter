"use client";

// Custom-filter idea sections: gates, scoring, confidence, validation, and
// the verdict panel — all driven by the founder's stored spec (violet
// identity). Reads/writes idea.custom[spec.id].
import { useMemo, useState } from "react";
import { CONFIDENCE_OPTIONS } from "@/lib/criteria";
import {
  customAdjustedScore,
  customDecision,
  customGateStatus,
  customKillerFlags,
  customRawScore,
  customTopRisks,
  emptyCustomBlock,
} from "@/lib/custom/engine";
import type { CustomDecision, CustomGateStatus } from "@/lib/custom/engine";
import { FlagIcon, Section, fmtScore } from "@/components/ui";
import type {
  CustomBlock,
  CustomFilterSpec,
  GateValue,
  Idea,
} from "@/lib/types";

const SCORE_VALUES = [0, 1, 2, 3, 4, 5];

export type CustomPatch = (
  patch:
    | Partial<CustomBlock>
    | ((latest: CustomBlock) => Partial<CustomBlock>),
) => void;

/** Build a block patcher for one filter id on top of the idea-level onPatch.
 *  Version rule: gate/score ids only mean anything within one spec version,
 *  so an edit against a block scored under a DIFFERENT version starts from a
 *  fresh block on the current version (same wholesale-replace semantics as a
 *  re-analysis) — never merged positionally into stale ids. */
export function makeCustomPatch(
  onPatch: (patch: Partial<Idea> | ((latest: Idea) => Partial<Idea>)) => void,
  spec: CustomFilterSpec,
): CustomPatch {
  return (patch) =>
    onPatch((latest) => {
      const stored = latest.custom?.[spec.id];
      const current =
        stored && stored.snapshot.version === spec.version
          ? stored
          : emptyCustomBlock(spec);
      const p = typeof patch === "function" ? patch(current) : patch;
      return {
        custom: { ...(latest.custom ?? {}), [spec.id]: { ...current, ...p } },
      };
    });
}

/** The stored block as-is (stale snapshots included) — for the verdict panel. */
export function customBlockOf(idea: Idea, spec: CustomFilterSpec): CustomBlock {
  return idea.custom?.[spec.id] ?? emptyCustomBlock(spec);
}

/** The block the editing sections work against: only a same-version block is
 *  editable in place; a stale one reads as empty (its verdict stays visible
 *  in the computed panel until an edit or re-analysis replaces it). */
export function editableBlockOf(
  idea: Idea,
  spec: CustomFilterSpec,
): CustomBlock {
  const stored = idea.custom?.[spec.id];
  return stored && stored.snapshot.version === spec.version
    ? stored
    : emptyCustomBlock(spec);
}

export function CustomGateChip({ status }: { status: CustomGateStatus }) {
  const styles =
    status === "PASS"
      ? "border-violet-500 bg-violet-500 text-white"
      : status === "FAIL"
        ? "border-red-600 bg-red-600 text-white"
        : "border-zinc-200 bg-zinc-100 text-zinc-500";
  return (
    <span
      className={`inline-block whitespace-nowrap rounded border px-2 py-0.5 text-xs font-medium ${styles}`}
    >
      {status}
    </span>
  );
}

export function CustomDecisionChip({
  decision,
}: {
  decision: CustomDecision | null;
}) {
  if (decision === null) return <span className="text-zinc-300">—</span>;
  const styles: Record<CustomDecision, string> = {
    "GO / BUILD": "bg-violet-600 text-white",
    "VALIDATE FAST": "bg-blue-600 text-white",
    "PARK / NARROW": "bg-zinc-200 text-zinc-700",
    "KILL / REFRAME": "bg-red-600 text-white",
    "PENDING GATES": "bg-zinc-100 text-zinc-400",
    "PENDING SCORES": "bg-zinc-100 text-zinc-400",
  };
  return (
    <span
      className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-semibold ${styles[decision]}`}
    >
      {decision}
    </span>
  );
}

/** Shown when the block was scored under an older version of the filter. */
export function StaleSpecNote({
  idea,
  spec,
}: {
  idea: Idea;
  spec: CustomFilterSpec;
}) {
  const block = idea.custom?.[spec.id];
  if (!block || block.snapshot.version >= spec.version) return null;
  return (
    <p className="rounded border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-800">
      {`These answers were scored with v${block.snapshot.version} of this filter — you've since redesigned it (now v${spec.version}). Re-run the analysis to score against the current version.`}
    </p>
  );
}

export function CustomGatesSection({
  idea,
  spec,
  customPatch,
}: {
  idea: Idea;
  spec: CustomFilterSpec;
  customPatch: CustomPatch;
}) {
  const block = editableBlockOf(idea, spec);
  const status = customGateStatus(block.gates, block.snapshot);

  function setGate(id: string, value: Exclude<GateValue, null>) {
    customPatch((latest) => ({
      gates: {
        ...latest.gates,
        [id]: latest.gates[id] === value ? null : value,
      },
    }));
  }

  return (
    <Section
      title="Gates"
      description="Hard pass/fail against YOUR bar — any N kills the idea regardless of scores."
      actions={<CustomGateChip status={status} />}
    >
      <div className="divide-y divide-zinc-100">
        {spec.gates.map((g) => {
          const value = block.gates[g.id] ?? null;
          const rationale = block.ai?.gateRationales?.[g.id];
          const needsConfirm =
            block.ai?.needsFounderConfirmation?.includes(g.id) ?? false;
          return (
            <div key={g.id} className="flex items-start gap-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-zinc-800">
                    {g.label}
                  </span>
                  {needsConfirm ? (
                    <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                      confirm yourself
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-xs text-zinc-500">Y — {g.yMeans}</p>
                <p className="mt-0.5 text-xs text-zinc-500">N — {g.nMeans}</p>
                {rationale ? (
                  <p className="mt-1 text-xs italic text-zinc-600">
                    AI: {rationale}
                  </p>
                ) : null}
              </div>
              <div className="inline-flex shrink-0 divide-x divide-zinc-300 overflow-hidden rounded border border-zinc-300">
                <button
                  type="button"
                  onClick={() => setGate(g.id, "Y")}
                  aria-pressed={value === "Y"}
                  className={`h-8 w-10 text-xs font-semibold transition-colors ${
                    value === "Y"
                      ? "bg-violet-500 text-white"
                      : "bg-white text-zinc-600 hover:bg-zinc-50"
                  }`}
                >
                  Y
                </button>
                <button
                  type="button"
                  onClick={() => setGate(g.id, "N")}
                  aria-pressed={value === "N"}
                  className={`h-8 w-10 text-xs font-semibold transition-colors ${
                    value === "N"
                      ? "bg-red-600 text-white"
                      : "bg-white text-zinc-600 hover:bg-zinc-50"
                  }`}
                >
                  N
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

export function CustomCriteriaSection({
  idea,
  spec,
  customPatch,
}: {
  idea: Idea;
  spec: CustomFilterSpec;
  customPatch: CustomPatch;
}) {
  const block = editableBlockOf(idea, spec);
  const [activeId, setActiveId] = useState<string | null>(null);
  const flagged = useMemo(
    () => customKillerFlags(block.scores, block.snapshot),
    [block.scores, block.snapshot],
  );

  function setScore(id: string, value: number | null) {
    customPatch((latest) => ({ scores: { ...latest.scores, [id]: value } }));
  }

  return (
    <Section
      title="Scoring"
      description="0–5 per criterion; weights sum to 100 so each reads as a percentage of what matters to you."
    >
      <div className="divide-y divide-zinc-100">
        {spec.criteria.map((c) => {
          const score = block.scores[c.id] ?? null;
          const rationale = block.ai?.scoreRationales?.[c.id];
          return (
            <div
              key={c.id}
              tabIndex={0}
              onFocus={() => setActiveId(c.id)}
              onClick={() => setActiveId(c.id)}
              onKeyDown={(e) => {
                if (/^[0-5]$/.test(e.key)) {
                  e.preventDefault();
                  setScore(c.id, Number(e.key));
                } else if (e.key === "Backspace" || e.key === "Delete") {
                  e.preventDefault();
                  setScore(c.id, null);
                }
              }}
              className="-mx-1 rounded px-1 py-3 outline-none focus-visible:ring-1 focus-visible:ring-violet-500"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-zinc-800">
                    {c.label}
                  </span>
                  <span className="tnum rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                    w {c.weight}
                  </span>
                </div>
                <div className="inline-flex shrink-0 divide-x divide-zinc-300 overflow-hidden rounded border border-zinc-300">
                  {SCORE_VALUES.map((n) => (
                    <button
                      key={n}
                      type="button"
                      tabIndex={-1}
                      onClick={() => setScore(c.id, score === n ? null : n)}
                      aria-pressed={score === n}
                      className={`tnum h-8 w-8 text-xs font-medium transition-colors ${
                        score === n
                          ? "bg-violet-500 text-white"
                          : "bg-white text-zinc-600 hover:bg-zinc-50"
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              {activeId === c.id ? (
                <div className="mt-2 grid gap-1 rounded bg-zinc-50 p-2 text-xs text-zinc-500 sm:grid-cols-3">
                  <div>
                    <span className="tnum font-medium text-zinc-600">0</span> —{" "}
                    {c.anchor0}
                  </div>
                  <div>
                    <span className="tnum font-medium text-zinc-600">3</span> —{" "}
                    {c.anchor3}
                  </div>
                  <div>
                    <span className="tnum font-medium text-zinc-600">5</span> —{" "}
                    {c.anchor5}
                  </div>
                </div>
              ) : null}
              {flagged.includes(c.id) ? (
                <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-600">
                  <FlagIcon />
                  <span>
                    Low score on something you weighted heavily — a kill signal
                    for YOUR goals unless it can be fixed cheaply.
                  </span>
                </p>
              ) : null}
              {rationale ? (
                <p className="mt-1 text-xs italic text-zinc-600">
                  AI: {rationale}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-zinc-400">
        Tip: focus a row and press 0–5 to score it; Backspace clears.
      </p>
    </Section>
  );
}

export function CustomConfidenceSection({
  idea,
  spec,
  customPatch,
}: {
  idea: Idea;
  spec: CustomFilterSpec;
  customPatch: CustomPatch;
}) {
  const block = editableBlockOf(idea, spec);
  return (
    <Section
      title="Evidence confidence"
      description="Raw × confidence is a sort key only — decisions use raw score and confidence separately."
    >
      <div className="grid gap-2 sm:grid-cols-3">
        {CONFIDENCE_OPTIONS.map((opt) => {
          const active = block.confidence === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={active}
              onClick={() =>
                customPatch({ confidence: active ? null : opt.value })
              }
              className={`min-h-8 rounded border px-3 py-2 text-left transition-colors ${
                active
                  ? "border-violet-500 bg-violet-500 text-white"
                  : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              <span className="tnum block text-sm font-semibold">
                {opt.label}
              </span>
              <span
                className={`block text-xs ${
                  active ? "text-violet-100" : "text-zinc-500"
                }`}
              >
                {opt.description}
              </span>
            </button>
          );
        })}
      </div>
      {block.ai?.confidenceRationale ? (
        <p className="mt-2 text-xs italic text-zinc-600">
          AI: {block.ai.confidenceRationale}
        </p>
      ) : null}
    </Section>
  );
}

export function CustomValidationSection({
  idea,
  spec,
  customPatch,
}: {
  idea: Idea;
  spec: CustomFilterSpec;
  customPatch: CustomPatch;
}) {
  const block = editableBlockOf(idea, spec);
  return (
    <Section title="30-day validation test">
      <textarea
        rows={4}
        className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
        value={block.validationTest30d}
        onChange={(e) => customPatch({ validationTest30d: e.target.value })}
        placeholder="The cheapest test that attacks the biggest risk to YOUR goals in 30 days — with a numeric pass/fail bar."
      />
    </Section>
  );
}

export function CustomComputedPanel({
  idea,
  spec,
}: {
  idea: Idea;
  spec: CustomFilterSpec;
}) {
  const block = customBlockOf(idea, spec);
  const raw = customRawScore(block.scores, block.snapshot);
  const adjusted = customAdjustedScore(raw, block.confidence);
  const status = customGateStatus(block.gates, block.snapshot);
  const dec = customDecision({
    gates: block.gates,
    scores: block.scores,
    confidence: block.confidence,
    snapshot: block.snapshot,
  });
  const risks = customTopRisks(block.scores, block.snapshot);

  return (
    <Section title={spec.name} description={spec.question}>
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-zinc-500">Decision</span>
          <CustomDecisionChip decision={dec} />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-zinc-500">Gates</span>
          <CustomGateChip status={status} />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-zinc-500">Raw score</span>
          <span className="tnum text-sm font-semibold text-zinc-900">
            {fmtScore(raw)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-zinc-500">
            Adjusted (sort key only)
          </span>
          <span className="tnum text-sm text-zinc-700">
            {fmtScore(adjusted)}
          </span>
        </div>
        <div className="border-t border-zinc-100 pt-3 text-xs text-zinc-500">
          GO / BUILD needs all gates Y, raw ≥ 80 and confidence ≥ 75%. Raw ≥ 70
          → validate fast; 60–69 → park or narrow; below 60 (or any gate N) →
          kill or reframe.
        </div>
        {risks.length > 0 ? (
          <div className="border-t border-zinc-100 pt-3">
            <p className="mb-1.5 text-xs font-medium text-zinc-500">
              Top risks (biggest weighted gaps)
            </p>
            <ol className="space-y-1">
              {risks.map((r, i) => (
                <li key={r.id} className="flex items-baseline gap-2 text-xs">
                  <span className="tnum text-zinc-400">{i + 1}.</span>
                  <span className="text-zinc-700">{r.label}</span>
                  <span className="tnum ml-auto text-zinc-400">
                    gap {r.gap.toFixed(0)}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        {block.ai?.summary ? (
          <div className="border-t border-zinc-100 pt-3">
            <p className="mb-1 text-xs font-medium text-zinc-500">AI summary</p>
            <p className="text-xs text-zinc-700">{block.ai.summary}</p>
          </div>
        ) : null}
      </div>
    </Section>
  );
}
