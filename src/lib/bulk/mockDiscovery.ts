/**
 * BULK mock discovery — clearly-labeled canned provider responses at scale.
 *
 * The single-call mock (providers/mocks.ts) returns 4 companies; bulk runs need
 * thousands. This generator produces `count` deterministic, clearly-labeled
 * fictional prospects (mock: true, source "mock:<provider>", .example.com
 * domains, 555 phones) with a deliberate fit spread so the fit gates and
 * enrichment waterfall demonstrably engage during a dry run.
 */

import type { Prospect, SearchFilters, Signals } from "../types";
import {
  EMPLOYEE_BANDS, FAKE_COMPANY_PREFIXES, FAKE_COMPANY_SUFFIXES, FAKE_INDUSTRIES, FAKE_NAMES,
  FAKE_SUB_INDUSTRIES, FAKE_TITLES, INDUSTRY_SIGNAL, REVENUE_BANDS, TX_CITIES, fakeDomain,
  fakePhone, seeded, signalProfile,
} from "./pools";

const now = () => new Date().toISOString();

const mockSource = (provider: string) => `mock:${provider}`;

function prov<T>(provider: string, value: T, verificationStatus: Prospect["companyName"]["verificationStatus"], confidence: number) {
  return { value, source: mockSource(provider), capturedAt: now(), confidence, verificationStatus };
}

const EMPTY_SIGNALS: Signals = {
  multipleEntities: false, multipleLocations: false, creActivity: false, constructionActivity: false,
  hospitalityOperations: false, projectVolume: false, documentBurden: false, departments: false,
  workflowComplexity: false, growthRate: false, acquisitionActivity: false, portfolioOwnership: false,
  businessUnits: false, operationalComplexity: false, spreadsheetHeavy: false, disconnectedSoftware: false,
};

export function mockDiscoverBulk(providerId: string, filters: SearchFilters, count: number, baseIndex = 0): Prospect[] {
  const state = filters.location?.state ?? "TX";
  const cityPool = filters.location?.city ? [filters.location.city] : TX_CITIES;
  const industryPool = filters.industry ? [filters.industry] : FAKE_INDUSTRIES;
  const out: Prospect[] = [];
  for (let i = 0; i < count; i++) {
    const n = baseIndex + i;
    const r = seeded(n);
    const industry = industryPool[Math.floor(r * 100) % industryPool.length] ?? "Real Estate";
    const subPool = FAKE_SUB_INDUSTRIES[industry] ?? [industry];
    const prefix = FAKE_COMPANY_PREFIXES[n % FAKE_COMPANY_PREFIXES.length];
    const suffix = FAKE_SUB_INDUSTRIES[industry]
      ? FAKE_SUB_INDUSTRIES[industry][n % FAKE_SUB_INDUSTRIES[industry].length].replace(/^(Commercial |Real Estate |General |Multi-unit |Franchise |Residential )/, "")
      : FAKE_COMPANY_SUFFIXES[n % FAKE_COMPANY_SUFFIXES.length];
    const name = `${prefix} ${suffix} ${String(n % 1000).padStart(3, "0")}`;
    const city = cityPool[n % cityPool.length] ?? "Austin";
    const band = filters.employeeMin !== undefined || filters.employeeMax !== undefined
      ? `${filters.employeeMin ?? 20}-${filters.employeeMax ?? 200}`
      : EMPLOYEE_BANDS[n % EMPLOYEE_BANDS.length];
    const profile = n % 5; // 0,1 = high fit, 2 = mid, 3 = low-mid, 4 = low
    const signals = { ...EMPTY_SIGNALS, ...signalProfile(profile, industry) };
    const contactName = FAKE_NAMES[n % FAKE_NAMES.length];
    const contactTitle = FAKE_TITLES[n % FAKE_TITLES.length];
    const domain = fakeDomain(name);
    const first = contactName.split(" ")[0]?.toLowerCase() ?? "contact";
    const last = contactName.split(" ")[1]?.toLowerCase() ?? "person";
    out.push({
      id: `mock-${providerId}-${slug(name)}-${n}`,
      companyName: prov(providerId, name, "High Confidence", 0.9),
      industry: prov(providerId, industry, "Likely", 0.65),
      subIndustry: prov(providerId, subPool[n % subPool.length], "Likely", 0.65),
      location: prov(providerId, { city, state, country: "US" }, "High Confidence", 0.9),
      employees: prov(providerId, band, "Likely", 0.6),
      revenue: prov(providerId, REVENUE_BANDS[n % REVENUE_BANDS.length], "Likely", 0.6),
      website: prov(providerId, domain, "High Confidence", 0.9),
      description: prov(providerId, `Mock record: fictional ${industry.toLowerCase()} company for dry-run testing.`, "Likely", 0.6),
      signals,
      contacts: [
        {
          id: `${slug(name)}-c1`,
          fullName: prov(providerId, contactName, "High Confidence", 0.9),
          title: prov(providerId, contactTitle, "Likely", 0.7),
          email: prov(providerId, `${first}.${last}@${domain}`, "Unverified", 0.7),
          phone: prov(providerId, fakePhone(n), "Likely", 0.5),
          isPrimary: true,
        },
      ],
      tags: [`mock-bulk:${n}`],
      sourceProvider: providerId,
      isSample: false,
      mock: true,
      importedAt: now(),
    } as Prospect);
  }
  return out;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);
}

/** Signal keys actually present in a generated profile (for tests/UI). */
export function profileSignalCount(profile: number, industry: string): number {
  return Object.values(signalProfile(profile, industry)).filter(Boolean).length;
}

export { INDUSTRY_SIGNAL };
