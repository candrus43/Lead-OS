/**
 * Website Intelligence — server-side site analyzer.
 *
 * Given a company URL, fetches the public page (plus a small set of obviously
 * relevant same-origin pages, hard-capped at SITE_INTEL_MAX_PAGES) with plain
 * fetch — no scraping tools, no CAPTCHA bypass, no third-party services, no
 * aggressive crawling. Evidence is extracted from the raw HTML (title, meta,
 * visible text, headings, same-origin links), mapped onto the fit engine's
 * Signals with keyword/pattern dictionaries, and assembled into a Prospect
 * where every important field carries provenance.
 *
 * Honesty rules:
 *   - direct page evidence   -> High Confidence
 *   - inferred from copy     -> Likely
 *   - absent                 -> Unknown (never fabricated)
 *   - emails/phones          -> only when literally present, then Unverified
 */

import type { Contact, Prospect, Signals, VerificationStatus } from "./types";
import type { SiteEvidenceItem } from "./types";
import { computeFit } from "./fitScore";
import { domainOf } from "./providers/http";
import { slug } from "./providers/util";

/* --------------------------------- limits --------------------------------- */

export const SITE_INTEL_MAX_PAGES = 6;
export const SITE_INTEL_TIMEOUT_MS = 12_000;
const MAX_HTML_CHARS = 400_000; // per page, kept for email scanning
const MAX_TEXT_CHARS = 60_000; // combined corpus text for matching

/* ------------------------------- result types ------------------------------ */

export type SiteIntelError = "invalid-url" | "unreachable" | "not-html";

export interface SiteIntelOk {
  ok: true;
  prospect: Prospect;
}

export interface SiteIntelFail {
  ok: false;
  error: SiteIntelError;
  detail?: string;
}

export type SiteIntelResult = SiteIntelOk | SiteIntelFail;

/* -------------------------------- fetching -------------------------------- */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

/** Refuse private/reserved hosts — we only fetch public websites. */
function isNonPublicHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!h || h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.includes("::") || h.startsWith("[::")) return true; // IPv6 loopback etc.
  const ipv4 = h.split(":")[0];
  const parts = ipv4.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  }
  return false;
}

/** Normalize a user-typed URL; return null when it is not a fetchable public http(s) URL. */
export function normalizeSiteUrl(raw: string): string | null {
  let input = raw.trim();
  if (!input) return null;
  // A bare scheme like "ftp://" or "file://" is never acceptable — reject up front.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) && !/^https?:\/\//i.test(input)) return null;
  if (!/^https?:\/\//i.test(input)) input = `https://${input}`;
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (isNonPublicHost(u.hostname)) return null;
  return u.href;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/&[a-z]+;/gi, " ");
}

function stripTags(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

interface PageData {
  url: string;
  title: string;
  metaDescription: string;
  metaKeywords: string;
  text: string; // visible text, whitespace-collapsed
  headings: string[];
  links: string[]; // same-origin absolute URLs
  emails: string[]; // literally present in the raw HTML
  jsOnly: boolean;
}

function parseHtml(raw: string, url: string): PageData {
  const title = decodeEntities((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? [])[1] ?? "").replace(/\s+/g, " ").trim();
  const metaDesc =
    decodeEntities(
      (raw.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ??
        raw.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i) ??
        [])[1] ?? ""
    ).replace(/\s+/g, " ").trim();
  const metaKeywords =
    decodeEntities(
      (raw.match(/<meta[^>]+name=["']keywords["'][^>]+content=["']([^"']*)["']/i) ??
        raw.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']keywords["']/i) ??
        [])[1] ?? ""
    ).replace(/\s+/g, " ").trim();

  const visible = decodeEntities(stripTags(raw)).replace(/\s+/g, " ").trim();
  const headings: string[] = [];
  const hre = /<h([12])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let hm: RegExpExecArray | null;
  while ((hm = hre.exec(raw))) {
    const h = decodeEntities(stripTags(hm[2])).replace(/\s+/g, " ").trim();
    if (h) headings.push(h.slice(0, 160));
  }

  const links: string[] = [];
  const origin = new URL(url).origin;
  const lre = /<a[^>]+href=["']([^"']+)["']/gi;
  let lm: RegExpExecArray | null;
  while ((lm = lre.exec(raw))) {
    const href = lm[1].trim();
    if (!href || /^(mailto:|tel:|javascript:|#|data:)/i.test(href)) continue;
    try {
      const u = new URL(href, url);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      if (u.origin !== origin) continue;
      links.push(u.href);
    } catch {
      // skip malformed hrefs
    }
  }
  const uniqueLinks = Array.from(new Set(links));

  const emails: string[] = [];
  const ere = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+/g;
  let em: RegExpExecArray | null;
  while ((em = ere.exec(raw))) {
    emails.push(em[0].toLowerCase());
  }

  const hasRoot = /<div\s+id=["'](?:root|app|__next|__nuxt|__gatsby|___gatsby)["']/i.test(raw) || /<main\s+id=["'](?:app|root)["']/i.test(raw);
  const hasBundle = /<script[^>]+src=["'][^"']*\.(?:js|mjs)/i.test(raw);
  const jsOnly = hasRoot && hasBundle && visible.length < 160;

  return { url, title, metaDescription: metaDesc, metaKeywords, text: visible, headings, links: uniqueLinks, emails, jsOnly };
}

async function fetchPage(url: string): Promise<{ ok: true; page: PageData } | { ok: false; error: SiteIntelError; detail?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SITE_INTEL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.8",
      },
    });
  } catch {
    return { ok: false, error: "unreachable", detail: "connection failed or timed out" };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return { ok: false, error: "unreachable", detail: `HTTP ${res.status}` };
  if (isNonPublicHost(new URL(res.url).hostname)) {
    return { ok: false, error: "unreachable", detail: "redirected to a non-public address" };
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml\+xml/i.test(ct)) {
    return { ok: false, error: "not-html", detail: ct || "unknown content type" };
  }
  const raw = (await res.text()).slice(0, MAX_HTML_CHARS);
  return { ok: true, page: parseHtml(raw, res.url) };
}

/* ------------------------------ text helpers ------------------------------- */

interface Hit {
  term: string;
  at: number;
}

function findHits(text: string, patterns: RegExp[]): Hit[] {
  const hits: Hit[] = [];
  for (const re of patterns) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = g.exec(text))) {
      hits.push({ term: m[0].slice(0, 70), at: m.index });
      if (m[0].length === 0) g.lastIndex++;
      if (hits.length >= 40) return hits;
    }
  }
  return hits;
}

