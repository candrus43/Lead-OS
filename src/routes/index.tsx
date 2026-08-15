/**
 * Intelligence Dashboard — "the 10 companies I should contact today".
 *
 * Every metric here is computed from ACTUAL store data (imported prospects,
 * live enrichment copies). Where data does not exist yet (CRM outcomes:
 * meetings, demos, trials, customers, pipeline value) the UI shows an honest
 * 0 / "—" with a hint — nothing is ever invented.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Badge, Card, ContactabilityPill, FitBadge, Icon, SectionHead, StatusPill } from "~/components/ui";
import { useAuth } from "~/components/AuthGate";
import { getImportedProspects, getSavedSearches, getEnrichedMap, getCategoryMap } from "~/lib/store";
import { getRuntimeConfig, type RuntimeConfig } from "~/lib/runtime";
import { contactabilityOf, shortLocation } from "~/lib/types";
import type { Prospect, Signals, VerificationStatus } from "~/lib/types";
import { CATEGORY_BY_ID, fullCatalog, labelOf, categoriesFor } from "~/lib/categories";
import { scoredPool, type ScoredProspect } from "~/lib/lists";
import { useClosedDeals, dealForProspect, formatDealValue } from "~/lib/webhookClient";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

/* ------------------------------ helpers ----------------------------------- */

const VERIFIED_CONTACT = (p: ScoredProspect) =>
  p.contacts.some((c) => c.email?.verificationStatus === "Verified" || c.phone?.verificationStatus === "Verified");

