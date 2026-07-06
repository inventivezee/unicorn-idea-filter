"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  DecisionChip,
  EmptyState,
  FlagIcon,
  GateStatusChip,
  Section,
  fmtScore,
} from "@/components/ui";
import { CC_CRITERIA } from "@/lib/cashcow/criteria";
import {
  ccDecision,
  ccGateStatus,
  ccKillerFlags,
  ccRawScore,
  type CcGates,
  type CcScores,
} from "@/lib/cashcow/engine";
import { CcDecisionChip } from "@/components/cashcow/CcSections";
import { ReframePanel } from "@/components/idea/ReframePanel";
import { ReframeButton } from "@/components/idea/ReframeButton";
import { CRITERIA, DEFAULT_WEIGHTS } from "@/lib/criteria";
import { emptyCashCowBlock } from "@/lib/cashcow/engine";
import { newIdea } from "@/lib/defaults";
import type { PublicIdeaRow } from "@/lib/db/types";
import {
  KILLER_FLAG_COPY,
  decision,
  isWeakVerdict,
  gateStatus,
  killerFlags,
  type Gates,
  type Scores,
} from "@/lib/engine";
import { useStore } from "@/lib/store";
import {
  CC_CRITERION_IDS,
  CC_GATE_IDS,
  CRITERION_IDS,
  GATE_IDS,
  type Confidence,
} from "@/lib/types";

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

function CcGateChip({ status }: { status: ReturnType<typeof ccGateStatus> }) {
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

/** Date only (no time) for scoring attribution, or null when unavailable. */
function fmtScoredDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
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

function ScoredBy({
  model,
  analyzedAt,
}: {
  model: string | null | undefined;
  analyzedAt: string | null | undefined;
}) {
  if (!model) return null;
  const when = fmtScoredDate(analyzedAt);
  return (
    <p className="mt-2 text-xs text-zinc-400">
      Scored by {model}
      {when ? <> · {when}</> : null}
    </p>
  );
}

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-zinc-500">{label}</div>
      <div className="mt-0.5 text-sm text-zinc-900">{value || "—"}</div>
    </div>
  );
}

/**
 * "Run this instrument's analysis" call-to-action, shown when a public idea
 * hasn't been scored in the active filter. Owners open their own idea and
 * analyze in place; anyone else forks a copy into their pipeline and analyzes
 * that — a stranger's published idea is never mutated. `label` names the
 * filter ("Cash Cow" / "Unicorn"); accent picks the button color.
 */
function RunAnalysisCTA({
  idea,
  ownsIdea,
  label,
  accent,
}: {
  idea: PublicIdeaRow;
  ownsIdea: boolean;
  label: string;
  accent: "teal" | "amber";
}) {
  const router = useRouter();
  const { addIdea } = useStore();
  const forkingRef = useRef(false);
  const btn =
    accent === "amber"
      ? "bg-amber-500 hover:bg-amber-600"
      : "bg-teal-600 hover:bg-teal-700";

  if (ownsIdea) {
    return (
      <div className="mt-3">
        <Link
          href={`/idea/${idea.id}?analyze=1`}
          className={`inline-block rounded px-3 py-1.5 text-sm font-medium text-white transition-colors ${btn}`}
        >
          Run the {label} analysis
        </Link>
        <span className="ml-2 text-xs text-zinc-400">
          It&apos;s your idea — this opens it with the analysis running.
        </span>
      </div>
    );
  }

  function fork() {
    if (forkingRef.current) return;
    forkingRef.current = true;
    // A copy in the viewer's own pipeline — scored with THEIR background,
    // leaving the original owner's published idea untouched.
    const created = addIdea({
      name: idea.name,
      domain: idea.domain,
      businessModel: idea.business_model,
      buyerICP: idea.buyer_icp,
      initialWedge: idea.initial_wedge,
      thesisNotes: idea.thesis_notes,
    });
    router.push(`/idea/${created.id}?analyze=1`);
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={fork}
        className={`inline-block rounded px-3 py-1.5 text-sm font-medium text-white transition-colors ${btn}`}
      >
        Analyze this idea in my pipeline
      </button>
      <span className="ml-2 text-xs text-zinc-400">
        Adds a copy to your pipeline and runs the {label} analysis against your
        own background.
      </span>
    </div>
  );
}

/**
 * Always-available fork: copies the idea's text and metadata into the
 * viewer's own pipeline (verdict NOT copied — the fork stays unpublished
 * until the forker scores it themselves, so the public feed never fills
 * with duplicates). Works signed-in or anonymous.
 */
