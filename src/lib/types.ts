/**
 * Operion Lead OS — core data model.
 *
 * Every important field on a prospect is a Provenance-wrapped value so the UI can
 * label data quality honestly: source, when it was captured, confidence, and a
 * verification status. Unknown stays unknown — nothing is ever fabricated.
 */

export type VerificationStatus =
  | "Verified"
  | "High Confidence"
  | "Likely"
  | "Unverified"
  | "Unknown";

export interface Provenance<T = string> {
  value: T;
  source: string; // e.g. "sample-data (fictional)", "csv-import", "hunter", "apollo"
  capturedAt: string; // ISO timestamp
  confidence: number; // 0..1
  verificationStatus: VerificationStatus;
}

export type Contactable = "High" | "Medium" | "Low" | "None";

export interface Contact {
  id: string;
  fullName: Provenance;
  title: Provenance;
  email?: Provenance;
  phone?: Provenance;
  isPrimary?: boolean;
}

/** Operational signals the Fit Score engine weighs. */
export interface Signals {
  multipleEntities: boolean;
  multipleLocations: boolean;
  creActivity: boolean; // commercial real estate activity
  constructionActivity: boolean;
  hospitalityOperations: boolean;
  projectVolume: boolean;
  documentBurden: boolean;
  departments: boolean; // multiple departments
  workflowComplexity: boolean;
  growthRate: boolean; // rapid growth
  acquisitionActivity: boolean;
  portfolioOwnership: boolean;
  businessUnits: boolean; // multiple business units
  operationalComplexity: boolean;
  spreadsheetHeavy: boolean;
  disconnectedSoftware: boolean;
}

export interface FitReason {
  /** signal key when the reason maps to an operational signal; pseudo keys
   *  ("fit:industry", "fit:location", "fit:size") for discovery-estimate
   *  reasons that credit the search match itself, not an observed signal. */
  signal: keyof Signals | `fit:${string}`;
  label: string;
  weight: number; // 0..100 contribution
  note: string;
}

export interface FitScore {
  score: number; // 0..100
  grade: "Excellent" | "Strong" | "Moderate" | "Weak";
  reasons: FitReason[];
  recommendedBuyer: string;
  secondaryBuyer: string;
  likelyPainPoint: string;
  thresholdMet: boolean;
  /**
   * True when this score is a DISCOVERY-STAGE ESTIMATE rather than the regular
   * signal-based score: it credits what the provider search itself established
   * (segment, location, size range) and is meant to be refined by enrichment.
   * The UI shows a "preliminary" chip next to such scores.
   */
  preliminary?: boolean;
  /** Merely informational — the text() basis "Discovery estimate" vs "Fit". */
  basis?: "discovery" | "standard";
}

/** One piece of evidence found on a company's public website. */
export interface SiteEvidenceItem {
  label: string; // e.g. "Industry vocabulary", "Public email"
  detail: string; // quoted snippet / value as found on the page
  status: VerificationStatus;
}

/** What the Website Intelligence analyzer fetched and how it scored it. */
export interface WebsiteIntel {
  domain: string;
  analyzedAt: string; // ISO
  pagesFetched: number;
  warnings: string[]; // e.g. "limited signals — site requires JavaScript"
  evidence: SiteEvidenceItem[];
}

/** How a closed-deal webhook event was linked to a Lead OS prospect. */
export type DealMatchBy = "crmProspectId" | "domain" | "website" | "name" | "email";

/** Deal outcome recorded by the CRM → Lead OS webhook (source: 'crm-webhook'). */
export interface ProspectDeal {
  status: Provenance<"won">;
  dealId: Provenance<string>;
  dealValue?: Provenance<number>;
  currency?: Provenance<string>;
  stage?: Provenance<string>;
  plan?: Provenance<string>;
  closedAt?: Provenance<string>;
  matchedBy: DealMatchBy;
  recordedAt: string; // ISO — when the webhook recorded the deal
}

export interface Prospect {
  id: string;
  companyName: Provenance;
  industry: Provenance;
  subIndustry?: Provenance;
  location: Provenance<{ city: string; state: string; country: string }>;
  employees?: Provenance<string>; // "20–200" or "51-200"
  revenue?: Provenance<string>;
  website?: Provenance;
  description?: Provenance;
  signals: Signals;
  contacts: Contact[];
  tags: string[];
  sourceProvider: string; // "sample-data" | "csv-import" | "website" | ...
  isSample: boolean; // clearly-labeled fictional data
  /** true when data came from dry-run mock providers — UI must show a mock badge */
  mock?: boolean;
  importedAt: string;
  fit?: FitScore;
  /** Evidence from the Website Intelligence analyzer (public site fetch). */
  websiteIntel?: WebsiteIntel;
  /** Deal outcome recorded by the CRM webhook — won/closed with provenance. */
  deal?: ProspectDeal;
  /** Outbound push to the Operion CRM (source: 'crm-api') — recorded with provenance. */
  crmDealId?: Provenance<string>;
  crmCompanyId?: Provenance<string>;
  crmContactId?: Provenance<string>;
  crmSentAt?: Provenance<string>;
  crmResult?: Provenance<"created" | "duplicate">;
}

/** A user-named saved search: the query text plus the filters it parsed to. */
export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  filters: SearchFilters;
  createdAt: string; // ISO
}

export interface SearchFilters {
  industry?: string;
  subIndustry?: string;
  location?: { city?: string; state?: string; country?: string; radiusMiles?: number };
  revenueMin?: number;
  revenueMax?: number;
  employeeMin?: number;
  employeeMax?: number;
  title?: string; // job title / seniority
  keywords?: string[];
  rawQuery?: string;
  /** Result offset — used by bulk runs to page through provider discovery. */
  offset?: number;
}

/** Parsed output of a natural-language query. */
export interface ParsedQuery {
  filters: SearchFilters;
  notes: string[]; // human-readable explanation of what was understood
  matched: boolean;
  parser: "rules" | "llm";
}

export const VERIFICATION_ORDER: Record<VerificationStatus, number> = {
  Verified: 4,
  "High Confidence": 3,
  Likely: 2,
  Unverified: 1,
  Unknown: 0,
};

/** Best status across a set of provenance fields. */
export function bestStatus(fields: (Provenance | undefined)[]): VerificationStatus {
  let best: VerificationStatus = "Unknown";
  for (const f of fields) {
    if (!f) continue;
    if (VERIFICATION_ORDER[f.verificationStatus] > VERIFICATION_ORDER[best]) {
      best = f.verificationStatus;
    }
  }
  return best;
}

export function contactabilityOf(p: Prospect): { band: Contactable; status: VerificationStatus } {
  const primaries = p.contacts.filter((c) => c.isPrimary || p.contacts.length === 1);
  const email = primaries[0]?.email;
  const phone = primaries[0]?.phone;
  const status = bestStatus([email, phone]);
  const band: Contactable =
    status === "Verified" && email ? "High" : status === "High Confidence" ? "High" : status === "Likely" ? "Medium" : status === "Unverified" ? "Medium" : "None";
  return { band: email || phone ? band : "None", status };
}

export function shortLocation(loc: Prospect["location"]["value"]): string {
  const parts = [loc.city, loc.state].filter(Boolean);
  return parts.join(", ") || loc.country || "—";
}
