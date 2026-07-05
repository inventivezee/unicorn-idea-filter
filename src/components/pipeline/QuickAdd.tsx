"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getAnonKey } from "@/lib/anon";
import { AutoSavedFlag, Button } from "@/components/ui";
import {
  ClarifyQuestionList,
  composeClarifications,
  emptyAnswersFor,
  markClarifyAsked,
  normalizeClarifyQuestions,
  type ClarifyAnswer,
} from "@/components/clarify/ClarifyForm";
import { useStore } from "@/lib/store";
import type { ClarifyQuestion } from "@/lib/types";

type Stage = "draft" | "clarify";
/** "analyze" = full scoring after add; "add" = name + metadata + description only. */
type AddMode = "analyze" | "add";

export function QuickAdd() {
  const { state, addIdea, updateSettings, cloud, hydrated } = useStore();
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

  // -------------------------------------------------------------------------
  // Cloud drafts: unfinished Quick Adds autosave server-side so they can be
  // resumed later (any device) — and are visible to the admin. Local-only
  // deployments skip this (nothing to sync to).
  // -------------------------------------------------------------------------
  interface IdeaDraftRow {
    id: string;
    updated_at: string;
    payload: {
      description?: string;
      stage?: Stage;
      mode?: AddMode;
      filterKey?: string;
      questions?: ClarifyQuestion[];
      answers?: ClarifyAnswer[];
    };
  }
  const [ideaDrafts, setIdeaDrafts] = useState<IdeaDraftRow[]>([]);
  const draftRowIdRef = useRef<string | null>(null);
  const draftDirtyRef = useRef(false);
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftsLoadedRef = useRef(false);

  // Inline founder-background capture (revealed when analysis is attempted
  // without a background set).
  const [showBgField, setShowBgField] = useState(false);
  const bgRef = useRef<HTMLDivElement>(null);
  const bgTextareaRef = useRef<HTMLTextAreaElement>(null);

  const settings = state.settings;
  const activeSpec =
    settings.filterMode === "custom"
      ? settings.customFilters.find(
          (f) => f.id === settings.activeCustomFilterId,
        )
      : undefined;
  // The instrument key the clarify questions were fetched under (the global
  // toggle can change while the wizard is open), and whether the step ran —
  // used to tag answers correctly and to not re-ask right after the add.
  const filterKey = activeSpec
    ? `custom:${activeSpec.id}`
    : settings.filterMode === "custom"
      ? "unicorn"
      : settings.filterMode;
  const clarifyFilterRef = useRef(filterKey);
  const clarifyRanRef = useRef(false);
  const hasBackground = settings.founderBackground.trim().length > 0;
  const teamPayload = settings.coFounders
    .filter((c) => c.background.trim())
    .map((c) => ({ name: c.name, background: c.background }));

  useEffect(() => {
    if (!cloud || !hydrated || draftsLoadedRef.current) return;
    draftsLoadedRef.current = true;
    void (async () => {
      try {
        const res = await fetch(
          `/api/drafts?kind=idea&anon_key=${encodeURIComponent(getAnonKey())}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as { drafts?: IdeaDraftRow[] };
        setIdeaDrafts(
          (data.drafts ?? []).filter((d) => d.payload?.description?.trim()),
        );
      } catch {
        // Draft listing is best-effort.
      }
    })();
  }, [cloud, hydrated]);

  function markDraftDirty() {
    if (!cloud) return;
    draftDirtyRef.current = true;
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = setTimeout(() => void flushDraftSave(), 1500);
  }

  const wizardRef = useRef({ draft, stage, mode, questions, answers });
  wizardRef.current = { draft, stage, mode, questions, answers };
  // Saves run through one promise chain so two debounced flushes can never
  // both see "no row yet" and double-create.
  const draftFlushChainRef = useRef<Promise<void>>(Promise.resolve());
  const wizardDoneRef = useRef(false);

  function flushDraftSave(): Promise<void> {
    const run = async () => {
      if (
        !draftDirtyRef.current ||
        submittingRef.current ||
        wizardDoneRef.current
      ) {
        return;
      }
      draftDirtyRef.current = false;
      const w = wizardRef.current;
      const text = w.draft.trim();
      if (!text) return; // nothing worth keeping
      const payload = {
        description: w.draft,
        stage: w.stage,
        mode: w.mode,
        filterKey: clarifyFilterRef.current,
        questions: w.questions,
        answers: w.answers,
      };
      try {
        if (draftRowIdRef.current) {
          const res = await fetch(`/api/drafts/${draftRowIdRef.current}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ payload, anonKey: getAnonKey() }),
          });
          if (res.ok) return;
          if (res.status === 404) {
            draftRowIdRef.current = null; // deleted elsewhere — recreate
          } else {
            draftDirtyRef.current = true; // real failure — retry later
            return;
          }
        }
        const res = await fetch("/api/drafts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "idea",
            payload,
            anonKey: getAnonKey(),
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { draft?: { id?: string } };
          if (data.draft?.id) draftRowIdRef.current = data.draft.id;
        } else {
          draftDirtyRef.current = true;
        }
      } catch {
        draftDirtyRef.current = true; // retry on the next edit
      }
    };
    const next = draftFlushChainRef.current.then(run, run);
    draftFlushChainRef.current = next;
    return next;
  }

  /** The wizard finished (idea added) — the draft row is no longer needed.
   *  Chained after any in-flight save so a row created mid-flight is still
   *  found and deleted. */
  function clearDraftRow() {
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    draftDirtyRef.current = false;
    wizardDoneRef.current = true;
    void draftFlushChainRef.current.finally(() => {
      const id = draftRowIdRef.current;
      if (!id) return;
      draftRowIdRef.current = null;
      // keepalive lets the DELETE survive the navigation to the new idea.
      void fetch(
        `/api/drafts/${id}?anon_key=${encodeURIComponent(getAnonKey())}`,
        { method: "DELETE", keepalive: true },
      ).catch(() => {});
    });
  }

  function resumeDraft(row: IdeaDraftRow) {
    const p = row.payload ?? {};
    draftRowIdRef.current = row.id;
    setDraft(p.description ?? "");
    setMode(p.mode === "add" ? "add" : "analyze");
    if (p.filterKey) clarifyFilterRef.current = p.filterKey;
    const qs = normalizeClarifyQuestions(p.questions);
    if (p.stage === "clarify" && qs.length) {
      setQuestions(qs);
      const restored = emptyAnswersFor(qs).map((empty, i) => {
        const saved = Array.isArray(p.answers) ? p.answers[i] : undefined;
        if (!saved || typeof saved !== "object") return empty;
        const custom = typeof saved.custom === "string" ? saved.custom : "";
        return {
          ...empty,
          choices: Array.isArray(saved.choices)
            ? saved.choices.filter((c): c is string => typeof c === "string")
            : [],
          custom,
          showCustom: saved.showCustom === true || custom.trim() !== "",
        };
      });
      setAnswers(restored);
      clarifyRanRef.current = true;
      setStage("clarify");
    } else {
      setStage("draft");
    }
    setIdeaDrafts((all) => all.filter((d) => d.id !== row.id));
  }

  function discardDraft(row: IdeaDraftRow) {
    setIdeaDrafts((all) => all.filter((d) => d.id !== row.id));
    if (draftRowIdRef.current === row.id) draftRowIdRef.current = null;
    void fetch(
      `/api/drafts/${row.id}?anon_key=${encodeURIComponent(getAnonKey())}`,
      { method: "DELETE" },
    ).catch(() => {});
  }

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
    clarifyFilterRef.current = filterKey;
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
          filter: activeSpec ? "custom" : settings.filterMode,
          ...(activeSpec ? { customSpec: activeSpec } : {}),
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
      clarifyRanRef.current = true;
      if (normalized.length === 0) {
        // Nothing worth asking — go straight to the add.
        finishAdd(chosenMode, text);
        return;
      }
      setQuestions(normalized);
      setAnswers(emptyAnswersFor(normalized));
      setStage("clarify");
      markDraftDirty();
    } catch {
      setError("Network error while fetching clarifying questions.");
    } finally {
      setLoadingMode(null);
    }
  }

  // The description stays the founder's raw text; the clarifying Q&A is kept
  // as structured, editable clarifications (composeClarifications) that feed
  // the analysis on their own — so it isn't duplicated into the description.
  function composeNotes(): string {
    return draft.trim();
  }

  function patchAnswer(i: number, patch: Partial<ClarifyAnswer>) {
    setAnswers((all) => all.map((a, j) => (j === i ? { ...a, ...patch } : a)));
    markDraftDirty();
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
    markDraftDirty();
  }

  /** Create the idea and hand off: full analysis, metadata-only fill, or nothing. */
  function finishAdd(chosenMode: AddMode | "plain", notes?: string) {
    if (submittingRef.current) return;
    const text = (notes ?? composeNotes()).trim();
    if (!text) return;
    submittingRef.current = true;
    setSubmitting(true);
    const clarifications = composeClarifications(
      questions,
      answers,
      clarifyFilterRef.current,
    );
    const idea = addIdea({
      thesisNotes: text,
      ...(clarifications.length ? { clarifications } : {}),
    });
    // The clarify step already ran for this filter (even if every question
    // was skipped) — the auto-run analysis must not immediately re-ask.
    if (clarifyRanRef.current) {
      markClarifyAsked(idea.id, clarifyFilterRef.current);
    }
    clearDraftRow();
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
        <div className="mt-3">
          <ClarifyQuestionList
            questions={questions}
            answers={answers}
            onToggleChoice={toggleChoice}
            onPatchAnswer={patchAnswer}
            accent={
              activeSpec
                ? "violet"
                : settings.filterMode === "cashcow"
                  ? "amber"
                  : "teal"
            }
          />
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

  const visibleDrafts = ideaDrafts
    .filter((d) => d.id !== draftRowIdRef.current)
    .slice(0, 3);

  return (
    <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-4">
      {visibleDrafts.length > 0 && !draft.trim() ? (
        <div className="mb-3 rounded-lg border border-teal-200 bg-teal-50/60 p-3">
          <p className="text-xs font-semibold text-teal-900">
            You have {visibleDrafts.length === 1 ? "an unfinished idea" : "unfinished ideas"} — pick up where you left off:
          </p>
          <ul className="mt-2 space-y-1.5">
            {visibleDrafts.map((d) => (
              <li key={d.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs text-zinc-700">
                  {(d.payload.description ?? "").trim()}
                </span>
                <span className="tnum shrink-0 text-[10px] text-zinc-400">
                  {d.updated_at.slice(0, 10)}
                </span>
                <Button
                  className="shrink-0 px-2 py-0.5 text-xs!"
                  onClick={() => resumeDraft(d)}
                >
                  Resume
                </Button>
                <button
                  type="button"
                  onClick={() => discardDraft(d)}
                  className="shrink-0 text-xs text-zinc-400 underline-offset-2 hover:text-red-600 hover:underline"
                >
                  Discard
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
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
        onChange={(e) => {
          setDraft(e.target.value);
          markDraftDirty();
        }}
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
