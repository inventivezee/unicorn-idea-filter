// Server-side idea persistence, shared by the CRUD and analyze routes.
// Authorization model: a row belongs to a signed-in owner (owner_id) or an
// anonymous device (anon_key while owner_id is null); admins can touch all.
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeDefaultRawScore, computePublished, ideaToWritableRow, rowToIdea } from "./types";
import type { IdeaRow } from "./types";
import {
  CC_CRITERION_IDS,
  CC_GATE_IDS,
  normalizeCashCow,
  normalizeCustomBlocks,
} from "../types";
import type {
  CashCowBlock,
  CcAnalyzeResponse,
  CustomBlock,
  CustomSpecSnapshot,
  Idea,
} from "../types";

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
    cashcow: row.cashcow ?? null,
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
  // cashcow.ai never regresses: an incoming block without ai — including a
  // fully-cleared (null) block — must not erase a server-persisted analysis
  // (same guarantee as the unicorn ai). Gates/scores/confidence/validation
  // are last-writer-wins, matching the unicorn fields.
  if ("cashcow" in row) {
    const incoming = row.cashcow as CashCowBlock | null;
    if (!incoming?.ai) {
      const existingCc = normalizeCashCow(existing.cashcow);
      if (existingCc?.ai) {
        if (incoming) {
          incoming.ai = existingCc.ai;
        } else {
          // User cleared every answer but the analysis stays.
          row.cashcow = { ...emptyCashCowBlock(), ai: existingCc.ai };
        }
      }
    }
  }
  // custom[filterId].ai never regresses either (same rule as cashcow.ai).
  if ("custom" in row) {
    const incoming = row.custom as Record<string, CustomBlock> | null;
    const existingCustom = normalizeCustomBlocks(existing.custom);
    if (existingCustom) {
      const merged: Record<string, CustomBlock> = { ...(incoming ?? {}) };
      for (const [fid, block] of Object.entries(existingCustom)) {
        if (!block.ai) continue;
        const inc = merged[fid];
        if (!inc) {
          // Cleared block but a persisted analysis exists — keep the analysis.
          merged[fid] = { ...block };
        } else if (!inc.ai && inc.snapshot.version === block.snapshot.version) {
          // Only reattach onto the SAME spec version — grafting a newer
          // analysis onto an older-version block would misattribute ids.
          inc.ai = block.ai;
        }
      }
      row.custom = Object.keys(merged).length ? merged : null;
    }
  }
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
    cashcow: "cashcow" in row ? row.cashcow : existing.cashcow,
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
    cashcow: existing.cashcow,
  });
  row.raw_score = computeDefaultRawScore(
    (row.scores ?? existing.scores ?? {}) as Record<string, unknown>,
  );

  await admin.from("ideas").update(row).eq("id", ideaId);
}

/**
 * Persist a Cash Cow analysis onto an idea row server-side (same guarantee as
 * applyAnalysisToIdea: a closed tab can't lose a paid-for analysis). Fill-blanks
 * merge within the cashcow block — synced manual edits win; the AI only fills
 * what's empty. Shared metadata fields fill blanks exactly like the unicorn
 * path. Does not touch unicorn gates/scores or the published flag (the public
 * feed is driven by the unicorn instrument).
 */
