/**
 * Provider registry — data providers plug in without rebuilding the app.
 *
 * Capabilities are declared per provider; the app inspects what's available and
 * adapts. The app must run with ZERO providers configured (CSV import works
 * import are built-in and always available).
 *
 * Statuses:
 *   - "active":          env key configured → real API calls.
 *   - "mock":            no key, but mock mode is on (ENABLE_PROVIDER_MOCKS or
 *                        the Settings "Dry run" switch) → clearly-labeled canned
 *                        responses so the waterfall runs without spending money.
 *   - "not-configured":  no key, no mock mode → capability surface is absent.
 */

import type { Prospect } from "../types";
import type { ProviderRuntime, ProviderStatus } from "./types";
import { makeGooglePlaces } from "./googlePlaces";
import { makeHunter } from "./hunter";
import { makePdl } from "./pdl";
import { makeApollo } from "./apollo";
import { slug } from "./util";

export type { Capability, ProviderDef, ProviderCtx, CompanyEnrichment, VerificationResult, ProviderRuntime, ProviderStatus } from "./types";
export { hasCapability, CAPABILITY_METHOD } from "./types";
export { UsageTracker, costFor, PROVIDER_COST_KEYS } from "./costs";
export type { UsageEntry } from "./costs";

const now = () => new Date().toISOString();