function ForkButton({ idea }: { idea: PublicIdeaRow }) {
  const router = useRouter();
  const { addIdea } = useStore();
  const forkingRef = useRef(false);

  function fork() {
    if (forkingRef.current) return;
    forkingRef.current = true;
    const created = addIdea({
      name: idea.name,
      domain: idea.domain,
      businessModel: idea.business_model,
      buyerICP: idea.buyer_icp,
      initialWedge: idea.initial_wedge,
      thesisNotes: idea.thesis_notes,
    });
    router.push(`/idea/${created.id}`);
  }

  return (
    <Button variant="secondary" onClick={fork} title="Copy this idea into your own pipeline — edit it, analyze it with your background, and reframe it from there.">
      ⑂ Fork into my pipeline
    </Button>
  );
}

export default function PublicIdeaPage() {
  const { id } = useParams<{ id: string }>();
  const { hydrated, cloud, state } = useStore();
  const cashcowMode = state.settings.filterMode === "cashcow";
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

  const ccGates = toCcGates(idea.cc_gates);
  const ccScores = toCcScores(idea.cc_scores);
  const ccRaw =
    typeof idea.cc_raw_score === "number"
      ? idea.cc_raw_score
      : ccRawScore(ccScores);
  const ccDec = ccDecision({
    gates: ccGates,
    scores: ccScores,
    confidence: toConfidence(idea.cc_confidence ?? null),
  });
  const ccFlags = new Set(ccKillerFlags(ccScores));
  const hasCcData =
    Boolean(idea.cc_summary) ||
    CC_GATE_IDS.some((g) => ccGates[g] !== null) ||
    CC_CRITERION_IDS.some((c) => typeof ccScores[c] === "number");
  const hasUnicornData =
    Boolean(idea.ai_summary) ||
    GATE_IDS.some((g) => gates[g] !== null) ||
    CRITERION_IDS.some((c) => typeof scores[c] === "number");
  // The viewer's own ideas are in the store (cloud mode loads them) — owners
  // get a "run the analysis" shortcut instead of just a note.
  const ownsIdea = state.ideas.some((i) => i.id === idea.id);

  // A store-shaped copy of the PUBLIC verdict so the reframe tool can judge
  // it with the normal engines. Never persisted — reframes the viewer adds
  // become fresh ideas in their own pipeline.
  const reframeFilter: "unicorn" | "cashcow" =
    cashcowMode && hasCcData ? "cashcow" : "unicorn";
  const syntheticIdea = newIdea({
    id: `public-${idea.id}`,
    name: idea.name,
    domain: idea.domain,
    businessModel: idea.business_model,
    buyerICP: idea.buyer_icp,
    initialWedge: idea.initial_wedge,
    thesisNotes: idea.thesis_notes,
    gates,
    scores,
    confidence: toConfidence(idea.confidence),
    ...(hasCcData
      ? {
          cashcow: {
            ...emptyCashCowBlock(),
            gates: ccGates,
            scores: ccScores,
            confidence: toConfidence(idea.cc_confidence ?? null),
          },
        }
      : {}),
  });
  const publicSummary =
    (reframeFilter === "cashcow" ? idea.cc_summary : idea.ai_summary) ?? "";
  // Reframe is offered to everyone on a weak public verdict — including the
  // idea's own author. (It used to be gated on !ownsIdea, which hid the panel
  // the moment the owner was signed in, even though reframing just seeds NEW
  // ideas in the viewer's pipeline from the sanitized public verdict — no
  // ownership or publishing concern.) The panel itself still self-hides unless
  // the verdict is weak.
  const showReframe =
    reframeFilter === "cashcow" ? hasCcData : hasUnicornData;
  // Reframe entry points shown beside the verdict/summary when it's weak.
  const reframeWeak =
    showReframe && isWeakVerdict(reframeFilter === "cashcow" ? ccDec : dec);
  // The owner reframes from their private editor (full data) — the button
  // navigates there and auto-starts; everyone else runs it inline here.
  const reframeHref = ownsIdea ? `/idea/${idea.id}?reframe=1` : undefined;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-zinc-900">
            {idea.name || "Untitled idea"}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            {idea.author_handle ?? "Anonymous founder"}
            {" · added "}
            <span className="tnum">{fmtDate(idea.created_at)}</span>
          </p>
        </div>
        {ownsIdea ? (
          <Link
            href={`/idea/${idea.id}`}
            className="text-sm font-medium text-teal-700 underline-offset-2 hover:underline"
          >
            Open in my pipeline →
          </Link>
        ) : (
          <ForkButton idea={idea} />
        )}
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

          {idea.founder_profile ? (
            <Section
              title="Founding team"
              description="Anonymised profile — the founder's identity and full background stay private."
            >
              <p className="whitespace-pre-wrap text-sm text-zinc-700">
                {idea.founder_profile}
              </p>
            </Section>
          ) : null}

          {cashcowMode ? (
            hasCcData ? (
              <>
                {idea.cc_summary ? (
                  <Section title="AI assessment — Cash Cow Filter">
                    <p className="whitespace-pre-wrap text-sm text-zinc-700">
                      {idea.cc_summary}
                    </p>
                    {reframeWeak ? (
                      <div className="mt-3">
                        <ReframeButton href={reframeHref} />
                      </div>
                    ) : null}
                    <ScoredBy
                      model={idea.cc_model}
                      analyzedAt={idea.cc_analyzed_at}
                    />
                  </Section>
                ) : null}
                <Section
                  title="Cash cow scores"
                  description="0–5 per criterion; weights sum to 100 so each reads as a percentage."
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
                        {CC_CRITERIA.map((c) => (
                          <tr key={c.id} className="border-t border-zinc-100">
                            <td className="px-2 py-2 text-zinc-700">
                              {c.label}
                            </td>
                            <td className="tnum px-2 py-2 text-right font-medium text-zinc-900">
                              {ccScores[c.id] === null ? "—" : ccScores[c.id]}
                            </td>
                            <td className="px-2 py-2 text-center">
                              {ccFlags.has(c.id) ? (
                                <FlagIcon
                                  title={`${c.label}: low score on a heavyweight cash criterion`}
                                />
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Section>
              </>
            ) : (
              <Section title="Cash Cow Filter">
                <p className="text-sm text-zinc-600">
                  This idea hasn&apos;t been scored with the Cash Cow Filter
                  yet
                  {hasUnicornData
                    ? " — switch to the Unicorn Idea Filter (top-left) to see its venture verdict."
                    : "."}
                </p>
                <RunAnalysisCTA
                  idea={idea}
                  ownsIdea={ownsIdea}
                  label="Cash Cow"
                  accent="amber"
                />
              </Section>
            )
          ) : (
            !hasUnicornData ? (
              <Section title="Unicorn Idea Filter">
                <p className="text-sm text-zinc-600">
                  This idea hasn&apos;t been scored with the Unicorn Idea
                  Filter yet
                  {hasCcData
                    ? " — switch to the Cash Cow Filter (top-left) to see its EBITDA verdict."
                    : "."}
                </p>
                <RunAnalysisCTA
                  idea={idea}
                  ownsIdea={ownsIdea}
                  label="Unicorn"
                  accent="teal"
                />
              </Section>
            ) : (
            <>
              {idea.ai_summary ? (
                <Section title="AI assessment">
                  <p className="whitespace-pre-wrap text-sm text-zinc-700">
                    {idea.ai_summary}
                  </p>
                  {reframeWeak ? (
                    <div className="mt-3">
                      <ReframeButton href={reframeHref} />
                    </div>
                  ) : null}
                  <ScoredBy
                    model={idea.ai_model}
                    analyzedAt={idea.ai_analyzed_at}
                  />
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
                              <FlagIcon
                                title={`${c.label}: ${KILLER_FLAG_COPY}`}
                              />
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            </>
            )
          )}
        </div>

        <div>
          {cashcowMode ? (
            hasCcData ? (
              <Section title="Cash cow verdict">
                <dl className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-xs font-medium text-zinc-500">
                      Raw score
                    </dt>
                    <dd className="tnum text-sm font-semibold text-zinc-900">
                      {fmtScore(ccRaw)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-xs font-medium text-zinc-500">Gates</dt>
                    <dd>
                      <CcGateChip status={ccGateStatus(ccGates)} />
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-xs font-medium text-zinc-500">
                      Decision
                    </dt>
                    <dd>
                      <CcDecisionChip decision={ccDec} />
                    </dd>
                  </div>
                </dl>
                {reframeWeak ? (
                  <div className="mt-3">
                    <ReframeButton href={reframeHref} />
                  </div>
                ) : null}
                <ScoredBy
                  model={idea.cc_model}
                  analyzedAt={idea.cc_analyzed_at}
                />
              </Section>
            ) : null
          ) : !hasUnicornData ? null : (
            <Section title="Computed">
              <dl className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-xs font-medium text-zinc-500">
                    Raw score
                  </dt>
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
              {reframeWeak ? (
                <div className="mt-3">
                  <ReframeButton href={reframeHref} />
                </div>
              ) : null}
              <ScoredBy
                model={idea.ai_model}
                analyzedAt={idea.ai_analyzed_at}
              />
            </Section>
          )}
        </div>
      </div>

      {showReframe && !ownsIdea ? (
        <div className="mt-4">
          <ReframePanel
            idea={syntheticIdea}
            settings={state.settings}
            filter={reframeFilter}
            fallbackSummary={publicSummary}
          />
        </div>
      ) : null}

      <p className="mt-6 text-center text-xs text-zinc-500">
        {cashcowMode
          ? "Viewed through the Cash Cow Filter — "
          : "Scored with the Unicorn Idea Filter — "}
        <Link href="/" className="font-medium text-teal-700 hover:underline">
          add your own idea
        </Link>
      </p>
    </div>
  );
}
