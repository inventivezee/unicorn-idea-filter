import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./prompt";
import { STANDARD_WEB_SEARCH_CAP } from "../entitlements";

describe("buildSystemPrompt web-search budget", () => {
  it("caps the free tier at the standard budget", () => {
    const p = buildSystemPrompt(STANDARD_WEB_SEARCH_CAP);
    expect(p).toContain(`do not exceed roughly ${STANDARD_WEB_SEARCH_CAP} searches`);
  });

  it("does not cap subscribers (null budget)", () => {
    const p = buildSystemPrompt(null);
    expect(p).not.toContain("do not exceed");
    expect(p).toContain("as many targeted searches");
  });

  it("keeps the rest of the instrument intact for both tiers", () => {
    for (const budget of [STANDARD_WEB_SEARCH_CAP, null]) {
      const p = buildSystemPrompt(budget);
      // Gate + criterion ids are interpolated in.
      expect(p).toContain("g_moat");
      expect(p).toContain("fmf");
      expect(p).toContain("Unicorn Idea Filter");
    }
  });
});
