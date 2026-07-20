// User API keys (BYOK): GET masked status, POST set one provider's key,
// DELETE clear one. Subscriber/admin only. Keys are WRITE-ONLY over the
// wire — the GET never returns plaintext, only {set, hint}. Encrypted at
// rest (migration 016 + APP_ENCRYPTION_KEY); when encryption is
// unavailable the POST fails cleanly and provider calls keep using the
// deployment keys.
import { guardRequest, readJsonBody } from "@/lib/ai/server";
import { encryptionAvailable } from "@/lib/ai/crypto";
import {
  clearUserKey,
  keyStatus,
  setUserKey,
  type KeyProvider,
} from "@/lib/db/apiKeys";
import {
  adminClient,
  cloudConfigured,
  resolveCaller,
} from "@/lib/supabase/server";

export const maxDuration = 30;

const PROVIDERS: KeyProvider[] = [
  "anthropic",
  "openai",
  "openrouter",
  "browserbase",
];

export async function GET(request: Request) {
  const guard = guardRequest(request);
  if (guard) return guard;
  if (!cloudConfigured()) {
    return Response.json({ keys: null, available: false });
  }
  const caller = await resolveCaller();
  if (!caller.user) return Response.json({ keys: null, available: false });
  const status = await keyStatus(adminClient(), caller.user.id);
  return Response.json({ keys: status, available: encryptionAvailable() });
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
      { error: "Bring-your-own-key is a subscriber feature.", upgrade: true },
      { status: 402 },
    );
  }
  if (!encryptionAvailable()) {
    return Response.json(
      {
        error:
          "Key storage isn't enabled on this deployment yet (APP_ENCRYPTION_KEY missing).",
      },
      { status: 503 },
    );
  }
  const body = await readJsonBody(request);
  if (!body) {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const provider = body.provider as KeyProvider;
  if (!PROVIDERS.includes(provider)) {
    return Response.json({ error: "Unknown provider." }, { status: 400 });
  }
  const value = typeof body.value === "string" ? body.value.trim() : "";
  if (!value || value.length > 400) {
    return Response.json({ error: "Provide a valid key." }, { status: 400 });
  }
  const project =
    provider === "browserbase" && typeof body.project === "string"
      ? body.project.trim()
      : undefined;
  if (provider === "browserbase" && !project) {
    return Response.json(
      { error: "Browserbase needs both an API key and a project id." },
      { status: 400 },
    );
  }
  const ok = await setUserKey(
    adminClient(),
    caller.user.id,
    provider,
    value,
    project,
  );
  if (!ok) {
    return Response.json(
      { error: "Couldn't save the key (storage unavailable)." },
      { status: 503 },
    );
  }
  const status = await keyStatus(adminClient(), caller.user.id);
  return Response.json({ ok: true, keys: status });
}

export async function DELETE(request: Request) {
  const guard = guardRequest(request);
  if (guard) return guard;
  if (!cloudConfigured()) {
    return Response.json({ error: "Cloud not configured." }, { status: 503 });
  }
  const caller = await resolveCaller();
  if (!caller.user) {
    return Response.json({ error: "Sign in first." }, { status: 401 });
  }
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") as KeyProvider;
  if (!PROVIDERS.includes(provider)) {
    return Response.json({ error: "Unknown provider." }, { status: 400 });
  }
  await clearUserKey(adminClient(), caller.user.id, provider);
  const status = await keyStatus(adminClient(), caller.user.id);
  return Response.json({ ok: true, keys: status });
}
