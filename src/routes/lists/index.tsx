/**
 * Lists — dynamic (rule-driven) and manual lists over the scored pool.
 *
 * Dynamic lists re-evaluate live from current data; manual lists hold explicit
 * members. "Today's Best Prospects" is seeded as a dynamic system list.
 * List detail (members, counts, CSV export with provenance) lives at /lists/$id.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Badge, Button, Card, Icon, Modal, SectionHead, useModal } from "~/components/ui";
import { ensureSeededLists, evaluateList, ruleSummary, scoredPool, type ProspectList, type ListRule } from "~/lib/lists";
import { getLists, saveLists, deleteList } from "~/lib/store";
import { fullCatalog } from "~/lib/categories";

export const Route = createFileRoute("/lists/")({
  component: ListsPage,
});

function ListsPage() {
  const [lists, setLists] = useState<ProspectList[]>(() => ensureSeededLists());
  const [refresh, setRefresh] = useState(0);
  const createModal = useModal();

  const pool = useMemo(() => scoredPool(), [refresh]);
  const industries = useMemo(() => Array.from(new Set(pool.map((p) => p.industry.value))).sort(), [pool]);

  const membersOf = (l: ProspectList) => evaluateList(l, pool);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of lists) m.set(l.id, membersOf(l).length);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lists, pool]);

  const remove = (l: ProspectList) => {
    setLists(deleteList(l.id));
  };

  return (
    <div className="space-y-6">
      <SectionHead
        eyebrow="Lists"
        title="Lists & saved searches"
        desc="Dynamic lists re-evaluate live from the scored pool; manual lists hold explicit members. Lists are views — the CRM stays the system of record."
        right={
          <Button onClick={createModal.openModal}>
            <Icon name="layers" className="h-4 w-4" /> New list
          </Button>
        }
      />

      {/* Dynamic lists */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold tracking-head text-fg">Dynamic lists</h2>
        <p className="-mt-1 text-sm text-muted">Membership is computed on every visit from current store data — nothing stored, nothing invented.</p>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {lists.filter((l) => l.kind === "dynamic").map((l) => (
            <ListCard key={l.id} list={l} count={counts.get(l.id) ?? 0} onDelete={l.isSystem ? undefined : () => remove(l)} />
          ))}
        </div>
      </div>

      {/* Manual lists */}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold tracking-head text-fg">Manual lists</h2>
        <p className="-mt-1 text-sm text-muted">You choose the members — add/remove them from the list detail page.</p>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {lists.filter((l) => l.kind === "manual").map((l) => (
            <ListCard key={l.id} list={l} count={counts.get(l.id) ?? 0} onDelete={() => remove(l)} />
          ))}
          {lists.filter((l) => l.kind === "manual").length === 0 && (
            <Card className="p-5 text-sm text-muted">No manual lists yet — create one and add prospects from its detail page.</Card>
          )}
        </div>
      </div>

      <CreateListModal
        open={createModal.open}
        onClose={createModal.closeModal}
        industries={industries}
        onCreated={() => { setLists(getLists()); setRefresh((n) => n + 1); createModal.closeModal(); }}
      />
    </div>
  );
}

function ListCard({ list, count, onDelete }: { list: ProspectList; count: number; onDelete?: () => void }) {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between gap-2">
        <span className="icon-tile"><Icon name={list.kind === "dynamic" ? "bolt" : "list"} className="h-4 w-4" /></span>
        {onDelete && (
          <button type="button" onClick={onDelete} className="rounded-lg p-1.5 text-muted transition hover:bg-white/5 hover:text-danger" aria-label={`Delete list ${list.name}`}>
            ✕
          </button>
        )}
      </div>
      <div>
        <p className="font-medium text-fg">{list.name}</p>
        {list.isSystem && <Badge variant="violet" className="mt-1 text-[10px]">system</Badge>}
        <p className="mt-1 text-xs text-muted">{list.description ?? (list.kind === "dynamic" ? (list.rules ?? []).map(ruleSummary).join(" · ") : "Manual list")}</p>
      </div>
      <div className="mt-auto flex items-center justify-between">
        <span className="font-mono text-sm text-fg">{count} member{count === 1 ? "" : "s"}</span>
        <Link to="/lists/$id" params={{ id: list.id }} className="btn-ghost px-3 py-1.5 text-xs">
          Open <Icon name="chevron" className="ml-1 h-3 w-3" />
        </Link>
      </div>
    </Card>
  );
}

