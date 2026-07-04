"use client";

import { useMemo, useState } from "react";
import { CRITERIA } from "@/lib/criteria";
import { KILLER_FLAG_COPY, killerFlags } from "@/lib/engine";
import { FlagIcon, Section } from "@/components/ui";
import type { CriterionId, Idea } from "@/lib/types";

const SCORE_VALUES = [0, 1, 2, 3, 4, 5];

export function CriteriaSection({
  idea,
  weights,
  onPatch,
}: {
  idea: Idea;
  weights: Record<CriterionId, number>;
  onPatch: (patch: Partial<Idea>) => void;
}) {
  const [activeId, setActiveId] = useState<CriterionId | null>(null);
  const flagged = useMemo(
    () => killerFlags(idea.scores, weights),
    [idea.scores, weights],
  );

  function setScore(id: CriterionId, value: number | null) {
    onPatch({ scores: { ...idea.scores, [id]: value } });
  }

  return (
    <Section
      title="Scoring"
      description="0–5 per criterion; 1, 2 and 4 interpolate between the anchors."
    >
      <div className="divide-y divide-zinc-100">
        {CRITERIA.map((c) => {
          const score = idea.scores[c.id];
          const rationale = idea.ai?.scoreRationales?.[c.id];
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
              className="-mx-1 rounded px-1 py-3 outline-none focus-visible:ring-1 focus-visible:ring-teal-500"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-zinc-800">
                    {c.label}
                  </span>
                  <span className="tnum rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                    w {weights[c.id]}
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
                          ? "bg-teal-600 text-white"
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
                  <span>{KILLER_FLAG_COPY}</span>
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