/** Map a raw CSV row onto a Prospect with honest provenance (Unverified). */
export function rowToProspect(
  row: Record<string, string>,
  providerId: string,
  isSample: boolean
): Prospect | null {
  const companyName = (row.company || row.company_name || row.name || "").trim();
  if (!companyName) return null;
  const c = row.city?.trim() || "";
  const s = row.state?.trim() || "";
  const emp = (row.employees || row.employee_count || "").trim();
  const rev = (row.revenue || "").trim();
  const email = (row.email || row.contact_email || "").trim();
  const phone = (row.phone || row.contact_phone || "").trim();
  const contactName = (row.contact_name || row.contact || `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim()).trim();
  const title = (row.title || row.job_title || "").trim();
  const source = isSample ? "sample-data (fictional)" : "csv-import";

  // Optional `signals` column (JSON) — lets
  // imported CSVs feed the fit engine. Missing/invalid → all signals false.
  const sigRaw = (row.signals || row.signal_json || "").trim();
  let parsedSignals: Partial<import("../types").Signals> = {};
  if (sigRaw) {
    try {
      const s = JSON.parse(sigRaw) as unknown;
      if (s && typeof s === "object" && !Array.isArray(s)) parsedSignals = s as Partial<import("../types").Signals>;
    } catch {
      parsedSignals = {};
    }
  }
  const contacts: Prospect["contacts"] =
    contactName || email || phone || title
      ? [
          {
            id: slug(companyName) + "-c1",
            fullName: {
              value: contactName || "Unknown",
              source,
              capturedAt: now(),
              confidence: contactName ? 1 : 0,
              verificationStatus: contactName ? (isSample ? "High Confidence" : "Unverified") : "Unknown",
            },
            title: {
              value: title || "Unknown",
              source,
              capturedAt: now(),
              confidence: title ? 1 : 0,
              verificationStatus: title ? (isSample ? "High Confidence" : "Unverified") : "Unknown",
            },
            ...(email
              ? {
                  email: {
                    value: email,
                    source,
                    capturedAt: now(),
                    confidence: 1,
                    verificationStatus: isSample ? "Verified" : "Unverified",
                  } as const,
                }
              : {}),
            ...(phone
              ? {
                  phone: {
                    value: phone,
                    source,
                    capturedAt: now(),
                    confidence: 1,
                    verificationStatus: isSample ? "High Confidence" : "Unverified",
                  } as const,
                }
              : {}),
            isPrimary: true,
          },
        ]
      : [];

  return {
    id: slug(companyName) + "-" + slug(providerId) + "-" + (isSample ? "s" : "u"),
    companyName: {
      value: companyName,
      source,
      capturedAt: now(),
      confidence: 1,
      verificationStatus: isSample ? "High Confidence" : "Unverified",
    },
    industry: {
      value: (row.industry || "Unknown").trim() || "Unknown",
      source,
      capturedAt: now(),
      confidence: row.industry ? 1 : 0,
      verificationStatus: row.industry ? (isSample ? "High Confidence" : "Unverified") : "Unknown",
    },
    ...((row.sub_industry || "").trim()
      ? {
          subIndustry: {
            value: row.sub_industry.trim(),
            source,
            capturedAt: now(),
            confidence: 1,
            verificationStatus: isSample ? "High Confidence" : "Unverified",
          } as const,
        }
      : {}),
    location: {
      value: { city: c, state: s, country: (row.country || "US").trim() || "US" },
      source,
      capturedAt: now(),
      confidence: c || s ? 1 : 0,
      verificationStatus: c || s ? (isSample ? "High Confidence" : "Unverified") : "Unknown",
    },
    ...(emp
      ? {
          employees: {
            value: emp,
            source,
            capturedAt: now(),
            confidence: 1,
            verificationStatus: isSample ? "High Confidence" : "Unverified",
          } as const,
        }
      : {}),
    ...(rev
      ? {
          revenue: {
            value: rev,
            source,
            capturedAt: now(),
            confidence: 1,
            verificationStatus: isSample ? "High Confidence" : "Unverified",
          } as const,
        }
      : {}),
    ...((row.website || "").trim()
      ? {
          website: {
            value: row.website.trim(),
            source,
            capturedAt: now(),
            confidence: 1,
            verificationStatus: isSample ? "High Confidence" : "Unverified",
          } as const,
        }
      : {}),
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
      ...parsedSignals,
    },
    contacts,
    tags: [],
    sourceProvider: providerId,
    isSample,
    importedAt: now(),
  };
}

/* ------------------------------------------------------------------ */
/* CSV import provider (always active)                                 */
/* ------------------------------------------------------------------ */

const csvProvider: ProviderRuntime = {
  def: {
    id: "csv",
    name: "CSV Import",
    kind: "csv",
    status: "active",
    capabilities: ["importRows", "discoverCompanies"],
    envKeys: [],
    description:
      "Upload or paste your own list of companies. No API keys needed — rows become prospects with Unverified provenance until enriched.",
    mock: false,
  },
  async importRows(rows) {
    return rows.map((r) => rowToProspect(r, "csv", false)).filter(Boolean) as Prospect[];
  },
};

/* ------------------------------------------------------------------ */
/* Registry builder                                                     */
/* ------------------------------------------------------------------ */

export function buildRegistry(
  env: Record<string, string | undefined> = process.env,
  mockMode = false
): ProviderRuntime[] {
  const key = (k: string) => env[k]?.trim() || "";
  const registry: ProviderRuntime[] = [csvProvider];

  const googleKey = key("GOOGLE_PLACES_API_KEY");
  const hunterKey = key("HUNTER_API_KEY");
  const pdlKey = key("PDL_API_KEY");
  const apolloKey = key("APOLLO_API_KEY");

  // Real adapters activate when their key exists; without a key they only exist
  // in mock mode (dry run). Never both: real keys win, mocks are only the fallback.
  if (googleKey) registry.push(makeGooglePlaces(googleKey, false));
  else if (mockMode) registry.push(makeGooglePlaces("", true));
  if (hunterKey) registry.push(makeHunter(hunterKey, false));
  else if (mockMode) registry.push(makeHunter("", true));
  if (pdlKey) registry.push(makePdl(pdlKey, false));
  else if (mockMode) registry.push(makePdl("", true));
  if (apolloKey) registry.push(makeApollo(apolloKey, false));
  else if (mockMode) registry.push(makeApollo("", true));

  return registry;
}

export function providerDefs(env: Record<string, string | undefined> = process.env, mockMode = false): ProviderRuntime["def"][] {
  return buildRegistry(env, mockMode).map((p) => p.def);
}

export function isProviderUsable(def: { status: ProviderStatus }): boolean {
  return def.status === "active" || def.status === "mock";
}
