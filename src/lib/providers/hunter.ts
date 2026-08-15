/**
 * Hunter adapter — official Hunter.io API (Email Finder + Email Verifier).
 *
 *   GET https://api.hunter.io/v2/email-finder?domain=..&first_name=..&last_name=..
 *       &api_key=..  → { data: { email, score, verification: { status } } }
 *   GET https://api.hunter.io/v2/email-verifier?email=..&api_key=..
 *       → { data: { result: "deliverable" | "undeliverable" | "risky" | "unknown",
 *                   score } }
 *
 * Verification mapping is honest:
 *   Hunter deliverable/valid          → Verified
 *   Hunter undeliverable/invalid      → Unverified
 *   Hunter risky / accept_all         → Likely (accept-all server, uncertain)
 *   Hunter unknown                    → Unknown
 * No fabrications: when Hunter has no data the field stays Unknown.
 */

import type { Contact, Prospect } from "../types";
import type { Provenance } from "../types";
import type { ProviderRuntime, ProviderCtx, VerificationResult } from "./types";
import { fetchJson, domainOf, now } from "./http";

const BASE = "https://api.hunter.io/v2";

interface HunterEmailFinderData {
  email?: string;
  score?: number;
  first_name?: string;
  last_name?: string;
  verification?: { status?: string; date?: string };
}

interface HunterResponse<T> {
  data?: T;
  errors?: { details?: string[] }[];
}

interface HunterVerifierData {
  status?: string;
  result?: string;
  score?: number;
  regexp?: boolean;
  disposable?: boolean;
  webmail?: boolean;
}

export function makeHunter(apiKey: string, mock: boolean): ProviderRuntime {
  const def: ProviderRuntime["def"] = {
    id: "hunter",
    name: "Hunter",
    kind: "api",
    status: mock ? "mock" : "active",
    capabilities: ["findEmail", "verifyEmail"],
    envKeys: ["HUNTER_API_KEY"],
    description: "Find and verify business email addresses via Hunter's official API. Verified emails are marked Verified; everything else stays honestly unverified/unknown.",
    mock,
  };

  const splitName = (fullName: string) => {
    const parts = fullName.trim().split(/\s+/);
    return { first: parts[0] ?? "", last: parts.length > 1 ? parts[parts.length - 1] : "" };
  };

  const findEmail = async (p: Prospect, contact: Contact, ctx: ProviderCtx): Promise<Provenance | undefined> => {
    ctx.tracker.record("hunter", "findEmail", 1, ctx.mock);
    if (ctx.mock) return undefined;
    const domain = domainOf(p.website?.value);
    if (!domain) return undefined;
    const { first, last } = splitName(contact.fullName.value);
    if (!first && !last) return undefined;
    const url = `${BASE}/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}&type=personal&api_key=${apiKey}`;
    const res = await fetchJson<HunterResponse<HunterEmailFinderData>>(url);
    const data = res?.data;
    if (!data?.email) return undefined;
    const vStatus = data.verification?.status;
    const verificationStatus: Provenance["verificationStatus"] =
      vStatus === "valid" ? "Verified" : vStatus === "invalid" ? "Unverified" : vStatus === "accept_all" ? "Likely" : vStatus === "unknown" ? "Unknown" : "Unverified";
    return {
      value: data.email,
      source: "hunter",
      capturedAt: now(),
      confidence: verificationStatus === "Verified" ? 0.97 : verificationStatus === "Unverified" ? 0.5 : 0.6,
      verificationStatus,
    };
  };

  const verifyEmail = async (_p: Prospect, contact: Contact, ctx: ProviderCtx): Promise<VerificationResult | undefined> => {
    ctx.tracker.record("hunter", "verifyEmail", 1, ctx.mock);
    if (ctx.mock) return undefined;
    const email = contact.email?.value;
    if (!email) return undefined;
    const url = `${BASE}/email-verifier?email=${encodeURIComponent(email)}&api_key=${apiKey}`;
    const res = await fetchJson<HunterResponse<HunterVerifierData>>(url);
    const result = res?.data?.result;
    if (!result) return undefined;
    if (result === "deliverable") return { verdict: "verified", detail: "Hunter verifier: deliverable" };
    if (result === "undeliverable") return { verdict: "unverified", detail: "Hunter verifier: undeliverable" };
    if (result === "risky" || result === "accept_all") return { verdict: "unknown", detail: `Hunter verifier: ${result}` };
    return { verdict: "unknown", detail: `Hunter verifier: ${result}` };
  };

  return { def, findEmail, verifyEmail };
}
