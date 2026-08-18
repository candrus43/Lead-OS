/**
 * Prospect Search — natural-language query → structured filters → pipeline →
 * ranked results. Then the enrichment waterfall: discover from providers
 * (Google Places / Apollo), enrich the top prospects (cheapest providers first,
 * gated by the Settings cost rules), and show usage/cost. Dry-run (mock) mode
 * exercises the whole waterfall with zero keys — mock data is always labeled.
 */

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Badge, Button, Card, Icon, Modal, SectionHead, useModal } from "~/components/ui";
import { ProspectTable } from "~/components/prospectTable";
import { parseQuery } from "~/lib/parser";
import { runPipeline, type PipelineResult } from "~/lib/pipeline";
import { computeDiscoveryFit, DEFAULT_COST_RULES } from "~/lib/fitScore";
import { addImportedProspects, getImportedProspects, loadJson, getSavedSearches, saveSavedSearch, deleteSavedSearch } from "~/lib/store";
import { getDryRun, getEnrichedMap, mergeEnrichedResults, saveLastUsage, setDryRun } from "~/lib/store";
import { discoverFromProviders, runEnrichment } from "~/lib/enrichServer";
import { analyzeCompanyWebsite } from "~/lib/siteIntelServer";
import { getRuntimeConfig, type RuntimeConfig } from "~/lib/runtime";
import { domainOf } from "~/lib/providers/http";
import { formatCost } from "~/lib/enrich";
import type { EnrichmentRunReport } from "~/lib/enrich";
import type { Prospect, SavedSearch, SearchFilters } from "~/lib/types";

export const Route = createFileRoute("/search")({
  validateSearch: (s: Record<string, unknown>) => ({ q: typeof s.q === "string" ? s.q : "" }),
  component: SearchPage,
});

const EXAMPLES = [
  "Find commercial real estate developers in Texas with 20–200 employees",
  "Hospitality groups with multiple locations and rapid growth",
  "Construction companies in Dallas with high project volume",
  "Multi-unit franchise operators in Texas",
];

function FiltersPanel({ filters, notes, label }: { filters: SearchFilters; notes: string[]; label?: string }) {
  const items: [string, string][] = [
    ["Industry", filters.industry ?? "—"],
    ["Sub-industry", filters.subIndustry ?? "—"],
    ["Location", filters.location ? `${filters.location.city ?? ""} ${filters.location.state ?? ""}`.trim() || "—" : "—"],
    ["Employees", filters.employeeMin !== undefined || filters.employeeMax !== undefined ? `${filters.employeeMin ?? "0"}–${filters.employeeMax ?? "∞"}` : "—"],
    ["Revenue", filters.revenueMin !== undefined || filters.revenueMax !== undefined ? `${filters.revenueMin ?? "0"}–${filters.revenueMax ?? "∞"}M` : "—"],
    ["Title / seniority", filters.title ?? "—"],
    ["Keywords", filters.keywords?.join(", ") ?? "—"],
  ];
  return (
    <div className="mt-4 border-t border-white/5 pt-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="eyebrow">Parsed filters</p>
        {label && <span className="text-[11px] uppercase tracking-label text-muted">{label}</span>}
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
        {items.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <p className="text-[11px] uppercase tracking-label text-faint">{k}</p>
            <p className="truncate text-sm text-fg" title={v}>{v}</p>
          </div>
        ))}
      </div>
      {notes.length > 0 && (
        <p className="mt-3 text-xs text-muted">
          <span className="text-faint">Understood:</span> {notes.join(" · ")}
        </p>
      )}
    </div>
  );
}

