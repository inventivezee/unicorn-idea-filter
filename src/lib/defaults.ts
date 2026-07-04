import { DEFAULT_WEIGHTS } from "./criteria";
import { CRITERION_IDS, GATE_IDS } from "./types";
import type {
  AppState,
  CriterionId,
  GateId,
  GateValue,
  Idea,
  Provider,
  Settings,
} from "./types";

export const ANTHROPIC_MODELS = [
  { id: "claude-fable-5", label: "Claude Fable 5 (most capable, xhigh effort)" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8 (recommended)" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

export const OPENAI_MODELS = [
  { id: "gpt-5.5", label: "GPT-5.5 (most capable, xhigh reasoning)" },
  { id: "gpt-5.1", label: "GPT-5.1 (recommended)" },
  { id: "gpt-5", label: "GPT-5" },
  { id: "gpt-5-mini", label: "GPT-5 mini" },
  { id: "gpt-4.1", label: "GPT-4.1" },
];

export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-5.1",
};

export const DEFAULT_TRIALS = 300;

export function emptyGates(): Record<GateId, GateValue> {
  return Object.fromEntries(GATE_IDS.map((id) => [id, null])) as Record<
    GateId,
    GateValue
  >;
}

export function emptyScores(): Record<CriterionId, number | null> {
  return Object.fromEntries(CRITERION_IDS.map((id) => [id, null])) as Record<
    CriterionId,
    number | null
  >;
}

export function defaultSettings(): Settings {
  return {
    weights: { ...DEFAULT_WEIGHTS },
    trials: DEFAULT_TRIALS,
    provider: "anthropic",
    models: { ...DEFAULT_MODELS },
    founderBackground: "",
    coFounders: [],
    webSearch: true,
  };
}

export function generateId(prefix: string): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export function newIdea(partial?: Partial<Idea>): Idea {
  const now = new Date().toISOString();
  const idea: Idea = {
    id: "",
    name: "",
    domain: "",
    businessModel: "",
    buyerICP: "",
    initialWedge: "",
    thesisNotes: "",
    gates: emptyGates(),
    scores: emptyScores(),
    confidence: null,
    validationTest30d: "",
    ai: null,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
  // The id survives spreads of partials that carry id: undefined (e.g. from
  // imported JSON) — generate it last so it can never be clobbered away.
  if (!idea.id || typeof idea.id !== "string") {
    idea.id = generateId("idea");
  }
  return idea;
}

/** Two generic, clearly-marked example ideas so first-time users see how the pipeline works. */
export function seedIdeas(): Idea[] {
  return [
    newIdea({
      id: "example-ai-compliance-copilot",
      name: "Example: AI Compliance Copilot",
      domain: "AI",
      businessModel: "SaaS",
      buyerICP: "Head of Compliance at mid-market fintechs (50–500 employees)",
      initialWedge:
        "Automated evidence collection for SOC 2 renewals, expanding into continuous controls monitoring",
      thesisNotes:
        "Compliance teams burn hundreds of hours assembling audit evidence by hand. LLMs can read policies, map controls, and draft evidence packages. Wedge in via one painful audit framework, expand to the full GRC suite.",
      validationTest30d:
        "Interview 15 compliance leads; get 3 signed pilots for automated SOC 2 evidence collection.",
      isExample: true,
    }),
    newIdea({
      id: "example-field-service-marketplace",
      name: "Example: Field Service Parts Marketplace",
      domain: "B2B Marketplace",
      businessModel: "Marketplace",
      buyerICP:
        "Operations managers at HVAC / electrical service companies (10–200 technicians)",
      initialWedge:
        "Same-day sourcing of scarce repair parts in one metro, expanding city-by-city",
      thesisNotes:
        "Technicians lose whole jobs waiting days for parts. Distributors have fragmented, offline inventory. Aggregate real-time availability and courier delivery; take rate on urgent orders where willingness to pay is highest.",
      validationTest30d:
        "Manually broker 20 urgent parts orders in one city; measure fill rate, take rate tolerance, and repeat usage.",
      isExample: true,
    }),
  ];
}

export function initialState(): AppState {
  return {
    version: 1,
    ideas: seedIdeas(),
    settings: defaultSettings(),
  };
}
