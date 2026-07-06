"use client";

// Cash Cow Filter idea sections: gates, scoring, confidence, validation, and
// the computed panel. Visually distinct from the unicorn instrument (amber
// accent) and reads/writes idea.cashcow instead of the unicorn fields.
import { useMemo, useState } from "react";
import { CONFIDENCE_OPTIONS } from "@/lib/criteria";
import { CC_CRITERIA, CC_GATES } from "@/lib/cashcow/criteria";
import {
  ccAdjustedScore,
  ccDecision,
  ccGateStatus,
  ccKillerFlags,
  ccRawScore,
  ccTopRisks,
  emptyCashCowBlock,
} from "@/lib/cashcow/engine";
import type { CcDecision, CcGateStatus } from "@/lib/cashcow/engine";
import { FlagIcon, Section, fmtScore } from "@/components/ui";
import { ReframeButton } from "@/components/idea/ReframeButton";
import { isWeakVerdict } from "@/lib/engine";
import type {
  CashCowBlock,
  CcCriterionId,
  CcGateId,
  GateValue,
  Idea,
} from "@/lib/types";

const SCORE_VALUES = [0, 1, 2, 3, 4, 5];

export type CcPatch = (
  patch:
    | Partial<CashCowBlock>
    | ((latest: CashCowBlock) => Partial<CashCowBlock>),
) => void;

/** Build a cc-block patcher on top of the idea-level onPatch. */
export function makeCcPatch(
  onPatch: (patch: Partial<Idea> | ((latest: Idea) => Partial<Idea>)) => void,
): CcPatch {
  return (patch) =>
    onPatch((latest) => {
      const current = latest.cashcow ?? emptyCashCowBlock();
      const p = typeof patch === "function" ? patch(current) : patch;
      return { cashcow: { ...current, ...p } };
    });
}

export function ccBlockOf(idea: Idea): CashCowBlock {
  return idea.cashcow ?? emptyCashCowBlock();
}

