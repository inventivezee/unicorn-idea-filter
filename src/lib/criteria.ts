import type { CriterionId, GateId } from "./types";

export interface CriterionDef {
  id: CriterionId;
  label: string;
  defaultWeight: number;
  anchor0: string;
  anchor3: string;
  anchor5: string;
}

export const CRITERIA: CriterionDef[] = [
  {
    id: "pain",
    label: "Pain intensity / must-have urgency",
    defaultWeight: 8,
    anchor0: "Nice-to-have, vague pain, no urgency",
    anchor3: "Clear pain but buyer can defer",
    anchor5: "Hair-on-fire pain with obvious budget or existential need",
  },
  {
    id: "market",
    label: "Market scale / category potential",
    defaultWeight: 12,
    anchor0: "Small niche with no expansion path",
    anchor3: "$2–5B credible market or large but fragmented",
    anchor5: "$10B+ category potential with credible expansion vectors",
  },
  {
    id: "whynow",
    label: "Why now / timing inflection",
    defaultWeight: 8,
    anchor0: "No new enabling wave; too early or too late",
    anchor3: "Some tailwinds but not decisive",
    anchor5:
      "Multiple converging waves: tech, regulation, cost curve, behavior, data, or capital shift",
  },
  {
    id: "tenx",
    label: "10x product or technical breakthrough",
    defaultWeight: 8,
    anchor0: "Incremental feature or copycat",
    anchor3: "Meaningful improvement over alternatives",
    anchor5: "Feels magical or unlocks a previously impossible workflow",
  },
  {
    id: "wedge",
    label: "Wedge to $100M revenue",
    defaultWeight: 10,
    anchor0: "No bottom-up revenue path",
    anchor3: "Plausible but fuzzy path to $100M",
    anchor5:
      "Specific initial wedge plus expansion path to $100M within 7–10 years",
  },
  {
    id: "unitecon",
    label: "Unit economics / margin structure",
    defaultWeight: 7,
    anchor0: "Low margin, bad payback, or service-heavy forever",
    anchor3: "Acceptable economics with improvement path",
    anchor5:
      "High gross margin or strong contribution margin with credible CAC/payback discipline",
  },
  {
    id: "retention",
    label: "Retention / expansion potential",
    defaultWeight: 7,
    anchor0: "Leaky bucket, episodic usage, no expansion",
    anchor3: "Some repeat use or upsell potential",
    anchor5:
      "High switching cost, habit, workflow lock-in, or strong expansion revenue",
  },
  {
    id: "distribution",
    label: "Distribution advantage",
    defaultWeight: 8,
    anchor0: "No edge; dependent on paid acquisition or cold outbound forever",
    anchor3: "One promising channel or partnership path",
    anchor5:
      "Owned, embedded, viral, ecosystem, or founder-led distribution edge",
  },
  {
    id: "moat",
    label: "Moat / compounding defensibility",
    defaultWeight: 10,
    anchor0: "Commodity product; no durable advantage",
    anchor3: "Partial moat through brand, workflow, or data",
    anchor5:
      "Compounding moat via data, network effects, switching costs, regulatory position, or scale",
  },
  {
    id: "pubco",
    label: "Public-company quality",
    defaultWeight: 6,
    anchor0: "Revenue unpredictable, concentrated, or hard to audit",
    anchor3: "Could become predictable with operational maturity",
    anchor5:
      "Recurring/predictable revenue, scalable GTM, governance-ready, credible Rule-of-40 path",
  },
  {
    id: "reg",
    label: "Regulatory / platform risk manageability",
    defaultWeight: 3,
    anchor0: "Single-point regulatory or platform death risk",
    anchor3: "Risks real but have mitigations",
    anchor5: "Regulatory/platform path manageable or becomes an advantage",
  },
  {
    id: "capital",
    label: "Capital efficiency / time to PMF",
    defaultWeight: 3,
    anchor0: "Needs massive capital before learning anything",
    anchor3: "Meaningful capital but clear milestones",
    anchor5: "Decisive PMF signal in under 24 months with sane burn",
  },
  {
    id: "fmf",
    label: "Founder–market fit / unfair advantage",
    defaultWeight: 5,
    anchor0: "No special access, insight, or credibility",
    anchor3: "Some relevant network or experience",
    anchor5:
      "Unfair access to users, capital, talent, distribution, or proprietary insight",
  },
  {
    id: "talent",
    label: "Talent magnetism / team edge",
    defaultWeight: 2,
    anchor0: "Hard to recruit the needed A+ team",
    anchor3: "Can recruit competent team with effort",
    anchor5: "Mission and network attract exceptional talent quickly",
  },
  {
    id: "mission",
    label: "Mission and impact energy",
    defaultWeight: 3,
    anchor0: "Low personal energy or questionable social value",
    anchor3: "Interesting and broadly positive",
    anchor5:
      "Worth a decade of your life; plausibly advances human flourishing, science, health, trust, or abundance",
  },
];

