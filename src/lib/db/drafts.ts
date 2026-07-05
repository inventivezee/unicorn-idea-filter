// Drafts: unfinished ideas (Quick Add state) and unfinished custom-filter
// designs (inputs + the three-model design chain). Service-role-only access —
// every caller goes through these helpers, which enforce ownership the same
// way ideas do (owner_id for signed-in users, anon_key for devices).
import type { SupabaseClient } from "@supabase/supabase-js";

export type DraftKind = "idea" | "filter";
export type DraftStatus = "draft" | "designing" | "ready" | "failed";

export interface DraftRow {
  id: string;
  owner_id: string | null;
  anon_key: string | null;
  kind: DraftKind;
  status: DraftStatus;
  payload: Record<string, unknown>;
  rev: number;
  created_at: string;
  updated_at: string;
}

export class DraftAccessError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface DraftActor {
  userId: string | null;
  anonKey: string | null;
  isAdmin: boolean;
}

function assertActor(actor: DraftActor): void {
  if (!actor.userId && !actor.anonKey && !actor.isAdmin) {
    throw new DraftAccessError("No identity supplied.", 401);
  }
}

const MAX_DRAFTS_PER_OWNER = 20;
// User-authored drafts (autosaves) stay small; the design chain's own state
// carries three raw model designs plus the founder background, so its
// server-authored writes get more headroom — every piece it stores is
// individually truncated, keeping the worst case well under this bound.
const MAX_PAYLOAD_CHARS = 100_000;
const MAX_CHAIN_PAYLOAD_CHARS = 250_000;

function checkPayload(
  payload: Record<string, unknown>,
  max = MAX_PAYLOAD_CHARS,
): void {
  if (JSON.stringify(payload).length > max) {
    throw new DraftAccessError("Draft is too large to save.", 413);
  }
}

/** Postgres unique violation — the partial one-designing-per-owner index. */
function isUniqueViolation(error: { code?: string }): boolean {
  return error.code === "23505";
}

function ownedBy(row: DraftRow, actor: DraftActor): boolean {
  return actor.userId
    ? row.owner_id === actor.userId
    : row.owner_id === null && row.anon_key === actor.anonKey;
}

export async function fetchOwnedDraft(
  admin: SupabaseClient,
  actor: DraftActor,
  id: string,
): Promise<DraftRow> {
  assertActor(actor);
  const { data, error } = await admin
    .from("drafts")
    .select("*")
    .eq("id", id)
    .maybeSingle<DraftRow>();
  if (error) throw new DraftAccessError(error.message, 500);
  if (!data) throw new DraftAccessError("Draft not found.", 404);
  if (!ownedBy(data, actor) && !actor.isAdmin) {
    throw new DraftAccessError("You don't have access to this draft.", 403);
  }
  return data;
}

export async function listOwnedDrafts(
  admin: SupabaseClient,
  actor: DraftActor,
  kind?: DraftKind,
): Promise<DraftRow[]> {
  assertActor(actor);
  let query = admin
    .from("drafts")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(MAX_DRAFTS_PER_OWNER);
  query = actor.userId
    ? query.eq("owner_id", actor.userId)
    : query.is("owner_id", null).eq("anon_key", actor.anonKey);
  if (kind) query = query.eq("kind", kind);
  const { data, error } = await query;
  if (error) throw new DraftAccessError(error.message, 500);
  return (data ?? []) as DraftRow[];
}

