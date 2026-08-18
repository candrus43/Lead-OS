/**
 * Ranked prospects table — the core "10 companies I should contact today" view.
 * Columns: company, industry, location, employees, fit score (+reasons),
 * contactability, buyer identified, verification, status, actions.
 */

import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { Prospect } from "~/lib/types";
import { contactabilityOf, shortLocation } from "~/lib/types";
import { Badge, Button, ContactabilityPill, FitBadge, Modal, StatusPill, useModal } from "./ui";
import { Icon } from "./ui";
import { getEnrichedMap, saveEnrichedMap, updateImportedProspect } from "~/lib/store";
import { formatCost } from "~/lib/enrich";
import { computeFit } from "~/lib/fitScore";
import { sendProspectToCrm, type CrmPushPayload, type CrmSendResult } from "~/lib/crmServer";

const CRM_APP_URL = "https://operion-crm.ctonew.app";

/** Build the extended CRM payload from a prospect — real fields only, nothing fabricated. */
function crmPayloadFor(p: Prospect): { kind: "ok"; lead: CrmPushPayload } | { kind: "no-email" } {
  const primary = p.contacts.find((c) => c.isPrimary) ?? p.contacts[0];
  const email = primary?.email?.value?.trim() ?? "";
  if (!email) return { kind: "no-email" };
  const name = primary?.fullName?.value?.trim() || p.companyName.value.trim();
  // The fit engine is deterministic — compute locally if the stored prospect
  // doesn't carry it, so the CRM always receives the real score/buyer lines.
  const fit = p.fit ?? computeFit(p);
  const researchLines = [
    `Fit ${fit.score}/100 (${fit.grade}) — recommended buyer: ${fit.recommendedBuyer}`,
    ...(fit.likelyPainPoint ? [`Likely pain point: ${fit.likelyPainPoint}`] : []),
  ].slice(0, 3);
  return {
    kind: "ok",
    lead: {
      customerName: name,
      customerEmail: email,
      company: p.companyName.value.trim() || undefined,
      website: p.website?.value?.trim() || undefined,
      phone: primary?.phone?.value?.trim() || undefined,
      source: "Operion Lead OS",
      fitScore: fit.score,
      recommendedBuyer: fit.recommendedBuyer,
      researchSummary: researchLines.join("\n"),
    },
  };
}

/** Persist the CRM acknowledgment on the prospect (imported store + enriched copy). */
function persistCrmResult(prospectId: string, res: CrmSendResult): void {
  if (!res.ok || !res.dealId || !res.capturedAt) return;
  const prov = { source: "crm-api", capturedAt: res.capturedAt, confidence: 1, verificationStatus: "Verified" as const };
  const patch: Partial<Prospect> = {
    crmDealId: { value: res.dealId, ...prov },
    crmSentAt: { value: res.capturedAt, ...prov },
    crmResult: { value: (res.created ? "created" : "duplicate") as "created" | "duplicate", ...prov },
    ...(res.company?.companyId ? { crmCompanyId: { value: res.company.companyId, ...prov } } : {}),
    ...(res.contact?.contactId ? { crmContactId: { value: res.contact.contactId, ...prov } } : {}),
  };
  updateImportedProspect(prospectId, (p) => ({ ...p, ...patch }));
  const map = getEnrichedMap();
  if (map[prospectId]) {
    map[prospectId] = { ...map[prospectId], prospect: { ...map[prospectId].prospect, ...patch } };
    saveEnrichedMap(map);
  }
}

type CrmModalState =
  | { kind: "idle" }
  | { kind: "sending"; lead: CrmPushPayload | null }
  | { kind: "done"; result: CrmSendResult; updated?: boolean };

/** Compact "Details" expander for the CRM result panel — one clear outcome on
 *  top, entity-level breakdown folded underneath. */
