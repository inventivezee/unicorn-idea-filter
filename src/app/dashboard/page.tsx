"use client";

import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import {
  DecisionChip,
  EmptyState,
  FlagIcon,
  PageHeader,
  Section,
  fmtScore,
} from "@/components/ui";
import { CRITERIA_BY_ID } from "@/lib/criteria";
import {
  KILLER_FLAG_COPY,
  decision,
  isFullyScored,
  killerFlags,
  rawScore,
  stressTest,
} from "@/lib/engine";
import { useStore } from "@/lib/store";
import type { CriterionId, Decision } from "@/lib/types";

/** Canonical display order for decision states (best → worst → pending). */
const DECISION_ORDER: Decision[] = [
  "BUILD / INCUBATE",
  "VALIDATE FAST",
  "PARK / NARROW",
  "KILL / REFRAME",
  "KILL",
  "PENDING GATES",
  "PENDING SCORES",
];

/** Distribution-bar segment colors, matched to DecisionChip semantics. */
const BAR_COLORS: Record<Decision, string> = {
  "BUILD / INCUBATE": "bg-teal-600",
  "VALIDATE FAST": "bg-blue-600",
  "PARK / NARROW": "bg-zinc-400",
  "KILL / REFRAME": "bg-red-300",
  KILL: "bg-red-600",
  "PENDING GATES": "bg-zinc-200",
  "PENDING SCORES": "bg-zinc-300",
};

function StatCard({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-8 flex-col justify-between gap-1 rounded-lg border border-zinc-200 bg-white px-4 py-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div>{children}</div>
    </div>
  );
}

interface KillerRow {
  ideaId: string;
  ideaName: string;
  criterionId: CriterionId;
  score: number;
  weight: number;
}

