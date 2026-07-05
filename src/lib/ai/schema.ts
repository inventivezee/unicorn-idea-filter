// JSON Schemas for AI output — shared verbatim by both providers.
// IMPORTANT: keep these LEAN. Anthropic compiles the schema into a
// constrained-decoding grammar and rejects oversized ones ("compiled grammar
// is too large"), especially combined with server tools. All scoring
// semantics, anchors, and gate definitions live in the system prompt — the
// schema only pins the shape. Both providers also require
// additionalProperties:false with every property required, and neither
// supports minimum/maximum (hence integer enums).
import { CC_CRITERIA, CC_GATES } from "../cashcow/criteria";
import { CRITERIA, GATES } from "../criteria";

const GATE_VALUE = {
  type: "object",
  properties: {
    value: { type: "string", enum: ["Y", "N", "UNSURE"] },
    rationale: { type: "string" },
  },
  required: ["value", "rationale"],
  additionalProperties: false,
} as const;

const SCORE_VALUE = {
  type: "object",
  properties: {
    score: { type: "integer", enum: [0, 1, 2, 3, 4, 5] },
    rationale: { type: "string" },
  },
  required: ["score", "rationale"],
  additionalProperties: false,
} as const;

const METADATA_OBJECT = {
  type: "object",
  properties: {
    name: { type: "string" },
    domain: { type: "string" },
    businessModel: { type: "string" },
    buyerICP: { type: "string" },
    initialWedge: { type: "string" },
  },
  required: ["name", "domain", "businessModel", "buyerICP", "initialWedge"],
  additionalProperties: false,
} as const;

export const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    metadata: METADATA_OBJECT,
    founderProfile: { type: "string" },
    gates: {
      type: "object",
      properties: Object.fromEntries(GATES.map((g) => [g.id, GATE_VALUE])),
      required: GATES.map((g) => g.id),
      additionalProperties: false,
    },
    scores: {
      type: "object",
      properties: Object.fromEntries(CRITERIA.map((c) => [c.id, SCORE_VALUE])),
      required: CRITERIA.map((c) => c.id),
      additionalProperties: false,
    },
    confidence: { type: "string", enum: ["0.5", "0.75", "1.0"] },
    confidenceRationale: { type: "string" },
    validationTest30d: { type: "string" },
    needsFounderConfirmation: {
      type: "array",
      items: { type: "string", enum: GATES.map((g) => g.id) },
    },
  },
  required: [
    "summary",
    "metadata",
    "founderProfile",
    "gates",
    "scores",
    "confidence",
    "confidenceRationale",
    "validationTest30d",
    "needsFounderConfirmation",
  ],
  additionalProperties: false,
} as const;

/** Cash Cow Filter analysis — same shape as ANALYSIS_SCHEMA over the 11
 *  cash-cow gates and 18 criteria. Shape only; semantics live in the prompt. */
export const CC_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    metadata: METADATA_OBJECT,
    founderProfile: { type: "string" },
    gates: {
      type: "object",
      properties: Object.fromEntries(CC_GATES.map((g) => [g.id, GATE_VALUE])),
      required: CC_GATES.map((g) => g.id),
      additionalProperties: false,
    },
    scores: {
      type: "object",
      properties: Object.fromEntries(
        CC_CRITERIA.map((c) => [c.id, SCORE_VALUE]),
      ),
      required: CC_CRITERIA.map((c) => c.id),
      additionalProperties: false,
    },
    confidence: { type: "string", enum: ["0.5", "0.75", "1.0"] },
    confidenceRationale: { type: "string" },
    validationTest30d: { type: "string" },
    needsFounderConfirmation: {
      type: "array",
      items: { type: "string", enum: CC_GATES.map((g) => g.id) },
    },
  },
  required: [
    "summary",
    "metadata",
    "founderProfile",
    "gates",
    "scores",
    "confidence",
    "confidenceRationale",
    "validationTest30d",
    "needsFounderConfirmation",
  ],
  additionalProperties: false,
} as const;

/** Schema for the lightweight "Add only" fill — metadata + description, no scoring. */
export const METADATA_SCHEMA = {
  type: "object",
  properties: {
    metadata: METADATA_OBJECT,
    refinedDescription: { type: "string" },
    founderProfile: { type: "string" },
  },
  required: ["metadata", "refinedDescription", "founderProfile"],
  additionalProperties: false,
} as const;

