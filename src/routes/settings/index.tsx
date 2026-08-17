/**
 * Settings — pipeline behavior: fit threshold, cost-control rules for
 * enrichment, dry-run (mock provider) mode, and LLM parser adapter status.
 * All stored locally for the V1; the server reports what's actually configured
 * (keys stay on the server).
 */

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Badge, Card, Icon, SectionHead } from "~/components/ui";
import { RoleNotAllowed } from "~/components/AuthGate";
import { guardModule } from "~/lib/authServer";
import { DEFAULT_COST_RULES, DEFAULT_FIT_THRESHOLD } from "~/lib/fitScore";
import { loadJson, saveJson, getDryRun, setDryRun } from "~/lib/store";
import { getRuntimeConfig, type RuntimeConfig } from "~/lib/runtime";
import { getWebhookConfig, getSecretsStatus, type WebhookConfigResult } from "~/lib/webhookServer";

export const Route = createFileRoute("/settings/")({
  component: SettingsPage,
});

type GuardState = "loading" | "allowed" | "denied";

function NumberField({ label, desc, value, onChange, suffix }: { label: string; desc: string; value: number; onChange: (n: number) => void; suffix?: string }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-white/5 py-3">
      <div>
        <p className="text-sm font-medium text-fg">{label}</p>
        <p className="mt-0.5 text-xs text-muted">{desc}</p>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={value}
          min={0}
          max={100}
          onChange={(e) => onChange(Math.max(0, Math.min(100, +e.target.value || 0)))}
          className="input-dark w-20 px-2 py-1.5 text-center font-mono text-sm"
        />
        {suffix && <span className="text-xs text-muted">{suffix}</span>}
      </div>
    </div>
  );
}

