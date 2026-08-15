/**
 * Pipeline: discover → score → filter by fit threshold → rank.
 * "Search broad, enrich narrow": filtering is cheap and happens first; paid
 * enrichment/verification steps are stubbed and gated by cost rules (Settings).
 */

import type { Prospect, SearchFilters } from "./types";
import { computeFit, DEFAULT_FIT_THRESHOLD } from "./fitScore";
import { parseQuery, parseWithLLM } from "./parser";
import { getImportedProspects } from "./store";

export interface PipelineResult {
  prospects: Prospect[]; // ranked by fit score desc
  filters: SearchFilters;
  parserUsed: "rules" | "llm" | "none";
  notes: string[];
  totalScored: number;
  threshold: number;
}

function empToNum(v?: string): number | undefined {
  if (!v) return undefined;
  const m = v.match(/(\d+)\s*(?:–|—|-|to)\s*(\d+)/);
  if (m) return Math.round((+m[1] + +m[2]) / 2);
  const single = v.match(/(\d+)/);
  return single ? +single[1] : undefined;
}

export function matchFilters(p: Prospect, f: SearchFilters): boolean {
  if (f.industry && p.industry.value.toLowerCase() !== f.industry.toLowerCase()) return false;
  if (f.subIndustry && p.subIndustry && p.subIndustry.value.toLowerCase() !== f.subIndustry.toLowerCase()) return false;
  if (f.location) {
    const loc = p.location.value;
    if (f.location.state && loc.state.toUpperCase() !== f.location.state.toUpperCase()) return false;
    if (f.location.city && !loc.city.toLowerCase().includes(f.location.city.toLowerCase())) return false;
  }
  if (f.employeeMin !== undefined || f.employeeMax !== undefined) {
    const n = empToNum(p.employees?.value);
    if (n === undefined) return false;
    if (f.employeeMin !== undefined && n < f.employeeMin) return false;
    if (f.employeeMax !== undefined && n > f.employeeMax) return false;
  }
  if (f.revenueMin !== undefined || f.revenueMax !== undefined) {
    const m = p.revenue?.value.match(/([\d.]+)\s*M/i);
    const n = m ? +m[1] : undefined;
    if (n === undefined) return false;
    if (f.revenueMin !== undefined && n < f.revenueMin) return false;
    if (f.revenueMax !== undefined && n > f.revenueMax) return false;
  }
  if (f.keywords?.length) {
    const hay = `${p.companyName.value} ${p.industry.value} ${p.description?.value ?? ""} ${p.tags.join(" ")}`.toLowerCase();
    if (!f.keywords.every((k) => hay.includes(k.toLowerCase()))) return false;
  }
  return true;
}

export interface RunOptions {
  query?: string;
  filters?: SearchFilters;
  includeImported?: boolean;
  threshold?: number;
  limit?: number;
}

export async function runPipeline(opts: RunOptions): Promise<PipelineResult> {
  const includeImported = opts.includeImported ?? true;
  const threshold = opts.threshold ?? DEFAULT_FIT_THRESHOLD;

  let pool: Prospect[] = [];
  if (includeImported) pool = pool.concat(getImportedProspects());

  let filters: SearchFilters = opts.filters ?? {};
  let parserUsed: PipelineResult["parserUsed"] = "none";
  let notes: string[] = [];

  if (opts.query?.trim()) {
    // Try the LLM adapter first when configured; fall back to rules.
    const llm = await parseWithLLM(opts.query);
    if (llm) {
      filters = llm.filters;
      parserUsed = "llm";
      notes = llm.notes;
    } else {
      const parsed = parseQuery(opts.query);
      filters = parsed.filters;
      parserUsed = parsed.matched ? "rules" : "none";
      notes = parsed.notes;
    }
  }

  const scored = pool
    .filter((p) => matchFilters(p, filters))
    .map((p) => ({ ...p, fit: computeFit(p) }));

  const totalScored = scored.length;
  const ranked = scored
    .filter((p) => p.fit!.score >= threshold)
    .sort((a, b) => b.fit!.score - a.fit!.score)
    .slice(0, opts.limit ?? 50);

  return { prospects: ranked, filters, parserUsed, notes, totalScored, threshold };
}
