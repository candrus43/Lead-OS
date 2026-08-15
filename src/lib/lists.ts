/**
 * Lists — dynamic (rule-driven) and manual lists over the scored prospect pool.
 *
 * Dynamic lists re-evaluate live: membership is computed from the current pool
 * (imported prospects, fit computed fresh) whenever the page renders. Manual
 * lists store explicit memberIds. "Today's Best Prospects" is seeded as a
 * dynamic system list (fit ≥ 75, top 10 by fit) — the product's centerpiece.
 *
 * CSV export includes provenance columns (verification status + source) so a
 * list can be shared without losing data-quality labels.
 */

import type { FitScore, Prospect } from "./types";
import { computeFit } from "./fitScore";
import { getImportedProspects, getLists, saveLists, getEnrichedMap } from "./store";
import { autoCategories, labelOf } from "./categories";

export type ScoredProspect = Prospect & { fit: FitScore };

export type ListRule =
  | { kind: "fitMin"; value: number }
  | { kind: "industry"; value: string }
  | { kind: "category"; value: string }
  | { kind: "sourceProvider"; value: string }
  | { kind: "readyForOutreach" }
  | { kind: "hasVerifiedContact" };

export interface ProspectList {
  id: string;
  name: string;
  kind: "dynamic" | "manual";
  description?: string;
  rules?: ListRule[];
  memberIds?: string[]; // manual lists
  limit?: number; // dynamic cap (optional)
  createdAt: string;
  isSystem?: boolean;
}

export const RULE_LABEL: Record<ListRule["kind"], string> = {
  fitMin: "Fit ≥",
  industry: "Industry",
  category: "Category",
  sourceProvider: "Source",
  readyForOutreach: "Ready for outreach",
  hasVerifiedContact: "Has verified contact",
};

export function ruleSummary(r: ListRule): string {
  switch (r.kind) {
    case "fitMin": return `Fit ≥ ${r.value}`;
    case "industry": return `Industry = ${r.value}`;
    case "category": return `Category: ${labelOf(r.value)}`;
    case "sourceProvider": return `Source = ${r.value}`;
    default: return RULE_LABEL[r.kind];
  }
}

/* ------------------------------ pool -------------------------------------- */

export function scoredPool(): ScoredProspect[] {
  const all = [...getImportedProspects()];
  return all.map((p) => ({ ...p, fit: computeFit(p) }));
}

/** View copy: enriched record wins when one exists (matches ProspectTable). */
export function viewOf(p: ScoredProspect): Prospect {
  return getEnrichedMap()[p.id]?.prospect ?? p;
}

/* --------------------------- rule evaluation ------------------------------ */

export function matchesRules(p: ScoredProspect, rules: ListRule[]): boolean {
  return rules.every((r) => {
    const v = viewOf(p);
    switch (r.kind) {
      case "fitMin": return p.fit.score >= r.value;
      case "industry": return v.industry.value.toLowerCase() === r.value.toLowerCase();
      case "category": return autoCategories(v, p.fit).includes(r.value);
      case "sourceProvider": return v.sourceProvider === r.value;
      case "readyForOutreach":
        return p.fit.score >= 75 && v.contacts.some((c) => c.email?.verificationStatus === "Verified" || c.phone?.verificationStatus === "Verified");
      case "hasVerifiedContact":
        return v.contacts.some((c) => c.email?.verificationStatus === "Verified" || c.phone?.verificationStatus === "Verified");
      default: return false;
    }
  });
}

/** Live membership of a list against the current pool, ranked by fit desc. */
export function evaluateList(list: ProspectList, pool: ScoredProspect[] = scoredPool()): ScoredProspect[] {
  if (list.kind === "manual") {
    const ids = new Set(list.memberIds ?? []);
    return pool.filter((p) => ids.has(p.id)).sort((a, b) => b.fit.score - a.fit.score);
  }
  const rules = list.rules ?? [];
  let members = pool
    .filter((p) => matchesRules(p, rules))
    .sort((a, b) => b.fit.score - a.fit.score);
  if (list.limit !== undefined) members = members.slice(0, list.limit);
  return members;
}

/* ------------------------------ seeding ----------------------------------- */

const TODAYS_BEST: ProspectList = {
  id: "list-todays-best",
  name: "Today's Best Prospects",
  kind: "dynamic",
  description: "Top 10 strong-fit prospects (fit ≥ 75) ranked by Operion Fit Score.",
  rules: [{ kind: "fitMin", value: 75 }],
  limit: 10,
  createdAt: new Date().toISOString(),
  isSystem: true,
};

/** Seed system lists once; user lists are never touched. */
export function ensureSeededLists(): ProspectList[] {
  const cur = getLists();
  if (cur.some((l) => l.id === TODAYS_BEST.id)) return cur;
  const next = [...cur, TODAYS_BEST];
  saveLists(next);
  return next;
}

/* ------------------------------- CSV export ------------------------------- */

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function listsToCsv(prospects: ScoredProspect[]): string {
  const header = [
    "company_name", "company_source", "industry", "sub_industry",
    "city", "state", "country", "employees", "revenue", "website",
    "fit_score", "fit_grade", "recommended_buyer", "likely_pain_point",
    "contact_name", "contact_title",
    "contact_email", "email_verification", "email_source",
    "contact_phone", "phone_verification", "phone_source",
    "source_provider", "is_sample", "imported_at", "categories",
  ];
  const rows = prospects.map((p) => {
    const v = viewOf(p);
    const primary = v.contacts.find((c) => c.isPrimary) ?? v.contacts[0];
    const cats = autoCategories(v, p.fit).map(labelOf).join(" | ");
    return [
      v.companyName.value, v.companyName.source, v.industry.value, v.subIndustry?.value ?? "",
      v.location.value.city, v.location.value.state, v.location.value.country,
      v.employees?.value ?? "", v.revenue?.value ?? "", v.website?.value ?? "",
      p.fit.score, p.fit.grade, p.fit.recommendedBuyer, p.fit.likelyPainPoint,
      primary?.fullName.value ?? "", primary?.title.value ?? "",
      primary?.email?.value ?? "", primary?.email?.verificationStatus ?? "", primary?.email?.source ?? "",
      primary?.phone?.value ?? "", primary?.phone?.verificationStatus ?? "", primary?.phone?.source ?? "",
      v.sourceProvider, v.isSample ? "sample" : "real", v.importedAt, cats,
    ].map(csvCell).join(",");
  });
  return [header.join(","), ...rows].join("\n");
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
