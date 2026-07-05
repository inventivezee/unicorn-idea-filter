// Single-draft operations: read, update (autosave), delete (finished or
// discarded). Ownership enforced in the db layer.
import { cancelChain, chainStateFrom } from "@/lib/ai/design-chain";
import { guardOrigin, readJsonBody } from "@/lib/ai/server";
import {
  DraftAccessError,
  deleteDraft,
  fetchOwnedDraft,
  updateDraft,
  type DraftActor,
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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!cloudConfigured()) return notConfigured();
  try {
    const { id } = await params;
    const anonKey = anonKeyFromBody(
      new URL(request.url).searchParams.get("anon_key"),
    );
    const actor = await actorFor(anonKey);
    const draft = await fetchOwnedDraft(adminClient(), actor, id);
    return Response.json({ draft });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Autosave. Body: { payload?, anonKey? }. Status changes are server-driven. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = guardOrigin(request);
  if (guard) return guard;
  if (!cloudConfigured()) return notConfigured();
  try {
    const { id } = await params;
    const body = await readJsonBody(request);
    if (!body) {
      return Response.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const actor = await actorFor(anonKeyFromBody(body.anonKey));
    const existing = await fetchOwnedDraft(adminClient(), actor, id);
    const payload =
      body.payload &&
      typeof body.payload === "object" &&
      !Array.isArray(body.payload)
        ? (body.payload as Record<string, unknown>)
        : undefined;
    // A running design chain owns its payload — user autosaves must never
    // clobber chain state. The status condition is enforced INSIDE the
    // UPDATE statement (not check-then-act) so an autosave racing the
    // draft→designing transition atomically loses with a 409.
    const draft = await updateDraft(
      adminClient(),
      actor,
      id,
      { payload },
      existing.kind === "filter" ? "draft" : undefined,
    );
    return Response.json({ draft });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = guardOrigin(request);
  if (guard) return guard;
  if (!cloudConfigured()) return notConfigured();
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const anonKey = anonKeyFromBody(url.searchParams.get("anon_key"));
    const rawExpect = url.searchParams.get("expect");
    const expect =
      rawExpect === "draft" ||
      rawExpect === "designing" ||
      rawExpect === "ready" ||
      rawExpect === "failed"
        ? rawExpect
        : undefined;
    const actor = await actorFor(anonKey);
    const admin = adminClient();
    const existing = await fetchOwnedDraft(admin, actor, id);
    // Housekeeping deletes (expect set) are no-ops when the row moved on —
    // e.g. a stale failed row another tab just flipped back to designing.
    if (expect && existing.status !== expect) {
      return Response.json({ ok: true, skipped: true });
    }
    // Deleting a running design also cancels its in-flight provider job —
    // an abandoned xhigh/max run would otherwise keep billing to completion.
    if (existing.kind === "filter" && existing.status === "designing" && !expect) {
      await cancelChain(
        chainStateFrom(
          (existing.payload as Record<string, unknown>).chain,
        ),
      );
    }
    await deleteDraft(admin, actor, id, expect);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
