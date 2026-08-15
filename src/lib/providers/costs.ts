/**
 * Per-provider cost model + usage tracker.
 *
 * Defaults are sensible estimates from public pricing (USD per API call):
 *   - Google Places:  Text Search ~$0.032, Place Details ~$0.017 (Google Maps
 *     Platform pricing, "Essentials" SKUs).
 *   - Hunter:         Email Finder ~$0.05/call, Email Verifier ~$0.01/call
 *     (Hunter plans range ~$0.04–$0.15 and ~$0.008–$0.02 per call depending on
 *     tier — defaults sit at the low end).
 *   - People Data Labs: person search/enrich ~$0.025, company enrich ~$0.05.
 *   - Apollo:         ~1 credit per call ≈ $0.01 (credit packs roughly $0.005–
 *                     $0.015/credit).
 *
 * Costs are estimates for planning, never actual billing. No money moves unless
 * a key is configured; every value can be overridden per-env via
 * COST_<PROVIDER>_<CAPABILITY> (e.g. COST_HUNTER_FINDEMAIL=0.12).
 */

import type { Capability } from "./types";

export interface UsageEntry {
  provider: string;
  capability: Capability;
  calls: number;
  cost: number; // estimated USD
  mock: boolean;
}

const DEFAULT_COSTS: Record<string, Partial<Record<Capability, number>>> = {
  "google-places": { discoverCompanies: 0.032, enrichCompany: 0.017, verifyPhone: 0.017 },
  hunter: { findEmail: 0.05, verifyEmail: 0.01 },
  pdl: { enrichCompany: 0.05, findDecisionMakers: 0.025 },
  apollo: { discoverCompanies: 0.01, enrichCompany: 0.01, findDecisionMakers: 0.01, findEmail: 0.01 },
};

function envKey(provider: string, capability: Capability): string {
  return `COST_${provider.replace(/-/g, "_").toUpperCase()}_${capability.toUpperCase()}`;
}

export function costFor(provider: string, capability: Capability, env: Record<string, string | undefined> = process.env): number {
  const override = env[envKey(provider, capability)];
  if (override !== undefined) {
    const n = Number(override);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_COSTS[provider]?.[capability] ?? 0;
}

export class UsageTracker {
  private entries = new Map<string, UsageEntry>();
  private env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.env = env;
  }

  /** Record `calls` (default 1) API calls for a provider capability. */
  record(provider: string, capability: Capability, calls = 1, mock = false): void {
    const key = `${provider}:${capability}`;
    const cost = costFor(provider, capability, this.env) * calls;
    const existing = this.entries.get(key);
    if (existing) {
      existing.calls += calls;
      existing.cost += cost;
    } else {
      this.entries.set(key, { provider, capability, calls, cost, mock });
    }
  }

  list(): UsageEntry[] {
    return [...this.entries.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  }

  totalCalls(): number {
    return this.list().reduce((a, e) => a + e.calls, 0);
  }

  totalCost(): number {
    return this.list().reduce((a, e) => a + e.cost, 0);
  }
}

export const PROVIDER_COST_KEYS = [
  "COST_GOOGLE_PLACES_DISCOVERCOMPANIES",
  "COST_GOOGLE_PLACES_ENRICHCOMPANY",
  "COST_GOOGLE_PLACES_VERIFYPHONE",
  "COST_HUNTER_FINDEMAIL",
  "COST_HUNTER_VERIFYEMAIL",
  "COST_PDL_ENRICHCOMPANY",
  "COST_PDL_FINDDECISIONMAKERS",
  "COST_APOLLO_DISCOVERCOMPANIES",
  "COST_APOLLO_ENRICHCOMPANY",
  "COST_APOLLO_FINDDECISIONMAKERS",
  "COST_APOLLO_FINDEMAIL",
];

/** Default per-call cost map (for display in the UI). */
export function defaultCostMap(): Record<string, Partial<Record<Capability, number>>> {
  return Object.fromEntries(
    Object.entries(DEFAULT_COSTS).map(([k, v]) => [k, { ...v }])
  ) as Record<string, Partial<Record<Capability, number>>>;
}
