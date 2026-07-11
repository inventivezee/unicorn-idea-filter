// Discovery engine prompts. Generation agents get the unicorn instrument as
// GUIDANCE (and explicit permission to refine the metrics they research
// against); scoring reuses the app's canonical evaluator prompts so the
// instrument semantics are identical to interactive analysis.
import { CRITERIA, GATES } from "@/lib/criteria";
import { buildSystemPrompt, buildUserPrompt } from "@/lib/ai/prompt";
import type { CoFounderInput } from "@/lib/ai/prompt";

/** Final structured output of generation/reframe synthesis. Lean on purpose
 *  (invariant #4 — this schema compiles into Anthropic's constrained-decoding
 *  grammar); everything semantic lives in the prompts. */
export const IDEA_GEN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    domain: { type: "string" },
    businessModel: { type: "string" },
    buyerICP: { type: "string" },
    initialWedge: { type: "string" },
    thesisNotes: { type: "string" },
  },
  required: [
    "name",
    "domain",
    "businessModel",
    "buyerICP",
    "initialWedge",
    "thesisNotes",
  ],
} as const;

export interface GeneratedIdea {
  name: string;
  domain: string;
  businessModel: string;
  buyerICP: string;
  initialWedge: string;
  thesisNotes: string;
}

export function normalizeGeneratedIdea(raw: unknown): GeneratedIdea | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (k: string, max: number) =>
    typeof r[k] === "string" ? (r[k] as string).trim().slice(0, max) : "";
  const idea: GeneratedIdea = {
    name: str("name", 80),
    domain: str("domain", 200),
    businessModel: str("businessModel", 500),
    buyerICP: str("buyerICP", 1500),
    initialWedge: str("initialWedge", 1500),
    thesisNotes: str("thesisNotes", 20000),
  };
  return idea.name && idea.thesisNotes ? idea : null;
}

/** Compact instrument summary for generation guidance (full anchors live in
 *  the scoring prompts — generators only need to know the bar). */
function instrumentSummary(): string {
  return `Hard gates (an idea failing ANY of these dies):\n${GATES.map(
    (g) => `- ${g.label}`,
  ).join("\n")}\n\nWeighted criteria (0–5 each; weights shown):\n${CRITERIA.map(
    (c) => `- ${c.label} (${c.defaultWeight})`,
  ).join("\n")}`;
}

const ANONYMITY_RULE = `PRIVACY (hard rule): every field you write may be shown PUBLICLY. If founder background informs the idea, reference the advantage ONLY in anonymised categorical terms ("a founder with a decade in enterprise payments infrastructure") — NEVER names, employers, schools, cities, or anything identifying.`;

export function buildDiscoveryResearchSystem(opts: {
  guidelines: string;
  founderBackground: string;
  round: number;
  /** One-line digests of sibling candidates already in this run. */
  siblings?: string;
}): string {
  return `You are an elite startup scout inside the "Unicorn Idea Filter". Your mission: through REAL market research, originate ONE startup idea with a credible path to a $1B+ (unicorn/IPO-scale) company.

You have a REAL browser with powerful tools: web_search (Google; set num_results 10-100, plus optional vertical: news/scholar/patents, recency, country), open_page (reads pages AND full PDFs; long documents paginate — follow the from_char/pdf_pages continuation hints in the footers), scroll_page (reveal lazy-loaded content: reviews, feeds, tables), click_element (open pricing tabs, 'load more', accordions), and — if you can see images — view_page (screenshot; full_page: true for whole-page charts and tables). Use them extensively: market sizes, funding activity, emerging pain points, competitive gaps, regulatory shifts, technology inflections. Ground every claim in what you actually find; do not invent statistics.

The idea will later be scored by an independent evaluator against this instrument:

${instrumentSummary()}

Treat these metrics as your baseline — and refine or extend them where your research reveals better signals for this space (e.g. regulatory tailwinds, supply-chain shifts, distribution wedges). Optimizing for the *spirit* of the bar (venture-scale outcome) beats gaming individual line items.

${
  opts.founderBackground
    ? `FOUNDER FIT: an idea this founder could credibly build is worth more. Their background:\n${opts.founderBackground}\n\n${ANONYMITY_RULE}`
    : "No founder background was provided — optimize purely for idea quality."
}

Focus areas from the founder: ${opts.guidelines || "(none — any industry)"}
${
  opts.round > 1
    ? `\nThis is candidate #${opts.round} from you in this run — pick a DIFFERENT wedge, market, or model than your first instinct; avoid the obvious first-choice idea for this space.`
    : ""
}
${
  opts.siblings
    ? `\nCANDIDATES ALREADY BEING DEVELOPED by sibling agents in this run — your idea must be CLEARLY DISTINCT from every one of them (different problem, buyer, or wedge — not a rewording):\n${opts.siblings}`
    : ""
}

