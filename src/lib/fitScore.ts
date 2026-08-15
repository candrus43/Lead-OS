/**
 * Operion Fit Score engine (0–100) — deterministic and explainable.
 *
 * Each operational signal carries a max weight. The engine sums contributions of
 * present signals, generates human-readable reasons, and maps the dominant signal
 * clusters to a recommended buyer, secondary buyer, and likely pain point.
 * Rationale is stored on the prospect so the UI can always explain a score.
 */

import type { FitReason, FitScore, Prospect, Signals } from "./types";

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
      .filter((r) => m.signals.includes(r.signal))
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
    const overlap = reasons.filter((r) => m.signals.includes(r.signal)).reduce((a, r) => a + r.weight, 0);
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