export const CRITERIA_BY_ID: Record<CriterionId, CriterionDef> =
  Object.fromEntries(CRITERIA.map((c) => [c.id, c])) as Record<
    CriterionId,
    CriterionDef
  >;

export const DEFAULT_WEIGHTS: Record<CriterionId, number> = Object.fromEntries(
  CRITERIA.map((c) => [c.id, c.defaultWeight]),
) as Record<CriterionId, number>;

export interface GateDef {
  id: GateId;
  label: string;
  yMeans: string;
  nMeans: string;
  /** Gates only the founder can truly answer — AI proposals always need confirmation. */
  founderPersonal: boolean;
}

export const GATES: GateDef[] = [
  {
    id: "g_pain",
    label: "Pain is must-have",
    yMeans:
      "Customer has urgent pain and already spends time, money, status, or political capital on it",
    nMeans: "Intellectually interesting but not urgent",
    founderPersonal: false,
  },
  {
    id: "g_10b",
    label: "$10B+ category upside",
    yMeans:
      "Credible path to a huge market or a category that grows into one",
    nMeans: "Even success caps out below venture scale",
    founderPersonal: false,
  },
  {
    id: "g_100m",
    label: "Credible path to $100M revenue",
    yMeans: "Bottom-up revenue math works from wedge to expansion",
    nMeans: "Revenue path depends on hand-wavy market-share assumptions",
    founderPersonal: false,
  },
  {
    id: "g_dist",
    label: "Distribution edge identified",
    yMeans:
      "You can name the first high-leverage channel or ecosystem wedge",
    nMeans: "You will be buying attention in a crowded market",
    founderPersonal: false,
  },
  {
    id: "g_moat",
    label: "Moat likely within 3 years",
    yMeans: "Product gets harder to copy as it grows",
    nMeans: "Better-funded competitors can clone it even if it works",
    founderPersonal: false,
  },
  {
    id: "g_reg",
    label: "Legal/reg feasible in 24 months",
    yMeans: "Regulatory/platform path understood enough to start",
    nMeans:
      "A single regulator, platform, or legal issue can kill the company",
    founderPersonal: false,
  },
  {
    id: "g_edge",
    label: "Founder unfair advantages (≥2 present)",
    yMeans:
      "At least two of, across the founding team: capital, domain expertise, operating experience, founder credibility, dealflow, network, distribution",
    nMeans: "Competing as a generic founder",
    founderPersonal: true,
  },
  {
    id: "g_impact",
    label: "Positive impact aligned",
    yMeans:
      "A scaled version helps science, health, trust, coordination, abundance, or flourishing",
    nMeans:
      "A scaled version creates harm, extraction, addiction, or fraud risk",
    founderPersonal: false,
  },
  {
    id: "g_decade",
    label: "10-year commitment",
    yMeans:
      "You would commit 7–10 years to this even through a brutal middle",
    nMeans: "You are excited for months, not years",
    founderPersonal: true,
  },
];

export const GATES_BY_ID: Record<GateId, GateDef> = Object.fromEntries(
  GATES.map((g) => [g.id, g]),
) as Record<GateId, GateDef>;

export const CONFIDENCE_OPTIONS = [
  { value: 0.5 as const, label: "50%", description: "Intuition" },
  { value: 0.75 as const, label: "75%", description: "Expert or customer signals" },
  { value: 1.0 as const, label: "100%", description: "Strong proof or bottom-up math" },
];