/** Schema for the clarifying questions asked before an idea is added.
 *  Each question ships click-to-answer options; the UI adds an "Other" field. */
export const CLARIFY_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
        required: ["question", "options"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
} as const;

/** Schema for AI-summarising an uploaded CV into a founder background. */
export const CV_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    background: { type: "string" },
  },
  required: ["background"],
  additionalProperties: false,
} as const;

/** Schema for an AI web-search lookup of a founder from a profile URL. */
export const PROFILE_LOOKUP_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    background: { type: "string" },
    sources: { type: "array", items: { type: "string" } },
  },
  required: ["found", "background", "sources"],
  additionalProperties: false,
} as const;

/** One generated idea (the "Help me generate" feature). Lean: shape only. */
const GENERATED_IDEA = {
  type: "object",
  properties: {
    name: { type: "string" },
    pitch: { type: "string" },
    domain: { type: "string" },
    businessModel: { type: "string" },
    buyerICP: { type: "string" },
    initialWedge: { type: "string" },
    whyNow: { type: "string" },
    whyYou: { type: "string" },
  },
  required: [
    "name",
    "pitch",
    "domain",
    "businessModel",
    "buyerICP",
    "initialWedge",
    "whyNow",
    "whyYou",
  ],
  additionalProperties: false,
} as const;

export const IDEAS_GEN_SCHEMA = {
  type: "object",
  properties: {
    ideas: { type: "array", items: GENERATED_IDEA },
  },
  required: ["ideas"],
  additionalProperties: false,
} as const;

/** Reframes of a weak idea: substantive mutations that attack its weaknesses. */
export const REFRAME_SCHEMA = {
  type: "object",
  properties: {
    reframes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          pitch: { type: "string" },
          whatChanged: { type: "string" },
          risksAddressed: { type: "string" },
        },
        required: ["name", "pitch", "whatChanged", "risksAddressed"],
        additionalProperties: false,
      },
    },
  },
  required: ["reframes"],
  additionalProperties: false,
} as const;

/** Schema for AI-designing a custom filter from the founder's goals. */
export const FILTER_DESIGN_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    question: { type: "string" },
    gates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          yMeans: { type: "string" },
          nMeans: { type: "string" },
        },
        required: ["label", "yMeans", "nMeans"],
        additionalProperties: false,
      },
    },
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          weight: { type: "integer" },
          anchor0: { type: "string" },
          anchor3: { type: "string" },
          anchor5: { type: "string" },
        },
        required: ["label", "weight", "anchor0", "anchor3", "anchor5"],
        additionalProperties: false,
      },
    },
  },
  required: ["name", "question", "gates", "criteria"],
  additionalProperties: false,
} as const;

/**
 * Analysis schema for a CUSTOM filter — built at request time from the
 * founder's spec (dynamic gate/criterion ids). Spec caps (≤9 gates, ≤14
 * criteria) keep the compiled grammar comfortably inside the size budget the
 * static schemas are tested against.
 */
export function buildCustomAnalysisSchema(spec: {
  gates: { id: string }[];
  criteria: { id: string }[];
}): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      summary: { type: "string" },
      metadata: METADATA_OBJECT,
      founderProfile: { type: "string" },
      gates: {
        type: "object",
        properties: Object.fromEntries(spec.gates.map((g) => [g.id, GATE_VALUE])),
        required: spec.gates.map((g) => g.id),
        additionalProperties: false,
      },
      scores: {
        type: "object",
        properties: Object.fromEntries(
          spec.criteria.map((c) => [c.id, SCORE_VALUE]),
        ),
        required: spec.criteria.map((c) => c.id),
        additionalProperties: false,
      },
      confidence: { type: "string", enum: ["0.5", "0.75", "1.0"] },
      confidenceRationale: { type: "string" },
      validationTest30d: { type: "string" },
      needsFounderConfirmation: {
        type: "array",
        items: { type: "string", enum: spec.gates.map((g) => g.id) },
      },
    },
    required: [
      "summary",
      "metadata",
      "founderProfile",
      "gates",
      "scores",
      "confidence",
      "confidenceRationale",
      "validationTest30d",
      "needsFounderConfirmation",
    ],
    additionalProperties: false,
  };
}
