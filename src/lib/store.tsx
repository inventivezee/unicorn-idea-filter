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
import { DEFAULT_WEIGHTS } from "./criteria";
import { initialState, newIdea } from "./defaults";
import { normalizeState } from "./persistence";
import type { AppState, Idea, Settings } from "./types";

const STORAGE_KEY = "unicorn-idea-filter:v1";

interface StoreContextValue {
  state: AppState;
  /** True once localStorage has been read — render data only after this. */
  hydrated: boolean;
  addIdea: (partial?: Partial<Idea>) => Idea;
  updateIdea: (id: string, patch: Partial<Idea>) => void;
  deleteIdea: (id: string) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  resetWeights: () => void;
  exportJSON: () => string;
  importJSON: (json: string) => void;
}

const StoreContext = createContext<StoreContextValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(initialState);
  const [hydrated, setHydrated] = useState(false);
  const skipNextSave = useRef(true);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setState(normalizeState(JSON.parse(raw)));
    } catch {
      // Corrupt storage — keep seed state rather than crashing.
    }
    setHydrated(true);

    // Another tab saved — adopt its state instead of clobbering it on our next edit.
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
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage full or unavailable — data stays in memory.
    }
  }, [state, hydrated]);

  const addIdea = useCallback((partial?: Partial<Idea>) => {
    const idea = newIdea(partial);
    setState((s) => ({ ...s, ideas: [idea, ...s.ideas] }));
    return idea;
  }, []);

  const updateIdea = useCallback((id: string, patch: Partial<Idea>) => {
    setState((s) => ({
      ...s,
      ideas: s.ideas.map((i) =>
        i.id === id
          ? { ...i, ...patch, updatedAt: new Date().toISOString() }
          : i,
      ),
    }));
  }, []);

  const deleteIdea = useCallback((id: string) => {
    setState((s) => ({ ...s, ideas: s.ideas.filter((i) => i.id !== id) }));
  }, []);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setState((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
  }, []);

  const resetWeights = useCallback(() => {
    setState((s) => ({
      ...s,
      settings: { ...s.settings, weights: { ...DEFAULT_WEIGHTS } },
    }));
  }, []);

  const exportJSON = useCallback(() => JSON.stringify(state, null, 2), [state]);

  const importJSON = useCallback((json: string) => {
    const next = normalizeState(JSON.parse(json));
    setState(next);
  }, []);

  const value = useMemo(
    () => ({
      state,
      hydrated,
      addIdea,
      updateIdea,
      deleteIdea,
      updateSettings,
      resetWeights,
      exportJSON,
      importJSON,
    }),
    [
      state,
      hydrated,
      addIdea,
      updateIdea,
      deleteIdea,
      updateSettings,
      resetWeights,
      exportJSON,
      importJSON,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreContextValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
