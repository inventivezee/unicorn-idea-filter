import { DEFAULT_WEIGHTS, CRITERIA_BY_ID } from "./criteria";
import { defaultSettings, emptyGates, emptyScores, newIdea } from "./defaults";
import { adjustedScore, decision, gateStatus, killerFlags, rawScore } from "./engine";
import { CRITERION_IDS, GATE_IDS } from "./types";
import type { AppState, Idea, Settings } from "./types";

/** Coerce unknown persisted/imported JSON into a valid AppState. Throws on garbage. */
export function normalizeState(data: unknown): AppState {
  if (!data || typeof data !== "object") throw new Error("Not an object");
  const obj = data as Partial<AppState>;
  if (!Array.isArray(obj.ideas) || typeof obj.settings !== "object" || !obj.settings) {
    throw new Error("Missing ideas or settings");
  }
  const base = defaultSettings();
  const s = obj.settings as Partial<Settings>;
  const settings: Settings = {
    weights: { ...base.weights },
    trials:
      typeof s.trials === "number" && s.trials > 0
        ? Math.floor(s.trials)
        : base.trials,
    provider: s.provider === "openai" ? "openai" : "anthropic",
    models: {
      anthropic:
        typeof s.models?.anthropic === "string" && s.models.anthropic
          ? s.models.anthropic
          : base.models.anthropic,
      openai:
        typeof s.models?.openai === "string" && s.models.openai
          ? s.models.openai
          : base.models.openai,
    },
    founderBackground:
      typeof s.founderBackground === "string" ? s.founderBackground : "",
  };
  for (const id of CRITERION_IDS) {
    const w = s.weights?.[id];
    settings.weights[id] =
      typeof w === "number" && isFinite(w) && w >= 0 ? w : DEFAULT_WEIGHTS[id];
  }

  const ideas: Idea[] = obj.ideas.map((raw) => {
    const i = (raw ?? {}) as Partial<Idea>;
    const idea = newIdea({
      id: typeof i.id === "string" && i.id ? i.id : undefined,
      name: typeof i.name === "string" ? i.name : "",
      domain: typeof i.domain === "string" ? i.domain : "",
      businessModel: typeof i.businessModel === "string" ? i.businessModel : "",
      buyerICP: typeof i.buyerICP === "string" ? i.buyerICP : "",
      initialWedge: typeof i.initialWedge === "string" ? i.initialWedge : "",
      thesisNotes: typeof i.thesisNotes === "string" ? i.thesisNotes : "",
      confidence:
        i.confidence === 0.5 || i.confidence === 0.75 || i.confidence === 1.0
          ? i.confidence
          : null,
      validationTest30d:
        typeof i.validationTest30d === "string" ? i.validationTest30d : "",
      ai: i.ai ?? null,
      createdAt:
        typeof i.createdAt === "string" ? i.createdAt : new Date().toISOString(),
      updatedAt:
        typeof i.updatedAt === "string" ? i.updatedAt : new Date().toISOString(),
    });
    const gates = emptyGates();
    for (const id of GATE_IDS) {
      const v = i.gates?.[id];
      if (v === "Y" || v === "N") gates[id] = v;
    }
    if (i.isExample === true) idea.isExample = true;
    if (typeof i.topRiskOverride1 === "string") {
      idea.topRiskOverride1 = i.topRiskOverride1;
    }
    if (typeof i.topRiskOverride2 === "string") {
      idea.topRiskOverride2 = i.topRiskOverride2;
    }
    idea.gates = gates;
    const scores = emptyScores();
    for (const id of CRITERION_IDS) {
      const v = i.scores?.[id];
      if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 5) {
        scores[id] = v;
      }
    }
    idea.scores = scores;
    return idea;
  });

  return { version: 1, ideas, settings };
}

function csvEscape(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV export of the pipeline table. */
export function pipelineCSV(ideas: Idea[], settings: Settings): string {
  const header = [
    "Name",
    "Domain",
    "Business model",
    "Gate status",
    "Raw score",
    "Confidence",
    "Adjusted",
    "Decision",
    "Killer flags",
    "Updated",
  ];
  const rows = ideas.map((i) => {
    const raw = rawScore(i.scores, settings.weights);
    const adj = adjustedScore(raw, i.confidence);
    const flags = killerFlags(i.scores, settings.weights)
      .map((id) => CRITERIA_BY_ID[id].label)
      .join("; ");
    return [
      i.name,
      i.domain,
      i.businessModel,
      gateStatus(i.gates),
      raw === null ? "" : raw.toFixed(1),
      i.confidence === null ? "" : `${i.confidence * 100}%`,
      adj === null ? "" : adj.toFixed(1),
      decision({
        name: i.name,
        gates: i.gates,
        scores: i.scores,
        confidence: i.confidence,
        weights: settings.weights,
      }) ?? "",
      flags,
      i.updatedAt,
    ];
  });
  return [header, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");
}
