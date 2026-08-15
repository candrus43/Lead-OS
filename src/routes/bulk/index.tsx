/**
 * Bulk Analysis — start and monitor asynchronous bulk runs.
 *
 * A run takes a large prospect set (CSV upload — thousands of rows — or provider
 * discovery) and processes it server-side in batches: discover → score → fit-
 * gated enrichment → verify. The browser never receives the full dataset: it
 * starts a run, polls run-level progress, and opens paginated results.
 */

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Badge, Button, Card, Icon, SectionHead } from "~/components/ui";
import { getDryRun, loadJson, setDryRun } from "~/lib/store";
import { getRuntimeConfig } from "~/lib/runtime";
import { DEFAULT_COST_RULES } from "~/lib/fitScore";
import { startBulkRun, listBulkRuns } from "~/lib/bulkServer";
import { countCsvRows } from "~/lib/bulk/csvStream";
import { formatCost } from "~/lib/enrich";
import type { BulkRunSummary } from "~/lib/bulk/types";
import type { CostRules } from "~/lib/fitScore";

export const Route = createFileRoute("/bulk/")({
  component: BulkPage,
});

const STATUS_BADGE: Record<string, { variant: "green" | "violet" | "amber" | "red" | "mock" | "neutral"; label: string }> = {
  queued: { variant: "violet", label: "Queued" },
  running: { variant: "green", label: "Running" },
  complete: { variant: "green", label: "Complete" },
  cancelled: { variant: "amber", label: "Cancelled" },
  error: { variant: "red", label: "Error" },
};

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
  const s = STATUS_BADGE[run.status] ?? STATUS_BADGE.queued;
  return (
    <Badge variant={s.variant}>
      {run.status === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />}
      {s.label}
    </Badge>
  );
}

/* ------------------------------- start form ------------------------------- */

type SourceKind = "csv" | "provider";