function snip(text: string, idx: number, radius = 70): string {
  if (idx < 0) return "";
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius);
  const s = text.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + s + (end < text.length ? "…" : "");
}

/* --------------------------- industry dictionaries ------------------------- */

interface IndustryDict {
  id: string;
  industry: string;
  subIndustry: string;
  patterns: RegExp[];
}

const INDUSTRY_DICTS: IndustryDict[] = [
  {
    id: "cre",
    industry: "Real Estate",
    subIndustry: "Commercial Real Estate",
    patterns: [
      /commercial real estate/i, /\bCRE\b/i, /commercial properties?/i, /office (?:space|buildings?|portfolio|properties)/i,
      /industrial (?:space|properties?|portfolio)/i, /retail (?:space|properties?|portfolio)/i, /multifamily|multi-?family/i,
      /mixed-?use/i, /real estate/i, /property (?:invest|portfolio|develop|management|ownership)/i, /\bleasing\b/i,
      /investment properties?/i, /commercial (?:leasing|brokerage)/i,
    ],
  },
  {
    id: "development",
    industry: "Real Estate",
    subIndustry: "Development",
    patterns: [
      /\bdevelopments?\b/i, /\bdevelopers?\b/i, /\bdevelopment\b/i, /land (?:development|acquisition)/i,
      /master-?planned/i, /ground-?up (?:development|construction)/i, /development projects?/i,
    ],
  },
  {
    id: "construction",
    industry: "Construction",
    subIndustry: "General Contracting",
    patterns: [
      /\bconstruction\b/i, /general contractor/i, /\bbuilders?\b/i, /\bcontracting\b/i, /ground-?up/i,
      /build-?to-?suit/i, /site development/i, /pre-?construction/i, /new construction/i, /construction (?:services|projects|company)/i,
    ],
  },
  {
    id: "hospitality",
    industry: "Hospitality",
    subIndustry: "Hotels & Resorts",
    patterns: [
      /\bhospitality\b/i, /\bhotels?\b/i, /\bresorts?\b/i, /\blodging\b/i, /guest rooms?/i, /front desk/i,
      /housekeeping/i, /\bamenities\b/i, /restaurant group/i, /\binns?\b/i, /hotel (?:management|operations|group)/i,
    ],
  },
  {
    id: "property-mgmt",
    industry: "Real Estate",
    subIndustry: "Property Management",
    patterns: [
      /property management/i, /property manager/i, /manag(?:e|ing) properties/i, /\btenants?\b/i, /leasing office/i,
      /homeowners association|\bHOA\b/i, /property managers?/i,
    ],
  },
  {
    id: "investment",
    industry: "Real Estate",
    subIndustry: "Investment",
    patterns: [
      /\binvestment\b/i, /\binvestments\b/i, /\bacquisitions?\b/i, /asset management/i, /capital (?:partners?|investors?)/i,
      /private equity/i, /\bREIT\b/i, /investment (?:portfolio|properties?|fund)/i,
    ],
  },
  {
    id: "self-storage",
    industry: "Real Estate",
    subIndustry: "Self-Storage",
    patterns: [/self-?storage/i, /storage units?/i, /climate-?controlled storage/i],
  },
];

