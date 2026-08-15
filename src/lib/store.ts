/**
 * Lightweight client-side store for user-imported prospects (CSV).
 * localStorage-backed so imports survive navigation and reloads. The app starts
 * with an empty pool (no seeded data); this store holds user imports.
 *
 * Also persists enrichment run results (per-prospect enriched copies + the last
 * run's usage report) and the Settings dry-run toggle so the UI can show
 * enrichment data without re-running the waterfall.
 */

import type { Prospect, SavedSearch } from "./types";
import type { EnrichedProspect, EnrichmentRunReport } from "./enrich";
import type { ProspectList } from "./lists";

const KEY = "op-leados-imported-v1";
const ENRICHED_KEY = "op-leados-enriched-v1";
const USAGE_KEY = "op-leados-usage-v1";
const DRYRUN_KEY = "op-leados-dryrun";
const SAVED_SEARCHES_KEY = "op-leados-savedsearches-v1";
const LISTS_KEY = "op-leados-lists-v1";
const CATEGORIES_KEY = "op-leados-categories-v1";
const CUSTOM_CATEGORIES_KEY = "op-leados-customcategories-v1";

export function getImportedProspects(): Prospect[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Prospect[]) : [];
  } catch {
    return [];
  }
}

export function saveImportedProspects(list: Prospect[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list.slice(-500)));
  } catch {
    // storage full or unavailable — keep the app functional, just don't persist
  }
}

export function addImportedProspects(prospects: Prospect[]): Prospect[] {
  const next = [...getImportedProspects(), ...prospects];
  saveImportedProspects(next);
  return next;
}

/** Replace one imported prospect in place (used by Website Intelligence re-analysis). */
export function updateImportedProspect(id: string, updater: (p: Prospect) => Prospect): boolean {
  const list = getImportedProspects();
  const idx = list.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  list[idx] = updater(list[idx]);
  saveImportedProspects(list);
  return true;
}

export function clearImportedProspects(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY);
}

/* ------------------------- enrichment persistence ------------------------- */

export function getEnrichedMap(): Record<string, EnrichedProspect> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(ENRICHED_KEY);
    return raw ? (JSON.parse(raw) as Record<string, EnrichedProspect>) : {};
  } catch {
    return {};
  }
}

export function saveEnrichedMap(map: Record<string, EnrichedProspect>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ENRICHED_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

/** Merge a fresh run into the persisted map (new results win). */
export function mergeEnrichedResults(results: EnrichedProspect[]): Record<string, EnrichedProspect> {
  const map = getEnrichedMap();
  for (const r of results) {
    if (r.reason === "enriched") map[r.prospect.id] = r;
  }
  saveEnrichedMap(map);
  return map;
}

export function getLastUsage(): EnrichmentRunReport | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(USAGE_KEY);
    return raw ? (JSON.parse(raw) as EnrichmentRunReport) : null;
  } catch {
    return null;
  }
}

export function saveLastUsage(report: EnrichmentRunReport): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(USAGE_KEY, JSON.stringify(report));
  } catch {
    // ignore
  }
}

export function getDryRun(): boolean {
  return loadJson(DRYRUN_KEY, { on: false }).on;
}

export function setDryRun(on: boolean): void {
  saveJson(DRYRUN_KEY, { on });
}

/* ---------------------------- saved searches ------------------------------ */

export function getSavedSearches(): SavedSearch[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SAVED_SEARCHES_KEY);
    return raw ? (JSON.parse(raw) as SavedSearch[]) : [];
  } catch {
    return [];
  }
}

export function saveSavedSearch(ss: SavedSearch): SavedSearch[] {
  const next = [ss, ...getSavedSearches().filter((s) => s.id !== ss.id)].slice(0, 50);
  saveJson(SAVED_SEARCHES_KEY, next);
  return next;
}

export function deleteSavedSearch(id: string): SavedSearch[] {
  const next = getSavedSearches().filter((s) => s.id !== id);
  saveJson(SAVED_SEARCHES_KEY, next);
  return next;
}

/* ------------------------------- lists ------------------------------------ */

export function getLists(): ProspectList[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LISTS_KEY);
    return raw ? (JSON.parse(raw) as ProspectList[]) : [];
  } catch {
    return [];
  }
}

export function saveLists(list: ProspectList[]): void {
  saveJson(LISTS_KEY, list);
}

export function upsertList(l: ProspectList): ProspectList[] {
  const next = [...getLists().filter((x) => x.id !== l.id), l];
  saveLists(next);
  return next;
}

export function deleteList(id: string): ProspectList[] {
  const next = getLists().filter((x) => x.id !== id);
  saveLists(next);
  return next;
}

/* ----------------------------- categories --------------------------------- */

/** Manual category assignments: prospectId → category ids (auto ones are computed). */
export function getCategoryMap(): Record<string, string[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(CATEGORIES_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

export function saveCategoryMap(map: Record<string, string[]>): void {
  saveJson(CATEGORIES_KEY, map);
}

export function getCustomCategories(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_CATEGORIES_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function saveCustomCategories(list: string[]): void {
  saveJson(CUSTOM_CATEGORIES_KEY, list.slice(0, 50));
}

/* ------------------------------- settings -------------------------------- */

/** Read-only config the UI persists (threshold, cost rules). */
export function loadJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<T>) } : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson<T>(key: string, value: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}
