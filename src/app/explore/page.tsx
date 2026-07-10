"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Button,
  DecisionChip,
  EmptyState,
  GateStatusChip,
  PageHeader,
  fmtScore,
} from "@/components/ui";
import { DEFAULT_WEIGHTS } from "@/lib/criteria";
import {
  ccDecision,
  ccGateStatus,
  ccRawScore,
  type CcGates,
  type CcScores,
} from "@/lib/cashcow/engine";
import { CcDecisionChip } from "@/components/cashcow/CcSections";
import type { PublicIdeaRow } from "@/lib/db/types";
import { SECTORS } from "@/lib/sectors";
import { decision, gateStatus, type Gates, type Scores } from "@/lib/engine";
import { useStore } from "@/lib/store";
import {
  CC_CRITERION_IDS,
  CC_GATE_IDS,
  CRITERION_IDS,
  GATE_IDS,
  type Confidence,
} from "@/lib/types";

type FeedSort = "new" | "top";

interface FeedResponse {
  ideas: PublicIdeaRow[];
  page: number;
  pageSize: number;
  total: number;
}

/** Normalize the view's loosely-typed JSON columns into engine shapes. */
function toGates(raw: Record<string, unknown> | null | undefined): Gates {
  const gates = {} as Gates;
  for (const id of GATE_IDS) {
    const v = raw?.[id];
    gates[id] = v === "Y" || v === "N" ? v : null;
  }
  return gates;
}

function toScores(raw: Record<string, unknown> | null | undefined): Scores {
  const scores = {} as Scores;
  for (const id of CRITERION_IDS) {
    const v = raw?.[id];
    scores[id] =
      typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 5
        ? v
        : null;
  }
  return scores;
}

function toConfidence(v: number | null): Confidence {
  return v === 0.5 || v === 0.75 || v === 1.0 ? v : null;
}

function toCcGates(raw: Record<string, unknown> | null | undefined): CcGates {
  const gates = {} as CcGates;
  for (const id of CC_GATE_IDS) {
    const v = raw?.[id];
    gates[id] = v === "Y" || v === "N" ? v : null;
  }
  return gates;
}

