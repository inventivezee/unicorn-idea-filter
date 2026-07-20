"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AutoSavedFlag, Button, PageHeader, Section } from "@/components/ui";
import { CRITERIA } from "@/lib/criteria";
import { getAnonKey } from "@/lib/anon";
import { ANTHROPIC_MODELS, generateId, OPENAI_MODELS } from "@/lib/defaults";
import { sumWeights } from "@/lib/engine";
import {
  FREE_ANALYSES_PER_DAY,
  isPremiumModel,
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

/** "or paste a profile URL" row — AI web-search lookup for one founder slot.
 *  Module-level so it keeps a stable identity (the URL input keeps focus). */
function ProfileUrlRow({
  value,
  busy,
  anyBusy,
  onChange,
  onFetch,
}: {
  value: string;
  busy: boolean;
  anyBusy: boolean;
  onChange: (v: string) => void;
  onFetch: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="url"
        inputMode="url"
        value={value}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        placeholder="or paste a LinkedIn / bio / personal-site URL"
        className="h-8 min-w-0 flex-1 rounded border border-zinc-300 bg-white px-2 text-xs text-zinc-900 placeholder:text-zinc-400 focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
      />
      <Button
        onClick={onFetch}
        disabled={anyBusy || !value.trim()}
        className="text-xs!"
      >
        {busy ? "Looking up…" : "Fetch from URL"}
      </Button>
    </div>
  );
}

interface KeyStatus {
  set: boolean;
  hint?: string;
}

const BYOK_PROVIDERS: Array<{
  id: "anthropic" | "openai" | "openrouter" | "browserbase";
  label: string;
  placeholder: string;
  note: string;
}> = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    placeholder: "sk-ant-…",
    note: "Powers analysis + discovery scoring/generation.",
  },
  {
    id: "openai",
    label: "OpenAI (GPT-5.6 Sol)",
    placeholder: "sk-…",
    note: "Powers analysis + discovery scoring/generation.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    placeholder: "sk-or-…",
    note: "Discovery's DeepSeek / Qwen / Gemini research panel.",
  },
  {
    id: "browserbase",
    label: "Browserbase",
    placeholder: "bb-… (API key)",
    note: "Discovery's live research browser. Needs the project id too.",
  },
];

