// Drafts: list + create unfinished work (Quick Add ideas, filter designs).
// Owned by the signed-in user or the anonymous device key; admin sees all
// via /api/admin/drafts, not here.
import { guardOrigin, guardRequest, readJsonBody } from "@/lib/ai/server";
import {
  DraftAccessError,
  createDraft,
  listOwnedDrafts,
  type DraftActor,
  type DraftKind,
} from "@/lib/db/drafts";
import {
  adminClient,
  anonKeyFromBody,
  cloudConfigured,
  resolveCaller,
} from "@/lib/supabase/server";

function notConfigured(): Response {
  return Response.json(
    { error: "Cloud features are not configured on this deployment." },
    { status: 503 },
  );
}

function errorResponse(err: unknown): Response {
  if (err instanceof DraftAccessError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : "Unknown error";
  return Response.json({ error: message }, { status: 500 });
}

async function actorFor(anonKey: string | null): Promise<DraftActor> {
  const caller = await resolveCaller();
  return {
    userId: caller.user?.id ?? null,
    anonKey,
    isAdmin: caller.isAdmin,
  };
}

function kindFrom(value: unknown): DraftKind | undefined {
  return value === "idea" || value === "filter" ? value : undefined;
}

/** List the caller's drafts, optionally filtered by kind. */
export async function GET(request: Request) {
  const guard = guardOrigin(request);
  if (guard) return guard;
  if (!cloudConfigured()) return notConfigured();
  try {
    const url = new URL(request.url);
    const anonKey = anonKeyFromBody(url.searchParams.get("anon_key"));
    const actor = await actorFor(anonKey);
    const drafts = await listOwnedDrafts(
      adminClient(),
      actor,
      kindFrom(url.searchParams.get("kind")),
    );
    return Response.json({ drafts });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Create a draft. Body: { kind, payload, anonKey? }. Rate-limited: row
 *  creation is the abuse surface (autosave UPDATEs are not). */
export async function POST(request: Request) {
  const guard = guardRequest(request);
  if (guard) return guard;
  if (!cloudConfigured()) return notConfigured();
  try {
    const body = await readJsonBody(request);
    if (!body) {
      return Response.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const kind = kindFrom(body.kind);
    if (!kind) {
      return Response.json({ error: "Unknown draft kind." }, { status: 400 });
    }
    const payload =
      body.payload &&
      typeof body.payload === "object" &&
      !Array.isArray(body.payload)
        ? (body.payload as Record<string, unknown>)
        : {};
    const actor = await actorFor(anonKeyFromBody(body.anonKey));
    const draft = await createDraft(adminClient(), actor, kind, payload);
    return Response.json({ draft });
  } catch (err) {
    return errorResponse(err);
  }
}