function detectIndustry(text: string): { industry: string; subIndustry: string; terms: string[]; status: VerificationStatus } {
  const scored = INDUSTRY_DICTS.map((d) => ({ d, hits: findHits(text, d.patterns) })).filter((x) => x.hits.length > 0);
  scored.sort((a, b) => b.hits.length - a.hits.length);
  const top = scored[0];
  if (!top) return { industry: "Unknown", subIndustry: "", terms: [], status: "Unknown" };
  const terms = Array.from(new Set(top.hits.map((h) => h.term))).slice(0, 6);
  return {
    industry: top.d.industry,
    subIndustry: top.d.subIndustry,
    terms,
    status: top.hits.length >= 3 ? "High Confidence" : "Likely",
  };
}

/* -------------------------------- locations -------------------------------- */

const STATES: [string, string][] = [
  ["Alabama", "AL"], ["Alaska", "AK"], ["Arizona", "AZ"], ["Arkansas", "AR"], ["California", "CA"],
  ["Colorado", "CO"], ["Connecticut", "CT"], ["Delaware", "DE"], ["Florida", "FL"], ["Georgia", "GA"],
  ["Hawaii", "HI"], ["Idaho", "ID"], ["Illinois", "IL"], ["Indiana", "IN"], ["Iowa", "IA"],
  ["Kansas", "KS"], ["Kentucky", "KY"], ["Louisiana", "LA"], ["Maine", "ME"], ["Maryland", "MD"],
  ["Massachusetts", "MA"], ["Michigan", "MI"], ["Minnesota", "MN"], ["Mississippi", "MS"], ["Missouri", "MO"],
  ["Montana", "MT"], ["Nebraska", "NE"], ["Nevada", "NV"], ["New Hampshire", "NH"], ["New Jersey", "NJ"],
  ["New Mexico", "NM"], ["New York", "NY"], ["North Carolina", "NC"], ["North Dakota", "ND"], ["Ohio", "OH"],
  ["Oklahoma", "OK"], ["Oregon", "OR"], ["Pennsylvania", "PA"], ["Rhode Island", "RI"], ["South Carolina", "SC"],
  ["South Dakota", "SD"], ["Tennessee", "TN"], ["Texas", "TX"], ["Utah", "UT"], ["Vermont", "VT"],
  ["Virginia", "VA"], ["Washington", "WA"], ["West Virginia", "WV"], ["Wisconsin", "WI"], ["Wyoming", "WY"],
];

const STATE_ABBR = new Set(STATES.map(([, a]) => a));
const STATE_RE = new RegExp(`\\b(?:${STATES.flatMap(([n, a]) => [n, a]).join("|")})\\b`, "g");

const BASED_IN_RE = /\b(?:based|headquartered|located|operating)\s+in\s+([A-Z][a-zA-Z.]+(?:\s[A-Z][a-zA-Z.]+)?),\s*([A-Z]{2})\b/g;
const CITY_STATE_ZIP_RE = /\b([A-Z][a-zA-Z.]+(?:\s[A-Z][a-zA-Z.]+)?),\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/g;

interface LocationResult {
  value: { city: string; state: string; country: string };
  status: VerificationStatus;
  detail: string;
  distinctStates: string[];
}

