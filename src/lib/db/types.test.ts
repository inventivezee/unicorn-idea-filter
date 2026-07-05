import { describe, expect, it } from "vitest";
import {
  computeDefaultRawScore,
  computePublished,
  ideaToWritableRow,
  rowToIdea,
  type IdeaRow,
} from "./types";
import { CRITERION_IDS } from "../types";

function baseRow(overrides: Partial<IdeaRow> = {}): IdeaRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    owner_id: null,
    anon_key: "device-1",
    name: "Test",
    domain: "AI",
    business_model: "SaaS",
    buyer_icp: "",
    initial_wedge: "",
    thesis_notes: "notes",
    gates: {},
    scores: {},
    confidence: null,
    validation_test_30d: "",
    top_risk_override_1: null,
    top_risk_override_2: null,
    ai: null,
    ai_summary: "",
    founder_profile: "",
    is_private: false,
    published: false,
    created_at: "2026-07-04T00:00:00.000Z",
    updated_at: "2026-07-04T00:00:00.000Z",
    ...overrides,
  };
}

describe("computePublished — 'once it has scores' rule", () => {
  it("unscored drafts stay unpublished", () => {
    expect(computePublished({ gates: {}, scores: {}, ai: null })).toBe(false);
  });
  it("a single score publishes", () => {
    expect(computePublished({ gates: {}, scores: { pain: 3 }, ai: null })).toBe(
      true,
    );
  });
  it("a single gate answer publishes", () => {
    expect(
      computePublished({ gates: { g_pain: "Y" }, scores: {}, ai: null }),
    ).toBe(true);
  });
  it("an AI analysis publishes", () => {
    expect(computePublished({ gates: {}, scores: {}, ai: { summary: "x" } })).toBe(
      true,
    );
  });
  it("junk values do not publish", () => {
    expect(
      computePublished({
        gates: { g_pain: "MAYBE" },
        scores: { pain: "high" },
        ai: null,
      }),
    ).toBe(false);
  });
});

describe("computeDefaultRawScore — feed ranking", () => {
  it("is null unless fully scored", () => {
    expect(computeDefaultRawScore({ pain: 5 })).toBeNull();
  });
  it("matches the engine fixture at default weights", () => {
    const scores = Object.fromEntries(
      CRITERION_IDS.map((id) => [
        id,
        {
          pain: 4, market: 5, whynow: 4, tenx: 3, wedge: 4, unitecon: 3,
          retention: 3, distribution: 2, moat: 3, pubco: 3, reg: 3,
          capital: 3, fmf: 5, talent: 3, mission: 3,
        }[id],
      ]),
    );
    expect(computeDefaultRawScore(scores)).toBeCloseTo(70.4, 10);
  });
});

describe("rowToIdea", () => {
  it("maps and sanitizes a row", () => {
    const idea = rowToIdea(
      baseRow({
        scores: { pain: 4, market: 99, junk: 1 },
        gates: { g_pain: "Y", g_moat: "WAT" },
        confidence: 0.75,
        is_private: true,
        published: true,
        top_risk_override_1: "override",
      }),
    );
    expect(idea.scores.pain).toBe(4);
    expect(idea.scores.market).toBeNull(); // out of range dropped
    expect(idea.gates.g_pain).toBe("Y");
    expect(idea.gates.g_moat).toBeNull();
    expect(idea.confidence).toBe(0.75);
    expect(idea.isPrivate).toBe(true);
    expect(idea.published).toBe(true);
    expect(idea.topRiskOverride1).toBe("override");
    expect(idea.id).toBe("11111111-1111-4111-8111-111111111111");
  });
});

describe("ideaToWritableRow — cashcow block semantics", () => {
  it("omits the column when the idea never touched cashcow", () => {
    expect(ideaToWritableRow({ name: "x" })).not.toHaveProperty("cashcow");
  });

  it("writes null for a present-but-empty block so clears persist", () => {
    const row = ideaToWritableRow({
      name: "x",
      cashcow: {
        gates: {} as never,
        scores: {} as never,
        confidence: null,
        validationTest30d: "",
      },
    });
    expect(row.cashcow).toBeNull();
  });

  it("writes a normalized block when it has content", () => {
    const row = ideaToWritableRow({
      name: "x",
      cashcow: {
        gates: { cg_pain: "Y" } as never,
        scores: {} as never,
        confidence: null,
        validationTest30d: "",
      },
    });
    expect((row.cashcow as { gates: Record<string, unknown> }).gates.cg_pain).toBe("Y");
  });
});
