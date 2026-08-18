/**
 * Server functions for enrichment + discovery.
 *
 * Providers hold their keys in server env; the client never sees them. The
 * client sends scored prospects + cost rules (or search filters for discovery)
 * and receives enriched prospects + a usage/cost report. Mock mode is enabled
 * by ENABLE_PROVIDER_MOCKS=true (server) or the Settings "Dry run" switch
 * (passed in the payload).
 */

import { createServerFn } from "@tanstack/react-start";
import type { Prospect, SearchFilters } from "./types";
import type { CostRules } from "./fitScore";
import { runWaterfall, type EnrichmentRunReport } from "./enrich";
import { buildRegistry, hasCapability, isProviderUsable } from "./providers";
import { UsageTracker } from "./providers/costs";
import type { UsageEntry } from "./providers/costs";
import { mockCall } from "./providers/mocks";

const envMock = () => process.env.ENABLE_PROVIDER_MOCKS === "true";

export interface DiscoveryResult {
  prospects: Prospect[];
  usage: UsageEntry[];
  mock: boolean;
  /** Descriptive per-provider failures (e.g. "Google Places: REQUEST_DENIED — …"). */
  providerErrors: string[];
  /** Provider ids that actually ran a real discovery call (survived gating). */
  providersAttempted: string[];
}

export const discoverFromProviders = createServerFn({ method: "POST" })
  .validator((d: { filters: SearchFilters; mock: boolean }) => d)
  .handler(async ({ data }): Promise<DiscoveryResult> => {
    const mock = data.mock || envMock();
    const registry = buildRegistry(process.env, mock);
    const byId = new Map(registry.map((r) => [r.def.id, r]));
    const tracker = new UsageTracker(process.env);
    const out: Prospect[] = [];
    const providerErrors: string[] = [];
    const providersAttempted: string[] = [];
    for (const id of ["google-places", "apollo"]) {
      const p = byId.get(id);
      if (!p) continue;
      if (mock) {
        const res = await mockCall(id, "discoverCompanies", [data.filters], { mock: true, tracker });
        if (Array.isArray(res)) out.push(...(res as Prospect[]));
        continue;
      }
      if (p.def.status !== "active" || !isProviderUsable(p.def) || !hasCapability(p, "discoverCompanies")) continue;
      providersAttempted.push(id);
      try {
        const res = await p.discoverCompanies!(data.filters, { mock: false, tracker });
        if (res?.length) out.push(...res);
      } catch (e) {
        // graceful degradation — discovery failure never breaks the run, but the
        // caller is told exactly which provider failed and why (no keys leaked).
        providerErrors.push(e instanceof Error ? e.message : `${p.def.name}: discovery error`);
      }
    }
    return { prospects: out, usage: tracker.list(), mock, providerErrors, providersAttempted };
  });

export const runEnrichment = createServerFn({ method: "POST" })
  .validator((d: { prospects: Prospect[]; rules: CostRules; mock: boolean; skipIds: string[] }) => d)
  .handler(async ({ data }): Promise<EnrichmentRunReport> => {
    const mock = data.mock || envMock();
    return runWaterfall(data.prospects, {
      rules: data.rules,
      mock,
      skipIds: new Set(data.skipIds),
      env: process.env,
    });
  });
