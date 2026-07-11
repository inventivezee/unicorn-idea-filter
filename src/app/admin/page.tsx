"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  Button,
  EmptyState,
  PageHeader,
  Section,
  fmtScore,
} from "@/components/ui";
import { computeDefaultRawScore } from "@/lib/db/types";
import type { IdeaRow } from "@/lib/db/types";
import {
  customAdjustedScore,
  customDecision,
  customGateStatus,
  customRawScore,
} from "@/lib/custom/engine";
import { normalizeClarifications, normalizeCustomBlocks } from "@/lib/types";
import { useStore } from "@/lib/store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Row shape returned by GET /api/admin/ideas — full IdeaRow + owner context. */
type AdminIdea = IdeaRow & { owner_email: string | null };

interface AdminDraft {
  id: string;
  owner_id: string | null;
  owner_email: string | null;
  anon_key: string | null;
  kind: "idea" | "filter";
  status: "draft" | "designing" | "ready" | "failed";
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** Row shape of submission_logs, returned by GET /api/admin/logs. */
interface LogRow {
  id: number;
  idea_id: string | null;
  user_id: string | null;
  anon_key: string | null;
  action: string;
  ip: string | null;
  user_agent: string | null;
  referer: string | null;
  country: string | null;
  city: string | null;
  provider: string | null;
  model: string | null;
  web_searches: number | null;
  created_at: string;
}

interface CvUpload {
  id: string;
  user_id: string | null;
  anon_key: string | null;
  owner_email: string | null;
  founder_slot: string;
  filename: string;
  mime_type: string;
  size_bytes: number | null;
  source_url: string | null;
  web_searches: number | null;
  extracted_text: string;
  ai_summary: string;
  provider: string | null;
  model: string | null;
  ip: string | null;
  user_agent: string | null;
  country: string | null;
  download_url: string | null;
  created_at: string;
}

type AnalyzeState =
  | { status: "pending" }
  | { status: "done" }
  | { status: "error"; message: string };

interface IdeaLogsState {
  loading: boolean;
  error: string | null;
  logs: LogRow[] | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body — fall through to the status-based message.
  }
  if (!res.ok) {
    const message =
      body &&
      typeof body === "object" &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body as T;
}

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** "YYYY-MM-DD HH:mm" in local time (rendered client-side only). */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function ownerLabel(idea: AdminIdea): ReactNode {
  if (idea.owner_email) {
    return <span className="text-zinc-700">{idea.owner_email}</span>;
  }
  if (idea.anon_key) {
    return (
      <span className="font-mono text-xs text-zinc-500">
        anon:{idea.anon_key.slice(0, 8)}
      </span>
    );
  }
  return <Dash />;
}

function actorLabel(log: LogRow): ReactNode {
  if (log.user_id) {
    return (
      <span className="font-mono text-xs text-zinc-600" title={log.user_id}>
        {log.user_id.slice(0, 8)}
      </span>
    );
  }
  if (log.anon_key) {
    return (
      <span className="font-mono text-xs text-zinc-500" title={log.anon_key}>
        anon:{log.anon_key.slice(0, 8)}
      </span>
    );
  }
  return <Dash />;
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function Dash() {
  return <span className="text-zinc-300">—</span>;
}

function Chip({
  tone,
  children,
}: {
  tone: "teal" | "zinc" | "red";
  children: ReactNode;
}) {
  const styles =
    tone === "teal"
      ? "border-teal-200 bg-teal-50 text-teal-700"
      : tone === "red"
        ? "border-red-200 bg-red-50 text-red-700"
        : "border-zinc-200 bg-zinc-50 text-zinc-500";
  return (
    <span
      className={`inline-block whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-medium ${styles}`}
    >
      {children}
    </span>
  );
}

function Spinner() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 animate-spin text-zinc-400"
      fill="none"
      role="img"
      aria-label="working"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="2"
        className="opacity-25"
      />
      <path
        d="M14 8a6 6 0 0 0-6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4 shrink-0 text-teal-600"
      fill="none"
      role="img"
      aria-label="analysis complete"
    >
      <path
        d="M3 8.5 6.5 12 13 4.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`h-3.5 w-3.5 text-zinc-400 transition-transform ${open ? "rotate-90" : ""}`}
      fill="none"
      role="img"
      aria-label={open ? "collapse" : "expand"}
    >
      <path
        d="M6 3.5 10.5 8 6 12.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const TH = "px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-zinc-400";
const TD = "px-3 py-2 align-top text-xs text-zinc-600";

/**
 * Compact telemetry table.
 * "idea" mode (inside an expanded row): time, action, ip, country, UA, model.
 * "global" mode (recent activity): time, action, idea, actor, ip, country, model.
 */
function LogsTable({ logs, mode }: { logs: LogRow[]; mode: "idea" | "global" }) {
  if (logs.length === 0) {
    return <p className="text-xs text-zinc-400">No log entries.</p>;
  }
  const global = mode === "global";
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] border-collapse">
        <thead>
          <tr className="border-b border-zinc-200">
            <th className={TH}>Time</th>
            <th className={TH}>Action</th>
            {global ? (
              <>
                <th className={TH}>Idea</th>
                <th className={TH}>User / anon</th>
              </>
            ) : null}
            <th className={TH}>IP</th>
            <th className={TH}>Country</th>
            {global ? (
              <th className={TH}>Model</th>
            ) : (
              <>
                <th className={TH}>User agent</th>
                <th className={TH}>Provider / model</th>
              </>
            )}
            <th className={`${TH} text-right`}>Searches</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <tr
              key={log.id}
              className="border-b border-zinc-100 last:border-b-0"
            >
              <td className={`tnum ${TD} whitespace-nowrap text-zinc-500`}>
                {fmtTime(log.created_at)}
              </td>
              <td className={`${TD} whitespace-nowrap font-medium text-zinc-700`}>
                {log.action}
              </td>
              {global ? (
                <>
                  <td className={TD}>
                    {log.idea_id ? (
                      <span
                        className="font-mono text-xs text-zinc-500"
                        title={log.idea_id}
                      >
                        {log.idea_id.slice(0, 8)}
                      </span>
                    ) : (
                      <Dash />
                    )}
                  </td>
                  <td className={TD}>{actorLabel(log)}</td>
                </>
              ) : null}
              <td className={`${TD} whitespace-nowrap font-mono text-xs`}>
                {log.ip ?? <Dash />}
              </td>
              <td className={TD}>{log.country ?? <Dash />}</td>
              {global ? (
                <td className={`${TD} whitespace-nowrap`}>
                  {log.model ?? <Dash />}
                </td>
              ) : (
                <>
                  <td className={TD}>
                    {log.user_agent ? (
                      <span title={log.user_agent}>
                        {truncate(log.user_agent, 60)}
                      </span>
                    ) : (
                      <Dash />
                    )}
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>
                    {[log.provider, log.model].filter(Boolean).join(" / ") || (
                      <Dash />
                    )}
                  </td>
                </>
              )}
              <td className={`tnum ${TD} text-right`}>
                {typeof log.web_searches === "number" ? (
                  log.web_searches
                ) : (
                  <Dash />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface AbSummary {
  tasks: number;
  scored: number;
  avgRawScore: number | null;
  medianRawScore: number | null;
  firstTryPassRate: number | null;
  avgRescueLoops: number | null;
}

function DiscoveryAbSection() {
  const [data, setData] = useState<{
    byGenVariant: Record<string, AbSummary>;
    byGenAndScoringVariant: Record<string, AbSummary>;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/discovery-ab");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as typeof data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const table = (rows: Record<string, AbSummary>, label: string) => (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <thead>
          <tr className="text-xs text-zinc-500">
            <th className="px-2 py-1.5 text-left font-medium">{label}</th>
            <th className="px-2 py-1.5 text-right font-medium">Tasks</th>
            <th className="px-2 py-1.5 text-right font-medium">Scored</th>
            <th className="px-2 py-1.5 text-right font-medium">Avg raw</th>
            <th className="px-2 py-1.5 text-right font-medium">Median</th>
            <th className="px-2 py-1.5 text-right font-medium">
              1st-try pass
            </th>
            <th className="px-2 py-1.5 text-right font-medium">
              Avg rescues
            </th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(rows)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => (
              <tr key={k} className="border-t border-zinc-100">
                <td className="px-2 py-1.5 font-medium text-zinc-800">{k}</td>
                <td className="tnum px-2 py-1.5 text-right">{v.tasks}</td>
                <td className="tnum px-2 py-1.5 text-right">{v.scored}</td>
                <td className="tnum px-2 py-1.5 text-right">
                  {v.avgRawScore ?? "—"}
                </td>
                <td className="tnum px-2 py-1.5 text-right">
                  {v.medianRawScore ?? "—"}
                </td>
                <td className="tnum px-2 py-1.5 text-right">
                  {v.firstTryPassRate === null ? "—" : `${v.firstTryPassRate}%`}
                </td>
                <td className="tnum px-2 py-1.5 text-right">
                  {v.avgRescueLoops ?? "—"}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <Section
      title="Discovery A/B"
      description="Generation schools (strict design-against-the-instrument vs spirit-of-the-bar) and the gen × scoring-panel cells — original-idea outcomes only; tasks appear once their experiment assignment is recorded."
    >
      <div className="mb-2 flex justify-end">
        <Button
          className="px-2 py-1 text-xs!"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? "Loading…" : "⟳ Refresh"}
        </Button>
      </div>
      {error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : !data ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : Object.keys(data.byGenVariant).length === 0 ? (
        <p className="text-sm text-zinc-500">
          No experiment data yet — assignments record as new tasks initialize.
        </p>
      ) : (
        <div className="space-y-4">
          {table(data.byGenVariant, "Generation school")}
          {table(data.byGenAndScoringVariant, "Gen × scoring panel")}
        </div>
      )}
    </Section>
  );
}

export default function AdminPage() {
  const { hydrated, cloud, entitlements } = useStore();
  const isAdmin = cloud && entitlements.isAdmin;

  // Ideas table.
  const [ideas, setIdeas] = useState<AdminIdea[] | null>(null);
  const [ideasTotal, setIdeasTotal] = useState(0);
  const [ideasPage, setIdeasPage] = useState(0);
  const [ideasLoading, setIdeasLoading] = useState(false);
  const [ideasError, setIdeasError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [analyzeState, setAnalyzeState] = useState<
    Record<string, AnalyzeState>
  >({});
  const [ideaLogs, setIdeaLogs] = useState<Record<string, IdeaLogsState>>({});

  // Recent activity.
  const [activity, setActivity] = useState<LogRow[] | null>(null);
  const [activityTotal, setActivityTotal] = useState(0);
  const [activityPage, setActivityPage] = useState(0);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);

  // CV uploads (retained even after a founder clears their background).
  const [drafts, setDrafts] = useState<AdminDraft[] | null>(null);
  const [draftsTotal, setDraftsTotal] = useState(0);
  const [draftsPage, setDraftsPage] = useState(0);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [draftsOpen, setDraftsOpen] = useState<ReadonlySet<string>>(new Set());
  const [cvUploads, setCvUploads] = useState<CvUpload[] | null>(null);
  const [cvTotal, setCvTotal] = useState(0);
  const [cvPage, setCvPage] = useState(0);
  const [cvLoading, setCvLoading] = useState(false);
  const [cvError, setCvError] = useState<string | null>(null);
  const [cvOpen, setCvOpen] = useState<ReadonlySet<string>>(new Set());

  const loadIdeas = useCallback(async (page: number) => {
    setIdeasLoading(true);
    setIdeasError(null);
    try {
      const data = await fetchJSON<{ ideas: AdminIdea[]; total: number }>(
        `/api/admin/ideas?page=${page}`,
      );
      setIdeas((prev) => {
        if (page === 0 || !prev) return data.ideas;
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...data.ideas.filter((i) => !seen.has(i.id))];
      });
      setIdeasTotal(data.total);
      setIdeasPage(page);
    } catch (e) {
      setIdeasError(errMsg(e, "Couldn't load ideas."));
    } finally {
      setIdeasLoading(false);
    }
  }, []);

  /** Refresh one idea's row in place after an admin-triggered analysis. */
  const refreshRowsFromPageZero = useCallback(async (ideaId?: string) => {
    try {
      const data = await fetchJSON<{ ideas: AdminIdea[] }>(
        ideaId
          ? `/api/admin/ideas?id=${encodeURIComponent(ideaId)}`
          : "/api/admin/ideas?page=0",
      );
      setIdeas((prev) => {
        if (!prev) return data.ideas;
        const fresh = new Map(data.ideas.map((i) => [i.id, i]));
        return prev.map((i) => fresh.get(i.id) ?? i);
      });
    } catch {
      // Row refresh is best-effort; the analyze result is already saved.
    }
  }, []);

  const loadActivity = useCallback(async (page: number) => {
    setActivityLoading(true);
    setActivityError(null);
    try {
      const data = await fetchJSON<{ logs: LogRow[]; total: number }>(
        `/api/admin/logs?page=${page}`,
      );
      setActivity((prev) => {
        if (page === 0 || !prev) return data.logs;
        const seen = new Set(prev.map((l) => l.id));
        return [...prev, ...data.logs.filter((l) => !seen.has(l.id))];
      });
      setActivityTotal(data.total);
      setActivityPage(page);
    } catch (e) {
      setActivityError(errMsg(e, "Couldn't load activity."));
    } finally {
      setActivityLoading(false);
    }
  }, []);

  const loadDrafts = useCallback(async (page: number) => {
    setDraftsLoading(true);
    setDraftsError(null);
    try {
      const data = await fetchJSON<{ drafts: AdminDraft[]; total: number }>(
        `/api/admin/drafts?page=${page}`,
      );
      setDrafts((prev) => {
        if (page === 0 || !prev) return data.drafts;
        const seen = new Set(prev.map((d) => d.id));
        return [...prev, ...data.drafts.filter((d) => !seen.has(d.id))];
      });
      setDraftsTotal(data.total);
      setDraftsPage(page);
    } catch (e) {
      setDraftsError(errMsg(e, "Couldn't load drafts."));
    } finally {
      setDraftsLoading(false);
    }
  }, []);

  const loadCvUploads = useCallback(async (page: number) => {
    setCvLoading(true);
    setCvError(null);
    try {
      const data = await fetchJSON<{ uploads: CvUpload[]; total: number }>(
        `/api/admin/cv?page=${page}`,
      );
      setCvUploads((prev) => {
        if (page === 0 || !prev) return data.uploads;
        const seen = new Set(prev.map((u) => u.id));
        return [...prev, ...data.uploads.filter((u) => !seen.has(u.id))];
      });
      setCvTotal(data.total);
      setCvPage(page);
    } catch (e) {
      setCvError(errMsg(e, "Couldn't load CV uploads."));
    } finally {
      setCvLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!hydrated || !isAdmin) return;
    void loadIdeas(0);
    void loadActivity(0);
    void loadCvUploads(0);
    void loadDrafts(0);
  }, [hydrated, isAdmin, loadIdeas, loadActivity, loadCvUploads, loadDrafts]);

  const runAnalyze = useCallback(
    async (ideaId: string, filter: "unicorn" | "cashcow") => {
      setAnalyzeState((prev) => ({ ...prev, [ideaId]: { status: "pending" } }));
      try {
        await fetchJSON<{ ok: boolean; webSearches: number }>(
          "/api/admin/analyze",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ideaId, filter }),
          },
        );
        setAnalyzeState((prev) => ({ ...prev, [ideaId]: { status: "done" } }));
        await refreshRowsFromPageZero(ideaId);
      } catch (e) {
        setAnalyzeState((prev) => ({
          ...prev,
          [ideaId]: { status: "error", message: errMsg(e, "Analysis failed.") },
        }));
      }
    },
    [refreshRowsFromPageZero],
  );

