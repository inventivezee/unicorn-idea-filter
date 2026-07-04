"use client";

import { useEffect, useRef, useState } from "react";
import { Button, PageHeader, Section } from "@/components/ui";
import { CRITERIA } from "@/lib/criteria";
import { ANTHROPIC_MODELS, OPENAI_MODELS } from "@/lib/defaults";
import { sumWeights } from "@/lib/engine";
import { extractTextFromFile } from "@/lib/extractText";
import { useStore } from "@/lib/store";
import type { CriterionId, Provider } from "@/lib/types";

const CUSTOM_OPTION = "__custom__";

const PROVIDER_META: Record<
  Provider,
  { label: string; envVar: string; models: { id: string; label: string }[] }
> = {
  anthropic: {
    label: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    models: ANTHROPIC_MODELS,
  },
  openai: { label: "OpenAI", envVar: "OPENAI_API_KEY", models: OPENAI_MODELS },
};

interface Health {
  anthropic: boolean;
  openai: boolean;
}

const inputClass =
  "h-8 rounded border border-zinc-300 bg-white px-2 text-sm text-zinc-900 focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600";

export default function SettingsPage() {
  const { state, hydrated, updateSettings, resetWeights, exportJSON, importJSON } =
    useStore();
  const settings = state.settings;

  // --- Founder background ---
  const cvInputRef = useRef<HTMLInputElement>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extractSuccess, setExtractSuccess] = useState<string | null>(null);

  async function handleCvFile(file: File) {
    setExtractError(null);
    setExtractSuccess(null);
    if (
      settings.founderBackground.trim() !== "" &&
      !window.confirm(
        "Replace your existing founder background with the extracted text?",
      )
    ) {
      return;
    }
    setExtracting(true);
    try {
      const text = await extractTextFromFile(file);
      updateSettings({ founderBackground: text });
      setExtractSuccess(
        `Extracted ${text.length.toLocaleString()} characters from ${file.name}`,
      );
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : String(err));
    } finally {
      setExtracting(false);
    }
  }

  // --- AI provider & model ---
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((data: Health) => {
        if (!cancelled) {
          setHealth({
            anthropic: Boolean(data.anthropic),
            openai: Boolean(data.openai),
          });
        }
      })
      .catch(() => {
        if (!cancelled) setHealth({ anthropic: false, openai: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const provider = settings.provider;
  const providerMeta = PROVIDER_META[provider];
  const currentModel = settings.models[provider];
  const modelIsListed = providerMeta.models.some((m) => m.id === currentModel);
  const [customModelMode, setCustomModelMode] = useState(false);
  const showCustomInput = customModelMode || !modelIsListed;

  function setModel(value: string) {
    updateSettings({
      models: { ...state.settings.models, [provider]: value },
    });
  }

  // --- Weights ---
  const weightSum = sumWeights(settings.weights);

  function setWeight(id: CriterionId, rawValue: number) {
    const value = Number.isNaN(rawValue) ? 0 : Math.max(0, rawValue);
    updateSettings({ weights: { ...state.settings.weights, [id]: value } });
  }

  // --- Data ---
  const importInputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);

  function handleExport() {
    const blob = new Blob([exportJSON()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "unicorn-idea-filter-backup.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImportFile(file: File) {
    setImportError(null);
    setImportSuccess(false);
    const text = await file.text();
    if (
      !window.confirm(
        "Importing replaces ALL current ideas and settings. Continue?",
      )
    ) {
      return;
    }
    try {
      importJSON(text);
      setImportSuccess(true);
    } catch {
      setImportError("That file isn't a valid backup.");
    }
  }

  if (!hydrated) return null;

  return (
    <>
      <PageHeader
        title="Settings"
        description="Founder background, AI provider, criteria weights, and data."
      />
      <div className="space-y-6">
        {/* 1. Founder background */}
        <Section
          title="Founder background"
          description="Used by the AI to judge founder–market fit, unfair advantages, and founder-personal gates. Paste it or upload your CV."
        >
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={cvInputRef}
                type="file"
                accept=".pdf,.docx,.txt,.md"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void handleCvFile(file);
                }}
              />
              <Button
                onClick={() => cvInputRef.current?.click()}
                disabled={extracting}
              >
                {extracting ? "Extracting…" : "Upload CV (.pdf / .docx / .txt)"}
              </Button>
              {extractError ? (
                <span className="text-xs text-red-600">{extractError}</span>
              ) : null}
              {extractSuccess ? (
                <span className="text-xs text-teal-700">{extractSuccess}</span>
              ) : null}
            </div>
            <textarea
              rows={10}
              value={settings.founderBackground}
              onChange={(e) =>
                updateSettings({ founderBackground: e.target.value })
              }
              placeholder="Domain expertise, operating history, networks, capital access, distribution, credibility…"
              className="w-full rounded border border-zinc-300 bg-white p-2 font-mono text-xs text-zinc-900 focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
            />
            <div className="text-right text-xs text-zinc-400">
              <span className="tnum">
                {settings.founderBackground.length.toLocaleString()}
              </span>{" "}
              characters
            </div>
          </div>
        </Section>

        {/* 2. AI provider & model */}
        <Section
          title="AI provider & model"
          description="Which model runs the analysis when you press Analyze on an idea."
        >
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              {(Object.keys(PROVIDER_META) as Provider[]).map((p) => {
                const meta = PROVIDER_META[p];
                const selected = provider === p;
                const configured = health === null ? null : health[p];
                return (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => {
                      updateSettings({ provider: p });
                      setCustomModelMode(false);
                    }}
                    className={`min-h-8 rounded-lg border p-3 text-left transition-colors ${
                      selected
                        ? "border-teal-600 bg-teal-50/40 ring-1 ring-teal-600"
                        : "border-zinc-200 bg-white hover:border-zinc-300"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-zinc-900">
                        {meta.label}
                      </span>
                      <span
                        className={`h-3.5 w-3.5 rounded-full border ${
                          selected
                            ? "border-teal-600 bg-teal-600"
                            : "border-zinc-300 bg-white"
                        }`}
                        aria-hidden
                      >
                        {selected ? (
                          <span className="mx-auto mt-[4px] block h-1.5 w-1.5 rounded-full bg-white" />
                        ) : null}
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-start gap-1.5 text-xs">
                      <span
                        className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                          configured === null
                            ? "bg-zinc-300"
                            : configured
                              ? "bg-teal-500"
                              : "bg-amber-500"
                        }`}
                        aria-hidden
                      />
                      {configured === null ? (
                        <span className="text-zinc-400">checking…</span>
                      ) : configured ? (
                        <span className="text-teal-700">Configured</span>
                      ) : (
                        <span className="text-amber-700">
                          Not configured — set {meta.envVar} in the deployment
                          environment
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="model-select"
                className="block text-xs font-medium text-zinc-700"
              >
                Model ({providerMeta.label})
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  id="model-select"
                  value={showCustomInput ? CUSTOM_OPTION : currentModel}
                  onChange={(e) => {
                    if (e.target.value === CUSTOM_OPTION) {
                      setCustomModelMode(true);
                    } else {
                      setCustomModelMode(false);
                      setModel(e.target.value);
                    }
                  }}
                  className={`${inputClass} max-w-full`}
                >
                  {providerMeta.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                  <option value={CUSTOM_OPTION}>Custom model id…</option>
                </select>
                {showCustomInput ? (
                  <input
                    type="text"
                    value={currentModel}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="model id"
                    spellCheck={false}
                    className={`${inputClass} w-64 max-w-full font-mono text-xs`}
                    aria-label="Custom model id"
                  />
                ) : null}
              </div>
              <p className="text-xs text-zinc-500">
                Analysis runs server-side — API keys never reach the browser.
              </p>
            </div>
          </div>
        </Section>

        {/* 3. Criteria weights */}
        <Section
          title="Criteria weights"
          description="Weights normalize automatically, so scoring never breaks — but keeping the sum at 100 keeps them readable."
          actions={
            <Button
              onClick={() => {
                if (window.confirm("Reset all weights to their defaults?")) {
                  resetWeights();
                }
              }}
            >
              Reset to defaults
            </Button>
          }
        >
          <div className="divide-y divide-zinc-100">
            {CRITERIA.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-3 py-1.5"
              >
                <div className="min-w-0">
                  <div className="text-sm text-zinc-700">{c.label}</div>
                  <div className="text-xs text-zinc-400">
                    default <span className="tnum">{c.defaultWeight}</span>
                  </div>
                </div>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={settings.weights[c.id]}
                  onChange={(e) => setWeight(c.id, e.target.valueAsNumber)}
                  className={`${inputClass} tnum w-20 shrink-0 text-right`}
                  aria-label={`Weight for ${c.label}`}
                />
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-end gap-2 border-t border-zinc-100 pt-3 text-sm text-zinc-900">
            <span>
              Sum: <span className="tnum font-semibold">{weightSum}</span>
            </span>
            {weightSum !== 100 ? (
              <span className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                ≠ 100
              </span>
            ) : null}
          </div>
        </Section>

        {/* 4. Stress test */}
        <Section title="Stress test">
          <div className="flex flex-wrap items-center gap-3">
            <label
              htmlFor="trials-input"
              className="text-sm text-zinc-700"
            >
              Trials
            </label>
            <input
              id="trials-input"
              type="number"
              min={1}
              step={50}
              value={settings.trials}
              onChange={(e) => {
                const n = e.target.valueAsNumber;
                updateSettings({
                  trials: Number.isNaN(n) ? 1 : Math.max(1, Math.floor(n)),
                });
              }}
              className={`${inputClass} tnum w-24 text-right`}
            />
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            Perturbation trials for the dashboard&apos;s leader-robustness check
            (weights ±20%, seeded).
          </p>
        </Section>

        {/* 5. Data */}
        <Section
          title="Data"
          description="Everything lives in this browser's localStorage — export regularly."
        >
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={handleExport}>Export JSON</Button>
            <input
              ref={importInputRef}
              type="file"
              accept=".json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void handleImportFile(file);
              }}
            />
            <Button onClick={() => importInputRef.current?.click()}>
              Import JSON
            </Button>
            {importError ? (
              <span className="text-xs text-red-600">{importError}</span>
            ) : null}
            {importSuccess ? (
              <span className="text-xs text-teal-700">Backup imported.</span>
            ) : null}
          </div>
        </Section>
      </div>
    </>
  );
}