function ApiKeysSection() {
  const [status, setStatus] = useState<Record<string, KeyStatus> | null>(null);
  const [available, setAvailable] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [bbProject, setBbProject] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/keys");
        if (res.ok) {
          const d = (await res.json()) as {
            keys: Record<string, KeyStatus> | null;
            available: boolean;
          };
          setStatus(d.keys);
          setAvailable(d.available);
        }
      } catch {
        // Non-blocking.
      }
    })();
  }, []);

  async function save(id: string) {
    setBusy(id);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        provider: id,
        value: drafts[id] ?? "",
      };
      if (id === "browserbase") body.project = bbProject;
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await res.json().catch(() => null)) as {
        keys?: Record<string, KeyStatus>;
        error?: string;
      } | null;
      if (!res.ok) {
        setError(d?.error ?? `Couldn't save (HTTP ${res.status}).`);
        return;
      }
      if (d?.keys) setStatus(d.keys);
      setDrafts((prev) => ({ ...prev, [id]: "" }));
      if (id === "browserbase") setBbProject("");
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(null);
    }
  }

  async function clear(id: string) {
    setBusy(id);
    try {
      const res = await fetch(`/api/keys?provider=${id}`, { method: "DELETE" });
      const d = (await res.json().catch(() => null)) as {
        keys?: Record<string, KeyStatus>;
      } | null;
      if (d?.keys) setStatus(d.keys);
    } catch {
      // Next load shows the truth.
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section
      title="Your API keys (bring your own)"
      description="Add your own provider keys to run analysis and discovery on your own accounts — your keys are used instead of ours, and your daily caps are lifted. Bring all four to fully self-fund discovery. Keys are encrypted, never shown again, and never shared."
    >
      {!available ? (
        <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Key storage isn&apos;t enabled on this deployment yet. Until it is,
          everything runs on the app&apos;s shared keys.
        </div>
      ) : null}
      {error ? (
        <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}
      <div className="space-y-4">
        {BYOK_PROVIDERS.map((p) => {
          const st = status?.[p.id];
          return (
            <div
              key={p.id}
              className="rounded-lg border border-zinc-200 bg-white p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-zinc-800">
                  {p.label}
                </span>
                {st?.set ? (
                  <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                    set · {st.hint}
                  </span>
                ) : (
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                    using app key
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-zinc-500">{p.note}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  disabled={!available || busy === p.id}
                  value={drafts[p.id] ?? ""}
                  onChange={(e) =>
                    setDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))
                  }
                  placeholder={p.placeholder}
                  className="min-w-[200px] flex-1 rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-cyan-500 focus:outline-none"
                />
                {p.id === "browserbase" ? (
                  <input
                    type="text"
                    autoComplete="off"
                    disabled={!available || busy === p.id}
                    value={bbProject}
                    onChange={(e) => setBbProject(e.target.value)}
                    placeholder="project id"
                    className="w-[140px] rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-cyan-500 focus:outline-none"
                  />
                ) : null}
                <Button
                  disabled={!available || busy === p.id || !(drafts[p.id] ?? "").trim()}
                  onClick={() => void save(p.id)}
                >
                  {busy === p.id ? "Saving…" : "Save"}
                </Button>
                {st?.set ? (
                  <Button
                    variant="secondary"
                    disabled={busy === p.id}
                    onClick={() => void clear(p.id)}
                  >
                    Clear
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
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
      // The Stripe webhook races the redirect back here — poll until the
      // subscription lands (bounded at ~30s).
      for (const ms of [0, 2000, 5000, 10_000, 30_000]) {
        setTimeout(() => void refreshEntitlements(), ms);
      }
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

  // --- Profile-URL lookup (per founder slot) ---
  const [profileUrls, setProfileUrls] = useState<Record<string, string>>({});
  const [lookupSlot, setLookupSlot] = useState<string | null>(null);

  async function lookupProfile(target: string) {
    const url = (profileUrls[target] ?? "").trim();
    if (!url || lookupSlot) return;
    const existing =
      target === "primary"
        ? settings.founderBackground
        : (settings.coFounders.find((c) => c.id === target)?.background ?? "");
    if (
      existing.trim() !== "" &&
      !window.confirm(
        "Replace this founder's existing background with the AI lookup?",
      )
    ) {
      return;
    }
    setExtractError(null);
    setExtractSuccess(null);
    setLookupSlot(target);
    try {
      const res = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          provider: settings.provider,
          model: settings.models[settings.provider],
          anonKey: getAnonKey(),
          founderSlot: target,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        found?: boolean;
        background?: string;
        error?: string;
      } | null;
      if (!res.ok) {
        setExtractError(data?.error ?? `Lookup failed (HTTP ${res.status}).`);
        return;
      }
      if (data?.found && data.background?.trim()) {
        if (target === "primary") {
          updateSettings({ founderBackground: data.background });
        } else {
          setCoFounder(target, { background: data.background });
        }
        setExtractSuccess(
          "Built a background from public info — review and edit it below.",
        );
      } else {
        // Honest miss: don't overwrite anything, tell the founder.
        setExtractError(
          data?.background?.trim() ||
            "Couldn't find enough public information from that URL — paste your background or upload a CV instead.",
        );
      }
    } catch {
      setExtractError("Network error during the profile lookup.");
    } finally {
      setLookupSlot(null);
    }
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
      // Send the raw file + extracted text to be stored (cloud) and
      // AI-summarised into a cleaner background. Fall back to the raw text if
      // the endpoint is unreachable so an upload never dead-ends.
      let background = text;
      let summarised = false;
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("extractedText", text);
        fd.append("provider", settings.provider);
        fd.append("model", settings.models[settings.provider]);
        fd.append("anonKey", getAnonKey());
        fd.append("founderSlot", target);
        const res = await fetch("/api/cv", { method: "POST", body: fd });
        if (res.ok) {
          const data = (await res.json()) as {
            background?: string;
            summarised?: boolean;
          };
          if (data.background && data.background.trim()) {
            background = data.background;
            summarised = data.summarised === true;
          }
        }
      } catch {
        // Network error — keep the locally extracted text.
      }
      if (target === "primary") {
        updateSettings({ founderBackground: background });
      } else {
        setCoFounder(target, { background });
      }
      setExtractSuccess(
        summarised
          ? `Summarised your background from ${file.name} with AI — edit it below if needed.`
          : `Extracted ${background.length.toLocaleString()} characters from ${file.name}.`,
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

  const profileRow = (slot: string) => (
    <ProfileUrlRow
      value={profileUrls[slot] ?? ""}
      busy={lookupSlot === slot}
      anyBusy={lookupSlot !== null}
      onChange={(v) => setProfileUrls((m) => ({ ...m, [slot]: v }))}
      onFetch={() => void lookupProfile(slot)}
    />
  );

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

        {/* 1. Founding team */}
        <Section
          title="Founding team"
          description="Used by the AI to judge founder–market fit, unfair advantages, and founder-personal gates. Upload a CV and the AI summarises it into a background for you. With co-founders, founder–market fit scores as the strongest founder's fit."
          actions={
            <AutoSavedFlag
              value={
                settings.founderBackground +
                " " +
                JSON.stringify(settings.coFounders)
              }
            />
          }
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
                  {extracting
                    ? "Reading & summarising…"
                    : "Upload CV (.pdf / .docx / .txt)"}
                </Button>
              </div>
              {profileRow("primary")}
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
                {profileRow(c.id)}
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
                      isPremiumModel(m.id)
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
              isPremiumModel(currentModel) ? (
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

        {cloud && (entitlements.subscribed || entitlements.isAdmin) ? (
          <ApiKeysSection />
        ) : null}

        {/* 2b. Subscription — sits under the AI model picker */}
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
                      <span className="font-medium">Premium power</span> —
                      Claude Fable 5, plus GPT-5.5 at xhigh reasoning (free
                      tier runs it at medium)
                    </li>
                    <li>
                      <span className="font-medium">
                        Unlimited AI analyses
                      </span>{" "}
                      — free tier gets {FREE_ANALYSES_PER_DAY}/day
                    </li>
                  </ul>
                  {entitlements.analysesRemaining !== null ? (
                    <p className="mt-2 text-xs text-zinc-500">
                      <span className="tnum">
                        {entitlements.analysesRemaining}
                      </span>{" "}
                      of <span className="tnum">{FREE_ANALYSES_PER_DAY}</span>{" "}
                      free analyses left today
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
            On the Dashboard, the stress test re-ranks your ideas many times
            with each criterion&apos;s weight randomly nudged ±20%, to check
            whether your top idea genuinely leads or only wins because of your
            exact weighting. This sets how many runs — more trials give a
            steadier result but take a little longer.
          </p>
        </Section>

        {/* 5. Data */}
        <Section
          title="Data"
          description={
            cloud
              ? "Your ideas and settings sync to your account. Export a JSON backup any time, or import one from another browser."
              : "Everything lives in this browser's localStorage — export regularly."
          }
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
