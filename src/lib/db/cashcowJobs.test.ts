import { describe, expect, it } from "vitest";
import { classifyProviderError } from "@/lib/db/cashcowJobs";

// These classifications are a spend/data contract, not cosmetics: a real
// outage misread as "fatal" permanently kills ideas that were never at
// fault, and an idea-specific failure misread as "transient" re-bills the
// same doomed call forever. Both have happened in production.
describe("classifyProviderError", () => {
  it("treats a disabled or invalid key as transient with a long backoff", () => {
    const msg =
      '401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."}}';
    const f = classifyProviderError(msg);
    expect(f).toMatchObject({ transient: true, kind: "auth" });
    // A human fixes a key; retrying in 5 minutes just burns claims.
    expect(f.backoffSeconds).toBeGreaterThanOrEqual(3600);
  });

  it("treats provider 5xx as transient — a 500 burst once killed 44 ideas", () => {
    for (const msg of [
      "500 The server had an error processing your request.",
      "503 upstream connect error or disconnect/reset before headers. reset reason: connection termination",
      "529 overloaded_error",
      "Request timed out.",
    ]) {
      expect(classifyProviderError(msg)).toMatchObject({
        transient: true,
        kind: "infra",
      });
    }
  });

  it("treats quota exhaustion as transient and holds it out for an hour", () => {
    const f = classifyProviderError(
      "429 You exceeded your current quota, please check your plan and billing details.",
    );
    expect(f).toMatchObject({ transient: true, kind: "quota" });
    expect(f.backoffSeconds).toBe(3600);
  });

  it("keeps idea-specific failures fatal so they consume the attempt cap", () => {
    for (const msg of [
      "The model returned no parseable output. Try again or switch models.",
      "The response ran over the output limit. Try a shorter idea description or founder background.",
    ]) {
      expect(classifyProviderError(msg)).toMatchObject({
        transient: false,
        kind: "fatal",
      });
    }
  });

  it("orders auth above quota when a message mentions billing", () => {
    // Anthropic's 401 body can mention billing; the key is still the problem.
    expect(
      classifyProviderError(
        "401 authentication_error: check your billing settings",
      ).kind,
    ).toBe("auth");
  });
});
