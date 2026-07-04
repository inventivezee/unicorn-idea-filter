// JSON Schema for the AI analysis output — shared verbatim by both providers.
// Constraints: Anthropic structured outputs and OpenAI strict mode both require
// additionalProperties:false and every property listed in `required`; neither
// reliably supports minimum/maximum, so scores use integer enums instead.
import { CRITERIA, GATES } from "../criteria";

const gateProperties = Object.fromEntries(
  GATES.map((g) => [
    g.id,
    {
      type: "object",
      description: `Gate: ${g.label}. Y means: ${g.yMeans}. N means: ${g.nMeans}.`,
      properties: {
        value: {
          type: "string",
          enum: ["Y", "N", "UNSURE"],
          description:
            "Y if the gate clearly passes, N if it clearly fails, UNSURE if the available information cannot settle it.",
        },
        rationale: {
          type: "string",
          description: "1–2 sentences of evidence-based reasoning.",
        },
      },
      required: ["value", "rationale"],
      additionalProperties: false,
    },
  ]),
);

const scoreProperties = Object.fromEntries(
  CRITERIA.map((c) => [
    c.id,
    {
      type: "object",
      description: `Criterion: ${c.label}. 0 means: ${c.anchor0}. 3 means: ${c.anchor3}. 5 means: ${c.anchor5}. 1, 2 and 4 interpolate.`,
      properties: {
        score: { type: "integer", enum: [0, 1, 2, 3, 4, 5] },
        rationale: {
          type: "string",
          description: "1–2 sentences justifying the score against the anchors.",
        },
      },
      required: ["score", "rationale"],
      additionalProperties: false,
    },
  ]),
);

export const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "3–5 sentence overall assessment of the idea against a unicorn/IPO bar, referencing the founder's background where relevant.",
    },
    metadata: {
      type: "object",
      description:
        "Concise metadata inferred from the idea description. Always fill every field with your best inference — the app applies these only where the founder left a field blank.",
      properties: {
        name: {
          type: "string",
          description:
            "Short, memorable working name for the idea (under 40 characters, no quotes, not a sentence).",
        },
        domain: {
          type: "string",
          description: 'Domain/sector, e.g. "AI", "Fintech", "AI + Bio".',
        },
        businessModel: {
          type: "string",
          description:
            'Business model, e.g. "SaaS", "Marketplace", "Fintech/Payments", "Infra", "Consumer".',
        },
        buyerICP: {
          type: "string",
          description:
            "Who pays: the ideal customer profile in one specific phrase.",
        },
        initialWedge: {
          type: "string",
          description:
            "The narrow initial wedge plus the expansion direction, one sentence.",
        },
      },
      required: ["name", "domain", "businessModel", "buyerICP", "initialWedge"],
      additionalProperties: false,
    },
    gates: {
      type: "object",
      properties: gateProperties,
      required: GATES.map((g) => g.id),
      additionalProperties: false,
    },
    scores: {
      type: "object",
      properties: scoreProperties,
      required: CRITERIA.map((c) => c.id),
      additionalProperties: false,
    },
    confidence: {
      type: "string",
      enum: ["0.5", "0.75", "1.0"],
      description:
        "0.5 = intuition only; 0.75 = expert or customer signals exist; 1.0 = strong proof or bottom-up math. AI analysis of a written description should almost always be 0.5, or 0.75 when the description cites concrete evidence (pilots, LOIs, revenue, verified data).",
    },
    confidenceRationale: { type: "string" },
    validationTest30d: {
      type: "string",
      description:
        "A concrete, falsifiable 30-day validation test targeting the biggest risk: what to do, with whom, and the numeric threshold that counts as a pass.",
    },
    needsFounderConfirmation: {
      type: "array",
      description:
        "Gate ids whose answer depends on the founder personally (commitment, personal advantages) or where you marked UNSURE — the founder must confirm these manually.",
      items: { type: "string", enum: GATES.map((g) => g.id) },
    },
  },
  required: [
    "summary",
    "metadata",
    "gates",
    "scores",
    "confidence",
    "confidenceRationale",
    "validationTest30d",
    "needsFounderConfirmation",
  ],
  additionalProperties: false,
} as const;
