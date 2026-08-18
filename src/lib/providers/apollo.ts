/**
 * Apollo adapter — official Apollo.io API v1 (People + Company search).
 *
 *   POST https://api.apollo.io/v1/mixed_companies/search  (X-Api-Key header)
 *     → { organizations: [{ id, name, website_url, estimated_num_employees,
 *                           revenue_range: { minimum, maximum, currency },
 *                           industry, ... }] }
 *   POST https://api.apollo.io/v1/mixed_people/search
 *     → { people: [{ id, first_name, last_name, title, email, phone,
 *                    organization: { name, website_url } }] }
 *
 * Apollo is credit-based (~1 credit per result returned); every search call is
 * recorded as one call at the default credit cost. Emails from Apollo are
 * Unverified; phone numbers Likely — nothing is presented as verified.
 */

import type { Contact, Prospect, SearchFilters } from "../types";
import type { Provenance } from "../types";
import type { CompanyEnrichment, ProviderCtx, ProviderRuntime } from "./types";
import { fetchJson, domainOf, now } from "./http";
import { contactId } from "./util";

const BASE = "https://api.apollo.io/v1";

interface ApolloOrg {
  id?: string;
  name?: string;
  website_url?: string;
  employee_count?: number;
  estimated_num_employees?: number;
  industry?: string;
  revenue_range?: { minimum?: number; maximum?: number; currency?: string };
  primary_phone?: string | null;
  address?: { city?: string; state?: string; country?: string } | null;
  organization_locations?: { city?: string; state?: string; country?: string }[];
}
interface ApolloPerson {
  id?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  title?: string;
  email?: string | null;
  phone?: string | null;
  organization?: { name?: string; website_url?: string };
}
interface ApolloResponse {
  organizations?: ApolloOrg[];
  people?: ApolloPerson[];
  error?: string;
}

const headers = (apiKey: string) => ({
  "X-Api-Key": apiKey,
  "Content-Type": "application/json",
});

function employeesLabel(count?: number): string | undefined {
  if (count === undefined) return undefined;
  const bands: [number, number, string][] = [
    [0, 10, "1-10"],
    [11, 20, "11-20"],
    [21, 50, "21-50"],
    [51, 200, "51-200"],
    [201, 500, "201-500"],
    [501, 1000, "501-1000"],
    [1001, 5000, "1001-5000"],
    [5001, 10000, "5001-10000"],
    [10001, Infinity, "10001+"],
  ];
  for (const [lo, hi, label] of bands) {
    if (count >= lo && count <= hi) return label;
  }
  return String(count);
}

function revenueLabel(r?: { minimum?: number; maximum?: number }): string | undefined {
  if (!r?.minimum && !r?.maximum) return undefined;
  const m = (v?: number) => (v === undefined ? undefined : Math.round(v / 1_000_000));
  const lo = m(r.minimum);
  const hi = m(r.maximum);
  if (lo !== undefined && hi !== undefined && lo === hi) return `${lo}M`;
  if (lo !== undefined && hi !== undefined) return `${lo}M-${hi}M`;
  return `${lo ?? hi}M`;
}