/* ------------------------------ create modal ------------------------------ */

function CreateListModal({ open, onClose, industries, onCreated }: { open: boolean; onClose: () => void; industries: string[]; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"dynamic" | "manual">("dynamic");
  const [fitMin, setFitMin] = useState("");
  const [industry, setIndustry] = useState("");
  const [category, setCategory] = useState("");
  const [readyOnly, setReadyOnly] = useState(false);
  const [limit, setLimit] = useState("25");
  const [error, setError] = useState("");

  const catalog = fullCatalog();

  const create = () => {
    const clean = name.trim();
    if (!clean) { setError("Give the list a name."); return; }
    const rules: ListRule[] = [];
    if (fitMin.trim()) rules.push({ kind: "fitMin", value: Math.max(0, Math.min(100, +fitMin || 0)) });
    if (industry) rules.push({ kind: "industry", value: industry });
    if (category) rules.push({ kind: "category", value: category });
    if (readyOnly) rules.push({ kind: "readyForOutreach" });
    const list: ProspectList = {
      id: `list-${Date.now()}`,
      name: clean,
      kind,
      description: kind === "dynamic" ? (rules.length ? rules.map(ruleSummary).join(" · ") : "All prospects") : "Manual list",
      rules: kind === "dynamic" ? rules : undefined,
      memberIds: kind === "manual" ? [] : undefined,
      limit: kind === "dynamic" && limit.trim() ? Math.max(1, +limit || 25) : undefined,
      createdAt: new Date().toISOString(),
    };
    saveLists([...getLists(), list]);
    setName(""); setFitMin(""); setIndustry(""); setCategory(""); setReadyOnly(false); setLimit("25"); setError("");
    onCreated();
  };

  return (
    <Modal open={open} onClose={onClose} title="New list">
      <div className="space-y-3">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="List name (e.g. Texas hospitality, fit ≥ 70)" className="input-dark" aria-label="List name" />
        <div className="flex gap-2">
          {(["dynamic", "manual"] as const).map((k) => (
            <button key={k} type="button" onClick={() => setKind(k)} className={`flex-1 rounded-xl border px-3 py-2 text-sm font-medium capitalize transition ${kind === k ? "border-accent/50 bg-accent/15 text-fg" : "border-white/10 bg-white/[.03] text-muted hover:text-fg"}`}>
              {k}
            </button>
          ))}
        </div>

        {kind === "dynamic" && (
          <div className="space-y-2.5 rounded-xl border border-white/5 bg-white/[.02] p-3">
            <p className="eyebrow">Rules (all must match)</p>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="text-[11px] uppercase tracking-label text-faint">Min fit</span>
                <input value={fitMin} onChange={(e) => setFitMin(e.target.value)} type="number" min={0} max={100} placeholder="e.g. 70" className="input-dark mt-1" aria-label="Minimum fit score" />
              </label>
              <label className="block">
                <span className="text-[11px] uppercase tracking-label text-faint">Limit (top N)</span>
                <input value={limit} onChange={(e) => setLimit(e.target.value)} type="number" min={1} placeholder="e.g. 25" className="input-dark mt-1" aria-label="List limit" />
              </label>
              <label className="block">
                <span className="text-[11px] uppercase tracking-label text-faint">Industry</span>
                <select value={industry} onChange={(e) => setIndustry(e.target.value)} className="input-dark mt-1">
                  <option value="">Any</option>
                  {industries.map((i) => <option key={i} value={i}>{i}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-[11px] uppercase tracking-label text-faint">Category</span>
                <select value={category} onChange={(e) => setCategory(e.target.value)} className="input-dark mt-1">
                  <option value="">Any</option>
                  {catalog.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </label>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={readyOnly} onChange={(e) => setReadyOnly(e.target.checked)} className="accent-[#8b5cf6]" />
              Ready for outreach only (fit ≥ 75 + verified contact)
            </label>
          </div>
        )}

        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={create}>Create list</Button>
        </div>
      </div>
    </Modal>
  );
}