function detectLocation(text: string): LocationResult {
  const pairs: { city: string; state: string }[] = [];
  for (const re of [BASED_IN_RE, CITY_STATE_ZIP_RE]) {
    const g = new RegExp(re.source, "g");
    let m: RegExpExecArray | null;
    while ((m = g.exec(text))) {
      const city = m[1].replace(/\.$/, "").trim();
      const state = m[2].toUpperCase().trim();
      if (city && STATE_ABBR.has(state)) pairs.push({ city, state });
    }
  }
  const seen = new Set<string>();
  const uniquePairs = pairs.filter((p) => {
    const k = `${p.city}|${p.state}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const states: string[] = [];
  const sg = new RegExp(STATE_RE.source, "g");
  let sm: RegExpExecArray | null;
  while ((sm = sg.exec(text))) {
    const raw = sm[0];
    const s = raw.length === 2 ? raw : STATES.find(([n]) => n === raw)?.[1] ?? raw;
    if (STATE_ABBR.has(s) && !states.includes(s)) states.push(s);
  }

  if (uniquePairs.length) {
    const first = uniquePairs[0];
    const others = uniquePairs.slice(1).filter((p) => p.city !== first.city);
    const detail = `Address / "based in" match: ${first.city}, ${first.state}${others.length ? ` (also ${others.slice(0, 3).map((p) => p.city).join(", ")})` : ""}`;
    return { value: { city: first.city, state: first.state, country: "US" }, status: "High Confidence", detail, distinctStates: states };
  }
  if (states.length) {
    const detail = `State${states.length > 1 ? "s" : ""} mentioned: ${states.join(", ")}`;
    return { value: { city: "", state: states[0], country: "US" }, status: "Likely", detail, distinctStates: states };
  }
  return { value: { city: "", state: "", country: "" }, status: "Unknown", detail: "", distinctStates: [] };
}

/* ------------------------------ signal patterns ---------------------------- */

interface SignalDef {
  key: keyof Signals;
  label: string;
  patterns: RegExp[];
}

const SIGNAL_PATTERNS: SignalDef[] = [
  {
    key: "multipleEntities",
    label: "Multiple entities / brands",
    patterns: [
      /portfolio of (?:companies|brands|businesses)/i, /family of companies/i, /group of companies/i, /group of businesses/i,
      /our brands? (?:include|are)/i, /\bbrands? (?:include|are)/i, /\bsubsidiaries?\b/i, /operating companies/i,
      /sister companies?/i, /\bholdings\b/i, /\bentities\b/i, /umbrella (?:company|corporation|group)/i,
      /multiple (?:companies|businesses|brands|entities)/i, /dba|doing business as/i,
    ],
  },
  {
    key: "multipleLocations",
    label: "Multiple locations",
    patterns: [
      /(?:multiple|several|various|many|two|2|three|3|four|4)\s+locations?/i, /locations?\s+(?:across|in|throughout|spanning|nationwide|statewide)/i,
      /offices?\s+(?:across|in|throughout|spanning)/i, /\bnationwide\b/i, /\bcountrywide\b/i, /across (?:the )?(?:US|USA|U\.S\.|country|nation)/i,
      /in \d+ (?:states|cities|markets)/i, /locations? in \d+/i, /multiple (?:offices|sites|branches)/i,
    ],
  },
  {
    key: "creActivity",
    label: "Commercial real estate activity",
    patterns: [
      /commercial real estate/i, /\bCRE\b/i, /commercial properties?/i, /real estate (?:development|invest|portfolio|ownership)/i,
      /property (?:portfolio|investments?|acquisitions?|ownership|management)/i, /\bleasing\b/i, /office space/i,
      /industrial space/i, /retail space/i, /multifamily|multi-?family/i, /mixed-?use/i, /self-?storage/i,
      /asset management/i, /\bREIT\b/i, /investment properties?/i, /properties? (?:for (?:sale|lease)|owned)/i,
      /property (?:owners?|management company)/i,
    ],
  },
  {
    key: "constructionActivity",
    label: "Construction activity",
    patterns: [
      /\bconstruction\b/i, /general contractor/i, /\bbuilders?\b/i, /ground-?up/i, /build-?to-?suit/i,
      /under construction/i, /currently (?:building|constructing|developing)/i, /site development/i,
      /new construction/i, /construction projects?/i, /construction (?:services|division|company)/i,
    ],
  },
  {
    key: "hospitalityOperations",
    label: "Hospitality operations",
    patterns: [
      /\bhospitality\b/i, /\bhotels?\b/i, /\bresorts?\b/i, /\blodging\b/i, /guest rooms?/i, /front desk/i,
      /housekeeping/i, /\bamenities\b/i, /restaurant group/i, /\binns?\b/i, /hotel (?:management|operations)/i,
    ],
  },
  {
    key: "projectVolume",
    label: "High project volume",
    patterns: [
      /our projects/i, /featured projects/i, /current projects?/i, /projects? (?:include|across|throughout|spanning|portfolio|underway|under way)/i,
      /developments? (?:include|across|throughout|spanning|portfolio)/i, /portfolio of projects?/i,
      /dozens of projects?/i, /over \d+ projects?/i, /\d+\+? (?:active|completed) projects?/i,
    ],
  },
  {
    key: "departments",
    label: "Multiple departments",
    patterns: [
      /\bdepartments?\b/i, /our (?:departments|divisions)/i, /departments? (?:include|across)/i, /service lines?/i,
      /\bdivisions?\b/i, /business units/i, /\bverticals?\b/i, /\bsectors?\b/i, /cross-?functional/i,
    ],
  },
  {
    key: "businessUnits",
    label: "Multiple business units",
    patterns: [
      /\bdivisions?\b/i, /business units?/i, /\bsegments?\b/i, /\bverticals?\b/i, /\bsectors?\b/i,
      /operating companies/i, /multiple brands?/i, /under (?:one|a single) (?:roof|umbrella)/i, /group (?:of|with) companies/i,
    ],
  },
  {
    key: "growthRate",
    label: "Rapid growth",
    patterns: [
      /we'?re (?:growing|hiring|expanding)/i, /now hiring/i, /we are growing/i, /rapid(?:ly)? (?:growing|growth|expanding|expansion)/i,
      /expanding (?:into|across|to|our)/i, /new locations? (?:opening|coming)/i, /growing (?:team|company|fast)/i,
      /join our (?:growing )?team/i, /\d+ open (?:positions|roles)/i, /(?:we|our company) (?:are|is) (?:expanding|growing)/i,
    ],
  },
  {
    key: "acquisitionActivity",
    label: "Acquisition activity",
    patterns: [
      /(?:we|company|firm|group|portfolio company)\s+(?:have|has)?\s*acquired/i, /acquisition of/i,
      /completed (?:the )?acquisition/i, /\bmergers?\b/i, /\bM&A\b/i, /acquired (?:a|an|the)/i, /strategic acquisitions?/i,
    ],
  },
  {
    key: "portfolioOwnership",
    label: "Portfolio ownership",
    patterns: [
      /portfolio of properties?/i, /portfolio of assets/i, /our properties?/i, /properties? (?:owned|we own)/i,
      /owns? and operates?/i, /assets under management/i, /property portfolio/i, /self-?storage (?:facilities|units|properties)/i,
      /we (?:own|operate|manage)/i, /investment portfolio/i, /\d+\+? properties?/i, /property (?:owners?|ownership)/i,
      /portfolio of (?:real estate|buildings)/i,
    ],
  },
];

/* --------------------------------- contacts -------------------------------- */

const LEADERSHIP_PAGE_RE = /\/(?:team|about|people|leadership|management|founders|who-we-are|company|executives?|board)[/#]?/i;

const TITLE_ALT = [
  "Chief Executive Officer", "Chief Operating Officer", "Chief Financial Officer", "Chief Technology Officer",
  "Chief Information Officer", "Chief Marketing Officer", "Chief Revenue Officer", "Chief Administrative Officer",
  "Chief People Officer", "CEO", "COO", "CFO", "CTO", "CIO", "CMO", "CRO", "CAO",
  "President", "Founder", "Co-Founder", "Co Founder", "Managing Director", "General Manager",
  "Executive Director", "Executive Vice President", "Vice President", "VP", "Owner", "Principal",
  "Partner", "Chairman", "Chairwoman", "Board Member",
];
const TITLE = TITLE_ALT.join("|");
const NAME = "[A-Z][a-z]+(?:\\s(?:[A-Z]\\.?|[A-Z][a-z]+)){1,3}";

const NAME_TITLE_RE = new RegExp(`\\b(${NAME})\\s*[,–—|:]\\s*(${TITLE})\\b`, "gi");
const TITLE_NAME_RE = new RegExp(`\\b(${TITLE})\\s*:?\\s*(${NAME})(?!\\s+(?:of|at|for)\\b)`, "gi");
const FOUNDED_BY_RE = /\b(?:Founded|Founder|Co-founded)\s+by\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+){1,2})/gi;

interface LeaderRaw {
  name: string;
  title: string;
}

function extractLeaders(pages: PageData[], mainUrl: string): LeaderRaw[] {
  const out: LeaderRaw[] = [];
  const seen = new Set<string>();
  const push = (name: string, title: string) => {
    const clean = name.replace(/[.]+$/, "").trim();
    if (!clean || clean.length < 6) return;
    const key = `${clean.toLowerCase()}|${title.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: clean.slice(0, 60), title: title.trim() });
  };

  const main = pages.find((p) => p.url === mainUrl);
  if (main) {
    const g = new RegExp(FOUNDED_BY_RE.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = g.exec(main.text))) push(m[1], "Founder");
  }

  for (const p of pages) {
    if (!LEADERSHIP_PAGE_RE.test(p.url)) continue;
    const g1 = new RegExp(NAME_TITLE_RE.source, "gi");
    let m1: RegExpExecArray | null;
    while ((m1 = g1.exec(p.text))) push(m1[1], m1[2]);
    const g2 = new RegExp(TITLE_NAME_RE.source, "gi");
    let m2: RegExpExecArray | null;
    while ((m2 = g2.exec(p.text))) push(m2[2], m2[1]);
  }
  return out.slice(0, 4);
}

