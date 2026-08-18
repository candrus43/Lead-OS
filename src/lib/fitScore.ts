/**
 * Operion Fit Score engine (0–100) — deterministic and explainable.
 *
 * Each operational signal carries a max weight. The engine sums contributions of
 * present signals, generates human-readable reasons, and maps the dominant signal
 * clusters to a recommended buyer, secondary buyer, and likely pain point.
 * Rationale is stored on the prospect so the UI can always explain a score.
 */

import type { FitReason, FitScore, Prospect, SearchFilters, Signals } from "./types";

interface SignalDef {
  key: keyof Signals;
  label: string;
  weight: number;
  note: string;
}

export const SIGNAL_DEFS: SignalDef[] = [
  { key: "multipleEntities", label: "Multiple operating entities", weight: 10, note: "Multiple legal entities multiply entity-level contracts, compliance and bookkeeping." },
  { key: "multipleLocations", label: "Multiple locations", weight: 10, note: "Multi-site operations drive decentralized reporting and coordination overhead." },
  { key: "creActivity", label: "Commercial real estate activity", weight: 12, note: "Active CRE involvement (ownership, leasing, development) — Operion's core focus." },
  { key: "constructionActivity", label: "Construction activity", weight: 12, note: "Active construction projects create heavy document and workflow volume." },
  { key: "hospitalityOperations", label: "Hospitality operations", weight: 10, note: "Hospitality runs on high-frequency operational coordination." },
  { key: "projectVolume", label: "High project volume", weight: 10, note: "Many concurrent projects strain manual tracking and reporting." },
  { key: "documentBurden", label: "Large document burden", weight: 8, note: "Contracts, permits, invoices and plans across many projects." },
  { key: "departments", label: "Multiple departments", weight: 7, note: "Cross-department handoffs create coordination and approval friction." },
  { key: "workflowComplexity", label: "Complex workflows", weight: 7, note: "Multi-step processes are easy to lose and hard to audit by hand." },
  { key: "growthRate", label: "Rapid growth", weight: 8, note: "Fast scaling outpaces manual processes — a classic trigger moment." },
  { key: "acquisitionActivity", label: "Acquisition activity", weight: 6, note: "Recent M&A means new entities, integrations and operational catch-up." },
  { key: "portfolioOwnership", label: "Portfolio ownership", weight: 8, note: "Portfolio owners need asset-level visibility across holdings." },
  { key: "businessUnits", label: "Multiple business units", weight: 7, note: "Unit-level P&L and reporting create structural complexity." },
  { key: "operationalComplexity", label: "Operational complexity", weight: 8, note: "Overall operational surface area is high for the company's size." },
  { key: "spreadsheetHeavy", label: "Spreadsheet-heavy workflows", weight: 6, note: "Mission-critical processes still live in spreadsheets — prime automation target." },
  { key: "disconnectedSoftware", label: "Disconnected software environment", weight: 6, note: "Tools don't talk to each other; data is re-keyed by hand." },
];

const TOTAL_WEIGHT = SIGNAL_DEFS.reduce((a, s) => a + s.weight, 0); // 135

/** Buyer mapping: signal cluster → roles. */
const BUYER_MAP: { signals: (keyof Signals)[]; primary: string; secondary: string; pain: string }[] = [
  {
    signals: ["creActivity", "constructionActivity", "portfolioOwnership"],
    primary: "Head of Development / Director of Construction",
    secondary: "Portfolio Manager / Head of Asset Management",
    pain: "Juggles multiple properties, projects and entities — tracking progress, contracts, and compliance across every site by hand.",
  },
  {
    signals: ["hospitalityOperations", "multipleLocations"],
    primary: "VP Operations (Hospitality)",
    secondary: "Regional General Manager",
    pain: "Coordinates many locations with scattered schedules, vendors and reporting — no single source of truth for operations.",
  },
  {
    signals: ["growthRate", "acquisitionActivity"],
    primary: "CFO / VP Finance",
    secondary: "COO",
    pain: "Growing fast (or acquiring) faster than manual processes can keep up — entity and financial reporting is lagging behind.",
  },
  {
    signals: ["departments", "businessUnits", "workflowComplexity", "operationalComplexity"],
    primary: "COO / VP Operations",
    secondary: "VP Finance",
    pain: "Complex, cross-department workflows with handoffs that stall, duplicate and disappear — no shared operational layer.",
  },
  {
    signals: ["documentBurden", "projectVolume"],
    primary: "Head of Contracts / Legal Ops",
    secondary: "VP Operations",
    pain: "A high volume of contracts, permits and project documents that are filed, re-keyed and searched manually.",
  },
  {
    signals: ["spreadsheetHeavy", "disconnectedSoftware"],
    primary: "COO / VP Operations",
    secondary: "IT / Systems Lead",
    pain: "Mission-critical processes live in disconnected spreadsheets and tools — data is re-entered and errors slip through.",
  },
];

