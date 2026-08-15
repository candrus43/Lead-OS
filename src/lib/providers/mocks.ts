/**
 * MOCK MODE — clearly-labeled canned provider responses for dry runs.
 *
 * Enabled via ENABLE_PROVIDER_MOCKS=true (server env) or the "Dry run" switch
 * in Settings. Every field returned here carries source "mock:<provider>" and
 * prospects get mock: true so the UI shows a "mock" badge. Mock data is NEVER
 * presented as real: it exists purely to exercise the enrichment waterfall
 * end to end without spending credits.
 */

import type { Contact, Prospect, Provenance, SearchFilters, Signals } from "../types";
import type { Capability, CompanyEnrichment, ProviderCtx, VerificationResult } from "./types";
import { domainOf, now } from "./http";
import { contactId, slug } from "./util";

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const mockSource = (provider: string) => `mock:${provider}`;

function prov<T>(provider: string, value: T, verificationStatus: Provenance["verificationStatus"], confidence: number): Provenance<T> {
  return { value, source: mockSource(provider), capturedAt: now(), confidence, verificationStatus };
}

const EMPTY_SIGNALS: Signals = {
  multipleEntities: false, multipleLocations: false, creActivity: false, constructionActivity: false,
  hospitalityOperations: false, projectVolume: false, documentBurden: false, departments: false,
  workflowComplexity: false, growthRate: false, acquisitionActivity: false, portfolioOwnership: false,
  businessUnits: false, operationalComplexity: false, spreadsheetHeavy: false, disconnectedSoftware: false,
};

const MOCK_NAMES = ["Stonebridge", "Cedar Hollow", "Iron Peak", "Bluewater", "Summitline", "Red Oak", "Granite Point", "Silver Creek", "Harborlight", "Northgate"];

function mockCompanyName(provider: string, filters: SearchFilters, i: number): string {
  const base = MOCK_NAMES[(hash(provider + (filters.industry ?? "company") + i) + i) % MOCK_NAMES.length];
  const activity = filters.subIndustry || filters.industry || "Development";
  return `${base} ${activity.replace(/\b(\w)/g, (c) => c.toUpperCase())}`;
}

function mockDomain(name: string): string {
  return `${slug(name).slice(0, 32)}.example.com`;
}

/* ---------------------------- discovery mocks ---------------------------- */

function mockDiscover(filters: SearchFilters, provider: string, withSize: boolean): Prospect[] {
  const state = filters.location?.state ?? "TX";
  const city = filters.location?.city ?? "Austin";
  return Array.from({ length: 4 }, (_, i) => {
    const name = mockCompanyName(provider, filters, i);
    const signals = { ...EMPTY_SIGNALS };
    if (filters.industry?.toLowerCase() === "hospitality") signals.hospitalityOperations = true;
    if (filters.industry?.toLowerCase() === "real estate") signals.creActivity = true;
    if (filters.industry?.toLowerCase() === "construction") signals.constructionActivity = true;
    return {
      id: `mock-${provider}-${slug(name)}`,
      companyName: prov(provider, name, "High Confidence", 0.9),
      industry: prov(provider, filters.industry ?? "Unknown", "Likely", 0.6),
      ...(filters.subIndustry ? { subIndustry: prov(provider, filters.subIndustry, "Likely", 0.6) as Provenance } : {}),
      location: prov(provider, { city, state, country: "US" }, "High Confidence", 0.9),
      ...(withSize
        ? {
            employees: prov(provider, filters.employeeMin !== undefined && filters.employeeMax !== undefined ? `${filters.employeeMin}-${filters.employeeMax}` : "51-200", "Likely", 0.6) as Provenance<string>,
          }
        : {}),
      website: prov(provider, mockDomain(name), "High Confidence", 0.9),
      signals,
      contacts: [],
      tags: [`place:mock-${i}`],
      sourceProvider: provider,
      isSample: false,
      mock: true,
      importedAt: now(),
    } as Prospect;
  });
}

/* --------------------------- enrichment mocks ---------------------------- */

function mockContacts(provider: string, p: Prospect): Contact[] {
  const domain = domainOf(p.website?.value) || mockDomain(p.companyName.value);
  const name = p.companyName.value;
  return [
    {
      id: contactId(name, 0, "mock"),
      fullName: prov(provider, "Morgan Reyes", "High Confidence", 0.9),
      title: prov(provider, "VP Operations", "Likely", 0.7),
      email: prov(provider, `morgan.reyes@${domain}`, "Unverified", 0.7),
      ...(provider === "apollo" ? { phone: prov(provider, "+1 (512) 555-0198", "Likely", 0.5) as Provenance } : {}),
      isPrimary: true,
    },
    {
      id: contactId(name, 1, "mock"),
      fullName: prov(provider, "Jordan Blake", "High Confidence", 0.9),
      title: prov(provider, "Director of Development", "Likely", 0.7),
      ...(provider === "apollo" ? { email: prov(provider, `jordan.blake@${domain}`, "Unverified", 0.6) as Provenance } : {}),
      isPrimary: false,
    },
  ];
}

function mockCompanyEnrichment(provider: string, p: Prospect): CompanyEnrichment {
  const domain = domainOf(p.website?.value) || mockDomain(p.companyName.value);
  return {
    employees: prov(provider, "51-200", "Likely", 0.6),
    revenue: prov(provider, "25M", "Likely", 0.6),
    industry: prov(provider, p.industry.value === "Unknown" ? "Real Estate" : p.industry.value, "Likely", 0.6),
    description: prov(provider, `Mock record: a multi-location ${p.industry.value.toLowerCase()} operator used for dry-run testing.`, "Likely", 0.6),
    website: prov(provider, domain, "High Confidence", 0.9),
    location: prov(provider, { city: p.location.value.city || "Austin", state: p.location.value.state || "TX", country: "US" }, "High Confidence", 0.9),
  };
}

/** Dispatch for a mock capability. Records usage itself (mock = true). */
export async function mockCall(
  providerId: string,
  capability: Capability,
  args: unknown[],
  ctx: ProviderCtx
): Promise<unknown> {
  ctx.tracker.record(providerId, capability, 1, true);
  const [p] = args as [Prospect?];
  const filters = args[0] as SearchFilters;

  switch (capability) {
    case "discoverCompanies": {
      if (providerId === "apollo") return mockDiscover(filters ?? {}, "apollo", true);
      return mockDiscover(filters ?? {}, "google-places", false);
    }
    case "enrichCompany":
      return mockCompanyEnrichment(providerId, p ?? ({} as Prospect));
    case "findDecisionMakers":
      return mockContacts(providerId, p ?? ({} as Prospect));
    case "findEmail": {
      const contact = args[1] as Contact | undefined;
      const domain = domainOf(p?.website?.value) || (p ? mockDomain(p.companyName.value) : "example.com");
      const name = contact?.fullName?.value ?? "primary.contact";
      const local = slug(name).slice(0, 24) || "primary.contact";
      return prov(providerId, `${local}@${domain}`, "Unverified", 0.7);
    }
    case "verifyEmail": {
      const result: VerificationResult = { verdict: "verified", detail: "mock verifier: deliverable (dry run)" };
      return result;
    }
    case "verifyPhone": {
      const existing = p?.contacts?.find((c) => c.isPrimary)?.phone?.value;
      return prov(providerId, existing ?? "+1 (512) 555-0198", "High Confidence", 0.95);
    }
    case "importRows":
      return [];
    default:
      return undefined;
  }
}
