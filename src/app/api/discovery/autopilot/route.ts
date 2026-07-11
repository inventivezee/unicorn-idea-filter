// Discovery autopilot settings: GET current, POST {enabled, batch?,
// guidelines?, useFounderBackground?}. Subscriber-gated like run creation.
import { guardRequest, readJsonBody } from "@/lib/ai/server";
import { MAX_TASKS_PER_RUN } from "@/lib/discovery/config";
import {
  adminClient,
  cloudConfigured,
  resolveCaller,
} from "@/lib/supabase/server";

export const maxDuration = 30;

export async function GET(request: Request) {
  const guard = guardRequest(request);
  if (guard) return guard;
  if (!cloudConfigured()) return Response.json({ autopilot: null });
  const caller = await resolveCaller();
  if (!caller.user) return Response.json({ autopilot: null });
  const { data } = await adminClient()
    .from("discovery_autopilot")
    .select("enabled, batch, guidelines, use_founder_background")
    .eq("owner_id", caller.user.id)
    .maybeSingle();
  return Response.json({ autopilot: data ?? null });
}

export async function POST(request: Request) {
  const guard = guardRequest(request);
  if (guard) return guard;
  if (!cloudConfigured()) {
    return Response.json({ error: "Cloud not configured." }, { status: 503 });
  }
  const caller = await resolveCaller();
  if (!caller.user) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }
  if (!caller.subscribed && !caller.isAdmin) {
    return Response.json(
      { error: "Autopilot is a subscriber feature.", upgrade: true },
      { status: 402 },
    );
  }
  const body = await readJsonBody(request);
  if (!body) {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const patch = {
    owner_id: caller.user.id,
    enabled: body.enabled === true,
    batch: Math.min(
      MAX_TASKS_PER_RUN,
      Math.max(1, Math.round(Number(body.batch)) || 20),
    ),
    guidelines:
      typeof body.guidelines === "string"
        ? body.guidelines.trim().slice(0, 20000)
        : "",
    use_founder_background: body.useFounderBackground !== false,
    updated_at: new Date().toISOString(),
  };
  const { error } = await adminClient()
    .from("discovery_autopilot")
    .upsert(patch, { onConflict: "owner_id" });
  if (error) {
    return Response.json(
      { error: "Autopilot needs migration 015 on this deployment." },
      { status: 503 },
    );
  }
  return Response.json({ ok: true, autopilot: patch });
}
