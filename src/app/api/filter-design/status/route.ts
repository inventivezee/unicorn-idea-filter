// Poll + advance a running filter-design chain. Each call performs at most
// one provider round-trip; every paid submission inside advanceDraftChain is
// preceded by a CAS-won, budget-counted claim, so concurrent polls (two
// tabs, StrictMode double-mounts) can never double-spend.
import {
  advanceDraftChain,
  chainStateFrom,
} from "@/lib/ai/design-chain";
import { guardOrigin } from "@/lib/ai/server";
import {
  DraftAccessError,
  fetchOwnedDraft,
  type DraftRow,
} from "@/lib/db/drafts";
import {
  adminClient,
  cloudConfigured,
  resolveCaller,
} from "@/lib/supabase/server";

export const maxDuration = 800; // Vercel Pro (GA limit; build fails on Hobby)

function statusBody(draft: DraftRow) {
  const chain = chainStateFrom(
    (draft.payload as Record<string, unknown>).chain,
  );
  return {
    status: draft.status,
    stage: chain?.stage ?? 0,
    startedAt: chain?.startedAt ?? null,
    stageStartedAt: chain?.stageStartedAt ?? null,
    error: chain?.error ?? null,
    spec: (draft.payload as Record<string, unknown>).resultSpec ?? null,
  };
}

export async function GET(request: Request) {
  const guard = guardOrigin(request);
  if (guard) return guard;
  if (!cloudConfigured()) {
    return Response.json({ error: "Cloud not configured." }, { status: 503 });
  }
  const caller = await resolveCaller();
  if (!caller.user) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }
  const draftId = new URL(request.url).searchParams.get("draft") ?? "";
  const admin = adminClient();
  const actor = {
    userId: caller.user.id,
    anonKey: null,
    isAdmin: caller.isAdmin,
  };

  try {
    const draft = await fetchOwnedDraft(admin, actor, draftId);
    if (draft.kind !== "filter" || draft.status !== "designing") {
      return Response.json(statusBody(draft));
    }
    const advanced = await advanceDraftChain(admin, draft);
    return Response.json(statusBody(advanced));
  } catch (err) {
    if (err instanceof DraftAccessError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
