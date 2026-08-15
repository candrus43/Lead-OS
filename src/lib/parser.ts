/**
 * Natural-language search → structured filters.
 *
 * Rule-based parser handles the V1 example queries ("Find commercial real estate
 * developers in Texas with 20–200 employees"). An LLM adapter interface
 * (parseWithLLM) slots in later via OPENAI_API_KEY — see src/routes/api/llm-parse.ts.
 */

import type { ParsedQuery, SearchFilters } from "./types";

/** Industry keyword dictionaries (operational — extend as needed). */
const INDUSTRY_DICT: Record<string, { industry: string; subIndustry?: string }> = {
  "commercial real estate developers": { industry: "Real Estate", subIndustry: "Commercial Real Estate Development" },
  "commercial real estate": { industry: "Real Estate", subIndustry: "Commercial Real Estate" },
  "real estate developers": { industry: "Real Estate", subIndustry: "Real Estate Development" },
  "real estate development": { industry: "Real Estate", subIndustry: "Real Estate Development" },
  "real estate": { industry: "Real Estate" },
  developers: { industry: "Real Estate", subIndustry: "Real Estate Development" },
  "property management": { industry: "Real Estate", subIndustry: "Property Management" },
  "property managers": { industry: "Real Estate", subIndustry: "Property Management" },
  hospitality: { industry: "Hospitality" },
  hotels: { industry: "Hospitality", subIndustry: "Hotels" },
  "hotel management": { industry: "Hospitality", subIndustry: "Hotel Management" },
  restaurants: { industry: "Hospitality", subIndustry: "Restaurants" },
  "restaurant groups": { industry: "Hospitality", subIndustry: "Restaurant Groups" },
  construction: { industry: "Construction" },
  "general contractors": { industry: "Construction", subIndustry: "General Contracting" },
  "commercial contractors": { industry: "Construction", subIndustry: "Commercial Contracting" },
  "homebuilders": { industry: "Construction", subIndustry: "Homebuilding" },
  "home builders": { industry: "Construction", subIndustry: "Homebuilding" },
  manufacturing: { industry: "Manufacturing" },
  "wholesale distribution": { industry: "Distribution" },
  distribution: { industry: "Distribution" },
  logistics: { industry: "Logistics" },
  "professional services": { industry: "Professional Services" },
  "architecture firms": { industry: "Professional Services", subIndustry: "Architecture" },
  "engineering firms": { industry: "Professional Services", subIndustry: "Engineering" },
  healthcare: { industry: "Healthcare" },
  "senior living": { industry: "Healthcare", subIndustry: "Senior Living" },
  "skilled nursing": { industry: "Healthcare", subIndustry: "Skilled Nursing" },
  "franchise operators": { industry: "Franchise", subIndustry: "Multi-unit Operators" },
  franchises: { industry: "Franchise" },
  "multi-unit": { industry: "Franchise", subIndustry: "Multi-unit Operators" },
  "energy companies": { industry: "Energy" },
  "oil and gas": { industry: "Energy", subIndustry: "Oil & Gas" },
  retail: { industry: "Retail" },
  "retail chains": { industry: "Retail", subIndustry: "Multi-location Retail" },
};

const STATE_ABBR: Record<string, string> = {
  texas: "TX", california: "CA", florida: "FL", "new york": "NY", georgia: "GA",
  arizona: "AZ", colorado: "CO", illinois: "IL", "north carolina": "NC", tennessee: "TN",
  nevada: "NV", utah: "UT", washington: "WA", oregon: "OR", michigan: "MI", ohio: "OH",
  "pennsylvania": "PA", virginia: "VA", "massachusetts": "MA", "new jersey": "NJ",
  louisiana: "LA", oklahoma: "OK", "south carolina": "SC", alabama: "AL", kentucky: "KY",
  indiana: "IN", wisconsin: "WI", minnesota: "MN", missouri: "MO", arkansas: "AR",
  iowa: "IA", kansas: "KS", nebraska: "NE", "new mexico": "NM", idaho: "ID", montana: "MT",
  "north dakota": "ND", "south dakota": "SD", wyoming: "WY", hawaii: "HI",
  alaska: "AK", maryland: "MD", delaware: "DE", "west virginia": "WV", "new hampshire": "NH",
  vermont: "VT", maine: "ME", "rhode island": "RI", connecticut: "CT",
};

const TITLES = [
  "ceo", "president", "chief operating officer", "coo", "chief financial officer", "cfo",
  "chief technology officer", "cto", "vp", "vice president", "director", "head of",
  "operations", "general manager", "owner", "founder", "manager", "controller",
  "accountant", "bookkeeper", "procurement",
];

const M = {
  RANGE: /(\d+)\s*(?:–|—|-|to)\s*(\d+)/i,
  PLUS: /(\d+)\s*\+/,
  UNDER: /under\s*(\d+)|fewer\s*than\s*(\d+)/i,
  OVER: /over\s*(\d+)|more\s*than\s*(\d+)|above\s*(\d+)/i,
};