export async function applyCashCowToIdea(
  admin: SupabaseClient,
  ideaId: string,
  analysis: CcAnalyzeResponse,
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
  const metadata = analysis.metadata as unknown as Record<string, string>;
  for (const [appField, column] of Object.entries(metaMap)) {
    const proposal = metadata?.[appField]?.trim();
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

  // Merge into the existing cashcow block, filling only what's blank.
  const current: CashCowBlock =
    normalizeCashCow(existing.cashcow) ?? emptyCashCowBlock();
  for (const gid of CC_GATE_IDS) {
    if (current.gates[gid] === null) {
      const v = analysis.gates[gid]?.value;
      current.gates[gid] = v === "Y" || v === "N" ? v : null;
    }
  }
  for (const cid of CC_CRITERION_IDS) {
    if (typeof current.scores[cid] !== "number") {
      const s = analysis.scores[cid]?.score;
      current.scores[cid] = typeof s === "number" ? s : null;
    }
  }
  if (current.confidence === null) current.confidence = analysis.confidence;
  if (!current.validationTest30d.trim()) {
    current.validationTest30d = analysis.validationTest30d;
  }
  current.ai = {
    summary: analysis.summary,
    gateRationales: Object.fromEntries(
      Object.entries(analysis.gates).map(([k, v]) => [k, v.rationale]),
    ),
    scoreRationales: Object.fromEntries(
      Object.entries(analysis.scores).map(([k, v]) => [k, v.rationale]),
    ),
    confidenceRationale: analysis.confidenceRationale,
    needsFounderConfirmation: analysis.needsFounderConfirmation,
    provider: analysis.provider,
    model: analysis.model,
    analyzedAt: new Date().toISOString(),
    webSearches: analysis.webSearches,
  };
  row.cashcow = current;
  // A cash-cow analysis publishes the idea, same as a unicorn one.
  row.published = computePublished({
    gates: (existing.gates ?? {}) as Record<string, unknown>,
    scores: (existing.scores ?? {}) as Record<string, unknown>,
    ai: existing.ai,
    cashcow: current,
  });

  // Migration-drift tolerant (like insertIdea/patchIdea): if the cashcow
  // column doesn't exist yet, strip it and still land the metadata fills.
  const { error } = await writeToleratingMissingColumns<IdeaRow>(row, (r) =>
    admin.from("ideas").update(r).eq("id", ideaId).select("*").single<IdeaRow>(),
  );
  if (error) console.error("cashcow analysis persist failed", error.message);
}

function emptyCashCowBlock(): CashCowBlock {
  return {
    gates: Object.fromEntries(
      CC_GATE_IDS.map((id) => [id, null]),
    ) as CashCowBlock["gates"],
    scores: Object.fromEntries(
      CC_CRITERION_IDS.map((id) => [id, null]),
    ) as CashCowBlock["scores"],
    confidence: null,
    validationTest30d: "",
  };
}

/**
 * Persist a custom-filter analysis onto an idea (same server-side guarantee
 * as the other instruments). Fill-blanks within that filter's block; shared
 * metadata fields fill blanks too. NEVER touches published — custom verdicts
 * are private to the founder (and admins).
 */
export async function applyCustomToIdea(
  admin: SupabaseClient,
  ideaId: string,
  filterId: string,
  snapshot: CustomSpecSnapshot,
  analysis: {
    summary: string;
    metadata: Record<string, string>;
    founderProfile: string;
    gates: Record<string, { value: string; rationale: string }>;
    scores: Record<string, { score: number; rationale: string }>;
    confidence: 0.5 | 0.75 | 1.0;
    confidenceRationale: string;
    validationTest30d: string;
    needsFounderConfirmation: string[];
    provider: "anthropic" | "openai";
    model: string;
    webSearches: number;
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

  const blocks = normalizeCustomBlocks(existing.custom) ?? {};
  const current: CustomBlock = blocks[filterId] ?? {
    gates: Object.fromEntries(snapshot.gates.map((g) => [g.id, null])),
    scores: Object.fromEntries(snapshot.criteria.map((c) => [c.id, null])),
    confidence: null,
    validationTest30d: "",
    snapshot,
  };
  // A stale in-flight analysis (run against an OLDER spec version than the
  // block already holds) must never clobber newer data — drop it.
  if (current.snapshot.version > snapshot.version) return;
  // A newer spec version replaces the block wholesale (old ids don't align).
  const sameVersion = current.snapshot.version === snapshot.version;
  const target: CustomBlock = sameVersion
    ? current
    : {
        gates: Object.fromEntries(snapshot.gates.map((g) => [g.id, null])),
        scores: Object.fromEntries(snapshot.criteria.map((c) => [c.id, null])),
        confidence: null,
        validationTest30d: "",
        snapshot,
      };

  for (const g of snapshot.gates) {
    if (target.gates[g.id] === null || target.gates[g.id] === undefined) {
      const v = analysis.gates[g.id]?.value;
      target.gates[g.id] = v === "Y" || v === "N" ? v : null;
    }
  }
  for (const c of snapshot.criteria) {
    if (typeof target.scores[c.id] !== "number") {
      const sc = analysis.scores[c.id]?.score;
      target.scores[c.id] = typeof sc === "number" ? sc : null;
    }
  }
  if (target.confidence === null) target.confidence = analysis.confidence;
  if (!target.validationTest30d.trim()) {
    target.validationTest30d = analysis.validationTest30d;
  }
  target.snapshot = snapshot;
  target.ai = {
    summary: analysis.summary,
    gateRationales: Object.fromEntries(
      Object.entries(analysis.gates).map(([k, v]) => [k, v.rationale]),
    ),
    scoreRationales: Object.fromEntries(
      Object.entries(analysis.scores).map(([k, v]) => [k, v.rationale]),
    ),
    confidenceRationale: analysis.confidenceRationale,
    needsFounderConfirmation: analysis.needsFounderConfirmation,
    provider: analysis.provider,
    model: analysis.model,
    analyzedAt: new Date().toISOString(),
    webSearches: analysis.webSearches,
  };
  blocks[filterId] = target;
  row.custom = blocks;
  // Deliberately NOT recomputing published: custom verdicts are private.

  const { error } = await writeToleratingMissingColumns<IdeaRow>(row, (r) =>
    admin.from("ideas").update(r).eq("id", ideaId).select("*").single<IdeaRow>(),
  );
  if (error) console.error("custom analysis persist failed", error.message);
}
