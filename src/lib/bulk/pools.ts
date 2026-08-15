/**
 * Shared fictional-name pools for bulk mock discovery (dry-run mode only).
 * Everything here is clearly fictional: reserved .example.com domains, 555-phone
 * numbers, invented company/contact names. Mock discovery is behind the explicit
 * "dry run" toggle and every mock prospect carries a "mock" badge — nothing is
 * ever presented as real.
 */

export const FAKE_COMPANY_PREFIXES = [
  "Lone Pine", "Cedar Hollow", "Iron Peak", "Bluewater", "Summitline",
  "Red Oak", "Granite Point", "Silver Creek", "Harborlight", "Northgate",
  "Canyon Ridge", "Beaconfield", "Stonebridge", "Windmere", "Foxhollow",
];

export const FAKE_COMPANY_SUFFIXES = [
  "Development Partners", "Construction Group", "Hospitality Group", "Property Management",
  "Realty Co", "Operations Group", "Enterprises", "Holdings", "Capital Partners", "Builders",
];

export const TX_CITIES = ["Austin", "Dallas", "Houston", "San Antonio", "Fort Worth", "Plano", "El Paso", "Frisco", "Round Rock", "Garland"];

export const FAKE_NAMES = [
  "Ava Chen", "Marcus Webb", "Priya Nair", "Liam Ortiz", "Sofia Alvarez", "Ethan Brooks",
  "Maya Patel", "Noah Kim", "Isabella Torres", "Lucas Grant", "Zoe Ramirez", "Owen Hale",
  "Chloe Nguyen", "Henry Forde", "Nina Kowalski", "Rafael Diaz",
];

export const FAKE_TITLES = [
  "VP Operations", "Director of Development", "COO", "CFO", "VP Finance",
  "Director of Construction", "General Manager", "Head of Asset Management",
];

/** Industry → activity signals the fake companies imply (deterministic). */
export const INDUSTRY_SIGNAL: Record<string, string[]> = {
  "Real Estate": ["creActivity", "portfolioOwnership", "projectVolume"],
  "Construction": ["constructionActivity", "projectVolume", "documentBurden"],
  "Hospitality": ["hospitalityOperations", "multipleLocations"],
  "Franchise": ["multipleEntities", "multipleLocations", "growthRate"],
  "Property Management": ["creActivity", "portfolioOwnership", "departments"],
  "Logistics": ["operationalComplexity", "workflowComplexity"],
};

export const FAKE_INDUSTRIES = [
  "Real Estate", "Construction", "Hospitality", "Franchise", "Property Management", "Logistics",
];

export const FAKE_SUB_INDUSTRIES: Record<string, string[]> = {
  "Real Estate": ["Commercial Real Estate Development", "Real Estate Development", "Property Management"],
  "Construction": ["Commercial Contracting", "General Contracting", "Commercial Construction"],
  "Hospitality": ["Hotels", "Restaurant Group", "Hotel Management"],
  "Franchise": ["Multi-unit Operators", "Franchise Operators"],
  "Property Management": ["Commercial Property Management", "Residential Property Management"],
  "Logistics": ["Warehousing", "Freight & Distribution"],
};

export const EMPLOYEE_BANDS = ["20-50", "51-200", "201-500", "501-1000"];
export const REVENUE_BANDS = ["10M", "25M", "50M", "100M"];

/** Deterministic pseudo-random from a seed. */
export function seeded(n: number): number {
  let h = (n * 2654435761) | 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Slug for invented domains — always under the reserved .example.com TLD. */
export function fakeDomain(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 32)}.example.com`;
}

export function fakePhone(i: number): string {
  const a = 200 + (i % 799);
  const b = 1000 + (i * 37) % 9000;
  return `+1 (555) ${String(a).padStart(3, "0")}-${String(b % 10000).padStart(4, "0")}`;
}

/** One of 5 signal profiles: high → low fit (so gates actually engage). */
export function signalProfile(profile: number, industry: string): Record<string, boolean> {
  const base = {
    multipleEntities: false, multipleLocations: false, creActivity: false, constructionActivity: false,
    hospitalityOperations: false, projectVolume: false, documentBurden: false, departments: false,
    workflowComplexity: false, growthRate: false, acquisitionActivity: false, portfolioOwnership: false,
    businessUnits: false, operationalComplexity: false, spreadsheetHeavy: false, disconnectedSoftware: false,
  };
  const activity = INDUSTRY_SIGNAL[industry] ?? ["documentBurden"];
  const P: Record<string, string[]> = {
    0: [...activity, "multipleEntities", "multipleLocations", "departments", "workflowComplexity", "operationalComplexity", "spreadsheetHeavy", "disconnectedSoftware", "growthRate"],
    1: [...activity, "multipleLocations", "departments", "workflowComplexity", "growthRate"],
    2: [...activity.slice(0, 1), "multipleLocations", "workflowComplexity", "spreadsheetHeavy"],
    3: [...activity.slice(0, 1), "projectVolume"],
    4: [],
  };
  for (const k of P[profile] ?? []) (base as Record<string, boolean>)[k] = true;
  return base;
}