function StartRunCard({ onStarted }: { onStarted: (id: string) => void }) {
  const navigate = useNavigate();
  const [kind, setKind] = useState<SourceKind>("csv");
  const [file, setFile] = useState<{ name: string; text: string; rows: number } | null>(null);
  const [fileName, setFileName] = useState("");
  const [csvText, setCsvText] = useState("");
  const [providerId, setProviderId] = useState("google-places");
  const [industry, setIndustry] = useState("Real Estate");
  const [city, setCity] = useState("");
  const [state, setState] = useState("TX");
  const [empMin, setEmpMin] = useState(20);
  const [empMax, setEmpMax] = useState(200);
  const [maxResults, setMaxResults] = useState(1000);
  const [dryRun, setDryRunState] = useState(getDryRun());
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [providers, setProviders] = useState<{ id: string; name: string; mock: boolean }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const rules = loadJson("op-leados-costrules", DEFAULT_COST_RULES) as CostRules;

  useEffect(() => {
    void getRuntimeConfig().then((cfg) => {
      setProviders(
        cfg.providers
          .filter((p) => p.capabilities.includes("discoverCompanies"))
          .map((p) => ({ id: p.id, name: p.name, mock: p.status === "mock" }))
      );
      if (cfg.providers.length) {
        const first = cfg.providers.find((p) => p.capabilities.includes("discoverCompanies"));
        if (first) setProviderId(first.id);
      }
    });
  }, []);

  const loadFile = (f: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      setCsvText(text);
      setFileName(f.name);
      setFile({ name: f.name, text, rows: countCsvRows(text) });
      setError("");
    };
    reader.readAsText(f);
  };

  const start = async (e?: FormEvent) => {
    e?.preventDefault();
    if (starting) return;
    if (kind === "csv" && !csvText) {
      setError("Pick a CSV file first.");
      return;
    }
    setStarting(true);
    setError("");
    try {
      const source =
        kind === "csv"
          ? { kind: "csv" as const, fileName: fileName || "upload.csv", csvText }
          : {
              kind: "provider" as const,
              providerId,
              maxResults: Math.min(Math.max(1, maxResults), 10000),
              filters: {
                industry: industry.trim() || undefined,
                location: { city: city.trim() || undefined, state: state.trim() || undefined, country: "US" },
                employeeMin: empMin > 0 ? empMin : undefined,
                employeeMax: empMax > 0 ? empMax : undefined,
              },
            };
      const summary = await startBulkRun({ data: { source, mock: dryRun, rules } });
      setDryRun(dryRun);
      onStarted(summary.id);
      navigate({ to: "/bulk/$id", params: { id: summary.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the run.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <Card className="p-5" glow>
      <p className="flex items-center gap-2 text-sm font-semibold text-fg">
        <Icon name="play" className="h-4 w-4 text-accent-light" /> Start a bulk run
      </p>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Processing happens server-side in batches of 100 — the browser only ever sees progress and one page of results at a time.
      </p>

      <div className="mt-4 flex gap-2">
        {(["csv", "provider"] as SourceKind[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`badge cursor-pointer transition ${kind === k ? "badge-violet" : "hover:border-accent/40 hover:bg-accent/10 hover:text-accent-light"}`}
          >
            {k === "csv" ? "CSV upload" : "Provider discovery"}
          </button>
        ))}
      </div>

      <form onSubmit={start} className="mt-4 space-y-4">
        {kind === "csv" ? (
          <div className="space-y-3">
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) loadFile(f); }} />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-white/15 bg-white/[.02] px-4 py-8 text-center transition hover:border-accent/40 hover:bg-accent/5"
            >
              <Icon name="upload" className="h-6 w-6 text-muted" />
              <span className="text-sm font-medium text-fg">{file ? file.name : "Choose a CSV file"}</span>
              <span className="text-xs text-muted">
                {file ? `${file.rows.toLocaleString()} data rows parsed client-side for preview — the run itself is server-side.` : "Columns: company, industry, sub_industry, city, state, employees, revenue, website, contact_name, title, email, phone, signals (JSON)"}
              </span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <label className="col-span-2 flex flex-col gap-1 sm:col-span-3">
              <span className="text-[11px] uppercase tracking-label text-faint">Discovery source</span>
              <select value={providerId} onChange={(e) => setProviderId(e.target.value)} className="input-dark text-sm" aria-label="Discovery provider">
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}{p.mock ? " (mock)" : ""}</option>
                ))}
              </select>
            </label>
            <label className="col-span-2 flex flex-col gap-1 sm:col-span-3">
              <span className="text-[11px] uppercase tracking-label text-faint">Industry</span>
              <input value={industry} onChange={(e) => setIndustry(e.target.value)} className="input-dark text-sm" placeholder="Real Estate / Construction / Hospitality…" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-label text-faint">City (optional)</span>
              <input value={city} onChange={(e) => setCity(e.target.value)} className="input-dark text-sm" placeholder="Austin" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-label text-faint">State</span>
              <input value={state} onChange={(e) => setState(e.target.value)} className="input-dark text-sm" placeholder="TX" />
            </label>
            <label className="col-span-2 flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-label text-faint">Employees {empMin}–{empMax}</span>
              <input type="range" min={1} max={1000} value={empMin} onChange={(e) => setEmpMin(+e.target.value)} className="w-full accent-[#8b5cf6]" />
              <input type="range" min={1} max={5000} value={empMax} onChange={(e) => setEmpMax(+e.target.value)} className="w-full accent-[#8b5cf6]" />
            </label>
            <label className="col-span-2 flex flex-col gap-1 sm:col-span-3">
              <span className="text-[11px] uppercase tracking-label text-faint">Max results (discovery pages until this many, ≤ 10,000)</span>
              <input type="number" min={100} max={10000} step={100} value={maxResults} onChange={(e) => setMaxResults(+e.target.value)} className="input-dark text-sm font-mono" />
            </label>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/5 bg-white/[.02] px-3 py-2.5">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={dryRun} onChange={(e) => { setDryRunState(e.target.checked); setDryRun(e.target.checked); }} className="accent-[#8b5cf6]" />
            Dry run <Badge variant="mock" className="text-[10px]">mock</Badge>
          </label>
          <span className="text-[11px] text-faint">
            Enrichment gate: fit ≥ {rules.onlyEnrichCompanyAboveFit} · max {rules.maxEnrichPerRun} calls · email verify ≥ {rules.onlyVerifyEmailAboveFit} <Link to="/settings" className="text-accent-light underline">adjust</Link>
          </span>
        </div>

        {error && <p className="text-xs text-danger">{error}</p>}

        <Button className="w-full" disabled={starting || (kind === "csv" && !csvText)} onClick={() => void start()}>
          <Icon name="play" className="h-4 w-4" /> {starting ? "Starting…" : "Start bulk run"}
        </Button>
      </form>
    </Card>
  );
}

