/**
 * Google Places adapter — official Places API (Text Search + Place Details).
 *
 * Discovery pass: keyword/location text search returns companies with location
 * and Google place types (cheap, ~$0.032/call). Place Details (~$0.017/call)
 * returns website + business phone and serves as our phone/place verification
 * (High Confidence — Google publishes this data, but it is not a "Verified"
 * email-style check).
 *
 * State-level searches: Google's legacy Text Search does not reliably answer a
 * bare state code ("commercial real estate developer in TX" → ZERO_RESULTS).
 * When the filters specify a state with NO city, we expand to that state's
 * largest metros (STATE_METROS) and run one Text Search per metro, deduping
 * the combined results. A city-level search still runs exactly one query
 * ("in {city}, {ST}").
 *
 * Response status is inspected after every call: OK / ZERO_RESULTS are clean
 * outcomes (ZERO_RESULTS → honest empty list), every other status throws a
 * descriptive error (provider name + status + Google's error_message) so the
 * UI can show why discovery produced nothing.
 *
 * Assumptions about response shapes (legacy JSON endpoints):
 *   GET /maps/api/place/textsearch/json  → { results: [{ place_id, name,
 *       formatted_address, geometry.location, types }], status }
 *   GET /maps/api/place/details/json     → { result: { place_id, name,
 *       formatted_address, formatted_phone_number, website, types } }
 * The legacy endpoints still serve API keys; the adapter is isolated in this
 * file so a switch to Places API v1 (field masks) is a one-file change.
 */

import type { Contact, Prospect, Provenance, SearchFilters, Signals } from "../types";
import type { CompanyEnrichment, ProviderCtx, ProviderRuntime } from "./types";
import { fetchJson, domainOf, now } from "./http";
import { slug } from "./util";

const TEXT_SEARCH = "https://maps.googleapis.com/maps/api/place/textsearch/json";
const DETAILS = "https://maps.googleapis.com/maps/api/place/details/json";

/** Hard cap on raw results kept across all metro queries (pre/post dedupe). */
const MAX_DISCOVER_RESULTS = 60;
/** Page size per discovery call — matches the original 20-per-query slice. */
const PAGE_SIZE = 20;

/**
 * State → largest metros. Used only when a discovery has a state but no city:
 * Google Text Search answers cities, not bare state codes. States most relevant
 * to Operion are covered; anything else falls back to a single query with no
 * location clause ([""]).
 */
const STATE_METROS: Record<string, string[]> = {
  TX: ["Dallas", "Houston", "Austin", "San Antonio", "Fort Worth"],
  FL: ["Miami", "Tampa", "Orlando", "Jacksonville", "Fort Lauderdale"],
  GA: ["Atlanta", "Savannah", "Augusta", "Columbus", "Macon"],
  NC: ["Charlotte", "Raleigh", "Greensboro", "Durham", "Wilmington"],
  SC: ["Greenville", "Columbia", "Charleston", "Spartanburg", "Myrtle Beach"],
  TN: ["Nashville", "Memphis", "Knoxville", "Chattanooga", "Franklin"],
  VA: ["Richmond", "Virginia Beach", "Norfolk", "Arlington", "Alexandria"],
  CA: ["Los Angeles", "San Francisco", "San Diego", "San Jose", "Sacramento"],
  AZ: ["Phoenix", "Scottsdale", "Tucson", "Mesa", "Tempe"],
  NV: ["Las Vegas", "Henderson", "Reno", "North Las Vegas", "Paradise"],
  CO: ["Denver", "Colorado Springs", "Aurora", "Boulder", "Fort Collins"],
  IL: ["Chicago", "Naperville", "Rockford", "Springfield", "Peoria"],
  OH: ["Columbus", "Cleveland", "Cincinnati", "Toledo", "Akron"],
  MI: ["Detroit", "Grand Rapids", "Warren", "Sterling Heights", "Ann Arbor"],
  PA: ["Philadelphia", "Pittsburgh", "Allentown", "Reading", "Scranton"],
  NY: ["New York", "Buffalo", "Rochester", "Albany", "Syracuse"],
  NJ: ["Newark", "Jersey City", "Paterson", "Trenton", "Camden"],
  MA: ["Boston", "Springfield", "Cambridge", "Lowell", "Worcester"],
  WA: ["Seattle", "Spokane", "Tacoma", "Bellevue", "Vancouver"],
  OR: ["Portland", "Salem", "Eugene", "Gresham", "Bend"],
};