/** Currency-aware value label for the outcome card (real webhook data). */
function formatCurrency(n: number, currencies: string[]): string {
  const c = currencies.length === 1 ? currencies[0] : "";
  const symbol = c === "USD" ? "$" : c ? `${c} ` : "";
  const suffix = currencies.length > 1 ? " (mixed)" : "";
  return `${symbol}${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
}

function bestContactStatus(p: Prospect): VerificationStatus {
  const statuses = p.contacts
    .flatMap((c) => [c.email?.verificationStatus, c.phone?.verificationStatus])
    .filter(Boolean) as VerificationStatus[];
  const order: VerificationStatus[] = ["Verified", "High Confidence", "Likely", "Unverified", "Unknown"];
  for (const s of order) if (statuses.includes(s)) return s;
  return "Unknown";
}

/** One-line "why now" — heuristic from the prospect's own signals. Illustrative. */
function whyNow(p: ScoredProspect): string {
  const s = p.signals;
  if (s.growthRate && s.acquisitionActivity) return "Recent growth + M&A — manual processes are behind";
  if (s.constructionActivity && s.projectVolume) return "Multiple active projects — document volume is rising";
  if (s.hospitalityOperations && s.multipleLocations) return "Multi-site hospitality — high coordination overhead";
  if (s.creActivity && s.portfolioOwnership) return "Active portfolio — asset-level visibility gap";
  if (s.documentBurden && s.projectVolume) return "Heavy contract/document load across projects";
  if (s.spreadsheetHeavy && s.disconnectedSoftware) return "Disconnected spreadsheets — prime automation target";
  if (s.multipleEntities && s.operationalComplexity) return "Multi-entity complexity — reporting strain";
  if (s.growthRate) return "Growing fast — processes haven't caught up";
  const top = p.fit.reasons[0];
  return top ? `Key signal: ${top.label.toLowerCase()}` : "Strong fit — worth a conversation";
}

interface Insight {
  title: string;
  body: string;
}

/** Heuristic observations from real fields. Labeled illustrative, never causal. */
function computeInsights(pool: ScoredProspect[]): Insight[] {
  const n = pool.length;
  if (n < 3) return [];
  const avg = pool.reduce((a, p) => a + p.fit.score, 0) / n;
  const avgOf = (ps: ScoredProspect[]) => (ps.length ? ps.reduce((a, p) => a + p.fit.score, 0) / ps.length : 0);
  const out: { title: string; body: string; diff: number }[] = [];

  const byInd = new Map<string, ScoredProspect[]>();
  for (const p of pool) byInd.set(p.industry.value, [...(byInd.get(p.industry.value) ?? []), p]);
  for (const [ind, ps] of byInd) {
    if (ps.length < 2) continue;
    const a = avgOf(ps);
    if (Math.abs(a - avg) >= 6) {
      out.push({
        diff: Math.abs(a - avg),
        title: `${ind} runs ${a >= avg ? "hotter" : "colder"} than the pool`,
        body: `${ps.length} ${ind} prospect${ps.length === 1 ? "" : "s"} average fit ${Math.round(a)} vs ${Math.round(avg)} overall.`,
      });
    }
  }

  const splits: [keyof Signals, string][] = [
    ["multipleLocations", "multi-location"],
    ["hospitalityOperations", "hospitality operations"],
    ["growthRate", "fast-growing"],
    ["constructionActivity", "construction-active"],
    ["multipleEntities", "multi-entity"],
  ];
  for (const [sig, label] of splits) {
    const yes = pool.filter((p) => p.signals[sig]);
    const no = pool.filter((p) => !p.signals[sig]);
    if (yes.length >= 2 && no.length >= 2) {
      const a = avgOf(yes);
      const b = avgOf(no);
      if (Math.abs(a - b) >= 6) {
        out.push({
          diff: Math.abs(a - b),
          title: `${label} prospects skew ${a >= b ? "higher" : "lower"}-fit`,
          body: `Companies with ${label} signal average ${Math.round(a)} vs ${Math.round(b)} without it — an observed correlation in current data, not a claim about outcomes.`,
        });
      }
    }
  }

  const highFit = pool.filter((p) => p.fit.score >= 75);
  const verifiedHigh = highFit.filter(VERIFIED_CONTACT);
  if (highFit.length >= 3) {
    out.push({
      diff: 5,
      title: "Verified contacts are the bottleneck to outreach",
      body: `${verifiedHigh.length} of ${highFit.length} high-fit prospects have a verified contact — the enrichment waterfall exists to close exactly this gap.`,
    });
  }

  out.sort((a, b) => b.diff - a.diff);
  return out.slice(0, 3).map(({ title, body }) => ({ title, body }));
}

/* ------------------------------ component --------------------------------- */

function Dashboard() {
  const { session } = useAuth();
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null);
  const closed = useClosedDeals();
  const [bannerDismissed, setBannerDismissed] = useState(() => {
    try {
      return localStorage.getItem("op-leados-auth-banner-dismissed") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    getRuntimeConfig().then(setCfg).catch(() => null);
  }, []);

  const data = useMemo(() => {
    const pool = scoredPool();
    const now = Date.now();
    const DAY = 86_400_000;
    const imported = getImportedProspects();
    const enriched = getEnrichedMap();
    const categoryMap = getCategoryMap();

    const new7d = pool.filter((p) => now - new Date(p.importedAt).getTime() < 7 * DAY).length;
    const highFit = pool.filter((p) => p.fit.score >= 75).length;
    const verifiedContacts = pool.filter(VERIFIED_CONTACT).length;
    const ready = pool.filter((p) => p.fit.score >= 75 && VERIFIED_CONTACT(p)).length;

    // Fit-score distribution buckets (real scores only)
    const buckets = [
      { label: "75–100", count: pool.filter((p) => p.fit.score >= 75).length, cls: "from-emerald-400 to-success" },
      { label: "50–74", count: pool.filter((p) => p.fit.score >= 50 && p.fit.score < 75).length, cls: "from-accent-light to-accent" },
      { label: "25–49", count: pool.filter((p) => p.fit.score >= 25 && p.fit.score < 50).length, cls: "from-warn to-amber-400" },
      { label: "0–24", count: pool.filter((p) => p.fit.score < 25).length, cls: "from-muted to-muted" },
    ];

    // Category breakdown — auto + manual, from real data
    const catCounts = new Map<string, number>();
    for (const p of pool) {
      const cats = categoriesFor(p, p.fit, categoryMap);
      for (const id of cats.all) catCounts.set(id, (catCounts.get(id) ?? 0) + 1);
    }
    const catalogIds = fullCatalog().map((c) => c.id);
    const categoryBreakdown = catalogIds
      .map((id) => ({ id, label: labelOf(id), count: catCounts.get(id) ?? 0, auto: !!CATEGORY_BY_ID[id]?.auto }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    const best10 = pool
      .filter((p) => p.fit.score >= 75)
      .sort((a, b) => b.fit.score - a.fit.score)
      .slice(0, 10);

    // Real count of prospects pushed to the Operion CRM (persisted crmDealId).
    const sentToCrm = pool.filter((p) => (getEnrichedMap()[p.id]?.prospect ?? p).crmDealId).length;

    return {
      pool,
      total: pool.length,
      new7d,
      highFit,
      verifiedContacts,
      ready,
      buckets,
      categoryBreakdown,
      best10,
      enrichedCount: Object.keys(enriched).length,
      importedCount: imported.length,
      sentToCrm,
      insights: computeInsights(pool),
      savedSearches: getSavedSearches(),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeProviders = cfg?.providers.filter((p) => p.status === "active").length ?? 1;

  /** Slim stat strip — one line of headline numbers. Detailed sub-notes live in
   *  the strip footer and on the prospect pages. */
  const strip: { label: string; value: string | number; zero?: boolean }[] = [
    { label: "Total prospects", value: data.total },
    { label: "New last 7 days", value: data.new7d },
    { label: "High-fit (≥ 75)", value: data.highFit },
    { label: "Verified contacts", value: data.verifiedContacts },
    { label: "Ready for outreach", value: data.ready },
    { label: "Sent to CRM", value: data.sentToCrm, zero: data.sentToCrm === 0 },
  ];

  return (
    <div className="space-y-8">
      <SectionHead
        eyebrow="Intelligence Dashboard"
        title="The 10 companies I should contact today"
        desc="Ranked from your real prospect pool — every company here came from your CSV imports, provider discovery, or website intelligence. Nothing is fabricated."
        right={<Badge variant="green"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> {activeProviders} data provider{activeProviders === 1 ? "" : "s"} active</Badge>}
      />

      {/* Open mode notice — visible only while no auth passwords are configured */}
      {session && !session.authConfigured && !bannerDismissed && (
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-warn/30 bg-warn/10 px-4 py-2.5">
          <p className="flex items-center gap-2.5 text-xs text-warn">
            <Icon name="shield" className="h-4 w-4 shrink-0" />
            <span>
              Auth not configured — add <span className="rounded-md bg-black/30 px-1.5 py-0.5 font-mono text-[11px]">OPERION_OWNER_PASSWORD</span> /{" "}
              <span className="rounded-md bg-black/30 px-1.5 py-0.5 font-mono text-[11px]">OPERION_AGENT_PASSWORD</span> to enable logins.
            </span>
          </p>
          <button
            type="button"
            onClick={() => {
              try {
                localStorage.setItem("op-leados-auth-banner-dismissed", "1");
              } catch {
                /* ignore */
              }
              setBannerDismissed(true);
            }}
            className="shrink-0 rounded-lg p-1 text-muted transition hover:bg-white/5 hover:text-fg"
            aria-label="Dismiss notice"
          >
            ✕
          </button>
        </div>
      )}

      {/* Empty-pool hero — guides the owner to their first real data */}
      {data.total === 0 && (
        <div className="glass flex flex-col items-center gap-3 px-6 py-10 text-center">
          <span className="icon-tile">
            <Icon name="search" className="h-5 w-5" />
          </span>
          <p className="text-base font-semibold text-fg">No prospects yet — your pool starts clean</p>
          <p className="max-w-md text-xs leading-relaxed text-muted">
            Import your first list via CSV on Bulk Analysis, run a search to discover companies from your providers, or paste a company URL into Website Intelligence.
          </p>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
            <Link to="/search" search={{ q: "" }} className="btn-primary">
              <Icon name="search" className="h-4 w-4" /> Run a search
            </Link>
            <Link to="/bulk" className="btn-ghost">
              <Icon name="upload" className="h-4 w-4" /> Import a CSV
            </Link>
          </div>
        </div>
      )}

      {/* Slim stat strip — one primary row, not eight cards */}
      <div className="glass">
        <div className="grid grid-cols-2 divide-white/5 sm:grid-cols-3 lg:grid-cols-6 lg:divide-x">
          {strip.map((s) => (
            <div key={s.label} className="px-5 py-4">
              <p className="eyebrow">{s.label}</p>
              <p className={`mt-1.5 font-mono text-2xl font-bold tracking-head ${s.zero ? "text-faint" : "text-fg"}`}>{s.value}</p>
            </div>
          ))}
        </div>
        <p className="border-t border-white/5 px-5 py-2.5 text-[11px] leading-relaxed text-faint">
          {data.importedCount} imported. Deals closed via CRM webhook: {closed.summary?.total ?? 0}
          {closed.summary && closed.summary.hasValueData ? ` · value ${formatCurrency(closed.summary.valueClosed, closed.summary.currencies)}` : ""}. Meetings · demos · trials · customers arrive with the outbound CRM push.
        </p>
      </div>

      {/* Today's Best Prospects — the centerpiece */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold tracking-head text-fg">Today&apos;s Best Prospects</h2>
            <p className="text-sm text-muted">Fit ≥ 75, ranked by Operion Fit Score — why-now lines are heuristic, shown so every pick has a story.</p>
          </div>
          <Link to="/search" search={{ q: "" }} className="btn-primary">
            <Icon name="search" className="h-4 w-4" /> New search
          </Link>
        </div>
        <TodayPanel prospects={data.best10} lookup={closed.lookup} />
      </div>

      {/* Distribution + categories — compact side-by-side */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <p className="eyebrow mb-1">Fit-score distribution</p>
          <p className="mb-4 text-xs text-muted">Real scores across {data.total} prospect{data.total === 1 ? "" : "s"}.</p>
          <div className="space-y-3">
            {data.buckets.map((b) => (
              <div key={b.label}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="font-medium text-fg">{b.label}</span>
                  <span className="font-mono text-muted">{b.count}</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-white/5">
                  <div className={`h-full rounded-full bg-gradient-to-r ${b.cls}`} style={{ width: `${data.total ? (b.count / data.total) * 100 : 0}%` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[11px] text-faint">Excellent ≥ 75 · Strong 55–74 · Moderate 35–54 · Weak &lt; 35 (fit engine weights: {135} pts of signals).</p>
        </Card>

        <Card className="p-5">
          <p className="eyebrow mb-1">Categories</p>
          <p className="mb-4 text-xs text-muted">Auto categories computed from each prospect&apos;s data — hover a label for its rule.</p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
            {data.categoryBreakdown.slice(0, 6).map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="flex min-w-0 items-center gap-1.5 text-muted" title={CATEGORY_BY_ID[c.id]?.rule ?? "Custom category"}>
                  <span className="truncate">{c.label}</span>
                  {c.auto && <span className="text-[10px] text-faint">auto</span>}
                </span>
                <span className="font-mono text-fg">{c.count}</span>
              </div>
            ))}
          </div>
          {data.categoryBreakdown.length > 6 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-muted hover:text-fg">Show all {data.categoryBreakdown.length} categories</summary>
              <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5">
                {data.categoryBreakdown.slice(6).map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-1.5 text-muted" title={CATEGORY_BY_ID[c.id]?.rule ?? "Custom category"}>
                      <span className="truncate">{c.label}</span>
                      {c.auto && <span className="text-[10px] text-faint">auto</span>}
                    </span>
                    <span className="font-mono text-fg">{c.count}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </Card>
      </div>

      {/* AI Insights — folded into one expander */}
      <details className="glass p-5">
        <summary className="flex cursor-pointer items-center justify-between gap-3 text-sm font-semibold text-fg">
          <span className="flex items-center gap-1.5"><Icon name="sparkle" className="h-4 w-4 text-accent-light" /> AI insights</span>
          <span className="text-xs font-normal text-muted">illustrative — computed from signals, not outcomes</span>
        </summary>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          {data.insights.map((ins) => (
            <Card key={ins.title} className="p-5">
              <p className="text-sm font-semibold text-fg">{ins.title}</p>
              <p className="mt-2 text-xs leading-relaxed text-muted">{ins.body}</p>
              <p className="mt-3 text-[10px] uppercase tracking-label text-faint">Illustrative — computed from signals, not outcomes</p>
            </Card>
          ))}
          {data.insights.length === 0 && (
            <Card className="p-5 text-sm text-muted">Not enough prospects to compute meaningful comparisons yet — insights appear as the pool grows.</Card>
          )}
          <Card className="p-5">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-fg"><Icon name="bolt" className="h-4 w-4 text-warn" /> Outcome-based insights</p>
            {closed.summary && closed.summary.total > 0 ? (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-white/10 bg-white/[.03] px-3 py-2">
                    <p className="text-[10px] uppercase tracking-label text-faint">Deals closed</p>
                    <p className="mt-0.5 font-mono text-xl font-bold text-fg">
                      {closed.summary.total}
                      <span className="ml-1 text-xs font-normal text-muted">({closed.summary.matched} matched)</span>
                    </p>
                  </div>
                  <div className="rounded-xl border border-white/10 bg-white/[.03] px-3 py-2">
                    <p className="text-[10px] uppercase tracking-label text-faint">Value closed</p>
                    <p className="mt-0.5 font-mono text-xl font-bold text-fg">{closed.summary.hasValueData ? formatCurrency(closed.summary.valueClosed, closed.summary.currencies) : "—"}</p>
                    {closed.summary.currencies.length > 1 && <p className="text-[10px] text-faint">mixed currencies — as submitted</p>}
                  </div>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-label text-faint">Closed deals by fit band</p>
                  <div className="mt-1.5 space-y-1.5">
                    {closed.summary.byFitBand.map((b) => (
                      <div key={b.band} className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-muted">{b.band === "unmatched" ? "unmatched (no Lead OS match)" : b.band}</span>
                        <span className="font-mono text-fg">{b.count}{b.value !== undefined ? ` · ${formatCurrency(b.value, closed.summary!.currencies)}` : ""}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <p className="text-[11px] leading-relaxed text-faint">
                  Real records from the CRM → Lead OS webhook (source <span className="font-mono">crm-webhook</span>, verified). A true win rate needs the “sent to CRM” baseline — that arrives with the outbound CRM push.
                </p>
              </div>
            ) : (
              <>
                <p className="mt-2 text-xs leading-relaxed text-muted">
                  No closed deals recorded yet. When the CRM posts a closed deal to the Lead OS webhook, this card shows real numbers — deals closed, value closed, and distribution by fit band.
                </p>
                <p className="mt-3 text-[10px] uppercase tracking-label text-faint">Waiting for the first CRM webhook event</p>
              </>
            )}
          </Card>
        </div>
      </details>

      {/* Saved searches — shown only when there are some (empty-state hint lives on Search) */}
      {data.savedSearches.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-end justify-between">
            <div>
              <h2 className="text-lg font-semibold tracking-head text-fg">Saved searches</h2>
              <p className="text-sm text-muted">Re-runs the query against the live pool on click.</p>
            </div>
            <Link to="/search" search={{ q: "" }} className="text-sm text-accent-light hover:underline">New search →</Link>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.savedSearches.map((ss) => (
              <Link key={ss.id} to="/search" search={{ q: ss.query }} className="glass group p-4 transition hover:border-accent/30">
                <p className="flex items-center gap-2 text-sm font-medium text-fg">
                  <Icon name="search" className="h-3.5 w-3.5 text-accent-light" />
                  <span className="truncate">{ss.name}</span>
                </p>
                <p className="mt-1 truncate text-xs text-muted" title={ss.query}>{ss.query}</p>
                <p className="mt-2 text-[10px] uppercase tracking-label text-faint">Saved {new Date(ss.createdAt).toLocaleDateString()} · run on click</p>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------- Today's Best Prospects panel ----------------------- */

function TodayPanel({ prospects, lookup }: { prospects: ScoredProspect[]; lookup: import("~/lib/webhookClient").ClosedDealLookup }) {
  if (!prospects.length) {
    return (
      <Card className="p-10 text-center text-sm text-muted">
        No prospects meet fit ≥ 75 yet. <Link to="/search" search={{ q: "" }} className="text-accent-light underline">Run a search</Link> to discover companies, or import your first list via CSV on{" "}
        <Link to="/bulk" className="text-accent-light underline">Bulk Analysis</Link>.
      </Card>
    );
  }
  return (
    <div className="glass overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead>
            <tr className="border-b border-white/5">
              {["#", "Company", "Fit", "Contactability", "Buyer identified", "Verification", "Why now"].map((h) => (
                <th key={h} className="px-4 py-3 text-xs font-semibold uppercase tracking-label text-muted">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {prospects.map((p, i) => {
              const view: Prospect = getEnrichedMap()[p.id]?.prospect ?? p;
              const cont = contactabilityOf(view);
              const vStatus = bestContactStatus(view);
              const deal = dealForProspect(view, lookup);
              return (
                <tr key={p.id} className="group border-b border-white/5 transition hover:bg-white/[.03]">
                  <td className="px-4 py-2.5 font-mono text-xs text-muted">{String(i + 1).padStart(2, "0")}</td>
                  <td className="px-4 py-3">
                    <Link to="/prospects/$id" params={{ id: p.id }} className="font-semibold text-fg hover:text-accent-light">
                      {view.companyName.value}
                    </Link>
                    {deal && (
                      <span
                        title={`Won — deal ${deal.dealId}${deal.fields.dealValue ? ` · ${formatDealValue(deal)}` : ""}${deal.fields.closedAt ? ` · closed ${new Date(deal.fields.closedAt.value).toLocaleDateString()}` : ""} · recorded ${new Date(deal.recordedAt).toLocaleDateString()} (CRM webhook)`}
                      >
                        <Badge variant="green" className="ml-2 text-[10px]">won{deal.fields.dealValue ? ` · ${formatDealValue(deal)}` : ""}</Badge>
                      </span>
                    )}
                    <p className="mt-0.5 text-xs text-muted">{view.subIndustry?.value ?? view.industry.value} · {shortLocation(view.location.value)}</p>
                  </td>
                  <td className="px-4 py-3"><FitBadge score={p.fit.score} /></td>
                  <td className="px-4 py-3"><ContactabilityPill band={cont.band} /></td>
                  <td className="px-4 py-3"><p className="max-w-[11rem] text-xs text-fg">{p.fit.recommendedBuyer}</p></td>
                  <td className="px-4 py-3"><StatusPill status={vStatus} /></td>
                  <td className="px-4 py-3"><p className="max-w-[16rem] text-xs text-muted">{whyNow(p)}</p></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t border-white/5 px-4 py-2.5 text-[11px] text-faint">
        “Why now” is a heuristic line from the company&apos;s own signals — illustrative, shown so every pick has a story.
      </p>
    </div>
  );
}
