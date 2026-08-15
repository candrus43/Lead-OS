/**
 * Bulk run detail — live progress + server-paginated results.
 *
 * While a run is queued/running the page polls run-level progress and the
 * current page of results; when it reaches a terminal state polling stops.
 * Results are always fetched one page (50) at a time from the server — the
 * browser never receives the full dataset.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, ContactabilityPill, FitBadge, Icon, SectionHead, StatusPill } from "~/components/ui";
import { cancelBulkRun, getBulkRun, getBulkRunPage } from "~/lib/bulkServer";
import { formatCost } from "~/lib/enrich";
import { contactabilityOf, shortLocation } from "~/lib/types";
import type { BulkRunPage, BulkRunSummary, ProspectRunStatus } from "~/lib/bulk/types";

export const Route = createFileRoute("/bulk/$id")({
  component: BulkRunDetailPage,
});

const PAGE_SIZE = 50;

const STATUS_META: Record<ProspectRunStatus, { cls: string; dot?: string; pulse?: boolean }> = {
  Queued: { cls: "" },
  Processing: { cls: "badge-violet", dot: "bg-accent-light", pulse: true },
  Scoring: { cls: "badge-violet", dot: "bg-accent-light", pulse: true },
  Enriching: { cls: "badge-violet", dot: "bg-accent-light", pulse: true },
  Verifying: { cls: "badge-violet", dot: "bg-accent-light", pulse: true },
  Complete: { cls: "badge-green", dot: "bg-success" },
  Error: { cls: "badge-red", dot: "bg-danger" },
  Cancelled: { cls: "badge-amber", dot: "bg-warn" },
};

function ItemStatus({ status }: { status: ProspectRunStatus }) {
  const m = STATUS_META[status] ?? STATUS_META.Queued;
  return (
    <span className={`badge ${m.cls}`} title={status}>
      {m.dot && <span className={`h-1.5 w-1.5 rounded-full ${m.dot} ${m.pulse ? "animate-pulse" : ""}`} />}
      {status}
    </span>
  );
}

function fmtDuration(run: BulkRunSummary): string {
  if (run.durationSec === undefined) return run.status === "running" ? "in progress" : "—";
  const s = run.durationSec;
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function sourceLabel(run: BulkRunSummary): string {
  return run.source.label || (run.source.kind === "csv" ? run.source.fileName ?? "CSV" : run.source.providerId ?? "provider");
}

function RunStatusBadge({ run }: { run: BulkRunSummary }) {
  const map: Record<string, { variant: "green" | "violet" | "amber" | "red"; label: string }> = {
    queued: { variant: "violet", label: "Queued" },
    running: { variant: "green", label: "Running" },
    complete: { variant: "green", label: "Complete" },
    cancelled: { variant: "amber", label: "Cancelled" },
    error: { variant: "red", label: "Error" },
  };
  const m = map[run.status] ?? map.queued;
  return (
    <Badge variant={m.variant}>
      {run.status === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />}
      {m.label}
    </Badge>
  );
}

function BulkRunDetailPage() {
  const { id } = Route.useParams();
  const [run, setRun] = useState<BulkRunSummary | null>(null);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<BulkRunPage | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [missing, setMissing] = useState(false);
  const [stalePage, setStalePage] = useState(false);

  const refreshRun = useCallback(async () => {
    try {
      const r = await getBulkRun({ data: { id } });
      if (!r) {
        setMissing(true);
        return;
      }
      setRun(r);
    } catch {
      // transient poll failure — keep last state
    }
  }, [id]);

  const refreshPage = useCallback(async (p: number) => {
    try {
      const d = await getBulkRunPage({ data: { id, page: p, pageSize: PAGE_SIZE } });
      if (d) {
        setData(d);
        if (d.page !== p) setPage(d.page);
      }
    } catch {
      // transient
    }
  }, [id]);

  useEffect(() => {
    void refreshRun();
    void refreshPage(page);
  }, [refreshRun, refreshPage, page]);

  // Poll while the run is active.
  const active = run?.status === "queued" || run?.status === "running";
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      void refreshRun();
      void refreshPage(page);
    }, 1500);
    return () => clearInterval(t);
  }, [active, refreshRun, refreshPage, page]);

  // Keep the page data fresh as the run progresses past the current page.
  useEffect(() => {
    if (data && run && data.processedCount !== run.processedCount) {
      setStalePage(true);
      const t = setTimeout(() => {
        void refreshPage(page);
        setStalePage(false);
      }, 400);
      return () => clearTimeout(t);
    }
  }, [data, run, page, refreshPage]);

  if (missing) {
    return (
      <Card className="p-10 text-center text-sm text-muted">
        Run not found. <Link to="/bulk" className="text-accent-light underline">Back to Bulk Analysis</Link>
      </Card>
    );
  }
  if (!run) {
    return <p className="text-sm text-muted">Loading run…</p>;
  }

  const pct = run.totalCount > 0 ? Math.round((run.processedCount / run.totalCount) * 100) : 0;
  const from = data && data.items.length ? data.items[0].index + 1 : 0;
  const to = data && data.items.length ? data.items[data.items.length - 1].index + 1 : 0;

  return (
    <div className="space-y-6">
      <SectionHead
        eyebrow="Bulk Analysis"
        title={sourceLabel(run)}
        desc={run.source.kind === "csv" ? `CSV import · ${run.source.fileName ?? "uploaded file"}` : `Provider discovery · ${run.source.providerId}`}
        right={
          <div className="flex items-center gap-2">
            <RunStatusBadge run={run} />
            {run.mock && <Badge variant="mock">mock — dry run, no credits spent</Badge>}
            <Link to="/bulk" className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-fg transition hover:bg-white/10">
              ← All runs
            </Link>
          </div>
        }
      />

      {/* Progress */}
      <Card className="p-4" glow>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-5">
            <Stat label="Total" value={run.totalCount.toLocaleString()} />
            <Stat label="Processed" value={run.processedCount.toLocaleString()} accent />
            <Stat label="Complete" value={run.completeCount.toLocaleString()} color="text-success" />
            <Stat label="Errors" value={run.errorCount.toLocaleString()} color="text-danger" />
            <Stat label="Cancelled" value={run.cancelledCount.toLocaleString()} color="text-warn" />
            <Stat label="Running" value={String(run.runningCount)} color={run.runningCount > 0 ? "text-accent-light" : "text-muted"} />
          </div>
          <div className="flex flex-col items-end gap-0.5 font-mono text-sm">
            <span className="text-muted">est. cost <span className="text-fg">{formatCost(run.cost)}</span></span>
            {run.status === "running" && run.etaSeconds !== undefined && run.etaSeconds > 0 && (
              <span className="flex items-center gap-1 text-xs text-muted"><Icon name="clock" className="h-3.5 w-3.5" /> ETA ~{run.etaSeconds}s</span>
            )}
            <span className="text-xs text-faint">{fmtDuration(run)}</span>
          </div>
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between text-[11px] uppercase tracking-label text-faint">
            <span>{run.currentStage}{run.stageDetail ? ` — ${run.stageDetail}` : ""}</span>
            <span className="font-mono">{pct}%</span>
          </div>
          <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-white/5">
            <div
              className={`h-full rounded-full bg-gradient-to-r transition-all ${run.status === "error" ? "from-warn to-red-500" : run.status === "cancelled" ? "from-warn to-amber-400" : "from-accent-light to-accent"}`}
              style={{ width: `${Math.max(1, pct)}%` }}
            />
          </div>
        </div>

        {(active || cancelling) && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted">
              {run.cancelRequested
                ? "Cancel requested — the run stops after the current batch and marks the rest Cancelled."
                : "Runs continue in the background server-side; you can leave this page and come back."}
            </p>
            {!run.cancelRequested && (
              <Button variant="ghost" disabled={cancelling} onClick={() => {
                setCancelling(true);
                void cancelBulkRun({ data: { id } }).then((r) => {
                  if (r) setRun(r);
                  setCancelling(false);
                });
              }}>
                Cancel run
              </Button>
            )}
          </div>
        )}

        {run.stoppedReason && (
          <p className="mt-3 rounded-lg border border-warn/25 bg-warn/10 px-3 py-2 text-xs text-warn">
            Enrichment budget exhausted: {run.stoppedReason}. Remaining prospects were still scored (free) but skipped by the enrichment waterfall.
          </p>
        )}
        {run.error && (
          <p className="mt-3 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-xs text-danger">{run.error}</p>
        )}

        {run.usage.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {run.usage.map((u) => (
              <span key={`${u.provider}:${u.capability}`} className={`badge text-[10px] ${u.mock ? "badge-mock" : "badge-violet"}`} title={`${u.calls} call(s)`}>
                {u.provider} · {u.capability} · {u.calls} · {formatCost(u.cost)}{u.mock ? " (mock)" : ""}
              </span>
            ))}
          </div>
        )}
      </Card>

      {/* Results */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 px-5 py-3">
          <p className="text-sm font-semibold text-fg">
            Results <span className="font-mono text-xs text-muted">(page {data?.page ?? page} of {data?.totalPages ?? "…"} · {data?.totalItems ?? run.totalCount} total)</span>
          </p>
          <p className="text-[11px] text-faint">
            {active ? "showing processed items so far" : ""} {stalePage ? "· refreshing…" : ""}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[940px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/5 bg-ink-2/90 backdrop-blur">
                {["#", "Status", "Company", "Industry · Location", "Fit", "Buyer", "Contact", "Enrichment"].map((h) => (
                  <th key={h} className="sticky top-0 z-10 bg-ink-2/90 px-4 py-2.5 text-xs font-semibold uppercase tracking-label text-muted backdrop-blur">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(data?.items ?? []).map((it) => {
                const p = it.prospect;
                const contact = p ? p.contacts.find((c) => c.isPrimary) ?? p.contacts[0] : undefined;
                const cont = p ? contactabilityOf(p) : undefined;
                return (
                  <tr key={it.index} className="border-b border-white/5 transition hover:bg-white/[.03]">
                    <td className="px-4 py-2.5 font-mono text-xs text-faint">{it.index + 1}</td>
                    <td className="px-4 py-2.5"><ItemStatus status={it.status} /></td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-fg">{p?.companyName.value ?? "—"}</span>
                        {p?.mock && <Badge variant="mock" className="text-[10px]">mock</Badge>}
                      </div>
                      {p?.description?.value && <p className="mt-0.5 max-w-[16rem] truncate text-[11px] text-faint" title={p.description.value}>{p.description.value}</p>}
                    </td>
                    <td className="max-w-[16rem] px-4 py-2.5 text-muted" title={p ? `${p.subIndustry?.value ?? p.industry.value} · ${p.location.value}` : undefined}>
                      <p className="truncate">{p ? (p.subIndustry?.value ?? p.industry.value) : "—"}</p>
                      <p className="truncate text-[11px] text-faint">{p ? `${shortLocation(p.location.value)}${p.employees?.value ? ` · ${p.employees.value}` : ""}` : ""}</p>
                    </td>
                    <td className="px-4 py-2.5">
                      {p?.fit ? (
                        <div className="flex items-center gap-2">
                          <FitBadge score={p.fit.score} />
                          <span className="hidden cursor-help text-muted xl:inline" title={p.fit.reasons.slice(0, 6).map((r) => `+${r.weight} ${r.label}`).join("\n")}>
                            <Icon name="eye" className="h-3.5 w-3.5" />
                          </span>
                        </div>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-2.5"><p className="max-w-[10rem] truncate text-xs text-fg" title={p?.fit?.recommendedBuyer}>{p?.fit?.recommendedBuyer ?? "—"}</p></td>
                    <td className="px-4 py-2.5">
                      {contact && p ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs text-fg">{contact.fullName.value} · {contact.title.value}</span>
                          <span className="flex gap-1">
                            {contact.email ? <StatusPill status={contact.email.verificationStatus} label="email" /> : <span className="text-[10px] text-faint">no email</span>}
                            {contact.phone ? <StatusPill status={contact.phone.verificationStatus} label="phone" /> : null}
                          </span>
                          {cont && <ContactabilityPill band={cont.band} />}
                        </div>
                      ) : <span className="text-xs text-faint">—</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      {it.status === "Complete" && p ? (
                        <div className="flex flex-col gap-0.5 text-[11px]">
                          {it.enriched ? (
                            <span className="font-mono text-success">{formatCost(it.cost)} · {it.steps?.length ?? 0} steps</span>
                          ) : it.error ? (
                            <span className="text-faint" title={it.error}>skipped · {it.error.slice(0, 60)}</span>
                          ) : (
                            <span className="text-faint">scored only</span>
                          )}
                          {it.steps && it.steps.length > 0 && (
                            <span className="cursor-help text-faint" title={it.steps.map((s) => `${s.provider}/${s.capability}: ${s.outcome}${s.note ? " — " + s.note : ""}`).join("\n")}>
                              {it.steps.slice(0, 3).map((s) => `${s.provider}→${s.capability}${s.outcome === "mock" ? "*" : ""}`).join(" · ")}
                            </span>
                          )}
                        </div>
                      ) : it.status === "Error" ? (
                        <span className="text-[11px] text-danger" title={it.error}>{it.error?.slice(0, 48) ?? "error"}</span>
                      ) : (
                        <span className="text-[11px] text-faint">{it.status}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {(data?.items.length ?? 0) === 0 && (
          <div className="p-8 text-center text-xs text-muted">No results on this page yet — the run is still processing.</div>
        )}
        <div className="flex items-center justify-between gap-3 border-t border-white/5 px-5 py-3">
          <span className="font-mono text-[11px] text-faint">
            {data && data.items.length > 0 ? `Showing ${from}–${to} of ${data.totalItems.toLocaleString()} · page size ${PAGE_SIZE}` : " "}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" className="px-3 py-1.5 text-xs" disabled={!data || data.page <= 1} onClick={() => setPage(data!.page - 1)}>← Prev</Button>
            <span className="font-mono text-xs text-muted">Page {data?.page ?? page} / {data?.totalPages ?? "…"}</span>
            <Button variant="ghost" className="px-3 py-1.5 text-xs" disabled={!data || data.page >= data.totalPages} onClick={() => setPage(data!.page + 1)}>Next →</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function Stat({ label, value, accent, color = "text-fg" }: { label: string; value: string; accent?: boolean; color?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-label text-faint">{label}</span>
      <span className={`font-mono text-lg leading-tight ${accent ? "text-accent-light" : color}`}>{value}</span>
    </div>
  );
}