/* --------------------------- runs list / history -------------------------- */

function RunRow({ run }: { run: BulkRunSummary }) {
  const pct = run.totalCount > 0 ? Math.round((run.processedCount / run.totalCount) * 100) : 0;
  const active = run.status === "queued" || run.status === "running";
  return (
    <Link
      to="/bulk/$id"
      params={{ id: run.id }}
      className="block rounded-xl border border-white/5 bg-white/[.02] px-4 py-3 transition hover:border-accent/30 hover:bg-accent/5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <RunStatusBadge run={run} />
        {run.mock && <Badge variant="mock">mock</Badge>}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{sourceLabel(run)}</span>
        <span className="font-mono text-xs text-muted">{fmtDuration(run)}</span>
        <span className="font-mono text-xs text-muted">est. {formatCost(run.cost)}</span>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
          <div
            className={`h-full rounded-full bg-gradient-to-r ${active ? "from-accent-light to-accent" : run.status === "error" ? "from-warn to-red-500" : "from-emerald-400 to-success"}`}
            style={{ width: `${Math.max(2, pct)}%` }}
          />
        </div>
        <span className="font-mono text-[11px] text-muted">{run.processedCount.toLocaleString()} / {run.totalCount.toLocaleString()}</span>
        {run.status === "running" && run.etaSeconds !== undefined && run.etaSeconds > 0 && (
          <span className="flex items-center gap-1 font-mono text-[11px] text-muted">
            <Icon name="clock" className="h-3 w-3" /> ETA {run.etaSeconds}s
          </span>
        )}
      </div>
      {run.status === "running" && run.stageDetail && <p className="mt-1.5 text-[11px] text-faint">{run.stageDetail}</p>}
    </Link>
  );
}

function BulkPage() {
  const [runs, setRuns] = useState<BulkRunSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const active = runs.filter((r) => r.status === "queued" || r.status === "running");
  const history = runs.filter((r) => !active.includes(r));

  const refresh = useCallback(() => {
    void listBulkRuns().then((list) => {
      setRuns(list);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="space-y-6">
      <SectionHead
        eyebrow="Bulk Analysis"
        title="Process thousands of prospects, asynchronously"
        desc="Upload a CSV or run provider discovery — the server scores and enriches in batches of 100, with honest cost control and clearly-labeled mock mode."
      />

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <StartRunCard onStarted={() => refresh()} />
        </div>
        <div className="space-y-4 lg:col-span-3">
          {active.length > 0 && (
            <Card className="p-5">
              <p className="eyebrow mb-3">Active runs</p>
              <div className="space-y-2.5">
                {active.map((r) => <RunRow key={r.id} run={r} />)}
              </div>
            </Card>
          )}

          <Card className="p-5">
            <div className="flex items-center justify-between">
              <p className="eyebrow mb-3">Run history</p>
              {!loaded && <span className="text-xs text-faint">loading…</span>}
            </div>
            {history.length === 0 && loaded ? (
              <p className="text-xs text-muted">
                No runs yet. Upload a CSV or run provider discovery, then hit <span className="text-fg">Start bulk run</span> — the run continues in the background and you can leave this page.
              </p>
            ) : (
              <div className="space-y-2.5">
                {history.map((r) => <RunRow key={r.id} run={r} />)}
              </div>
            )}
          </Card>

          <details className="glass p-4">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-label text-muted hover:text-fg">How a run works</summary>
            <p className="mt-2.5 text-xs leading-relaxed text-muted">
              Every company moves <span className="text-fg">Queued → Processing → Scoring → Enriching → Verifying → Complete</span> (or Error).
              Scoring is free and runs for every row; the paid enrichment waterfall only touches prospects at or above the fit gate, cheapest providers first,
              capped by maxEnrichPerRun. Results persist server-side (data/bulk) and are served 50 per page — the browser never holds the full set.
            </p>
          </details>
        </div>
      </div>
    </div>
  );
}
