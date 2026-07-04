"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { GATES_BY_ID } from "@/lib/criteria";
import { CRITERION_IDS, GATE_IDS } from "@/lib/types";
import { Button, Section } from "@/components/ui";
import type {
  AnalyzeMetadataResponse,
  AnalyzeResponse,
  Confidence,
  CriterionId,
  GateId,
  GateValue,
  Idea,
  Settings,
} from "@/lib/types";

export function AIPanel({
  idea,
  settings,
  onPatch,
}: {
  idea: Idea;
  settings: Settings;
  onPatch: (patch: Partial<Idea>) => void;
}) {
  const [pending, setPending] = useState(false);
  const [pendingMode, setPendingMode] = useState<"full" | "metadata">("full");
  const [error, setError] = useState<string | null>(null);
  // The request may outlive this component (user navigates away mid-analysis).
  // The result is still applied through the store, which survives; only local
  // setState calls must stop after unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Latest idea values, so a result arriving minutes later can preserve any
  // manual edits the user made while the request was in flight.
  const ideaRef = useRef(idea);
  ideaRef.current = idea;

  const model = settings.models[settings.provider];
  const hasBackground = settings.founderBackground.trim().length > 0;
  const teamPayload = settings.coFounders
    .filter((c) => c.background.trim())
    .map((c) => ({ name: c.name, background: c.background }));

  // Quick-add flow: /idea/[id]?analyze=1 auto-runs the full analysis;
  // ?fill=1 ("Add only") just names and describes the idea, no scoring.
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (autoRanRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const wantsFull = params.get("analyze") === "1";
    const wantsFill = params.get("fill") === "1";
    if (!wantsFull && !wantsFill) return;
    autoRanRef.current = true;
    params.delete("analyze");
    params.delete("fill");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (query ? `?${query}` : ""),
    );
    if (wantsFull && !idea.ai) {
      if (settings.founderBackground.trim()) void analyze("full");
      else
        setError(
          "Analysis needs your founder background — add it in Settings, then press Analyze.",
        );
    } else if (wantsFill) void analyze("metadata");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const META_FIELDS = [
    "name",
    "domain",
    "businessModel",
    "buyerICP",
    "initialWedge",
  ] as const;

  async function analyze(mode: "full" | "metadata" = "full") {
    if (mode === "full" && !settings.founderBackground.trim()) {
      setError(
        "Analysis needs your founder background — add it in Settings first.",
      );
      return;
    }
    setError(null);
    setPending(true);
    setPendingMode(mode);
    // Snapshot at click time: fields the user later touches win over the AI.
    const snapshot = {
      gates: { ...idea.gates },
      scores: { ...idea.scores },
      confidence: idea.confidence,
      validationTest30d: idea.validationTest30d,
      thesisNotes: idea.thesisNotes,
      meta: Object.fromEntries(META_FIELDS.map((f) => [f, idea[f]])) as Record<
        (typeof META_FIELDS)[number],
        string
      >,
    };
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idea: {
            name: idea.name,
            domain: idea.domain,
            businessModel: idea.businessModel,
            buyerICP: idea.buyerICP,
            initialWedge: idea.initialWedge,
            thesisNotes: idea.thesisNotes,
          },
          founderBackground: settings.founderBackground,
          coFounders: teamPayload,
          provider: settings.provider,
          model,
          webSearch: settings.webSearch,
          mode,
        }),
      });

      if (!res.ok) {
        let message = `Analysis failed (HTTP ${res.status}).`;
        try {
          const body = (await res.json()) as { error?: unknown };
          if (body && typeof body.error === "string" && body.error) {
            message = body.error;
          }
        } catch {
          // Non-JSON error body — keep the generic message.
        }
        if (mountedRef.current) setError(message);
        return;
      }

      if (mode === "metadata") {
        const data = (await res.json()) as AnalyzeMetadataResponse;
        const latest = ideaRef.current;
        const patch: Partial<Idea> = {};
        for (const f of META_FIELDS) {
          const proposal = data.metadata?.[f]?.trim();
          if (
            proposal &&
            !snapshot.meta[f].trim() &&
            latest[f] === snapshot.meta[f]
          ) {
            patch[f] = proposal;
          }
        }
        if (
          data.refinedDescription &&
          latest.thesisNotes === snapshot.thesisNotes
        ) {
          patch.thesisNotes = data.refinedDescription;
        }
        onPatch(patch);
        return;
      }

      const data = (await res.json()) as AnalyzeResponse;
      const latest = ideaRef.current;

      const gates = {} as Record<GateId, GateValue>;
      const gateRationales: Partial<Record<GateId, string>> = {};
      for (const gid of GATE_IDS) {
        if (latest.gates[gid] !== snapshot.gates[gid]) {
          gates[gid] = latest.gates[gid]; // user answered this gate mid-flight
        } else {
          const g = data.gates?.[gid];
          gates[gid] = g ? (g.value === "UNSURE" ? null : g.value) : null;
        }
        const g = data.gates?.[gid];
        if (g?.rationale) gateRationales[gid] = g.rationale;
      }

      const scores = {} as Record<CriterionId, number | null>;
      const scoreRationales: Partial<Record<CriterionId, string>> = {};
      for (const cid of CRITERION_IDS) {
        if (latest.scores[cid] !== snapshot.scores[cid]) {
          scores[cid] = latest.scores[cid]; // user scored this one mid-flight
        } else {
          const s = data.scores?.[cid];
          scores[cid] = s ? s.score : null;
        }
        const s = data.scores?.[cid];
        if (s?.rationale) scoreRationales[cid] = s.rationale;
      }

      const confidence: Confidence =
        latest.confidence !== snapshot.confidence
          ? latest.confidence
          : data.confidence;
      const validationTest30d =
        latest.validationTest30d !== snapshot.validationTest30d
          ? latest.validationTest30d
          : data.validationTest30d;

      // Metadata: only fill fields the founder left blank (and didn't touch
      // while the request ran) — never rewrite what they typed themselves.
      const metaPatch: Partial<
        Record<(typeof META_FIELDS)[number], string>
      > = {};
      for (const f of META_FIELDS) {
        const proposal = data.metadata?.[f]?.trim();
        if (
          proposal &&
          !snapshot.meta[f].trim() &&
          latest[f] === snapshot.meta[f]
        ) {
          metaPatch[f] = proposal;
        }
      }

      onPatch({
        ...metaPatch,
        gates,
        scores,
        confidence,
        validationTest30d,
        ai: {
          summary: data.summary,
          gateRationales,
          scoreRationales,
          confidenceRationale: data.confidenceRationale,
          needsFounderConfirmation: data.needsFounderConfirmation ?? [],
          provider: data.provider,
          model: data.model,
          analyzedAt: new Date().toISOString(),
          webSearches: data.webSearches ?? 0,
        },
      });
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : "Network error.");
      }
    } finally {
      if (mountedRef.current) setPending(false);
    }
  }

  const ai = idea.ai;

  return (
    <Section
      title="AI analysis"
      description="Fills gates, scores, confidence and the 30-day test from your idea + founder background — everything stays editable."
      actions={
        <span className="text-xs text-zinc-500">
          {settings.provider} · {model}
        </span>
      }
    >
      {!hasBackground ? (
        <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Founder background is required before analysis — the AI judges
          founder–market fit and founder-personal gates from it. Add yours in{" "}
          <Link href="/settings" className="underline">
            Settings
          </Link>
          .
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          onClick={() => void analyze("full")}
          disabled={pending || !hasBackground}
          title={
            hasBackground
              ? undefined
              : "Add your founder background in Settings first"
          }
        >
          Analyze with AI
        </Button>
        {pending ? (
          <span className="flex items-center gap-2 text-xs text-zinc-500">
            <span
              aria-hidden
              className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-200 border-t-teal-600"
            />
            {pendingMode === "metadata"
              ? "Naming and describing the idea…"
              : "Analyzing — thinking models can take a minute or two. The result is applied even if you navigate elsewhere."}
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      ) : null}

      {ai ? (
        <div className="mt-3 space-y-2 border-t border-zinc-100 pt-3">
          <p className="text-sm text-zinc-700">{ai.summary}</p>
          <p className="text-xs text-zinc-400">
            Analyzed with {ai.model}
            {ai.webSearches ? (
              <> · {ai.webSearches} web search{ai.webSearches === 1 ? "" : "es"}</>
            ) : null}{" "}
            · {new Date(ai.analyzedAt).toLocaleString()}
          </p>
          {ai.needsFounderConfirmation?.length ? (
            <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Confirm these gates yourself:{" "}
              {ai.needsFounderConfirmation
                .map((g) => GATES_BY_ID[g]?.label ?? g)
                .join(", ")}
            </div>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
