/**
 * People Data Labs adapter — official v5 Enrichment + Search API.
 *
 *   POST https://api.peopledatalabs.com/v5/company/enrich  (body: { website, name })
 *     → { data: { name, size: { name: "51-200" }, revenue: { amount }, industry,
 *                 location: { locality, region, country }, description, website } }
 *   POST https://api.peopledatalabs.com/v5/person/search   (body: { query, size })
 *     → { data: [ { first_name, last_name, job_title, work_email,
 *                   employer: { name, size } } ] }
 *
 * PDL data is licensed/aggregated B2B data — employees/revenue are estimates
 * (Likely), titles are Likely, emails are Unverified until verified elsewhere.
 */

import type { Contact, Prospect, Provenance } from "../types";
import type { CompanyEnrichment, ProviderCtx, ProviderRuntime } from "./types";
import { fetchJson, domainOf, now } from "./http";
import { contactId } from "./util";

const BASE = "https://api.peopledatalabs.com/v5";

interface PdlSize {
  name?: string;
  employees?: number;
}
interface PdlLocation {
  name?: string;
  locality?: string;
  region?: string;
  country?: string;
  street_address?: string;
}
interface PdlCompanyData {
  name?: string;
  website?: string;
  size?: PdlSize;
  revenue?: { amount?: number; currency?: string };
  industry?: string;
  location?: PdlLocation;
  description?: string;
  employee_count?: number;
}
interface PdlPersonData {
  first_name?: string;
  last_name?: string;
  full_name?: string;
  job_title?: string;
  work_email?: string;
  email?: string;
  phone_numbers?: { phone_number?: string }[];
  employer?: { name?: string; size?: PdlSize };
  location?: PdlLocation;
}
interface PdlEnrichResponse<T> {
  status?: number;
  data?: T | null;
  error?: { message?: string }[];
}
interface PdlSearchResponse {
  data?: PdlPersonData[];
  total?: number;
}

const headers = (apiKey: string) => ({
  "X-Api-Key": apiKey,
  "Content-Type": "application/json",
});

export function makePdl(apiKey: string, mock: boolean): ProviderRuntime {
  const def: ProviderRuntime["def"] = {
    id: "pdl",
    name: "People Data Labs",
    kind: "api",
    status: mock ? "mock" : "active",
    capabilities: ["enrichCompany", "findDecisionMakers"],
    envKeys: ["PDL_API_KEY"],
    description: "Person & company enrichment from People Data Labs (licensed data). Employee/revenue figures are estimates — labeled Likely until confirmed.",
    mock,
  };

  const enrichCompany = async (p: Prospect, ctx: ProviderCtx): Promise<CompanyEnrichment | undefined> => {
    ctx.tracker.record("pdl", "enrichCompany", 1, ctx.mock);
    if (ctx.mock) return undefined;
    const body: Record<string, string> = { name: p.companyName.value };
    const domain = domainOf(p.website?.value);
    if (domain) body.website = domain;
    const loc = p.location.value;
    if (loc.city || loc.state) body.location = `${loc.city ?? ""} ${loc.state ?? ""}`.trim();
    const res = await fetchJson<PdlEnrichResponse<PdlCompanyData>>(`${BASE}/company/enrich`, {
      method: "POST",
      headers: headers(apiKey),
      body,
    });
    const d = res?.data;
    if (!d?.name) return undefined;
    const out: CompanyEnrichment = {};
    if (d.size?.name) {
      out.employees = { value: d.size.name, source: "pdl", capturedAt: now(), confidence: 0.6, verificationStatus: "Likely" };
    } else if (d.size?.employees !== undefined) {
      out.employees = { value: String(d.size.employees), source: "pdl", capturedAt: now(), confidence: 0.6, verificationStatus: "Likely" };
    }
    if (d.revenue?.amount !== undefined && (!d.revenue.currency || d.revenue.currency === "USD")) {
      const amt = d.revenue.amount >= 1000 ? Math.round(d.revenue.amount / 1000) : d.revenue.amount;
      out.revenue = { value: `${amt}M`, source: "pdl", capturedAt: now(), confidence: 0.6, verificationStatus: "Likely" };
    }
    if (d.industry) out.industry = { value: d.industry, source: "pdl", capturedAt: now(), confidence: 0.7, verificationStatus: "Likely" };
    if (d.description) out.description = { value: d.description.slice(0, 500), source: "pdl", capturedAt: now(), confidence: 0.7, verificationStatus: "Likely" };
    if (d.website) out.website = { value: domainOf(d.website), source: "pdl", capturedAt: now(), confidence: 0.85, verificationStatus: "High Confidence" };
    const city = d.location?.locality ?? d.location?.name;
    const region = d.location?.region;
    if (city || region) {
      out.location = {
        value: { city: city ?? "", state: region ?? "", country: d.location?.country ?? "US" },
        source: "pdl",
        capturedAt: now(),
        confidence: 0.7,
        verificationStatus: "High Confidence",
      };
    }
    return out;
  };

  const findDecisionMakers = async (p: Prospect, ctx: ProviderCtx): Promise<Contact[]> => {
    ctx.tracker.record("pdl", "findDecisionMakers", 1, ctx.mock);
    if (ctx.mock) return [];
    const domain = domainOf(p.website?.value);
    const must: unknown[] = [];
    if (domain) must.push({ term: { employer_website: domain } });
    if (!domain) must.push({ match: { company_name: p.companyName.value } });
    must.push({ terms: { job_title_levels: ["vp", "c_suite", "director"] } });
    const res = await fetchJson<PdlSearchResponse>(`${BASE}/person/search`, {
      method: "POST",
      headers: headers(apiKey),
      body: { query: { bool: { must } }, size: 5 },
    });
    const people = res?.data ?? [];
    return people
      .filter((d) => d.first_name || d.last_name || d.job_title)
      .slice(0, 5)
      .map((d, i): Contact => {
        const name = [d.first_name, d.last_name].filter(Boolean).join(" ") || d.full_name || "Unknown";
        const email: Provenance | undefined = d.work_email || d.email
          ? { value: d.work_email || d.email || "", source: "pdl", capturedAt: now(), confidence: 0.5, verificationStatus: "Unverified" }
          : undefined;
        const phone: Provenance | undefined = d.phone_numbers?.[0]?.phone_number
          ? { value: d.phone_numbers[0].phone_number, source: "pdl", capturedAt: now(), confidence: 0.5, verificationStatus: "Likely" }
          : undefined;
        return {
          id: contactId(p.companyName.value, i, "pdl"),
          fullName: { value: name, source: "pdl", capturedAt: now(), confidence: 0.8, verificationStatus: "High Confidence" },
          title: { value: d.job_title ?? "Unknown", source: "pdl", capturedAt: now(), confidence: 0.7, verificationStatus: "Likely" },
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
          isPrimary: i === 0,
        };
      });
  };

  return { def, enrichCompany, findDecisionMakers };
}