interface PlaceResult {
  place_id?: string;
  name?: string;
  formatted_address?: string;
  types?: string[];
  business_status?: string;
  geometry?: { location?: { lat?: number; lng?: number } };
  website?: string;
  formatted_phone_number?: string;
  international_phone_number?: string;
  rating?: number;
  user_ratings_total?: number;
}

interface TextSearchResponse {
  results?: PlaceResult[];
  status?: string;
  error_message?: string;
}

interface DetailsResponse {
  result?: PlaceResult;
  status?: string;
}

/** Human-readable hint appended to common Google Places error statuses. */
const STATUS_HINTS: Record<string, string> = {
  REQUEST_DENIED: "the API key is invalid or the Places API is not enabled, check your Google Cloud project",
  OVER_QUERY_LIMIT: "the API quota was exceeded — wait a bit and retry, or raise the quota in Google Cloud",
  INVALID_REQUEST: "the query was malformed — try a different city or industry term",
  NOT_FOUND: "the indicated location could not be found — try a different city",
  UNKNOWN_ERROR: "Google returned an unknown error — retry in a moment",
};

/**
 * Inspect a Text Search response status. OK and ZERO_RESULTS are clean (the
 * empty-list case genuinely means "no matches"); every other status is a
 * provider failure and is reported as a descriptive error so the UI can show
 * it. A missing response (network/timeout) is also a provider failure.
 */
function assertTextSearchOk(res: TextSearchResponse | undefined, query: string): void {
  if (res == null) {
    throw new Error(`Google Places: no response from the Places API (network or quota error) for "${query}"`);
  }
  const status = res.status ?? "";
  if (!status || status === "OK" || status === "ZERO_RESULTS") return;
  const hint = STATUS_HINTS[status];
  const detail = res.error_message ? ` ${res.error_message}` : "";
  throw new Error(`Google Places: ${status}${hint ? ` — ${hint}` : ""}${detail}`);
}

const INDUSTRY_QUERIES: Record<string, string[]> = {
  "real estate": ["commercial real estate developer", "real estate development", "property management company"],
  "construction": ["construction company", "general contractor", "commercial contractor"],
  "hospitality": ["hotel management company", "hospitality group", "restaurant group"],
  "franchise": ["franchise operator", "multi-unit franchise"],
  "manufacturing": ["manufacturing company"],
  "distribution": ["wholesale distribution company"],
  "logistics": ["logistics company"],
  "professional services": ["architecture firm", "engineering firm"],
  "healthcare": ["senior living facility", "healthcare provider"],
  "retail": ["retail chain", "retail company"],
  "energy": ["energy company", "oil and gas company"],
};

function queryTerms(f: SearchFilters): string[] {
  const base = f.industry ? (INDUSTRY_QUERIES[f.industry.toLowerCase()] ?? [f.industry]) : ["company", "business"];
  if (f.subIndustry) {
    const map: Record<string, string> = {
      "commercial real estate development": "commercial real estate developer",
      "real estate development": "real estate developer",
      "property management": "property management company",
      "hotel management": "hotel management company",
      "general contracting": "general contractor",
      "commercial contracting": "commercial contractor",
      "multi-unit operators": "franchise operator",
    };
    const mapped = map[f.subIndustry.toLowerCase()];
    if (mapped) return [mapped];
  }
  return base;
}

/**
 * Discover locations for a search filter:
 *  - city present → exactly one query on "{city}, {state}" (unchanged behavior);
 *  - state only    → expand to that state's largest metros (STATE_METROS);
 *  - neither       → one query with no location clause (unchanged behavior).
 * A bare state code is never sent to Google as the whole location.
 */
function expandLocations(loc: SearchFilters["location"]): Array<{ city: string; state: string }> {
  if (!loc?.state) {
    return [{ city: loc?.city ?? "", state: "" }];
  }
  const state = loc.state.toUpperCase();
  if (loc.city) {
    return [{ city: loc.city, state }];
  }
  const metros = STATE_METROS[state] ?? [""];
  // A bare state must never be sent as the whole location; unknown states get
  // a single query with no location clause (entry "" → state dropped too).
  return metros.map((city) => ({ city, state: city === "" ? "" : state }));
}

