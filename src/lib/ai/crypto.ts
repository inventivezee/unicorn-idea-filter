// Symmetric encryption for user-supplied API keys, at rest in the DB.
// AES-256-GCM (authenticated) with a single app secret (APP_ENCRYPTION_KEY,
// 32 bytes base64). The plaintext keys are decrypted ONLY server-side at
// provider-call time; they are never returned to the client, never logged,
// and never enter the public_ideas surface.
//
// If APP_ENCRYPTION_KEY is absent, encryption is UNAVAILABLE — BYOK simply
// can't be stored, and every provider call falls back to the deployment env
// keys (the chosen fallback model), so the feature degrades to today's
// behavior instead of breaking.
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGO = "aes-256-gcm";

function key(): Buffer | null {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) return null;
  const buf = Buffer.from(raw, "base64");
  return buf.length === 32 ? buf : null;
}

export function encryptionAvailable(): boolean {
  return key() !== null;
}

/** Returns iv.authTag.ciphertext (base64 parts, dot-joined), or null when
 *  encryption is unavailable. */
export function encryptSecret(plaintext: string): string | null {
  const k = key();
  if (!k) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, k, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
}

/** Reverse of encryptSecret. Returns null on any failure (wrong key, tamper,
 *  malformed) — a decrypt failure must never throw into a provider call; the
 *  caller falls back to the env key. */
export function decryptSecret(blob: string | null | undefined): string | null {
  const k = key();
  if (!k || !blob) return null;
  try {
    const [ivB64, tagB64, ctB64] = blob.split(".");
    if (!ivB64 || !tagB64 || !ctB64) return null;
    const decipher = createDecipheriv(ALGO, k, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]);
    return pt.toString("utf8");
  } catch {
    return null;
  }
}

/** Last 4 chars for display ("sk-…AB12"), never the whole key. */
export function keyHint(plaintext: string): string {
  const t = plaintext.trim();
  return t.length <= 4 ? "••••" : `••••${t.slice(-4)}`;
}
