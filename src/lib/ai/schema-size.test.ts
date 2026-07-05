import { describe, expect, it } from "vitest";
import {
  ANALYSIS_SCHEMA,
  CC_ANALYSIS_SCHEMA,
  CLARIFY_SCHEMA,
  FILTER_DESIGN_SCHEMA,
  IDEAS_GEN_SCHEMA,
  METADATA_SCHEMA,
  REFRAME_SCHEMA,
  buildCustomAnalysisSchema,
} from "./schema";

// Anthropic's constrained-decoding grammar compiler rejects oversized schemas
// ("compiled grammar is too large"). Keep the analysis schemas lean — the full
// scoring semantics live in the system prompt, not the schema.
describe("AI schema size budget", () => {
  it("stays under the grammar budget", () => {
    const size = JSON.stringify(ANALYSIS_SCHEMA).length;
    console.log("ANALYSIS_SCHEMA:", size, "chars");
    expect(size).toBeLessThan(6000);
    // 29 gate/criterion entries vs the unicorn's 24 — a slightly larger but
    // still comfortably-compiling budget (the live failure was at ~15k).
    const ccSize = JSON.stringify(CC_ANALYSIS_SCHEMA).length;
    console.log("CC_ANALYSIS_SCHEMA:", ccSize, "chars");
    expect(ccSize).toBeLessThan(7500);
    expect(JSON.stringify(METADATA_SCHEMA).length).toBeLessThan(2500);
    expect(JSON.stringify(CLARIFY_SCHEMA).length).toBeLessThan(600);
    expect(JSON.stringify(IDEAS_GEN_SCHEMA).length).toBeLessThan(1200);
    expect(JSON.stringify(REFRAME_SCHEMA).length).toBeLessThan(800);
    expect(JSON.stringify(FILTER_DESIGN_SCHEMA).length).toBeLessThan(2500);
  });

  it("custom analysis schema stays under budget at max spec size", () => {
    // normalizeCustomFilterSpec caps specs at 9 gates + 14 criteria — build
    // the schema at that ceiling, the worst case the API can ever receive.
    const maxSpec = {
      gates: Array.from({ length: 9 }, (_, i) => ({ id: `g${i + 1}` })),
      criteria: Array.from({ length: 14 }, (_, i) => ({ id: `c${i + 1}` })),
    };
    const size = JSON.stringify(buildCustomAnalysisSchema(maxSpec)).length;
    console.log("custom analysis schema (max spec):", size, "chars");
    expect(size).toBeLessThan(9000);
  });
});
