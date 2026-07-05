"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Button, EmptyState } from "@/components/ui";
import { getAnonKey } from "@/lib/anon";
import { FREE_ANALYSES_PER_MONTH } from "@/lib/entitlements";
import { useStore } from "@/lib/store";
import { supabaseBrowser } from "@/lib/supabase/client";

// Google OAuth is built and ready, but hidden until the Google OAuth app is
// verified. Flip to true to re-enable the "Continue with Google" button.
const GOOGLE_OAUTH_ENABLED = false;

function authRedirectUrl(): string {
  return `${location.origin}/auth/callback?anon_key=${encodeURIComponent(getAnonKey())}`;
}

export default function SignInPage() {
  const { hydrated, cloud, entitlements, signOut } = useStore();
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auth callback failures land back here as /signin?error=auth.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("error") === "auth") {
      setError("Sign-in failed — try again.");
    }
  }, []);

  async function sendMagicLink(e: FormEvent) {
    e.preventDefault();
    const address = email.trim();
    if (!address || sending) return;
    setSending(true);
    setError(null);
    try {
      const { error: otpError } = await supabaseBrowser().auth.signInWithOtp({
        email: address,
        options: { emailRedirectTo: authRedirectUrl() },
      });
      if (otpError) {
        setError(otpError.message || "Sign-in failed — try again.");
      } else {
        setSent(true);
      }
    } catch {
      setError("Sign-in failed — try again.");
    } finally {
      setSending(false);
    }
  }

  async function continueWithGoogle() {
    setError(null);
    try {
      const { error: oauthError } = await supabaseBrowser().auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: authRedirectUrl() },
      });
      if (oauthError) {
        setError(oauthError.message || "Sign-in failed — try again.");
      }
    } catch {
      setError("Sign-in failed — try again.");
    }
  }

  if (!hydrated) return null;

  if (!cloud) {
    return (
      <div className="mx-auto mt-16 max-w-md">
        <EmptyState>Accounts aren&apos;t configured on this deployment.</EmptyState>
      </div>
    );
  }

  if (entitlements.signedIn) {
    return (
      <div className="mx-auto mt-16 max-w-md rounded-lg border border-zinc-200 bg-white p-6 text-center">
        <p className="text-sm text-zinc-700">
          You&apos;re signed in as{" "}
          <span className="font-medium text-zinc-900">
            {entitlements.email ?? "your account"}
          </span>
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <Link
            href="/"
            className="rounded border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50"
          >
            Back to Pipeline
          </Link>
          <Button variant="danger" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-16 max-w-md">
      <div className="rounded-lg border border-zinc-200 bg-white p-6">
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900">
          Sign up or sign in
        </h1>
        <p className="mt-1 text-xs text-zinc-500">
          New here or returning — enter your email and we&apos;ll send a link.
          It creates your account if you don&apos;t have one yet.
        </p>

        {error ? (
          <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        ) : null}

        {sent ? (
          <p className="mt-4 rounded border border-teal-200 bg-teal-50 px-3 py-2 text-sm text-teal-800">
            Check your email for the sign-in link.
          </p>
        ) : (
          <form onSubmit={sendMagicLink} className="mt-4 space-y-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-zinc-600">
                Email
              </span>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="h-9 w-full rounded border border-zinc-300 bg-white px-2 text-sm text-zinc-900 focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
              />
            </label>
            <Button
              type="submit"
              variant="primary"
              disabled={sending || !email.trim()}
              className="w-full"
            >
              {sending ? "Sending…" : "Send magic link"}
            </Button>
          </form>
        )}

        {GOOGLE_OAUTH_ENABLED ? (
          <>
            <div className="my-4 flex items-center gap-3">
              <div className="h-px flex-1 bg-zinc-200" />
              <span className="text-xs text-zinc-400">or</span>
              <div className="h-px flex-1 bg-zinc-200" />
            </div>

            <Button
              variant="secondary"
              className="w-full"
              onClick={() => void continueWithGoogle()}
            >
              Continue with Google
            </Button>
          </>
        ) : null}

        <p className="mt-4 text-xs leading-relaxed text-zinc-500">
          A free account keeps your ideas across devices, gives you{" "}
          {FREE_ANALYSES_PER_MONTH} free AI analyses a month, and unlocks
          subscriptions.
        </p>
      </div>
    </div>
  );
}