function EnrichmentBanner({ report }: { report: EnrichmentRunReport }) {
  return (
    <Card className="p-4" glow>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-fg">
            <Icon name="bolt" className="h-4 w-4 text-accent-light" /> Enrichment waterfall
          </p>
          {report.mock && <Badge variant="mock">mock — dry run, no credits spent</Badge>}
          {report.stoppedReason && <Badge variant="amber">stopped: {report.stoppedReason}</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-4 font-mono text-sm">
          <span className="text-muted"><span className="text-fg">{report.totalCalls}</span> calls</span>
          <span className="text-muted">est. <span className="text-fg">{formatCost(report.totalCost)}</span></span>
          <span className="text-muted"><span className="text-success">{report.enrichedCount}</span> enriched</span>
          <span className="text-muted"><span className="text-warn">{report.skippedCount}</span> skipped</span>
        </div>
      </div>
      <p className="mt-2.5 text-xs leading-relaxed text-muted">
        Cheapest providers ran first (Google Places → PDL/Apollo → Hunter). Skips are gated by the cost rules and dedupe — details on each prospect page and under Providers &amp; Data.
      </p>
    </Card>
  );
}

/**
 * Website Intelligence — paste a company URL, the server fetches the public
 * site (≤ 6 pages, plain fetch), extracts evidence, scores the fit, and creates
 * a prospect. Zero API keys. Duplicate domains are surfaced instead of silently
 * duplicated.
 */
function WebsiteIntelCard() {
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [duplicate, setDuplicate] = useState<{ id: string; name: string; domain: string } | null>(null);
  const pending = useRef<Prospect | null>(null);

  const findDuplicate = (p: Prospect) => {
    const d = domainOf(p.website?.value);
    if (!d) return null;
    const found = getImportedProspects().find((x) => domainOf(x.website?.value) === d);
    return found ? { id: found.id, name: found.companyName.value, domain: d } : null;
  };

  const saveAndGo = (p: Prospect) => {
    addImportedProspects([p]);
    navigate({ to: "/prospects/$id", params: { id: p.id } });
  };

  const analyze = async () => {
    const raw = url.trim();
    if (!raw || running) return;
    setRunning(true);
    setError("");
    setDuplicate(null);
    pending.current = null;
    try {
      const res = await analyzeCompanyWebsite({ data: { url: raw } });
      if (!res.ok) {
        setError(
          res.error === "invalid-url"
            ? "That doesn't look like a valid public URL."
            : res.error === "not-html"
              ? "That URL didn't return an HTML page — check the URL (it may be a file or an API endpoint)."
              : "Couldn't fetch — check the URL. The site may be down, blocked, or too slow."
        );
        return;
      }
      const dup = findDuplicate(res.prospect);
      if (dup) {
        pending.current = res.prospect;
        setDuplicate(dup);
        return;
      }
      saveAndGo(res.prospect);
    } catch {
      setError("Analysis failed — try again in a moment.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-fg">
          <Icon name="eye" className="h-4 w-4 text-accent-light" /> Website Intelligence
        </p>
        <Badge variant="violet">zero API keys</Badge>
        <span className="text-xs text-muted">
          Paste a company URL — Operion reads the public site (≤ 6 pages, plain fetch, no scraping), scores the fit, and creates a prospect with provenance.
        </span>
      </div>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void analyze();
            }
          }}
          placeholder="https://company.com"
          className="input-dark font-mono"
          aria-label="Company website URL"
        />
        <Button onClick={() => void analyze()} disabled={running || !url.trim()} className="sm:w-auto">
          <Icon name="eye" className="h-4 w-4" /> {running ? "Analyzing…" : "Analyze website"}
        </Button>
      </div>
      {error && <p className="mt-3 text-xs text-danger">{error}</p>}
      {duplicate && (
        <div className="mt-3 rounded-xl border border-warn/30 bg-warn/10 p-3 text-sm">
          <p className="text-warn">
            This domain ({duplicate.domain}) is already in your prospects as <span className="font-medium text-fg">{duplicate.name}</span>. Open the existing record instead of duplicating?
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => navigate({ to: "/prospects/$id", params: { id: duplicate.id } })}>
              Open existing
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                if (pending.current) {
                  const p = pending.current;
                  pending.current = null;
                  setDuplicate(null);
                  saveAndGo(p);
                }
              }}
            >
              Analyze anyway (duplicate)
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * Saved searches — a pinned query + its parsed filters. Clicking re-runs the
 * query against the live pool. Persisted in localStorage (op-leados-* pattern).
 */
function SavedSearchesPanel({ searches, onRun, onDelete }: { searches: SavedSearch[]; onRun: (ss: SavedSearch) => void; onDelete: (id: string) => void }) {
  return (
    <Card className="p-4">
      <p className="eyebrow mb-3">Saved searches</p>
      {searches.length === 0 ? (
        <p className="text-xs text-muted">
          Run a search and hit <span className="text-fg">Save this search</span> to pin it here. Saved searches also appear on the dashboard.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {searches.map((ss) => (
            <div key={ss.id} className="group flex items-center gap-3 rounded-xl border border-white/5 bg-white/[.02] px-3 py-2">
              <button type="button" onClick={() => onRun(ss)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <Icon name="search" className="h-3.5 w-3.5 shrink-0 text-accent-light" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-fg">{ss.name}</span>
                  <span className="block truncate text-xs text-muted" title={ss.query}>{ss.query}</span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => onDelete(ss.id)}
                className="shrink-0 rounded-lg p-1.5 text-muted opacity-0 transition hover:bg-white/5 hover:text-danger group-hover:opacity-100"
                aria-label={`Delete saved search ${ss.name}`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function SearchPage() {
  const { q } = Route.useSearch();
  const navigate = useNavigate();
  const [query, setQuery] = useState(q);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [parserLabel, setParserLabel] = useState<string>("");
  const [dryRun, setDryRunState] = useState(getDryRun());
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<Prospect[]>([]);
  const [discoverNote, setDiscoverNote] = useState("");
  const [discoverErrors, setDiscoverErrors] = useState<string[]>([]);
  const [enriching, setEnriching] = useState(false);
  const [report, setReport] = useState<EnrichmentRunReport | null>(null);
  const [enrichError, setEnrichError] = useState("");
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>(getSavedSearches());
  const saveModal = useModal();
  const [saveName, setSaveName] = useState("");
  const [justSaved, setJustSaved] = useState(false);

  /** Provider registry status from the server (booleans + defs only — no keys),
   *  so we know whether discovery can produce anything before auto-running it. */
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null);
  /** In-flight guard mirroring `discovering` — safe to read synchronously from
   *  async continuations before React re-renders. */
  const discoveringRef = useRef(false);
  /** Fingerprint of the search that discovery last ran for (auto OR manual) —
   *  auto-discovery never runs twice for the same search. */
  const discoveryRanKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    getRuntimeConfig()
      .then((r) => {
        if (alive) setRuntime(r);
      })
      .catch(() => {
        // Runtime config unavailable — auto-discovery stays off; the manual
        // "Discover from providers" button keeps working as before.
      });
    return () => {
      alive = false;
    };
  }, []);

  /** True when Google Places or Apollo can currently produce results: a real
   *  server key ("active"), server mock mode ("mock"), or the client Dry-run
   *  toggle (servers get mock providers for the run). "not-configured" plus
   *  dry-run off means discovery would find nothing — keep the manual flow. */
  const discoveryUsable = useMemo(() => {
    if (!runtime) return false;
    return runtime.providers.some(
      (p) =>
        (p.id === "google-places" || p.id === "apollo") &&
        (p.status === "active" || p.status === "mock" || dryRun) &&
        p.capabilities.includes("discoverCompanies")
    );
  }, [runtime, dryRun]);

  const preview = useMemo(() => (query.trim() ? parseQuery(query) : null), [query]);

  /** After a run completes, show the ACTUAL parser output the pipeline used —
   *  server-side (LLM when OPENAI_API_KEY is configured, else rules) — not the
   *  client-side heuristic preview. Before any run, the heuristic preview stays
   *  as a live "as you type" hint. */
  const shown = result ? { filters: result.filters, notes: result.notes } : preview;

  /** When landing with a query in the URL (e.g. from a saved search on the
   *  dashboard), run it once on mount. */
  useEffect(() => {
    if (q.trim() && !result && !loading) {
      void run(q);
    }
    // mount-only: the saved-search / example buttons drive their own runs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveSearch = () => {
    if (!result || !saveName.trim()) return;
    const ss: SavedSearch = {
      id: `ss-${Date.now()}`,
      name: saveName.trim(),
      query: query.trim(),
      filters: result.filters,
      createdAt: new Date().toISOString(),
    };
    setSavedSearches(saveSavedSearch(ss));
    setSaveName("");
    setJustSaved(true);
    saveModal.closeModal();
  };

  const runSaved = (ss: SavedSearch) => {
    setQuery(ss.query);
    navigate({ to: "/search", search: { q: ss.query } });
    void run(ss.query);
  };

  const removeSaved = (id: string) => {
    setSavedSearches(deleteSavedSearch(id));
  };

  const run = async (text: string) => {
    setLoading(true);
    setDiscovered([]);
    setReport(null);
    setDiscoverNote("");
    setDiscoverErrors([]);
    try {
      const res = await runPipeline({ query: text, limit: 50 });
      setResult(res);
      setParserLabel(res.parserUsed === "llm" ? "LLM parser" : res.parserUsed === "rules" ? "Rule-based parser" : "No filters — showing all");
      // One action, one flow: if the pool produced nothing and discovery can
      // produce something, run it now instead of dead-ending at "Nothing matched".
      await maybeAutoDiscover(res);
    } finally {
      setLoading(false);
    }
  };

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    submitSearch();
  };

  const submitSearch = () => {
    const text = query.trim();
    if (!text || loading) return;
    navigate({ to: "/search", search: { q: text } });
    void run(text);
  };

  /** Discovery — the exact flow the manual button has always run, shared so the
   *  auto-trigger after an empty search produces identical notes, error panels,
   *  and empty states. Never double-runs: guarded by the in-flight ref and by
   *  the per-search key (records both auto and manual runs). */
  /** Identity of a discovery run: the parsed filters + the mock flag. Running
   *  discovery for the same inputs twice adds nothing, so auto-discovery is
   *  keyed on this. */
  const discoveryKey = (filters: SearchFilters, mock: boolean) => `${JSON.stringify(filters)}|${mock ? "mock" : "real"}`;

  const runDiscover = async (filters: SearchFilters, key: string) => {
    if (discoveringRef.current) return;
    discoveringRef.current = true;
    discoveryRanKeyRef.current = key;
    setDiscovering(true);
    setDiscoverNote("");
    setDiscoverErrors([]);
    try {
      const res = await discoverFromProviders({ data: { filters, mock: dryRun } });
      setDiscoverErrors(res.providerErrors ?? []);
      if (!res.prospects.length) {
        setDiscoverNote(
          dryRun
            ? "Dry-run discovery returned nothing to show."
            : res.providerErrors?.length
              ? "Discovery returned no companies — see the provider message above."
              : res.providersAttempted?.length
                ? "Providers ran but found no companies for these filters — try a larger city, a different industry term, or fewer filters."
                : "No provider is configured (add GOOGLE_PLACES_API_KEY or APOLLO_API_KEY in Secrets) — or turn on Dry run in Settings to see mock discovery."
        );
        setDiscovered([]);
        return;
      }
      const scored = res.prospects.map((p) => ({ ...p, fit: computeDiscoveryFit(p, filters) }));
      setDiscovered(scored);
      // Name every provider that actually contributed, not just the first
      // result's source (previously Apollo's contribution was invisible).
      const perProvider = new Map<string, number>();
      for (const p of res.prospects) perProvider.set(p.sourceProvider, (perProvider.get(p.sourceProvider) ?? 0) + 1);
      const providerLabel = [...perProvider.entries()].map(([prov, n]) => `${n} via ${prov}`).join(" · ");
      setDiscoverNote(
        `${scored.length} company${scored.length === 1 ? "" : "s"} discovered — ${providerLabel}${res.mock ? " (mock)" : ""}. ` +
          "Fit scores are preliminary discovery estimates (segment · location · size + provider signals); enrich the top prospects to confirm fit and pull contacts."
      );
    } catch {
      setDiscoverErrors(["Discovery failed — providers may be unreachable. Results below are from the local pool."]);
      setDiscovered([]);
    } finally {
      discoveringRef.current = false;
      setDiscovering(false);
    }
  };

  /** Manual button — always runs for the current search, even if it already ran
   *  automatically (the user asked for more results). */
  const discover = () => {
    if (!result || discoveringRef.current) return;
    void runDiscover(result.filters, discoveryKey(result.filters, dryRun));
  };

  /** Auto-discovery: after a run scored zero pool prospects, continue straight
   *  into discovery when a provider can produce results — so an empty pool never
   *  leaves the owner at a "Nothing matched" dead end. Skipped when no provider
   *  is configured ("No provider is configured…" message preserved), when
   *  discovery is already in flight, or when discovery already ran for this
   *  search (same filters + same mock flag). */
  const maybeAutoDiscover = async (res: PipelineResult) => {
    if (res.totalScored !== 0) return; // pool had matches — manual discovery only
    if (discoveringRef.current) return; // discovery in flight
    const key = discoveryKey(res.filters, dryRun);
    if (discoveryRanKeyRef.current === key) return; // already ran for this search
    if (!discoveryUsable) return; // no provider configured / no dry run
    await runDiscover(res.filters, key);
  };

  const enrich = async () => {
    if (!enrichTargets.length) return;
    setEnriching(true);
    setEnrichError("");
    try {
      const costRules = loadJson("op-leados-costrules", DEFAULT_COST_RULES);
      const already = Object.keys(getEnrichedMap());
      const res = await runEnrichment({
        data: { prospects: enrichTargets, rules: costRules, mock: dryRun, skipIds: already },
      });
      mergeEnrichedResults(res.prospects);
      saveLastUsage(res);
      setReport(res);
    } catch (e) {
      setEnrichError(e instanceof Error ? e.message : "Enrichment failed");
    } finally {
      setEnriching(false);
    }
  };

  /** Everything enrichment can act on this run: discovered companies FIRST
   *  (they are the fresh results of this search), then pool matches, deduped
   *  by prospect id so the same company never appears twice. Previously the
   *  handler sent only result.prospects (the local pool — empty on a fresh
   *  search), so "Enrich top N" never touched discovery results and Apollo/
   *  Hunter decision-makers + emails could never come through. */
  const enrichTargets = useMemo(() => {
    const seen = new Map<string, Prospect>();
    for (const p of [...discovered, ...(result?.prospects ?? [])]) {
      if (!seen.has(p.id)) seen.set(p.id, p);
    }
    return [...seen.values()];
  }, [result, discovered]);

  /** Top-N the button promises: bounded by maxEnrichPerRun (the cost rule that
   *  actually caps the run) and defaulting to 25 like the original label. */
  const enrichN = useMemo(() => {
    if (!enrichTargets.length) return 0;
    const max = loadJson("op-leados-costrules", DEFAULT_COST_RULES).maxEnrichPerRun ?? 25;
    return Math.min(enrichTargets.length, Math.max(0, max));
  }, [enrichTargets]);

  const tableProspects = useMemo(() => {
    if (!result) return [];
    return enrichTargets; // discovered + pool, deduped — same set enrichment targets
  }, [enrichTargets, result]);

  return (
    <div className="space-y-6">
      <SectionHead
        eyebrow="Prospect Search"
        title="Tell me who to contact today"
        desc="Describe your ideal customer in plain language — Operion parses it into filters, scores every match, and enriches the best prospects with honest provenance."
      />

      {/* Search box + parsed filters — ONE coherent unit */}
      <Card className="p-5" glow>
        <form onSubmit={onSearch} className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Icon name="search" className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find commercial real estate developers in Texas with 20–200 employees"
              className="input-dark pl-11"
              aria-label="Natural-language search"
            />
          </div>
          <Button disabled={loading || !query.trim()} onClick={submitSearch} className="sm:w-auto">
            {loading ? "Scoring…" : "Run search"}
          </Button>
        </form>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted">Try:</span>
            {EXAMPLES.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => {
                  setQuery(e);
                  navigate({ to: "/search", search: { q: e } });
                  void run(e);
                }}
                className="badge cursor-pointer transition hover:border-accent/40 hover:bg-accent/10 hover:text-accent-light"
              >
                {e.length > 52 ? e.slice(0, 52) + "…" : e}
              </button>
            ))}
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={dryRun} onChange={(e) => { setDryRunState(e.target.checked); setDryRun(e.target.checked); }} className="accent-[#8b5cf6]" />
            Dry run <Badge variant="mock" className="text-[10px]">mock</Badge>
          </label>
        </div>
        {shown && (
          <FiltersPanel
            filters={shown.filters}
            notes={shown.notes}
            label={result ? parserLabel : "Live preview"}
          />
        )}
      </Card>

      {/* Secondary tools — compact, one row */}
      <div className="grid gap-4 lg:grid-cols-2">
        <WebsiteIntelCard />
        <SavedSearchesPanel searches={savedSearches} onRun={runSaved} onDelete={removeSaved} />
      </div>

      {result && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="violet"><Icon name="sparkle" className="h-3 w-3" /> {parserLabel}</Badge>
            <Badge>{result.totalScored} scored</Badge>
            <Badge variant="green">{result.prospects.length} passed fit ≥ {result.threshold}</Badge>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button variant="ghost" className="whitespace-nowrap px-3 py-1.5 text-xs" onClick={discover} disabled={discovering}>
                <Icon name="search" className="h-3.5 w-3.5" /> {discovering ? "Discovering…" : "Discover from providers"}
              </Button>
              <Button
                className="whitespace-nowrap px-3 py-1.5 text-xs"
                onClick={enrich}
                disabled={enriching || !enrichN}
              >
                <Icon name="bolt" className="h-3.5 w-3.5" />{" "}
                {enriching ? "Enriching…" : enrichN ? `Enrich top ${enrichN} (${dryRun ? "dry run" : "paid"})` : "Enrich top 0 (paid)"}
              </Button>
              <Button variant="ghost" className="whitespace-nowrap px-3 py-1.5 text-xs" onClick={() => { setJustSaved(false); saveModal.openModal(); }}>
                <Icon name="check" className="h-3.5 w-3.5" /> {justSaved ? "Saved ✓" : "Save this search"}
              </Button>
            </div>
          </div>
          {justSaved && <p className="text-xs text-success">Saved — it now appears in Saved searches here and on the dashboard.</p>}
          {dryRun && <p className="text-xs text-muted"><Badge variant="mock" className="text-[10px]">mock</Badge> providers active — no credits spent.</p>}
          {enrichError && <span className="text-xs text-danger">{enrichError}</span>}

          {discoverErrors.length > 0 && (
            <div className="rounded-xl border border-danger/30 bg-danger/10 p-3">
              <p className="text-xs font-semibold text-danger">
                Provider discovery error{discoverErrors.length > 1 ? "s" : ""}
              </p>
              {discoverErrors.map((m, i) => (
                <p key={i} className="mt-1 text-xs text-danger/90">{m}</p>
              ))}
            </div>
          )}
          {discoverNote && <p className="text-xs text-muted">{discoverNote}</p>}
          {report && <EnrichmentBanner report={report} />}

          <ProspectTable prospects={tableProspects} showSource />
          {result.totalScored === 0 && discovered.length === 0 && discoverErrors.length === 0 && (
            <Card className="p-5 text-center text-sm text-muted">
              Nothing matched. <Link to="/providers" className="text-accent-light underline">Import a CSV</Link> to bring your own prospects, or hit <span className="text-fg">Discover from providers</span> above.
            </Card>
          )}
        </div>
      )}

      {/* Save search modal */}
      <Modal open={saveModal.open} onClose={saveModal.closeModal} title="Save this search">
        <div className="space-y-3">
          <div className="rounded-xl border border-white/10 bg-white/[.03] p-3 text-sm">
            <p className="text-xs text-muted">Query</p>
            <p className="mt-0.5 text-fg">{query.trim()}</p>
            {result && (
              <>
                <p className="mt-2 text-xs text-muted">Parsed filters</p>
                <p className="mt-0.5 text-xs text-fg">
                  {result.filters.industry ?? "—"} · {result.filters.location ? `${result.filters.location.city ?? ""} ${result.filters.location.state ?? ""}`.trim() || "anywhere" : "anywhere"} ·{" "}
                  {result.filters.employeeMin !== undefined || result.filters.employeeMax !== undefined ? `${result.filters.employeeMin ?? 0}–${result.filters.employeeMax ?? "∞"} employees` : "any size"}
                </p>
              </>
            )}
          </div>
          <input
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveSearch(); } }}
            placeholder="Name this search (e.g. CRE developers in Texas)"
            className="input-dark"
            aria-label="Saved search name"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={saveModal.closeModal}>Cancel</Button>
            <Button onClick={saveSearch} disabled={!saveName.trim()}>Save search</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
