"use client";

// Reframe generator — shown when the active instrument's decision is
// KILL / REFRAME or PARK / NARROW. Proposes substantive mutations that attack
// the idea's specific weaknesses (failed gates, killer flags, top risks); each
// reframe can be added to the pipeline as a new idea linked back to this one.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { getAnonKey } from "@/lib/anon";
import { ccDecision } from "@/lib/cashcow/engine";
import { emptyCashCowBlock } from "@/lib/cashcow/engine";
import { decision } from "@/lib/engine";
import { useStore } from "@/lib/store";
import { Button, Section } from "@/components/ui";
import type { FilterMode, Idea, Settings } from "@/lib/types";

interface Reframe {
  name: string;
  pitch: string;
  whatChanged: string;
  risksAddressed: string;
}

export function ReframePanel({
  idea,
  settings,
  filter,
}: {
  idea: Idea;
  settings: Settings;
  filter: FilterMode;
}) {
  const { addIdea } = useStore();
  const router = useRouter();
  const cashcow = filter === "cashcow";
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reframes, setReframes] = useState<Reframe[] | null>(null);
  const [added, setAdded] = useState<Record<number, string>>({});

  // Only offer reframes once the instrument has actually judged the idea
  // weak — that's when "reframe" is the decision ladder's own advice.
  const cc = idea.cashcow ?? emptyCashCowBlock();
  const dec = cashcow
    ? ccDecision({
        gates: cc.gates,
        scores: cc.scores,
        confidence: cc.confidence,
      })
    : decision({
        name: idea.name,
        gates: idea.gates,
        scores: idea.scores,
        confidence: idea.confidence,
        weights: settings.weights,
      });
  const weak =
    dec === "KILL / REFRAME" || dec === "PARK / NARROW" || dec === "KILL";
  if (!weak && !reframes) return null;

  async function generate() {
    if (loading) return;
    setError(null);
    setLoading(true);
    // A regenerate is a NEW batch — stale index→id mappings from the previous
    // batch must not mark fresh reframes as already added.
    setReframes(null);
    setAdded({});
    try {
      const ai = cashcow ? idea.cashcow?.ai : idea.ai;
      const res = await fetch("/api/reframe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filter,
          idea: {
            name: idea.name,
            domain: idea.domain,
            businessModel: idea.businessModel,
            buyerICP: idea.buyerICP,
            initialWedge: idea.initialWedge,
            thesisNotes: idea.thesisNotes,
          },
          gates: cashcow ? cc.gates : idea.gates,
          scores: cashcow ? cc.scores : idea.scores,
          weights: settings.weights,
          gateRationales: ai?.gateRationales ?? {},
          scoreRationales: ai?.scoreRationales ?? {},
          aiSummary: ai?.summary ?? "",
          clarifications: idea.clarifications ?? [],
          founderBackground: settings.founderBackground,
          coFounders: settings.coFounders
            .filter((c) => c.background.trim())
            .map((c) => ({ name: c.name, background: c.background })),
          provider: settings.provider,
          model: settings.models[settings.provider],
          anonKey: getAnonKey(),
        }),
      });
      if (!res.ok) {
        let message = `Couldn't generate reframes (HTTP ${res.status}).`;
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
          router.push("/upgrade?reason=premium");
          return;
        }
        setError(message);
        return;
      }
      const data = (await res.json()) as { reframes?: Reframe[] };
      if (!Array.isArray(data.reframes) || data.reframes.length === 0) {
        setError("No usable reframes came back — try again.");
        return;
      }
      setReframes(data.reframes);
    } catch {
      setError("Network error while generating reframes.");
    } finally {
      setLoading(false);
    }
  }

  function addToPipeline(r: Reframe, index: number) {
    if (added[index]) return;
    const created = addIdea({
      name: r.name,
      domain: idea.domain,
      thesisNotes: `${r.pitch}\n\nReframed from “${idea.name || "an earlier idea"}” — ${r.whatChanged}`,
    });
    setAdded((a) => ({ ...a, [index]: created.id }));
  }

  return (
    <Section
      title="Reframe this idea"
      description={
        cashcow
          ? "It missed the EBITDA bar as-is. Generate mutations that attack its specific weaknesses — different buyer, wedge, model, or scope."
          : "It missed the venture bar as-is. Generate mutations that attack its specific weaknesses — different buyer, wedge, model, or scope."
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          onClick={() => void generate()}
          disabled={loading}
        >
          {reframes ? "Regenerate reframes" : "Generate reframes"}
        </Button>
        {loading ? (
          <span className="flex items-center gap-2 text-xs text-zinc-500">
            <span
              aria-hidden
              className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-200 ${
                cashcow ? "border-t-amber-500" : "border-t-teal-600"
              }`}
            />
            Studying the weaknesses and generating reframes…
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      ) : null}

      {reframes ? (
        <div className="mt-4 space-y-3">
          {reframes.map((r, i) => (
            <div
              key={i}
              className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-zinc-900">
                  {r.name}
                </h3>
                {added[i] ? (
                  <Link
                    href={`/idea/${added[i]}`}
                    className="text-xs font-medium text-teal-700 underline-offset-2 hover:underline"
                  >
                    Added — open ↗
                  </Link>
                ) : (
                  <Button
                    className="px-2 py-1 text-xs!"
                    onClick={() => addToPipeline(r, i)}
                  >
                    Add to pipeline
                  </Button>
                )}
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-zinc-700">
                {r.pitch}
              </p>
              <p className="mt-2 text-xs text-zinc-500">
                <span className="font-medium">What changed:</span>{" "}
                {r.whatChanged}
              </p>
              {r.risksAddressed ? (
                <p className="mt-1 text-xs text-zinc-500">
                  <span className="font-medium">Fixes:</span>{" "}
                  {r.risksAddressed}
                </p>
              ) : null}
            </div>
          ))}
          <p className="text-xs text-zinc-400">
            Added reframes start fresh — score them from their own pages.
          </p>
        </div>
      ) : null}
    </Section>
  );
}
