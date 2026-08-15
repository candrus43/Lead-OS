/**
 * Provider abstraction types — capability declarations, runtime shape, and the
 * context every provider call receives (usage tracking + mock mode).
 *
 * Providers must degrade gracefully: a failed/absent provider returns undefined
 * or [] and the caller leaves fields Unknown — never guesses.
 */

import type { Contact, Prospect, Provenance, SearchFilters, Signals } from "../types";
import type { UsageTracker } from "./costs";

export type Capability =
  | "discoverCompanies"
  | "findDecisionMakers"
  | "enrichCompany"
  | "findEmail"
  | "verifyEmail"
  | "verifyPhone"
  | "importRows";

export type ProviderStatus = "active" | "mock" | "not-configured" | "stub";

export interface ProviderDef {
  id: string;
  name: string;
  kind: "builtin" | "csv" | "api";
  status: ProviderStatus;
  capabilities: Capability[];
  /** env var names this provider reads (shown in UI; secrets never leave server) */
  envKeys: string[];
  description: string;
  /** true when the provider is serving clearly-labeled mock data (dry run) */
  mock: boolean;
}

/** Per-call context: mock flag + usage tracker the provider records into. */
export interface ProviderCtx {
  mock: boolean;
  tracker: UsageTracker;
}

/** Partial enrichment a provider returns for a company. Fields are provenance-wrapped. */
export interface CompanyEnrichment {
  employees?: Provenance<string>;
  revenue?: Provenance<string>;
  industry?: Provenance;
  subIndustry?: Provenance;
  description?: Provenance;
  website?: Provenance;
  location?: Provenance<{ city: string; state: string; country: string }>;
  /** company phone (typically lands on the primary contact) */
  phone?: Provenance<string>;
  /** operational signal hints the provider's data implies (e.g. Google types → hospitality) */
  signals?: Partial<Signals>;
}

/** Honest email-verification verdict (Hunter-style). */
export interface VerificationResult {
  verdict: "verified" | "unverified" | "unknown";
  detail: string;
}

export interface ProviderRuntime {
  def: ProviderDef;
  /** Discovery: search for companies matching filters (Google Places / Apollo). */
  discoverCompanies?(filters: SearchFilters, ctx: ProviderCtx): Promise<Prospect[]>;
  /** CSV import (built-in). */
  importRows?(rows: Record<string, string>[]): Promise<Prospect[]>;
  /** Company enrichment (PDL / Apollo / Google Place Details). */
  enrichCompany?(p: Prospect, ctx: ProviderCtx): Promise<CompanyEnrichment | undefined>;
  /** Decision-maker discovery (Apollo People / PDL Person search). */
  findDecisionMakers?(p: Prospect, ctx: ProviderCtx): Promise<Contact[]>;
  /** Email discovery for a contact (Hunter Email Finder). */
  findEmail?(p: Prospect, contact: Contact, ctx: ProviderCtx): Promise<Provenance | undefined>;
  /** Email verification verdict (Hunter Email Verifier). */
  verifyEmail?(p: Prospect, contact: Contact, ctx: ProviderCtx): Promise<VerificationResult | undefined>;
  /** Phone verification (Google Place Details re-check). */
  verifyPhone?(p: Prospect, contact: Contact, ctx: ProviderCtx): Promise<Provenance | undefined>;
}

/** Capability → method name mapping on ProviderRuntime. */
export const CAPABILITY_METHOD: Record<Capability, keyof ProviderRuntime | null> = {
  discoverCompanies: "discoverCompanies",
  findDecisionMakers: "findDecisionMakers",
  enrichCompany: "enrichCompany",
  findEmail: "findEmail",
  verifyEmail: "verifyEmail",
  verifyPhone: "verifyPhone",
  importRows: "importRows",
};

export function hasCapability(p: ProviderRuntime, cap: Capability): boolean {
  const m = CAPABILITY_METHOD[cap];
  return !!m && typeof (p as unknown as Record<string, unknown>)[m] === "function";
}
