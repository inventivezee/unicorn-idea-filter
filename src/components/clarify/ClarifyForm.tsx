"use client";

// Shared clarifying-questions form: multi-select answer rows with an "Other"
// free-text option and a focus nudge past 2 selections. Used by the QuickAdd
// wizard (at idea creation) and by the AI panels (pre-analysis in a filter
// the idea hasn't been clarified for yet).
import { useState } from "react";
import type { Clarification, ClarifyQuestion } from "@/lib/types";

/** Per-question answer: any number of picked options, plus optional free text. */
export interface ClarifyAnswer {
  choices: string[];
  custom: string;
  showCustom: boolean;
}

export function emptyAnswersFor(questions: ClarifyQuestion[]): ClarifyAnswer[] {
  return questions.map((q) => ({
    choices: [],
    custom: "",
    // No options to click → open the text field straight away.
    showCustom: q.options.length === 0,
  }));
}

/** Combine picked options + optional free text into one answer string. */
export function answerText(a: ClarifyAnswer | undefined): string {
  if (!a) return "";
  const parts = [...a.choices];
  if (a.showCustom && a.custom.trim()) parts.push(a.custom.trim());
  return parts.join("; ");
}

/** Structured Q&A to persist with the idea (answered questions only). */
export function composeClarifications(
  questions: ClarifyQuestion[],
  answers: ClarifyAnswer[],
  /** Instrument key: "unicorn", "cashcow", or "custom:<filterId>". */
  filter: string,
): Clarification[] {
  return questions
    .map((q, i) => ({
      question: q.question,
      answer: answerText(answers[i]),
      filter,
    }))
    .filter((c) => c.answer);
}

/** Coerce the /api/clarify payload into valid ClarifyQuestion[] (dedupes options). */
export function normalizeClarifyQuestions(value: unknown): ClarifyQuestion[] {
  if (!Array.isArray(value)) return [];
  const out: ClarifyQuestion[] = [];
  for (const q of value) {
    if (typeof q === "string") {
      if (q.trim()) out.push({ question: q.trim(), options: [] });
      continue;
    }
    if (q && typeof q === "object") {
      const { question, options } = q as {
        question?: unknown;
        options?: unknown;
      };
      if (typeof question === "string" && question.trim()) {
        const opts = Array.from(
          new Set(
            (Array.isArray(options) ? options : [])
              .filter((o): o is string => typeof o === "string" && !!o.trim())
              .map((o) => o.trim()),
          ),
        ).slice(0, 5);
        out.push({ question: question.trim(), options: opts });
      }
    }
  }
  return out.slice(0, 5);
}

// ---------------------------------------------------------------------------
// "Already offered" marker. Once the clarify step has been offered for an
// idea+filter (answered, skipped, or zero questions), don't offer it again in
// this browser session — remounts and navigation must not burn repeated
// clarify calls. Session-scoped on purpose: a fresh session may ask once more
// (skippable, and previous answers are passed so nothing repeats verbatim).
// ---------------------------------------------------------------------------
function clarifyAskedKey(ideaId: string, filter: string): string {
  return `clarify-asked:${ideaId}:${filter}`;
}

export function markClarifyAsked(ideaId: string, filter: string): void {
  try {
    sessionStorage.setItem(clarifyAskedKey(ideaId, filter), "1");
  } catch {
    // Storage unavailable — worst case the question round is offered again.
  }
}

export function wasClarifyAsked(ideaId: string, filter: string): boolean {
  try {
    return sessionStorage.getItem(clarifyAskedKey(ideaId, filter)) === "1";
  } catch {
    return false;
  }
}

