"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { CONFIDENCE_OPTIONS } from "@/lib/criteria";
import { SUBSCRIPTION_PRICE_LABEL } from "@/lib/entitlements";
import { useStore } from "@/lib/store";
import { Button, EmptyState, Section } from "@/components/ui";
import { AIPanel } from "@/components/idea/AIPanel";
import { ClarificationsEditor } from "@/components/idea/ClarificationsEditor";
import { ComputedPanel } from "@/components/idea/ComputedPanel";
import { CriteriaSection } from "@/components/idea/CriteriaSection";
import { GatesSection } from "@/components/idea/GatesSection";
import { CcAIPanel } from "@/components/cashcow/CcAIPanel";
import {
  CcComputedPanel,
  CcConfidenceSection,
  CcCriteriaSection,
  CcGatesSection,
  CcValidationSection,
  makeCcPatch,
} from "@/components/cashcow/CcSections";
import type { Idea } from "@/lib/types";

const inputCls =
  "h-8 w-full rounded border border-zinc-300 bg-white px-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500";
const textareaCls =
  "w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-500">
        {label}
      </span>
      <input
        className={inputCls}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

export default function IdeaDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const {
    state,
    hydrated,
    cloud,
    entitlements,
    updateIdea,
    deleteIdea,
    setIdeaPrivacy,
  } = useStore();

  // Privacy control (cloud mode only).
  const [privacyBusy, setPrivacyBusy] = useState(false);
  const [privacyError, setPrivacyError] = useState<string | null>(null);
  const [privacyUpsell, setPrivacyUpsell] = useState(false);

  if (!hydrated) return null;

  const idea = state.ideas.find((i) => i.id === id);
  if (!idea) {
    return (
      <EmptyState>
        <p>Idea not found — it may have been deleted.</p>
        <Link
          href="/"
          className="mt-2 inline-block font-medium text-teal-700 underline"
        >
          Back to pipeline
        </Link>
      </EmptyState>
    );
  }

  const weights = state.settings.weights;
  const cashcowMode = state.settings.filterMode === "cashcow";
  const patch = (p: Partial<Idea> | ((latest: Idea) => Partial<Idea>)) =>
    updateIdea(idea.id, p);
  const ccPatch = makeCcPatch(patch);

  function handleDelete() {
    if (!idea) return;
    if (window.confirm(`Delete "${idea.name || "this idea"}"? This cannot be undone.`)) {
      deleteIdea(idea.id);
      router.push("/");
    }
  }

  async function handlePrivacyToggle() {
    if (!idea) return;
    setPrivacyError(null);
    const makePrivate = !idea.isPrivate;
    if (makePrivate && !entitlements.subscribed && !entitlements.isAdmin) {
      setPrivacyUpsell(true);
      return;
    }
    setPrivacyUpsell(false);
    setPrivacyBusy(true);
    const err = await setIdeaPrivacy(idea.id, makePrivate);
    setPrivacyBusy(false);
    setPrivacyError(err);
  }

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-start justify-between gap-3">
          <input
            value={idea.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="Idea name"
            aria-label="Idea name"
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-xl font-semibold tracking-tight text-zinc-900 placeholder:text-zinc-300 focus:outline-none"
          />
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {cloud ? (
              <>
                <span
                  className={`inline-block whitespace-nowrap rounded border px-2 py-0.5 text-xs font-medium ${
                    idea.isPrivate
                      ? "border-teal-200 bg-teal-50 text-teal-700"
                      : "border-zinc-200 bg-zinc-50 text-zinc-500"
                  }`}
                >
                  {idea.isPrivate
                    ? "Private"
                    : cashcowMode
                      ? "Public once scored in the Unicorn filter"
                      : "Public once scored"}
                </span>
                <Button
                  className="px-2 py-1 text-xs!"
                  onClick={() => void handlePrivacyToggle()}
                  disabled={privacyBusy}
                >
                  {privacyBusy
                    ? "Saving…"
                    : idea.isPrivate
                      ? "Make public"
                      : "Make private"}
                </Button>
              </>
            ) : null}
            <Button variant="danger" onClick={handleDelete}>
              Delete
            </Button>
          </div>
        </div>
        <p className="mt-1 text-xs text-zinc-400">
          Created {fmtDate(idea.createdAt)} · Updated {fmtDate(idea.updatedAt)}
          {cloud && idea.published && !idea.isPrivate ? (
            <>
              {" · "}
              <Link
                href={`/i/${idea.id}`}
                className="text-[10px] text-zinc-400 underline hover:text-zinc-600"
              >
                In the public database
              </Link>
            </>
          ) : null}
        </p>
        {cloud && privacyUpsell ? (
          <p className="mt-1 text-xs text-zinc-600">
            Private ideas are a subscriber feature —{" "}
            <Link
              href="/settings"
              className="font-medium text-teal-700 underline"
            >
              upgrade for {SUBSCRIPTION_PRICE_LABEL}
            </Link>
            .
          </p>
        ) : null}
        {cloud && privacyError ? (
          <p className="mt-1 text-xs text-red-600">{privacyError}</p>
        ) : null}
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          <Section title="Metadata">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Domain"
                value={idea.domain}
                onChange={(v) => patch({ domain: v })}
                placeholder="e.g. AI, fintech, healthcare"
              />
              <Field
                label="Business model"
                value={idea.businessModel}
                onChange={(v) => patch({ businessModel: v })}
                placeholder="e.g. SaaS, marketplace"
              />
              <Field
                label="Buyer / ICP"
                value={idea.buyerICP}
                onChange={(v) => patch({ buyerICP: v })}
                placeholder="Who signs the check"
              />
              <Field
                label="Initial wedge"
                value={idea.initialWedge}
                onChange={(v) => patch({ initialWedge: v })}
                placeholder="First narrow entry point"
              />
            </div>
            {cloud ? (
              <label className="mt-3 block">
                <span className="mb-1 block text-xs font-medium text-zinc-500">
                  Public founder profile (anonymised)
                </span>
                <textarea
                  className={textareaCls}
                  rows={2}
                  value={idea.founderProfile ?? ""}
                  onChange={(e) => patch({ founderProfile: e.target.value })}
                  placeholder="Written by the AI from your background without identifying details — shown publicly next to this idea once scored."
                />
                <span className="mt-0.5 block text-[10px] text-zinc-400">
                  Your full founder background is never public; only this
                  anonymised profile appears with the idea.
                </span>
              </label>
            ) : null}
            <label className="mt-3 block">
              <span className="mb-1 block text-xs font-medium text-zinc-500">
                Thesis / description
              </span>
              <textarea
                rows={5}
                className={textareaCls}
                value={idea.thesisNotes}
                onChange={(e) => patch({ thesisNotes: e.target.value })}
                placeholder="The core insight, why it wins, and why now."
              />
            </label>
            <ClarificationsEditor
              idea={idea}
              onPatch={patch}
              activeFilter={cashcowMode ? "cashcow" : "unicorn"}
            />
          </Section>

          {cashcowMode ? (
            <>
              <CcAIPanel
                idea={idea}
                settings={state.settings}
                onPatch={patch}
              />
              <CcGatesSection idea={idea} ccPatch={ccPatch} />
              <CcCriteriaSection idea={idea} ccPatch={ccPatch} />
              <CcConfidenceSection idea={idea} ccPatch={ccPatch} />
              <CcValidationSection idea={idea} ccPatch={ccPatch} />
            </>
          ) : (
            <>
          <AIPanel idea={idea} settings={state.settings} onPatch={patch} />

          <GatesSection idea={idea} onPatch={patch} />

          <CriteriaSection idea={idea} weights={weights} onPatch={patch} />

          <Section
            title="Confidence"
            description="Multiplies the raw score — how much evidence backs these numbers."
          >
            <div className="grid gap-2 sm:grid-cols-3">
              {CONFIDENCE_OPTIONS.map((opt) => {
                const active = idea.confidence === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      patch({ confidence: active ? null : opt.value })
                    }
                    className={`min-h-8 rounded border px-3 py-2 text-left transition-colors ${
                      active
                        ? "border-teal-600 bg-teal-600 text-white"
                        : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
                    }`}
                  >
                    <span className="tnum block text-sm font-semibold">
                      {opt.label}
                    </span>
                    <span
                      className={`block text-xs ${
                        active ? "text-teal-100" : "text-zinc-500"
                      }`}
                    >
                      {opt.description}
                    </span>
                  </button>
                );
              })}
            </div>
            {idea.ai?.confidenceRationale ? (
              <p className="mt-2 text-xs italic text-zinc-600">
                AI: {idea.ai.confidenceRationale}
              </p>
            ) : null}
          </Section>

          <Section title="30-day validation test">
            <textarea
              rows={4}
              className={textareaCls}
              value={idea.validationTest30d}
              onChange={(e) => patch({ validationTest30d: e.target.value })}
              placeholder="The single cheapest test that attacks the biggest risk in the next 30 days — with a numeric pass/fail bar."
            />
          </Section>
            </>
          )}
        </div>

        <aside className="min-w-0 self-start lg:sticky lg:top-16">
          {cashcowMode ? (
            <CcComputedPanel idea={idea} />
          ) : (
            <ComputedPanel idea={idea} weights={weights} onPatch={patch} />
          )}
        </aside>
      </div>
    </div>
  );
}