export function computeFit(p: Prospect): FitScore {
  const reasons: FitReason[] = [];
  for (const def of SIGNAL_DEFS) {
    if (p.signals[def.key]) {
      reasons.push({ signal: def.key, label: def.label, weight: def.weight, note: def.note });
    }
  }
  // Order by weight desc
  reasons.sort((a, b) => b.weight - a.weight);

  const raw = reasons.reduce((a, r) => a + r.weight, 0);
  const score = Math.round((raw / TOTAL_WEIGHT) * 100);
  const grade: FitScore["grade"] = score >= 75 ? "Excellent" : score >= 55 ? "Strong" : score >= 35 ? "Moderate" : "Weak";

  // Dominant cluster = the buyer map entry with the most signal overlap (by weight)
  let best = BUYER_MAP[BUYER_MAP.length - 1];
  let bestOverlap = -1;
  for (const m of BUYER_MAP) {
    const overlap = reasons
      .filter((r): r is FitReason & { signal: keyof Signals } => m.signals.includes(r.signal as keyof Signals))
      .reduce((a, r) => a + r.weight, 0);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = m;
    }
  }
  // Secondary buyer: next-best non-identical cluster
  let secondary = BUYER_MAP[0].secondary;
  let secondaryOverlap = -1;
  for (const m of BUYER_MAP) {
    if (m === best) continue;
    const overlap = reasons
      .filter((r) => r.signal !== "fit:segment" && r.signal !== "fit:location" && r.signal !== "fit:size" && m.signals.includes(r.signal as keyof Signals))
      .reduce((a, r) => a + r.weight, 0);
    if (overlap > secondaryOverlap) {
      secondaryOverlap = overlap;
      secondary = m.secondary;
    }
  }
  if (bestOverlap === 0) {
    best = {
      signals: [],
      primary: "COO / VP Operations",
      secondary: "CFO",
      pain: "Operations run on manual coordination — the kind of day-to-day sprawl Operion is built to organize.",
    };
    secondary = "CFO";
  }

  return {
    score,
    grade,
    reasons,
    recommendedBuyer: best.primary,
    secondaryBuyer: best.primary === secondary ? "CFO" : secondary,
    likelyPainPoint: best.pain,
    thresholdMet: score >= DEFAULT_FIT_THRESHOLD,
  };
}

export const DEFAULT_FIT_THRESHOLD = 55;

/* ---------------------------------------------------------------------------
 * Discovery-stage estimate ("preliminary").
 *
 * Used ONLY for companies that just came back from a provider discovery search
 * (Google Places / Apollo), before any enrichment. The regular signal engine is
 * misleading there: a spot-on commercial real estate developer returned for
 * "CRE developers in TX, 20–200 employees" has almost no signal data (Google
 * returns name/place/types only), so computeFit() reads ~9/100 "Weak" purely
 * because the data was never fetched — not because the company is a weak fit.
 *
 * This is NOT a re-weighting of the regular engine — computeFit() stays
 * untouched for enriched/imported prospects. This computes a clearly-labeled
 * PRELIMINARY ESTIMATE on the evidence the provider search itself established:
 *
 *   40%  core-segment match — the company came back for an Operion core-segment
 *        query (real estate / development / construction / hospitality /
 *        franchise / multi-unit / property management). The search term IS the
 *        evidence: it is Operion's own core focus. Other known industries get
 *        half credit — real match, not core segment.
 *   30%  activity evidence  — provider-derived operational activity signals
 *        (Google place types → CRE / construction / hospitality flags).
 *   15%  location match     — company state/city matches the searched geography
 *        (or no geography was requested).
 *   15%  employee-size match — provider-reported headcount inside the requested
 *        range (or no range was requested). Unknown size counts at 0.6 — it is
 *        UNCONFIRMED at discovery, not absent (owners rarely have it).
 *
 * Grade bands and the threshold stay on the shared 0–100 scale so sorting and
 * the onlyEnrichCompanyAboveFit gate behave identically: a core-segment match
 * reads "Strong" (~70+) and IS enrichable, a non-core match reads lower and is
 * not paid for until a human decides. The result carries preliminary: true and
 * basis "discovery", so every surface renders "Discovery estimate — enrich to
 * refine" instead of implying a confirmed verdict. The regular computeFit() is
 * unchanged and takes over as real signal data arrives.
 * ------------------------------------------------------------------------ */

const CORE_SEGMENT_RE =
  /real estate|development|construction|contract|hospitality|hotel|restaurant|franchise|multi-unit|multi unit|property management|operator|operators/i;

/** Buyer/pain guidance for the discovery estimate, keyed by searched segment. */
const DISCOVERY_GUIDANCE: Array<{ re: RegExp; primary: string; secondary: string; pain: string }> = [
  {
    re: /real estate|development|construction|property/i,
    primary: "Head of Development / Director of Construction",
    secondary: "Portfolio Manager / Head of Asset Management",
    pain: "Multiple properties, projects and entities tracked by hand — exactly the coordination Operion organizes.",
  },
  {
    re: /hospital|hotel|restaurant/i,
    primary: "VP Operations (Hospitality)",
    secondary: "Regional General Manager",
    pain: "Many locations with scattered schedules, vendors and reporting — no single source of truth for operations.",
  },
  {
    re: /franchise|multi-unit|operator/i,
    primary: "COO / VP Operations",
    secondary: "VP Finance",
    pain: "Unit-level operations tracked in spreadsheets and siloed tools — a classic Operion automation target.",
  },
];

