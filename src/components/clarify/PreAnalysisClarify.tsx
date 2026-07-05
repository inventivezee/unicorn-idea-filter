"use client";

// Pre-analysis clarifying questions: shown by an AI panel when the idea has
// no clarifying answers for the ACTIVE filter (e.g. it was created and
// clarified under the unicorn filter and is now being analyzed as a cash
// cow). Fetches filter-framed questions — seeded with the idea, its metadata,
// and the previously answered Q&A so nothing is re-asked — and hands the new
// answers back to the panel to save and analyze with.
import { useEffect, useRef, useState } from "react";
import { getAnonKey } from "@/lib/anon";
import { Button } from "@/components/ui";
import {
  ClarifyQuestionList,
  composeClarifications,
  emptyAnswersFor,
  normalizeClarifyQuestions,
  type ClarifyAnswer,
} from "./ClarifyForm";
import type {
  Clarification,
  ClarifyQuestion,
  FilterMode,
  Idea,
  Settings,
} from "@/lib/types";

export function PreAnalysisClarify({
  idea,
  settings,
  filter,
  onReady,
}: {
  idea: Idea;
  settings: Settings;
  filter: FilterMode;
  /** Called with the NEW answers to append (empty = proceed without any). */
  onReady: (extra: Clarification[]) => void;
}) {
  const [questions, setQuestions] = useState<ClarifyQuestion[] | null>(null);
  const [answers, setAnswers] = useState<ClarifyAnswer[]>([]);
  const fetchedRef = useRef(false);
  // Unmounting (navigating away, switching filters) abandons the clarify step
  // entirely — consistently drop, never launch an analysis nobody is watching
  // for. The user simply clicks Analyze again when they return.
  const cancelledRef = useRef(false);
  const accent = filter === "cashcow" ? "amber" : "teal";

  useEffect(() => {
    // Reset on every (re)mount — StrictMode's simulated unmount runs the
    // cleanup once on the same instance, which must not cancel for good.
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    (async () => {
      try {
        const res = await fetch("/api/clarify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description: idea.thesisNotes,
            metadata: {
              name: idea.name,
              domain: idea.domain,
              businessModel: idea.businessModel,
              buyerICP: idea.buyerICP,
              initialWedge: idea.initialWedge,
            },
            previousClarifications: idea.clarifications ?? [],
            founderBackground: settings.founderBackground,
            coFounders: settings.coFounders
              .filter((c) => c.background.trim())
              .map((c) => ({ name: c.name, background: c.background })),
            provider: settings.provider,
            model: settings.models[settings.provider],
            anonKey: getAnonKey(),
            filter,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { questions?: unknown };
        const normalized = normalizeClarifyQuestions(data.questions);
        if (cancelledRef.current) return; // abandoned — drop silently
        if (normalized.length === 0) {
          onReady([]); // nothing worth asking — analyze straight away
          return;
        }
        setQuestions(normalized);
        setAnswers(emptyAnswersFor(normalized));
      } catch {
        // Clarifying is a nice-to-have — never block the analysis on it.
        if (!cancelledRef.current) onReady([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (questions === null) {
    return (
      <div className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
        <span
          aria-hidden
          className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-200 ${
            accent === "amber" ? "border-t-amber-500" : "border-t-teal-600"
          }`}
        />
        Preparing a few clarifying questions for this filter…
      </div>
    );
  }

  function patchAnswer(i: number, patch: Partial<ClarifyAnswer>) {
    setAnswers((all) => all.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  }
  function toggleChoice(i: number, opt: string) {
    setAnswers((all) =>
      all.map((a, j) =>
        j === i
          ? {
              ...a,
              choices: a.choices.includes(opt)
                ? a.choices.filter((c) => c !== opt)
                : [...a.choices, opt],
            }
          : a,
      ),
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50/50 p-3">
      <p className="text-sm font-semibold text-zinc-900">
        {filter === "cashcow"
          ? "A few cash-cow questions first"
          : "A few venture questions first"}
      </p>
      <p className="mt-0.5 text-xs text-zinc-500">
        This filter weighs different things than the one this idea was
        clarified for — your answers sharpen the analysis. All optional.
      </p>
      <div className="mt-3">
        <ClarifyQuestionList
          questions={questions}
          answers={answers}
          onToggleChoice={toggleChoice}
          onPatchAnswer={patchAnswer}
          accent={accent}
        />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          onClick={() =>
            onReady(composeClarifications(questions, answers, filter))
          }
        >
          Answer &amp; analyze
        </Button>
        <button
          type="button"
          onClick={() => onReady([])}
          className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline"
        >
          Skip &amp; analyze now
        </button>
      </div>
    </div>
  );
}
