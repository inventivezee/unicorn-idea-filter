import { describe, expect, it } from "vitest";
import { initialState, newIdea } from "./defaults";
import { normalizeState, pipelineCSV } from "./persistence";

describe("acceptance test 6: export → import round-trips losslessly", () => {
  it("round-trips a fully populated state", () => {
    const state = initialState();
    const idea = newIdea({
      name: "Round Trip Co",
      domain: "AI",
      businessModel: "SaaS",
      buyerICP: "CTOs",
      initialWedge: "wedge",
      thesisNotes: "notes with, commas and \"quotes\"",
      clarifications: [
        {
          question: "Who pays?",
          answer: "Independent HVAC technicians",
          filter: "unicorn" as const,
        },
        { question: "Why now?", answer: "", filter: "cashcow" as const },
      ],
      confidence: 0.75,
      topRiskOverride1: "manual risk 1",
      validationTest30d: "run 10 interviews",
      ai: {
        summary: "solid",
        gateRationales: { g_pain: "urgent" },
        scoreRationales: { pain: "clear budget" },
        confidenceRationale: "signals",
        needsFounderConfirmation: ["g_decade"],
        provider: "anthropic",
        model: "claude-opus-4-8",
        analyzedAt: "2026-07-03T00:00:00.000Z",
      },
    });
    idea.gates.g_pain = "Y";
    idea.gates.g_10b = "N";
    idea.scores.pain = 4;
    idea.scores.market = 0;
    state.ideas.push(idea);
    state.settings.weights.market = 20;
    state.settings.trials = 500;
    state.settings.provider = "openai";
    state.settings.founderBackground = "10 years in fintech";
    state.settings.askClarifying = false;
    state.settings.coFounders = [
      { id: "cf-1", name: "Alex", background: "Ex-Stripe payments infra lead" },
    ];

    const json = JSON.stringify(state, null, 2);
    const restored = normalizeState(JSON.parse(json));
    expect(restored).toEqual(state);

    // Second round-trip is also stable (normalize is idempotent).
    const again = normalizeState(JSON.parse(JSON.stringify(restored)));
    expect(again).toEqual(restored);
  });

  it("rejects garbage", () => {
    expect(() => normalizeState("nope")).toThrow();
    expect(() => normalizeState({})).toThrow();
    expect(() => normalizeState(null)).toThrow();
  });

  it("sanitizes malformed ai objects instead of passing them through", () => {
    const state = initialState();
    const dirty = JSON.parse(JSON.stringify(state));
    dirty.ideas[0].ai = {}; // truthy but missing every field
    dirty.ideas[1].ai = "garbage";
    const restored = normalizeState(dirty);
    expect(restored.ideas[0].ai?.needsFounderConfirmation).toEqual([]);
    expect(restored.ideas[0].ai?.summary).toBe("");
    expect(restored.ideas[1].ai).toBeNull();
  });

  it("keeps generated ids when imported ideas lack one", () => {
    const state = initialState();
    const dirty = JSON.parse(JSON.stringify(state));
    delete dirty.ideas[0].id;
    dirty.ideas[1].id = 42;
    const restored = normalizeState(dirty);
    expect(typeof restored.ideas[0].id).toBe("string");
    expect(restored.ideas[0].id.length).toBeGreaterThan(0);
    expect(typeof restored.ideas[1].id).toBe("string");
    expect(restored.ideas[1].id.length).toBeGreaterThan(0);
  });

  it("clamps pathological trials values to sane defaults", () => {
    const state = initialState();
    const cases: Array<[unknown, number]> = [
      [0.5, 300],
      [0, 300],
      [-1, 300],
      [Infinity, 300],
      [300.7, 300],
      [10_000_000, 100_000],
    ];
    for (const [input, expected] of cases) {
      const dirty = JSON.parse(JSON.stringify(state));
      dirty.settings.trials = input;
      // JSON round-trip drops Infinity — set it directly on the object.
      if (input === Infinity) dirty.settings.trials = Infinity;
      expect(normalizeState(dirty).settings.trials).toBe(expected);
    }
  });

  it("coerces invalid values instead of crashing", () => {
    const state = initialState();
    const dirty = JSON.parse(JSON.stringify(state));
    dirty.ideas[0].scores.pain = 99;
    dirty.ideas[0].gates.g_pain = "MAYBE";
    dirty.settings.weights.market = -5;
    const restored = normalizeState(dirty);
    expect(restored.ideas[0].scores.pain).toBeNull();
    expect(restored.ideas[0].gates.g_pain).toBeNull();
    expect(restored.settings.weights.market).toBe(12);
  });
});

describe("pipelineCSV", () => {
  it("emits a header plus one row per idea and escapes commas/quotes", () => {
    const state = initialState();
    const idea = newIdea({ name: 'Acme, "The" Best' });
    const csv = pipelineCSV([idea], state.settings);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith("Name,Domain")).toBe(true);
    expect(lines[1]).toContain('"Acme, ""The"" Best"');
    expect(lines[1]).toContain("PENDING");
  });

  it("quotes fields containing bare carriage returns", () => {
    const state = initialState();
    const idea = newIdea({ name: "Acme\rCo" });
    const csv = pipelineCSV([idea], state.settings);
    expect(csv).toContain('"Acme\rCo"');
  });
});