function CcGateStatusChip({ status }: { status: CcGateStatus }) {
  const styles =
    status === "PASS"
      ? "border-amber-500 bg-amber-500 text-white"
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

export function CcDecisionChip({ decision }: { decision: CcDecision | null }) {
  if (decision === null) {
    return <span className="text-zinc-300">—</span>;
  }
  const styles: Record<CcDecision, string> = {
    "BUILD / HOLD / EXIT": "bg-amber-500 text-white",
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

export function CcGatesSection({
  idea,
  ccPatch,
}: {
  idea: Idea;
  ccPatch: CcPatch;
}) {
  const cc = ccBlockOf(idea);
  const status = ccGateStatus(cc.gates);

  function setGate(id: CcGateId, value: Exclude<GateValue, null>) {
    ccPatch((latest) => ({
      gates: {
        ...latest.gates,
        [id]: latest.gates[id] === value ? null : value,
      },
    }));
  }

  return (
    <Section
      title="Cash cow gates"
      description="Hard pass/fail — any N kills the idea regardless of scores. Gates come before scoring."
      actions={<CcGateStatusChip status={status} />}
    >
      <div className="divide-y divide-zinc-100">
        {CC_GATES.map((g) => {
          const value = cc.gates[g.id];
          const rationale = cc.ai?.gateRationales?.[g.id];
          const needsConfirm =
            cc.ai?.needsFounderConfirmation?.includes(g.id) ?? false;
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
                <p className="mt-0.5 text-xs text-zinc-500">
                  {g.whyItMatters}
                </p>
                <p className="mt-0.5 text-xs text-zinc-400">
                  Test: {g.practicalTest}
                </p>
                <p className="mt-0.5 text-xs text-red-400">
                  Kill signal: {g.killSignal}
                </p>
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
                      ? "bg-amber-500 text-white"
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

export function CcCriteriaSection({
  idea,
  ccPatch,
}: {
  idea: Idea;
  ccPatch: CcPatch;
}) {
  const cc = ccBlockOf(idea);
  const [activeId, setActiveId] = useState<CcCriterionId | null>(null);
  const flagged = useMemo(() => ccKillerFlags(cc.scores), [cc.scores]);

  function setScore(id: CcCriterionId, value: number | null) {
    ccPatch((latest) => ({ scores: { ...latest.scores, [id]: value } }));
  }

  return (
    <Section
      title="Cash cow scoring"
      description="0–5 per criterion; weights sum to 100 so each reads as a percentage. Anchors shown at 1 / 3 / 5."
    >
      <div className="divide-y divide-zinc-100">
        {CC_CRITERIA.map((c) => {
          const score = cc.scores[c.id];
          const rationale = cc.ai?.scoreRationales?.[c.id];
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
              className="-mx-1 rounded px-1 py-3 outline-none focus-visible:ring-1 focus-visible:ring-amber-500"
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
                          ? "bg-amber-500 text-white"
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
                    <span className="tnum font-medium text-zinc-600">1</span> —{" "}
                    {c.anchor1}
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
                    Low score on a heavyweight cash criterion — a kill signal
                    unless it can be fixed cheaply.
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

export function CcConfidenceSection({
  idea,
  ccPatch,
}: {
  idea: Idea;
  ccPatch: CcPatch;
}) {
  const cc = ccBlockOf(idea);
  return (
    <Section
      title="Evidence confidence"
      description="Raw × confidence is a sort key only — decisions use raw score and confidence separately."
    >
      <div className="grid gap-2 sm:grid-cols-3">
        {CONFIDENCE_OPTIONS.map((opt) => {
          const active = cc.confidence === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={active}
              onClick={() =>
                ccPatch({ confidence: active ? null : opt.value })
              }
              className={`min-h-8 rounded border px-3 py-2 text-left transition-colors ${
                active
                  ? "border-amber-500 bg-amber-500 text-white"
                  : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              <span className="tnum block text-sm font-semibold">
                {opt.label}
              </span>
              <span
                className={`block text-xs ${
                  active ? "text-amber-100" : "text-zinc-500"
                }`}
              >
                {opt.description}
              </span>
            </button>
          );
        })}
      </div>
      {cc.ai?.confidenceRationale ? (
        <p className="mt-2 text-xs italic text-zinc-600">
          AI: {cc.ai.confidenceRationale}
        </p>
      ) : null}
    </Section>
  );
}

export function CcValidationSection({
  idea,
  ccPatch,
}: {
  idea: Idea;
  ccPatch: CcPatch;
}) {
  const cc = ccBlockOf(idea);
  return (
    <Section title="30-day validation test">
      <textarea
        rows={4}
        className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
        value={cc.validationTest30d}
        onChange={(e) => ccPatch({ validationTest30d: e.target.value })}
        placeholder="The cheapest test that proves revenue and margin assumptions in 30 days — find buyers already spending money, with a numeric pass/fail bar."
      />
    </Section>
  );
}

export function CcComputedPanel({ idea }: { idea: Idea }) {
  const cc = ccBlockOf(idea);
  const raw = ccRawScore(cc.scores);
  const adjusted = ccAdjustedScore(raw, cc.confidence);
  const status = ccGateStatus(cc.gates);
  const decision = ccDecision({
    gates: cc.gates,
    scores: cc.scores,
    confidence: cc.confidence,
  });
  const risks = ccTopRisks(cc.scores);

  return (
    <Section
      title="Cash cow verdict"
      description="Can this produce $20M+ EBITDA/year with durable enterprise value?"
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-zinc-500">Decision</span>
          <CcDecisionChip decision={decision} />
        </div>

        {isWeakVerdict(decision) ? (
          <div>
            <ReframeButton />
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-zinc-500">Gates</span>
          <CcGateStatusChip status={status} />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-zinc-500">
            Raw score (business quality)
          </span>
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
          BUILD / HOLD / EXIT needs all gates Y, raw ≥ 80 and confidence ≥
          75%. Raw ≥ 70 → validate fast; 60–69 → park or narrow; below 60 (or
          any gate N) → kill or reframe.
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
        {cc.ai?.summary ? (
          <div className="border-t border-zinc-100 pt-3">
            <p className="mb-1 text-xs font-medium text-zinc-500">AI summary</p>
            <p className="text-xs text-zinc-700">{cc.ai.summary}</p>
          </div>
        ) : null}
      </div>
    </Section>
  );
}