/* --------------------------------- emails ---------------------------------- */

const EMAIL_JUNK = /(example\.com|example\.org|sentry\.io|schema\.org|w3\.org|googleapis\.com|googletagmanager\.com|doubleclick\.net|hotjar\.com|clarity\.ms|jquery\.com|google-analytics\.com|bootstrapcdn\.com|cloudflare\.com|webflow\.com|squarespace\.com|wordpress\.com|wix\.com|unbounce\.com|github\.com|gstatic\.com|cloudfront\.net)$/i;

function cleanEmails(raw: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    if (EMAIL_JUNK.test(e)) continue;
    if (e.length > 80 || e.length < 6) continue;
    if (seen.has(e)) continue;
    seen.add(e);
    out.push(e);
    if (out.length >= 6) break;
  }
  return out;
}

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g;

function cleanPhones(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const g = new RegExp(PHONE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    const [full, a, b, c] = m;
    if (a === "000" || b === "000" || c === "0000") continue;
    if (a[0] === a[1] && a[1] === a[2] && b[0] === b[1] && b[1] === b[2] && c[0] === c[1] && c[1] === c[2] && c[2] === c[3]) continue;
    const n = a + b + c;
    if (n[0] === "0") continue;
    // skip fictional 555-01xx ranges (placeholder numbers)
    if (a === "555" && parseInt(b, 10) >= 10 && parseInt(b, 10) <= 99) continue;
    const pretty = full.trim();
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(pretty.length > 16 ? `(${a}) ${b}-${c}` : pretty);
    if (out.length >= 3) break;
  }
  return out;
}

