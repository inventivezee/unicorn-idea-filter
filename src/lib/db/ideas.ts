// Server-side idea persistence, shared by the CRUD and analyze routes.
// Authorization model: a row belongs to a signed-in owner (owner_id) or an
// anonymous device (anon_key while owner_id is null); admins can touch all.
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeDefaultRawScore, computePublished, ideaToWritableRow, rowToIdea } from "./types";
import type { IdeaRow } from "./types";
import type { Idea } from "../types";

export class IdeaAccessError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface IdeaActor {
  userId: string | null;
  anonKey: string | null;
  isAdmin: boolean;
  subscribed: boolean;
}

function assertActor(actor: IdeaActor): void {
  if (!actor.userId && !actor.anonKey) {
    throw new IdeaAccessError(
      "Missing identity — sign in or retry from the app.",
      401,
    );
  }
}

export async function listIdeas(
  admin: SupabaseClient,
  actor: IdeaActor,
): Promise<ReturnType<typeof rowToIdea>[]> {
  assertActor(actor);
  const query = admin.from("ideas").select("*").order("updated_at", {
    ascending: false,
  });
  const { data, error } = actor.userId
    ? await query.eq("owner_id", actor.userId)
    : await query.is("owner_id", null).eq("anon_key", actor.anonKey!);
  if (error) throw new IdeaAccessError(error.message, 500);
  return ((data ?? []) as IdeaRow[]).map(rowToIdea);
}

export async function fetchOwnedIdea(
  admin: SupabaseClient,
  actor: IdeaActor,
  id: string,
): Promise<IdeaRow> {
  assertActor(actor);
  const { data, error } = await admin
    .from("ideas")
    .select("*")
    .eq("id", id)
    .maybeSingle<IdeaRow>();
  if (error) throw new IdeaAccessError(error.message, 500);
  if (!data) throw new IdeaAccessError("Idea not found.", 404);
  const owns = actor.userId
    ? data.owner_id === actor.userId
    : data.owner_id === null && data.anon_key === actor.anonKey;
  if (!owns && !actor.isAdmin) {
    throw new IdeaAccessError("You don't have access to this idea.", 403);
  }
  return data;
}

/**
 * PGRST204 = PostgREST can't find a column named in the payload — the deploy
 * is ahead of the database (an unapplied migration). Returns the column name.
 */
function missingColumn(error: {
  code?: string;
  message?: string;
}): string | null {
  if (error.code !== "PGRST204") return null;
  return /'([^']+)' column/.exec(error.message ?? "")?.[1] ?? null;
}

/**
 * Run a write, and when the database rejects a column it doesn't have yet,
 * strip that field and retry (up to 3 columns). Migration drift must degrade
 * the newest feature — never lose the user's idea.
 */
async function writeToleratingMissingColumns<T>(
  row: Record<string, unknown>,
  write: (row: Record<string, unknown>) => PromiseLike<{
    data: T | null;
    error: { code?: string; message: string } | null;
  }>,
): Promise<{ data: T | null; error: { code?: string; message: string } | null }> {
  let result = await write(row);
  for (let i = 0; i < 3 && result.error; i++) {
    const column = missingColumn(result.error);
    if (!column || !(column in row)) break;
    console.error(
      `ideas.${column} column missing in the database — run the latest migrations in supabase/migrations (see SETUP.md). Saving the idea without it.`,
    );
    delete row[column];
    result = await write(row);
  }
  return result;
}

export async function insertIdea(
  admin: SupabaseClient,
  actor: IdeaActor,
  fields: Partial<Idea>,
): Promise<ReturnType<typeof rowToIdea>> {
  assertActor(actor);
  const row = ideaToWritableRow(fields);
  // Optimistic client inserts carry their own uuid so navigation can happen
  // before the network round-trip completes.
  if (
    typeof fields.id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      fields.id,
    )
  ) {
    row.id = fields.id;
  }
  row.owner_id = actor.userId;
  row.anon_key = actor.userId ? null : actor.anonKey;
  row.published = computePublished({
    gates: (row.gates ?? {}) as Record<string, unknown>,
    scores: (row.scores ?? {}) as Record<string, unknown>,
    ai: row.ai ?? null,
  });
  row.raw_score = computeDefaultRawScore(
    (row.scores ?? {}) as Record<string, unknown>,
  );
  const { data, error } = await writeToleratingMissingColumns<IdeaRow>(
    row,
    (r) => admin.from("ideas").insert(r).select("*").single<IdeaRow>(),
  );
  if (error) {
    // 23505 = duplicate key: the row already exists (import retry or an
    // optimistic create racing a sync) — treat as success for idempotency.
    if (error.code === "23505" && typeof row.id === "string") {
      const { data: existing } = await admin
        .from("ideas")
        .select("*")
        .eq("id", row.id)
        .maybeSingle<IdeaRow>();
      if (existing) return rowToIdea(existing);
    }
    throw new IdeaAccessError(error.message, 500);
  }
  if (!data) throw new IdeaAccessError("Insert returned no row.", 500);
  return rowToIdea(data);
}