/** Best-effort city/state parse from a Google formatted address. */
function parseAddress(addr?: string): { city: string; state: string; country: string } {
  if (!addr) return { city: "", state: "", country: "US" };
  const parts = addr.split(",").map((p) => p.trim());
  let state = "";
  let country = "US";
  const last = parts[parts.length - 1] ?? "";
  if (/^[A-Z]{2}(\s\d{5}(-\d{4})?)?$/.test(last)) {
    country = "US";
    state = last.slice(0, 2);
  } else if (last && last !== "USA" && last.length <= 3) {
    country = last;
  }
  // second-to-last is usually "ST ZIP" for US addresses
  const penultimate = parts[parts.length - 2] ?? "";
  if (!state) {
    const m = penultimate.match(/\b([A-Z]{2})\s*\d{5}/);
    if (m) state = m[1];
  }
  let city = "";
  const cityCandidates = parts.slice(0, -2).reverse();
  for (const c of cityCandidates) {
    if (!/^\d/.test(c) && !/^[A-Z]{2}(\s\d+)?$/.test(c) && c !== "USA") {
      city = c;
      break;
    }
  }
  return { city, state, country };
}

function signalsFromTypes(types: string[] = []): Partial<Signals> {
  const t = new Set(types.map((x) => x.toLowerCase()));
  const out: Partial<Signals> = {};
  if (t.has("lodging") || t.has("restaurant")) out.hospitalityOperations = true;
  if (t.has("real_estate_agency")) out.creActivity = true;
  if (t.has("general_contractor")) out.constructionActivity = true;
  return out;
}