/** Small inline copy-to-clipboard button (plaintext values on the owner's page). */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    };
    try {
      await navigator.clipboard.writeText(text);
      done();
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        done();
      } catch {
        /* ignore */
      }
      ta.remove();
    }
  };
  return (
    <button type="button" onClick={copy} className="shrink-0 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] font-medium text-muted transition hover:text-fg" title="Copy to clipboard">
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function ConfigRow({ label, value, copyText }: { label: string; value: string; copyText?: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-label text-faint">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 font-mono text-xs text-fg" title={copyText ?? value}>
          {value}
        </code>
        {copyText !== undefined && <CopyButton text={copyText} />}
      </div>
    </div>
  );
}

function SettingsPage() {
  const [guard, setGuard] = useState<GuardState>("loading");
  useEffect(() => {
    guardModule({ data: { module: "settings" } })
      .then((r) => setGuard(r.allowed ? "allowed" : "denied"))
      .catch(() => setGuard("denied"));
  }, []);

  if (guard === "loading") return <p className="py-20 text-center text-xs text-muted">Checking access…</p>;
  if (guard === "denied") return <RoleNotAllowed />;
  return <SettingsContent />;
}

function SettingsContent() {
  const [fitThreshold, setFitThreshold] = useState(() => loadJson("op-leados-settings", { fitThreshold: DEFAULT_FIT_THRESHOLD }).fitThreshold);
  const [costRules, setCostRules] = useState(() => loadJson("op-leados-costrules", DEFAULT_COST_RULES));
  const [dryRun, setDryRunState] = useState(getDryRun());
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null);
  const [webhook, setWebhook] = useState<WebhookConfigResult | null>(null);
  const [secrets, setSecrets] = useState<{ crmApiKeyPresent: boolean; leadosKeyOverride: boolean } | null>(null);
  const [saved, setSaved] = useState(false);

  useMemo(() => {
    getRuntimeConfig().then(setRuntime).catch(() => undefined);
    getWebhookConfig().then(setWebhook).catch(() => null);
    getSecretsStatus().then(setSecrets).catch(() => null);
  }, []);

  const persist = () => {
    saveJson("op-leados-settings", { fitThreshold });
    saveJson("op-leados-costrules", costRules);
    setDryRun(dryRun);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="space-y-6">
      <SectionHead
        eyebrow="Settings"
        title="Pipeline behavior & cost control"
        desc="Search broad, enrich narrow. These rules decide what gets scored, what qualifies, and when paid enrichment is allowed to run — including dry-run mode to test the waterfall without spending."
      />

      <Card className="p-6">
        <p className="eyebrow mb-2">Fit threshold</p>
        <NumberField
          label="Minimum fit score to surface"
          desc="Prospects below this score are scored but filtered out of ranked results (default 55)."
          value={fitThreshold}
          onChange={(n) => { setFitThreshold(n); setSaved(false); }}
          suffix="/ 100"
        />
      </Card>

      <Card className="p-6">
        <p className="eyebrow mb-2">Enrichment cost rules (paid calls)</p>
        <NumberField label="Only verify email above fit" desc="Email verification (Hunter) only runs for prospects with fit ≥ this score." value={costRules.onlyVerifyEmailAboveFit} onChange={(n) => { setCostRules({ ...costRules, onlyVerifyEmailAboveFit: n }); setSaved(false); }} suffix="/ 100" />
        <NumberField label="Only enrich phone above fit" desc="Phone lookup/enrichment only for fit ≥ this score." value={costRules.onlyEnrichPhoneAboveFit} onChange={(n) => { setCostRules({ ...costRules, onlyEnrichPhoneAboveFit: n }); setSaved(false); }} suffix="/ 100" />
        <NumberField label="Only enrich company above fit" desc="Full company enrichment (Apollo / PDL / Google) only for fit ≥ this score. Below it, a prospect is never enriched." value={costRules.onlyEnrichCompanyAboveFit} onChange={(n) => { setCostRules({ ...costRules, onlyEnrichCompanyAboveFit: n }); setSaved(false); }} suffix="/ 100" />
        <NumberField label="Max enrichments per run" desc="Hard cap on total provider calls per pipeline run." value={costRules.maxEnrichPerRun} onChange={(n) => { setCostRules({ ...costRules, maxEnrichPerRun: Math.max(0, Math.min(500, n)) }); setSaved(false); }} suffix="calls" />
        <div className="mt-4 flex items-center gap-3">
          <button type="button" onClick={persist} className="btn-primary">Save rules</button>
          {saved && <span className="text-xs text-success">Saved to this browser.</span>}
        </div>
        <p className="mt-3 text-xs text-muted">The waterfall honors these gates: below onlyEnrichCompanyAboveFit a prospect is never touched; email verification and phone enrichment have their own higher gates; maxEnrichPerRun stops the run.</p>
      </Card>

      <Card className="p-6">
        <p className="eyebrow mb-3">Dry run (mock providers)</p>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 bg-white/[.03] px-3 py-2 text-sm text-fg">
            <input type="checkbox" checked={dryRun} onChange={(e) => { setDryRunState(e.target.checked); setSaved(false); }} className="accent-[#8b5cf6]" />
            Dry run — mock providers, no real API calls
          </label>
          <Badge variant="mock">mock data clearly labeled</Badge>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          With dry run on, every provider serves clearly-labeled canned responses (badge <Badge variant="mock" className="text-[10px]">mock</Badge>, provenance source{" "}
          <span className="font-mono text-faint">mock:&lt;provider&gt;</span>) so the full waterfall — discovery, company enrichment, decision makers, email find/verify, phone verify, cost rules, dedupe and stop rules — runs end to end with zero keys and zero spend.
          The server can also force this via <span className="font-mono text-faint">ENABLE_PROVIDER_MOCKS=true</span>. Mock data is never presented as real.
        </p>
      </Card>

      <Card className="p-6">
        <p className="eyebrow mb-3">AI parsing adapter</p>
        <div className="flex items-center gap-3">
          {runtime?.llm.configured ? (
            <Badge variant="green"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> LLM parsing active ({runtime.llm.provider})</Badge>
          ) : (
            <Badge variant="amber">LLM parsing not configured — rule-based parser active</Badge>
          )}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          Set <span className="font-mono text-faint">OPENAI_API_KEY</span> (and optionally <span className="font-mono text-faint">OPENAI_BASE_URL</span> / <span className="font-mono text-faint">OPENAI_MODEL</span>) in Secrets and natural-language parsing upgrades to the LLM adapter automatically — no rebuild. Without a key, the deterministic rule-based parser handles queries like <em>“Find commercial real estate developers in Texas with 20–200 employees.”</em>
        </p>
      </Card>

      <Card className="p-6">
        <p className="eyebrow mb-1">CRM → Lead OS integration</p>
        <p className="mb-4 text-xs leading-relaxed text-muted">
          When a deal closes in the CRM, the CRM posts it to this webhook so Lead OS marks the prospect won and feeds real outcomes into insights. Events are idempotent on <span className="font-mono text-faint">dealId</span> — repeats update, never duplicate, so re-firing a missed webhook is safe. If an event seems to have been lost, re-fire it and check the public health endpoint below: it reports the last deal received, or no record at all (no webhook received since deployment). Unmatched deals are stored flagged (<span className="font-mono text-faint">matched: false</span>), never dropped.
        </p>
        {webhook && webhook.allowed ? (
          <div className="space-y-3">
            <ConfigRow label="Webhook URL" value={webhook.url} copyText={webhook.url} />
            <ConfigRow label="Method & auth header" value={`POST · ${webhook.headerFormat}`} copyText={webhook.headerFormat} />
            <ConfigRow label="Health check (public, GET)" value={webhook.healthUrl} copyText={webhook.healthUrl} />
            <div>
              <p className="flex items-center gap-2 text-[11px] uppercase tracking-label text-faint">
                API key
                {webhook.keySource === "env" && <Badge variant="amber">env override active</Badge>}
              </p>
              <div className="mt-1 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 font-mono text-xs text-fg" title={webhook.apiKey}>
                  {webhook.apiKey}
                </code>
                <CopyButton text={webhook.apiKey} />
              </div>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-label text-faint">Payload example (JSON)</p>
              <pre className="mt-1 overflow-x-auto rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-fg/90">
{JSON.stringify(webhook.payloadExample, null, 2)}
              </pre>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted">Webhook config is owner-only — sign in as owner to view.</p>
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-faint">
          Key generated once and stored server-side (<span className="font-mono">data/deals/apikey.txt</span>, 48 hex chars). Set <span className="font-mono">OPERION_LEADOS_API_KEY</span> in Secrets to override — that value becomes authoritative. The key is never logged and never leaves this page.
        </p>
        {secrets && (
          <p className="mt-2 text-[11px] text-faint">
            Server secrets check — <span className="font-mono">OPERION_CRM_API_KEY</span> present: {secrets.crmApiKeyPresent ? "yes" : "no"} · webhook key override active: {secrets.leadosKeyOverride ? "yes" : "no"}
          </p>
        )}
      </Card>

      <Card className="p-5 text-sm text-muted">
        <p className="flex items-center gap-2 text-fg"><Icon name="eye" className="h-4 w-4 text-accent-light" /> Notes</p>
        <ul className="mt-2 list-inside list-disc space-y-1 text-xs">
          <li>Prospects stay in this engine until pushed to Operion CRM — the CRM remains the system of record.</li>
          <li>Threshold, cost rules and dry run are stored per-browser for V1; they move server-side with multi-user settings.</li>
          <li>Mock data is always labeled mock — real prospects come from your CSV imports, provider discovery, and website intelligence.</li>
        </ul>
      </Card>
    </div>
  );
}
