"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button, PageHeader, Section } from "@/components/ui";
import { CRITERIA } from "@/lib/criteria";
import { ANTHROPIC_MODELS, generateId, OPENAI_MODELS } from "@/lib/defaults";
import { sumWeights } from "@/lib/engine";
import {
  FREE_ANALYSES_PER_MONTH,
  PREMIUM_MODELS,
  SUBSCRIPTION_PRICE_LABEL,
} from "@/lib/entitlements";
import { extractTextFromFile } from "@/lib/extractText";
import { useStore } from "@/lib/store";
import type { CoFounder, CriterionId, Provider } from "@/lib/types";

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

/** Parse the API error shape { error: string }, falling back gracefully. */
async function readApiError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (body && typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Non-JSON body.
  }
  return fallback;
}

export default function SettingsPage() {
  const {
    state,
    hydrated,
    cloud,
    entitlements,
    refreshEntitlements,
    signOut,
    updateSettings,
    resetWeights,
    exportJSON,
    importJSON,
  } = useStore();
  const settings = state.settings;
  const router = useRouter();

  // --- Account ---
  const [displayName, setDisplayName] = useState(entitlements.displayName);
  const [showHandle, setShowHandle] = useState(entitlements.showHandle);
  const [accountError, setAccountError] = useState<string | null>(null);
  useEffect(() => {
    setDisplayName(entitlements.displayName);
  }, [entitlements.displayName]);
  useEffect(() => {
    setShowHandle(entitlements.showHandle);
  }, [entitlements.showHandle]);

  async function patchProfile(body: Record<string, unknown>) {
    setAccountError(null);
    try {
      const res = await fetch("/api/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setAccountError(await readApiError(res, "Couldn't save that change."));
        return;
      }
      await refreshEntitlements();
    } catch (e) {
      setAccountError(
        e instanceof Error ? e.message : "Couldn't save that change.",
      );
    }
  }

  // --- Subscription ---
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [upgradeWelcome, setUpgradeWelcome] = useState(false);

  useEffect(() => {
    if (!cloud) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("upgraded") === "1") {
      setUpgradeWelcome(true);
      void refreshEntitlements();
      // Strip the flag so a reload doesn't repeat the welcome note.
      params.delete("upgraded");
      const qs = params.toString();
      window.history.replaceState(
        null,
        "",
        window.location.pathname + (qs ? `?${qs}` : ""),
      );
    }
  }, [cloud, refreshEntitlements]);

  async function openBilling(endpoint: string) {
    setBillingError(null);
    setBillingBusy(true);
    try {
      const res = await fetch(endpoint, { method: "POST" });
      if (!res.ok) {
        setBillingError(
          await readApiError(res, "Something went wrong — try again."),
        );
        return;
      }
      const data = (await res.json()) as { url?: string };
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      setBillingError("No redirect URL returned — try again.");
    } catch (e) {
      setBillingError(
        e instanceof Error ? e.message : "Something went wrong — try again.",
      );
    } finally {
      setBillingBusy(false);
    }
  }

  function handleUpgrade() {
    if (!entitlements.signedIn) {
      router.push("/signin");
      return;
    }
    void openBilling("/api/stripe/checkout");
  }

  // --- Founding team ---
  const cvInputRef = useRef<HTMLInputElement>(null);
  // Which founder the next CV upload belongs to: "primary" or a co-founder id.
  const uploadTargetRef = useRef<string>("primary");
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extractSuccess, setExtractSuccess] = useState<string | null>(null);

  function uploadCvFor(target: string) {
    uploadTargetRef.current = target;
    cvInputRef.current?.click();
  }

  function setCoFounder(id: string, patch: Partial<CoFounder>) {
    updateSettings({
      coFounders: state.settings.coFounders.map((c) =>
        c.id === id ? { ...c, ...patch } : c,
      ),
    });
  }

  function addCoFounder() {
    updateSettings({
      coFounders: [
        ...state.settings.coFounders,
        { id: generateId("founder"), name: "", background: "" },
      ],
    });
  }

  function removeCoFounder(id: string) {
    const target = state.settings.coFounders.find((c) => c.id === id);
    if (
      target?.background.trim() &&
      !window.confirm("Remove this co-founder and their background?")
    ) {
      return;
    }
    updateSettings({
      coFounders: state.settings.coFounders.filter((c) => c.id !== id),
    });
  }

  async function handleCvFile(file: File) {
    setExtractError(null);
    setExtractSuccess(null);
    const target = uploadTargetRef.current;
    const existing =
      target === "primary"
        ? settings.founderBackground
        : (settings.coFounders.find((c) => c.id === target)?.background ?? "");
    if (
      existing.trim() !== "" &&
      !window.confirm(
        "Replace this founder's existing background with the extracted text?",
      )
    ) {
      return;
    }
    setExtracting(true);
    try {
      const text = await extractTextFromFile(file);
      if (target === "primary") {
        updateSettings({ founderBackground: text });
      } else {
        setCoFounder(target, { background: text });
      }
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
    let text: string;
    try {
      text = await file.text();
    } catch {
      setImportError("Couldn't read that file — try selecting it again.");
      return;
    }
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
        description="Founding team, AI provider, criteria weights, and data."
      />
      <div className="space-y-6">
        {/* 0a. Account (cloud mode only) */}
        {cloud ? (
          <Section title="Account">
            {entitlements.signedIn ? (
              <div className="space-y-3">
                <p className="text-sm text-zinc-700">
                  Signed in as{" "}
                  <span className="font-medium text-zinc-900">
                    {entitlements.email ?? "—"}
                  </span>
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <label
                    htmlFor="display-name"
                    className="text-xs font-medium text-zinc-700"
                  >
                    Display name
                  </label>
                  <input
                    id="display-name"
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    onBlur={() => {
                      if (displayName !== entitlements.displayName) {
                        void patchProfile({ displayName });
                      }
                    }}
                    placeholder="How you appear on public ideas"
                    className={`${inputClass} w-64 max-w-full`}
                  />
                </div>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={showHandle}
                    onChange={(e) => {
                      setShowHandle(e.target.checked);
                      void patchProfile({ showHandle: e.target.checked });
                    }}
                    className="h-4 w-4 accent-teal-600"
                  />
                  <span className="text-sm text-zinc-800">
                    Show my name on my public ideas
                  </span>
                </label>
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="danger" onClick={() => void signOut()}>
                    Sign out
                  </Button>
                  {accountError ? (
                    <span className="text-xs text-red-600">{accountError}</span>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm text-zinc-600">
                  Sign in to sync your founding team and ideas across devices.
                </p>
                <Link
                  href="/signin"
                  className="rounded bg-teal-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-teal-700"
                >
                  Sign in
                </Link>
              </div>
            )}
          </Section>
        ) : null}

        {/* 0b. Subscription (cloud mode only) */}
        {cloud ? (
          <Section title="Subscription">
            <div className="space-y-3">
              {upgradeWelcome ? (
                <div className="rounded border border-teal-200 bg-teal-50 px-3 py-2 text-sm text-teal-800">
                  Welcome aboard — subscription active.
                </div>
              ) : null}
              {entitlements.subscribed ? (
                <>
                  <div className="rounded border border-teal-200 bg-teal-50 px-3 py-2 text-sm text-teal-800">
                    Subscriber — unlimited analyses, private ideas, and premium
                    models.
                  </div>
                  <p className="text-xs text-zinc-500">
                    Status:{" "}
                    <span className="font-medium text-zinc-700">
                      {entitlements.subscriptionStatus}
                    </span>
                    {entitlements.subscriptionStatus === "trialing"
                      ? " — becomes a paid subscription when the trial ends."
                      : " — renews monthly; manage or cancel any time in the billing portal."}
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      onClick={() => void openBilling("/api/stripe/portal")}
                      disabled={billingBusy}
                    >
                      {billingBusy ? "Opening…" : "Manage billing"}
                    </Button>
                    {billingError ? (
                      <span className="text-xs text-red-600">
                        {billingError}
                      </span>
                    ) : null}
                  </div>
                </>
              ) : (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-4">
                  <div className="text-sm font-semibold text-zinc-900">
                    {SUBSCRIPTION_PRICE_LABEL}
                  </div>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-zinc-700">
                    <li>
                      <span className="font-medium">Private ideas</span> — keep
                      anything out of the public feed
                    </li>
                    <li>
                      <span className="font-medium">Premium models</span> —
                      Claude Fable 5 and GPT-5.5 at max reasoning
                    </li>
                    <li>
                      <span className="font-medium">
                        Unlimited AI analyses
                      </span>{" "}
                      — free tier gets {FREE_ANALYSES_PER_MONTH}/month
                    </li>
                  </ul>
                  {entitlements.analysesRemaining !== null ? (
                    <p className="mt-2 text-xs text-zinc-500">
                      <span className="tnum">
                        {entitlements.analysesRemaining}
                      </span>{" "}
                      of <span className="tnum">{FREE_ANALYSES_PER_MONTH}</span>{" "}
                      free analyses left this month
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <Button
                      variant="primary"
                      onClick={handleUpgrade}
                      disabled={billingBusy}
                    >
                      {billingBusy
                        ? "Redirecting…"
                        : `Upgrade — ${SUBSCRIPTION_PRICE_LABEL}`}
                    </Button>
                    {billingError ? (
                      <span className="text-xs text-red-600">
                        {billingError}
                      </span>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          </Section>
        ) : null}

        {/* 1. Founding team */}
        <Section
          title="Founding team"
          description="Used by the AI to judge founder–market fit, unfair advantages, and founder-personal gates. With co-founders, founder–market fit scores as the strongest founder's fit."
        >
          <div className="space-y-4">
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
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-zinc-800">
                  Your background
                </span>
                {settings.founderBackground.trim() ? null : (
                  <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                    required for analysis
                  </span>
                )}
                <span className="flex-1" />
                <Button
                  onClick={() => uploadCvFor("primary")}
                  disabled={extracting}
                >
                  {extracting ? "Extracting…" : "Upload CV (.pdf / .docx / .txt)"}
                </Button>
              </div>
              <textarea
                rows={8}
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

            {settings.coFounders.map((c, i) => (
              <div
                key={c.id}
                className="space-y-2 rounded-lg border border-zinc-200 bg-zinc-50/50 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-zinc-800">
                    Co-founder {i + 2}
                  </span>
                  <input
                    type="text"
                    value={c.name}
                    onChange={(e) => setCoFounder(c.id, { name: e.target.value })}
                    placeholder="Name (optional)"
                    className="h-8 w-40 rounded border border-zinc-300 bg-white px-2 text-sm text-zinc-900 focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
                  />
                  <span className="flex-1" />
                  <Button
                    onClick={() => uploadCvFor(c.id)}
                    disabled={extracting}
                  >
                    Upload CV
                  </Button>
                  <Button variant="danger" onClick={() => removeCoFounder(c.id)}>
                    Remove
                  </Button>
                </div>
                <textarea
                  rows={5}
                  value={c.background}
                  onChange={(e) =>
                    setCoFounder(c.id, { background: e.target.value })
                  }
                  placeholder="This co-founder's expertise, track record, networks, and unfair advantages…"
                  className="w-full rounded border border-zinc-300 bg-white p-2 font-mono text-xs text-zinc-900 focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
                />
              </div>
            ))}

            <div className="flex flex-wrap items-center gap-3">
              {settings.coFounders.length < 4 ? (
                <Button onClick={addCoFounder}>Add co-founder</Button>
              ) : (
                <span className="text-xs text-zinc-400">
                  Maximum of 4 co-founders.
                </span>
              )}
              {extractError ? (
                <span className="text-xs text-red-600">{extractError}</span>
              ) : null}
              {extractSuccess ? (
                <span className="text-xs text-teal-700">{extractSuccess}</span>
              ) : null}
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
                      {cloud &&
                      !entitlements.subscribed &&
                      PREMIUM_MODELS.has(m.id)
                        ? `${m.label} — subscribers`
                        : m.label}
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
              {cloud &&
              !entitlements.subscribed &&
              PREMIUM_MODELS.has(currentModel) ? (
                <p className="text-xs text-amber-600">
                  This model needs a subscription — analyses will ask you to
                  upgrade.
                </p>
              ) : null}
              <p className="text-xs text-zinc-500">
                Analysis runs server-side — API keys never reach the browser.
              </p>
              <label className="mt-3 flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  checked={settings.webSearch}
                  onChange={(e) =>
                    updateSettings({ webSearch: e.target.checked })
                  }
                  className="mt-0.5 h-4 w-4 accent-teal-600"
                />
                <span>
                  <span className="block text-sm text-zinc-800">
                    Web search during analysis
                  </span>
                  <span className="block text-xs text-zinc-500">
                    Lets the model verify market size, competitors, and timing
                    with a few live searches (up to 5 per analysis; Anthropic
                    bills ~$10 per 1,000 searches on top of tokens).
                  </span>
                </span>
              </label>
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