export function makeGooglePlaces(apiKey: string, mock: boolean): ProviderRuntime {
  const def: ProviderRuntime["def"] = {
    id: "google-places",
    name: "Google Places",
    kind: "api",
    status: mock ? "mock" : "active",
    capabilities: ["discoverCompanies", "enrichCompany", "verifyPhone"],
    envKeys: ["GOOGLE_PLACES_API_KEY"],
    description:
      "Discover companies by keyword/location from Google's official Places API; Place Details verify business phone and website. Cheap first pass — no employee/size data.",
    mock,
  };

  const discoverCompanies = async (filters: SearchFilters, ctx: ProviderCtx): Promise<Prospect[]> => {
    ctx.tracker.record("google-places", "discoverCompanies", 1, ctx.mock);
    if (ctx.mock) return [];
    const terms = queryTerms(filters);
    const locations = expandLocations(filters.location);
    const offset = filters.offset ?? 0;

    // filter → collect → dedupe → slice, applied consistently across queries.
    const collected: Array<{ r: PlaceResult; loc: { city: string; state: string } }> = [];
    for (const loc of locations) {
      const locationText = [loc.city, loc.state].filter(Boolean).join(", ");
      const query = [terms[0], locationText ? `in ${locationText}` : ""].filter(Boolean).join(" ");
      const res = await fetchJson<TextSearchResponse>(`${TEXT_SEARCH}?query=${encodeURIComponent(query)}&key=${apiKey}`);
      assertTextSearchOk(res, query);
      const clean = (res?.results ?? []).filter(
        (r) => r.name && r.business_status !== "CLOSED_PERMANENTLY" && r.business_status !== "CLOSED_TEMPORARILY"
      );
      for (const r of clean) {
        collected.push({ r, loc });
        if (collected.length >= MAX_DISCOVER_RESULTS) break;
      }
      if (collected.length >= MAX_DISCOVER_RESULTS) break;
    }

    // Dedupe by place_id (fall back to normalized name — the places that lack a
    // place_id also lack stable identity, so city+name keys it).
    const seen = new Set<string>();
    const deduped = collected.filter(({ r }) => {
      const key = r.place_id ? `id:${r.place_id}` : `name:${slug(r.name ?? "").toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return deduped
      .slice(offset, offset + PAGE_SIZE)
      .map(({ r, loc }, i) => {
        const addr = parseAddress(r.formatted_address);
        const signals = signalsFromTypes(r.types);
        // Location comes from Google's address when it parsed; the metro the
        // result came from fills any gap (never fabricated — it's where search
        // actually ran). Metro-filled locations are marked Likely, not High
        // Confidence, because the street-level city wasn't returned by Google.
        const city = addr.city || loc.city;
        const state = addr.state || loc.state;
        const gotRealAddress = !!addr.city || !!addr.state;
        return {
          id: `google-${r.place_id ?? slug(r.name ?? "")}-${i}`,
          companyName: { value: r.name ?? "Unknown", source: "google-places", capturedAt: now(), confidence: 0.9, verificationStatus: "High Confidence" },
          industry: { value: filters.industry ?? "Unknown", source: "google-places", capturedAt: now(), confidence: 0.5, verificationStatus: "Likely" },
          location: {
            value: { city, state, country: addr.country },
            source: "google-places",
            capturedAt: now(),
            confidence: gotRealAddress ? 0.8 : city || state ? 0.6 : 0.3,
            verificationStatus: gotRealAddress ? "High Confidence" : city || state ? "Likely" : "Unknown",
          },
          signals: {
            multipleEntities: false,
            multipleLocations: false,
            creActivity: !!signals.creActivity,
            constructionActivity: !!signals.constructionActivity,
            hospitalityOperations: !!signals.hospitalityOperations,
            projectVolume: false,
            documentBurden: false,
            departments: false,
            workflowComplexity: false,
            growthRate: false,
            acquisitionActivity: false,
            portfolioOwnership: false,
            businessUnits: false,
            operationalComplexity: false,
            spreadsheetHeavy: false,
            disconnectedSoftware: false,
          },
          contacts: [],
          tags: r.place_id ? [`place:${r.place_id}`] : [],
          sourceProvider: "google-places",
          isSample: false,
          mock: ctx.mock,
          importedAt: now(),
        } as Prospect;
      });
  };

  const enrichCompany = async (p: Prospect, ctx: ProviderCtx): Promise<CompanyEnrichment | undefined> => {
    ctx.tracker.record("google-places", "enrichCompany", 1, ctx.mock);
    if (ctx.mock) return undefined;
    const placeId = p.tags.find((t) => t.startsWith("place:"))?.slice(6);
    const query = placeId
      ? `place_id:${placeId}`
      : `${p.companyName.value} ${p.location.value.city ?? ""} ${p.location.value.state ?? ""}`.trim();
    const res = await fetchJson<DetailsResponse>(
      `${DETAILS}?place_id=${encodeURIComponent(query)}&fields=place_id,name,formatted_address,formatted_phone_number,international_phone_number,website,types,business_status&key=${apiKey}`
    );
    const r = res?.result;
    if (!r) return undefined;
    const addr = parseAddress(r.formatted_address);
    const out: CompanyEnrichment = {};
    if (r.formatted_phone_number || r.international_phone_number) {
      out.phone = {
        value: r.international_phone_number || r.formatted_phone_number || "",
        source: "google-places",
        capturedAt: now(),
        confidence: 0.95,
        verificationStatus: "High Confidence",
      };
    }
    if (r.website) {
      out.website = { value: domainOf(r.website), source: "google-places", capturedAt: now(), confidence: 0.9, verificationStatus: "High Confidence" };
    }
    if (addr.city || addr.state) {
      out.location = { value: addr, source: "google-places", capturedAt: now(), confidence: 0.8, verificationStatus: "High Confidence" };
    }
    const signals = signalsFromTypes(r.types);
    if (Object.keys(signals).length) out.signals = signals;
    return out;
  };

  const verifyPhone = async (p: Prospect, _contact: Contact, ctx: ProviderCtx): Promise<Provenance | undefined> => {
    ctx.tracker.record("google-places", "verifyPhone", 1, ctx.mock);
    if (ctx.mock) return undefined;
    const placeId = p.tags.find((t) => t.startsWith("place:"))?.slice(6);
    if (!placeId) return undefined;
    const res = await fetchJson<DetailsResponse>(`${DETAILS}?place_id=${encodeURIComponent(placeId)}&fields=formatted_phone_number,international_phone_number,business_status&key=${apiKey}`);
    const phone = res?.result?.international_phone_number || res?.result?.formatted_phone_number;
    if (!phone) return undefined;
    return { value: phone, source: "google-places", capturedAt: now(), confidence: 0.97, verificationStatus: "High Confidence" };
  };

  return { def, discoverCompanies, enrichCompany, verifyPhone };
}