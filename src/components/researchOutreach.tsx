/**
 * AI Company Research + AI Outreach Assistant — one modal on the prospect detail
 * page.
 *
 * Research: "Research company" composes a sourced research brief (AI-generated
 * from sourced data when OPENAI_API_KEY is configured, otherwise a deterministic
 * template summary — both from REAL sourced fields only, never invented).
 *
 * Outreach: pick a message type and generate ONE draft, grounded in the same
 * brief. Copy-to-clipboard + visible "human review before sending" and
 * one-at-a-time guardrails. No mass/automated messaging.
 */

import { useState } from "react";
import { Badge, Button, Icon, StatusPill } from "~/components/ui";
import { researchCompany, generateDraft } from "~/lib/researchServer";
import { DRAFT_TYPES } from "~/lib/research";
import type { DraftType, OutreachDraft, ResearchBrief } from "~/lib/research";
import type { Prospect } from "~/lib/types";

export function ResearchOutreachModal({ open, onClose, prospect }: { open: boolean; onClose: () => void; prospect: Prospect }) {
  const [tab, setTab] = useState<"research" | "outreach">("research");
  const [brief, setBrief] = useState<ResearchBrief | null>(null);
  const [researching, setResearching] = useState(false);
  const [researchError, setResearchError] = useState("");
  const [draftType, setDraftType] = useState<DraftType>("cold-email");
  const [draft, setDraft] = useState<OutreachDraft | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState("");
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  const runResearch = async () => {
    setResearching(true);
    setResearchError("");
    try {
      const res = await researchCompany({ data: { prospect } });
      setBrief(res.brief);
      setTab("research");
    } catch {
      setResearchError("Research failed — try again in a moment.");
    } finally {
      setResearching(false);
    }
  };

  const runDraft = async () => {
    setDrafting(true);
    setDraftError("");
    setCopied(false);
    try {
      const res = await generateDraft({ data: { prospect, type: draftType } });
      setDraft(res.draft);
      setBrief(res.brief);
      setTab("outreach");
    } catch {
      setDraftError("Draft generation failed — try again in a moment.");
    } finally {
      setDrafting(false);
    }
  };

  const copyDraft = async () => {
    if (!draft) return;
    const text = (draft.subject ? `Subject: ${draft.subject}\n\n` : "") + draft.body;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="glass anim-rise relative flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden p-6">
        {/* Header */}
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 className="flex items-center gap-2 text-lg font-semibold tracking-head text-fg">
              <Icon name="sparkle" className="h-4 w-4 text-accent-light" /> AI Company Research
            </h3>
            <p className="mt-1 text-xs text-muted">
              Sourced brief + outreach drafts for <span className="font-medium text-fg">{prospect.companyName.value}</span> — grounded in real data only, never fabricated.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-muted hover:bg-white/5 hover:text-fg" aria-label="Close">✕</button>
        </div>

        {/* Tabs */}
        <div className="mb-4 flex gap-1 rounded-xl border border-white/10 bg-white/[.03] p-1 text-sm">
          {(["research", "outreach"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => { setTab(t); setCopied(false); }}
              className={`flex-1 rounded-lg px-3 py-1.5 font-medium transition ${tab === t ? "bg-white/10 text-fg" : "text-muted hover:text-fg"}`}
            >
              {t === "research" ? "Research brief" : "Outreach assistant"}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {tab === "research" ? (
            <ResearchTab
              brief={brief}
              researching={researching}
              error={researchError}
              onRun={runResearch}
            />
          ) : (
            <OutreachTab
              prospect={prospect}
              brief={brief}
              draftType={draftType}
              setDraftType={(t) => { setDraftType(t); setDraft(null); setCopied(false); }}
              draft={draft}
              drafting={drafting}
              error={draftError}
              copied={copied}
              onGenerate={runDraft}
              onCopy={copyDraft}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- research -------------------------------- */

function ModeBadge({ brief }: { brief: ResearchBrief }) {
  return brief.mode === "ai" ? (
    <Badge variant="violet"><Icon name="sparkle" className="h-3 w-3" /> AI-generated from sourced data</Badge>
  ) : (
    <Badge><Icon name="layers" className="h-3 w-3" /> Template summary from sourced data</Badge>
  );
}

function FactChips({ facts }: { facts: ResearchBrief["allFacts"] }) {
  if (!facts.length) return <p className="text-xs text-faint">No sourced facts in this section.</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {facts.map((f, i) => (
        <span key={i} className="badge max-w-full" title={`Source: ${f.source}${f.capturedAt ? ` · Captured: ${new Date(f.capturedAt).toLocaleString()}` : ""}`}>
          <span className="text-faint">{f.label}:</span>
          <span className="truncate">{f.value.length > 90 ? f.value.slice(0, 90) + "…" : f.value}</span>
          <StatusPill status={f.verificationStatus} />
        </span>
      ))}
    </div>
  );
}

function BriefSection({ title, prose, facts }: { title: string; prose: string; facts: ResearchBrief["allFacts"] }) {
  return (
    <div className="rounded-xl border border-white/5 bg-white/[.02] p-3.5">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-label text-faint">{title}</p>
      <p className="text-sm leading-relaxed text-fg">{prose || "No data to summarize yet."}</p>
      <details className="mt-2">
        <summary className="cursor-pointer text-[11px] text-muted hover:text-fg">Sourced facts ({facts.length})</summary>
        <div className="mt-2"><FactChips facts={facts} /></div>
      </details>
    </div>
  );
}

function ResearchTab({ brief, researching, error, onRun }: {
  brief: ResearchBrief | null;
  researching: boolean;
  error: string;
  onRun: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onRun} disabled={researching}>
          <Icon name="sparkle" className="h-4 w-4" /> {researching ? "Researching…" : brief ? "Re-run research" : "Research company"}
        </Button>
        {brief && <ModeBadge brief={brief} />}
        {brief && (
          <span className="text-xs text-muted">
            {brief.allFacts.length} sourced facts · {brief.gaps.length} known gap{brief.gaps.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {researching && <p className="flex items-center gap-2 text-xs text-muted"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-light" /> Composing the brief from this record&apos;s sourced fields…</p>}
      {error && <p className="rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-xs text-danger">{error}</p>}

      {!brief && !researching && !error && (
        <p className="rounded-xl border border-white/10 bg-white/[.03] p-3.5 text-sm text-muted">
          Runs entirely from this record&apos;s real sourced fields — store data, provider enrichment, website-intel evidence, and the fit engine.
          With an OpenAI key configured the brief is AI-written from exactly those fields; without one you get the same structure as a deterministic template summary. Either way, nothing is invented.
        </p>
      )}

      {brief && (
        <div className="space-y-3">
          {brief.llmError && (
            <p className="rounded-lg border border-warn/30 bg-warn/10 p-2.5 text-xs text-warn">
              <Icon name="bolt" className="h-3 w-3" /> {brief.llmError}.
            </p>
          )}
          <BriefSection title="Company overview" prose={brief.prose.overview} facts={brief.overview} />
          <BriefSection title="Why Operion may fit" prose={brief.prose.whyFit} facts={brief.whyFit} />
          <BriefSection title="Likely operational pain points" prose={brief.prose.painPoints} facts={brief.painPoints} />

          <div className="rounded-xl border border-accent/20 bg-accent/10 p-3.5">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-label text-accent-light">Recommended contact</p>
            {brief.recommendedContact ? (
              <div className="space-y-1 text-sm">
                <p className="text-fg">
                  {brief.recommendedContact.name}{brief.recommendedContact.name !== "Unknown" && brief.recommendedContact.title !== "Unknown" ? ` — ${brief.recommendedContact.title}` : brief.recommendedContact.title !== "Unknown" ? ` (${brief.recommendedContact.title})` : ""}
                  {brief.recommendedContact.fallbackToRole && <Badge variant="amber" className="ml-2 text-[10px]">role from fit engine</Badge>}
                </p>
                {brief.recommendedContact.email && (
                  <p className="flex items-center gap-2 text-muted">Email: <span className="text-fg">{brief.recommendedContact.email}</span> <StatusPill status={brief.recommendedContact.verificationStatus} /></p>
                )}
                {brief.recommendedContact.phone && <p className="text-muted">Phone: <span className="text-fg">{brief.recommendedContact.phone}</span></p>}
                <p className="text-xs leading-relaxed text-muted">{brief.prose.contactNote}</p>
              </div>
            ) : (
              <p className="text-sm text-muted">No contact identified.</p>
            )}
          </div>

          <BriefSection title="Suggested outreach angle" prose={brief.prose.outreachAngle} facts={brief.outreachAngle} />

          {brief.gaps.length > 0 && (
            <div className="rounded-xl border border-white/5 bg-white/[.02] p-3.5">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-label text-faint">Known gaps — nothing invented to fill them</p>
              <div className="flex flex-wrap gap-1.5">
                {brief.gaps.map((g, i) => (
                  <span key={i} className="badge opacity-70">– {g}</span>
                ))}
              </div>
            </div>
          )}

        </div>
      )}
    </div>
  );
}

/* -------------------------------- outreach --------------------------------- */

function OutreachTab({ prospect, brief, draftType, setDraftType, draft, drafting, error, copied, onGenerate, onCopy }: {
  prospect: Prospect;
  brief: ResearchBrief | null;
  draftType: DraftType;
  setDraftType: (t: DraftType) => void;
  draft: OutreachDraft | null;
  drafting: boolean;
  error: string;
  copied: boolean;
  onGenerate: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="space-y-4">
      <p className="rounded-xl border border-white/10 bg-white/[.03] p-3 text-xs leading-relaxed text-muted">
        Draft one personalized message at a time, grounded in the research brief (real facts + recommended contact + outreach angle).
        Bracketed items like <span className="font-mono text-fg">[First name]</span> are placeholders you must fill — the assistant never invents them.
      </p>

      <div className="flex flex-wrap gap-1.5">
        {DRAFT_TYPES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setDraftType(t.id)}
            title={t.hint}
            className={`badge cursor-pointer transition ${draftType === t.id ? "badge-violet" : "opacity-60 hover:opacity-100"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onGenerate} disabled={drafting}>
          <Icon name="sparkle" className="h-4 w-4" /> {drafting ? "Drafting…" : "Generate draft"}
        </Button>
        {draft && (draft.mode === "ai" ? <Badge variant="violet"><Icon name="sparkle" className="h-3 w-3" /> AI-drafted from sourced data</Badge> : <Badge><Icon name="layers" className="h-3 w-3" /> Template draft from sourced data</Badge>)}
        {draft && (
          <span className="text-xs text-muted">
            Grounded in {draft.groundedIn.length} sourced fact{draft.groundedIn.length === 1 ? "" : "s"}
            {brief ? ` · ${brief.gaps.length} known gap${brief.gaps.length === 1 ? "" : "s"}` : ""}
          </span>
        )}
      </div>
      {drafting && <p className="flex items-center gap-2 text-xs text-muted"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-light" /> Drafting from the research brief…</p>}
      {error && <p className="rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-xs text-danger">{error}</p>}
      {draft?.llmError && <p className="rounded-lg border border-warn/30 bg-warn/10 p-2.5 text-xs text-warn"><Icon name="bolt" className="h-3 w-3" /> {draft.llmError}.</p>}

      {!draft && !drafting && !error && (
        <p className="rounded-xl border border-white/10 bg-white/[.03] p-3.5 text-sm text-muted">
          Pick a message type and generate one draft for {prospect.companyName.value}. Drafting assistant only — no sequences, no bulk sending.
        </p>
      )}

      {draft && (
        <div className="space-y-3">
          <div className="rounded-xl border border-white/10 bg-black/30 p-4">
            {draft.subject && (
              <p className="mb-2 text-sm text-muted">Subject: <span className="font-medium text-fg">{draft.subject}</span></p>
            )}
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-fg">{draft.body}</pre>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="ghost" onClick={onCopy} disabled={copied}>
              <Icon name="check" className="h-4 w-4" /> {copied ? "Copied ✓" : "Copy to clipboard"}
            </Button>
            <p className="text-[11px] text-muted">
              {draft.placeholders.length > 0 && (
                <span className="mr-2 text-warn">{draft.placeholders.join(", ")} — fill before sending</span>
              )}
            </p>
          </div>
          <div className="space-y-1.5 rounded-xl border border-warn/25 bg-warn/[.06] p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-warn">
              <Icon name="shield" className="h-3.5 w-3.5" /> Human review before sending
            </p>
            <p className="text-xs leading-relaxed text-muted">
              This is a drafting assistant — one message at a time. Verify every fact, fill the placeholders, and review before you send.
              No automated or mass sending. Reach out only to opted-in or verified contacts.
            </p>
          </div>
          <details className="rounded-xl border border-white/5 bg-white/[.02] p-3">
            <summary className="cursor-pointer text-[11px] text-muted hover:text-fg">Why this draft — grounded in ({draft.groundedIn.length})</summary>
            <div className="mt-2"><FactChips facts={draft.groundedIn} /></div>
          </details>
        </div>
      )}
    </div>
  );
}
