"use client";

// AI analysis runner for a founder's custom filter. Mirrors the other panels'
// guarantees: the request outlives navigation, results merge against the
// store's live idea, user edits made mid-flight win, and a pre-analysis
// clarify round fires when the idea has no answers for THIS filter yet.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { getAnonKey } from "@/lib/anon";
import { editableBlockOf } from "@/components/custom/CustomSections";
import { isPremiumModel } from "@/lib/entitlements";
import { useStore } from "@/lib/store";
import { hasClarificationsFor, specToSnapshot } from "@/lib/types";
import { Button, Section } from "@/components/ui";
import {
  markClarifyAsked,
  wasClarifyAsked,
} from "@/components/clarify/ClarifyForm";
import { PreAnalysisClarify } from "@/components/clarify/PreAnalysisClarify";
import type {
  AnalyzeMetadataResponse,
  Clarification,
  Confidence,
  CustomBlock,
  CustomFilterSpec,
  GateValue,
  Idea,
  Settings,
} from "@/lib/types";

interface CustomWireResponse {
  summary: string;
  metadata: Record<string, string>;
  founderProfile: string;
  gates: Record<string, { value: "Y" | "N" | "UNSURE"; rationale: string }>;
  scores: Record<string, { score: number; rationale: string }>;
  confidence: 0.5 | 0.75 | 1.0;
  confidenceRationale: string;
  validationTest30d: string;
  needsFounderConfirmation: string[];
  provider: "anthropic" | "openai";
  model: string;
  webSearches: number;
}