export function makeApollo(apiKey: string, mock: boolean): ProviderRuntime {
  const def: ProviderRuntime["def"] = {
    id: "apollo",
    name: "Apollo",
    kind: "api",
    status: mock ? "mock" : "active",
    capabilities: ["discoverCompanies", "findDecisionMakers", "enrichCompany", "findEmail"],
    envKeys: ["APOLLO_API_KEY"],
    description: "Licensed B2B database: company discovery, decision makers, enrichment. Credit-based — calls are counted against maxEnrichPerRun.",
    mock,
  };

  const discoverCompanies = async (filters: SearchFilters, ctx: ProviderCtx): Promise<Prospect[]> => {
    ctx.tracker.record("apollo", "discoverCompanies", 1, ctx.mock);
    if (ctx.mock) return [];
    const body: Record<string, unknown> = { page: 1 + Math.floor((filters.offset ?? 0) / 20), per_page: 20 };
    // Apollo's q_organization_name matches company NAMES (fuzzy). An industry
    // phrase like "Commercial Real Estate Development" matches no real org name,
    // so discovery returned zero organizations. Explicit company-name keywords
    // (the user typed a name to look for) keep going to q_organization_name;
    // industry/subIndustry terms go to q_keywords — Apollo's free-text search —
    // so real organizations in the segment actually come back. Location and
    // employee-size filters are intentionally unchanged.
    const orgNameKw = filters.keywords?.join(" ")?.trim();
    const industryTerm = filters.subIndustry || filters.industry;
    if (orgNameKw) body.q_organization_name = orgNameKw;
    else if (industryTerm) body.q_keywords = industryTerm;
    if (filters.location?.state) body.organization_locations = [{ location_type: "region", location: filters.location.state }];
    else if (filters.location?.city) body.organization_locations = [{ location_type: "city", location: filters.location.city }];
    if (filters.employeeMin !== undefined || filters.employeeMax !== undefined) {
      body.organization_num_employees_ranges = [[String(filters.employeeMin ?? 1), String(filters.employeeMax ?? 100000)]];
    }
    const res = await fetchJson<ApolloResponse>(`${BASE}/mixed_companies/search`, { method: "POST", headers: headers(apiKey), body });
    const orgs = res?.organizations ?? [];
    return orgs
      .filter((o) => o.name)
      .slice(0, 20)
      .map((o, i): Prospect => {
        const loc = o.address ?? o.organization_locations?.[0];
        const emp = employeesLabel(o.estimated_num_employees ?? o.employee_count);
        const rev = revenueLabel(o.revenue_range);
        return {
          id: `apollo-${o.id ?? slugName(o.name ?? "")}-${i}`,
          companyName: { value: o.name ?? "Unknown", source: "apollo", capturedAt: now(), confidence: 0.9, verificationStatus: "High Confidence" },
          industry: { value: o.industry || filters.industry || "Unknown", source: "apollo", capturedAt: now(), confidence: 0.6, verificationStatus: "Likely" },
          ...(emp
            ? { employees: { value: emp, source: "apollo", capturedAt: now(), confidence: 0.6, verificationStatus: "Likely" } as const }
            : {}),
          ...(rev
            ? { revenue: { value: rev, source: "apollo", capturedAt: now(), confidence: 0.6, verificationStatus: "Likely" } as const }
            : {}),
          ...(o.website_url
            ? { website: { value: domainOf(o.website_url), source: "apollo", capturedAt: now(), confidence: 0.9, verificationStatus: "High Confidence" } as const }
            : {}),
          location: {
            value: { city: loc?.city ?? "", state: loc?.state ?? "", country: loc?.country ?? "US" },
            source: "apollo",
            capturedAt: now(),
            confidence: loc?.city || loc?.state ? 0.6 : 0,
            verificationStatus: loc?.city || loc?.state ? "Likely" : "Unknown",
          },
          signals: {
            multipleEntities: false,
            multipleLocations: false,
            creActivity: false,
            constructionActivity: false,
            hospitalityOperations: false,
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
          tags: o.id ? [`apollo:${o.id}`] : [],
          sourceProvider: "apollo",
          isSample: false,
          mock: ctx.mock,
          importedAt: now(),
        };
      });
  };

  const enrichCompany = async (p: Prospect, ctx: ProviderCtx): Promise<CompanyEnrichment | undefined> => {
    ctx.tracker.record("apollo", "enrichCompany", 1, ctx.mock);
    if (ctx.mock) return undefined;
    const body: Record<string, unknown> = { page: 1, per_page: 1 };
    const orgId = p.tags.find((t) => t.startsWith("apollo:"))?.slice(7);
    if (orgId) body.id = [orgId];
    else {
      body.q_organization_name = p.companyName.value;
      if (p.location.value.state) body.organization_locations = [{ location_type: "region", location: p.location.value.state }];
    }
    const res = await fetchJson<ApolloResponse>(`${BASE}/mixed_companies/search`, { method: "POST", headers: headers(apiKey), body });
    const o = res?.organizations?.[0];
    if (!o?.name) return undefined;
    const out: CompanyEnrichment = {};
    const emp = employeesLabel(o.estimated_num_employees ?? o.employee_count);
    if (emp) out.employees = { value: emp, source: "apollo", capturedAt: now(), confidence: 0.6, verificationStatus: "Likely" };
    const rev = revenueLabel(o.revenue_range);
    if (rev) out.revenue = { value: rev, source: "apollo", capturedAt: now(), confidence: 0.6, verificationStatus: "Likely" };
    if (o.industry) out.industry = { value: o.industry, source: "apollo", capturedAt: now(), confidence: 0.6, verificationStatus: "Likely" };
    if (o.website_url) out.website = { value: domainOf(o.website_url), source: "apollo", capturedAt: now(), confidence: 0.9, verificationStatus: "High Confidence" };
    const loc = o.address ?? o.organization_locations?.[0];
    if (loc?.city || loc?.state) {
      out.location = {
        value: { city: loc.city ?? "", state: loc.state ?? "", country: loc.country ?? "US" },
        source: "apollo",
        capturedAt: now(),
        confidence: 0.6,
        verificationStatus: "Likely",
      };
    }
    if (o.primary_phone) out.phone = { value: o.primary_phone, source: "apollo", capturedAt: now(), confidence: 0.5, verificationStatus: "Likely" };
    return out;
  };

  const findDecisionMakers = async (p: Prospect, ctx: ProviderCtx): Promise<Contact[]> => {
    ctx.tracker.record("apollo", "findDecisionMakers", 1, ctx.mock);
    if (ctx.mock) return [];
    const body: Record<string, unknown> = { page: 1, per_page: 5 };
    const domain = domainOf(p.website?.value);
    if (domain) body.organization_domains = [domain];
    else body.organization_name = p.companyName.value;
    body.person_titles = ["Chief Executive Officer", "Chief Operating Officer", "VP Operations", "Chief Financial Officer", "Director of Operations"];
    const res = await fetchJson<ApolloResponse>(`${BASE}/mixed_people/search`, { method: "POST", headers: headers(apiKey), body });
    const people = res?.people ?? [];
    return people
      .filter((d) => d.first_name || d.last_name || d.name || d.title)
      .slice(0, 5)
      .map((d, i): Contact => {
        const name = [d.first_name, d.last_name].filter(Boolean).join(" ") || d.name || "Unknown";
        const email: Provenance | undefined = d.email
          ? { value: d.email, source: "apollo", capturedAt: now(), confidence: 0.6, verificationStatus: "Unverified" }
          : undefined;
        const phone: Provenance | undefined = d.phone
          ? { value: d.phone, source: "apollo", capturedAt: now(), confidence: 0.5, verificationStatus: "Likely" }
          : undefined;
        return {
          id: contactId(p.companyName.value, i, "apollo"),
          fullName: { value: name, source: "apollo", capturedAt: now(), confidence: 0.8, verificationStatus: "High Confidence" },
          title: { value: d.title ?? "Unknown", source: "apollo", capturedAt: now(), confidence: 0.7, verificationStatus: "Likely" },
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          isPrimary: i === 0,
        };
      });
  };

  const findEmail = async (p: Prospect, contact: Contact, ctx: ProviderCtx): Promise<Provenance | undefined> => {
    ctx.tracker.record("apollo", "findEmail", 1, ctx.mock);
    if (ctx.mock) return undefined;
    const domain = domainOf(p.website?.value);
    if (!domain) return undefined;
    const name = contact.fullName.value;
    const body: Record<string, unknown> = { page: 1, per_page: 1, organization_domains: [domain], q_keywords: name === "Unknown" ? undefined : name };
    const res = await fetchJson<ApolloResponse>(`${BASE}/mixed_people/search`, { method: "POST", headers: headers(apiKey), body });
    const email = res?.people?.find((d) => d.email)?.email;
    if (!email) return undefined;
    return { value: email, source: "apollo", capturedAt: now(), confidence: 0.6, verificationStatus: "Unverified" };
  };

  return { def, discoverCompanies, enrichCompany, findDecisionMakers, findEmail };
}

function slugName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);
}
