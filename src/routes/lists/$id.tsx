/**
 * List detail — members, live counts, CSV export (with provenance columns),
 * and add/remove for manual lists.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Badge, Button, Card, ContactabilityPill, FitBadge, Icon, Modal, SectionHead, StatusPill, useModal } from "~/components/ui";
import { downloadCsv, evaluateList, ensureSeededLists, listsToCsv, ruleSummary, scoredPool, viewOf, type ProspectList, type ScoredProspect } from "~/lib/lists";
import { getLists, saveLists, deleteList } from "~/lib/store";
import { contactabilityOf, shortLocation } from "~/lib/types";
import { SendToCrmButton } from "~/components/prospectTable";

export const Route = createFileRoute("/lists/$id")({
  component: ListDetail,
});

function ListDetail() {
  const { id } = Route.useParams();
  const [lists, setLists] = useState<ProspectList[]>(() => ensureSeededLists());
  const [refresh, setRefresh] = useState(0);
  const addModal = useModal();

  const list = lists.find((l) => l.id === id);
  const pool = useMemo(() => scoredPool(), [refresh]);
  const members = useMemo(() => (list ? evaluateList(list, pool) : []), [list, pool]);

  if (!list) {
    return (
      <div className="space-y-4">
        <SectionHead eyebrow="Lists" title="List not found" />
        <Card className="p-8 text-center text-sm text-muted">
          This list doesn&apos;t exist anymore. <Link to="/lists" className="text-accent-light underline">Back to Lists</Link>
        </Card>
      </div>
    );
  }

  const exportCsv = () => {
    downloadCsv(`${list.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.csv`, listsToCsv(members));
  };

  const removeMember = (prospectId: string) => {
    const next: ProspectList = { ...list, memberIds: (list.memberIds ?? []).filter((m) => m !== prospectId) };
    const updated = lists.map((l) => (l.id === list.id ? next : l));
    saveLists(updated);
    setLists(updated);
  };

  const removeList = () => {
    setLists(deleteList(list.id));
  };

  return (
    <div className="space-y-6">
      <SectionHead
        eyebrow="Lists"
        title={list.name}
        desc={list.description ?? (list.kind === "dynamic" ? (list.rules ?? []).map(ruleSummary).join(" · ") : "Manual list")}
        right={
          <div className="flex items-center gap-2">
            <Badge variant={list.kind === "dynamic" ? "violet" : "neutral"}>{list.kind === "dynamic" ? "dynamic" : "manual"}{list.isSystem ? " · system" : ""}</Badge>
            <Button variant="ghost" onClick={exportCsv} disabled={!members.length}>
              <Icon name="upload" className="h-4 w-4" /> Export CSV
            </Button>
            {list.kind === "manual" && (
              <Button onClick={addModal.openModal}>
                <Icon name="check" className="h-4 w-4" /> Add prospects
              </Button>
            )}
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
        <Badge variant="green">{members.length} member{members.length === 1 ? "" : "s"}</Badge>
        {list.kind === "dynamic" && <Badge>re-evaluated live</Badge>}
        {list.kind === "manual" && <Badge>manual membership</Badge>}
        {!list.isSystem && (
          <button type="button" onClick={removeList} className="ml-auto text-xs text-muted underline-offset-2 hover:text-danger hover:underline">
            Delete list
          </button>
        )}
      </div>

      {list.kind === "dynamic" && list.rules && list.rules.length > 0 && (
        <Card className="p-4 text-xs text-muted">
          <span className="font-semibold text-fg">Rules:</span> {list.rules.map(ruleSummary).join(" · ")}
        </Card>
      )}

      <MembersTable members={members} onRemove={list.kind === "manual" ? removeMember : undefined} />

      <AddProspectsModal open={addModal.open} onClose={addModal.closeModal} list={list} pool={pool} existingIds={new Set(members.map((m) => m.id))} onAdded={() => { setLists(getLists()); setRefresh((n) => n + 1); addModal.closeModal(); }} />
    </div>
  );
}

/* ------------------------------ members table ----------------------------- */

