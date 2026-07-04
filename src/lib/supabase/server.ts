// Server-side Supabase access. Two clients:
//  - session client (anon key + user cookies) → who is calling?
//  - admin client (service role) → all data access, bypasses RLS.
// Never import this from client components.
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { isSubscribed } from "../entitlements";
import type { ProfileRow } from "../db/types";

export function cloudConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
      process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

/** Service-role client — full access; use only inside API routes. */
export function adminClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** Resolve the signed-in user from request cookies (null when signed out). */
export async function sessionUser(): Promise<User | null> {
  if (!cloudConfigured()) return null;
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {
          // Route handlers can't reliably set cookies here; the proxy
          // middleware owns session refresh.
        },
      },
    },
  );
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
}

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

export interface Caller {
  user: User | null;
  profile: ProfileRow | null;
  isAdmin: boolean;
  subscribed: boolean;
}

/** Load the caller's identity + profile + entitlements in one shot. */
export async function resolveCaller(): Promise<Caller> {
  const user = await sessionUser();
  if (!user) {
    return { user: null, profile: null, isAdmin: false, subscribed: false };
  }
  const admin = adminClient();
  let { data: profile } = await admin
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle<ProfileRow>();

  if (!profile) {
    // Signup trigger not applied or raced — create the row lazily.
    const { data: created } = await admin
      .from("profiles")
      .upsert({ id: user.id, email: user.email ?? null }, { onConflict: "id" })
      .select("*")
      .single<ProfileRow>();
    profile = created ?? null;
  }

  const emailIsAdmin = Boolean(
    user.email && ADMIN_EMAILS.includes(user.email.toLowerCase()),
  );
  if (profile && emailIsAdmin && !profile.is_admin) {
    // Bootstrap: ADMIN_EMAILS grants admin and persists it.
    await admin.from("profiles").update({ is_admin: true }).eq("id", user.id);
    profile.is_admin = true;
  }

  return {
    user,
    profile,
    isAdmin: Boolean(profile?.is_admin),
    subscribed: isSubscribed(profile?.subscription_status),
  };
}

/** Request metadata captured for admin-only submission logs. */
export function requestTelemetry(request: Request): {
  ip: string;
  user_agent: string;
  referer: string;
  country: string;
  city: string;
} {
  const h = request.headers;
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local",
    user_agent: h.get("user-agent") ?? "",
    referer: h.get("referer") ?? "",
    // Populated by Vercel's edge; empty elsewhere.
    country: h.get("x-vercel-ip-country") ?? "",
    city: h.get("x-vercel-ip-city") ?? "",
  };
}

/** Validate a client-supplied anonymous device key (localStorage UUID). */
export function anonKeyFromBody(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return /^[A-Za-z0-9-]{16,64}$/.test(v) ? v : null;
}
