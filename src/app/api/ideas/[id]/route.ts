import {
  IdeaAccessError,
  patchIdea,
  removeIdea,
  type IdeaActor,
} from "@/lib/db/ideas";
import { readJsonBody } from "@/lib/ai/server";
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
  if (err instanceof IdeaAccessError) {
    return Response.json({ error: err.message }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : "Unknown error";
  return Response.json({ error: message }, { status: 500 });
}

async function actorFor(anonKey: string | null): Promise<IdeaActor> {
  const caller = await resolveCaller();
  return {
    userId: caller.user?.id ?? null,
    anonKey,
    isAdmin: caller.isAdmin,
    subscribed: caller.subscribed,
  };
}

/** Update an idea. Body: { patch?: Partial<Idea>, isPrivate?: boolean, anonKey?: string }. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!cloudConfigured()) return notConfigured();
  try {
    const { id } = await params;
    const body = await readJsonBody(request);
    if (!body) {
      return Response.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const actor = await actorFor(anonKeyFromBody(body.anonKey));
    const patch =
      body.patch && typeof body.patch === "object" && !Array.isArray(body.patch)
        ? (body.patch as Record<string, unknown>)
        : {};
    const isPrivate =
      typeof body.isPrivate === "boolean" ? body.isPrivate : undefined;
    const idea = await patchIdea(adminClient(), actor, id, patch, isPrivate);
    return Response.json({ idea });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Delete an idea. Body: { anonKey?: string }. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!cloudConfigured()) return notConfigured();
  try {
    const { id } = await params;
    const body = (await readJsonBody(request)) ?? {};
    const actor = await actorFor(anonKeyFromBody(body.anonKey));
    await removeIdea(adminClient(), actor, id);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