function MembersTable({ members, onRemove }: { members: ScoredProspect[]; onRemove?: (prospectId: string) => void }) {
  if (!members.length) {
    return (
      <Card className="p-10 text-center text-sm text-muted">
        {onRemove
          ? "This manual list is empty. Hit “Add prospects” to pick members from the scored pool."
          : "No prospects match these rules yet — the list will fill as the pool grows."}
      </Card>
    );
  }
  return (
    <div className="glass overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-white/5 bg-ink-2/90 backdrop-blur">
              {["Company", "Industry · Location", "Fit", "Contactability", "Verification", "", ""].map((h) => (
                <th key={h} className="sticky top-0 z-10 bg-ink-2/90 px-4 py-2.5 text-xs font-semibold uppercase tracking-label text-muted backdrop-blur">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {members.map((p) => {
              const view = viewOf(p);
              const cont = contactabilityOf(view);
              const primary = view.contacts.find((c) => c.isPrimary) ?? view.contacts[0];
              const vStatus = primary?.email?.verificationStatus === "Verified" || primary?.phone?.verificationStatus === "Verified"
                ? "Verified"
                : primary?.email?.verificationStatus ?? primary?.phone?.verificationStatus ?? "Unknown";
              return (
                <tr key={p.id} className="border-b border-white/5 transition hover:bg-white/[.03]">
                  <td className="px-4 py-2.5">
                    <Link to="/prospects/$id" params={{ id: p.id }} className="font-semibold text-fg hover:text-accent-light">{view.companyName.value}</Link>
                    <p className="mt-0.5 truncate text-xs text-muted" title={primary ? `${primary.fullName.value} · ${primary.title.value}` : undefined}>{primary ? `${primary.fullName.value} · ${primary.title.value}` : "No contact identified"}</p>
                  </td>
                  <td className="max-w-[16rem] px-4 py-2.5 text-muted" title={`${view.subIndustry?.value ?? view.industry.value} · ${view.location.value}`}>
                    <p className="truncate">{view.subIndustry?.value ?? view.industry.value}</p>
                    <p className="truncate text-[11px] text-faint">{shortLocation(view.location.value)}</p>
                  </td>
                  <td className="px-4 py-2.5"><FitBadge score={p.fit.score} /></td>
                  <td className="px-4 py-2.5"><ContactabilityPill band={cont.band} /></td>
                  <td className="px-4 py-2.5"><StatusPill status={vStatus} /></td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <Link to="/prospects/$id" params={{ id: p.id }} className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-fg transition hover:bg-white/10">View</Link>
                      <SendToCrmButton prospect={view} />
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    {onRemove && (
                      <button type="button" onClick={() => onRemove(p.id)} className="rounded-lg p-1.5 text-muted transition hover:bg-white/5 hover:text-danger" aria-label={`Remove ${view.companyName.value}`}>
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t border-white/5 px-4 py-2.5 text-[11px] text-faint">
        CSV export includes provenance columns (verification status + source for every field) so data-quality labels survive the file.
      </p>
    </div>
  );
}

/* --------------------------- add prospects modal --------------------------- */

function AddProspectsModal({ open, onClose, list, pool, existingIds, onAdded }: {
  open: boolean; onClose: () => void; list: ProspectList; pool: ScoredProspect[]; existingIds: Set<string>; onAdded: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pool
      .filter((p) => !existingIds.has(p.id))
      .filter((p) => !q || `${p.companyName.value} ${p.industry.value} ${p.location.value.city}`.toLowerCase().includes(q))
      .sort((a, b) => b.fit.score - a.fit.score)
      .slice(0, 40);
  }, [pool, query, existingIds]);

  const toggle = (pid: string) => {
    const next = new Set(selected);
    if (next.has(pid)) next.delete(pid); else next.add(pid);
    setSelected(next);
  };

  const addSelected = () => {
    const next: ProspectList = { ...list, memberIds: Array.from(new Set([...(list.memberIds ?? []), ...selected])) };
    saveLists(getLists().map((l) => (l.id === list.id ? next : l)));
    setSelected(new Set());
    setQuery("");
    onAdded();
  };

  return (
    <Modal open={open} onClose={onClose} title={`Add to ${list.name}`}>
      <div className="space-y-3">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by name, industry or city…" className="input-dark" aria-label="Filter prospects" />
        <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
          {candidates.length === 0 && <p className="py-4 text-center text-xs text-muted">No matching prospects — the pool only has what the engine already knows.</p>}
          {candidates.map((p) => (
            <label key={p.id} className="flex cursor-pointer items-center gap-3 rounded-lg border border-white/5 bg-white/[.02] px-3 py-2 text-sm transition hover:bg-white/[.05]">
              <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} className="accent-[#8b5cf6]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-fg">{p.companyName.value}</span>
                <span className="block truncate text-xs text-muted">{p.industry.value} · {shortLocation(p.location.value)}</span>
              </span>
              <FitBadge score={p.fit.score} />
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={addSelected} disabled={!selected.size}>Add {selected.size || ""} selected</Button>
        </div>
      </div>
    </Modal>
  );
}
