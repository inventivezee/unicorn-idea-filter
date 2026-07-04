import {
  IdeaAccessError,
  insertIdea,
  listIdeas,
  type IdeaActor,
} from "@/lib/db/ideas";
import { readJsonBody } from "@/lib/ai/server";
import {
  adminClient,
  anonKeyFromBody,
  cloudConfigured,
  requestTelemetry,
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

/** List the caller's ideas (session-owned, or anon-key-owned when signed out). */
export async function GET(request: Request) {
  if (!cloudConfigured()) return notConfigured();
  try {
    const anonKey = anonKeyFromBody(
      new URL(request.url).searchParams.get("anon_key"),
    );
    const actor = await actorFor(anonKey);
    const ideas = await listIdeas(adminClient(), actor);
    return Response.json({ ideas });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Create an idea. Body: { idea: Partial<Idea>, anonKey?: string }. */
export async function POST(request: Request) {
  if (!cloudConfigured()) return notConfigured();
  try {
    const body = await readJsonBody(request);
    if (!body) {
      return Response.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const anonKey = anonKeyFromBody(body.anonKey);
    const actor = await actorFor(anonKey);
    const fields =
      body.idea && typeof body.idea === "object" && !Array.isArray(body.idea)
        ? (body.idea as Record<string, unknown>)
        : {};
    const admin = adminClient();
    const idea = await insertIdea(admin, actor, fields);
    await admin.from("submission_logs").insert({
      idea_id: idea.id,
      user_id: actor.userId,
      anon_key: actor.userId ? null : actor.anonKey,
      action: "create",
      ...requestTelemetry(request),
    });
    return Response.json({ idea });
  } catch (err) {
    return errorResponse(err);
  }
}
