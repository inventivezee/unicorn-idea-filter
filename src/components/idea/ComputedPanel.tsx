"use client";

import { useMemo } from "react";
import { CRITERIA_BY_ID } from "@/lib/criteria";
import {
  adjustedScore,
  decision,
  gateStatus,
  killerFlags,
  rawScore,
  topRisks,
  isWeakVerdict,
} from "@/lib/engine";
import {
  DecisionChip,
  FlagIcon,
  GateStatusChip,
  Section,
  fmtScore,
} from "@/components/ui";
import { ReframeButton } from "./ReframeButton";
import type { CriterionId, Idea } from "@/lib/types";

const inputCls =
  "h-8 w-full rounded border border-zinc-300 bg-white px-2 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500";

export function ComputedPanel({
  idea,
  weights,
  onPatch,
}: {
  idea: Idea;
  weights: Record<CriterionId, number>;
  onPatch: (patch: Partial<Idea>) => void;
}) {
  const computed = useMemo(() => {
    const raw = rawScore(idea.scores, weights);
    return {
      raw,
      adjusted: adjustedScore(raw, idea.confidence),
      status: gateStatus(idea.gates),
      dec: decision({
        name: idea.name,
        gates: idea.gates,
        scores: idea.scores,
        confidence: idea.confidence,
        weights,
      }),
      risks: topRisks(idea.scores, weights),
      flags: killerFlags(idea.scores, weights),
    };
  }, [idea, weights]);

  const override1 = idea.topRiskOverride1?.trim() ? idea.topRiskOverride1 : null;
  const override2 = idea.topRiskOverride2?.trim() ? idea.topRiskOverride2 : null;
  const computedLabels = computed.risks
    ? ([
        CRITERIA_BY_ID[computed.risks[0].id].label,
        CRITERIA_BY_ID[computed.risks[1].id].label,
      ] as const)
    : null;
  const line1 = override1 ?? computedLabels?.[0] ?? null;
  const line2 = override2 ?? computedLabels?.[1] ?? null;

  return (
    <Section title="Computed" description="Recomputes live as you edit.">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-zinc-500">Raw score</div>
          <div className="tnum text-3xl font-semibold tracking-tight text-zinc-900">
            {fmtScore(computed.raw)}
          </div>
        </div>
        <div>
          <div className="text-xs text-zinc-500">
            Adjusted{" "}
            <span className="text-[10px] text-zinc-400">raw × confidence</span>
          </div>
          <div className="tnum text-3xl font-semibold tracking-tight text-zinc-900">
            {fmtScore(computed.adjusted)}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <DecisionChip decision={computed.dec} />
        <GateStatusChip status={computed.status} />
      </div>

      {isWeakVerdict(computed.dec) ? (
        <div className="mt-3">
          <ReframeButton />
        </div>
      ) : null}

      <div className="mt-4 border-t border-zinc-100 pt-3">
        <div className="text-xs font-medium text-zinc-500">Top risks</div>
        {line1 || line2 ? (
          <ol className="mt-1 space-y-0.5 text-sm text-zinc-800">
            {line1 ? (
              <li>
                1. {line1}
                {!override1 && computed.risks ? (
                  <span className="tnum ml-1 text-xs text-zinc-400">
                    −{Math.round(computed.risks[0].pointsLost)} pts
                  </span>
                ) : null}
              </li>
            ) : null}
            {line2 ? (
              <li>
                2. {line2}
                {!override2 && computed.risks ? (
                  <span className="tnum ml-1 text-xs text-zinc-400">
                    −{Math.round(computed.risks[1].pointsLost)} pts
                  </span>
                ) : null}
              </li>
            ) : null}
          </ol>
        ) : (
          <p className="mt-1 text-xs text-zinc-400">
            Score all 15 criteria to compute.
          </p>
        )}
        {(override1 || override2) && computedLabels ? (
          <p className="mt-1 text-xs text-zinc-400">
            (model: {computedLabels[0]}, {computedLabels[1]})
          </p>
        ) : null}
        <div className="mt-2 space-y-1.5">
          <input
            className={inputCls}
            placeholder="Override risk 1"
            value={idea.topRiskOverride1 ?? ""}
            onChange={(e) =>
              onPatch({
                topRiskOverride1:
                  e.target.value === "" ? undefined : e.target.value,
              })
            }
          />
          <input
            className={inputCls}
            placeholder="Override risk 2"
            value={idea.topRiskOverride2 ?? ""}
            onChange={(e) =>
              onPatch({
                topRiskOverride2:
                  e.target.value === "" ? undefined : e.target.value,
              })
            }
          />
        </div>
      </div>

      <div className="mt-4 border-t border-zinc-100 pt-3">
        <div className="text-xs font-medium text-zinc-500">Killer flaws</div>
        {computed.flags.length === 0 ? (
          <p className="mt-1 text-sm text-zinc-400">None</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {computed.flags.map((id) => (
              <li
                key={id}
                className="flex items-start gap-1.5 text-xs text-amber-700"
              >
                <FlagIcon />
                <span>{CRITERIA_BY_ID[id].label}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
