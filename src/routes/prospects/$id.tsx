/**
 * Prospect detail — fit explanation (score, reasons, recommended buyer, likely
 * pain point), decision-maker contacts with per-field provenance, the
 * enrichment waterfall report for this prospect (steps + per-prospect cost,
 * mock-labeled in dry runs), Website Intelligence evidence ("what we found on
 * the site") when the prospect came from a website analysis, and "Send to
 * Operion CRM" (stub: pending). Also hosts the "Re-analyze website" action.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Badge, Button, Card, FitBadge, Icon, Modal, ProvenanceTag, SectionHead, StatusPill } from "~/components/ui";
import { SendToCrmButton } from "~/components/prospectTable";
import { computeFit, SIGNAL_DEFS } from "~/lib/fitScore";
import { getImportedProspects, getEnrichedMap, saveEnrichedMap, updateImportedProspect } from "~/lib/store";
import { getCategoryMap } from "~/lib/store";
import { addCustomCategory, categoriesFor, fullCatalog, toggleManualCategory } from "~/lib/categories";
import { contactabilityOf, shortLocation } from "~/lib/types";
import { formatCost } from "~/lib/enrich";
import { analyzeCompanyWebsite } from "~/lib/siteIntelServer";
import { ResearchOutreachModal } from "~/components/researchOutreach";
import { useClosedDeals, dealForProspect, formatDealValue } from "~/lib/webhookClient";
import type { SiteIntelResult } from "~/lib/siteIntelServer";
import type { Prospect, Provenance } from "~/lib/types";

export const Route = createFileRoute("/prospects/$id")({
  component: ProspectDetail,
});

function findProspect(id: string): { prospect: Prospect; enrichedAt?: string; cost?: number; steps?: import("~/lib/enrich").EnrichmentStep[]; mock?: boolean; skipReason?: string } | undefined {
  const all = [...getImportedProspects()];
  const p = all.find((x) => x.id === id);
  if (!p) return undefined;
  const fit = computeFit(p);
  const enriched = getEnrichedMap()[id];
  if (enriched) {
    return {
      prospect: { ...enriched.prospect, fit },
      enrichedAt: enriched.enrichedAt,
      cost: enriched.cost,
      steps: enriched.steps,
      mock: enriched.mock,
      skipReason: enriched.reason === "skipped" ? enriched.skipReason : undefined,
    };
  }
  return { prospect: { ...p, fit } };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-label text-faint">{label}</p>
      <div className="mt-0.5 text-sm text-fg">{children}</div>
    </div>
  );
}

/** Re-run Website Intelligence on a stored prospect's website. */
function ReanalyzeModal({ open, onClose, prospect, onApplied }: { open: boolean; onClose: () => void; prospect: Prospect; onApplied: () => void }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SiteIntelResult | null>(null);
  const [applyError, setApplyError] = useState("");

  const run = async () => {
    setRunning(true);
    setApplyError("");
    setResult(null);
    try {
      const res = await analyzeCompanyWebsite({ data: { url: prospect.website?.value ?? "" } });
      setResult(res);
    } catch {
      setResult({ ok: false, error: "unreachable", detail: "analysis failed" });
    } finally {
      setRunning(false);
    }
  };

  const apply = () => {
    if (!result?.ok) return;
    const fresh = result.prospect;
    const merged: Prospect = {
      ...fresh,
      id: prospect.id,
      isSample: prospect.isSample,
      sourceProvider: prospect.sourceProvider,
      importedAt: prospect.importedAt,
      mock: prospect.mock,
      tags: Array.from(new Set([...(prospect.tags ?? []), ...(fresh.tags ?? [])])),
    };
    const ok = updateImportedProspect(prospect.id, () => merged);
    const map = getEnrichedMap();
    if (map[prospect.id]) {
      map[prospect.id] = { ...map[prospect.id], prospect: merged };
      saveEnrichedMap(map);
    }
    if (!ok) {
      setApplyError("This record can't be updated in place (it isn't stored in the imported list).");
      return;
    }
    onApplied();
    onClose();
  };

  const freshFit = result?.ok ? result.prospect.fit : undefined;
  const ev = result?.ok ? (result.prospect.websiteIntel?.evidence ?? []) : [];
  const warnings = result?.ok ? (result.prospect.websiteIntel?.warnings ?? []) : [];

  return (
    <Modal open={open} onClose={onClose} title="Re-analyze website">
      <div className="space-y-3 text-sm">
        <p className="text-xs text-muted">
          Re-reading <span className="font-mono text-fg">{prospect.website?.value}</span> — public pages only, max 6, plain fetch.
        </p>
        <Button onClick={() => void run()} disabled={running} className="w-full">
          <Icon name="eye" className="h-4 w-4" /> {running ? "Analyzing…" : "Run analysis"}
        </Button>

        {result?.ok ? (
          <div className="space-y-3">
            <div className="rounded-xl bg-white/[.03] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <FitBadge score={freshFit?.score ?? 0} />
                <span className="text-xs text-muted">{freshFit?.grade ?? "—"} match</span>
                {freshFit?.thresholdMet ? <Badge variant="green">passes fit ≥ 55</Badge> : <Badge>below fit threshold</Badge>}
              </div>
              <p className="mt-1.5 text-xs text-muted">
                Recommended buyer: <span className="text-fg">{freshFit?.recommendedBuyer ?? "—"}</span>
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                Pain point: <span className="text-fg">{freshFit?.likelyPainPoint ?? "—"}</span>
              </p>
            </div>
            {warnings.length > 0 && (
              <div className="space-y-1">
                {warnings.map((w, i) => (
                  <p key={i} className="flex items-start gap-1.5 rounded-lg border border-warn/30 bg-warn/10 p-2 text-xs text-warn">
                    <Icon name="bolt" className="mt-0.5 h-3 w-3 shrink-0" /> {w}
                  </p>
                ))}
              </div>
            )}
            {ev.length > 0 && (
              <div>
                <p className="mb-1.5 text-[11px] uppercase tracking-label text-faint">What we found on the site</p>
                <div className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
                  {ev.map((e, i) => (
                    <span key={i} className="badge" title={e.detail}>
                      <span className="text-faint">{e.label}:</span> {e.detail.length > 70 ? e.detail.slice(0, 70) + "…" : e.detail}
                      <StatusPill status={e.status} />
                    </span>
                  ))}
                </div>
              </div>
            )}
            {!prospect.isSample && (
              <Button onClick={apply} className="w-full">
                Apply update to this prospect
              </Button>
            )}
            {applyError && <p className="text-xs text-danger">{applyError}</p>}
          </div>
        ) : result && !result.ok ? (
          <p className="rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-xs text-danger">
            Couldn&apos;t fetch — check the URL. The site may be down, blocked, or too slow
            {result.detail ? ` (${result.detail})` : ""}.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

function ProspectDetail() {
  const { id } = Route.useParams();
  const [refresh, setRefresh] = useState(0);
  const [reanalyzeOpen, setReanalyzeOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const closed = useClosedDeals();
  const data = useMemo(() => findProspect(id), [id, refresh]);
  if (!data) {
    return (
      <div className="space-y-4">
        <SectionHead eyebrow="Prospect" title="Not found" />
        <Card className="p-8 text-center text-sm text-muted">
          This prospect isn&apos;t in the engine anymore. <Link to="/prospects" className="text-accent-light underline">Back to Prospects</Link>
        </Card>
      </div>
    );
  }
  const p = data.prospect;
  const fit = p.fit!;
  const cont = contactabilityOf(p);
  const primary = p.contacts.find((c) => c.isPrimary) ?? p.contacts[0];
  const signalDefs = SIGNAL_DEFS.filter((s) => p.signals[s.key]);
  const inactiveSignals = SIGNAL_DEFS.filter((s) => !p.signals[s.key]);
  const isMock = p.mock || !!data.mock;
  const intel = p.websiteIntel;
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/prospects" className="text-sm text-muted hover:text-fg">← Prospects</Link>
          </div>
          <h1 className="text-3xl font-bold tracking-head text-fg">{p.companyName.value}</h1>
          <div className="flex flex-wrap items-center gap-2">
            {isMock && <Badge variant="mock">Enriched with mock (dry run) data</Badge>}
            {intel && <Badge variant="violet"><Icon name="eye" className="h-3 w-3" /> website-intel</Badge>}
          </div>
          <p className="text-sm text-muted">
            {p.industry.value}{p.subIndustry ? ` · ${p.subIndustry.value}` : ""} · {shortLocation(p.location.value)}
            {p.employees ? ` · ${p.employees.value} employees` : ""}
            {p.website ? ` · ${p.website.value}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {p.website?.value && !p.isSample && (
            <Button variant="ghost" onClick={() => setReanalyzeOpen(true)}>
              <Icon name="eye" className="h-4 w-4" /> Re-analyze website
            </Button>
          )}
          <Button variant="ghost" onClick={() => setResearchOpen(true)}>
            <Icon name="sparkle" className="h-4 w-4" /> Research company
          </Button>
          <SendToCrmButton prospect={p} size="md" />
        </div>
      </div>
      {/* Won banner — recorded by the CRM deal-closed webhook */}
      {(() => {
        const deal = dealForProspect(p, closed.lookup);
        if (!deal) return null;
        return (
          <div className="rounded-2xl border border-success/30 bg-success/10 px-4 py-3">
            <p className="flex flex-wrap items-center gap-2 text-sm text-fg">
              <Badge variant="green">Won</Badge>
              <span className="font-medium">{p.companyName.value} closed a deal{deal.fields.dealValue ? ` worth ${formatDealValue(deal)}` : ""} — recorded from the CRM webhook.</span>
            </p>
            <p className="mt-1 text-[11px] text-success/80">
              Deal <span className="font-mono">{deal.dealId}</span>
              {deal.fields.closedAt ? ` · closed ${new Date(deal.fields.closedAt.value).toLocaleDateString()}` : ""}
              {deal.matchedBy ? ` · matched by ${deal.matchedBy}` : ""}
              · source crm-webhook · recorded {new Date(deal.recordedAt).toLocaleDateString()}
            </p>
          </div>
        );
      })()}
      {/* Sent to Operion CRM — recorded by the outbound CRM push */}
      {p.crmDealId && (
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="eyebrow flex items-center gap-1.5">
              <Icon name="check" className="h-3.5 w-3.5 text-success" /> Sent to Operion CRM
            </p>
            <Badge variant={p.crmResult?.value === "created" ? "green" : "amber"}>
              {p.crmResult?.value === "created" ? "created" : "duplicate (existing deal)"}
            </Badge>
          </div>
          <div className="mt-3 space-y-2 text-sm">
            <div className="flex items-center justify-between gap-3 border-b border-white/5 pb-2">
              <span className="text-muted">Deal</span>
              <span className="flex items-center gap-2">
                <span className="font-mono text-fg">{p.crmDealId.value}</span>
                <StatusPill status={p.crmDealId.verificationStatus} />
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-white/5 pb-2">
              <span className="text-muted">Result</span>
              <span className="flex items-center gap-2 text-fg">{p.crmResult?.value === "created" ? "created — new deal" : "duplicate — matched by email"}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted">Sent</span>
              <span className="flex items-center gap-2">
                <span className="text-fg">{p.crmSentAt ? new Date(p.crmSentAt.value).toLocaleString() : "—"}</span>
                {p.crmSentAt && <StatusPill status={p.crmSentAt.verificationStatus} />}
              </span>
            </div>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-faint">
            Recorded from the CRM API — source <span className="font-mono">crm-api</span> · captured {p.crmSentAt ? new Date(p.crmSentAt.value).toLocaleString() : "—"} · confidence 100% · verified. The CRM stays the system of record; this is Lead OS&apos;s note that the prospect was pushed.
          </p>
        </Card>
      )}
      {/* Fit score hero */}
      <Card className="p-6" glow>
        <div className="grid gap-6 lg:grid-cols-[auto_1fr]">
          <div className="flex flex-col items-center justify-center gap-2 lg:min-w-[10rem]">
            <div className="relative flex h-28 w-28 items-center justify-center">
              <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
                <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="8" />
                <circle
                  cx="50" cy="50" r="42" fill="none" stroke="url(#fitGrad)" strokeWidth="8" strokeLinecap="round"
                  strokeDasharray={`${(fit.score / 100) * 264} 264`}
                />
                <defs>
                  <linearGradient id="fitGrad" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#a78bfa" />
                    <stop offset="100%" stopColor="#60a5fa" />
                  </linearGradient>
                </defs>
              </svg>
              <div className="absolute text-center">
                <p className="font-mono text-3xl font-bold text-fg">{fit.score}</p>
                <p className="text-[10px] uppercase tracking-label text-muted">fit / 100</p>
              </div>
            </div>
            <p className="text-xs text-muted">{fit.grade} match</p>
          </div>
          <div className="space-y-4">
            <div className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
              <Field label="Recommended buyer"><span className="font-medium text-fg">{fit.recommendedBuyer}</span></Field>
              <Field label="Secondary buyer"><span className="text-muted">{fit.secondaryBuyer}</span></Field>
              <Field label="Contactability"><span className="text-muted">{cont.band} ({cont.status})</span></Field>
              <Field label="Source"><span className="text-muted">{p.sourceProvider}{isMock ? " · mock" : ""}</span></Field>
            </div>
            <div className="rounded-xl border border-accent/20 bg-accent/10 p-4">
              <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-label text-accent-light">
                <Icon name="bolt" className="h-3.5 w-3.5" /> Likely pain point
              </p>
              <p className="text-sm leading-relaxed text-fg">{fit.likelyPainPoint}</p>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-label text-faint">Why this score — {fit.reasons.length} signal{fit.reasons.length === 1 ? "" : "s"} detected</p>
              <div className="flex flex-wrap gap-1.5">
                {fit.reasons.map((r) => (
                  <span key={r.signal} className="badge badge-violet" title={r.note}>
                    +{r.weight} {r.label}
                  </span>
                ))}
                {fit.reasons.length === 0 && <span className="badge">No positive signals — low fit</span>}
              </div>
            </div>
          </div>
        </div>
      </Card>
      {/* Website Intelligence evidence */}
      {intel && (
        <Card className="p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="eyebrow flex items-center gap-1.5">
              <Icon name="eye" className="h-3.5 w-3.5 text-accent-light" /> Website intelligence — what we found on the site
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="violet">{intel.pagesFetched} page{intel.pagesFetched === 1 ? "" : "s"} analyzed</Badge>
              <span className="text-xs text-muted">{intel.domain} · {new Date(intel.analyzedAt).toLocaleString()}</span>
            </div>
          </div>
          {intel.warnings.length > 0 && (
            <div className="mt-3 space-y-1">
              {intel.warnings.map((w, i) => (
                <p key={i} className="flex items-start gap-1.5 rounded-lg border border-warn/30 bg-warn/10 p-2 text-xs text-warn">
                  <Icon name="bolt" className="mt-0.5 h-3 w-3 shrink-0" /> {w}
                </p>
              ))}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {intel.evidence.map((e, i) => (
              <span key={i} className="badge max-w-[24rem]" title={e.detail}>
                <span className="text-faint">{e.label}:</span>
                <span className="truncate">{e.detail.length > 80 ? e.detail.slice(0, 80) + "…" : e.detail}</span>
                <StatusPill status={e.status} />
              </span>
            ))}
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            Evidence is read from the public site only — nothing is guessed. Emails/phones are labeled Unverified; anything the page didn&apos;t say stays Unknown. Re-run anytime with <span className="text-fg">Re-analyze website</span>.
          </p>
        </Card>
      )}
      {/* Enrichment report */}
      <Card className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="eyebrow">Enrichment waterfall</p>
          <div className="flex flex-wrap items-center gap-2">
            {data.cost !== undefined && (
              <span className="font-mono text-sm text-muted">est. cost <span className="text-fg">{formatCost(data.cost)}</span></span>
            )}
            {isMock && <Badge variant="mock">mock — dry run</Badge>}
          </div>
        </div>
        {data.skipReason ? (
          <p className="mt-3 text-sm text-muted">
            Skipped this run — <span className="text-warn">{data.skipReason}</span>
          </p>
        ) : data.steps && data.steps.length ? (
          <div className="mt-3 space-y-1.5">
            {data.steps.map((s, i) => (
              <div key={i} className="flex flex-wrap items-center gap-3 rounded-lg bg-white/[.03] px-3 py-1.5 text-sm">
                <span className="font-mono text-xs text-muted">{String(i + 1).padStart(2, "0")}</span>
                <span className="flex-1 text-fg">{s.provider} → {s.capability}</span>
                {s.outcome === "ok" ? <Badge variant="green">done</Badge> : s.outcome === "skip" ? <Badge>skipped</Badge> : s.outcome === "mock" ? <Badge variant="mock">mock</Badge> : <Badge variant="red">failed</Badge>}
                <span className="font-mono text-xs text-muted">{s.cost !== undefined ? formatCost(s.cost) : "—"}</span>
              </div>
            ))}
            <p className="text-xs text-muted">
              Cheapest providers first (Google Places → PDL/Apollo → Hunter), gated by the cost rules and dedupe — labeled mock in dry runs.
            </p>
          </div>
        ) : (
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Not enriched yet. Run <span className="text-fg">Enrich top prospects</span> from Prospect Search (dry run in Settings shows the full mock waterfall with zero keys).
          </p>
        )}
      </Card>
      {/* Contact */}
      <Card className="p-6">
        <p className="eyebrow mb-4">Decision makers</p>
        {p.contacts.length === 0 ? (
          <p className="text-sm text-muted">
            No contacts identified yet. Decision-maker discovery runs only for prospects above the enrichment fit thresholds — this one didn&apos;t qualify or no provider is configured.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/5">
                  {["Name", "Title", "Email", "Phone"].map((h) => (
                    <th key={h} className="px-3 py-2 text-xs font-semibold uppercase tracking-label text-muted">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {p.contacts.map((c) => (
                  <tr key={c.id} className="border-b border-white/5">
                    <td className="px-3 py-3 font-medium text-fg">
                      {c.fullName.value}
                      {c.isPrimary && <span className="ml-2 text-[10px] text-accent-light">PRIMARY</span>}
                      <StatusPill status={c.fullName.verificationStatus} />
                    </td>
                    <td className="px-3 py-3 text-muted"><ProvenanceTag p={c.title} /></td>
                    <td className="px-3 py-3">{c.email ? <ProvenanceTag p={c.email} /> : <span className="text-xs text-faint">—</span>}</td>
                    <td className="px-3 py-3">{c.phone ? <ProvenanceTag p={c.phone} /> : <span className="text-xs text-faint">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {primary && (
          <p className="mt-3 text-xs text-muted">
            Best contact: <span className="text-fg">{primary.fullName.value}</span> — {primary.title.value}. Hover any field for source, capture time and confidence.
          </p>
        )}
      </Card>
      {/* Signals + provenance */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-6">
          <p className="eyebrow mb-4">Operational signals</p>
          <div className="space-y-1.5">
            {signalDefs.map((s) => (
              <div key={s.key} className="flex items-start justify-between gap-3 rounded-lg bg-white/[.03] px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-fg">✓ {s.label}</p>
                  <p className="text-xs text-muted">{s.note}</p>
                </div>
                <span className="badge badge-violet shrink-0">+{s.weight}</span>
              </div>
            ))}
            {signalDefs.length === 0 && <p className="text-sm text-muted">No signals detected.</p>}
            <details className="pt-2">
              <summary className="cursor-pointer text-xs text-muted hover:text-fg">Signals not detected ({inactiveSignals.length})</summary>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {inactiveSignals.map((s) => (
                  <span key={s.key} className="badge opacity-60">– {s.label}</span>
                ))}
              </div>
            </details>
          </div>
        </Card>
        <Card className="p-6">
          <p className="eyebrow mb-4">Data provenance</p>
          <div className="space-y-2.5">
            {([
              ["Company name", p.companyName],
              ["Industry", p.industry],
              ["Location", p.location],
              ["Employees", p.employees],
              ["Revenue", p.revenue],
              ["Website", p.website],
            ] as [string, Provenance | undefined][]).map(([label, prov]) => (
              <div key={label} className="flex items-center justify-between gap-3 border-b border-white/5 pb-2 text-sm">
                <span className="text-muted">{label}</span>
                <span className="flex items-center gap-2">
                  <span className="text-fg">{prov ? (label === "Location" && p.location ? shortLocation(p.location.value) : String(prov.value)) : "—"}</span>
                  {prov && <StatusPill status={prov.verificationStatus} />}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs leading-relaxed text-muted">
            Every field carries source, capture time, confidence and verification status (hover to inspect). Unknown stays unknown — Operion never fabricates data.
            {isMock && <span className="text-warn"> Enriched fields came from mock providers in dry-run mode — labeled mock, never presented as real.</span>}
            {intel && <span className="text-accent-light"> Fields here came from the public website of {intel.domain}.</span>}
          </p>
        </Card>
      </div>
      {/* Categories */}
      <Card className="p-6">
        <p className="eyebrow">Categories</p>
        <p className="mb-3 mt-0.5 text-xs text-muted">
          Auto categories are computed from this record&apos;s data (tier, industry/signals, outreach state). Toggle manual categories to organize your pipeline.
        </p>
        <CategoryPicker prospect={p} refreshKey={refresh} onChanged={() => setRefresh((n) => n + 1)} />
      </Card>
      <ReanalyzeModal open={reanalyzeOpen} onClose={() => setReanalyzeOpen(false)} prospect={p} onApplied={() => setRefresh((n) => n + 1)} />
      <ResearchOutreachModal open={researchOpen} onClose={() => setResearchOpen(false)} prospect={p} />
    </div>
  );
}

/* --------------------------- category assignment --------------------------- */

function CategoryPicker({ prospect, refreshKey, onChanged }: { prospect: Prospect; refreshKey: number; onChanged: () => void }) {
  const fit = computeFit(prospect);
  const cats = useMemo(() => categoriesFor(prospect, fit, getCategoryMap()), [prospect, fit, refreshKey]);
  const catalog = fullCatalog();
  const [newCat, setNewCat] = useState("");

  const toggle = (id: string) => {
    toggleManualCategory(prospect.id, id);
    onChanged();
  };

  const addCustom = () => {
    if (!newCat.trim()) return;
    addCustomCategory(newCat.trim());
    toggleManualCategory(prospect.id, newCat.trim());
    setNewCat("");
    onChanged();
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {catalog.map((c) => {
          const isAuto = cats.auto.includes(c.id);
          const isManual = cats.manual.includes(c.id);
          const active = isAuto || isManual;
          return (
            <button
              key={c.id}
              type="button"
              title={`${c.rule}${isAuto ? " · auto" : ""}`}
              onClick={() => { if (!isAuto) toggle(c.id); }}
              className={`badge transition ${active ? (isAuto ? "badge-violet opacity-80" : "badge-green") : "opacity-50 hover:opacity-90"}`}
            >
              {c.label}{isAuto ? " ✓" : ""}
            </button>
          );
        })}
      </div>
      <div className="flex max-w-md gap-2">
        <input value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="New custom category…" className="input-dark" aria-label="New custom category" />
        <Button variant="ghost" onClick={addCustom} disabled={!newCat.trim()}>Add</Button>
      </div>
      <p className="text-[11px] text-faint">
        Auto categories (✓) are computed from this record&apos;s data and can&apos;t be removed. Manual categories are yours and can be toggled freely.
      </p>
    </div>
  );
}
