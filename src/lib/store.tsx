"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getAnonKey } from "./anon";
import { DEFAULT_WEIGHTS } from "./criteria";
import { defaultSettings, initialState, newIdea } from "./defaults";
import type { Entitlements } from "./entitlements";
import { normalizeState } from "./persistence";
import { cloudEnabled, supabaseBrowser } from "./supabase/client";
import type { AppState, Idea, Settings } from "./types";

const STORAGE_KEY = "unicorn-idea-filter:v1";
const MIGRATED_KEY = "unicorn-idea-filter:migrated";
const SYNC_DEBOUNCE_MS = 800;

function signedOutEntitlements(): Entitlements {
  return {
    signedIn: false,
    email: null,
    displayName: "",
    showHandle: false,
    isAdmin: false,
    subscribed: false,
    subscriptionStatus: "none",
    analysesRemaining: null,
    premiumModels: ["claude-fable-5"],
  };
}

interface StoreContextValue {
  state: AppState;
  /** True once initial data (localStorage or cloud) has been read. */
  hydrated: boolean;
  /** Cloud mode: Supabase is configured and ideas live in the shared database. */
  cloud: boolean;
  entitlements: Entitlements;
  refreshEntitlements: () => Promise<void>;
  /** Anonymous device key (cloud mode, signed out). */
  anonKey: string | null;
  /** Non-null when background sync is failing. */
  syncError: string | null;
  /** Legacy local ideas that can be imported into the cloud. */
  pendingLocalImport: number;
  importLocalIdeas: () => Promise<void>;
  signOut: () => Promise<void>;
  addIdea: (partial?: Partial<Idea>) => Idea;
  updateIdea: (
    id: string,
    patch: Partial<Idea> | ((latest: Idea) => Partial<Idea>),
  ) => void;
  setIdeaPrivacy: (id: string, isPrivate: boolean) => Promise<string | null>;
  deleteIdea: (id: string) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  resetWeights: () => void;
  exportJSON: () => string;
  importJSON: (json: string) => void;
  /**
   * Ideas with an AI request in flight, keyed by id → kind (instrument +
   * mode). Ephemeral (never persisted or synced): lets the UI show progress
   * app-wide and survive navigating away from the idea while it runs.
   */
  analyzing: Record<string, AnalysisKind>;
  beginAnalysis: (id: string, kind: AnalysisKind) => void;
  endAnalysis: (id: string) => void;
  /**
   * True once settings are readable (synchronous localStorage read) — flips
   * long before the network-bound `hydrated`, so mode-dependent chrome (nav,
   * brand) paints correctly for returning users without a flash.
   */
  settingsHydrated: boolean;
}

/** What kind of AI request is running: instrument + mode. */
export type AnalysisKind = "full" | "metadata" | "cc_full" | "cc_metadata";

