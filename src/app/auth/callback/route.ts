// OAuth / magic-link callback: exchanges the auth code for a session cookie,
// then claims any anonymous ideas created on this device (?anon_key=...).
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { adminClient, anonKeyFromBody, cloudConfigured } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const anonKey = anonKeyFromBody(url.searchParams.get("anon_key"));
  const origin = url.origin;

  if (!cloudConfigured() || (!code && !tokenHash)) {
    return NextResponse.redirect(`${origin}/`);
  }

  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        },
      },
    },
  );

  // PKCE code exchange needs the same browser that requested the link; the
  // token_hash form works from any browser (e.g. email opened on the phone).
  const { data, error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : await supabase.auth.verifyOtp({ type: "email", token_hash: tokenHash! });
  if (error || !data.user) {
    return NextResponse.redirect(`${origin}/signin?error=auth`);
  }

  // Claim this device's anonymous ideas for the new session's user.
  if (anonKey) {
    const admin = adminClient();
    await admin
      .from("ideas")
      .update({ owner_id: data.user.id, anon_key: null })
      .is("owner_id", null)
      .eq("anon_key", anonKey);
    await admin.from("submission_logs").insert({
      user_id: data.user.id,
      anon_key: anonKey,
      action: "claim",
    });
  }

  return NextResponse.redirect(`${origin}/`);
}
