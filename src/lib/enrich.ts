/**
 * Enrichment waterfall — "search broad, enrich narrow".
 *
 * Given already-scored, rank-filtered prospects, this runs the cheapest useful
 * providers first and stops when enough verified data exists:
 *
 *   1. Google Places Place Details (cheap/free first pass): phone, website,
 *      location + place verification (High Confidence).
 *   2. Company enrichment (PDL preferred, Apollo fallback): employees, revenue,
 *      industry, description — provider estimates stay "Likely".
 *   3. Decision-maker discovery (Apollo preferred, PDL fallback): names/titles.
 *   4. Email discovery (Hunter preferred, Apollo fallback).
 *   5. Email verification (Hunter) — only above onlyVerifyEmailAboveFit.
 *   6. Phone verification (Google re-check) — only above onlyEnrichPhoneAboveFit.
 *
 * Gates before a single paid call:
 *   - fit < onlyEnrichCompanyAboveFit → untouched (never enriched).
 *   - duplicate company (normalized domain or name+place) within the run → skip.
 *   - already enriched with verified contact data (or already in this run) → skip.
 *   - sample/fictional prospects are NEVER sent to real (paid) providers; they
 *     are only enriched in mock (dry-run) mode so the flow can be demoed.
 *   - maxEnrichPerRun caps total calls; when exhausted the run stops.
 *
 * Server-side only (providers read env keys there). The client passes prospects
 * + cost rules; the server returns enriched prospects + a usage report.
 */

import type { Contact, Prospect, Provenance } from "./types";
import { computeFit, DEFAULT_COST_RULES, type CostRules } from "./fitScore";
import { buildRegistry, hasCapability, CAPABILITY_METHOD, isProviderUsable } from "./providers";
import { UsageTracker, costFor } from "./providers/costs";
import { mockCall } from "./providers/mocks";
import type { Capability, CompanyEnrichment, VerificationResult } from "./providers/types";
import { dedupeKey, hasVerifiedEnrichment } from "./normalize";
import { domainOf, now } from "./providers/http";

export interface EnrichmentStep {
  provider: string;
  capability: Capability;
  cost: number; // estimated USD for this call
  outcome: "ok" | "skip" | "error" | "mock";
  note?: string;
}

export interface EnrichedProspect {
  prospect: Prospect; // enriched copy
  cost: number; // estimated USD spent enriching this prospect
  steps: EnrichmentStep[];
  mock: boolean;
  enrichedAt: string;
  reason: "enriched" | "skipped";
  skipReason?: string;
}

export interface WaterfallOptions {
  rules: CostRules;
  mock: boolean;
  /** prospect ids already enriched in a previous run (dedupe) */
  skipIds?: ReadonlySet<string>;
  env?: Record<string, string | undefined>;
  /**
   * Shared usage tracker — lets a bulk run enforce maxEnrichPerRun across many
   * waterfall invocations (one tracker per run instead of one per call).
   */
  tracker?: UsageTracker;
}

