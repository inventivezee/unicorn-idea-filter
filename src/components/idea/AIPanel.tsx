"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { getAnonKey } from "@/lib/anon";
import { GATES_BY_ID } from "@/lib/criteria";
import { isPremiumModel } from "@/lib/entitlements";
import { useStore } from "@/lib/store";
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
  onPatch: (patch: Partial<Idea> | ((latest: Idea) => Partial<Idea>)) => void;
}) {
  const router = useRouter();
  const { analyzing, beginAnalysis, endAnalysis } = useStore();
  // Pending state lives in the store (keyed by idea id), so it survives
  // navigating away and is reflected if the user returns to this idea while
  // the request is still running.
  const activeMode = analyzing[idea.id] ?? null;
  const pending = activeMode !== null;
  const pendingMode = activeMode ?? "full";
  const [error, setError] = useState<string | null>(null);
  const [failedMode, setFailedMode] = useState<"full" | "metadata" | null>(
    null,
  );
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
    if (analyzing[idea.id]) return; // already running for this idea
    if (mode === "full" && !settings.founderBackground.trim()) {
      setError(
        "Analysis needs your founder background — add it in Settings first.",
      );
      return;
    }
    setError(null);
    setFailedMode(null);
    beginAnalysis(idea.id, mode);
    // Snapshot at click time: fields the user later touches win over the AI.
    const snapshot = {
      gates: { ...idea.gates },
      scores: { ...idea.scores },
      confidence: idea.confidence,
      validationTest30d: idea.validationTest30d,
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
          provider: settings.provider,
          model,
          webSearch: settings.webSearch,
          mode,
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
        // Free tier exceeded / premium model → send them to the plan page.
        if (upgrade || res.status === 402) {
          const reason = isPremiumModel(model) ? "premium" : "quota";
          router.push(`/upgrade?reason=${reason}`);
          return;
        }
        if (mountedRef.current) {
          setError(message);
          setFailedMode(mode);
        }
        return;
      }

      if (mode === "metadata") {
        const data = (await res.json()) as AnalyzeMetadataResponse;
        // Merge against the store's live idea at apply time — a component
        // ref would freeze at unmount and clobber edits made after remount.
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

      const data = (await res.json()) as AnalyzeResponse;

      // Merge against the store's live idea at apply time (see above).
      onPatch((latest) => {
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

        const profilePatch: Partial<Idea> = {};
        if (
          data.founderProfile &&
          !snapshot.founderProfile.trim() &&
          (latest.founderProfile ?? "") === snapshot.founderProfile
        ) {
          profilePatch.founderProfile = data.founderProfile;
        }

        return {
          ...metaPatch,
          ...profilePatch,
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
      });
    } catch (e) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : "Network error.");
        setFailedMode(mode);
      }
    } finally {
      // Store update — safe after unmount, and clears the app-wide indicator.
      endAnalysis(idea.id);
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
          <p>{error}</p>
          {failedMode === "metadata" ? (
            <button
              type="button"
              onClick={() => void analyze("metadata")}
              disabled={pending}
              className="mt-2 font-medium underline underline-offset-2 disabled:opacity-50"
            >
              Retry naming &amp; description
            </button>
          ) : null}
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
