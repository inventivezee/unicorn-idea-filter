// Cash Cow Filter definitions, transcribed from the operator's
// "100M Cash Cow Filter v2" spreadsheet. The instrument asks: can this become
// a company producing $20M+ EBITDA/year with durable enterprise value?
// (The unicorn filter asks: venture-scale, category-defining, possibly public.)
//
// 18 criteria, weights sum to 100 (each weight reads as a percentage).
// Anchors are given at 1 / 3 / 5 in the source; scores are integers 0–5.
import type { CcCriterionId, CcGateId } from "../types";

export interface CcCriterionDef {
  id: CcCriterionId;
  label: string;
  weight: number;
  anchor1: string;
  anchor3: string;
  anchor5: string;
}

export const CC_CRITERIA: CcCriterionDef[] = [
  {
    id: "cc_pain",
    label: "Pain / urgency",
    weight: 6,
    anchor5:
      "Pain is urgent, budgeted, frequent, and board-level or owner-level",
    anchor3: "Useful but not urgent",
    anchor1: "Nice-to-have",
  },
  {
    id: "cc_wtp",
    label: "Willingness to pay",
    weight: 6,
    anchor5: "Buyer can pay premium prices and ROI is obvious",
    anchor3: "Some budget exists but value proof is needed",
    anchor1: "Low budget or hard to monetize",
  },
  {
    id: "cc_reach",
    label: "Buyer reachability",
    weight: 5,
    anchor5: "Clear buyer list, warm access, short path to decision-maker",
    anchor3: "Buyer exists but channel is uncertain",
    anchor1: "Buyer is diffuse or hard to reach",
  },
  {
    id: "cc_speed",
    label: "Speed to first cash",
    weight: 6,
    anchor5: "Can invoice within 30–60 days",
    anchor3: "Can invoice within 3–6 months",
    anchor1: "Long R&D before revenue",
  },
  {
    id: "cc_gm",
    label: "Gross margin potential",
    weight: 5,
    anchor5: "Software/data economics or very high-value service",
    anchor3: "Mixed software/service economics",
    anchor1: "Low-margin delivery",
  },
  {
    id: "cc_ebitda",
    label: "EBITDA margin potential",
    weight: 9,
    anchor5:
      "Can mature to 35%+ EBITDA margin (post-improvement for acquisitions)",
    anchor3: "Can mature to 20–30% EBITDA margin",
    anchor1: "Structurally low EBITDA margin",
  },
  {
    id: "cc_fcf",
    label: "FCF conversion / working capital",
    weight: 8,
    anchor5: "EBITDA converts to cash with low capex/working-capital drag",
    anchor3: "Some receivables/capex/reinvestment drag",
    anchor1: "Cash is trapped in inventory, capex, or long collections",
  },
  {
    id: "cc_control",
    label: "Founder control / dilution resistance",
    weight: 7,
    anchor5: "Can be bootstrapped, customer-funded, or lightly financed",
    anchor3: "Some outside capital needed but control can remain",
    anchor1: "Requires heavy VC/dilution",
  },
  {
    id: "cc_dist",
    label: "Distribution efficiency",
    weight: 6,
    anchor5: "Repeatable channel with low CAC and fast payback",
    anchor3: "Workable but still founder-led",
    anchor1: "Expensive, slow, or unproven acquisition",
  },
  {
    id: "cc_retention",
    label: "Retention / repeat revenue",
    weight: 6,
    anchor5: "Recurring, sticky, mission-critical",
    anchor3: "Repeat business likely but not locked in",
    anchor1: "One-off or churn-prone",
  },
  {
    id: "cc_pricing",
    label: "Pricing power",
    weight: 6,
    anchor5: "Can raise price as value/usage grows",
    anchor3: "Some room to increase price",
    anchor1: "Commodity pricing",
  },
  {
    id: "cc_ops",
    label: "Operating simplicity / low headcount",
    weight: 4,
    anchor5: "Lean team, automation-heavy, few operational bottlenecks",
    anchor3: "Moderate operational complexity",
    anchor1: "People-heavy, messy delivery",
  },
  {
    id: "cc_capital",
    label: "Capital efficiency",
    weight: 5,
    anchor5: "Can reach profitability with modest capital",
    anchor3: "Needs some capital but milestones are clear",
    anchor1: "Needs large funding before proof",
  },
  {
    id: "cc_moat",
    label: "Moat / durability vs AI compression",
    weight: 6,
    anchor5:
      "Data, workflow lock-in, regulation, licenses, brand, or network effects that survive frontier-AI commoditization for 7–10 years",
    anchor3: "Some differentiation; AI compression risk real but manageable",
    anchor1:
      "Easily copied, or sits directly in the path of platform/AI commoditization",
  },
  {
    id: "cc_exit",
    label: "Exit optionality / strategic value",
    weight: 4,
    anchor5:
      "Obvious acquirers or PE buyers at 5x+ EBITDA; low key-person discount",
    anchor3: "Some likely buyers",
    anchor1: "Unclear buyer universe",
  },
  {
    id: "cc_fmf",
    label: "Founder–market fit",
    weight: 5,
    anchor5:
      "Founder has a direct unfair advantage: trust, network, regulatory scar tissue, or dealflow in this exact niche",
    anchor3: "Some adjacency",
    anchor1: "No clear edge",
  },
  {
    id: "cc_impact",
    label: "Impact / mission",
    weight: 2,
    anchor5: "Meaningfully advances health, science, trust, or human capability",
    anchor3: "Neutral to mildly positive",
    anchor1: "Low or negative impact",
  },
  {
    id: "cc_transfer",
    label: "Owner independence / transferability",
    weight: 4,
    anchor5:
      "Runs with an installed GM by year 2–3; systems-driven; founder credibility is not the product",
    anchor3: "Founder-led for 3–5 years, then transferable",
    anchor1:
      "The founder IS the product; PE buyers apply a key-person discount",
  },
];

