import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

// A valid 32-byte base64 key must exist BEFORE the module reads it.
beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("crypto (user key encryption)", () => {
  it("round-trips a secret", async () => {
    const { encryptSecret, decryptSecret } = await import("./crypto");
    const secret = "sk-ant-abc123-SENSITIVE";
    const blob = encryptSecret(secret);
    expect(blob).toBeTruthy();
    expect(blob).not.toContain(secret); // ciphertext, not plaintext
    expect(decryptSecret(blob)).toBe(secret);
  });

  it("returns null on a tampered blob (GCM auth)", async () => {
    const { encryptSecret, decryptSecret } = await import("./crypto");
    const blob = encryptSecret("value")!;
    const [iv, tag, ct] = blob.split(".");
    // flip a byte in the ciphertext
    const bad = Buffer.from(ct, "base64");
    bad[0] ^= 0xff;
    expect(decryptSecret(`${iv}.${tag}.${bad.toString("base64")}`)).toBeNull();
  });

  it("keyHint never reveals the whole key", async () => {
    const { keyHint } = await import("./crypto");
    expect(keyHint("sk-ant-verylongsecret-9999")).toBe("••••9999");
  });
});

describe("provider-keys (env fallback)", () => {
  it("prefers the user key, falls back to env", async () => {
    const { anthropicKey, openaiKey } = await import("./provider-keys");
    process.env.ANTHROPIC_API_KEY = "env-anthropic";
    expect(anthropicKey({ anthropic: "user-key" })).toBe("user-key");
    expect(anthropicKey({})).toBe("env-anthropic");
    expect(anthropicKey(undefined)).toBe("env-anthropic");
    expect(openaiKey({ openai: "u" })).toBe("u");
  });
});