export default function DashboardPage() {
  const { state, hydrated } = useStore();
  const { ideas, settings } = state;
  const weights = settings.weights;
  const trials = settings.trials;

  const computed = useMemo(() => {
    // Decision counts across all ideas (unnamed ideas yield null → skipped).
    const counts = new Map<Decision, number>();
    for (const idea of ideas) {
      const d = decision({
        name: idea.name,
        gates: idea.gates,
        scores: idea.scores,
        confidence: idea.confidence,
        weights,
      });
      if (d !== null) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    const decisionCounts = DECISION_ORDER.filter((d) => (counts.get(d) ?? 0) > 0).map(
      (d) => ({ decision: d, count: counts.get(d) as number }),
    );
    const decidedTotal = decisionCounts.reduce((acc, e) => acc + e.count, 0);

    // Raw-score stats over named, fully-scored ideas (matches stressTest's pool).
    const scored = ideas
      .filter((i) => i.name && isFullyScored(i.scores))
      .map((i) => ({ idea: i, raw: rawScore(i.scores, weights) as number }));
    const avgRaw =
      scored.length > 0
        ? scored.reduce((acc, e) => acc + e.raw, 0) / scored.length
        : null;
    let leader: (typeof scored)[number] | null = null;
    for (const e of scored) {
      if (leader === null || e.raw > leader.raw) leader = e;
    }

    const stress = stressTest(
      ideas.map((i) => ({ id: i.id, name: i.name, scores: i.scores })),
      weights,
      trials,
    );

    // Killer risks: every (idea, criterion) pair flagged across the pipeline.
    const killerRows: KillerRow[] = [];
    for (const idea of ideas) {
      for (const cid of killerFlags(idea.scores, weights)) {
        killerRows.push({
          ideaId: idea.id,
          ideaName: idea.name || "(unnamed idea)",
          criterionId: cid,
          score: idea.scores[cid] as number,
          weight: weights[cid] ?? 0,
        });
      }
    }

    return { decisionCounts, decidedTotal, scored, avgRaw, leader, stress, killerRows };
  }, [ideas, weights, trials]);

  if (!hydrated) return null;

  const { decisionCounts, decidedTotal, scored, avgRaw, leader, stress, killerRows } =
    computed;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Pipeline health at a glance — decisions, scores, leader robustness, and killer risks."
      />

      <div className="space-y-6">
        {/* Decision counts */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          <StatCard label="Total ideas">
            <div className="tnum text-2xl font-semibold text-zinc-900">
              {ideas.length}
            </div>
          </StatCard>
          {decisionCounts.map((e) => (
            <StatCard key={e.decision} label={<DecisionChip decision={e.decision} />}>
              <div className="tnum text-2xl font-semibold text-zinc-900">
                {e.count}
              </div>
            </StatCard>
          ))}
        </div>

        {/* Decision distribution bar */}
        {decidedTotal > 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
            <div className="text-xs text-zinc-500">Decision distribution</div>
            <div className="mt-2 flex h-3 w-full overflow-hidden rounded-full bg-zinc-100">
              {decisionCounts.map((e) => (
                <div
                  key={e.decision}
                  className={BAR_COLORS[e.decision]}
                  style={{ width: `${(e.count / decidedTotal) * 100}%` }}
                  title={`${e.decision}: ${e.count}`}
                />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {decisionCounts.map((e) => (
                <span
                  key={e.decision}
                  className="flex items-center gap-1.5 text-xs text-zinc-600"
                >
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${BAR_COLORS[e.decision]}`}
                  />
                  {e.decision}
                  <span className="tnum text-zinc-400">{e.count}</span>
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {/* Scores row */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatCard label="Average raw score">
            <div className="tnum text-2xl font-semibold text-zinc-900">
              {fmtScore(avgRaw)}
            </div>
            <div className="tnum mt-0.5 text-xs text-zinc-500">
              {scored.length} fully scored
            </div>
          </StatCard>
          <StatCard label="Top raw score">
            <div className="tnum text-2xl font-semibold text-zinc-900">
              {fmtScore(leader ? leader.raw : null)}
            </div>
          </StatCard>
          <StatCard label="Top idea">
            {leader ? (
              <Link
                href={`/idea/${leader.idea.id}`}
                className="block truncate text-sm font-medium text-teal-700 hover:underline"
              >
                {leader.idea.name}
              </Link>
            ) : (
              <span className="text-sm text-zinc-300">—</span>
            )}
          </StatCard>
        </div>

        {/* Leader robustness */}
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
          <div className="text-xs text-zinc-500">Weight sensitivity</div>
          {stress ? (
            <div className="mt-1">
              <div className="text-sm font-semibold text-zinc-900">
                Leader robustness:{" "}
                <span className="tnum">{Math.round(stress.robustnessPct)}%</span>{" "}
                <span className="font-normal text-zinc-500">
                  (weights ±20%, <span className="tnum">{trials}</span> trials)
                </span>
              </div>
              <div className="mt-1 text-sm text-zinc-700">{stress.leaderName}</div>
              <p className="mt-1 text-xs text-zinc-500">
                Share of seeded perturbation trials where {stress.leaderName} stays
                #1; ties count as holds.
              </p>
            </div>
          ) : (
            <div className="mt-1 text-sm text-zinc-500">
              No fully-scored ideas yet.
            </div>
          )}
        </div>

        {/* Killer risks */}
        <Section title="Killer risks" description={KILLER_FLAG_COPY}>
          {killerRows.length === 0 ? (
            <EmptyState>No killer flaws flagged.</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-sm">
                <thead>
                  <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500">
                    <th className="w-8 py-2 pr-2 font-medium" aria-label="Flag" />
                    <th className="py-2 pr-4 font-medium">Idea</th>
                    <th className="py-2 pr-4 font-medium">Criterion</th>
                    <th className="py-2 pr-4 text-right font-medium">Score</th>
                    <th className="py-2 text-right font-medium">Weight</th>
                  </tr>
                </thead>
                <tbody>
                  {killerRows.map((row) => (
                    <tr
                      key={`${row.ideaId}:${row.criterionId}`}
                      className="h-8 border-b border-zinc-100 last:border-b-0"
                    >
                      <td className="py-2 pr-2">
                        <FlagIcon title="Killer flaw" />
                      </td>
                      <td className="py-2 pr-4">
                        <Link
                          href={`/idea/${row.ideaId}`}
                          className="font-medium text-teal-700 hover:underline"
                        >
                          {row.ideaName}
                        </Link>
                      </td>
                      <td className="py-2 pr-4 text-zinc-700">
                        {CRITERIA_BY_ID[row.criterionId].label}
                      </td>
                      <td className="tnum py-2 pr-4 text-right text-zinc-900">
                        {row.score}
                      </td>
                      <td className="tnum py-2 text-right text-zinc-900">
                        {row.weight}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
