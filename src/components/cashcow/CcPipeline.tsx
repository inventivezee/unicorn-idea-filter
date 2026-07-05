"use client";

// Cash Cow Filter pipeline table — the mode-specific replacement for the
// unicorn table on the home page. Same ideas, different instrument: 11 gates,
// 18 criteria, EBITDA-bar decisions, amber identity.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ccAdjustedScore,
  ccDecision,
  ccGateStatus,
  ccKillerFlags,
  ccRawScore,
} from "@/lib/cashcow/engine";
import type { CcDecision, CcGateStatus } from "@/lib/cashcow/engine";
import { useStore } from "@/lib/store";
import { CC_GATE_IDS } from "@/lib/types";
import type { Idea } from "@/lib/types";
import { FlagIcon, fmtScore } from "@/components/ui";
import { CcDecisionChip, ccBlockOf } from "./CcSections";

interface CcRow {
  idea: Idea;
  gate: CcGateStatus;
  answered: number;
  raw: number | null;
  adj: number | null;
  dec: CcDecision;
  flagCount: number;
}

type SortKey = "name" | "gate" | "raw" | "adjusted" | "decision" | "updated";
type SortDir = "asc" | "desc";

const GATE_ORDER: Record<CcGateStatus, number> = {
  PASS: 0,
  PENDING: 1,
  FAIL: 2,
};

const DECISION_ORDER: Record<CcDecision, number> = {
  "BUILD / HOLD / EXIT": 0,
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

function sortValue(row: CcRow, key: SortKey): string | number | null {
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
          className="w-2 text-[10px] leading-none text-amber-600"
          aria-hidden
        >
          {active ? (sort.dir === "asc" ? "↑" : "↓") : ""}
        </span>
      </button>
    </th>
  );
}

function CcGateChip({ status }: { status: CcGateStatus }) {
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

export function CcPipelineTable() {
  const router = useRouter();
  const { state, analyzing } = useStore();
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: "updated",
    dir: "desc",
  });

  const rows = useMemo<CcRow[]>(
    () =>
      state.ideas.map((idea) => {
        const cc = ccBlockOf(idea);
        const raw = ccRawScore(cc.scores);
        return {
          idea,
          gate: ccGateStatus(cc.gates),
          answered: CC_GATE_IDS.filter((id) => cc.gates[id] !== null).length,
          raw,
          adj: ccAdjustedScore(raw, cc.confidence),
          dec: ccDecision({
            gates: cc.gates,
            scores: cc.scores,
            confidence: cc.confidence,
          }),
          flagCount: ccKillerFlags(cc.scores).length,
        };
      }),
    [state.ideas],
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
    <div className="rounded-lg border border-amber-200 bg-white">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-amber-100 bg-amber-50/40">
              <HeaderCell label="Name" sortKey="name" sort={sort} onSort={handleSort} />
              <HeaderCell label="Gates" sortKey="gate" sort={sort} onSort={handleSort} />
              <HeaderCell label="Raw" sortKey="raw" sort={sort} onSort={handleSort} align="right" />
              <th className="px-3 py-0 text-right">
                <span className="flex h-8 items-center justify-end text-xs font-medium text-zinc-500">
                  Conf.
                </span>
              </th>
              <HeaderCell label="Adjusted (sort)" sortKey="adjusted" sort={sort} onSort={handleSort} align="right" />
              <HeaderCell label="Decision" sortKey="decision" sort={sort} onSort={handleSort} />
              <th className="px-3 py-0 text-left">
                <span className="flex h-8 items-center text-xs font-medium text-zinc-500">
                  Flags
                </span>
              </th>
              <HeaderCell label="Updated" sortKey="updated" sort={sort} onSort={handleSort} align="right" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr
                key={row.idea.id}
                onClick={() => router.push(`/idea/${row.idea.id}`)}
                className="cursor-pointer border-b border-zinc-100 last:border-b-0 hover:bg-amber-50/40"
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
                    {row.idea.isExample ? (
                      <span className="shrink-0 rounded bg-zinc-100 px-1 text-[10px] text-zinc-500">
                        example
                      </span>
                    ) : null}
                    {analyzing[row.idea.id] ? (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                        title="An AI request is still running for this idea."
                      >
                        <span
                          aria-hidden
                          className="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-amber-300 border-t-amber-600"
                        />
                        {analyzing[row.idea.id].endsWith("metadata")
                          ? "Filling…"
                          : "Analyzing…"}
                      </span>
                    ) : null}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2.5">
                  <CcGateChip status={row.gate} />
                  {row.gate === "PENDING" ? (
                    <span className="tnum ml-1.5 text-[10px] text-zinc-400">
                      {row.answered}/{CC_GATE_IDS.length} answered
                    </span>
                  ) : null}
                </td>
                <td className="tnum px-3 py-2.5 text-right text-zinc-700">
                  {fmtScore(row.raw)}
                </td>
                <td className="tnum px-3 py-2.5 text-right text-zinc-700">
                  {ccBlockOf(row.idea).confidence === null ? (
                    <span className="text-zinc-300">—</span>
                  ) : (
                    `${(ccBlockOf(row.idea).confidence as number) * 100}%`
                  )}
                </td>
                <td className="tnum px-3 py-2.5 text-right font-medium text-zinc-900">
                  {fmtScore(row.adj)}
                </td>
                <td className="px-3 py-2.5">
                  <CcDecisionChip decision={row.dec} />
                </td>
                <td className="whitespace-nowrap px-3 py-2.5">
                  {row.flagCount === 0 ? (
                    <span className="text-zinc-300">—</span>
                  ) : (
                    Array.from({ length: row.flagCount }, (_, i) => (
                      <FlagIcon
                        key={i}
                        title="Low score on a heavyweight cash criterion"
                      />
                    ))
                  )}
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
