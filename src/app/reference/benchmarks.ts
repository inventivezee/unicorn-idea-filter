/** Static reference data: what a $1B outcome demands per business model.
 *  Read-only — rendered by /reference. Numbers reflect standard venture
 *  benchmarks (multiples, margins, retention bars) as of the mid-2020s. */

export interface Benchmark {
  model: string;
  oneLiner: string;
  billionLogic: string;
  ipoTargets: string[];
  earlyProof: string[];
  killRisks: string[];
}

export const BENCHMARKS: Benchmark[] = [
  {
    model: "AI / Enterprise SaaS",
    oneLiner:
      "Recurring software revenue sold to businesses — AI-native products must convert model capability into durable workflow lock-in, not a feature the model layer absorbs.",
    billionLogic:
      "$1B ≈ $100–200M ARR at an 8–12× forward revenue multiple (the premium end requires 50–60%+ growth). Getting there means roughly $1M → $10M ARR in 18–24 months (T2D3 pace), 75–80%+ gross margin after inference costs, NRR ≥ 115–125%, and a credible Rule-of-40 path (growth % + FCF margin ≥ 40). Typical shape: $50–150K ACVs across 1,000–2,000 accounts, or $15–30K ACVs on a high-velocity PLG motion — either way CAC payback must land under 18 months.",
    ipoTargets: [
      "$200M+ ARR growing 30%+ YoY at scale",
      "NRR ≥ 115% and gross logo retention ≥ 90%",
      "75%+ gross margin net of inference and hosting",
      "Rule of 40 ≥ 40 with FCF breakeven or better",
      "CAC payback < 18 months; sales magic number ≥ 0.75",
    ],
    earlyProof: [
      "3–5 lighthouse logos in the target ICP with < 90-day sales cycles",
      "First $1M ARR within ~12 months of general availability",
      "Usage depth: weekly active seats ≥ 60% of licensed seats",
      "Expansion inside accounts within the first 2 quarters (early NRR signal)",
      "Win rate ≥ 30% in competitive evaluations, strong logo retention",
    ],
    killRisks: [
      "Model-layer commoditization: the next foundation-model release absorbs your product as a feature",
      "Seat-based pricing collapse as AI removes the seats you charge for",
      "Thin wrapper: no proprietary data or workflow moat, monthly churn > 3%",
      "Inference costs pinning gross margin below 60%",
      "Incumbent platform (Microsoft, Salesforce, Google) bundles the capability for free",
    ],
  },
  {
    model: "AI + Bio / Longevity infrastructure",
    oneLiner:
      "Picks-and-shovels for AI-driven drug discovery, diagnostics, and longevity — sell platforms, data, and partnered programs rather than betting the company on one molecule.",
    billionLogic:
      "$1B comes via one of two paths. (a) Platform economics: $100–150M ARR from pharma data/software licensing at a ~10× multiple — pharma platform deals run $5–50M per year each, so 5–15 anchor partnerships. (b) Partial asset economics: 2–3 partnered programs carrying $50–500M milestone stacks plus 3–8% royalties on drugs with $1B+ peak-sales potential. Hybrids only keep the platform multiple if platform revenue stays > 50% of mix; wet-lab services at 40–50% gross margin drag the multiple toward CRO territory. Target 70%+ gross margin on the software/data segment and a dataset that compounds with every engagement.",
    ipoTargets: [
      "$100M+ platform/data ARR, or 3+ clinical-stage partnered assets",
      "5+ top-20 pharma logos with expanding multi-year contracts",
      "$150M+ contracted milestones with meaningful probability-weighted value",
      "70%+ gross margin on the platform segment",
      "Proprietary dataset compounding ~2× per year (samples, assays, patients)",
    ],
    earlyProof: [
      "1–2 pharma pilots converted to $1M+ annual contracts",
      "Platform output validated in vitro/in vivo by an external partner, not just in silico",
      "Data flywheel live: each customer engagement enlarges the training set you own",
      "Hit-to-lead or biomarker-discovery time/cost cut 5–10× vs. industry benchmark",
      "Peer-reviewed or partner-audited head-to-head result",
    ],
    killRisks: [
      "CRO drift: services revenue at 40% margin with no compounding data asset",
      "Pharma runs the pilot, learns the method, rebuilds it in-house",
      "Public data releases (AlphaFold-class) commoditize your proprietary dataset",
      "Validation latency: biology needs 3–7 years to prove the platform actually works",
      "One failed flagship program taints the whole platform story",
    ],
  },
  {
    model: "Biotech / Diagnostics",
    oneLiner:
      "Value equals probability-weighted peak sales — binary clinical and regulatory events dominate returns, and reimbursement decides whether diagnostics monetize at all.",
    billionLogic:
      "$1B ≈ one therapeutic asset with $1–3B peak-sales potential holding strong Phase 2 data (post-Ph2 probability of success runs ~55–65%, and deals price off probability-weighted peak-sales share), or an approved diagnostic at $150–300M revenue growing 40%+ with 60–80% gross margin — Dx trades at 4–8× revenue, well below therapeutics. Diagnostics need the full reimbursement stack: a CPT code, $200–2,000 ASP, and payer coverage for > 50% of the addressable population. Plan for $100–300M of capital to approval and stage the binaries so one readout never equals the company.",
    ipoTargets: [
      "Lead asset in or near Phase 3 (or approved) with $1B+ peak-sales consensus",
      "Dx: $100M+ revenue, 40%+ growth, Medicare plus 3 major commercial payers covering",
      "18–24 months of cash runway at IPO pricing",
      "A second asset or indication to dilute single-readout risk",
      "Gross margin 60–80% (Dx) or partnered economics covering the burn",
    ],
    earlyProof: [
      "Human proof-of-concept or strong biomarker data in the target indication",
      "KOL advocacy: 3–5 leading investigators committed to the trial design",
      "FDA alignment: pre-IND / pre-submission minutes consistent with your protocol",
      "Dx: clinical validation with sensitivity/specificity ≥ 90/90 vs. standard of care",
      "Non-dilutive capital (grants, pharma partnership) covering ≥ 20% of burn",
    ],
    killRisks: [
      "Single-asset binary: a Phase 2 miss cuts valuation ~80% overnight",
      "Reimbursement denial — a clinically great test nobody pays for",
      "Enrollment stall in a rare population adding 2–3 years",
      "Capital intensity: $100–300M to approval and brutal dilution",
      "Fast-follower with a better modality obsoletes you mid-trial",
    ],
  },
  {
    model: "Fintech / Payments / Stablecoin infrastructure",
    oneLiner:
      "Monetize money movement — value scales with volume × net take rate, losses must stay near zero, and licenses plus compliance form the real moat.",
    billionLogic:
      "$1B ≈ $100–250M net revenue (after interchange, processing, and credit/fraud losses) at 4–8× — fintech only earns SaaS multiples when 80%+ of revenue is recurring software. Payments math: $10–25B TPV at a 30–100bps net take. Lending: revenue is spread × book, but sustained losses above 3–4% destroy the multiple entirely. Stablecoin infrastructure: float income (~4–5% on reserves at current rates) plus 5–20bps on/off-ramp fees — $5B of float ≈ $200M/yr, but 200bps of rate cuts halves it. Direct licensure (MTLs, e-money, trust charters) takes 18–36 months and is the barrier competitors can't shortcut.",
    ipoTargets: [
      "$150M+ net revenue growing 40%+, fraud/credit losses < 40bps of TPV",
      "Take-rate stability across 8+ quarters — no visible compression trend",
      "Direct licenses in core markets rather than rented BaaS rails",
      "Proven unit profitability per account and per transaction at scale",
      "Top-10 customers < 30% of total volume",
    ],
    earlyProof: [
      "$100M+ annualized TPV within 12–18 months of launch",
      "An embedded distribution deal — a platform whose users onboard by default",
      "Fraud/loss rates at or below incumbent benchmarks from day one",
      "Regulatory approvals in flight before the growth spend, not after",
      "Net take rate holding while volume grows 10×",
    ],
    killRisks: [
      "Interchange and take-rate compression as volume concentrates with big customers",
      "BaaS partner-bank risk: one consent order shuts down your rails",
      "Fraud spiral — losses scale faster than the models catch them",
      "Regulatory reclassification (stablecoins deemed securities or deposits)",
      "Float-income dependence: rate cuts remove half the revenue line",
    ],
  },
  {
    model: "Marketplace / Network",
    oneLiner:
      "Aggregate fragmented supply and demand — liquidity is both the product and the moat, and the category leader is worth 5–10× the runner-up.",
    billionLogic:
      "$1B ≈ GMV × take rate × multiple. Typical shapes: $2–4B GMV at a 10–15% take = $250–500M net revenue valued at 3–6× revenue, or $6–10B GMV at 3–5% for payments-light models. The premium multiple (6–10×) requires 20%+ contribution margin and demonstrated network effects — cohort GMV retention > 100% and > 60% of new users arriving organically. Winner-take-most dynamics mean the strategy is to dominate liquidity in one vertical or geography first (> 30% fill rate, falling time-to-transaction) before expanding, not to be thin everywhere.",
    ipoTargets: [
      "$3B+ annualized GMV growing 25%+, take rate stable or rising",
      "Net revenue $250M+ with contribution margin > 20%",
      "Cohort GMV retention ≥ 100% on both sides of the market",
      "60%+ organic/repeat transaction mix — paid CAC not propping up liquidity",
      "Category leadership: > 40% share of the served segment",
    ],
    earlyProof: [
      "Liquidity in one wedge: > 30% match/fill rate with time-to-transaction dropping monthly",
      "Supply retention: 70%+ of sellers still active at month 6",
      "Demand repeat rate > 50% within 90 days",
      "Take rate introduced or raised without volume loss",
      "> 40% of new supply arriving via word of mouth",
    ],
    killRisks: [
      "Disintermediation: parties meet once, then transact off-platform forever",
      "Chicken-and-egg burn — subsidizing both sides with no retention behind it",
      "Take-rate ceiling: value-add too thin to justify 10%+",
      "Multi-tenanting: supply lists on every rival platform, zero exclusivity",
      "An incumbent (Amazon, Google) enters the vertical with free distribution",
    ],
  },
  {
    model: "Crypto / Protocol / Web3 infrastructure",
    oneLiner:
      "Fee-generating decentralized infrastructure — value accrues to a token or equity only if the fees are real, sticky, and survive the removal of incentives.",
    billionLogic:
      "$1B fully-diluted value needs defensible fee flow: mature protocols trade at roughly 10–30× annualized protocol revenue — fees that accrue to holders, not gross fees paid. That means $30–100M/yr of real, non-incentivized revenue: e.g., a DEX clearing $30B+ annual volume at a 10–30bps protocol take, or infrastructure (rollups, oracles, RPC) with $50M+ of paid demand. Equity-side picks-and-shovels (custody, on-ramps, dev tooling) price like fintech/SaaS at $100M+ revenue and 8–12×. Token emissions that exceed fees are negative revenue — TVL bought with incentives evaporates when they stop.",
    ipoTargets: [
      "$50–100M+ annualized protocol or service revenue net of token incentives",
      "Fees growing with usage, not emissions — incentive spend < 20% of fee revenue",
      "TVL/volume retained through a full bear cycle",
      "Regulatory posture resolved: registered, jurisdictionally clean, or credibly decentralized",
      "Equity businesses: SOC 2, institutional client base, 90%+ gross retention",
    ],
    earlyProof: [
      "Organic usage before incentives — users paying real fees in month 1",
      "Developer traction: 100+ external teams building on the protocol",
      "Volume/TVL surviving incentive cuts (< 30% drop when emissions halve)",
      "2+ independent audits plus a live bug bounty; no critical exploits",
      "A fee switch or clear value-accrual path accepted by governance",
    ],
    killRisks: [
      "Incentive-farmed usage: 90% of TVL leaves when emissions end",
      "Regulatory strike — token deemed a security, core market cut off",
      "Fork risk: code is open source, liquidity gets vampire-attacked",
      "One bridge or contract exploit erases the brand overnight",
      "Fee compression toward zero as blockspace and infra commoditize",
    ],
  },
  {
    model: "Robotics / Hardware + Software",
    oneLiner:
      "Ship atoms, monetize bits — hardware wins the deployment, but recurring software and RaaS revenue are what make it a venture-scale outcome.",
    billionLogic:
      "$1B needs $150–300M revenue growing 30%+, and mix matters more than scale: 50%+ recurring (RaaS subscriptions, software, service contracts) earns 6–10× on the recurring line, while pure hardware at 25–35% gross margin trades at 1–3× revenue. Target economics: hardware gross margin ≥ 35–45%, recurring gross margin ≥ 70%, and customer payback < 18 months (labor replaced ÷ system cost). RaaS math: $3–8K per robot per month on 3–5-year deployments with > 95% uptime. Budget $50–150M of capital before scale manufacturing — and unit economics must be proven at unit 50, not promised at unit 5,000.",
    ipoTargets: [
      "$200M+ revenue with a 40%+ recurring mix growing faster than hardware",
      "Blended gross margin ≥ 45% and improving with volume",
      "Fleet NRR ≥ 110% — deployed accounts expanding, not shrinking",
      "Scale manufacturing: 1,000+ units/yr on a declining unit-cost curve",
      "Backlog and committed contracts ≥ 12 months of forward revenue",
    ],
    earlyProof: [
      "3–5 paid pilots converting to fleet orders (10×+ expansion within one account)",
      "Documented customer ROI with < 18-month payback, referenceable",
      "> 95% uptime in production without resident field engineers",
      "Per-unit gross margin positive by roughly unit 50",
      "Repeatable deployment playbook: install time down 50%+ across cohorts",
    ],
    killRisks: [
      "Service trap: every deployment needs babysitting, so margins never scale",
      "Pilot purgatory — 20 pilots, zero fleet conversions",
      "Capital intensity: hardware iterations burn $50M+ before product-market fit",
      "A competitor at 40% of your price reaches acceptable quality",
      "Customer concentration: 2 accounts making up 60% of revenue",
    ],
  },
  {
    model: "Consumer / Prosumer",
    oneLiner:
      "Mass-market subscriptions or transactions — distribution efficiency and cohort retention decide everything; prosumer pricing is the sweet spot between consumer CAC and B2B retention.",
    billionLogic:
      "$1B ≈ $150–250M revenue at 4–8× (consumer subs price below B2B on churn fear): e.g., 2–3M paying subscribers at $70–100/yr net of app-store take, or 10M+ MAU monetizing $15–25 ARPU through ads and transactions. The math only compounds if month-12 retention is ≥ 40% for subscriptions (≥ 25% free-to-paid apps) and organic/viral installs exceed 50% — paid-CAC-driven consumer growth dies once LTV:CAC drops under 3:1. Prosumer tools at $100–300/yr are the strongest shape: consumer-cheap acquisition, B2B-grade retention, and bottom-up expansion into teams.",
    ipoTargets: [
      "$200M+ revenue growing 30%+ with > 70% gross margin",
      "2M+ paying subscribers with month-12 retention ≥ 40–45%",
      "LTV:CAC ≥ 3 with < 12-month payback; organic installs > 50%",
      "ARPU rising via tiering and annual plans without a churn spike",
      "Free-to-paid conversion ≥ 5–8%, stable across cohorts",
    ],
    earlyProof: [
      "Organic pull: 100K+ signups or downloads on near-zero paid spend",
      "D30 retention ≥ 20–30% before any growth spend",
      "Early cohorts converting to paid ≥ 4% within 30 days",
      "A measurable referral loop: K-factor ≥ 0.3",
      "Price test passed: users pay $8–15/mo without conversion collapse",
    ],
    killRisks: [
      "Churn treadmill: month-12 retention < 25%, growth just refills a leaky bucket",
      "CAC inflation — Meta/Google auction prices outpace LTV growth",
      "Platform tax and policy risk: 15–30% app-store take, one rule change kills the model",
      "Fad decay: engagement halves within 6 months of peak",
      "The feature gets absorbed by iOS, Android, or the default AI assistant",
    ],
  },
];