Work method: search broadly → open the most promising sources → follow the evidence. When (and only when) you are confident you've mapped the space, STOP calling tools and write your final RESEARCH BRIEF as plain text: (1) the TOP 3 candidate framings you found, each with a short comparative assessment against the instrument; (2) your PICK and why; (3) for the pick — the opportunity, the evidence (with the numbers you verified and where), why now, the wedge, competition, and the founder-fit angle. Keep it under 2500 words.`;
}

export function buildDiscoveryResearchPrompt(guidelines: string): string {
  return `Begin your market research now. Focus areas: ${guidelines || "open — find the best opportunity anywhere"}. Remember: verify claims with the browser tools before relying on them.`;
}

export function buildGenerationSynthesisSystem(): string {
  return `You turn a research brief into ONE structured startup idea for the Unicorn Idea Filter database. Write tight, specific, evidence-grounded fields — a reader should understand exactly who pays, for what, and why this wins. thesisNotes: the core insight, why it wins, why now, and the strongest evidence from the research (with the concrete numbers found). ${ANONYMITY_RULE}`;
}

export function buildGenerationSynthesisPrompt(
  researchBrief: string,
  critique?: string,
  researchLog?: string,
): string {
  return `## Research brief\n\n${researchBrief}${
    critique ? `\n\n## Red-team critique (address its recommendation)\n\n${critique}` : ""
  }${
    researchLog
      ? `\n\n## Appendix: full research transcript (raw — use it to recover specifics the brief compressed away)\n\n${researchLog.slice(-300_000)}`
      : ""
  }\n\nProduce the final structured idea now.`;
}

export function buildCritiqueSystem(): string {
  return `You are a ruthless venture red-teamer. You receive a scout's research brief proposing candidate startup framings and a pick. Attack it: is the pick actually the strongest of the three against the instrument (venture-scale bar)? Which specific gates/criteria is it weakest on, and does one of the alternates dominate it? What would a skeptical partner meeting kill it for? End with: (1) FINAL FRAMING — keep the pick or switch to an alternate, stated plainly; (2) three concrete strengthenings (sharper wedge, better buyer, stronger why-now) the final idea must incorporate. Under 1200 words.`;
}

// ---------------------------------------------------------------------------
// Scoring — research loop + synthesis reusing the canonical evaluator.
// ---------------------------------------------------------------------------
export function buildScoringResearchSystem(idea: GeneratedIdea): string {
  return `You are the research arm of a rigorous venture evaluator. You will soon score this startup idea against a fixed instrument — first, gather INDEPENDENT evidence. You have a REAL browser with powerful tools: web_search (Google; set num_results 10-100, plus optional vertical: news/scholar/patents, recency, country), open_page (reads pages AND full PDFs; long documents paginate — follow the from_char/pdf_pages continuation hints in the footers), scroll_page (reveal lazy-loaded content: reviews, feeds, tables), click_element (open pricing tabs, 'load more', accordions), and — if you can see images — view_page (screenshot; full_page: true for whole-page charts and tables). Use them to: validate or refute the market-size claims, find real competitors, check pricing norms, funding activity, and why-now signals. Be adversarial: hunt for the evidence that would KILL this idea, not just support it.

Idea under evaluation:
Name: ${idea.name}
Domain: ${idea.domain}
Business model: ${idea.businessModel}
Buyer/ICP: ${idea.buyerICP}
Initial wedge: ${idea.initialWedge}
Thesis: ${idea.thesisNotes}

When you have enough evidence for a calibrated verdict, STOP calling tools and write a plain-text EVIDENCE MEMO (under 2000 words): what you verified, what you refuted, competitors found, and the decisive facts — each tagged with where you found it.`;
}

/** Round 2 of two-round scoring: the FINAL scorer reviews the first
 *  model's verdict WITH its own browser access, verifies what it doubts,
 *  and prepares to own the final updated score. */
export function buildScoringFeedbackSystem(opts: {
  idea: GeneratedIdea;
  firstVerdict: string;
  evidenceMemo: string;
}): string {
  return `You are the SECOND and FINAL evaluator in a two-model scoring panel for startup ideas. A first evaluator (a different AI) already researched and scored it — its evidence memo and full verdict are below. YOU will produce the final verdict shortly; this is your research pass. Check the scoring that was already done: take the good results and insights from it, and correct what the evidence doesn't support — too generous, too harsh, gates called wrong, evidence missed or misread. You have the same browser tools (web_search with Google, open_page, scroll_page, click_element, view_page) — USE them to verify any claim you doubt and to fill gaps with your own evidence rather than guessing.

Idea under evaluation:
Name: ${opts.idea.name}
Domain: ${opts.idea.domain}
Business model: ${opts.idea.businessModel}
Buyer/ICP: ${opts.idea.buyerICP}
Initial wedge: ${opts.idea.initialWedge}
Thesis: ${opts.idea.thesisNotes}

The first evaluator's evidence memo:
${opts.evidenceMemo}

The first evaluator's VERDICT:
${opts.firstVerdict}

When you have verified enough for a calibrated final call, STOP calling tools and write a plain-text VERIFICATION MEMO (under 1500 words): what you accept from the first verdict (and why it's solid), what you correct (with your evidence), and anything material it missed.`;
}