export async function patchIdea(
  admin: SupabaseClient,
  actor: IdeaActor,
  id: string,
  patch: Partial<Idea>,
  isPrivate: boolean | undefined,
): Promise<ReturnType<typeof rowToIdea>> {
  const existing = await fetchOwnedIdea(admin, actor, id);

  const row = ideaToWritableRow(patch);
  if (isPrivate !== undefined) {
    if (isPrivate && !existing.is_private && !actor.subscribed && !actor.isAdmin) {
      throw new IdeaAccessError(
        "Private ideas are a subscriber feature — upgrade to keep this idea out of the public feed.",
        402,
      );
    }
    row.is_private = isPrivate;
  }
  row.updated_at = new Date().toISOString();
  row.published = computePublished({
    gates: (row.gates ?? existing.gates ?? {}) as Record<string, unknown>,
    scores: (row.scores ?? existing.scores ?? {}) as Record<string, unknown>,
    ai: row.ai !== undefined ? row.ai : existing.ai,
  });
  row.raw_score = computeDefaultRawScore(
    (row.scores ?? existing.scores ?? {}) as Record<string, unknown>,
  );

  const { data, error } = await writeToleratingMissingColumns<IdeaRow>(
    row,
    (r) =>
      admin.from("ideas").update(r).eq("id", id).select("*").single<IdeaRow>(),
  );
  if (error) throw new IdeaAccessError(error.message, 500);
  if (!data) throw new IdeaAccessError("Update returned no row.", 500);
  return rowToIdea(data);
}

export async function removeIdea(
  admin: SupabaseClient,
  actor: IdeaActor,
  id: string,
): Promise<void> {
  await fetchOwnedIdea(admin, actor, id);
  const { error } = await admin.from("ideas").delete().eq("id", id);
  if (error) throw new IdeaAccessError(error.message, 500);
}

/**
 * Persist an analysis result onto an idea row server-side, so a closed tab
 * can't lose a paid-for analysis. Fill-blanks merge: the AI only writes gate
 * answers, scores, and metadata the row doesn't already have — synced manual
 * edits always win. The client applies its own finer-grained merge on top.
 */
export async function applyAnalysisToIdea(
  admin: SupabaseClient,
  ideaId: string,
  analysis: {
    metadata?: Record<string, string>;
    founderProfile?: string;
    gates?: Record<string, { value: string }>;
    scores?: Record<string, { score: number }>;
    confidence?: number;
    validationTest30d?: string;
    ai?: unknown;
    aiSummary?: string;
  },
): Promise<void> {
  const { data: existing } = await admin
    .from("ideas")
    .select("*")
    .eq("id", ideaId)
    .maybeSingle<IdeaRow>();
  if (!existing) return;

  const row: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  const metaMap: Record<string, string> = {
    name: "name",
    domain: "domain",
    businessModel: "business_model",
    buyerICP: "buyer_icp",
    initialWedge: "initial_wedge",
  };
  for (const [appField, column] of Object.entries(metaMap)) {
    const proposal = analysis.metadata?.[appField]?.trim();
    const current = (existing as unknown as Record<string, unknown>)[column];
    if (proposal && (typeof current !== "string" || !current.trim())) {
      row[column] = proposal;
    }
  }

  if (
    analysis.founderProfile?.trim() &&
    !(existing.founder_profile ?? "").trim()
  ) {
    row.founder_profile = analysis.founderProfile.trim();
  }

  if (analysis.gates) {
    const gates = { ...(existing.gates ?? {}) } as Record<string, unknown>;
    for (const [gid, g] of Object.entries(analysis.gates)) {
      const current = gates[gid];
      if (current !== "Y" && current !== "N") {
        gates[gid] = g.value === "Y" || g.value === "N" ? g.value : null;
      }
    }
    row.gates = gates;
  }
  if (analysis.scores) {
    const scores = { ...(existing.scores ?? {}) } as Record<string, unknown>;
    for (const [cid, s] of Object.entries(analysis.scores)) {
      if (typeof scores[cid] !== "number") scores[cid] = s.score;
    }
    row.scores = scores;
  }
  if (analysis.confidence !== undefined && existing.confidence === null) {
    row.confidence = analysis.confidence;
  }
  if (
    analysis.validationTest30d &&
    !(existing.validation_test_30d ?? "").trim()
  ) {
    row.validation_test_30d = analysis.validationTest30d;
  }
  if (analysis.ai !== undefined) {
    row.ai = analysis.ai;
    row.ai_summary = analysis.aiSummary ?? "";
  }

  row.published = computePublished({
    gates: (row.gates ?? existing.gates ?? {}) as Record<string, unknown>,
    scores: (row.scores ?? existing.scores ?? {}) as Record<string, unknown>,
    ai: row.ai !== undefined ? row.ai : existing.ai,
  });
  row.raw_score = computeDefaultRawScore(
    (row.scores ?? existing.scores ?? {}) as Record<string, unknown>,
  );

  await admin.from("ideas").update(row).eq("id", ideaId);
}