function CrmResultDetails({ res }: { res: CrmSendResult }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-white/10 bg-white/[.02]">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-muted transition hover:text-fg"
      >
        <span className="flex items-center gap-1.5">
          <Icon name="chevron" className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
          Details
        </span>
        <span className="font-mono text-[10px] text-faint">company · contact · notes</span>
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-white/5 px-3 py-2.5 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted">Company</span>
            <span className="font-mono text-fg">
              {res.company ? (res.company.created ? "created" : res.company.updated ? "updated" : "exists") : "—"}
            </span>
          </div>
          {res.company && (
            <p className="truncate text-[10px] text-faint" title={res.company.companyId}>
              {res.company.companyId}
            </p>
          )}
          <div className="flex items-center justify-between gap-3 border-t border-white/5 pt-1.5">
            <span className="text-muted">Contact</span>
            <span className="font-mono text-fg">{res.contact ? (res.contact.created ? "created" : "exists") : "—"}</span>
          </div>
          {res.contact && (
            <p className="truncate text-[10px] text-faint" title={res.contact.contactId}>
              {res.contact.contactId}
            </p>
          )}
          <div className="flex items-center justify-between gap-3 border-t border-white/5 pt-1.5">
            <span className="text-muted">Research notes</span>
            <span className="font-mono text-fg">{res.notesAttached ? "attached" : "—"}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** One shared "Send to Operion CRM" modal — table rows, lists and detail page all use it. */
export function SendToCrmButton({ prospect, size = "sm" }: { prospect: Prospect; size?: "sm" | "md" }) {
  const { open: isOpen, openModal, closeModal } = useModal();
  const [state, setState] = useState<CrmModalState>({ kind: "idle" });
  const payload = crmPayloadFor(prospect);
  const primary = prospect.contacts.find((c) => c.isPrimary) ?? prospect.contacts[0];

  const open = () => {
    setState({ kind: "idle" });
    openModal();
  };
  const close = () => closeModal();

  const send = async () => {
    if (payload.kind === "no-email") {
      setState({
        kind: "done",
        result: { ok: false, code: "no-email", message: "The CRM dedupes by email, so a contact email is required to push this prospect." },
      });
      return;
    }
    setState({ kind: "sending", lead: payload.lead });
    try {
      const res = await sendProspectToCrm({ data: payload.lead });
      if (res.ok) persistCrmResult(prospect.id, res);
      setState((s) => ({ kind: "done", result: res, updated: s.kind === "done" && s.updated }));
    } catch {
      setState({ kind: "done", result: { ok: false, code: "error", message: "Could not reach the Operion CRM (network error). Try again." } });
    }
  };

  const updateRecord = async () => {
    if (payload.kind === "no-email") return;
    setState({ kind: "sending", lead: payload.lead });
    try {
      const res = await sendProspectToCrm({ data: payload.lead });
      if (res.ok) persistCrmResult(prospect.id, res);
      setState({ kind: "done", result: res, updated: true });
    } catch {
      setState({ kind: "done", result: { ok: false, code: "error", message: "Could not reach the Operion CRM (network error). Try again." } });
    }
  };

  const res = state.kind === "done" ? state.result : null;

  return (
    <>
      <Button variant={size === "md" ? "primary" : "ghost"} className={size === "md" ? "w-full sm:w-auto" : "whitespace-nowrap px-3 py-1.5 text-xs"} onClick={open}>
        <Icon name="bolt" className="h-3.5 w-3.5" />
        Send to CRM
      </Button>
      <Modal open={isOpen} onClose={close} title="Send to Operion CRM">
        <div className="space-y-4">
          <div className="rounded-xl border border-white/10 bg-white/[.03] p-3 text-sm text-muted">
            <p className="font-medium text-fg">{prospect.companyName.value}</p>
            <p className="mt-0.5 text-xs">Fit {prospect.fit?.score ?? "—"}/100 · {prospect.fit?.recommendedBuyer ?? "Buyer not identified"}</p>
          </div>

          {state.kind === "idle" && (
            <div className="space-y-3">
              {prospect.crmDealId && (
                <p className="rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-xs text-success/90">
                  Already pushed to Operion CRM — deal <span className="font-mono">{prospect.crmDealId.value}</span>. Sending again refreshes the record (the CRM dedupes by email).
                </p>
              )}
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between gap-3 border-b border-white/5 pb-1.5">
                  <span className="text-muted">Contact</span>
                  <span className="text-fg">{primary?.fullName.value || "—"}</span>
                </div>
                <div className="flex justify-between gap-3 border-b border-white/5 pb-1.5">
                  <span className="text-muted">Email</span>
                  <span className={primary?.email?.value ? "text-fg" : "text-warn"}>
                    {primary?.email?.value ?? "none — the CRM dedupes by email"}
                  </span>
                </div>
                <div className="flex justify-between gap-3 border-b border-white/5 pb-1.5">
                  <span className="text-muted">Company</span>
                  <span className="text-fg">{prospect.companyName.value}</span>
                </div>
                {primary?.phone?.value && (
                  <div className="flex justify-between gap-3 border-b border-white/5 pb-1.5">
                    <span className="text-muted">Phone</span>
                    <span className="text-fg">{primary.phone.value}</span>
                  </div>
                )}
                <div className="flex justify-between gap-3">
                  <span className="text-muted">Source</span>
                  <span className="text-fg">Operion Lead OS</span>
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-faint">
                Only known, real fields are sent — never a fabricated plan. Company, score and research stay in Lead OS; the CRM stays the system of record.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={close}>Cancel</Button>
                <Button onClick={() => void send()}>
                  <Icon name="bolt" className="h-3.5 w-3.5" /> Push to Operion CRM
                </Button>
              </div>
            </div>
          )}

          {state.kind === "sending" && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-accent-light border-t-transparent" />
              <p className="text-sm text-muted">
                Pushing {state.lead?.customerName ?? prospect.companyName.value} to Operion CRM…
              </p>
              <p className="text-[11px] text-faint">The CRM dedupes by email — you&apos;ll see created or duplicate in a moment.</p>
            </div>
          )}

          {state.kind === "done" && res && (
            <div className="space-y-3">
              {res.code === "created" && res.ok && (
                <>
                  <div className="rounded-xl border border-success/25 bg-success/10 p-4">
                    <p className="flex items-center gap-2 text-sm font-medium text-fg">
                      <Icon name="check" className="h-4 w-4 shrink-0 text-success" />
                      Created in Operion CRM — deal <span className="font-mono">{res.dealId}</span>
                    </p>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted">
                      Company and contact recorded, research notes attached, deal created — all verified live against the CRM API.
                    </p>
                    <p className="mt-1 text-[11px] text-faint">
                      Recorded on this prospect: source <span className="font-mono">crm-api</span> · captured {res.capturedAt ? new Date(res.capturedAt).toLocaleString() : ""} · confidence 100%.
                    </p>
                  </div>
                  <CrmResultDetails res={res} />
                  <div className="flex justify-end gap-2">
                    <a href={CRM_APP_URL} target="_blank" rel="noreferrer" className="btn-primary">
                      <Icon name="check" className="h-3.5 w-3.5" /> Open Operion CRM
                    </a>
                    <Button variant="ghost" onClick={close}>Done</Button>
                  </div>
                </>
              )}

              {res.code === "duplicate" && res.ok && (
                <>
                  <div className="rounded-xl border border-amber/25 bg-amber/10 p-4">
                    <p className="text-sm font-medium text-fg">
                      Already in Operion CRM under this email — deal <span className="font-mono">{res.dealId}</span>
                    </p>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted">
                      The CRM dedupes by email, so this prospect maps to the existing deal. Company, contact and research notes were refreshed; Update re-posts the current fields, Cancel keeps everything local.
                    </p>
                  </div>
                  <CrmResultDetails res={res} />
                  {state.updated && (
                    <p className="rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-xs text-success/90">
                      <Icon name="check" className="mr-1 inline h-3.5 w-3.5" />
                      Updated — deal <span className="font-mono">{res.dealId}</span> refreshed in Operion CRM with the current prospect fields.
                    </p>
                  )}
                  <div className="flex justify-end gap-2">
                    {state.updated ? (
                      <Button variant="ghost" onClick={close}>Done</Button>
                    ) : (
                      <>
                        <Button variant="ghost" onClick={close}>Cancel — keep local</Button>
                        <Button onClick={() => void updateRecord()}>
                          <Icon name="bolt" className="h-3.5 w-3.5" /> Update record
                        </Button>
                      </>
                    )}
                  </div>
                </>
              )}

              {res.code === "no-email" && (
                <>
                  <div className="rounded-xl border border-warn/25 bg-warn/10 p-4">
                    <p className="text-sm font-medium text-fg">A contact email is required</p>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted">
                      The CRM dedupes by email, so it can&apos;t accept a prospect without one — nothing was sent. Add an email contact (or enrich this prospect) first.
                    </p>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={close}>Close</Button>
                  </div>
                </>
              )}

              {res.code === "no-key" && (
                <>
                  <div className="rounded-xl border border-warn/25 bg-warn/10 p-4">
                    <p className="text-sm font-medium text-fg">CRM not connected</p>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted">
                      Add <span className="rounded-md bg-black/30 px-1.5 py-0.5 font-mono text-[11px]">OPERION_CRM_API_KEY</span> in Secrets to enable pushes — nothing was sent.
                    </p>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={close}>Close</Button>
                  </div>
                </>
              )}

              {res.code === "error" && (
                <>
                  <div className="rounded-xl border border-danger/25 bg-danger/10 p-4">
                    <p className="text-sm font-medium text-fg">Couldn&apos;t push to Operion CRM</p>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted">{res.message}</p>
                  </div>
                  {(res.company || res.contact) && (
                    <p className="text-[11px] leading-relaxed text-faint">
                      Partial progress was saved in the CRM before the failure — see Details.
                    </p>
                  )}
                  {(res.company || res.contact) && <CrmResultDetails res={res} />}
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={close}>Close</Button>
                    <Button onClick={() => void send()}>Try again</Button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}

export function ProspectTable({ prospects, showSource = false }: { prospects: Prospect[]; showSource?: boolean }) {
  if (!prospects.length) {
    return (
      <div className="glass flex flex-col items-center gap-3 p-12 text-center">
        <span className="icon-tile">
          <Icon name="search" className="h-5 w-5" />
        </span>
        <p className="text-sm font-medium text-fg">No prospects match</p>
        <p className="max-w-sm text-xs text-muted">
          Nothing in the pool meets these filters yet. Try relaxing the filters or lowering the fit threshold — or import your first list via CSV on{" "}
          <Link to="/bulk" className="text-accent-light underline">Bulk Analysis</Link> and run a search to discover more.
        </p>
      </div>
    );
  }
  return (
    <div className="glass overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead>
            <tr className="border-b border-white/5 bg-ink-2/90 backdrop-blur">
              {["Company", "Industry · Location", "Fit", "Contactability", "Buyer Identified", "Verification", ""].map((h) => (
                <th key={h} className="sticky top-0 z-10 bg-ink-2/90 px-4 py-2.5 text-xs font-semibold uppercase tracking-label text-muted backdrop-blur">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {prospects.map((p) => {
              const enriched = getEnrichedMap()[p.id];
              const view = enriched ? enriched.prospect : p;
              const contact = view.contacts.find((c) => c.isPrimary) ?? view.contacts[0];
              const cont = contactabilityOf(view);
              return (
                <tr key={p.id} className="group border-b border-white/5 transition hover:bg-white/[.03]">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <Link to="/prospects/$id" params={{ id: p.id }} className="font-semibold text-fg hover:text-accent-light">
                        {view.companyName.value}
                      </Link>
                      {view.mock && <Badge variant="mock" className="text-[10px]">mock</Badge>}
                      {view.crmDealId && (
                        <span title={`Pushed to Operion CRM — deal ${view.crmDealId.value}`}>
                          <Badge variant="green" className="text-[10px]">in CRM</Badge>
                        </span>
                      )}
                      {showSource && <Badge className="text-[10px]">{view.sourceProvider}</Badge>}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted" title={contact ? `${contact.fullName.value} · ${contact.title.value}` : undefined}>
                      {contact ? `${contact.fullName.value} · ${contact.title.value}` : "No contact identified"}
                    </p>
                    <p className="mt-0.5 text-[10px] text-faint" title={enriched ? `${enriched.steps.length} enrichment step(s)` : undefined}>
                      {view.employees?.value ? `${view.employees.value} employees` : ""}
                      {enriched ? ` · enriched ${formatCost(enriched.cost)}${enriched.mock ? " · mock" : ""}` : ""}
                    </p>
                  </td>
                  <td className="max-w-[16rem] px-4 py-2.5 text-muted" title={`${view.subIndustry?.value ?? view.industry.value} · ${view.location.value}`}>
                    <p className="truncate">{view.subIndustry?.value ?? view.industry.value}</p>
                    <p className="truncate text-[11px] text-faint">{shortLocation(view.location.value)}</p>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <FitBadge score={view.fit?.score ?? 0} />
                      {view.fit?.preliminary && (
                        <span
                          className="cursor-help text-[10px] uppercase tracking-label text-faint"
                          title="Discovery estimate — computed from the search match (segment · location · size) plus provider signals. Enrich to refine."
                        >
                          est.
                        </span>
                      )}
                      {view.fit && view.fit.reasons.length > 0 && (
                        <span
                          className="hidden cursor-help text-muted xl:inline"
                          title={view.fit.reasons.slice(0, 6).map((r) => `+${r.weight} ${r.label}`).join("\n")}
                        >
                          <Icon name="eye" className="h-3.5 w-3.5" />
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5"><ContactabilityPill band={cont.band} /></td>
                  <td className="px-4 py-2.5">
                    <p className="max-w-[10rem] truncate text-xs text-fg" title={view.fit?.recommendedBuyer}>{view.fit?.recommendedBuyer ?? "—"}</p>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-col gap-1">
                      {contact?.email ? <StatusPill status={contact.email.verificationStatus} label="email" /> : <span className="text-xs text-faint">no email</span>}
                      {contact?.phone ? <StatusPill status={contact.phone.verificationStatus} label="phone" /> : null}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <Link to="/prospects/$id" params={{ id: p.id }} className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-fg transition hover:bg-white/10">
                        View
                      </Link>
                      <SendToCrmButton prospect={view} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
