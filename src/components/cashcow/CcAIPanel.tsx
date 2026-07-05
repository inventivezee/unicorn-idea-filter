"use client";

// AI analysis runner for the Cash Cow Filter. Mirrors AIPanel's guarantees:
// the request outlives navigation (pending state lives in the store), results
// merge against the store's live idea, and user edits made mid-flight win.
// Writes to idea.cashcow; shared metadata fields fill blanks only.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { getAnonKey } from "@/lib/anon";
import { CC_GATES_BY_ID } from "@/lib/cashcow/criteria";
import { emptyCashCowBlock } from "@/lib/cashcow/engine";
import { isPremiumModel } from "@/lib/entitlements";
import { useStore } from "@/lib/store";
import {
  CC_CRITERION_IDS,
  CC_GATE_IDS,
  hasClarificationsFor,
} from "@/lib/types";
import { Button, Section } from "@/components/ui";
import {
  markClarifyAsked,
  wasClarifyAsked,
} from "@/components/clarify/ClarifyForm";
import { PreAnalysisClarify } from "@/components/clarify/PreAnalysisClarify";
import type {
  AnalyzeMetadataResponse,
  CashCowBlock,
  Clarification,
  CcAnalyzeResponse,
  CcCriterionId,
  CcGateId,
  Confidence,
  GateValue,
  Idea,
  Settings,
} from "@/lib/types";

export function CcAIPanel({
  idea,
  settings,
  onPatch,
}: {
  idea: Idea;
  settings: Settings;
  onPatch: (patch: Partial<Idea> | ((latest: Idea) => Partial<Idea>)) => void;
}) {
  const router = useRouter();
  const { analyzing, beginAnalysis, endAnalysis } = useStore();
  // Instrument-tagged pending state: this panel owns "cc_full"/"cc_metadata";
  // bare "full"/"metadata" belongs to the unicorn panel.
  const activeKind = analyzing[idea.id] ?? null;
  const mine = activeKind === "cc_full" || activeKind === "cc_metadata";
  const pending = activeKind !== null;
  const pendingMode = activeKind === "cc_metadata" ? "metadata" : "full";
  const otherInstrumentRunning = pending && !mine;
  const [error, setError] = useState<string | null>(null);
  // Pre-analysis clarify: shown when the idea has no clarifying answers for
  // the cash-cow filter (e.g. it was clarified under the unicorn filter only).
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

  // Quick-add flow: ?analyze=1 runs the full cash-cow analysis; ?fill=1 just
  // names and describes the idea (shared metadata mode, no scoring).
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
    if (wantsFull && !idea.cashcow?.ai) {
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
    // No clarifying answers for this filter yet → ask first (skippable).
    if (
      mode === "full" &&
      extraClarifications === undefined &&
      settings.askClarifying &&
      !clarifyHandledRef.current &&
      !wasClarifyAsked(idea.id, "cashcow") &&
      !hasClarificationsFor(idea.clarifications, "cashcow")
    ) {
      setError(null);
      setShowClarify(true);
      return;
    }
    setError(null);
    beginAnalysis(idea.id, mode === "full" ? "cc_full" : "cc_metadata");
    const cc = idea.cashcow ?? emptyCashCowBlock();
    // Snapshot at click time: fields the user later touches win over the AI.
    const snapshot = {
      gates: { ...cc.gates },
      scores: { ...cc.scores },
      confidence: cc.confidence,
      validationTest30d: cc.validationTest30d,
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
          filter: "cashcow",
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
          // Non-JSON error body — keep the generic message.
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

      const data = (await res.json()) as CcAnalyzeResponse;

      onPatch((latest) => {
        const latestCc = latest.cashcow ?? emptyCashCowBlock();
        const gates = {} as Record<CcGateId, GateValue>;
        const gateRationales: Partial<Record<CcGateId, string>> = {};
        for (const gid of CC_GATE_IDS) {
          if (latestCc.gates[gid] !== snapshot.gates[gid]) {
            gates[gid] = latestCc.gates[gid]; // user answered mid-flight
          } else {
            const g = data.gates?.[gid];
            gates[gid] = g ? (g.value === "UNSURE" ? null : g.value) : null;
          }
          const g = data.gates?.[gid];
          if (g?.rationale) gateRationales[gid] = g.rationale;
        }

        const scores = {} as Record<CcCriterionId, number | null>;
        const scoreRationales: Partial<Record<CcCriterionId, string>> = {};
        for (const cid of CC_CRITERION_IDS) {
          if (latestCc.scores[cid] !== snapshot.scores[cid]) {
            scores[cid] = latestCc.scores[cid]; // user scored mid-flight
          } else {
            const s = data.scores?.[cid];
            scores[cid] = s ? s.score : null;
          }
          const s = data.scores?.[cid];
          if (s?.rationale) scoreRationales[cid] = s.rationale;
        }

        const confidence: Confidence =
          latestCc.confidence !== snapshot.confidence
            ? latestCc.confidence
            : data.confidence;
        const validationTest30d =
          latestCc.validationTest30d !== snapshot.validationTest30d
            ? latestCc.validationTest30d
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

        const cashcow: CashCowBlock = {
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
        };
        return { ...metaPatch, ...profilePatch, cashcow };
      });
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : "Network error.");
      }
    } finally {
      endAnalysis(idea.id);
    }
  }

  const ai = idea.cashcow?.ai;

  return (
    <Section
      title="AI analysis — cash cow"
      description="Judges the idea like a buyout investor: margins, cash conversion, founder control, durability. Everything stays editable."
      actions={
        <span className="text-xs text-zinc-500">
          {settings.provider} · {model}
        </span>
      }
    >
      {!hasBackground ? (
        <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Founder background is required before analysis — the AI judges
          founder–market fit and the founder-control gate from it. Add yours in{" "}
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
              className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-200 border-t-amber-500"
            />
            {pendingMode === "metadata"
              ? "Naming and describing the idea…"
              : "Analyzing against the $20M EBITDA bar — thinking models can take a minute or two. The result is applied even if you navigate elsewhere."}
          </span>
        ) : null}
        {otherInstrumentRunning ? (
          <span className="flex items-center gap-2 text-xs text-zinc-500">
            <span
              aria-hidden
              className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-200 border-t-teal-600"
            />
            A Unicorn analysis is running for this idea — its result lands in
            the Unicorn Idea Filter.
          </span>
        ) : null}
      </div>

      {showClarify ? (
        <PreAnalysisClarify
          idea={idea}
          settings={settings}
          filter="cashcow"
          onReady={(extra) => {
            clarifyHandledRef.current = true;
            markClarifyAsked(idea.id, "cashcow");
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
                .map((g) => CC_GATES_BY_ID[g]?.label ?? g)
                .join(", ")}
            </div>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
