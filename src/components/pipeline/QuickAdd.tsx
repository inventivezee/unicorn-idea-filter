"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getAnonKey } from "@/lib/anon";
import { Button } from "@/components/ui";
import { useStore } from "@/lib/store";
import type { ClarifyResponse } from "@/lib/types";

type Stage = "draft" | "clarify";
/** "analyze" = full scoring after add; "add" = name + metadata + description only. */
type AddMode = "analyze" | "add";

export function QuickAdd() {
  const { state, addIdea, updateSettings } = useStore();
  const router = useRouter();

  const [stage, setStage] = useState<Stage>("draft");
  const [draft, setDraft] = useState("");
  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [mode, setMode] = useState<AddMode>("analyze");
  const [loadingMode, setLoadingMode] = useState<AddMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One idea per wizard — guards double-clicks across every add path.
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  const settings = state.settings;
  const hasBackground = settings.founderBackground.trim().length > 0;
  const teamPayload = settings.coFounders
    .filter((c) => c.background.trim())
    .map((c) => ({ name: c.name, background: c.background }));

  async function startClarify(chosenMode: AddMode) {
    const text = draft.trim();
    if (!text || loadingMode) return;
    if (chosenMode === "analyze" && !hasBackground) return;
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
      const data = (await res.json()) as ClarifyResponse;
      if (!Array.isArray(data.questions) || data.questions.length === 0) {
        // Nothing worth asking — go straight to the add.
        finishAdd(chosenMode, text);
        return;
      }
      setQuestions(data.questions);
      setAnswers(data.questions.map(() => ""));
      setStage("clarify");
    } catch {
      setError("Network error while fetching clarifying questions.");
    } finally {
      setLoadingMode(null);
    }
  }

  function composeNotes(): string {
    const answered = questions
      .map((q, i) => ({ q, a: (answers[i] ?? "").trim() }))
      .filter((x) => x.a);
    const base = draft.trim();
    if (answered.length === 0) return base;
    return (
      base +
      "\n\nClarifications:\n" +
      answered.map(({ q, a }) => `Q: ${q}\nA: ${a}`).join("\n")
    );
  }

  /** Create the idea and hand off: full analysis, metadata-only fill, or nothing. */
  function finishAdd(chosenMode: AddMode | "plain", notes?: string) {
    if (submittingRef.current) return;
    const text = (notes ?? composeNotes()).trim();
    if (!text) return;
    submittingRef.current = true;
    setSubmitting(true);
    const idea = addIdea({ thesisNotes: text });
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

  if (stage === "clarify") {
    return (
      <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-zinc-900">
          A few clarifying questions
        </h2>
        <p className="mt-0.5 text-xs text-zinc-500">
          Answers are optional — skip any you're not sure about. They sharpen
          the AI's naming, metadata, and scoring.
        </p>
        <blockquote className="mt-3 max-h-24 overflow-y-auto rounded border border-zinc-100 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
          {draft.trim()}
        </blockquote>
        <div className="mt-3 space-y-3">
          {questions.map((q, i) => (
            <div key={i}>
              <label
                htmlFor={`clarify-${i}`}
                className="block text-sm text-zinc-800"
              >
                {q}
              </label>
              <textarea
                id={`clarify-${i}`}
                rows={2}
                value={answers[i] ?? ""}
                onChange={(e) =>
                  setAnswers((a) =>
                    a.map((v, j) => (j === i ? e.target.value : v)),
                  )
                }
                className="mt-1 w-full rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
              />
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            variant={mode === "analyze" ? "primary" : "secondary"}
            onClick={() => finishAdd("analyze")}
            disabled={!hasBackground || submitting}
            title={
              hasBackground
                ? undefined
                : "Add your founder background in Settings first"
            }
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
          disabled={!draft.trim() || loadingMode !== null || !hasBackground}
          title={
            hasBackground
              ? undefined
              : "Add your founder background in Settings first"
          }
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
      {!hasBackground ? (
        <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Analysis needs your founder background — add it in Settings first.
          Add only works without it.
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
