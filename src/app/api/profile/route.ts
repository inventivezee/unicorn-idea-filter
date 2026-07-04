// Profile-URL lookup: given a LinkedIn / bio / personal-site URL, use AI web
// search to synthesise a founder background from public information. Logged to
// the retained cv_uploads audit table (admin-visible). Best-effort — returns
// found:false rather than fabricating when it can't verify the person.
import {
  buildProfileLookupPrompt,
  PROFILE_LOOKUP_SYSTEM_PROMPT,
} from "@/lib/ai/prompt";
import { PROFILE_LOOKUP_SCHEMA } from "@/lib/ai/schema";
import {
  callProviderJSON,
  guardRequest,
  keyMissingResponse,
  mapProviderError,
  modelFromBody,
  parseLastJSON,
  providerFromBody,
  readJsonBody,
} from "@/lib/ai/server";
import {
  DEFAULT_MODEL_FALLBACKS,
  isPremiumModel,
  PROFILE_WEB_SEARCH_CAP,
} from "@/lib/entitlements";
import {
  adminClient,
  anonKeyFromBody,
  cloudConfigured,
  requestTelemetry,
  resolveCaller,
} from "@/lib/supabase/server";

export const maxDuration = 300;

/** Normalize + validate a pasted profile URL (http/https only). */
function normalizeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim().slice(0, 500);
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const guard = guardRequest(request);
  if (guard) return guard;

  const body = await readJsonBody(request);
  if (!body) {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const url = normalizeUrl(body.url);
  if (!url) {
    return Response.json(
      { error: "Paste a valid profile URL (e.g. a LinkedIn link)." },
      { status: 400 },
    );
  }
  const provider = providerFromBody(body.provider);
  const requestedModel = modelFromBody(body.model);
  const anonKey = anonKeyFromBody(body.anonKey);
  const founderSlot = String(body.founderSlot ?? "primary").slice(0, 64);

  const missing = keyMissingResponse(provider);
  if (missing) return missing;

  // Best-effort helper — don't hard-block behind the paywall; fall back off a
  // premium model when the caller isn't entitled.
  let model = requestedModel ?? DEFAULT_MODEL_FALLBACKS[provider];
  let subscribed = true;
  const cloud = cloudConfigured();
  let caller = null;
  if (cloud) {
    caller = await resolveCaller();
    subscribed = caller.subscribed || caller.isAdmin;
    if (isPremiumModel(model) && !subscribed) {
      model = DEFAULT_MODEL_FALLBACKS[provider];
    }
  }

  try {
    const result = await callProviderJSON({
      provider,
      model,
      system: PROFILE_LOOKUP_SYSTEM_PROMPT,
      prompt: buildProfileLookupPrompt(url),
      schemaName: "profile_lookup",
      schema: PROFILE_LOOKUP_SCHEMA as unknown as Record<string, unknown>,
      webSearch: true, // the whole point — always search for a profile lookup
      speed: "quality",
      tier: subscribed ? "premium" : "standard",
      // Bounded task — cap search for every tier (not "unlimited" like analysis).
      maxWebSearches: PROFILE_WEB_SEARCH_CAP,
    });
    const raw = parseLastJSON<{
      found?: unknown;
      background?: unknown;
      sources?: unknown;
    }>(result.texts);
    const found = raw.found === true;
    const background =
      typeof raw.background === "string" ? raw.background.trim() : "";
    const sources = Array.isArray(raw.sources)
      ? raw.sources.filter((x): x is string => typeof x === "string").slice(0, 10)
      : [];

    // Retain an audit record (cloud only), whether or not the lookup succeeded.
    if (cloud) {
      const telemetry = requestTelemetry(request);
      const { error: insErr } = await adminClient()
        .from("cv_uploads")
        .insert({
          user_id: caller?.user?.id ?? null,
          anon_key: caller?.user ? null : anonKey,
          founder_slot: founderSlot,
          filename: "",
          mime_type: "",
          source_url: url,
          extracted_text: sources.join("\n"),
          ai_summary: found ? background : "",
          provider,
          model,
          web_searches: result.webSearches,
          ...telemetry,
        });
      if (insErr) console.error("cv_uploads (profile) insert failed", insErr.message);
    }

    return Response.json({ found, background, sources, webSearches: result.webSearches });
  } catch (err) {
    return mapProviderError(err, model);
  }
}