/* --------------------------------- employees ------------------------------- */

const EMP_PATTERNS: { re: RegExp; exact: boolean }[] = [
  { re: /\b(?:we|our|the|with|a)\s+(?:currently\s+)?(?:employ|have)\s+(\d[\d,]*)\s*[-–to]+\s*\d[\d,]*\s*\+?\s*(?:employees?|people|staff|professionals|team members)\b/i, exact: true },
  { re: /\b(?:we|our|the|with|a)\s+(?:currently\s+)?(?:employ|have)\s+(\d[\d,]*)\s*\+?\s*(?:employees?|people|staff|professionals|team members)\b/i, exact: true },
  { re: /\b(?:a|our|with|the)\s+team\s+of\s+(\d[\d,]*)\s*\+?\b/i, exact: false },
  { re: /\b(?:over|more than|about|approximately|nearly|around)\s+(\d[\d,]*)\s*\+?\s*(?:employees?|people|staff|team members)\b/i, exact: false },
  { re: /\b(\d[\d,]*)\s*\+?\s*employees?\b/i, exact: true },
];

function detectEmployees(text: string): { value: string; status: VerificationStatus; detail: string } | null {
  for (const { re, exact } of EMP_PATTERNS) {
    const g = new RegExp(re.source, "i");
    const m = g.exec(text);
    if (m) {
      const raw = m[1].replace(/,/g, "");
      const value = `${raw}${exact ? "" : "+"}`;
      return {
        value,
        status: exact ? "High Confidence" : "Likely",
        detail: snip(text, m.index, 60),
      };
    }
  }
  return null;
}

/* ------------------------------ company name ------------------------------- */

const NAV_RE = /\b(?:about|home|contact|login|log in|sign in|sign up|register|terms|privacy|blog|news|careers|services|products?|the team|our team|portfolio|projects?|our work)\b/i;

function domainToName(domain: string): string {
  const base = domain.split(".")[0] ?? domain;
  return base
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .slice(0, 60);
}

