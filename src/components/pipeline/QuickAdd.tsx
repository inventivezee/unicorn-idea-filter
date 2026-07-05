"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getAnonKey } from "@/lib/anon";
import { AutoSavedFlag, Button } from "@/components/ui";
import { useStore } from "@/lib/store";
import type { ClarifyQuestion } from "@/lib/types";

type Stage = "draft" | "clarify";
/** "analyze" = full scoring after add; "add" = name + metadata + description only. */
type AddMode = "analyze" | "add";

/** Per-question answer: any number of picked options, plus optional free text. */
interface ClarifyAnswer {
  choices: string[];
  custom: string;
  showCustom: boolean;
}

/** Coerce the /api/clarify payload into valid ClarifyQuestion[] (dedupes options). */
function normalizeClarifyQuestions(value: unknown): ClarifyQuestion[] {
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

export function QuickAdd() {
  const { state, addIdea, updateSettings } = useStore();
  const router = useRouter();

  const [stage, setStage] = useState<Stage>("draft");
  const [draft, setDraft] = useState("");
  const [questions, setQuestions] = useState<ClarifyQuestion[]>([]);
  const [answers, setAnswers] = useState<ClarifyAnswer[]>([]);
  const [mode, setMode] = useState<AddMode>("analyze");
  const [loadingMode, setLoadingMode] = useState<AddMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One idea per wizard — guards double-clicks across every add path.
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  // Inline founder-background capture (revealed when analysis is attempted
  // without a background set).
  const [showBgField, setShowBgField] = useState(false);
  const bgRef = useRef<HTMLDivElement>(null);
  const bgTextareaRef = useRef<HTMLTextAreaElement>(null);

  const settings = state.settings;
  const hasBackground = settings.founderBackground.trim().length > 0;
  const teamPayload = settings.coFounders
    .filter((c) => c.background.trim())
    .map((c) => ({ name: c.name, background: c.background }));

  /** Reveal the inline background field, scroll to it, and focus it. */
  function revealBackground() {
    setShowBgField(true);
    setError(null);
    requestAnimationFrame(() => {
      bgRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      bgTextareaRef.current?.focus();
    });
  }

  async function startClarify(chosenMode: AddMode) {
    const text = draft.trim();
    if (!text || loadingMode) return;
    // Analysis needs a founder background — capture it inline instead of blocking.
    if (chosenMode === "analyze" && !hasBackground) {
      revealBackground();
      return;
    }
    // Toggle off → skip the clarifying step and add straight away.
    if (!settings.askClarifying) {
      finishAdd(chosenMode, text);
      return;
    }
    setError(null);
    setMode(chosenMode);
    setLoadingMode(chosenMode);
    try {
      const res = await fetch("/api/clarify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: text,
          founderBackground: settings.founderBackground,
          coFounders: teamPayload,
          provider: settings.provider,
          model: settings.models[settings.provider],
          anonKey: getAnonKey(),
        }),
      });
      if (!res.ok) {
        let message = `Couldn't get clarifying questions (HTTP ${res.status}).`;
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
          router.push("/upgrade?reason=premium");
          return;
        }
        setError(message);
        return;
      }
      const data = (await res.json()) as { questions?: unknown };
      // Normalize defensively: tolerate bare strings (an older server bundle)
      // and drop malformed entries, so the render never sees a non-object.
      const normalized = normalizeClarifyQuestions(data.questions);
      if (normalized.length === 0) {
        // Nothing worth asking — go straight to the add.
        finishAdd(chosenMode, text);
        return;
      }
      setQuestions(normalized);
      setAnswers(
        normalized.map((q) => ({
          choices: [],
          custom: "",
          // No options to click → open the text field straight away.
          showCustom: q.options.length === 0,
        })),
      );
      setStage("clarify");
    } catch {
      setError("Network error while fetching clarifying questions.");
    } finally {
      setLoadingMode(null);
    }
  }

  /** Combine picked options + optional free text into one answer string. */
  function answerText(a: ClarifyAnswer | undefined): string {
    if (!a) return "";
    const parts = [...a.choices];
    if (a.showCustom && a.custom.trim()) parts.push(a.custom.trim());
    return parts.join("; ");
  }

  function composeNotes(): string {
    const answered = questions
      .map((q, i) => ({ q: q.question, a: answerText(answers[i]) }))
      .filter((x) => x.a);
    const base = draft.trim();
    if (answered.length === 0) return base;
    return (
      base +
      "\n\nClarifications:\n" +
      answered.map(({ q, a }) => `Q: ${q}\nA: ${a}`).join("\n")
    );
  }

  function patchAnswer(i: number, patch: Partial<ClarifyAnswer>) {
    setAnswers((all) => all.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  }

  /** Toggle one option in/out of a question's multi-select answer. */
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

  /** Structured Q&A to persist with the idea (answered questions only). */
  function composeClarifications() {
    return questions
      .map((q, i) => ({ question: q.question, answer: answerText(answers[i]) }))
      .filter((c) => c.answer);
  }

  /** Create the idea and hand off: full analysis, metadata-only fill, or nothing. */
  function finishAdd(chosenMode: AddMode | "plain", notes?: string) {
    if (submittingRef.current) return;
    const text = (notes ?? composeNotes()).trim();
    if (!text) return;
    submittingRef.current = true;
    setSubmitting(true);
    const clarifications = composeClarifications();
    const idea = addIdea({
      thesisNotes: text,
      ...(clarifications.length ? { clarifications } : {}),
    });
    const param =
      chosenMode === "analyze" ? "?analyze=1" : chosenMode === "add" ? "?fill=1" : "";
    router.push(`/idea/${idea.id}${param}`);
  }

  function handleManualAdd() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const idea = addIdea();
    router.push(`/idea/${idea.id}`);
  }

  function backToDraft() {
    submittingRef.current = false;
    setSubmitting(false);
    setStage("draft");
    setQuestions([]);
    setAnswers([]);
    setError(null);
  }

  const spinner = (
    <span
      aria-hidden
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-200 border-t-teal-600 align-[-2px]"
    />
  );

  /** Inline founder-background capture, shared by both stages. */
  const backgroundField =
    showBgField ? (
      <div
        ref={bgRef}
        className="mt-3 rounded-lg border border-amber-300 bg-amber-50/60 p-3"
      >
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor="inline-founder-bg"
            className="text-sm font-medium text-zinc-900"
          >
            Your founder background{" "}
            {hasBackground ? null : (
              <span className="font-normal text-amber-700">
                — required to analyze
              </span>
            )}
          </label>
          <AutoSavedFlag value={settings.founderBackground} />
        </div>
        <p className="mt-0.5 text-xs text-zinc-600">
          The AI judges founder–market fit and the founder-personal gates from
          this. It&apos;s saved for all your future ideas — refine it any time
          in Settings (you can add co-founders there too).
        </p>
        <textarea
          id="inline-founder-bg"
          ref={bgTextareaRef}
          rows={4}
          value={settings.founderBackground}
          onChange={(e) => updateSettings({ founderBackground: e.target.value })}
          placeholder="Domain expertise, operating history, networks, capital access, distribution, credibility…"
          className="mt-2 w-full rounded border border-zinc-300 bg-white p-2 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
        />
        {hasBackground ? (
          <p className="mt-1.5 text-xs text-teal-700">
            Saved — press “Add &amp; analyze with AI” to continue.
          </p>
        ) : null}
      </div>
    ) : null;

  if (stage === "clarify") {
    return (
      <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-zinc-900">
          A few clarifying questions
        </h2>
        <p className="mt-0.5 text-xs text-zinc-500">
          Pick the answers that apply — you can choose more than one, or add
          your own, though 1–2 focused picks per question work best. All
          optional; skip any you&apos;re not sure about. They sharpen the
          AI&apos;s naming, metadata, and scoring.
        </p>
        <blockquote className="mt-3 max-h-24 overflow-y-auto rounded border border-zinc-100 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
          {draft.trim()}
        </blockquote>
        <div className="mt-3 space-y-4">
          {questions.map((q, i) => {
            const a = answers[i] ?? {
              choices: [],
              custom: "",
              showCustom: true,
            };
            // Stacked, left-aligned rows: detailed options read like short
            // answers, not tags, and wrap cleanly on mobile.
            const rowBase =
              "w-full rounded-lg border px-3 py-2 text-left text-xs leading-relaxed transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600";
            return (
              <div key={i}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <p className="text-sm font-medium text-zinc-800">
                    {q.question}
                  </p>
                  {a.choices.length > 2 ? (
                    <span
                      role="alert"
                      className="text-xs font-medium text-red-600"
                    >
                      Best to pick 1–2 — a focused answer sharpens the
                      analysis.
                    </span>
                  ) : null}
                </div>
                <div
                  className="mt-1.5 space-y-1.5"
                  role="group"
                  aria-label={q.question}
                >
                  {q.options.map((opt) => {
                    const selected = a.choices.includes(opt);
                    return (
                      <button
                        key={opt}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleChoice(i, opt)}
                        className={`${rowBase} ${
                          selected
                            ? "border-teal-600 bg-teal-50 text-teal-900 ring-1 ring-teal-600"
                            : "border-zinc-200 bg-white text-zinc-700 hover:border-teal-500 hover:bg-teal-50/40"
                        }`}
                      >
                        <span className="flex items-start gap-2">
                          <span
                            aria-hidden
                            className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                              selected
                                ? "border-teal-600 bg-teal-600 text-white"
                                : "border-zinc-300 bg-white"
                            }`}
                          >
                            {selected ? (
                              <svg
                                viewBox="0 0 16 16"
                                className="h-2.5 w-2.5"
                                fill="none"
                                aria-hidden
                              >
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
                      onClick={() =>
                        patchAnswer(i, { showCustom: !a.showCustom })
                      }
                      className={`${rowBase} ${
                        a.showCustom
                          ? "border-teal-600 bg-teal-50 font-medium text-teal-900 ring-1 ring-teal-600"
                          : "border-dashed border-zinc-300 bg-white text-zinc-500 hover:border-teal-500 hover:text-teal-700"
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
                    onChange={(e) => patchAnswer(i, { custom: e.target.value })}
                    placeholder="Type your answer…"
                    aria-label={`Your answer: ${q.question}`}
                    className="mt-1.5 w-full rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
                  />
                ) : null}
              </div>
            );
          })}
        </div>
        {/* Only prompt for a background here when it's still missing — once
            filled, the "Add & analyze" button below works directly. */}
        {hasBackground ? null : backgroundField}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            variant={mode === "analyze" ? "primary" : "secondary"}
            onClick={() =>
              hasBackground ? finishAdd("analyze") : revealBackground()
            }
            disabled={submitting}
          >
            Add &amp; analyze with AI
          </Button>
          <Button
            variant={mode === "add" ? "primary" : "secondary"}
            onClick={() => finishAdd("add")}
            disabled={submitting}
          >
            Add only
          </Button>
          <button
            type="button"
            onClick={backToDraft}
            className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline"
          >
            Back to editing
          </button>
        </div>
        <p className="mt-2 text-xs text-zinc-400">
          Add only fills in the name, metadata, and a sharper description —
          scoring waits until you run the analysis yourself.
        </p>
      </div>
    );
  }

  return (
    <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-4">
      <label htmlFor="quick-add" className="text-sm font-semibold text-zinc-900">
        New idea
      </label>
      <p className="mt-0.5 text-xs text-zinc-500">
        Just describe it — the AI{" "}
        {settings.askClarifying ? "asks a few clarifying questions, then " : ""}
        names it and fills in the metadata. Everything stays editable.
      </p>
      <textarea
        id="quick-add"
        rows={3}
        value={draft}
        disabled={loadingMode !== null}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            void startClarify("analyze");
          }
        }}
        placeholder="e.g. A marketplace that lets independent HVAC technicians source scarce repair parts same-day from local distributors…"
        className="mt-3 w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          onClick={() => void startClarify("analyze")}
          disabled={!draft.trim() || loadingMode !== null}
        >
          Add &amp; analyze with AI
        </Button>
        <Button
          variant="secondary"
          onClick={() => void startClarify("add")}
          disabled={!draft.trim() || loadingMode !== null}
        >
          Add only
        </Button>
        {loadingMode ? (
          <span className="flex items-center gap-2 text-xs text-zinc-500">
            {spinner}
            Coming up with clarifying questions…
          </span>
        ) : (
          <button
            type="button"
            onClick={handleManualAdd}
            className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-900 hover:underline"
          >
            or add a blank idea to fill in manually
          </button>
        )}
        <label
          className="ml-auto flex cursor-pointer items-center gap-2 text-xs text-zinc-600"
          title="When on, the AI asks a few clarifying questions before adding — usually sharpens naming and scoring."
        >
          <span>Ask clarifying questions</span>
          <button
            type="button"
            role="switch"
            aria-checked={settings.askClarifying}
            onClick={() =>
              updateSettings({ askClarifying: !settings.askClarifying })
            }
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
              settings.askClarifying ? "bg-teal-600" : "bg-zinc-300"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                settings.askClarifying ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>
        </label>
      </div>
      <p className="mt-2 text-xs text-zinc-400">
        Add only skips the scoring: the AI just names and describes the idea.
      </p>
      {backgroundField}
      {!hasBackground && !showBgField ? (
        <p className="mt-2 text-xs text-zinc-400">
          Analysis needs your founder background — press “Add &amp; analyze
          with AI” and you can add it right here.
        </p>
      ) : null}
      {error ? (
        <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <p>{error}</p>
          <div className="mt-2 flex flex-wrap gap-3">
            {hasBackground ? (
              <button
                type="button"
                onClick={() => finishAdd("analyze", draft.trim())}
                disabled={submitting || !draft.trim()}
                className="font-medium underline underline-offset-2 disabled:opacity-50"
              >
                Add anyway &amp; analyze
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => finishAdd("plain", draft.trim())}
              disabled={submitting || !draft.trim()}
              className="font-medium underline underline-offset-2 disabled:opacity-50"
            >
              Add without AI
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
