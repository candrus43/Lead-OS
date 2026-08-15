/**
 * Client-side helpers for closed-deal data — won/closed overlays on prospects
 * and outcome insights. Fetches the persisted collection once per page via the
 * getClosedDeals server fn; the lookup helpers are pure.
 *
 * normalizeDomain mirrors the server's version in src/lib/webhook.ts (kept here
 * so the client never imports the server-only module).
 */

import { useEffect, useMemo, useState } from "react";
import { getClosedDeals } from "./webhookServer";
import type { ClosedDealRecord, ClosedDealsSummary } from "./webhook";

export function normalizeDomain(input: string | null | undefined): string {
  if (!input) return "";
  let d = String(input).trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  d = d.split(/[/?#]/)[0];
  d = d.replace(/^www\./, "");
  d = d.replace(/\.$/, "");
  return d.trim();
}

export interface ClosedDealLookup {
  byProspectId: Map<string, ClosedDealRecord>;
  byDomain: Map<string, ClosedDealRecord>;
  byName: Map<string, ClosedDealRecord>;
}

const emptyLookup: ClosedDealLookup = { byProspectId: new Map(), byDomain: new Map(), byName: new Map() };

export function buildLookup(records: ClosedDealRecord[]): ClosedDealLookup {
  const byProspectId = new Map<string, ClosedDealRecord>();
  const byDomain = new Map<string, ClosedDealRecord>();
  const byName = new Map<string, ClosedDealRecord>();
  for (const r of records) {
    if (r.prospectId) byProspectId.set(r.prospectId, r);
    const dom = normalizeDomain(r.fields.companyDomain?.value);
    if (dom && !byDomain.has(dom)) byDomain.set(dom, r);
    const web = normalizeDomain(r.fields.companyWebsite?.value);
    if (web && !byDomain.has(web)) byDomain.set(web, r);
    const nm = r.fields.companyName?.value.trim().toLowerCase();
    if (nm && !byName.has(nm)) byName.set(nm, r);
  }
  return { byProspectId, byDomain, byName };
}

/** The closed deal tied to a prospect, if any (id → domain → name). */
export function dealForProspect(
  p: { id: string; companyName: { value: string }; website?: { value?: string } },
  lookup: ClosedDealLookup
): ClosedDealRecord | undefined {
  const byId = lookup.byProspectId.get(p.id);
  if (byId) return byId;
  if (p.website?.value) {
    const d = normalizeDomain(p.website.value);
    const hit = lookup.byDomain.get(d);
    if (hit) return hit;
  }
  return lookup.byName.get(p.companyName.value.trim().toLowerCase());
}

export function formatDealValue(r: ClosedDealRecord | undefined): string {
  if (!r?.fields.dealValue) return "";
  const v = r.fields.dealValue.value;
  const cur = r.fields.currency?.value ?? "";
  const symbol = cur.toUpperCase() === "USD" || cur.toUpperCase() === "US" ? "$" : cur ? `${cur} ` : "";
  return `${symbol}${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export interface ClosedDealData {
  records: ClosedDealRecord[];
  summary: ClosedDealsSummary | null;
  lookup: ClosedDealLookup;
  loaded: boolean;
}

/** Fetch the closed-deals collection once per page (silent failure — overlays
 *  are progressive enhancement; core stats never depend on this). */
export function useClosedDeals(): ClosedDealData {
  const [data, setData] = useState<{ records: ClosedDealRecord[]; summary: ClosedDealsSummary } | null>(null);
  useEffect(() => {
    let alive = true;
    getClosedDeals()
      .then((r) => {
        if (alive) setData(r);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const lookup = useMemo(() => (data ? buildLookup(data.records) : emptyLookup), [data]);
  return { records: data?.records ?? [], summary: data?.summary ?? null, lookup, loaded: !!data };
}