  const loadIdeaLogs = useCallback(async (ideaId: string) => {
    setIdeaLogs((prev) => ({
      ...prev,
      [ideaId]: { loading: true, error: null, logs: prev[ideaId]?.logs ?? null },
    }));
    try {
      const data = await fetchJSON<{ logs: LogRow[] }>(
        `/api/admin/logs?idea=${encodeURIComponent(ideaId)}`,
      );
      setIdeaLogs((prev) => ({
        ...prev,
        [ideaId]: { loading: false, error: null, logs: data.logs },
      }));
    } catch (e) {
      setIdeaLogs((prev) => ({
        ...prev,
        [ideaId]: {
          loading: false,
          error: errMsg(e, "Couldn't load logs."),
          logs: prev[ideaId]?.logs ?? null,
        },
      }));
    }
  }, []);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!hydrated) return null;
  if (!isAdmin) return <EmptyState>Admin only.</EmptyState>;

  const ideaColumns = 8;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Admin"
        description="Every idea — public, private, unscored, and anonymous — plus submission telemetry."
      />

      <Section
        title="Ideas"
        description={
          ideas
            ? `${ideas.length} of ${ideasTotal} shown, newest first.`
            : undefined
        }
      >
        {ideasError ? (
          <div className="mb-3 flex items-center gap-3 text-xs text-red-600">
            <span>{ideasError}</span>
            <Button
              className="px-2! py-0.5! text-xs!"
              onClick={() => void loadIdeas(ideas ? ideasPage : 0)}
            >
              Retry
            </Button>
          </div>
        ) : null}

        {!ideas ? (
          ideasLoading ? (
            <p className="text-xs text-zinc-400">Loading ideas…</p>
          ) : null
        ) : ideas.length === 0 ? (
          <p className="text-xs text-zinc-400">No ideas in the database yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse">
              <thead>
                <tr className="border-b border-zinc-200">
                  <th className={`${TH} w-6`} aria-label="expand" />
                  <th className={TH}>Name</th>
                  <th className={TH}>Owner</th>
                  <th className={TH}>Private</th>
                  <th className={TH}>Published</th>
                  <th className={`${TH} text-right`}>Raw score</th>
                  <th className={TH}>Created</th>
                  <th className={TH}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {ideas.map((idea) => {
                  const open = expanded.has(idea.id);
                  const analyze = analyzeState[idea.id];
                  const logs = ideaLogs[idea.id];
                  return (
                    <Fragment key={idea.id}>
                      <tr
                        onClick={() => toggleExpanded(idea.id)}
                        className={`cursor-pointer border-b hover:bg-zinc-50 ${
                          open ? "border-zinc-100 bg-zinc-50" : "border-zinc-100"
                        }`}
                      >
                        <td className={`${TD} pr-0`}>
                          <Chevron open={open} />
                        </td>
                        <td className={TD}>
                          {idea.name.trim() ? (
                            <span className="font-medium text-zinc-900">
                              {idea.name}
                            </span>
                          ) : (
                            <span className="italic text-zinc-400">
                              (untitled)
                            </span>
                          )}
                        </td>
                        <td className={`${TD} whitespace-nowrap`}>
                          {ownerLabel(idea)}
                        </td>
                        <td className={TD}>
                          {idea.is_private ? (
                            <Chip tone="zinc">Private</Chip>
                          ) : (
                            <Dash />
                          )}
                        </td>
                        <td className={TD}>
                          {idea.published ? (
                            <Chip tone="teal">Published</Chip>
                          ) : (
                            <Dash />
                          )}
                        </td>
                        <td className={`tnum ${TD} text-right text-zinc-700`}>
                          {fmtScore(computeDefaultRawScore(idea.scores))}
                        </td>
                        <td className={`tnum ${TD} whitespace-nowrap text-zinc-500`}>
                          {idea.created_at.slice(0, 10)}
                        </td>
                        <td className={`${TD} whitespace-nowrap`}>
                          {analyze?.status === "pending" ? (
                            <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
                              <Spinner />
                              Analyzing…
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5">
                              <Button
                                variant="secondary"
                                className="px-2! py-0.5! text-xs!"
                                title="Run the Unicorn analysis on this idea exactly as it stands (owner's background, no extra questions)"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void runAnalyze(idea.id, "unicorn");
                                }}
                              >
                                🦄 Analyze
                              </Button>
                              <Button
                                variant="secondary"
                                className="px-2! py-0.5! text-xs!"
                                title="Run the Cash Cow analysis on this idea exactly as it stands (owner's background, no extra questions)"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void runAnalyze(idea.id, "cashcow");
                                }}
                              >
                                🐄 Analyze
                              </Button>
                              {analyze?.status === "done" ? <CheckIcon /> : null}
                              {analyze?.status === "error" ? (
                                <span
                                  className="max-w-[220px] truncate text-xs text-red-600"
                                  title={analyze.message}
                                >
                                  {analyze.message}
                                </span>
                              ) : null}
                            </span>
                          )}
                        </td>
                      </tr>
                      {open ? (
                        <tr className="border-b border-zinc-100">
                          <td
                            colSpan={ideaColumns}
                            className="bg-zinc-50 px-4 py-3"
                          >
                            <div className="flex flex-col gap-3">
                              <div>
                                <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                                  Thesis notes
                                </div>
                                {idea.thesis_notes.trim() ? (
                                  <p className="mt-1 max-w-3xl whitespace-pre-wrap text-xs text-zinc-600">
                                    {idea.thesis_notes}
                                  </p>
                                ) : (
                                  <p className="mt-1 text-xs text-zinc-400">
                                    None.
                                  </p>
                                )}
                              </div>
                              {(() => {
                                const clar = normalizeClarifications(
                                  idea.clarifications,
                                );
                                if (!clar.length) return null;
                                return (
                                  <div>
                                    <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                                      Clarifying Q&amp;A
                                    </div>
                                    <dl className="mt-1 max-w-3xl space-y-1.5">
                                      {clar.map((c, i) => (
                                        <div key={i} className="text-xs">
                                          <dt className="font-medium text-zinc-500">
                                            {c.question}
                                          </dt>
                                          <dd className="text-zinc-700">
                                            {c.answer || "(skipped)"}
                                          </dd>
                                        </div>
                                      ))}
                                    </dl>
                                  </div>
                                );
                              })()}
                              <div>
                                <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                                  AI summary
                                </div>
                                {idea.ai_summary.trim() ? (
                                  <p className="mt-1 max-w-3xl whitespace-pre-wrap text-xs text-zinc-600">
                                    {idea.ai_summary}
                                  </p>
                                ) : (
                                  <p className="mt-1 text-xs text-zinc-400">
                                    Not analyzed yet.
                                  </p>
                                )}
                              </div>
                              {(() => {
                                const blocks = normalizeCustomBlocks(
                                  idea.custom,
                                );
                                const entries = Object.entries(blocks ?? {});
                                if (!entries.length) return null;
                                return (
                                  <div>
                                    <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                                      Custom filters (private — owner &amp;
                                      admin only)
                                    </div>
                                    <div className="mt-1 flex max-w-3xl flex-col gap-2">
                                      {entries.map(([fid, block]) => {
                                        const raw = customRawScore(
                                          block.scores,
                                          block.snapshot,
                                        );
                                        const adj = customAdjustedScore(
                                          raw,
                                          block.confidence,
                                        );
                                        const dec = customDecision({
                                          gates: block.gates,
                                          scores: block.scores,
                                          confidence: block.confidence,
                                          snapshot: block.snapshot,
                                        });
                                        return (
                                          <div
                                            key={fid}
                                            className="rounded border border-violet-200 bg-violet-50/40 px-2.5 py-2 text-xs"
                                          >
                                            <div className="flex flex-wrap items-center gap-2">
                                              <span className="font-medium text-violet-900">
                                                {block.snapshot.name}
                                              </span>
                                              <Chip tone="zinc">
                                                gates:{" "}
                                                {customGateStatus(
                                                  block.gates,
                                                  block.snapshot,
                                                )}
                                              </Chip>
                                              <Chip tone="zinc">{dec}</Chip>
                                              <span className="tnum text-zinc-600">
                                                raw {fmtScore(raw)} · adj{" "}
                                                {fmtScore(adj)}
                                              </span>
                                              {block.ai ? (
                                                <span className="text-zinc-400">
                                                  {block.ai.model} ·{" "}
                                                  {block.ai.analyzedAt.slice(
                                                    0,
                                                    10,
                                                  )}
                                                </span>
                                              ) : null}
                                            </div>
                                            <p className="mt-1 text-zinc-500">
                                              “{block.snapshot.question}”
                                            </p>
                                            {block.ai?.summary ? (
                                              <p className="mt-1 whitespace-pre-wrap text-zinc-600">
                                                {block.ai.summary}
                                              </p>
                                            ) : (
                                              <p className="mt-1 text-zinc-400">
                                                Not AI-analyzed in this filter
                                                yet.
                                              </p>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                );
                              })()}
                              <div>
                                <div className="flex items-center gap-2">
                                  <Button
                                    variant="secondary"
                                    className="px-2! py-0.5! text-xs!"
                                    disabled={logs?.loading}
                                    onClick={() => void loadIdeaLogs(idea.id)}
                                  >
                                    {logs?.loading
                                      ? "Loading…"
                                      : logs?.logs
                                        ? "Reload logs"
                                        : "View logs"}
                                  </Button>
                                  {logs?.error ? (
                                    <span className="text-xs text-red-600">
                                      {logs.error}
                                    </span>
                                  ) : null}
                                </div>
                                {logs?.logs ? (
                                  <div className="mt-2">
                                    <LogsTable logs={logs.logs} mode="idea" />
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {ideas && ideas.length < ideasTotal ? (
          <div className="mt-3">
            <Button
              variant="secondary"
              className="text-xs!"
              disabled={ideasLoading}
              onClick={() => void loadIdeas(ideasPage + 1)}
            >
              {ideasLoading ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : null}
      </Section>

      <DiscoveryAbSection />

      <Section
        title="Drafts"
        description="Unfinished work across all users: in-progress Quick Add ideas and custom-filter designs (including running design chains), newest first."
      >
        {draftsError ? (
          <div className="mb-3 flex items-center gap-3 text-xs text-red-600">
            <span>{draftsError}</span>
            <Button
              className="px-2! py-0.5! text-xs!"
              onClick={() => void loadDrafts(drafts ? draftsPage : 0)}
            >
              Retry
            </Button>
          </div>
        ) : null}

        {!drafts ? (
          draftsLoading ? (
            <p className="text-xs text-zinc-400">Loading drafts…</p>
          ) : null
        ) : drafts.length === 0 ? (
          <p className="text-xs text-zinc-400">No drafts right now.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse">
              <thead>
                <tr className="border-b border-zinc-200">
                  <th className={`${TH} w-6`} aria-label="expand" />
                  <th className={TH}>Kind</th>
                  <th className={TH}>Owner</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Content</th>
                  <th className={TH}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((d) => {
                  const open = draftsOpen.has(d.id);
                  const payload = d.payload ?? {};
                  const description =
                    typeof payload.description === "string"
                      ? payload.description
                      : "";
                  const inputs =
                    payload.inputs && typeof payload.inputs === "object"
                      ? (payload.inputs as Record<string, unknown>)
                      : null;
                  const chain =
                    payload.chain && typeof payload.chain === "object"
                      ? (payload.chain as Record<string, unknown>)
                      : null;
                  const resultSpec =
                    payload.resultSpec && typeof payload.resultSpec === "object"
                      ? (payload.resultSpec as Record<string, unknown>)
                      : null;
                  const summary =
                    d.kind === "idea"
                      ? description || "(empty)"
                      : inputs
                        ? `$${Number(inputs.netProfitTarget ?? 0).toLocaleString()}/yr · ${String(
                            inputs.hoursPerDay ?? "?",
                          )}h/day · ${String(inputs.yearsToBuild ?? "?")}yrs`
                        : "(no inputs)";
                  return (
                    <Fragment key={d.id}>
                      <tr
                        onClick={() =>
                          setDraftsOpen((prev) => {
                            const next = new Set(prev);
                            if (next.has(d.id)) next.delete(d.id);
                            else next.add(d.id);
                            return next;
                          })
                        }
                        className={`cursor-pointer border-b hover:bg-zinc-50 ${
                          open ? "border-zinc-100 bg-zinc-50" : "border-zinc-100"
                        }`}
                      >
                        <td className={`${TD} pr-0`}>
                          <Chevron open={open} />
                        </td>
                        <td className={TD}>
                          <Chip tone={d.kind === "filter" ? "zinc" : "teal"}>
                            {d.kind === "filter" ? "🎯 Filter design" : "💡 Idea"}
                          </Chip>
                        </td>
                        <td className={`${TD} whitespace-nowrap`}>
                          {d.owner_email ??
                            (d.anon_key ? (
                              <span
                                className="tnum text-zinc-500"
                                title={d.anon_key}
                              >
                                anon:{d.anon_key.slice(0, 8)}…
                              </span>
                            ) : (
                              <Dash />
                            ))}
                        </td>
                        <td className={TD}>
                          <Chip
                            tone={
                              d.status === "failed"
                                ? "red"
                                : d.status === "ready" ||
                                    d.status === "designing"
                                  ? "teal"
                                  : "zinc"
                            }
                          >
                            {d.status === "designing"
                              ? `designing (stage ${String(chain?.stage ?? "?")})`
                              : d.status}
                          </Chip>
                        </td>
                        <td className={`${TD} max-w-[320px]`}>
                          <span className="block truncate text-zinc-600">
                            {summary}
                          </span>
                        </td>
                        <td className={`tnum ${TD} whitespace-nowrap text-zinc-500`}>
                          {fmtTime(d.updated_at)}
                        </td>
                      </tr>
                      {open ? (
                        <tr className="border-b border-zinc-100">
                          <td colSpan={6} className="bg-zinc-50 px-4 py-3">
                            <div className="flex flex-col gap-3 text-xs">
                              {d.kind === "idea" ? (
                                <div>
                                  <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                                    Draft description
                                  </div>
                                  <p className="mt-1 max-w-3xl whitespace-pre-wrap text-zinc-600">
                                    {description || "(empty)"}
                                  </p>
                                </div>
                              ) : (
                                <>
                                  <div>
                                    <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                                      Founder goals
                                    </div>
                                    <p className="mt-1 text-zinc-600">
                                      {summary}
                                      {inputs &&
                                      typeof inputs.otherQualities === "string" &&
                                      inputs.otherQualities.trim()
                                        ? ` · "${inputs.otherQualities}"`
                                        : ""}
                                    </p>
                                  </div>
                                  {chain && typeof chain.error === "string" ? (
                                    <p className="text-red-600">
                                      Error: {chain.error}
                                    </p>
                                  ) : null}
                                  {resultSpec ? (
                                    <p className="text-zinc-600">
                                      Result: “
                                      {typeof resultSpec.name === "string"
                                        ? resultSpec.name
                                        : "?"}
                                      ” — awaiting acceptance.
                                    </p>
                                  ) : null}
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {drafts && drafts.length < draftsTotal ? (
          <div className="mt-3">
            <Button
              variant="secondary"
              className="text-xs!"
              disabled={draftsLoading}
              onClick={() => void loadDrafts(draftsPage + 1)}
            >
              {draftsLoading ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : null}
      </Section>

      <Section
        title="Recent activity"
        description="Latest submission telemetry across all ideas, newest first."
      >
        {activityError ? (
          <div className="mb-3 flex items-center gap-3 text-xs text-red-600">
            <span>{activityError}</span>
            <Button
              className="px-2! py-0.5! text-xs!"
              onClick={() => void loadActivity(activity ? activityPage : 0)}
            >
              Retry
            </Button>
          </div>
        ) : null}

        {!activity ? (
          activityLoading ? (
            <p className="text-xs text-zinc-400">Loading activity…</p>
          ) : null
        ) : (
          <LogsTable logs={activity} mode="global" />
        )}

        {activity && activity.length < activityTotal ? (
          <div className="mt-3">
            <Button
              variant="secondary"
              className="text-xs!"
              disabled={activityLoading}
              onClick={() => void loadActivity(activityPage + 1)}
            >
              {activityLoading ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : null}
      </Section>

      <Section
        title="CV uploads"
        description="Every CV a founder uploaded — retained even after they clear their background. Download links are signed and expire after an hour."
      >
        {cvError ? (
          <div className="mb-3 flex items-center gap-3 text-xs text-red-600">
            <span>{cvError}</span>
            <Button
              className="px-2! py-0.5! text-xs!"
              onClick={() => void loadCvUploads(cvUploads ? cvPage : 0)}
            >
              Retry
            </Button>
          </div>
        ) : null}

        {!cvUploads ? (
          cvLoading ? (
            <p className="text-xs text-zinc-400">Loading CV uploads…</p>
          ) : null
        ) : cvUploads.length === 0 ? (
          <p className="text-xs text-zinc-400">No CVs uploaded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] border-collapse text-xs">
              <thead>
                <tr className="border-b border-zinc-200 text-left text-zinc-500">
                  <th className="py-1.5 pr-3 font-medium">Uploaded</th>
                  <th className="py-1.5 pr-3 font-medium">Founder</th>
                  <th className="py-1.5 pr-3 font-medium">File</th>
                  <th className="py-1.5 pr-3 font-medium">Size</th>
                  <th className="py-1.5 pr-3 font-medium">IP / country</th>
                  <th className="py-1.5 pr-3 font-medium">Model</th>
                  <th className="py-1.5 font-medium">Content</th>
                </tr>
              </thead>
              <tbody>
                {cvUploads.map((u) => {
                  const isOpen = cvOpen.has(u.id);
                  return (
                    <Fragment key={u.id}>
                      <tr className="border-b border-zinc-100 align-top">
                        <td className="tnum py-1.5 pr-3 whitespace-nowrap text-zinc-600">
                          {fmtTime(u.created_at)}
                        </td>
                        <td className="py-1.5 pr-3 text-zinc-700">
                          {u.owner_email ??
                            (u.anon_key
                              ? `anon:${u.anon_key.slice(0, 8)}`
                              : "—")}
                          <span className="ml-1 text-zinc-400">
                            ({u.founder_slot === "primary"
                              ? "primary"
                              : "co-founder"})
                          </span>
                        </td>
                        <td className="py-1.5 pr-3">
                          {u.download_url ? (
                            <a
                              href={u.download_url}
                              target="_blank"
                              rel="noreferrer"
                              className="font-medium text-teal-700 underline"
                            >
                              {u.filename || "download"}
                            </a>
                          ) : u.source_url ? (
                            <a
                              href={u.source_url}
                              target="_blank"
                              rel="noreferrer"
                              className="max-w-[220px] truncate font-medium text-teal-700 underline"
                              title={u.source_url}
                            >
                              {u.source_url.replace(/^https?:\/\//, "").slice(0, 40)}
                            </a>
                          ) : (
                            <span className="text-zinc-400">
                              {u.filename || "(text only)"}
                            </span>
                          )}
                        </td>
                        <td className="tnum py-1.5 pr-3 whitespace-nowrap text-zinc-500">
                          {u.size_bytes
                            ? `${Math.round(u.size_bytes / 1024)} KB`
                            : "—"}
                        </td>
                        <td className="py-1.5 pr-3 text-zinc-500">
                          <span className="font-mono">{u.ip ?? "—"}</span>
                          {u.country ? ` · ${u.country}` : ""}
                        </td>
                        <td className="py-1.5 pr-3 text-zinc-500">
                          {u.model ?? "—"}
                        </td>
                        <td className="py-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              setCvOpen((prev) => {
                                const next = new Set(prev);
                                if (next.has(u.id)) next.delete(u.id);
                                else next.add(u.id);
                                return next;
                              })
                            }
                            className="text-teal-700 underline underline-offset-2"
                          >
                            {isOpen ? "Hide" : "View"}
                          </button>
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr className="border-b border-zinc-100 bg-zinc-50">
                          <td colSpan={7} className="px-3 py-3">
                            <div className="grid gap-4 md:grid-cols-2">
                              <div>
                                <div className="mb-1 font-medium text-zinc-600">
                                  AI summary (shown to the founder)
                                </div>
                                <p className="whitespace-pre-wrap text-zinc-700">
                                  {u.ai_summary || "—"}
                                </p>
                              </div>
                              <div>
                                <div className="mb-1 font-medium text-zinc-600">
                                  Raw extracted text
                                </div>
                                <p className="max-h-64 overflow-y-auto whitespace-pre-wrap text-zinc-600">
                                  {u.extracted_text || "—"}
                                </p>
                              </div>
                            </div>
                            <div className="mt-2 text-[11px] text-zinc-400">
                              User agent: {truncate(u.user_agent ?? "—", 120)}
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {cvUploads && cvUploads.length < cvTotal ? (
          <div className="mt-3">
            <Button
              variant="secondary"
              className="text-xs!"
              disabled={cvLoading}
              onClick={() => void loadCvUploads(cvPage + 1)}
            >
              {cvLoading ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : null}
      </Section>
    </div>
  );
}
