"use client";

// Anonymous device identity: a random key in localStorage that lets a
// signed-out visitor edit the ideas they created from this browser, and lets
// the server meter their analysis quota. Not a tracking cookie — it never
// leaves this app.
const ANON_KEY_STORAGE = "unicorn-idea-filter:anon-key";

export function getAnonKey(): string {
  try {
    const existing = localStorage.getItem(ANON_KEY_STORAGE);
    if (existing && /^[A-Za-z0-9-]{16,64}$/.test(existing)) return existing;
    const key =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `anon-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    localStorage.setItem(ANON_KEY_STORAGE, key);
    return key;
  } catch {
    // Storage unavailable (private mode) — session-scoped fallback (must
    // satisfy the server's 16-64 char key format).
    return "anon-ephemeral-fallback-key";
  }
}