export function CustomAIPanel({
  idea,
  spec,
  settings,
  onPatch,
}: {
  idea: Idea;
  spec: CustomFilterSpec;
  settings: Settings;
  onPatch: (patch: Partial<Idea> | ((latest: Idea) => Partial<Idea>)) => void;
}) {
  const router = useRouter();
  const { analyzing, beginAnalysis, endAnalysis } = useStore();
  const clarifyKey = `custom:${spec.id}`;
  const activeKind = analyzing[idea.id] ?? null;
  const mine =
    activeKind === `custom_full:${spec.id}` ||
    activeKind === `custom_metadata:${spec.id}`;
  const pending = activeKind !== null;
  const pendingMode =
    activeKind === `custom_metadata:${spec.id}` ? "metadata" : "full";
  const otherInstrumentRunning = pending && !mine;
  const [error, setError] = useState<string | null>(null);
  const [showClarify, setShowClarify] = useState(false);
  const clarifyHandledRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const model = settings.models[settings.provider];
  const hasBackground = settings.founderBackground.trim().length > 0;
  const teamPayload = settings.coFounders
    .filter((c) => c.background.trim())
    .map((c) => ({ name: c.name, background: c.background }));

  // Quick-add flow: ?analyze=1 runs the full analysis in this filter.
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
    if (wantsFull && !idea.custom?.[spec.id]?.ai) {
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

  async function analyze(
    mode: "full" | "metadata" = "full",
    extraClarifications?: Clarification[],
  ) {
    if (analyzing[idea.id]) return;
    if (mode === "full" && !settings.founderBackground.trim()) {
      setError(
        "Analysis needs your founder background — add it in Settings first.",
      );
      return;
    }
    if (
      mode === "full" &&
      extraClarifications === undefined &&
      settings.askClarifying &&
      !clarifyHandledRef.current &&
      !wasClarifyAsked(idea.id, clarifyKey) &&
      !hasClarificationsFor(idea.clarifications, clarifyKey)
    ) {
      setError(null);
      setShowClarify(true);
      return;
    }
    setError(null);
    beginAnalysis(
      idea.id,
      mode === "full" ? `custom_full:${spec.id}` : `custom_metadata:${spec.id}`,
    );
    // Version-matched view: a stale-version block's values are not "user
    // answers" under the current spec's ids, so they read as blank here.
    const block = editableBlockOf(idea, spec);
    const snapshot = {
      gates: { ...block.gates },
      scores: { ...block.scores },
      confidence: block.confidence,
      validationTest30d: block.validationTest30d,
      thesisNotes: idea.thesisNotes,
      founderProfile: idea.founderProfile ?? "",
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
          clarifications: [
            ...(idea.clarifications ?? []),
            ...(extraClarifications ?? []),
          ],
          provider: settings.provider,
          model,
          webSearch: settings.webSearch,
          mode,
          filter: "custom",
          customSpec: spec,
          ideaId: idea.id,
          anonKey: getAnonKey(),
        }),
      });

      if (!res.ok) {
        let message = `Analysis failed (HTTP ${res.status}).`;
        let upgrade = false;
        try {
          const body = (await res.json()) as {
            error?: unknown;
            upgrade?: unknown;
          };
          if (body && typeof body.error === "string" && body.error) {
            message = body.error;
          }
          upgrade = body?.upgrade === true;
        } catch {
          // Non-JSON error body.
        }
        if (upgrade || res.status === 402) {
          const reason = isPremiumModel(model) ? "premium" : "quota";
          router.push(`/upgrade?reason=${reason}`);
          return;
        }
        if (mountedRef.current) setError(message);
        return;
      }

      if (mode === "metadata") {
        const data = (await res.json()) as AnalyzeMetadataResponse;
        onPatch((latest) => {
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
          if (
            data.founderProfile &&
            !snapshot.founderProfile.trim() &&
            (latest.founderProfile ?? "") === snapshot.founderProfile
          ) {
            patch.founderProfile = data.founderProfile;
          }
          return patch;
        });
        return;
      }

      const data = (await res.json()) as CustomWireResponse;

      onPatch((latest) => {
        const latestBlock = editableBlockOf(latest, spec);
        const gates: Record<string, GateValue> = {};
        const gateRationales: Record<string, string> = {};
        for (const g of spec.gates) {
          if (latestBlock.gates[g.id] !== snapshot.gates[g.id]) {
            gates[g.id] = latestBlock.gates[g.id]; // user answered mid-flight
          } else {
            const v = data.gates?.[g.id];
            gates[g.id] = v ? (v.value === "UNSURE" ? null : v.value) : null;
          }
          const v = data.gates?.[g.id];
          if (v?.rationale) gateRationales[g.id] = v.rationale;
        }
        const scores: Record<string, number | null> = {};
        const scoreRationales: Record<string, string> = {};
        for (const c of spec.criteria) {
          if (latestBlock.scores[c.id] !== snapshot.scores[c.id]) {
            scores[c.id] = latestBlock.scores[c.id];
          } else {
            const sc = data.scores?.[c.id];
            scores[c.id] = sc ? sc.score : null;
          }
          const sc = data.scores?.[c.id];
          if (sc?.rationale) scoreRationales[c.id] = sc.rationale;
        }
        const confidence: Confidence =
          latestBlock.confidence !== snapshot.confidence
            ? latestBlock.confidence
            : data.confidence;
        const validationTest30d =
          latestBlock.validationTest30d !== snapshot.validationTest30d
            ? latestBlock.validationTest30d
            : data.validationTest30d;

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
        const profilePatch: Partial<Idea> = {};
        if (
          data.founderProfile &&
          !snapshot.founderProfile.trim() &&
          (latest.founderProfile ?? "") === snapshot.founderProfile
        ) {
          profilePatch.founderProfile = data.founderProfile;
        }

        const block: CustomBlock = {
          gates,
          scores,
          confidence,
          validationTest30d,
          snapshot: specToSnapshot(spec),
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
        };
        return {
          ...metaPatch,
          ...profilePatch,
          custom: { ...(latest.custom ?? {}), [spec.id]: block },
        };
      });
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : "Network error.");
      }
    } finally {
      endAnalysis(idea.id);
    }
  }

  const ai = idea.custom?.[spec.id]?.ai;

  return (
    <Section
      title={`AI analysis — ${spec.name}`}
      description="Judges the idea against YOUR stated goals — profit target, hours, horizon, constraints. Everything stays editable."
      actions={
        <span className="text-xs text-zinc-500">
          {settings.provider} · {model}
        </span>
      }
    >
      {!hasBackground ? (
        <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Founder background is required before analysis — the AI judges
          founder-fit against it. Add yours in{" "}
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
        {pending && mine ? (
          <span className="flex items-center gap-2 text-xs text-zinc-500">
            <span
              aria-hidden
              className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-200 border-t-violet-500"
            />
            {pendingMode === "metadata"
              ? "Naming and describing the idea…"
              : "Analyzing against your bar — thinking models can take a minute or two. The result is applied even if you navigate elsewhere."}
          </span>
        ) : null}
        {otherInstrumentRunning ? (
          <span className="flex items-center gap-2 text-xs text-zinc-500">
            <span
              aria-hidden
              className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-200 border-t-teal-600"
            />
            Another instrument&apos;s analysis is running for this idea — its
            result lands in that filter.
          </span>
        ) : null}
      </div>

      {showClarify ? (
        <PreAnalysisClarify
          idea={idea}
          settings={settings}
          filter="custom"
          customSpec={spec}
          onReady={(extra) => {
            clarifyHandledRef.current = true;
            markClarifyAsked(idea.id, clarifyKey);
            setShowClarify(false);
            if (extra.length) {
              onPatch((latest) => ({
                clarifications: [...(latest.clarifications ?? []), ...extra],
              }));
            }
            void analyze("full", extra);
          }}
        />
      ) : null}

      {error ? (
        <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <p>{error}</p>
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
            · {new Date(ai.analyzedAt).toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          </p>
          {ai.needsFounderConfirmation?.length ? (
            <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Confirm these gates yourself:{" "}
              {ai.needsFounderConfirmation
                .map(
                  (g) => spec.gates.find((x) => x.id === g)?.label ?? g,
                )
                .join(", ")}
            </div>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
