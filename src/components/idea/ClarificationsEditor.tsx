"use client";

// Editable clarifying Q&A for an idea. The answers are gathered at add-time
// but stay editable here — they feed the AI analysis (both filters) as direct
// founder input and are saved with the idea. Shared across both instruments.
import type { Clarification, FilterMode, Idea } from "@/lib/types";

const answerCls =
  "mt-1 w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500";

export function ClarificationsEditor({
  idea,
  onPatch,
  activeFilter = "unicorn",
}: {
  idea: Idea;
  onPatch: (patch: Partial<Idea>) => void;
  /** Manually added rows are tagged for this filter. */
  activeFilter?: FilterMode;
}) {
  const clarifications: Clarification[] = idea.clarifications ?? [];

  function setAll(next: Clarification[]) {
    onPatch({ clarifications: next });
  }
  function setItem(i: number, patch: Partial<Clarification>) {
    setAll(clarifications.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  }
  function remove(i: number) {
    setAll(clarifications.filter((_, j) => j !== i));
  }
  function add() {
    setAll([
      ...clarifications,
      { question: "", answer: "", filter: activeFilter },
    ]);
  }

  return (
    <div className="mt-4">
      <span className="mb-1.5 block text-xs font-medium text-zinc-500">
        Clarifying answers
      </span>
      {clarifications.length > 0 ? (
        <div className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50/60 p-3">
          {clarifications.map((c, i) => (
            <div key={i}>
              <div className="flex items-start gap-2">
                <input
                  value={c.question}
                  onChange={(e) => setItem(i, { question: e.target.value })}
                  placeholder="Question"
                  aria-label={`Clarifying question ${i + 1}`}
                  className="min-w-0 flex-1 border-0 bg-transparent p-0 text-xs font-medium text-zinc-700 placeholder:text-zinc-400 focus:outline-none"
                />
                <span
                  className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide ${
                    (c.filter ?? "unicorn") === "cashcow"
                      ? "bg-amber-100 text-amber-700"
                      : "bg-teal-100 text-teal-700"
                  }`}
                  title="Which filter asked this question"
                >
                  {(c.filter ?? "unicorn") === "cashcow" ? "Cash Cow" : "Unicorn"}
                </span>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  aria-label="Remove this clarification"
                  className="shrink-0 rounded px-1 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-700"
                >
                  ✕
                </button>
              </div>
              <textarea
                rows={2}
                value={c.answer}
                onChange={(e) => setItem(i, { answer: e.target.value })}
                placeholder="Your answer…"
                aria-label={`Answer ${i + 1}`}
                className={answerCls}
              />
            </div>
          ))}
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={add}
          className="text-xs font-medium text-teal-700 underline-offset-2 hover:underline"
        >
          + Add a clarification
        </button>
        <span className="text-[10px] text-zinc-400">
          Edited answers feed the next AI analysis. Not shown publicly.
        </span>
      </div>
    </div>
  );
}
