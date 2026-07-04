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
import type { PublicIdeaRow } from "@/lib/db/types";
import { decision, gateStatus, type Gates, type Scores } from "@/lib/engine";
import { useStore } from "@/lib/store";
import { CRITERION_IDS, GATE_IDS, type Confidence } from "@/lib/types";

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

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <tr key={i} className="border-t border-zinc-100">
          {Array.from({ length: 8 }).map((_, j) => (
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
  const { hydrated, cloud } = useStore();
  const [sort, setSort] = useState<FeedSort>("new");
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
        const res = await fetch(`/api/feed?page=${page}&sort=${sort}`, {
          signal: controller.signal,
        });
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
        setIdeas((prev) => (page === 0 ? data.ideas : [...prev, ...data.ideas]));
        setTotal(data.total);
        setLoading(false);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Couldn't load the feed.");
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [cloud, sort, page, reloadKey]);

  if (!hydrated) return null;

  const header = (
    <PageHeader
      title="Explore"
      description="Every scored idea in the public database — what founders are testing right now."
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
          No public ideas yet — score one and it will show up here.
        </EmptyState>
      ) : (
        <div className="rounded-lg border border-zinc-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] border-collapse text-sm">
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
                          {fmtScore(row.raw_score)}
                        </td>
                        <td className="px-3 py-2.5">
                          <GateStatusChip status={gateStatus(gates)} />
                        </td>
                        <td className="px-3 py-2.5">
                          <DecisionChip decision={dec} />
                        </td>
                        <td className="max-w-[160px] truncate px-3 py-2.5 text-zinc-600">
                          {row.author_handle ?? "Anonymous founder"}
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
