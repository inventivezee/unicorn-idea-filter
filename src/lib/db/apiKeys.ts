// DAL for user-supplied provider keys. Encrypt on write, decrypt on read
// into a ProviderKeys set. Drift-tolerant: if migration 016 hasn't run, or
// APP_ENCRYPTION_KEY is unset, reads return an empty set (→ env fallback)
// and writes surface a clear error to the settings route.
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret, keyHint } from "@/lib/ai/crypto";
import type { ProviderKeys } from "@/lib/ai/provider-keys";

export type KeyProvider =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "browserbase";

interface KeyRow {
  anthropic: string | null;
  openai: string | null;
  openrouter: string | null;
  browserbase: string | null;
  browserbase_project: string | null;
}

/** Resolve a user's stored keys into a ProviderKeys set (env fallback lives
 *  in the accessor helpers, not here — this returns ONLY what the user set). */
export async function resolveUserKeys(
  admin: SupabaseClient,
  userId: string | null | undefined,
): Promise<ProviderKeys> {
  if (!userId) return {};
  let row: KeyRow | null = null;
  try {
    const { data } = await admin
      .from("user_api_keys")
      .select("anthropic, openai, openrouter, browserbase, browserbase_project")
      .eq("user_id", userId)
      .maybeSingle<KeyRow>();
    row = data;
  } catch {
    return {}; // migration 016 not applied → env fallback everywhere
  }
  if (!row) return {};
  const anthropic = decryptSecret(row.anthropic) ?? undefined;
  const openai = decryptSecret(row.openai) ?? undefined;
  const openrouter = decryptSecret(row.openrouter) ?? undefined;
  const bbKey = decryptSecret(row.browserbase) ?? undefined;
  const bbProject = decryptSecret(row.browserbase_project) ?? undefined;
  const keys: ProviderKeys = {};
  if (anthropic) keys.anthropic = anthropic;
  if (openai) keys.openai = openai;
  if (openrouter) keys.openrouter = openrouter;
  if (bbKey && bbProject) keys.browserbase = { key: bbKey, project: bbProject };
  keys.hasOwn = Boolean(
    keys.anthropic || keys.openai || keys.openrouter || keys.browserbase,
  );
  return keys;
}

/** Which providers the user has set + a masked hint, for the settings UI.
 *  NEVER returns plaintext keys. */
export async function keyStatus(
  admin: SupabaseClient,
  userId: string,
): Promise<Record<string, { set: boolean; hint?: string }>> {
  const keys = await resolveUserKeys(admin, userId);
  const status = (v?: string) =>
    v ? { set: true, hint: keyHint(v) } : { set: false };
  return {
    anthropic: status(keys.anthropic),
    openai: status(keys.openai),
    openrouter: status(keys.openrouter),
    browserbase: keys.browserbase
      ? { set: true, hint: keyHint(keys.browserbase.key) }
      : { set: false },
  };
}

/** Upsert one provider's key (encrypted). browserbase needs both key+project.
 *  Returns false when encryption is unavailable (APP_ENCRYPTION_KEY unset)
 *  or the migration is missing — the route turns that into a 503. */
export async function setUserKey(
  admin: SupabaseClient,
  userId: string,
  provider: KeyProvider,
  value: string,
  browserbaseProject?: string,
): Promise<boolean> {
  const enc = encryptSecret(value.trim());
  if (!enc) return false;
  const patch: Record<string, unknown> = { user_id: userId, updated_at: new Date().toISOString() };
  if (provider === "browserbase") {
    const proj = encryptSecret((browserbaseProject ?? "").trim());
    if (!proj) return false;
    patch.browserbase = enc;
    patch.browserbase_project = proj;
  } else {
    patch[provider] = enc;
  }
  try {
    const { error } = await admin
      .from("user_api_keys")
      .upsert(patch, { onConflict: "user_id" });
    return !error;
  } catch {
    return false;
  }
}

/** Clear one provider's key (set columns to null). */
export async function clearUserKey(
  admin: SupabaseClient,
  userId: string,
  provider: KeyProvider,
): Promise<void> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (provider === "browserbase") {
    patch.browserbase = null;
    patch.browserbase_project = null;
  } else {
    patch[provider] = null;
  }
  try {
    await admin.from("user_api_keys").update(patch).eq("user_id", userId);
  } catch {
    // Nothing stored / migration missing — nothing to clear.
  }
}
