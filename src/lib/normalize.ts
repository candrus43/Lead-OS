/**
 * Normalization + dedupe keys for the "search broad, enrich narrow" gate.
 *
 * Companies are compared by normalized domain first; when no domain exists, by
 * normalized company name + city + state. This is deliberately conservative —
 * a false merge is worse than a missed one, so we never collapse two records
 * unless they share a domain or an exact normalized name in the same place.
 */

import type { Prospect } from "./types";
import { domainOf } from "./providers/http";

const LEGAL_SUFFIXES =
  /\b(llc|l\.l\.c\.|inc|inc\.|incorporated|corp|corp\.|corporation|co|co\.|company|group|grp|ltd|ltd\.|limited|llp|pllc|plc|gmbh|ag|sa|s\.a\.|pvt|pvt\.|private|holdings|holding|hg|lp|partners|partner)\b\.?$/gi;

export function normalizeCompanyName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ") // punctuation → space
      .replace(LEGAL_SUFFIXES, " ") // legal suffixes
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Dedupe key: domain when available, else normalized name + place. */
export function dedupeKey(p: Prospect): string {
  const domain = domainOf(p.website?.value);
  if (domain) return `d:${domain}`;
  const name = normalizeCompanyName(p.companyName.value);
  const place = `${p.location.value.city ?? ""}|${p.location.value.state ?? ""}|${p.location.value.country ?? ""}`.toLowerCase();
  return `n:${name}#${place}`;
}

/** Does the prospect already carry verified-enough contact data to skip enrichment? */
export function hasVerifiedEnrichment(p: Prospect): boolean {
  const primary = p.contacts.find((c) => c.isPrimary) ?? p.contacts[0];
  const emailOk = !!primary?.email && primary.email.verificationStatus === "Verified";
  const phoneOk =
    !!primary?.phone &&
    (primary.phone.verificationStatus === "Verified" || primary.phone.verificationStatus === "High Confidence");
  const companyOk =
    !!p.employees &&
    !!p.revenue &&
    (p.employees.verificationStatus === "Verified" ||
      p.employees.verificationStatus === "High Confidence" ||
      p.employees.verificationStatus === "Likely") &&
    (p.revenue.verificationStatus === "Verified" ||
      p.revenue.verificationStatus === "High Confidence" ||
      p.revenue.verificationStatus === "Likely");
  return emailOk && phoneOk && companyOk;
}
