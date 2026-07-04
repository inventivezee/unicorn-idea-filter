"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CRITERIA_BY_ID } from "@/lib/criteria";
import {
  adjustedScore,
  decision,
  gateStatus,
  isFullyScored,
  killerFlags,
  rawScore,
  KILLER_FLAG_COPY,
  type GateStatus,
} from "@/lib/engine";
import { pipelineCSV } from "@/lib/persistence";
import { useStore } from "@/lib/store";
import { GATE_IDS } from "@/lib/types";
import type { CriterionId, Decision, Idea } from "@/lib/types";
import {
  Button,
  DecisionChip,
  EmptyState,
  FlagIcon,
  GateStatusChip,
  PageHeader,
  fmtScore,
} from "@/components/ui";

interface Row {
  idea: Idea;
  gate: GateStatus;
  answered: number;
  raw: number | null;
  adj: number | null;
  dec: Decision | null;
  flags: CriterionId[];
}

type SortKey =
  | "name"
  | "domain"
  | "gate"
  | "raw"
  | "confidence"
  | "adjusted"
  | "decision"
  | "updated";

type SortDir = "asc" | "desc";

const GATE_ORDER: Record<GateStatus, number> = {
  PASS: 0,
  PENDING: 1,
  FAIL: 2,
};

const DECISION_ORDER: Record<Decision, number> = {
  "BUILD / INCUBATE": 0,
  "VALIDATE FAST": 1,
  "PARK / NARROW": 2,
  "KILL / REFRAME": 3,
  KILL: 4,
  "PENDING GATES": 5,
  "PENDING SCORES": 6,
};

/** Direction used the first time a column is clicked. */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: "asc",
  domain: "asc",
  gate: "asc",
  raw: "desc",
  confidence: "desc",
  adjusted: "desc",
  decision: "asc",
  updated: "desc",
};

function sortValue(row: Row, key: SortKey): string | number | null {
  switch (key) {
    case "name":
      return row.idea.name.trim() ? row.idea.name.toLowerCase() : null;
    case "domain":
      return row.idea.domain.trim() ? row.idea.domain.toLowerCase() : null;
    case "gate":
      return GATE_ORDER[row.gate];
    case "raw":
      return row.raw;
    case "confidence":
      return row.idea.confidence;
    case "adjusted":
      return row.adj;
    case "decision":
      return row.dec === null ? null : DECISION_ORDER[row.dec];
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
        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
      >
        <span className="whitespace-nowrap">{label}</span>
        <span className="w-2 text-[10px] leading-none text-teal-600" aria-hidden>
          {active ? (sort.dir === "asc" ? "↑" : "↓") : ""}
        </span>
      </button>
    </th>
  );
}