function toCcScores(raw: Record<string, unknown> | null | undefined): CcScores {
  const scores = {} as CcScores;
  for (const id of CC_CRITERION_IDS) {
    const v = raw?.[id];
    scores[id] =
      typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 5
        ? v
        : null;
  }
  return scores;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

function CcGateChipInline({
  status,
}: {
  status: ReturnType<typeof ccGateStatus>;
}) {
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

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <tr key={i} className="border-t border-zinc-100">
          {Array.from({ length: 9 }).map((_, j) => (
            <td key={j} className="px-3 py-3">
              <div className="h-3.5 animate-pulse rounded bg-zinc-100" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export default function ExplorePage() {
  const { hydrated, cloud, state } = useStore();
  const cashcowMode = state.settings.filterMode === "cashcow";
  const [sort, setSort] = useState<FeedSort>("new");
  const [sector, setSector] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [ideas, setIdeas] = useState<PublicIdeaRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!cloud) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/feed?page=${page}&sort=${sort}&filter=${cashcowMode ? "cashcow" : "unicorn"}${sector ? `&sector=${sector}` : ""}`,
          { signal: controller.signal },
        );
        if (!res.ok) {
          let message = `Couldn't load the feed (${res.status}).`;
          try {
            const body = (await res.json()) as { error?: unknown };
            if (typeof body.error === "string" && body.error) {
              message = body.error;
            }
          } catch {
            // Non-JSON error body.
          }
          throw new Error(message);
        }
        const data = (await res.json()) as FeedResponse;
        setIdeas((prev) => {
          if (page === 0) return data.ideas;
          // Live feed: rows published between clicks shift offset ranges —
          // dedupe by id so React keys stay unique.
          const seen = new Set(prev.map((i) => i.id));
          return [...prev, ...data.ideas.filter((i) => !seen.has(i.id))];
        });
        setTotal(data.total);
        setLoading(false);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Couldn't load the feed.");
        setLoading(false);
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloud, sort, page, reloadKey, cashcowMode, sector]);

  // Mode changed → restart from page 0 so ranking matches the instrument.
  useEffect(() => {
    setPage(0);
    setIdeas([]);
    setTotal(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cashcowMode]);

  if (!hydrated) return null;

  const header = (
    <PageHeader
      title="Explore"
      description={
        cashcowMode
          ? "The public database through the Cash Cow lens — verdicts against the $20M EBITDA bar."
          : "Every scored idea in the public database — what founders are testing right now."
      }
    />
  );

  if (!cloud) {
    return (
      <div>
        {header}
        <EmptyState>
          The public database isn&apos;t configured on this deployment.
        </EmptyState>
      </div>
    );
  }

  function changeSort(next: FeedSort) {
    if (next === sort) return;
    setSort(next);
    setPage(0);
    setIdeas([]);
    setTotal(0);
  }

  function changeSector(next: string | null) {
    if (next === sector) return;
    setSector(next);
    setPage(0);
    setIdeas([]);
    setTotal(0);
  }

  const initialLoading = loading && ideas.length === 0;

  return (
    <div>
      {header}

      <div className="mb-3 flex items-center justify-between gap-3">
        <div
          className="inline-flex rounded border border-zinc-300 bg-white p-0.5"
          role="tablist"
          aria-label="Sort"
        >
          {(
            [
              { key: "new", label: "Newest" },
              { key: "top", label: "Top score" },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={sort === tab.key}
              onClick={() => changeSort(tab.key)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                sort === tab.key
                  ? "bg-teal-600 text-white"
                  : "text-zinc-500 hover:text-zinc-900"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {total > 0 ? (
          <p className="tnum text-xs text-zinc-500">
            {ideas.length} of {total} ideas
          </p>
        ) : null}
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5" aria-label="Sector filter">
        <button
          type="button"
          onClick={() => changeSector(null)}
          className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
            sector === null
              ? "border-teal-600 bg-teal-600 text-white"
              : "border-zinc-300 bg-white text-zinc-600 hover:border-zinc-400"
          }`}
        >
          All sectors
        </button>
        {SECTORS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => changeSector(s.key)}
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
              sector === s.key
                ? "border-teal-600 bg-teal-600 text-white"
                : "border-zinc-300 bg-white text-zinc-600 hover:border-zinc-400"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {error ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>{error}</span>
          <Button variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
            Retry
          </Button>
        </div>
      ) : null}

      {!initialLoading && !error && ideas.length === 0 ? (
        <EmptyState>
          {sector
            ? "No public ideas match this sector yet — try another, or clear the filter."
            : "No public ideas yet — score one and it will show up here."}
        </EmptyState>
      ) : (
        <div className="rounded-lg border border-zinc-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] border-collapse text-sm">
              <thead>
                <tr className="text-xs text-zinc-500">
                  <th className="px-3 py-2.5 text-left font-medium">Name</th>
                  <th className="px-3 py-2.5 text-left font-medium">Domain</th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    Business model
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    Raw score
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">Gates</th>
                  <th className="px-3 py-2.5 text-left font-medium">Decision</th>
                  <th className="px-3 py-2.5 text-left font-medium">Author</th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    Scored with
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">Added</th>
                </tr>
              </thead>
              <tbody>
                {initialLoading ? (
                  <SkeletonRows />
                ) : (
                  ideas.map((row) => {
                    const gates = toGates(row.gates);
                    const scores = toScores(row.scores);
                    const dec = decision({
                      name: row.name,
                      gates,
                      scores,
                      confidence: toConfidence(row.confidence),
                      weights: DEFAULT_WEIGHTS,
                    });
                    const ccGates = toCcGates(row.cc_gates);
                    const ccScores = toCcScores(row.cc_scores);
                    const ccRaw =
                      typeof row.cc_raw_score === "number"
                        ? row.cc_raw_score
                        : ccRawScore(ccScores);
                    const ccDec = ccDecision({
                      gates: ccGates,
                      scores: ccScores,
                      confidence: toConfidence(row.cc_confidence ?? null),
                    });
                    return (
                      <tr
                        key={row.id}
                        className="border-t border-zinc-100 hover:bg-zinc-50"
                      >
                        <td className="max-w-[240px] px-3 py-2.5">
                          <Link
                            href={`/i/${row.id}`}
                            className="block truncate font-medium text-zinc-900 hover:text-teal-700"
                          >
                            {row.name || "Untitled idea"}
                          </Link>
                        </td>
                        <td className="max-w-[160px] truncate px-3 py-2.5 text-zinc-600">
                          {row.domain || "—"}
                        </td>
                        <td className="max-w-[160px] truncate px-3 py-2.5 text-zinc-600">
                          {row.business_model || "—"}
                        </td>
                        <td className="tnum px-3 py-2.5 text-right font-medium text-zinc-900">
                          {fmtScore(cashcowMode ? ccRaw : row.raw_score)}
                        </td>
                        <td className="px-3 py-2.5">
                          {cashcowMode ? (
                            <CcGateChipInline status={ccGateStatus(ccGates)} />
                          ) : (
                            <GateStatusChip status={gateStatus(gates)} />
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          {cashcowMode ? (
                            <CcDecisionChip decision={ccDec} />
                          ) : (
                            <DecisionChip decision={dec} />
                          )}
                        </td>
                        <td className="max-w-[160px] truncate px-3 py-2.5 text-zinc-600">
                          {row.origin === "discovery" ? (
                            <span
                              className="mr-1.5 inline-block rounded border border-cyan-200 bg-cyan-50 px-1.5 py-0.5 text-[10px] font-medium text-cyan-700"
                              title="Originated by the autonomous discovery engine"
                            >
                              Discovered
                            </span>
                          ) : null}
                          {row.author_handle ?? "Anonymous founder"}
                        </td>
                        <td
                          className="max-w-[150px] truncate px-3 py-2.5 text-xs text-zinc-500"
                          title={(() => {
                            const at = cashcowMode
                              ? row.cc_analyzed_at
                              : row.ai_analyzed_at;
                            if (!at) return undefined;
                            const d = new Date(at);
                            return isNaN(d.getTime())
                              ? undefined
                              : `Scored ${fmtDate(at)}`;
                          })()}
                        >
                          {(cashcowMode ? row.cc_model : row.ai_model) || "—"}
                        </td>
                        <td className="tnum whitespace-nowrap px-3 py-2.5 text-right text-xs text-zinc-500">
                          {fmtDate(row.created_at)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!error && ideas.length > 0 && ideas.length < total ? (
        <div className="mt-4 flex justify-center">
          <Button
            variant="secondary"
            disabled={loading}
            onClick={() => setPage((p) => p + 1)}
          >
            {loading ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