/** State + handlers for a set of clarify questions. */
export function useClarifyAnswers(questions: ClarifyQuestion[]) {
  const [answers, setAnswers] = useState<ClarifyAnswer[]>(() =>
    emptyAnswersFor(questions),
  );

  function reset(next: ClarifyQuestion[]) {
    setAnswers(emptyAnswersFor(next));
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

  return { answers, reset, patchAnswer, toggleChoice };
}

/** The stacked multi-select question rows (accent-aware per filter). */
export function ClarifyQuestionList({
  questions,
  answers,
  onToggleChoice,
  onPatchAnswer,
  accent = "teal",
}: {
  questions: ClarifyQuestion[];
  answers: ClarifyAnswer[];
  onToggleChoice: (i: number, opt: string) => void;
  onPatchAnswer: (i: number, patch: Partial<ClarifyAnswer>) => void;
  accent?: "teal" | "amber" | "violet";
}) {
  const ring =
    accent === "amber"
      ? "focus-visible:ring-amber-500"
      : accent === "violet"
        ? "focus-visible:ring-violet-500"
        : "focus-visible:ring-teal-600";
  const sel =
    accent === "amber"
      ? "border-amber-500 bg-amber-50 text-amber-900 ring-1 ring-amber-500"
      : accent === "violet"
        ? "border-violet-500 bg-violet-50 text-violet-900 ring-1 ring-violet-500"
        : "border-teal-600 bg-teal-50 text-teal-900 ring-1 ring-teal-600";
  const hover =
    accent === "amber"
      ? "hover:border-amber-500 hover:bg-amber-50/40"
      : accent === "violet"
        ? "hover:border-violet-500 hover:bg-violet-50/40"
        : "hover:border-teal-500 hover:bg-teal-50/40";
  const check =
    accent === "amber"
      ? "border-amber-500 bg-amber-500"
      : accent === "violet"
        ? "border-violet-500 bg-violet-500"
        : "border-teal-600 bg-teal-600";
  const rowBase = `w-full rounded-lg border px-3 py-2 text-left text-xs leading-relaxed transition-colors focus:outline-none focus-visible:ring-2 ${ring}`;

  return (
    <div className="space-y-4">
      {questions.map((q, i) => {
        const a = answers[i] ?? { choices: [], custom: "", showCustom: true };
        return (
          <div key={i}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <p className="text-sm font-medium text-zinc-800">{q.question}</p>
              {a.choices.length > 2 ? (
                <span role="alert" className="text-xs font-medium text-red-600">
                  Best to pick 1–2 — a focused answer sharpens the analysis.
                </span>
              ) : null}
            </div>
            <div className="mt-1.5 space-y-1.5" role="group" aria-label={q.question}>
              {q.options.map((opt) => {
                const selected = a.choices.includes(opt);
                return (
                  <button
                    key={opt}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onToggleChoice(i, opt)}
                    className={`${rowBase} ${
                      selected
                        ? sel
                        : `border-zinc-200 bg-white text-zinc-700 ${hover}`
                    }`}
                  >
                    <span className="flex items-start gap-2">
                      <span
                        aria-hidden
                        className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                          selected ? `${check} text-white` : "border-zinc-300 bg-white"
                        }`}
                      >
                        {selected ? (
                          <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="none" aria-hidden>
                            <path
                              d="M3 8.5 6.5 12 13 4.5"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        ) : null}
                      </span>
                      <span>{opt}</span>
                    </span>
                  </button>
                );
              })}
              {q.options.length > 0 ? (
                <button
                  type="button"
                  aria-pressed={a.showCustom}
                  onClick={() => onPatchAnswer(i, { showCustom: !a.showCustom })}
                  className={`${rowBase} ${
                    a.showCustom
                      ? `${sel} font-medium`
                      : `border-dashed border-zinc-300 bg-white text-zinc-500 ${hover}`
                  }`}
                >
                  Other — add your own answer…
                </button>
              ) : null}
            </div>
            {a.showCustom ? (
              <input
                type="text"
                autoFocus={q.options.length > 0}
                value={a.custom}
                onChange={(e) => onPatchAnswer(i, { custom: e.target.value })}
                placeholder="Type your answer…"
                aria-label={`Your answer: ${q.question}`}
                className="mt-1.5 w-full rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