function employeesInRange(emp: string | undefined, lo?: number, hi?: number): boolean {
  if (!emp) return false;
  const rng = emp.match(/(\d+)\s*(?:–|—|-|to)\s*(\d+)/);
  const single = emp.match(/(\d+)/);
  const n = rng ? (+rng[1] + +rng[2]) / 2 : single ? +single[1] : undefined;
  if (n === undefined) return false;
  if (lo !== undefined && n < lo) return false;
  if (hi !== undefined && n > hi) return false;
  return true;
}

export function computeDiscoveryFit(p: Prospect, filters: SearchFilters): FitScore {
  const term = `${filters.subIndustry ?? ""} ${filters.industry ?? ""}`.trim();
  const reasons: FitReason[] = [];

  // 40 — core-segment match (the search itself establishes the segment)
  const core = CORE_SEGMENT_RE.test(term) ? 1 : filters.industry ? 0.5 : 0;
  if (core > 0) {
    reasons.push({
      signal: "fit:segment",
      label: "Core segment match",
      weight: Math.round(40 * core),
      note: `Provider search matched "${term || filters.industry}" — ${core >= 1 ? "an Operion core segment" : "an industry outside the core segments"}.`,
    });
  }

  // 2 — activity evidence from the provider (Google place types, etc.)
  const acts = [p.signals.creActivity, p.signals.constructionActivity, p.signals.hospitalityOperations];
  const actCount = acts.filter(Boolean).length;
  const activity = actCount / 3;
  if (activity > 0) {
    reasons.push({
      signal: acts[0] ? "creActivity" : acts[1] ? "constructionActivity" : "hospitalityOperations",
      label: "Activity evidence",
      weight: Math.round(30 * activity),
      note: `${actCount}/3 operational-activity signals present from provider data.`,
    });
  }

  // 3 — location match (or "no geography requested")
  const fLoc = filters.location;
  const locOk =
    !fLoc ||
    (fLoc.state
      ? p.location.value.state.toUpperCase() === fLoc.state.toUpperCase()
      : !fLoc.city || p.location.value.city.toLowerCase().includes(fLoc.city.toLowerCase()));
  const location = fLoc ? (locOk ? 1 : 0) : 1;
  if (location > 0) {
    reasons.push({
      signal: "fit:location",
      label: "Location match",
      weight: Math.round(15 * location),
      note: `Company is in ${p.location.value.city || p.location.value.state || p.location.value.country || "—"}${fLoc ? `; searched ${[fLoc.city, fLoc.state].filter(Boolean).join(", ")}` : ""}.`,
    });
  }

  // 4 — employee-size match (unknown counts as unconfirmed, not absent)
  const askedSize = filters.employeeMin !== undefined || filters.employeeMax !== undefined;
  const size = askedSize
    ? employeesInRange(p.employees?.value, filters.employeeMin, filters.employeeMax)
      ? 1
      : p.employees
        ? 0
        : 0.6
    : 1;
  if (size > 0) {
    reasons.push({
      signal: "fit:size",
      label: "Size match",
      weight: Math.round(15 * size),
      note: askedSize
        ? p.employees
          ? `${p.employees.value} employees (in ${filters.employeeMin ?? 0}–${filters.employeeMax ?? "∞"})`
          : "employee size unconfirmed at discovery — enrich to confirm"
        : "no size filter",
    });
  }

  const score = Math.min(100, Math.round(40 * core + 30 * activity + 15 * location + 15 * size));
  const grade: FitScore["grade"] = score >= 75 ? "Excellent" : score >= 55 ? "Strong" : score >= 35 ? "Moderate" : "Weak";

  const guidance = DISCOVERY_GUIDANCE.find((g) => g.re.test(term)) ?? DISCOVERY_GUIDANCE[DISCOVERY_GUIDANCE.length - 1];

  return {
    score,
    grade,
    reasons,
    recommendedBuyer: guidance.primary,
    secondaryBuyer: guidance.secondary,
    likelyPainPoint: guidance.pain,
    thresholdMet: score >= DEFAULT_FIT_THRESHOLD,
    preliminary: true,
    basis: "discovery",
  };
}

/** Cost-control rules (config stubs — see Settings page). */
export interface CostRules {
  onlyVerifyEmailAboveFit: number;
  onlyEnrichPhoneAboveFit: number;
  onlyEnrichCompanyAboveFit: number;
  maxEnrichPerRun: number;
}

export const DEFAULT_COST_RULES: CostRules = {
  onlyVerifyEmailAboveFit: 80,
  onlyEnrichPhoneAboveFit: 75,
  onlyEnrichCompanyAboveFit: 60,
  maxEnrichPerRun: 25,
};
