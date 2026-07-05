"use client";

// Pipeline table for a founder's custom filter (violet identity). Same shape
// as the other instruments' tables, driven by the active spec.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  customAdjustedScore,
  customDecision,
  customGateStatus,
  customRawScore,
  emptyCustomBlock,
} from "@/lib/custom/engine";
import type { CustomDecision, CustomGateStatus } from "@/lib/custom/engine";
import { isMetadataKind, useStore } from "@/lib/store";
import type { CustomFilterSpec, Idea } from "@/lib/types";
import { fmtScore } from "@/components/ui";
import { CustomDecisionChip, CustomGateChip } from "./CustomSections";

interface Row {
  idea: Idea;
  gate: CustomGateStatus;
  answered: number;
  raw: number | null;
  adj: number | null;
  dec: CustomDecision;
}

type SortKey = "name" | "gate" | "raw" | "adjusted" | "decision" | "updated";
type SortDir = "asc" | "desc";

const GATE_ORDER: Record<CustomGateStatus, number> = {
  PASS: 0,
  PENDING: 1,
  FAIL: 2,
};
const DECISION_ORDER: Record<CustomDecision, number> = {
  "GO / BUILD": 0,
  "VALIDATE FAST": 1,
  "PARK / NARROW": 2,
  "KILL / REFRAME": 3,
  "PENDING GATES": 4,
  "PENDING SCORES": 5,
};
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: "asc",
  gate: "asc",
  raw: "desc",
  adjusted: "desc",
  decision: "asc",
  updated: "desc",
};

function sortValue(row: Row, key: SortKey): string | number | null {
  switch (key) {
    case "name":
      return row.idea.name.trim() ? row.idea.name.toLowerCase() : null;
    case "gate":
      return GATE_ORDER[row.gate];
    case "raw":
      return row.raw;
    case "adjusted":
      return row.adj;
    case "decision":
      return DECISION_ORDER[row.dec];
    case "updated":
      return row.idea.updatedAt;
  }
}

function HeaderCell({
  label,
  sortKey,
  sort,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === sortKey;
  return (
    <th className="px-3 py-0 text-left font-medium">
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`flex h-8 w-full items-center gap-1 text-xs font-medium transition-colors ${
          align === "right" ? "justify-end" : ""
        } ${active ? "text-zinc-900" : "text-zinc-500 hover:text-zinc-900"}`}
        aria-sort={
          active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined
        }
      >
        <span className="whitespace-nowrap">{label}</span>
        <span
          className="w-2 text-[10px] leading-none text-violet-600"
          aria-hidden
        >
          {active ? (sort.dir === "asc" ? "↑" : "↓") : ""}
        </span>
      </button>
    </th>
  );
}

export function CustomPipelineTable({ spec }: { spec: CustomFilterSpec }) {
  const router = useRouter();
  const { state, analyzing } = useStore();
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: "updated",
    dir: "desc",
  });

  const rows = useMemo<Row[]>(
    () =>
      state.ideas.map((idea) => {
        const block = idea.custom?.[spec.id] ?? emptyCustomBlock(spec);
        const raw = customRawScore(block.scores, block.snapshot);
        return {
          idea,
          gate: customGateStatus(block.gates, block.snapshot),
          answered: block.snapshot.gates.filter(
            (g) => block.gates[g.id] !== null && block.gates[g.id] !== undefined,
          ).length,
          raw,
          adj: customAdjustedScore(raw, block.confidence),
          dec: customDecision({
            gates: block.gates,
            scores: block.scores,
            confidence: block.confidence,
            snapshot: block.snapshot,
          }),
        };
      }),
    [state.ideas, spec],
  );

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      const base =
        typeof va === "string"
          ? va.localeCompare(vb as string)
          : (va as number) - (vb as number);
      return sort.dir === "asc" ? base : -base;
    });
    return copy;
  }, [rows, sort]);

  function handleSort(key: SortKey) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: DEFAULT_DIR[key] },
    );
  }

  return (
    <div className="rounded-lg border border-violet-200 bg-white">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-violet-100 bg-violet-50/40">
              <HeaderCell label="Name" sortKey="name" sort={sort} onSort={handleSort} />
              <HeaderCell label="Gates" sortKey="gate" sort={sort} onSort={handleSort} />
              <HeaderCell label="Raw" sortKey="raw" sort={sort} onSort={handleSort} align="right" />
              <HeaderCell label="Adjusted (sort)" sortKey="adjusted" sort={sort} onSort={handleSort} align="right" />
              <HeaderCell label="Decision" sortKey="decision" sort={sort} onSort={handleSort} />
              <HeaderCell label="Updated" sortKey="updated" sort={sort} onSort={handleSort} align="right" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr
                key={row.idea.id}
                onClick={() => router.push(`/idea/${row.idea.id}`)}
                className="cursor-pointer border-b border-zinc-100 last:border-b-0 hover:bg-violet-50/40"
              >
                <td className="px-3 py-2.5">
                  <span className="flex items-center gap-1.5">
                    {row.idea.name.trim() ? (
                      <span className="font-medium text-zinc-900">
                        {row.idea.name}
                      </span>
                    ) : (
                      <span className="italic text-zinc-400">(untitled)</span>
                    )}
                    {analyzing[row.idea.id] ? (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700"
                        title="An AI request is still running for this idea."
                      >
                        <span
                          aria-hidden
                          className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-violet-300 border-t-violet-600"
                        />
                        {isMetadataKind(analyzing[row.idea.id])
                          ? "Filling…"
                          : "Analyzing…"}
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2.5">
                  <CustomGateChip status={row.gate} />
                  {row.gate === "PENDING" ? (
                    <span className="tnum ml-1.5 text-[10px] text-zinc-400">
                      {row.answered}/{spec.gates.length} answered
                    </span>
                  ) : null}
                </td>
                <td className="tnum px-3 py-2.5 text-right text-zinc-700">
                  {fmtScore(row.raw)}
                </td>
                <td className="tnum px-3 py-2.5 text-right font-medium text-zinc-900">
                  {fmtScore(row.adj)}
                </td>
                <td className="px-3 py-2.5">
                  <CustomDecisionChip decision={row.dec} />
                </td>
                <td className="tnum px-3 py-2.5 text-right text-xs text-zinc-500">
                  {row.idea.updatedAt.slice(0, 10)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
