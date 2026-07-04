"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { GATES_BY_ID } from "@/lib/criteria";
import { CRITERION_IDS, GATE_IDS } from "@/lib/types";
import { Button, Section } from "@/components/ui";
import type {
  AnalyzeResponse,
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
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  // Abort any in-flight request when the component unmounts.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const model = settings.models[settings.provider];

  async function analyze() {
    setError(null);
    setPending(true);
    const controller = new AbortController();
    controllerRef.current = controller;
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
          provider: settings.provider,
          model,
        }),
        signal: controller.signal,
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
        setError(message);
        return;
      }

      const data = (await res.json()) as AnalyzeResponse;

      const gates = {} as Record<GateId, GateValue>;
      const gateRationales: Partial<Record<GateId, string>> = {};
      for (const gid of GATE_IDS) {
        const g = data.gates?.[gid];
        gates[gid] = g ? (g.value === "UNSURE" ? null : g.value) : null;
        if (g?.rationale) gateRationales[gid] = g.rationale;
      }

      const scores = {} as Record<CriterionId, number | null>;
      const scoreRationales: Partial<Record<CriterionId, string>> = {};
      for (const cid of CRITERION_IDS) {
        const s = data.scores?.[cid];
        scores[cid] = s ? s.score : null;
        if (s?.rationale) scoreRationales[cid] = s.rationale;
      }

      onPatch({
        gates,
        scores,
        confidence: data.confidence,
        validationTest30d: data.validationTest30d,
        ai: {
          summary: data.summary,
          gateRationales,
          scoreRationales,
          confidenceRationale: data.confidenceRationale,
          needsFounderConfirmation: data.needsFounderConfirmation ?? [],
          provider: data.provider,
          model: data.model,
          analyzedAt: new Date().toISOString(),
        },
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      if (!controller.signal.aborted) setPending(false);
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
      {!settings.founderBackground.trim() ? (
        <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Founder-personal gates will come back unanswered — add your
          background in{" "}
          <Link href="/settings" className="underline">
            Settings
          </Link>
          .
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={analyze} disabled={pending}>
          Analyze with AI
        </Button>
        {pending ? (
          <span className="flex items-center gap-2 text-xs text-zinc-500">
            <span
              aria-hidden
              className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-200 border-t-teal-600"
            />
            Analyzing — thinking models can take a minute or two…
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
            Analyzed with {ai.model} ·{" "}
            {new Date(ai.analyzedAt).toLocaleString()}
          </p>
          {ai.needsFounderConfirmation.length > 0 ? (
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
