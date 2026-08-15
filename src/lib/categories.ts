/**
 * Categories — the standard Operion Lead OS category set plus custom ones.
 *
 * Every prospect gets AUTO categories derived deterministically from its own
 * data (fit tier, industry/signals, outreach readiness). Users can ADD manual
 * categories on the prospect detail page (multi-select); auto categories are
 * always shown and can't be removed — they are computed, never invented.
 *
 * Storage lives in src/lib/store.ts (localStorage, same pattern as imports):
 *   op-leados-categories-v1      prospectId → manual category ids
 *   op-leados-customcategories-v1 custom category labels
 */

import type { FitScore, Prospect } from "./types";
import { getCategoryMap, getCustomCategories, saveCategoryMap, saveCustomCategories } from "./store";

export interface CategoryDef {
  id: string;
  label: string;
  /** category is derived from prospect data (tiers, industry, signals) */
  auto: boolean;
  /** short rule description shown in tooltips */
  rule: string;
  kind: "tier" | "industry" | "signal" | "state" | "custom";
}

/** The standard, always-present category set. */
export const STANDARD_CATEGORIES: CategoryDef[] = [
  { id: "tier-1", label: "Tier 1 – Excellent Fit", auto: true, rule: "Fit ≥ 75", kind: "tier" },
  { id: "tier-2", label: "Tier 2 – Strong Fit", auto: true, rule: "Fit 55–74", kind: "tier" },
  { id: "tier-3", label: "Tier 3 – Possible Fit", auto: true, rule: "Fit 35–54", kind: "tier" },
  { id: "cre", label: "Commercial Real Estate", auto: true, rule: "Industry is Real Estate w/ CRE activity or CRE development", kind: "industry" },
  { id: "construction", label: "Construction", auto: true, rule: "Industry Construction or active construction activity", kind: "industry" },
  { id: "hospitality", label: "Hospitality", auto: true, rule: "Industry Hospitality or hospitality operations", kind: "industry" },
  { id: "multi-entity", label: "Multi-Entity Owners", auto: true, rule: "Signal: multiple operating entities", kind: "signal" },
  { id: "property-mgmt", label: "Property Management", auto: true, rule: "Sub-industry is property management", kind: "industry" },
  { id: "development", label: "Development Companies", auto: true, rule: "Sub-industry development or CRE + construction signals", kind: "industry" },
  { id: "private-investment", label: "Private Investment Groups", auto: true, rule: "Portfolio ownership + acquisition/investment signals", kind: "signal" },
  { id: "ready", label: "Ready for Outreach", auto: true, rule: "Fit ≥ 75 and a verified contact (email or phone)", kind: "state" },
  { id: "needs-research", label: "Needs Research", auto: true, rule: "No verified contact or no website yet", kind: "state" },
];

export const CATEGORY_BY_ID: Record<string, CategoryDef> = Object.fromEntries(
  STANDARD_CATEGORIES.map((c) => [c.id, c])
);

/** Auto categories computed from a prospect's real data. */
export function autoCategories(p: Prospect, fit: FitScore): string[] {
  const out: string[] = [];
  const ind = p.industry.value.toLowerCase();
  const sub = (p.subIndustry?.value ?? "").toLowerCase();
  const s = p.signals;
  const verified = p.contacts.some(
    (c) => c.email?.verificationStatus === "Verified" || c.phone?.verificationStatus === "Verified"
  );

  // Tiers from the fit score (auto, deterministic)
  if (fit.score >= 75) out.push("tier-1");
  else if (fit.score >= 55) out.push("tier-2");
  else if (fit.score >= 35) out.push("tier-3");

  // Industry / signal clusters
  if (ind === "real estate" || s.creActivity || sub.includes("commercial real estate")) out.push("cre");
  if (ind === "construction" || s.constructionActivity || sub.includes("construction")) out.push("construction");
  if (ind === "hospitality" || s.hospitalityOperations || sub.includes("hospitality")) out.push("hospitality");
  if (sub.includes("property management") || (ind === "real estate" && sub.includes("property"))) out.push("property-mgmt");
  if (sub.includes("development") || (s.creActivity && s.constructionActivity)) out.push("development");
  if (s.multipleEntities) out.push("multi-entity");
  if (s.portfolioOwnership && (s.acquisitionActivity || s.creActivity || s.businessUnits)) out.push("private-investment");

  // State categories
  if (fit.score >= 75 && verified) out.push("ready");
  if (!verified || !p.website?.value) out.push("needs-research");

  return out;
}

export interface ProspectCategories {
  auto: string[];
  manual: string[];
  all: string[];
}

/** Full category set for one prospect: auto (computed) + manual (user-assigned). */
export function categoriesFor(p: Prospect, fit: FitScore, map: Record<string, string[]> = getCategoryMap()): ProspectCategories {
  const auto = autoCategories(p, fit);
  const manual = (map[p.id] ?? []).filter((id) => CATEGORY_BY_ID[id] || getCustomCategories().includes(id));
  return { auto, manual, all: Array.from(new Set([...auto, ...manual])) };
}

export function labelOf(id: string): string {
  return CATEGORY_BY_ID[id]?.label ?? id;
}

/** Toggle a manual category on a prospect; auto categories are unaffected. */
export function toggleManualCategory(prospectId: string, categoryId: string): string[] {
  const map = getCategoryMap();
  const cur = map[prospectId] ?? [];
  const next = cur.includes(categoryId) ? cur.filter((c) => c !== categoryId) : [...cur, categoryId];
  map[prospectId] = next;
  saveCategoryMap(map);
  return next;
}

export function addCustomCategory(label: string): string[] {
  const clean = label.trim();
  if (!clean) return getCustomCategories();
  const next = getCustomCategories().includes(clean) ? getCustomCategories() : [...getCustomCategories(), clean];
  saveCustomCategories(next);
  return next;
}

export function removeCustomCategory(label: string): string[] {
  const next = getCustomCategories().filter((c) => c !== label);
  saveCustomCategories(next);
  const map = getCategoryMap();
  for (const k of Object.keys(map)) map[k] = (map[k] ?? []).filter((c) => c !== label);
  saveCategoryMap(map);
  return next;
}

/** Full catalog of assignable categories: standard + custom (standard first). */
export function fullCatalog(custom: string[] = getCustomCategories()): CategoryDef[] {
  return [
    ...STANDARD_CATEGORIES,
    ...custom.map((c) => ({ id: c, label: c, auto: false, rule: "Custom category", kind: "custom" as const })),
  ];
}
