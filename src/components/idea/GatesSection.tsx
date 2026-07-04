"use client";

import { GATES } from "@/lib/criteria";
import { gateStatus } from "@/lib/engine";
import { GateStatusChip, Section } from "@/components/ui";
import type { GateId, GateValue, Idea } from "@/lib/types";

export function GatesSection({
  idea,
  onPatch,
}: {
  idea: Idea;
  onPatch: (patch: Partial<Idea>) => void;
}) {
  const status = gateStatus(idea.gates);

  function setGate(id: GateId, value: Exclude<GateValue, null>) {
    const next: GateValue = idea.gates[id] === value ? null : value;
    onPatch({ gates: { ...idea.gates, [id]: next } });
  }

  return (
    <Section
      title="Gates"
      description="Hard pass/fail — a single N kills the idea regardless of scores. Gates come before scoring."
      actions={<GateStatusChip status={status} />}
    >
      <div className="divide-y divide-zinc-100">
        {GATES.map((g) => {
          const value = idea.gates[g.id];
          const rationale = idea.ai?.gateRationales?.[g.id];
          const needsConfirm =
            idea.ai?.needsFounderConfirmation?.includes(g.id) ?? false;
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
                  Y — {g.yMeans}
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  N — {g.nMeans}
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
                      ? "bg-teal-600 text-white"
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
