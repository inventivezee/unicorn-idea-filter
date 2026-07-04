// Bulk import of legacy localStorage ideas into the cloud (one-time sync).
import { IdeaAccessError, insertIdea, type IdeaActor } from "@/lib/db/ideas";
import { readJsonBody } from "@/lib/ai/server";
import {
  adminClient,
  anonKeyFromBody,
  cloudConfigured,
  requestTelemetry,
  resolveCaller,
} from "@/lib/supabase/server";

const MAX_IMPORT = 100;

export async function POST(request: Request) {
  if (!cloudConfigured()) {
    return Response.json(
      { error: "Cloud features are not configured on this deployment." },
      { status: 503 },
    );
  }
  try {
    const body = await readJsonBody(request);
    if (!body || !Array.isArray(body.ideas)) {
      return Response.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const caller = await resolveCaller();
    const actor: IdeaActor = {
      userId: caller.user?.id ?? null,
      anonKey: anonKeyFromBody(body.anonKey),
      isAdmin: caller.isAdmin,
      subscribed: caller.subscribed,
    };
    const admin = adminClient();
    const items = body.ideas.slice(0, MAX_IMPORT);
    const imported = [];
    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      imported.push(await insertIdea(admin, actor, item));
    }
    await admin.from("submission_logs").insert({
      user_id: actor.userId,
      anon_key: actor.userId ? null : actor.anonKey,
      action: "import",
      ...requestTelemetry(request),
    });
    return Response.json({ ideas: imported });
  } catch (err) {
    if (err instanceof IdeaAccessError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