export default function PipelinePage() {
  const router = useRouter();
  const { state, hydrated, addIdea } = useStore();
  const [draft, setDraft] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: "updated",
    dir: "desc",
  });

  const weights = state.settings.weights;

  const rows = useMemo<Row[]>(
    () =>
      state.ideas.map((idea) => {
        const raw = rawScore(idea.scores, weights);
        return {
          idea,
          gate: gateStatus(idea.gates),
          answered: GATE_IDS.filter((id) => idea.gates[id] !== null).length,
          raw,
          adj: adjustedScore(raw, idea.confidence),
          dec: decision({
            name: idea.name,
            gates: idea.gates,
            scores: idea.scores,
            confidence: idea.confidence,
            weights,
          }),
          flags: killerFlags(idea.scores, weights),
        };
      }),
    [state.ideas, weights],
  );

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      // Nulls always sink to the bottom, regardless of direction.
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

  if (!hydrated) return null;

  const fullyScored = state.ideas.filter((i) => isFullyScored(i.scores)).length;

  function handleSort(key: SortKey) {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: DEFAULT_DIR[key] },
    );
  }

  function handleNewIdea() {
    const idea = addIdea();
    router.push(`/idea/${idea.id}`);
  }

  function handleQuickAdd() {
    const text = draft.trim();
    if (!text) return;
    const idea = addIdea({ thesisNotes: text });
    router.push(`/idea/${idea.id}?analyze=1`);
  }

  function handleExportCSV() {
    const csv = pipelineCSV(state.ideas, state.settings);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "unicorn-pipeline.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const quickAdd = (
    <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-4">
      <label
        htmlFor="quick-add"
        className="text-sm font-semibold text-zinc-900"
      >
        New idea
      </label>
      <p className="mt-0.5 text-xs text-zinc-500">
        Just describe it — the AI names it, fills in the metadata, and scores
        it against the gates and criteria. Everything stays editable.
      </p>
      <textarea
        id="quick-add"
        rows={3}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleQuickAdd();
        }}
        placeholder="e.g. A marketplace that lets independent HVAC technicians source scarce repair parts same-day from local distributors…"
        className="mt-3 w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          onClick={handleQuickAdd}
          disabled={!draft.trim()}
        >
          Add &amp; analyze with AI
        </Button>
        <button
          type="button"
          onClick={handleNewIdea}
          className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline"
        >
          or add a blank idea to fill in manually
        </button>
      </div>
    </div>
  );

  const header = (
    <PageHeader
      title="Pipeline"
      description={
        state.ideas.length === 0
          ? "No ideas yet."
          : `${state.ideas.length} idea${state.ideas.length === 1 ? "" : "s"} · ${fullyScored} fully scored`
      }
      actions={
        <>
          {state.ideas.length > 0 ? (
            <Button variant="secondary" onClick={handleExportCSV}>
              Export CSV
            </Button>
          ) : null}
        </>
      }
    />
  );

  if (state.ideas.length === 0) {
    return (
      <div>
        {header}
        {quickAdd}
        <EmptyState>
          No ideas in the pipeline — describe one above to start filtering.
        </EmptyState>
      </div>
    );
  }

  return (
    <div>
      {header}
      {quickAdd}
      <div className="rounded-lg border border-zinc-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-zinc-200">
                <HeaderCell label="Name" sortKey="name" sort={sort} onSort={handleSort} />
                <HeaderCell label="Domain" sortKey="domain" sort={sort} onSort={handleSort} />
                <HeaderCell label="Gates" sortKey="gate" sort={sort} onSort={handleSort} />
                <HeaderCell label="Raw" sortKey="raw" sort={sort} onSort={handleSort} align="right" />
                <HeaderCell label="Conf." sortKey="confidence" sort={sort} onSort={handleSort} align="right" />
                <HeaderCell label="Adjusted" sortKey="adjusted" sort={sort} onSort={handleSort} align="right" />
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
                  className="cursor-pointer border-b border-zinc-100 last:border-b-0 hover:bg-zinc-50"
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
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-zinc-600">
                    {row.idea.domain.trim() ? (
                      row.idea.domain
                    ) : (
                      <span className="text-zinc-300">—</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <GateStatusChip status={row.gate} />
                    {row.gate === "PENDING" ? (
                      <span className="tnum ml-1.5 text-[10px] text-zinc-400">
                        {row.answered}/{GATE_IDS.length} answered
                      </span>
                    ) : null}
                  </td>
                  <td className="tnum px-3 py-2.5 text-right text-zinc-700">
                    {fmtScore(row.raw)}
                  </td>
                  <td className="tnum px-3 py-2.5 text-right text-zinc-700">
                    {row.idea.confidence === null ? (
                      <span className="text-zinc-300">—</span>
                    ) : (
                      `${row.idea.confidence * 100}%`
                    )}
                  </td>
                  <td className="tnum px-3 py-2.5 text-right font-medium text-zinc-900">
                    {fmtScore(row.adj)}
                  </td>
                  <td className="px-3 py-2.5">
                    <DecisionChip decision={row.dec} />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    {row.flags.length === 0 ? (
                      <span className="text-zinc-300">—</span>
                    ) : (
                      row.flags.map((id) => (
                        <FlagIcon
                          key={id}
                          title={`${CRITERIA_BY_ID[id].label}: ${KILLER_FLAG_COPY}`}
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
    </div>
  );
}