function parseEmployeeRange(q: string): { min?: number; max?: number } | null {
  const r = q.match(M.RANGE);
  if (r) return { min: +r[1], max: +r[2] };
  const u = q.match(M.UNDER);
  if (u) return { max: +(u[1] || u[2]) };
  const o = q.match(M.OVER);
  if (o) return { min: +(o[1] || o[2] || o[3]) };
  const p = q.match(M.PLUS);
  if (p) return { min: +p[1] };
  return null;
}

function parseRevenue(q: string): { min?: number; max?: number } | null {
  // "$10M–$50M revenue", "revenue under $50M", "revenue over $100M"
  const seg = q.match(/revenue[^.]{0,60}/i)?.[0];
  if (!seg) return null;
  const num = (s: string) => {
    const m = s.match(/\$?\s*([\d.]+)\s*([kmb])?/i);
    if (!m) return undefined;
    const mult = m[2]?.toLowerCase() === "b" ? 1000 : m[2]?.toLowerCase() === "m" ? 1 : m[2]?.toLowerCase() === "k" ? 0.001 : 1;
    return Math.round(+m[1] * mult);
  };
  const r = seg.match(/(\$\s*[\d.]+[kmb]?)\s*(?:–|—|-|to)\s*(\$\s*[\d.]+[kmb]?)/i);
  if (r) return { min: num(r[1]), max: num(r[2]) };
  if (/under|below|less than/i.test(seg)) return { max: num(seg.match(/\$?\s*[\d.]+[kmb]?/i)?.[0] || "") };
  if (/over|above|more than/i.test(seg)) return { min: num(seg.match(/\$?\s*[\d.]+[kmb]?/i)?.[0] || "") };
  return null;
}

export function parseQuery(raw: string): ParsedQuery {
  const q = raw.trim().replace(/\s+/g, " ");
  const lower = q.toLowerCase();
  const notes: string[] = [];
  const filters: SearchFilters = {};

  // Industry (longest match first)
  const industryKeys = Object.keys(INDUSTRY_DICT).sort((a, b) => b.length - a.length);
  for (const key of industryKeys) {
    if (lower.includes(key)) {
      const hit = INDUSTRY_DICT[key];
      filters.industry = hit.industry;
      if (hit.subIndustry) filters.subIndustry = hit.subIndustry;
      notes.push(`Industry: ${hit.industry}${hit.subIndustry ? ` → ${hit.subIndustry}` : ""}`);
      break;
    }
  }

  // Location: "in Texas", "in Austin, TX", "near Dallas"
  const inMatch = lower.match(/in\s+(?:the\s+)?([a-z\s,]+?)(?:\s+(?:with|that|and|and\s+have|having))?$/);
  const nearMatch = lower.match(/near\s+([a-z\s]+?)(?:\s+(?:with|that|and|having))?$/);
  const locText = (nearMatch?.[1] || inMatch?.[1] || "").trim().replace(/,$/, "");
  if (locText) {
    const parts = locText.split(",").map((p) => p.trim());
    const stateName = parts[parts.length - 1]?.toLowerCase();
    const state = STATE_ABBR[stateName];
    const city = parts.length > 1 ? parts.slice(0, -1).join(", ") : state ? undefined : locText;
    filters.location = { city, state, country: "US" };
    notes.push(
      state
        ? `Location: ${city ? `${city}, ` : ""}${stateName.toUpperCase()}`
        : `Location: ${locText}`
    );
    if (nearMatch) filters.location.radiusMiles = 25;
  }

  // Employees
  const empSeg = lower.match(/(?:with|having|and|at)?\s*(\d+[\s]*(?:–|—|-|to)?[\s]*\d*[\s]*\+?)\s*employees?/i);
  const emp = empSeg ? parseEmployeeRange(empSeg[0]) : null;
  if (emp) {
    filters.employeeMin = emp.min;
    filters.employeeMax = emp.max;
    notes.push(
      `Employees: ${emp.min ?? 0}–${emp.max ?? "∞"}`
    );
  }

  // Revenue
  const rev = parseRevenue(lower);
  if (rev) {
    filters.revenueMin = rev.min;
    filters.revenueMax = rev.max;
    notes.push(`Revenue: ${rev.min ? `$${rev.min}M` : "—"}–${rev.max ? `$${rev.max}M` : "∞"}`);
  }

  // Title / seniority
  const titleHit = TITLES.find((t) => lower.includes(t));
  if (titleHit) {
    filters.title = titleHit === "head of" ? "Head of" : titleHit.replace(/\b\w/g, (c) => c.toUpperCase());
    notes.push(`Decision-maker title: ${filters.title}`);
  }

  // Keywords: quoted phrases or leftover meaningful words
  const quoted = [...q.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (quoted.length) filters.keywords = quoted;

  return { filters, notes: notes.length ? notes : ["No structured filters recognized — showing all prospects."], matched: notes.length > 0 || !!emp || !!rev, parser: "rules" };
}

/** LLM adapter interface — implemented server-side (see lib/llm.ts). */
export async function parseWithLLM(raw: string): Promise<ParsedQuery | null> {
  try {
    const { parseWithLlmFn } = await import("./llm");
    const res = await parseWithLlmFn({ data: { query: raw } });
    if (!res.configured || !res.parsed) return null;
    return res.parsed;
  } catch {
    return null;
  }
}
