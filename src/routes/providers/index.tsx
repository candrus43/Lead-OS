/**
 * Providers & Data — CSV import (works with zero API keys) + provider registry
 * status + last-run usage/cost tracking. Apollo / Google Places / Hunter /
 * People Data Labs activate from env secrets when keys exist; in dry-run mode
 * they serve clearly-labeled mock data. The app runs fine with none configured.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, Icon, SectionHead } from "~/components/ui";
import { RoleNotAllowed } from "~/components/AuthGate";
import { guardModule } from "~/lib/authServer";
import { parseCsv } from "~/lib/csv";
import { addImportedProspects, clearImportedProspects, getImportedProspects, getLastUsage } from "~/lib/store";
import { rowToProspect } from "~/lib/providers";
import { getRuntimeConfig, type RuntimeConfig } from "~/lib/runtime";
import { formatCost } from "~/lib/enrich";
import type { ProviderDef } from "~/lib/providers";
import type { EnrichmentRunReport } from "~/lib/enrich";

export const Route = createFileRoute("/providers/")({
  component: ProvidersPage,
});

type GuardState = "loading" | "allowed" | "denied";

const CSV_SAMPLE = `company,industry,sub_industry,city,state,employees,revenue,website,contact_name,title,email,phone
Example Ventures,Real Estate,Commercial Real Estate Development,Austin,TX,51-200,30M,example.example.com,Jane Smith,VP Operations,jane@example.example.com,+1 (555) 000-0100`;

const CAP_LABEL: Record<string, string> = {
  discoverCompanies: "Discover companies",
  enrichCompany: "Enrich company",
  findDecisionMakers: "Decision makers",
  findEmail: "Email find",
  verifyEmail: "Email verify",
  verifyPhone: "Phone verify",
  importRows: "CSV import",
};

function ProviderCard({ def }: { def: ProviderDef }) {
  const active = def.status === "active";
  const mock = def.status === "mock";
  return (
    <Card className={`p-5 ${active ? "ring-1 ring-success/20" : mock ? "ring-1 ring-warn/25" : "opacity-90"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-fg">{def.name}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">{def.description}</p>
        </div>
        {active ? (
          <Badge variant="green"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> Active</Badge>
        ) : mock ? (
          <Badge variant="mock">Mock (dry run)</Badge>
        ) : (
          <Badge variant="amber">Not configured</Badge>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {def.capabilities.map((c) => (
          <span key={c} className={`badge text-[10px] ${active || mock ? "badge-violet" : ""}`}>{c}</span>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-faint">
        {def.envKeys.length ? `Env: ${def.envKeys.join(", ")}` : "Always available — no keys needed"}
        {mock && <span className="text-warn"> · serving labeled mock data</span>}
      </p>
    </Card>
  );
}

function UsageSection({ report }: { report: EnrichmentRunReport }) {
  const perProvider = new Map<string, { calls: number; cost: number; mock: boolean; caps: Map<string, number> }>();
  for (const e of report.usage) {
    const row = perProvider.get(e.provider) ?? { calls: 0, cost: 0, mock: e.mock, caps: new Map<string, number>() };
    row.calls += e.calls;
    row.cost += e.cost;
    row.caps.set(e.capability, (row.caps.get(e.capability) ?? 0) + e.calls);
    perProvider.set(e.provider, row);
  }
  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="eyebrow">Last enrichment run</p>
        <div className="flex flex-wrap items-center gap-2">
          {report.mock && <Badge variant="mock">mock — dry run</Badge>}
          {report.stoppedReason && <Badge variant="amber">{report.stoppedReason}</Badge>}
          <span className="font-mono text-xs text-muted">{new Date(report.ranAt).toLocaleString()}</span>
        </div>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead>
            <tr className="border-b border-white/5">
              {["Provider", "Calls this run", "Est. cost", "Capabilities used"].map((h) => (
                <th key={h} className="px-3 py-2 text-xs font-semibold uppercase tracking-label text-muted">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...perProvider.entries()].map(([id, row]) => (
              <tr key={id} className="border-b border-white/5">
                <td className="px-3 py-3 font-medium capitalize text-fg">{id.replace(/-/g, " ")}{row.mock && <Badge variant="mock" className="ml-2 text-[10px]">mock</Badge>}</td>
                <td className="px-3 py-3 font-mono text-muted">{row.calls}</td>
                <td className="px-3 py-3 font-mono text-muted">{formatCost(row.cost)}</td>
                <td className="px-3 py-3 text-xs text-muted">
                  {[...row.caps.entries()].map(([cap, n]) => `${CAP_LABEL[cap] ?? cap} ×${n}`).join(" · ")}
                </td>
              </tr>
            ))}
            {report.usage.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-4 text-xs text-muted">No provider calls were made on the last run (nothing qualified or no provider usable).</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted">
        <span><span className="font-mono text-fg">{report.totalCalls}</span> total calls</span>
        <span>estimated cost <span className="font-mono text-fg">{formatCost(report.totalCost)}</span></span>
        <span><span className="font-mono text-success">{report.enrichedCount}</span> enriched</span>
        <span><span className="font-mono text-warn">{report.skippedCount}</span> skipped</span>
        {!report.mock && <span className="text-faint">estimates only — real billing depends on provider plan pricing</span>}
      </div>
    </Card>
  );
}

function ProvidersPage() {
  const [guard, setGuard] = useState<GuardState>("loading");
  useEffect(() => {
    guardModule({ data: { module: "providers" } })
      .then((r) => setGuard(r.allowed ? "allowed" : "denied"))
      .catch(() => setGuard("denied"));
  }, []);

  if (guard === "loading") return <p className="py-20 text-center text-xs text-muted">Checking access…</p>;
  if (guard === "denied") return <RoleNotAllowed />;
  return <ProvidersContent />;
}

function ProvidersContent() {
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [csvText, setCsvText] = useState("");
  const [imported, setImported] = useState<{ n: number; names: string[] } | null>(null);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useMemo(() => {
    getRuntimeConfig().then((r) => { setRuntime(r); setStatus("ready"); }).catch(() => setStatus("error"));
  }, []);

  const existing = getImportedProspects();
  const lastUsage = getLastUsage();

  const importCsv = (text: string) => {
    const rows = parseCsv(text);
    if (!rows.length) {
      setError("No rows found — expected a header row like: company,industry,city,state,employees,email");
      return;
    }
    const prospects = rows
      .map((r) => rowToProspect(r, "csv", false))
      .filter((p): p is NonNullable<typeof p> => p !== null);
    if (!prospects.length) {
      setError("No valid rows (a non-empty company column is required)");
      return;
    }
    addImportedProspects(prospects);
    setImported({ n: prospects.length, names: prospects.map((p) => p.companyName.value).slice(0, 6) });
    setCsvText("");
    setError("");
  };

  const onFile = (f: File) => {
    const reader = new FileReader();
    reader.onload = () => importCsv(String(reader.result ?? ""));
    reader.readAsText(f);
  };

  return (
    <div className="space-y-6">
      <SectionHead
        eyebrow="Providers & Data"
        title="Plug in data sources — or import your own"
        desc="Search broad, enrich narrow. CSV works today with zero API keys; paid providers activate automatically when their keys exist in Secrets. Dry-run mock providers let you exercise the full waterfall with no keys and no spend. Every row lands with honest provenance."
        right={runtime?.mockMode ? <Badge variant="mock">Server dry-run mode on (ENABLE_PROVIDER_MOCKS)</Badge> : undefined}
      />

      {/* CSV import */}
      <Card className="p-6" glow>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 font-semibold text-fg"><Icon name="upload" className="h-4 w-4 text-accent-light" /> CSV import</p>
            <p className="mt-1 text-sm text-muted">Paste rows or upload a file. Recognized columns: company, industry, sub_industry, city, state, country, employees, revenue, website, contact_name, title, email, phone.</p>
          </div>
          <div className="flex gap-2">
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            <Button variant="ghost" onClick={() => fileRef.current?.click()}>Upload file</Button>
          </div>
        </div>
        <textarea
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          placeholder={CSV_SAMPLE}
          className="input-dark mt-4 h-40 resize-y font-mono text-xs leading-relaxed"
          aria-label="Paste CSV rows"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button onClick={() => importCsv(csvText)} disabled={!csvText.trim()}>
            <Icon name="database" className="h-4 w-4" /> Import {csvText.trim() ? "rows" : ""}
          </Button>
          <button type="button" onClick={() => setCsvText(CSV_SAMPLE)} className="text-xs text-muted underline hover:text-fg">Fill with example format</button>
          {error && <p className="text-xs text-danger">{error}</p>}
          {imported && (
            <p className="text-xs text-success">
              Imported {imported.n} prospect{imported.n === 1 ? "" : "s"}: {imported.names.join(", ")}{imported.n > 6 ? "…" : ""} — tagged Unverified until enriched.
            </p>
          )}
        </div>
        {existing.length > 0 && (
          <div className="mt-4 flex items-center justify-between border-t border-white/5 pt-4">
            <p className="text-xs text-muted"><span className="font-medium text-fg">{existing.length}</span> imported prospect{existing.length === 1 ? "" : "s"} in the engine · <Link to="/prospects" className="text-accent-light underline">view ranked</Link></p>
            <button type="button" onClick={() => { clearImportedProspects(); setImported(null); window.location.reload(); }} className="text-xs text-muted underline hover:text-danger">Clear imports</button>
          </div>
        )}
      </Card>

      {/* Provider registry */}
      <div>
        <p className="eyebrow mb-3">Provider registry{status === "loading" ? " — checking configured keys…" : ""}</p>
        {status === "error" && <p className="mb-3 text-xs text-amber">Couldn&apos;t reach the runtime config endpoint — showing defaults.</p>}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(runtime?.providers ?? []).map((d) => <ProviderCard key={d.id} def={d} />)}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-muted">
          Keys are read from environment secrets on the server — they never appear in the browser. Add <span className="font-mono text-faint">GOOGLE_PLACES_API_KEY</span>,{" "}
          <span className="font-mono text-faint">APOLLO_API_KEY</span>, <span className="font-mono text-faint">HUNTER_API_KEY</span>, or <span className="font-mono text-faint">PDL_API_KEY</span> and the provider activates on the next load. Set{" "}
          <span className="font-mono text-faint">ENABLE_PROVIDER_MOCKS=true</span> or use the Settings dry-run switch to exercise the waterfall without keys.
        </p>
      </div>

      {/* Usage / cost */}
      {lastUsage && <UsageSection report={lastUsage} />}

      {/* Cost map */}
      <Card className="p-6">
        <p className="eyebrow mb-3">Estimated per-call cost model (planning only)</p>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {(runtime?.costMap ? Object.entries(runtime.costMap) : []).map(([id, caps]) => (
            <div key={id} className="rounded-xl border border-white/5 bg-white/[.02] p-3">
              <p className="text-sm font-medium capitalize text-fg">{id.replace(/-/g, " ")}</p>
              <ul className="mt-1.5 space-y-1 text-[11px] text-muted">
                {Object.entries(caps).map(([cap, cost]) => (
                  <li key={cap} className="flex justify-between gap-2">
                    <span>{CAP_LABEL[cap] ?? cap}</span>
                    <span className="font-mono text-faint">{formatCost(cost ?? 0)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-muted">
          Defaults reflect public list pricing (Google Places ~$0.03/text search; Hunter ~$0.05 email find; PDL ~$0.025–0.05; Apollo ~1 credit ≈ $0.01). Override any value server-side with{" "}
          <span className="font-mono text-faint">COST_&lt;PROVIDER&gt;_&lt;CAPABILITY&gt;</span> env vars. No money moves without a configured key.
        </p>
      </Card>

      {/* Compliance note */}
      <Card className="p-5">
        <p className="flex items-center gap-2 text-sm font-medium text-fg"><Icon name="shield" className="h-4 w-4 text-success" /> Compliance guardrails</p>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Official APIs, licensed B2B data, public business data and your own CSVs only. No scraping, no CAPTCHA bypass, no mass unsolicited messaging.
          Enrichment is gated by cost rules (Settings) — paid calls only for high-fit prospects, and mock data is never presented as real.
        </p>
      </Card>
    </div>
  );
}
