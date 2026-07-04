// JSON Schemas for AI output — shared verbatim by both providers.
// IMPORTANT: keep these LEAN. Anthropic compiles the schema into a
// constrained-decoding grammar and rejects oversized ones ("compiled grammar
// is too large"), especially combined with server tools. All scoring
// semantics, anchors, and gate definitions live in the system prompt — the
// schema only pins the shape. Both providers also require
// additionalProperties:false with every property required, and neither
// supports minimum/maximum (hence integer enums).
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