export const CC_CRITERIA_BY_ID: Record<CcCriterionId, CcCriterionDef> =
  Object.fromEntries(CC_CRITERIA.map((c) => [c.id, c])) as Record<
    CcCriterionId,
    CcCriterionDef
  >;

export const CC_WEIGHTS: Record<CcCriterionId, number> = Object.fromEntries(
  CC_CRITERIA.map((c) => [c.id, c.weight]),
) as Record<CcCriterionId, number>;

export interface CcGateDef {
  id: CcGateId;
  label: string;
  whyItMatters: string;
  practicalTest: string;
  killSignal: string;
}

export const CC_GATES: CcGateDef[] = [
  {
    id: "cg_pain",
    label: "Must-have pain",
    whyItMatters:
      "Cash cows are built on expensive, recurring pain, not intellectual curiosity.",
    practicalTest:
      "Find buyers already spending money or time on the problem.",
    killSignal: "Users say it is interesting but cannot name budget.",
  },
  {
    id: "cg_buyer",
    label: "Reachable buyer / channel",
    whyItMatters: "A great business dies if customers are too hard to reach.",
    practicalTest: "List 100 target buyers and 10 warm intros.",
    killSignal: "No repeatable path to buyer.",
  },
  {
    id: "cg_path20",
    label: "Clear path to $20M EBITDA/year",
    whyItMatters:
      "This is the core target, not personal income or paper valuation.",
    practicalTest: "Backsolve revenue = $20M / mature EBITDA margin.",
    killSignal: "The company needs unrealistic revenue or margin.",
  },
  {
    id: "cg_control",
    // Operator's modification vs the source sheet: 33%+ equity with 50%+
    // voting control (was a flat 50%+ ownership requirement).
    label: "Founder keeps 33%+ equity with 50%+ voting control",
    whyItMatters:
      "Cash-cow economics are best when the founder avoids heavy dilution — at least a third of the equity, and voting control stays with the founder.",
    practicalTest:
      "Model capital needs through profitability (equity + debt for acquisitions) with the founder retaining ≥33% ownership and >50% of voting shares.",
    killSignal: "Requires multiple VC rounds before proof.",
  },
  {
    id: "cg_margin",
    label: "Mature EBITDA margin path 25%+ (post-improvement)",
    whyItMatters:
      "At low margin, $20M EBITDA requires too much operational scale. For acquisitions, judge the margin AFTER credible automation/pricing improvements, not at entry.",
    practicalTest:
      "Show pricing, delivery cost, headcount, CAC, and G&A at scale — or the entry-to-mature margin bridge for a bought asset.",
    killSignal:
      "Structurally people-heavy or commodity margins even after improvement.",
  },
  {
    id: "cg_fcf",
    label: "High FCF conversion / low working-capital drag",
    whyItMatters: "EBITDA is not enough if cash gets trapped.",
    practicalTest:
      "Check capex, inventory, receivables, prepayments, and reinvestment needs.",
    killSignal: "Long collections, inventory, or heavy capex.",
  },
  {
    id: "cg_engine",
    label: "Repeatable sales or acquisition engine",
    whyItMatters: "The business must grow beyond founder hustle.",
    practicalTest:
      "Demonstrate a repeatable sales process or target acquisition pipeline.",
    killSignal: "Every deal is custom and founder-dependent.",
  },
  {
    id: "cg_conc",
    label: "No customer >25% at maturity",
    whyItMatters:
      "Concentration kills EBITDA durability and crushes the exit multiple.",
    practicalTest: "Model the top-10 customer mix at $20M EBITDA scale.",
    killSignal: "Business plan depends on 1–2 anchor accounts.",
  },
  {
    id: "cg_ai",
    label: "Durable vs AI/platform compression",
    whyItMatters:
      "The same AI wave that creates the margin can commoditize the product; durability must come from regulation, trust, data, or workflow lock-in.",
    practicalTest:
      "Ask: if frontier models get 10x better and cheaper, does this business get stronger or weaker?",
    killSignal:
      "Value prop is a thin layer on capabilities the platforms will absorb.",
  },
  {
    id: "cg_legal",
    label: "Legal / regulatory feasible",
    whyItMatters:
      "Cash cows need durability; regulatory landmines kill durability.",
    practicalTest: "Map licenses, compliance, liability, and data handling.",
    killSignal: "Core model depends on gray areas.",
  },
  {
    id: "cg_impact",
    label: "Positive impact",
    whyItMatters: "This should create wealth and be worth doing.",
    practicalTest: "State who benefits and what improves.",
    killSignal: "Extractive or harmful externalities.",
  },
];

export const CC_GATES_BY_ID: Record<CcGateId, CcGateDef> = Object.fromEntries(
  CC_GATES.map((g) => [g.id, g]),
) as Record<CcGateId, CcGateDef>;

/** Gates only the founder can truly answer — the AI flags them for confirmation. */
export const CC_FOUNDER_PERSONAL_GATES: CcGateId[] = ["cg_control"];
