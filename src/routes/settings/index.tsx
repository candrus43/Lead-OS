/**
 * Settings — owner-only: team/agent roster management, pipeline behavior (fit
 * threshold, cost-control rules for enrichment), dry-run (mock provider) mode,
 * and LLM parser adapter status. All stored locally for the V1; the server
 * reports what's actually configured (keys stay on the server).
 */

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Badge, Card, Icon, Modal, SectionHead } from "~/components/ui";
import { RoleNotAllowed } from "~/components/AuthGate";
import { guardModule } from "~/lib/authServer";
import { createAgent, deleteAgent, listAgents, resetAgentPassword, updateAgent, type SanitizedAgent } from "~/lib/agentsServer";
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

/* ------------------------- Team / Agents card ------------------------------ */

const ROW_ACTION =
  "rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-muted transition hover:text-fg";

/** Owner-managed agent roster — add/remove accounts as people get hired.
 *  Server fns double-guard ownership; this page is already owner-only. */
function AgentsCard() {
  const [agents, setAgents] = useState<SanitizedAgent[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addUsername, setAddUsername] = useState("");
  const [addPassword, setAddPassword] = useState("");
  const [showAddPw, setShowAddPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState("");
  const [showResetPw, setShowResetPw] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const res = await listAgents();
      if (!res.allowed) {
        setLoadError("Only the owner can manage agents.");
        setAgents([]);
        return;
      }
      setAgents(res.agents);
      setLoadError("");
    } catch {
      setLoadError("Couldn't load the agent roster.");
      setAgents([]);
    }
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(""), 3200);
  };

  const submitAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await createAgent({ data: { name: addName, username: addUsername, password: addPassword } });
      if (!res.allowed) {
        setError("Only the owner can add agents.");
        return;
      }
      if (res.error) {
        setError(res.error);
        return;
      }
      setAddName("");
      setAddUsername("");
      setAddPassword("");
      setAddOpen(false);
      await refresh();
      flash(`Agent "${res.agent?.username}" created — they can sign in at /login.`);
    } catch {
      setError("Couldn't reach the server — try again.");
    } finally {
      setBusy(false);
    }
  };

  const doRename = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await updateAgent({ data: { id, name: renameValue } });
      if (!res.allowed) {
        setError("Only the owner can manage agents.");
        return;
      }
      if (res.error) {
        setError(res.error);
        return;
      }
      setRenamingId(null);
      await refresh();
      flash("Agent renamed.");
    } catch {
      setError("Couldn't reach the server — try again.");
    } finally {
      setBusy(false);
    }
  };

  const doToggle = async (a: SanitizedAgent) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await updateAgent({ data: { id: a.id, active: !a.active } });
      if (!res.allowed) {
        setError("Only the owner can manage agents.");
        return;
      }
      if (res.error) {
        setError(res.error);
        return;
      }
      await refresh();
      flash(a.active ? `Agent "${a.username}" disabled — they can no longer sign in.` : `Agent "${a.username}" enabled.`);
    } catch {
      setError("Couldn't reach the server — try again.");
    } finally {
      setBusy(false);
    }
  };

  const doReset = async () => {
    if (!resetId || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await resetAgentPassword({ data: { id: resetId, password: resetPw } });
      if (!res.allowed) {
        setError("Only the owner can manage agents.");
        return;
      }
      if (res.error) {
        setError(res.error);
        return;
      }
      setResetId(null);
      setResetPw("");
      await refresh();
      flash("Password reset.");
    } catch {
      setError("Couldn't reach the server — try again.");
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!deleteId || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await deleteAgent({ data: { id: deleteId } });
      if (!res.allowed) {
        setError("Only the owner can manage agents.");
        return;
      }
      if (res.error) {
        setError(res.error);
        return;
      }
      setDeleteId(null);
      await refresh();
      flash("Agent removed from the roster.");
    } catch {
      setError("Couldn't reach the server — try again.");
    } finally {
      setBusy(false);
    }
  };

  const deleting = agents?.find((a) => a.id === deleteId) ?? null;
  const resetting = agents?.find((a) => a.id === resetId) ?? null;

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Team / Agents</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Add agent accounts as you hire. Agents sign in at <span className="font-mono text-faint">/login</span> with their
            username and never see Settings or Providers &amp; Data — those stay owner-only.
          </p>
        </div>
        {!addOpen && (
          <button type="button" className="btn-primary" onClick={() => setAddOpen(true)} disabled={busy}>
            <span className="mr-1.5">+</span>Add agent
          </button>
        )}
      </div>

      {notice && <p className="mt-3 text-xs text-success">{notice}</p>}
      {error && <p className="mt-3 text-xs text-danger">{error}</p>}
      {loadError && <p className="mt-3 text-xs text-danger">{loadError}</p>}

      {addOpen && (
        <form onSubmit={(e) => void submitAdd(e)} className="mt-4 space-y-3 rounded-xl border border-white/10 bg-white/[.03] p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="ag-name" className="eyebrow mb-1.5 block">Name</label>
              <input
                id="ag-name"
                className="input-dark"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder="e.g. Sam Rivera"
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="ag-username" className="eyebrow mb-1.5 block">Username</label>
              <input
                id="ag-username"
                className="input-dark"
                value={addUsername}
                onChange={(e) => setAddUsername(e.target.value)}
                placeholder="e.g. sam.rivera"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            <div>
              <label htmlFor="ag-password" className="eyebrow mb-1.5 block">Password</label>
              <div className="relative">
                <input
                  id="ag-password"
                  type={showAddPw ? "text" : "password"}
                  className="input-dark w-full pr-9"
                  value={addPassword}
                  onChange={(e) => setAddPassword(e.target.value)}
                  placeholder="min 8 characters"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowAddPw((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-fg"
                  aria-label={showAddPw ? "Hide password" : "Show password"}
                >
                  <Icon name="eye" className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
          <p className="text-[11px] text-faint">
            Username: 2–40 characters, lowercase letters, numbers, dots, dashes, underscores. The username{" "}
            <span className="font-mono">owner</span> is reserved. Passwords are stored as salted hashes — never plaintext.
          </p>
          <div className="flex items-center gap-2">
            <button type="submit" disabled={busy || !addName.trim() || !addUsername.trim() || !addPassword} className="btn-primary">
              {busy ? "Creating…" : "Create agent"}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setAddOpen(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {agents === null ? (
        <p className="py-6 text-center text-xs text-muted">Loading roster…</p>
      ) : agents.length === 0 && !loadError ? (
        <div className="mt-4 rounded-xl border border-white/5 bg-white/[.02] px-5 py-8 text-center">
          <p className="text-sm font-medium text-fg">No agents yet — add one when you hire.</p>
          <p className="mt-1.5 text-xs text-muted">Agent accounts appear here once created; they can then sign in at /login.</p>
        </div>
      ) : (
        <div className="mt-4 divide-y divide-white/5">
          {agents.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                {renamingId === a.id ? (
                  <div className="flex items-center gap-2">
                    <input
                      className="input-dark w-52 px-2 py-1 text-sm"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      autoFocus
                    />
                    <button type="button" className="btn-primary px-2.5 py-1 text-[11px]" onClick={() => void doRename(a.id)} disabled={busy}>
                      Save
                    </button>
                    <button type="button" className="btn-ghost px-2.5 py-1 text-[11px]" onClick={() => setRenamingId(null)} disabled={busy}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <p className="text-sm font-medium text-fg">{a.name}</p>
                )}
                <p className="mt-0.5 font-mono text-xs text-muted">
                  @{a.username} · created {new Date(a.createdAt).toLocaleDateString()}
                </p>
              </div>
              {a.active ? <Badge variant="green">Active</Badge> : <Badge variant="amber">Disabled</Badge>}
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  className={ROW_ACTION}
                  onClick={() => {
                    setRenamingId(a.id);
                    setRenameValue(a.name);
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className={ROW_ACTION}
                  onClick={() => {
                    setResetId(a.id);
                    setResetPw("");
                    setShowResetPw(false);
                  }}
                >
                  Reset password
                </button>
                <button type="button" className={ROW_ACTION} onClick={() => void doToggle(a)} disabled={busy}>
                  {a.active ? "Disable" : "Enable"}
                </button>
                <button type="button" className={`${ROW_ACTION} text-danger`} onClick={() => setDeleteId(a.id)} disabled={busy}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Reset-password modal */}
      <Modal open={resetId !== null} onClose={() => setResetId(null)} title={`Reset password — ${resetting?.name ?? ""}`}>
        <p className="text-xs leading-relaxed text-muted">
          Set a new password for <span className="font-mono text-faint">@{resetting?.username ?? ""}</span>. The old one stops working
          immediately.
        </p>
        <div className="mt-4">
          <label htmlFor="rp-password" className="eyebrow mb-1.5 block">New password</label>
          <div className="relative">
            <input
              id="rp-password"
              type={showResetPw ? "text" : "password"}
              className="input-dark w-full pr-9"
              value={resetPw}
              onChange={(e) => setResetPw(e.target.value)}
              placeholder="min 8 characters"
              autoComplete="new-password"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShowResetPw((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-fg"
              aria-label={showResetPw ? "Hide password" : "Show password"}
            >
              <Icon name="eye" className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="mt-5 flex items-center gap-2">
          <button type="button" className="btn-primary" onClick={() => void doReset()} disabled={busy || resetPw.length < 8}>
            {busy ? "Saving…" : "Set new password"}
          </button>
          <button type="button" className="btn-ghost" onClick={() => setResetId(null)} disabled={busy}>
            Cancel
          </button>
        </div>
      </Modal>

      {/* Delete-confirm modal */}
      <Modal open={deleteId !== null} onClose={() => setDeleteId(null)} title={`Remove agent?`}>
        <p className="text-xs leading-relaxed text-muted">
          Remove <span className="font-medium text-fg">{deleting?.name}</span> (
          <span className="font-mono text-faint">@{deleting?.username}</span>) from the roster? This is permanent — they will no longer
          be able to sign in, and their saved password hash is deleted.
        </p>
        <div className="mt-5 flex items-center gap-2">
          <button
            type="button"
            className="rounded-lg border border-danger/50 bg-danger/15 px-4 py-2 text-sm font-semibold text-danger transition hover:bg-danger/25"
            onClick={() => void doDelete()}
            disabled={busy}
          >
            {busy ? "Removing…" : "Remove agent"}
          </button>
          <button type="button" className="btn-ghost" onClick={() => setDeleteId(null)} disabled={busy}>
            Keep
          </button>
        </div>
      </Modal>
    </Card>
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

      <AgentsCard />

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
