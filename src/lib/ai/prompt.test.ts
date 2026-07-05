import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";
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

describe("buildUserPrompt clarifications", () => {
  const idea = {
    name: "X",
    domain: "",
    businessModel: "",
    buyerICP: "",
    initialWedge: "",
    thesisNotes: "Core idea.",
  };

  it("appends a founder-clarifications section", () => {
    const p = buildUserPrompt(idea, "bg", [], [
      { question: "Who pays?", answer: "Retail" },
    ]);
    expect(p).toContain("Founder's clarifications");
    expect(p).toContain("Who pays?");
    expect(p).toContain("Retail");
  });

  it("omits the section when there are no answered clarifications", () => {
    expect(buildUserPrompt(idea, "bg", [], [])).not.toContain(
      "Founder's clarifications",
    );
    // question without answer is not emitted
    expect(
      buildUserPrompt(idea, "bg", [], [{ question: "Q?", answer: "" }]),
    ).not.toContain("Founder's clarifications");
  });

  it("strips a legacy Q&A block from the description to avoid double-feeding", () => {
    const legacy = {
      ...idea,
      thesisNotes: "Core idea.\n\nClarifications:\nQ: Who pays?\nA: Retail",
    };
    const p = buildUserPrompt(legacy, "bg", [], [
      { question: "Who pays?", answer: "Retail" },
    ]);
    // "Who pays?" appears once (in the clarifications section, not the thesis)
    expect(p.match(/Who pays\?/g) ?? []).toHaveLength(1);
    expect(p).toContain("Core idea.");
    expect(p).not.toContain("Clarifications:\nQ:");
  });
});