function nameFromTitle(title: string, domain: string): { name: string; fromTitle: boolean } {
  const parts = title
    .split(/\s*[|–—-]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const clean = parts.filter((p) => !NAV_RE.test(p));
  const pick = (clean[0] ?? parts[0] ?? "").trim();
  if (pick) return { name: pick.slice(0, 80), fromTitle: true };
  return { name: domainToName(domain), fromTitle: false };
}

/* ------------------------------- main pipeline ----------------------------- */

interface Corpus {
  domain: string;
  main: PageData;
  pages: PageData[];
  allText: string;
}

function buildCorpus(main: PageData, pages: PageData[]): Corpus {
  const texts = [main, ...pages].map((p) => p.text).filter(Boolean);
  return {
    domain: domainOf(main.url),
    main,
    pages: [main, ...pages],
    allText: texts.join(" \n ").slice(0, MAX_TEXT_CHARS),
  };
}

async function fetchContextPages(main: PageData): Promise<PageData[]> {
  const origin = new URL(main.url).origin;
  const CONTEXT_SEGMENTS = ["about", "team", "people", "leadership", "management", "founders", "contact", "portfolio", "projects", "our-work", "properties", "developments", "locations", "company", "who-we-are", "services", "divisions"];
  const candidates = main.links.filter((href) => {
    const path = href.slice(origin.length);
    return CONTEXT_SEGMENTS.some((s) => new RegExp(`(?:^|/)${s}(?:/|$|[-_])`, "i").test(path));
  });
  const unique = Array.from(new Set(candidates)).slice(0, SITE_INTEL_MAX_PAGES - 1);
  const fetched: PageData[] = [];
  for (const href of unique) {
    if (fetched.length >= SITE_INTEL_MAX_PAGES - 1) break;
    const res = await fetchPage(href);
    if (res.ok && !res.page.jsOnly) fetched.push(res.page);
  }
  return fetched;
}

/** Analyze a company website URL. Pure server-side logic; exposed via siteIntelServer.ts. */
export async function analyzeSite(rawUrl: string): Promise<SiteIntelResult> {
  const url = normalizeSiteUrl(rawUrl);
  if (!url) return { ok: false, error: "invalid-url", detail: "not a public http(s) URL" };

  const mainRes = await fetchPage(url);
  if (!mainRes.ok) return mainRes;

  const main = mainRes.page;
  const warnings: string[] = [];
  if (main.jsOnly) {
    warnings.push("limited signals — site requires JavaScript (raw HTML contained almost no text)");
  }

  const contextPages = main.jsOnly ? [] : await fetchContextPages(main);
  const corpus = buildCorpus(main, contextPages);
  const domain = corpus.domain;
  const src = `website:${domain}`;
  const capturedAt = new Date().toISOString();

  const evidence: SiteEvidenceItem[] = [];
  const signals: Signals = {
    multipleEntities: false, multipleLocations: false, creActivity: false, constructionActivity: false,
    hospitalityOperations: false, projectVolume: false, documentBurden: false, departments: false,
    workflowComplexity: false, growthRate: false, acquisitionActivity: false, portfolioOwnership: false,
    businessUnits: false, operationalComplexity: false, spreadsheetHeavy: false, disconnectedSoftware: false,
  };

  /* --- company name --- */
  const { name, fromTitle } = nameFromTitle(main.title, domain);
  const companyNameStatus: VerificationStatus = fromTitle ? "High Confidence" : "Likely";
  if (fromTitle && main.title) {
    evidence.push({ label: "Company name", detail: `Site <title>: "${main.title.slice(0, 120)}"`, status: "High Confidence" });
  }

  /* --- description / keywords --- */
  let description: string | undefined;
  if (main.metaDescription) {
    description = main.metaDescription.slice(0, 300);
    evidence.push({ label: "Description", detail: main.metaDescription.slice(0, 160), status: "High Confidence" });
  }
  if (main.metaKeywords) {
    evidence.push({ label: "Meta keywords", detail: main.metaKeywords.slice(0, 160), status: "High Confidence" });
  }

  /* --- industry --- */
  const ind = detectIndustry(corpus.allText);
  const industryStatus: VerificationStatus = ind.status;
  if (ind.industry !== "Unknown") {
    evidence.push({
      label: "Industry vocabulary",
      detail: `${ind.industry}${ind.subIndustry ? ` · ${ind.subIndustry}` : ""} — matched: ${ind.terms.map((t) => `"${t}"`).join(", ")}`,
      status: industryStatus,
    });
  }

  /* --- location --- */
  const loc = detectLocation(corpus.allText);
  if (loc.status !== "Unknown") {
    evidence.push({ label: "Location", detail: loc.detail, status: loc.status });
  }
  if (loc.distinctStates.length >= 2) signals.multipleLocations = true;

  /* --- employees --- */
  const emp = detectEmployees(corpus.allText);
  if (emp) evidence.push({ label: "Employees", detail: emp.detail, status: emp.status });

  /* --- signal patterns --- */
  const activeSignals: { label: string; detail: string }[] = [];
  for (const def of SIGNAL_PATTERNS) {
    const hits = findHits(corpus.allText, def.patterns);
    if (hits.length) {
      signals[def.key] = true;
      activeSignals.push({ label: def.label, detail: snip(corpus.allText, hits[0].at, 70) });
      evidence.push({ label: def.label, detail: `"${snip(corpus.allText, hits[0].at, 70)}"`, status: "Likely" });
    }
  }

  /* --- derived signals --- */
  if (ind.industry === "Real Estate") signals.creActivity = true;
  if (ind.industry === "Construction") signals.constructionActivity = true;
  if (ind.industry === "Hospitality") signals.hospitalityOperations = true;
  const structural = [
    signals.departments, signals.businessUnits, signals.multipleLocations, signals.multipleEntities, signals.projectVolume,
  ].filter(Boolean).length;
  if (structural >= 2) {
    signals.operationalComplexity = true;
    activeSignals.push({ label: "Operational complexity", detail: `combines ${structural} structural signals (departments, business units, locations, entities, projects)` });
    evidence.push({ label: "Operational complexity", detail: `combines ${structural} structural signals (departments, business units, locations, entities, projects)`, status: "Likely" });
  }

  /* --- leadership --- */
  const leaders = extractLeaders(corpus.pages, main.url);
  if (leaders.length) {
    evidence.push({
      label: "Leadership",
      detail: leaders.map((l) => `${l.title}: ${l.name}`).join("; "),
      status: "Likely",
    });
  }

  /* --- emails / phones --- */
  const emails = cleanEmails(corpus.pages.flatMap((p) => p.emails));
  const phones = cleanPhones(corpus.allText);
  for (const e of emails.slice(0, 3)) evidence.push({ label: "Public email", detail: e, status: "Unverified" });
  for (const ph of phones.slice(0, 3)) evidence.push({ label: "Public phone", detail: ph, status: "Unverified" });

  /* --- pages analyzed --- */
  const pageNames = corpus.pages.map((p) => {
    const u = new URL(p.url);
    return u.pathname === "/" ? domain : u.pathname.slice(1);
  });
  evidence.push({
    label: "Pages analyzed",
    detail: `${corpus.pages.length} page(s): ${pageNames.join(", ")}`,
    status: "High Confidence",
  });

  /* --- contacts --- */
  const contacts: Contact[] = leaders.map((l, i) => ({
    id: `${slug(name)}-site-c${i + 1}`,
    fullName: { value: l.name, source: src, capturedAt, confidence: 0.6, verificationStatus: "Likely" },
    title: { value: l.title, source: src, capturedAt, confidence: 0.6, verificationStatus: "Likely" },
    isPrimary: i === 0,
  }));
  const siteEmail = emails.find((e) => !/^(info|hello|contact|sales|team|office|admin|reception|enquiries|inquiries|bookings|reservations|support|careers|jobs|hr)@/i.test(e));
  const roleEmail = emails.find((e) => /^(info|hello|contact|sales|team|office|admin|reception|enquiries|inquiries|bookings|reservations|support)@/i.test(e));
  if (contacts.length) {
    const target = contacts[0];
    // Name-based match only (e.g. "jane.doe@x.com" vs "Jane Doe") — still Unverified.
    const personMatch = emails.find((e) => {
      const local = e.split("@")[0].toLowerCase().replace(/[^a-z]/g, "");
      const fn = target.fullName.value.toLowerCase().replace(/[^a-z]/g, "");
      const lastName = fn.replace(/^[a-z]+/, "");
      return local.length > 6 && fn.length > 4 && (local.includes(fn) || local.includes(lastName));
    });
    if (personMatch) {
      target.email = { value: personMatch, source: src, capturedAt, confidence: 0.5, verificationStatus: "Unverified" };
    }
  }
  if (!contacts.length && (siteEmail || roleEmail || phones.length)) {
    contacts.push({
      id: `${slug(name)}-site-contact`,
      fullName: { value: "Unknown", source: src, capturedAt, confidence: 0, verificationStatus: "Unknown" },
      title: { value: "Public website contact", source: src, capturedAt, confidence: 0.3, verificationStatus: "Unverified" },
      email: siteEmail ?? roleEmail ? { value: siteEmail ?? roleEmail!, source: src, capturedAt, confidence: 0.4, verificationStatus: "Unverified" } : undefined,
      phone: phones[0] ? { value: phones[0], source: src, capturedAt, confidence: 0.4, verificationStatus: "Unverified" } : undefined,
    });
  }

  /* --- build prospect --- */
  const p: Prospect = {
    id: `web-${slug(domain)}-${Date.now().toString(36)}`,
    companyName: {
      value: name,
      source: src,
      capturedAt,
      confidence: companyNameStatus === "High Confidence" ? 0.9 : 0.55,
      verificationStatus: companyNameStatus,
    },
    industry: { value: ind.industry, source: src, capturedAt, confidence: ind.status === "Unknown" ? 0 : ind.status === "High Confidence" ? 0.8 : 0.6, verificationStatus: ind.status },
    subIndustry: ind.subIndustry && ind.industry !== "Unknown" ? { value: ind.subIndustry, source: src, capturedAt, confidence: 0.6, verificationStatus: "Likely" } : undefined,
    location: {
      value: loc.value,
      source: src,
      capturedAt,
      confidence: loc.status === "Unknown" ? 0 : loc.status === "High Confidence" ? 0.85 : 0.6,
      verificationStatus: loc.status,
    },
    employees: emp ? { value: emp.value, source: src, capturedAt, confidence: emp.status === "High Confidence" ? 0.85 : 0.6, verificationStatus: emp.status } : undefined,
    website: { value: domain, source: src, capturedAt, confidence: 0.95, verificationStatus: "High Confidence" },
    description: description ? { value: description, source: src, capturedAt, confidence: 0.8, verificationStatus: "High Confidence" } : undefined,
    signals,
    contacts,
    tags: ["website-intel"],
    sourceProvider: "website",
    isSample: false,
    importedAt: capturedAt,
    websiteIntel: {
      domain,
      analyzedAt: capturedAt,
      pagesFetched: corpus.pages.length,
      warnings,
      evidence,
    },
  };
  p.fit = computeFit(p);
  return { ok: true, prospect: p };
}