export interface EnrichmentRunReport {
  prospects: EnrichedProspect[];
  usage: ReturnType<UsageTracker["list"]>;
  totalCalls: number;
  totalCost: number;
  enrichedCount: number;
  skippedCount: number;
  stoppedReason?: string;
  mock: boolean;
  ranAt: string;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function step(provider: string, capability: Capability, outcome: EnrichmentStep["outcome"], note: string, env: Record<string, string | undefined>): EnrichmentStep {
  return { provider, capability, cost: costFor(provider, capability, env), outcome, note };
}

/** Merge a provider's company enrichment into the prospect (never downgrade a field). */
function applyCompanyEnrichment(working: Prospect, enc: CompanyEnrichment): string[] {
  const notes: string[] = [];
  const setIfBetter = <T>(key: "employees" | "revenue" | "industry" | "subIndustry" | "description" | "website", incoming: Provenance<T> | undefined) => {
    if (!incoming) return;
    const existing = working[key] as Provenance | undefined;
    if (!existing || (incoming.verificationStatus === "High Confidence" || incoming.verificationStatus === "Verified")) {
      (working as unknown as Record<string, unknown>)[key] = incoming;
      notes.push(`${key} → ${String(incoming.value).slice(0, 40)}`);
    }
  };
  setIfBetter("employees", enc.employees);
  setIfBetter("revenue", enc.revenue);
  setIfBetter("industry", enc.industry);
  setIfBetter("subIndustry", enc.subIndustry);
  setIfBetter("description", enc.description);
  setIfBetter("website", enc.website);
  if (enc.location) {
    const existing = working.location;
    if (!existing || !existing.value.city || !existing.value.state) {
      working.location = enc.location;
      notes.push(`location → ${enc.location.value.city}, ${enc.location.value.state}`);
    }
  }
  if (enc.signals) {
    const sig = working.signals;
    for (const [k, v] of Object.entries(enc.signals)) {
      if (v) (sig as unknown as Record<string, boolean>)[k] = true;
    }
    notes.push("signals updated");
  }
  if (enc.phone) {
    const primary = working.contacts.find((c) => c.isPrimary) ?? working.contacts[0];
    if (primary) {
      if (!primary.phone || primary.phone.verificationStatus === "Unknown" || primary.phone.verificationStatus === "Unverified") {
        primary.phone = enc.phone;
      }
    } else {
      working.contacts.push({
        id: `${working.id}-phone`,
        fullName: { value: "Unknown", source: enc.phone.source, capturedAt: now(), confidence: 0, verificationStatus: "Unknown" },
        title: { value: "Unknown", source: enc.phone.source, capturedAt: now(), confidence: 0, verificationStatus: "Unknown" },
        phone: enc.phone,
        isPrimary: true,
      });
    }
    notes.push(`phone → ${enc.phone.value.slice(0, 24)}`);
  }
  return notes;
}

/** Append decision-makers, keeping existing contacts and a single primary. */
function mergeContacts(working: Prospect, contacts: Contact[]): number {
  const existingEmails = new Set(working.contacts.map((c) => c.email?.value).filter(Boolean));
  const existingNames = new Set(working.contacts.map((c) => c.fullName.value.toLowerCase()));
  let added = 0;
  for (const c of contacts) {
    const dup = (c.email?.value && existingEmails.has(c.email.value)) || existingNames.has(c.fullName.value.toLowerCase());
    if (dup) continue;
    working.contacts.push(c);
    existingEmails.add(c.email?.value ?? "");
    existingNames.add(c.fullName.value.toLowerCase());
    added++;
  }
  if (working.contacts.length && !working.contacts.some((c) => c.isPrimary)) {
    working.contacts[0].isPrimary = true;
  }
  return added;
}

export async function runWaterfall(input: Prospect[], opts: WaterfallOptions): Promise<EnrichmentRunReport> {
  const env = opts.env ?? process.env;
  const rules = { ...DEFAULT_COST_RULES, ...opts.rules };
  const maxCalls = Math.max(0, rules.maxEnrichPerRun);
  const mock = opts.mock;
  const skipIds = opts.skipIds ?? new Set<string>();
  const registry = buildRegistry(env, mock);
  const byId = new Map(registry.map((r) => [r.def.id, r]));
  const tracker = opts.tracker ?? new UsageTracker(env);
  const seenKeys = new Set<string>();
  const results: EnrichedProspect[] = [];
  let stoppedReason: string | undefined;

  const budgetLeft = () => tracker.totalCalls() < maxCalls;
  const guard = (): boolean => {
    if (stoppedReason) return false;
    if (!budgetLeft()) {
      stoppedReason = `maxEnrichPerRun (${maxCalls}) reached`;
      return false;
    }
    return true;
  };

  const canUse = (id: string, cap: Capability): boolean => {
    if (mock) return true; // mock dispatch covers every provider
    const p = byId.get(id);
    return !!p && p.def.status === "active" && isProviderUsable(p.def) && hasCapability(p, cap);
  };

  const callProvider = async (id: string, cap: Capability, args: unknown[]): Promise<unknown> => {
    if (!guard()) return undefined;
    if (mock) return mockCall(id, cap, args, { mock: true, tracker });
    const p = byId.get(id);
    if (!p) return undefined;
    const method = CAPABILITY_METHOD[cap];
    if (!method) return undefined;
    const m = p[method];
    if (typeof m !== "function") return undefined;
    try {
      // Providers expect (…args, ctx); the waterfall previously called them
      // without ctx, which silently broke real (non-mock) provider calls.
      return await (m as (...a: unknown[]) => Promise<unknown>).apply(p, [...args, { mock, tracker }]);
    } catch {
      return undefined;
    }
  };

  for (const raw of input) {
    if (stoppedReason) {
      results.push({ prospect: raw, cost: 0, steps: [], mock, enrichedAt: now(), reason: "skipped", skipReason: stoppedReason });
      continue;
    }
    const p: Prospect = { ...raw, fit: raw.fit ?? computeFit(raw) };
    const score = p.fit!.score;

    const skip = (reason: string): void => {
      results.push({ prospect: raw, cost: 0, steps: [], mock, enrichedAt: now(), reason: "skipped", skipReason: reason });
    };

    // Gate 1 — already enriched in a previous run (dedupe across runs)
    if (skipIds.has(p.id)) {
      skip("already enriched this run");
      continue;
    }
    // Gate 2 — fictional sample data never hits real (paid) providers
    if (p.isSample && !mock) {
      skip("sample data (fictional) — excluded from paid enrichment");
      continue;
    }
    // Gate 3 — the core cost rule: low-fit prospects are never enriched
    if (score < rules.onlyEnrichCompanyAboveFit) {
      skip(`fit ${score} < ${rules.onlyEnrichCompanyAboveFit} (onlyEnrichCompanyAboveFit)`);
      continue;
    }
    // Gate 4 — dedupe within the run (normalized domain, else name+place)
    const key = dedupeKey(p);
    if (seenKeys.has(key)) {
      skip(`duplicate of an earlier record (${key.slice(0, 60)})`);
      continue;
    }
    seenKeys.add(key);
    // Gate 5 — already has verified contact data → nothing more to buy
    if (hasVerifiedEnrichment(p)) {
      skip("already enriched with verified contact data");
      continue;
    }

    const working = clone(p);
    const steps: EnrichmentStep[] = [];
    let cost = 0;
    const phoneEnrichable = score >= rules.onlyEnrichPhoneAboveFit;
    const emailVerifyable = score >= rules.onlyVerifyEmailAboveFit;

    // ---- Stage 1: Google Places — cheap/free first pass (phone, website, location)
    if (guard() && canUse("google-places", "enrichCompany")) {
      const enc = (await callProvider("google-places", "enrichCompany", [working])) as CompanyEnrichment | undefined;
      if (enc) {
        const notes = applyCompanyEnrichment(working, enc);
        steps.push(step("google-places", "enrichCompany", mock ? "mock" : "ok", `place details: ${notes.join(", ") || "fields merged"}`, env));
        cost += costFor("google-places", "enrichCompany", env);
        const primary = working.contacts.find((c) => c.isPrimary) ?? working.contacts[0];
        if (phoneEnrichable && primary?.phone) {
          steps.push({ provider: "google-places", capability: "verifyPhone", cost: 0, outcome: mock ? "mock" : "ok", note: "phone from Place Details — High Confidence" });
        }
      } else {
        steps.push(step("google-places", "enrichCompany", "error", "no place found — fields stay Unknown", env));
      }
    }

    // ---- Stage 2: company enrichment — PDL preferred, Apollo fallback
    if (guard()) {
      const companyProv = canUse("pdl", "enrichCompany") ? "pdl" : canUse("apollo", "enrichCompany") ? "apollo" : undefined;
      if (companyProv) {
        const enc = (await callProvider(companyProv, "enrichCompany", [working])) as CompanyEnrichment | undefined;
        if (enc) {
          const notes = applyCompanyEnrichment(working, enc);
          steps.push(step(companyProv, "enrichCompany", mock ? "mock" : "ok", notes.join(", ") || "company data merged", env));
          cost += costFor(companyProv, "enrichCompany", env);
        } else {
          steps.push(step(companyProv, "enrichCompany", "error", "no result — estimates stay Unknown", env));
        }
      }
    }

    // ---- Stage 3: decision makers — Apollo preferred, PDL fallback
    if (guard()) {
      const dmProv = canUse("apollo", "findDecisionMakers") ? "apollo" : canUse("pdl", "findDecisionMakers") ? "pdl" : undefined;
      if (dmProv) {
        const contacts = (await callProvider(dmProv, "findDecisionMakers", [working])) as Contact[] | undefined;
        if (contacts?.length) {
          const added = mergeContacts(working, contacts);
          steps.push(step(dmProv, "findDecisionMakers", mock ? "mock" : "ok", `${added} decision maker${added === 1 ? "" : "s"} added`, env));
          cost += costFor(dmProv, "findDecisionMakers", env);
        } else {
          steps.push(step(dmProv, "findDecisionMakers", "error", "no contacts found", env));
        }
      }
    }

    // ---- Stage 4: email discovery — Hunter preferred, Apollo fallback
    if (guard()) {
      const primary = working.contacts.find((c) => c.isPrimary) ?? working.contacts[0];
      const domain = domainOf(working.website?.value);
      if (primary && !primary.email && domain) {
        const emailProv = canUse("hunter", "findEmail") ? "hunter" : canUse("apollo", "findEmail") ? "apollo" : undefined;
        if (emailProv) {
          const em = (await callProvider(emailProv, "findEmail", [working, primary])) as Provenance | undefined;
          if (em) {
            primary.email = em;
            steps.push(step(emailProv, "findEmail", mock ? "mock" : "ok", `email found: ${em.value}`, env));
            cost += costFor(emailProv, "findEmail", env);
          } else {
            steps.push(step(emailProv, "findEmail", "error", "no email found", env));
          }
        }
      }
    }

    // ---- Stage 5: email verification — Hunter, gated by onlyVerifyEmailAboveFit
    if (guard() && emailVerifyable) {
      const primary = working.contacts.find((c) => c.isPrimary) ?? working.contacts[0];
      if (primary?.email && canUse("hunter", "verifyEmail")) {
        const v = (await callProvider("hunter", "verifyEmail", [working, primary])) as VerificationResult | undefined;
        if (v) {
          const status: Provenance["verificationStatus"] =
            v.verdict === "verified" ? "Verified" : v.verdict === "unverified" ? "Unverified" : "Unknown";
          primary.email = { ...primary.email, verificationStatus: status, confidence: v.verdict === "verified" ? 0.97 : primary.email.confidence };
          steps.push(step("hunter", "verifyEmail", mock ? "mock" : "ok", v.detail, env));
          cost += costFor("hunter", "verifyEmail", env);
        } else {
          steps.push(step("hunter", "verifyEmail", "error", "verifier returned nothing", env));
        }
      }
    }

    // ---- Stage 6: phone verification — Google re-check, gated by onlyEnrichPhoneAboveFit
    if (guard() && phoneEnrichable) {
      const primary = working.contacts.find((c) => c.isPrimary) ?? working.contacts[0];
      if (primary?.phone && canUse("google-places", "verifyPhone")) {
        const ph = (await callProvider("google-places", "verifyPhone", [working, primary])) as Provenance | undefined;
        if (ph) {
          primary.phone = ph;
          steps.push(step("google-places", "verifyPhone", mock ? "mock" : "ok", "phone re-confirmed via Place Details", env));
          cost += costFor("google-places", "verifyPhone", env);
        }
      }
    }

    // ---- Stop-after-verified: enough verified data → nothing else to buy
    if (guard()) {
      const primary = working.contacts.find((c) => c.isPrimary) ?? working.contacts[0];
      if (primary?.email?.verificationStatus === "Verified" && primary.phone && working.employees && working.revenue) {
        steps.push({ provider: "—", capability: "verifyEmail", cost: 0, outcome: "skip", note: "sufficient verified data — enrichment complete" });
      }
    }

    results.push({ prospect: working, cost, steps, mock, enrichedAt: now(), reason: "enriched" });
  }

  if (!stoppedReason && !budgetLeft()) stoppedReason = `maxEnrichPerRun (${maxCalls}) reached`;

  return {
    prospects: results,
    usage: tracker.list(),
    totalCalls: tracker.totalCalls(),
    totalCost: tracker.totalCost(),
    enrichedCount: results.filter((r) => r.reason === "enriched").length,
    skippedCount: results.filter((r) => r.reason === "skipped").length,
    stoppedReason,
    mock,
    ranAt: now(),
  };
}

/** Overlay an enriched copy onto the original prospect for display. */
export function mergeEnriched(p: Prospect, ep: EnrichedProspect | undefined): Prospect {
  if (!ep) return p;
  return { ...ep.prospect, id: p.id, fit: p.fit ?? ep.prospect.fit };
}

export function formatCost(cost: number): string {
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}
