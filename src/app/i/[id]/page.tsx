"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Button,
  DecisionChip,
  EmptyState,
  FlagIcon,
  GateStatusChip,
  Section,
  fmtScore,
} from "@/components/ui";
import { CRITERIA, DEFAULT_WEIGHTS } from "@/lib/criteria";
import type { PublicIdeaRow } from "@/lib/db/types";
import {
  KILLER_FLAG_COPY,
  decision,
  gateStatus,
  killerFlags,
  type Gates,
  type Scores,
} from "@/lib/engine";
import { useStore } from "@/lib/store";
import { CRITERION_IDS, GATE_IDS, type Confidence } from "@/lib/types";

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

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-zinc-500">{label}</div>
      <div className="mt-0.5 text-sm text-zinc-900">{value || "—"}</div>
    </div>
  );
}

export default function PublicIdeaPage() {
  const { id } = useParams<{ id: string }>();
  const { hydrated, cloud } = useStore();
  const [idea, setIdea] = useState<PublicIdeaRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!cloud || !id) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setNotFound(false);
    (async () => {
      try {
        const res = await fetch(`/api/i/${encodeURIComponent(id)}`, {
          signal: controller.signal,
        });
        if (res.status === 404) {
          setNotFound(true);
          setLoading(false);
          return;
        }
        if (!res.ok) {
          let message = `Couldn't load this idea (${res.status}).`;
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
        const data = (await res.json()) as { idea: PublicIdeaRow };
        setIdea(data.idea);
        setLoading(false);
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Couldn't load this idea.");
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [cloud, id, reloadKey]);

  if (!hydrated) return null;

  if (!cloud) {
    return (
      <EmptyState>
        The public database isn&apos;t configured on this deployment.
      </EmptyState>
    );
  }

  if (notFound) {
    return (
      <EmptyState>
        This idea isn&apos;t public (or doesn&apos;t exist).
      </EmptyState>
    );
  }

  if (error) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <span>{error}</span>
        <Button variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
          Retry
        </Button>
      </div>
    );
  }

  if (loading || !idea) {
    return (
      <div className="space-y-4">
        <div className="h-6 w-1/3 animate-pulse rounded bg-zinc-100" />
        <div className="h-4 w-1/4 animate-pulse rounded bg-zinc-100" />
        <div className="h-40 animate-pulse rounded-lg bg-zinc-100" />
        <div className="h-64 animate-pulse rounded-lg bg-zinc-100" />
      </div>
    );
  }

  const gates = toGates(idea.gates);
  const scores = toScores(idea.scores);
  const dec = decision({
    name: idea.name,
    gates,
    scores,
    confidence: toConfidence(idea.confidence),
    weights: DEFAULT_WEIGHTS,
  });
  const flags = new Set(killerFlags(scores, DEFAULT_WEIGHTS));

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900">
          {idea.name || "Untitled idea"}
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          {idea.author_handle ?? "Anonymous founder"}
          {" · added "}
          <span className="tnum">{fmtDate(idea.created_at)}</span>
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-4">
          <Section title="Idea">
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <MetaCell label="Domain" value={idea.domain} />
              <MetaCell label="Business model" value={idea.business_model} />
              <MetaCell label="Buyer" value={idea.buyer_icp} />
              <MetaCell label="Wedge" value={idea.initial_wedge} />
            </div>
            {idea.thesis_notes ? (
              <p className="mt-4 whitespace-pre-wrap border-t border-zinc-100 pt-3 text-sm text-zinc-700">
                {idea.thesis_notes}
              </p>
            ) : null}
          </Section>

          {idea.ai_summary ? (
            <Section title="AI assessment">
              <p className="whitespace-pre-wrap text-sm text-zinc-700">
                {idea.ai_summary}
              </p>
            </Section>
          ) : null}

          <Section
            title="Scores"
            description="0–5 per criterion, scored against default weights."
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] border-collapse text-sm">
                <thead>
                  <tr className="text-xs text-zinc-500">
                    <th className="px-2 py-1.5 text-left font-medium">
                      Criterion
                    </th>
                    <th className="px-2 py-1.5 text-right font-medium">
                      Score
                    </th>
                    <th className="w-10 px-2 py-1.5" aria-label="Flags" />
                  </tr>
                </thead>
                <tbody>
                  {CRITERIA.map((c) => (
                    <tr key={c.id} className="border-t border-zinc-100">
                      <td className="px-2 py-2 text-zinc-700">{c.label}</td>
                      <td className="tnum px-2 py-2 text-right font-medium text-zinc-900">
                        {scores[c.id] === null ? "—" : scores[c.id]}
                      </td>
                      <td className="px-2 py-2 text-center">
                        {flags.has(c.id) ? (
                          <FlagIcon title={`${c.label}: ${KILLER_FLAG_COPY}`} />
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </div>

        <div>
          <Section title="Computed">
            <dl className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-xs font-medium text-zinc-500">Raw score</dt>
                <dd className="tnum text-sm font-semibold text-zinc-900">
                  {fmtScore(idea.raw_score)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-xs font-medium text-zinc-500">Gates</dt>
                <dd>
                  <GateStatusChip status={gateStatus(gates)} />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-xs font-medium text-zinc-500">Decision</dt>
                <dd>
                  <DecisionChip decision={dec} />
                </dd>
              </div>
            </dl>
          </Section>
        </div>
      </div>

      <p className="mt-6 text-center text-xs text-zinc-500">
        Scored with the Unicorn Idea Filter —{" "}
        <Link href="/" className="font-medium text-teal-700 hover:underline">
          add your own idea
        </Link>
      </p>
    </div>
  );
}
