// Sector taxonomy for Explore filtering. Domains are free text, so each
// sector matches by keyword against the public domain/name columns —
// curated, not exhaustive; "Other" is the absence of a filter.
export interface Sector {
  key: string;
  label: string;
  keywords: string[];
}

export const SECTORS: Sector[] = [
  { key: "ai", label: "AI & ML", keywords: ["ai", "artificial intelligence", "machine learning", "llm", "agent"] },
  { key: "fintech", label: "Fintech", keywords: ["fintech", "finance", "financial", "payment", "banking", "lending", "insurance", "insurtech", "treasury", "accounting"] },
  { key: "health", label: "Healthcare & Bio", keywords: ["health", "medical", "clinical", "bio", "pharma", "patient", "care", "therapeutic", "diagnostic"] },
  { key: "climate", label: "Climate & Energy", keywords: ["climate", "energy", "carbon", "solar", "grid", "battery", "ev ", "renewable", "sustainab"] },
  { key: "devtools", label: "Developer tools", keywords: ["developer", "devops", "api", "infrastructure", "software", "code", "cloud", "data platform", "observability"] },
  { key: "logistics", label: "Logistics & Supply chain", keywords: ["logistics", "supply chain", "freight", "shipping", "warehouse", "procurement", "customs", "trade"] },
  { key: "industrial", label: "Industrial & Construction", keywords: ["construction", "manufactur", "industrial", "robotics", "hardware", "factory", "field service"] },
  { key: "commerce", label: "Commerce & Consumer", keywords: ["consumer", "commerce", "retail", "marketplace", "brand", "d2c", "food", "travel"] },
  { key: "work", label: "Work & Productivity", keywords: ["hr ", "recruiting", "workforce", "productivity", "collaboration", "sales", "marketing", "crm", "back-office", "back office"] },
  { key: "security", label: "Security & Compliance", keywords: ["security", "compliance", "privacy", "fraud", "identity", "legal", "regulat", "audit"] },
  { key: "education", label: "Education", keywords: ["education", "learning", "school", "training", "edtech"] },
  { key: "realestate", label: "Real estate & Property", keywords: ["real estate", "property", "housing", "proptech", "landlord"] },
];

export function sectorByKey(key: string | null): Sector | null {
  return SECTORS.find((s) => s.key === key) ?? null;
}