export function buildScoringFeedbackPrompt(): string {
  return "Begin your scoring pass now: review the first verdict, verify what you doubt with the browser tools, then write your verification memo.";
}

export function buildScoringResearchPrompt(): string {
  return "Begin your independent evidence gathering now.";
}

/** Scoring synthesis = the app's canonical evaluator prompt + the browser
 *  evidence memo. webSearch is OFF for this call (browser was the research
 *  surface); searchBudget null keeps the system prompt's search rule out. */
export function buildScoringSynthesisSystem(): string {
  return buildSystemPrompt(null);
}

export function buildScoringSynthesisPrompt(opts: {
  idea: GeneratedIdea;
  founderBackground: string;
  coFounders: CoFounderInput[];
  evidenceMemo: string;
  researchLog?: string;
  /** Round-2 final scoring: the first model's verdict + your own
   *  verification memo. */
  firstVerdict?: string;
  verificationMemo?: string;
}): string {
  const base = buildUserPrompt(
    {
      name: opts.idea.name,
      domain: opts.idea.domain,
      businessModel: opts.idea.businessModel,
      buyerICP: opts.idea.buyerICP,
      initialWedge: opts.idea.initialWedge,
      thesisNotes: opts.idea.thesisNotes,
    },
    opts.founderBackground,
    opts.coFounders,
    [],
  );
  return `${base}

## Gate discipline for autonomous scoring
You researched this idea with a live browser: commit to Y or N on every evidence-based gate — UNSURE wastes the research. For the founder-personal gates (team edge, decade commitment): answer from the founder background when provided; if it is silent, answer Y and state the assumption in the rationale (there is no founder in the loop to confirm).

## Independent research evidence (gathered live by your research arm — weigh it above the pitch's own claims)

${opts.evidenceMemo || "(no research memo available)"}${
    opts.firstVerdict
      ? `\n\n## First evaluator's verdict (a different AI scored this before you)\n\nTake the good results and insights from it; correct what the evidence doesn't support:\n\n${opts.firstVerdict}`
      : ""
  }${
    opts.verificationMemo
      ? `\n\n## Your verification memo (you wrote this after reviewing the first verdict with your own browser research)\n\n${opts.verificationMemo}\n\nNow produce the FINAL, updated verdict — yours is the score of record.`
      : ""
  }${
    opts.researchLog
      ? `\n\n## Appendix: full evidence-gathering transcript (raw)\n\n${opts.researchLog.slice(-300_000)}`
      : ""
  }`;
}

// ---------------------------------------------------------------------------
// Reframe — rescue a failing idea (same output schema as generation).
// ---------------------------------------------------------------------------
export function buildReframeResearchSystem(opts: {
  idea: GeneratedIdea;
  verdictSummary: string;
  history?: Array<{ name: string; summary: string }>;
}): string {
  return `You rescue startup ideas that failed a venture-scale evaluation. The instrument judged this idea too weak; your job is to find — through REAL browser research (search verticals, page reading with pagination, scrolling, clicking, PDFs, screenshots) — a substantive reframe that attacks the verdict's specific weaknesses: a different buyer, wedge, business model, or scope that clears the bar the original missed.

Original idea:
Name: ${opts.idea.name}
Domain: ${opts.idea.domain}
Business model: ${opts.idea.businessModel}
Buyer/ICP: ${opts.idea.buyerICP}
Initial wedge: ${opts.idea.initialWedge}
Thesis: ${opts.idea.thesisNotes}

Why it failed:
${opts.verdictSummary}
${
  opts.history?.length
    ? `\nPRIOR RESCUE ATTEMPTS that STILL FAILED — do something meaningfully different from all of them:\n${opts.history
        .map((h, i) => `Attempt ${i + 1} ("${h.name}"): ${h.summary}`)
        .join("\n\n")}`
    : ""
}
Research the failure points, then STOP calling tools and write a plain-text REFRAME BRIEF (under 2000 words): up to THREE candidate pivots you found, each assessed against the specific bars the original failed; then your PICK — the strongest single reframe — with the evidence it clears those bars and what changed.`;
}

export function buildReframeSynthesisSystem(): string {
  return `You turn a reframe brief into ONE structured startup idea (the REFRAMED version — a genuinely different attack, not a reworded pitch). Fields must be specific and evidence-grounded. In thesisNotes, open with the core insight of the reframe, then why it clears the bars the original failed. ${ANONYMITY_RULE}`;
}
