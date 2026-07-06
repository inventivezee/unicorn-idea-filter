// Profile + entitlements for the signed-in caller.
import { readJsonBody } from "@/lib/ai/server";
import {
  FREE_ANALYSES_PER_DAY,
  PREMIUM_MODELS,
  type Entitlements,
  type SubscriptionStatus,
} from "@/lib/entitlements";
import {
  adminClient,
  cloudConfigured,
  resolveCaller,
} from "@/lib/supabase/server";
import type { CoFounder } from "@/lib/types";

function signedOutEntitlements(): Entitlements {
  return {
    signedIn: false,
    email: null,
    displayName: "",
    showHandle: false,
    isAdmin: false,
    subscribed: false,
    subscriptionStatus: "none",
    analysesRemaining: null,
    premiumModels: [...PREMIUM_MODELS],
  };
}

export async function GET() {
  if (!cloudConfigured()) {
    return Response.json({
      entitlements: signedOutEntitlements(),
      profile: null,
      cloud: false,
    });
  }
  const caller = await resolveCaller();
  if (!caller.user || !caller.profile) {
    return Response.json({
      entitlements: signedOutEntitlements(),
      profile: null,
      cloud: true,
    });
  }
  const p = caller.profile;
  const sameDay =
    new Date(p.analyses_reset_at).toISOString().slice(0, 10) ===
    new Date().toISOString().slice(0, 10);
  const used = sameDay ? p.analyses_used : 0;
  const entitlements: Entitlements = {
    signedIn: true,
    email: caller.user.email ?? null,
    displayName: p.display_name,
    showHandle: p.show_handle,
    isAdmin: caller.isAdmin,
    subscribed: caller.subscribed,
    subscriptionStatus: (p.subscription_status as SubscriptionStatus) ?? "none",
    analysesRemaining: caller.subscribed
      ? null
      : Math.max(0, FREE_ANALYSES_PER_DAY - used),
    premiumModels: [...PREMIUM_MODELS],
  };
  return Response.json({
    entitlements,
    profile: {
      displayName: p.display_name,
      showHandle: p.show_handle,
      founderBackground: p.founder_background,
      coFounders: Array.isArray(p.co_founders) ? p.co_founders : [],
      prefs: p.prefs ?? {},
    },
    cloud: true,
  });
}

/** Update the caller's profile (safe fields only). */
export async function PATCH(request: Request) {
  if (!cloudConfigured()) {
    return Response.json({ error: "Cloud not configured." }, { status: 503 });
  }
  const caller = await resolveCaller();
  if (!caller.user) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }
  const body = await readJsonBody(request);
  if (!body) {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.displayName === "string") {
    update.display_name = body.displayName.slice(0, 80);
  }
  if (typeof body.showHandle === "boolean") update.show_handle = body.showHandle;
  if (typeof body.founderBackground === "string") {
    update.founder_background = body.founderBackground.slice(0, 60_000);
  }
  if (Array.isArray(body.coFounders)) {
    update.co_founders = body.coFounders
      .slice(0, 4)
      .flatMap((c): CoFounder[] => {
        if (!c || typeof c !== "object") return [];
        const cf = c as Partial<CoFounder>;
        return [
          {
            id: typeof cf.id === "string" ? cf.id.slice(0, 64) : "",
            name: typeof cf.name === "string" ? cf.name.slice(0, 200) : "",
            background:
              typeof cf.background === "string"
                ? cf.background.slice(0, 60_000)
                : "",
          },
        ];
      });
  }
  if (body.prefs && typeof body.prefs === "object" && !Array.isArray(body.prefs)) {
    update.prefs = body.prefs;
  }
  const { error } = await adminClient()
    .from("profiles")
    .update(update)
    .eq("id", caller.user.id);
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ ok: true });
}