export async function createDraft(
  admin: SupabaseClient,
  actor: DraftActor,
  kind: DraftKind,
  payload: Record<string, unknown>,
  status: DraftStatus = "draft",
): Promise<DraftRow> {
  assertActor(actor);
  checkPayload(
    payload,
    status === "designing" ? MAX_CHAIN_PAYLOAD_CHARS : MAX_PAYLOAD_CHARS,
  );
  const existing = await listOwnedDrafts(admin, actor);
  if (existing.length >= MAX_DRAFTS_PER_OWNER) {
    throw new DraftAccessError(
      `You have ${MAX_DRAFTS_PER_OWNER} drafts already — finish or delete some first.`,
      409,
    );
  }
  const { data, error } = await admin
    .from("drafts")
    .insert({
      owner_id: actor.userId,
      anon_key: actor.userId ? null : actor.anonKey,
      kind,
      status,
      payload,
    })
    .select("*")
    .single<DraftRow>();
  if (error) {
    if (isUniqueViolation(error)) {
      throw new DraftAccessError(
        "A filter design is already running — open it from Your filters.",
        409,
      );
    }
    throw new DraftAccessError(error.message, 500);
  }
  return data;
}

/**
 * Last-writer-wins update for user-typed draft content. `onlyWhenStatus`
 * makes the write conditional IN the statement (atomic) — an autosave racing
 * a status transition (draft → designing) must lose, never strip chain state.
 */
export async function updateDraft(
  admin: SupabaseClient,
  actor: DraftActor,
  id: string,
  patch: { payload?: Record<string, unknown>; status?: DraftStatus },
  onlyWhenStatus?: DraftStatus,
): Promise<DraftRow> {
  const existing = await fetchOwnedDraft(admin, actor, id);
  if (patch.payload) checkPayload(patch.payload);
  let query = admin
    .from("drafts")
    .update({
      ...(patch.payload ? { payload: patch.payload } : {}),
      ...(patch.status ? { status: patch.status } : {}),
      rev: existing.rev + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (onlyWhenStatus) query = query.eq("status", onlyWhenStatus);
  const { data, error } = await query.select("*").maybeSingle<DraftRow>();
  if (error) {
    if (isUniqueViolation(error)) {
      throw new DraftAccessError(
        "A filter design is already running — open it from Your filters.",
        409,
      );
    }
    throw new DraftAccessError(error.message, 500);
  }
  if (!data) {
    throw new DraftAccessError(
      "This draft changed state — reload and try again.",
      409,
    );
  }
  return data;
}

/**
 * Compare-and-swap update for the design chain: only applies when the row's
 * rev still matches what the caller read. Returns the updated row, or null
 * when another tab/poll advanced the chain first (caller should re-read).
 */
export async function casUpdateDraft(
  admin: SupabaseClient,
  id: string,
  expectedRev: number,
  patch: { payload?: Record<string, unknown>; status?: DraftStatus },
): Promise<DraftRow | null> {
  // Chain-authored writes: bigger cap (individually-truncated pieces), and a
  // cap breach must surface as a normal error, not block the CAS forever —
  // callers treat 413s as fatal-for-this-job.
  if (patch.payload) checkPayload(patch.payload, MAX_CHAIN_PAYLOAD_CHARS);
  const { data, error } = await admin
    .from("drafts")
    .update({
      ...(patch.payload ? { payload: patch.payload } : {}),
      ...(patch.status ? { status: patch.status } : {}),
      rev: expectedRev + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("rev", expectedRev)
    .select("*")
    .maybeSingle<DraftRow>();
  if (error) {
    if (isUniqueViolation(error)) {
      throw new DraftAccessError(
        "A filter design is already running — open it from Your filters.",
        409,
      );
    }
    throw new DraftAccessError(error.message, 500);
  }
  return data ?? null;
}

/**
 * Delete a draft. `expectStatus` makes the DELETE conditional in the
 * statement — housekeeping deletes computed from a snapshot (boot cleanup)
 * must be no-ops if the row moved on (e.g. a stale failed row another tab
 * just flipped to designing). User-intent deletes pass no expectation.
 */
export async function deleteDraft(
  admin: SupabaseClient,
  actor: DraftActor,
  id: string,
  expectStatus?: DraftStatus,
): Promise<void> {
  await fetchOwnedDraft(admin, actor, id);
  let query = admin.from("drafts").delete().eq("id", id);
  if (expectStatus) query = query.eq("status", expectStatus);
  const { error } = await query;
  if (error) throw new DraftAccessError(error.message, 500);
}