const StoreContext = createContext<StoreContextValue | null>(null);

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (body && typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Non-JSON body.
  }
  return fallback;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const cloud = cloudEnabled();
  const [state, setState] = useState<AppState>(() =>
    cloud
      ? { version: 1, ideas: [], settings: defaultSettings() }
      : initialState(),
  );
  const [hydrated, setHydrated] = useState(false);
  const [entitlements, setEntitlements] = useState<Entitlements>(
    signedOutEntitlements,
  );
  const [syncError, setSyncError] = useState<string | null>(null);
  const [pendingLocalImport, setPendingLocalImport] = useState(0);
  const [anonKey, setAnonKey] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState<Record<string, AnalysisKind>>(
    {},
  );
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const skipNextSave = useRef(true);
  const signedInRef = useRef(false);

  // ---------------------------------------------------------------------
  // Debounced cloud sync of dirty ideas / settings.
  // ---------------------------------------------------------------------
  const dirtyIdeas = useRef(new Set<string>());
  const settingsDirty = useRef(false);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const flushSync = useCallback(async () => {
    if (!cloud) return;
    const key = getAnonKey();
    const ids = [...dirtyIdeas.current];
    dirtyIdeas.current.clear();
    for (const id of ids) {
      const idea = stateRef.current.ideas.find((i) => i.id === id);
      if (!idea) continue;
      try {
        let res = await fetch(`/api/ideas/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patch: idea, anonKey: key }),
        });
        if (res.status === 404) {
          // Row never made it to the cloud (failed optimistic create, JSON
          // restore, offline edit) — create it now instead of dropping it.
          res = await fetch("/api/ideas", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ idea, anonKey: key }),
          });
        }
        if (!res.ok) {
          throw new Error(await readError(res, `Sync failed (${res.status})`));
        }
        setSyncError(null);
      } catch (e) {
        dirtyIdeas.current.add(id); // retry on the next flush
        setSyncError(e instanceof Error ? e.message : "Sync failed.");
      }
    }
    if (settingsDirty.current && signedInRef.current) {
      settingsDirty.current = false;
      const s = stateRef.current.settings;
      try {
        const res = await fetch("/api/me", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            founderBackground: s.founderBackground,
            coFounders: s.coFounders,
            prefs: {
              provider: s.provider,
              models: s.models,
              webSearch: s.webSearch,
              askClarifying: s.askClarifying,
              filterMode: s.filterMode,
              weights: s.weights,
              trials: s.trials,
            },
          }),
        });
        if (!res.ok) {
          throw new Error(await readError(res, `Sync failed (${res.status})`));
        }
        setSyncError(null);
      } catch (e) {
        settingsDirty.current = true;
        setSyncError(e instanceof Error ? e.message : "Sync failed.");
      }
    }
  }, [cloud]);

  const scheduleSync = useCallback(() => {
    if (!cloud) return;
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => void flushSync(), SYNC_DEBOUNCE_MS);
  }, [cloud, flushSync]);

  // ---------------------------------------------------------------------
  // Boot: local mode hydrates from localStorage; cloud mode from the API.
  // ---------------------------------------------------------------------
  const refreshEntitlements = useCallback(async () => {
    if (!cloud) return;
    try {
      const res = await fetch("/api/me");
      if (!res.ok) return;
      const data = (await res.json()) as {
        entitlements: Entitlements;
        profile: {
          displayName: string;
          showHandle: boolean;
          founderBackground: string;
          coFounders: Settings["coFounders"];
          prefs: Record<string, unknown>;
        } | null;
      };
      setEntitlements(data.entitlements);
      signedInRef.current = data.entitlements.signedIn;
      if (data.profile) {
        // Profile is authoritative when it has content; otherwise keep what
        // was entered anonymously on this device and push it up to the
        // profile (first sign-in must never wipe a locally written CV).
        const prefs = data.profile.prefs ?? {};
        const profileBackground = data.profile.founderBackground ?? "";
        const profileCoFounders = data.profile.coFounders ?? [];
        let pushLocalUp = false;
        setState((s) => {
          const keepLocalBackground =
            !profileBackground.trim() && s.settings.founderBackground.trim();
          const keepLocalCoFounders =
            profileCoFounders.length === 0 && s.settings.coFounders.length > 0;
          pushLocalUp = Boolean(keepLocalBackground || keepLocalCoFounders);
          const merged = normalizeState({
            version: 1,
            ideas: [],
            settings: {
              ...s.settings,
              ...((prefs as Record<string, unknown>) ?? {}),
              founderBackground: keepLocalBackground
                ? s.settings.founderBackground
                : profileBackground,
              coFounders: keepLocalCoFounders
                ? s.settings.coFounders
                : profileCoFounders,
            },
          }).settings;
          return { ...s, settings: merged };
        });
        if (pushLocalUp) {
          settingsDirty.current = true;
          scheduleSync();
        }
      }
    } catch {
      // Entitlement refresh is best-effort.
    }
  }, [cloud, scheduleSync]);

  const loadCloudIdeas = useCallback(async () => {
    const key = getAnonKey();
    setAnonKey(key);
    try {
      const res = await fetch(`/api/ideas?anon_key=${encodeURIComponent(key)}`);
      if (!res.ok) {
        throw new Error(await readError(res, `Load failed (${res.status})`));
      }
      const data = (await res.json()) as { ideas: Idea[] };
      setState((s) => ({ ...s, ideas: data.ideas }));
      setSyncError(null);
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "Couldn't load ideas.");
    }
  }, []);

  useEffect(() => {
    if (!cloud) {
      // Local-only mode — behaves exactly as before.
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) setState(normalizeState(JSON.parse(raw)));
      } catch {
        // Corrupt storage — keep seed state rather than crashing.
      }
      setSettingsHydrated(true);
      setHydrated(true);
      return;
    }

    // Cloud mode: settings still cache locally (fast boot + anon settings).
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = normalizeState(JSON.parse(raw));
        setState((s) => ({ ...s, settings: parsed.settings }));
        if (
          parsed.ideas.some((i) => !i.isExample) &&
          !localStorage.getItem(MIGRATED_KEY)
        ) {
          setPendingLocalImport(parsed.ideas.filter((i) => !i.isExample).length);
        }
      }
    } catch {
      // Ignore corrupt local cache.
    }
    setSettingsHydrated(true);
    void Promise.all([loadCloudIdeas(), refreshEntitlements()]).finally(() =>
      setHydrated(true),
    );

    const supabase = supabaseBrowser();
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT") {
        void Promise.all([loadCloudIdeas(), refreshEntitlements()]);
      }
    });
    return () => sub.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloud]);

  // Persist to localStorage (full state locally; settings cache in cloud mode).
  useEffect(() => {
    if (!hydrated) return;
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }
    try {
      if (cloud) {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ version: 1, ideas: [], settings: state.settings }),
        );
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      }
    } catch {
      // Storage full or unavailable — data stays in memory.
    }
  }, [state, hydrated, cloud]);

  // Best-effort flush of pending edits when the tab is closed or hidden —
  // keepalive requests survive page teardown for small payloads.
  useEffect(() => {
    if (!cloud) return;
    function flushOnExit() {
      const key = getAnonKey();
      for (const id of dirtyIdeas.current) {
        const idea = stateRef.current.ideas.find((i) => i.id === id);
        if (!idea) continue;
        void fetch(`/api/ideas/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patch: idea, anonKey: key }),
          keepalive: true,
        }).catch(() => {});
      }
      dirtyIdeas.current.clear();
    }
    window.addEventListener("pagehide", flushOnExit);
    return () => window.removeEventListener("pagehide", flushOnExit);
  }, [cloud]);

  // Cross-tab sync (local mode only; cloud mode reloads from the API).
  useEffect(() => {
    if (cloud) return;
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY || e.newValue === null) return;
      try {
        skipNextSave.current = true;
        setState(normalizeState(JSON.parse(e.newValue)));
      } catch {
        // Ignore malformed cross-tab writes.
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [cloud]);

  // ---------------------------------------------------------------------
  // Mutations — optimistic local state, then synced to the cloud.
  // ---------------------------------------------------------------------
  const addIdea = useCallback(
    (partial?: Partial<Idea>) => {
      const idea = newIdea(partial);
      setState((s) => ({ ...s, ideas: [idea, ...s.ideas] }));
      if (cloud) {
        void fetch("/api/ideas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            idea: { ...idea },
            anonKey: getAnonKey(),
          }),
        })
          .then(async (res) => {
            if (!res.ok) {
              setSyncError(await readError(res, "Couldn't save the new idea."));
              dirtyIdeas.current.add(idea.id); // retried via PATCH-404→POST
              scheduleSync();
            }
          })
          .catch(() => {
            setSyncError("Couldn't save the new idea — will retry.");
            dirtyIdeas.current.add(idea.id);
            scheduleSync();
          });
      }
      return idea;
    },
    [cloud, scheduleSync],
  );

  const updateIdea = useCallback(
    (id: string, patch: Partial<Idea> | ((latest: Idea) => Partial<Idea>)) => {
      setState((s) => ({
        ...s,
        ideas: s.ideas.map((i) =>
          i.id === id
            ? {
                ...i,
                ...(typeof patch === "function" ? patch(i) : patch),
                updatedAt: new Date().toISOString(),
              }
            : i,
        ),
      }));
      dirtyIdeas.current.add(id);
      scheduleSync();
    },
    [scheduleSync],
  );

  const setIdeaPrivacy = useCallback(
    async (id: string, isPrivate: boolean): Promise<string | null> => {
      if (!cloud) return "Cloud features are not configured.";
      try {
        const res = await fetch(`/api/ideas/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isPrivate, anonKey: getAnonKey() }),
        });
        if (!res.ok) {
          return await readError(res, `Couldn't update privacy (${res.status}).`);
        }
        setState((s) => ({
          ...s,
          ideas: s.ideas.map((i) => (i.id === id ? { ...i, isPrivate } : i)),
        }));
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : "Couldn't update privacy.";
      }
    },
    [cloud],
  );

  const deleteIdea = useCallback(
    (id: string) => {
      setState((s) => ({ ...s, ideas: s.ideas.filter((i) => i.id !== id) }));
      dirtyIdeas.current.delete(id);
      if (cloud) {
        void fetch(`/api/ideas/${id}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ anonKey: getAnonKey() }),
        })
          .then(async (res) => {
            if (!res.ok && res.status !== 404) {
              setSyncError(
                await readError(res, "Couldn't delete the idea in the cloud."),
              );
            }
          })
          .catch(() => setSyncError("Couldn't delete the idea in the cloud."));
      }
    },
    [cloud],
  );

  const updateSettings = useCallback(
    (patch: Partial<Settings>) => {
      setState((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
      settingsDirty.current = true;
      scheduleSync();
    },
    [scheduleSync],
  );

  const resetWeights = useCallback(() => {
    setState((s) => ({
      ...s,
      settings: { ...s.settings, weights: { ...DEFAULT_WEIGHTS } },
    }));
    settingsDirty.current = true;
    scheduleSync();
  }, [scheduleSync]);

  const exportJSON = useCallback(() => JSON.stringify(state, null, 2), [state]);

  const importJSON = useCallback(
    (json: string) => {
      const next = normalizeState(JSON.parse(json));
      setState(next);
      if (cloud) {
        for (const idea of next.ideas) dirtyIdeas.current.add(idea.id);
        settingsDirty.current = true;
        scheduleSync();
      }
    },
    [cloud, scheduleSync],
  );

  const importInFlight = useRef(false);
  const importLocalIdeas = useCallback(async () => {
    if (!cloud || importInFlight.current) return;
    importInFlight.current = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? normalizeState(JSON.parse(raw)) : null;
      const ideas = parsed?.ideas.filter((i) => !i.isExample) ?? [];
      // The endpoint caps batches at 100 — chunk instead of silently dropping.
      for (let start = 0; start < ideas.length; start += 100) {
        const res = await fetch("/api/ideas/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ideas: ideas.slice(start, start + 100),
            anonKey: getAnonKey(),
          }),
        });
        if (!res.ok) {
          setSyncError(await readError(res, "Import failed."));
          return;
        }
      }
      localStorage.setItem(MIGRATED_KEY, "1");
      setPendingLocalImport(0);
      await loadCloudIdeas();
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      importInFlight.current = false;
    }
  }, [cloud, loadCloudIdeas]);

  const signOut = useCallback(async () => {
    if (!cloud) return;
    await supabaseBrowser().auth.signOut();
    setEntitlements(signedOutEntitlements());
    signedInRef.current = false;
    settingsDirty.current = false;
    // Don't leave the signed-in user's CV/settings behind for the next
    // (anonymous) person on this browser.
    setState((s) => ({ ...s, settings: defaultSettings() }));
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: 1, ideas: [], settings: defaultSettings() }),
      );
    } catch {
      // Cache wipe is best-effort.
    }
    await loadCloudIdeas();
  }, [cloud, loadCloudIdeas]);

  const beginAnalysis = useCallback((id: string, kind: AnalysisKind) => {
    setAnalyzing((a) => ({ ...a, [id]: kind }));
  }, []);
  const endAnalysis = useCallback((id: string) => {
    setAnalyzing((a) => {
      if (!(id in a)) return a;
      const next = { ...a };
      delete next[id];
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      state,
      hydrated,
      cloud,
      entitlements,
      refreshEntitlements,
      anonKey,
      syncError,
      pendingLocalImport,
      importLocalIdeas,
      signOut,
      addIdea,
      updateIdea,
      setIdeaPrivacy,
      deleteIdea,
      updateSettings,
      resetWeights,
      exportJSON,
      importJSON,
      analyzing,
      beginAnalysis,
      endAnalysis,
      settingsHydrated,
    }),
    [
      state,
      hydrated,
      cloud,
      entitlements,
      refreshEntitlements,
      anonKey,
      syncError,
      pendingLocalImport,
      importLocalIdeas,
      signOut,
      addIdea,
      updateIdea,
      setIdeaPrivacy,
      deleteIdea,
      updateSettings,
      resetWeights,
      exportJSON,
      importJSON,
      analyzing,
      beginAnalysis,
      endAnalysis,
      settingsHydrated,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
