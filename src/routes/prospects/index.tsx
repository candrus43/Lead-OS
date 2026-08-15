/**
 * Prospects — every prospect in the engine (imported + discovered + website
 * intelligence), ranked by fit score, with a fit-threshold filter and a
 * category filter. Not a CRM — this is the pipeline view.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Card, Icon, SectionHead } from "~/components/ui";
import { ProspectTable } from "~/components/prospectTable";
import { computeFit, DEFAULT_FIT_THRESHOLD } from "~/lib/fitScore";
import { getImportedProspects, getCategoryMap } from "~/lib/store";
import { categoriesFor, fullCatalog } from "~/lib/categories";
import type { ScoredProspect } from "~/lib/lists";

export const Route = createFileRoute("/prospects/")({
  component: ProspectsPage,
});

function ProspectsPage() {
  const [threshold, setThreshold] = useState(DEFAULT_FIT_THRESHOLD);
  const [category, setCategory] = useState("");

  const { ranked, counts } = useMemo(() => {
    const imported = getImportedProspects();
    const scored: ScoredProspect[] = imported.map((p) => ({ ...p, fit: computeFit(p) })).sort((a, b) => b.fit!.score - a.fit!.score);
    const map = getCategoryMap();
    const visible = scored.filter((p) => {
      if (p.fit!.score < threshold) return false;
      if (category) return categoriesFor(p, p.fit!, map).all.includes(category);
      return true;
    });
    return { ranked: visible, counts: { total: scored.length, visible: visible.length, imported: imported.length } };
  }, [threshold, category]);

  const catalog = fullCatalog();

  return (
    <div className="space-y-6">
      <SectionHead
        eyebrow="Prospects"
        title={`${counts.visible} of ${counts.total} prospects meet fit ≥ ${threshold}${category ? " · " + (catalog.find((c) => c.id === category)?.label ?? category) : ""}`}
        desc="Ranked by Operion Fit Score. Imported rows carry Unverified provenance until enriched — nothing is fabricated."
      />

      {/* Filters — one card, two controls */}
      <Card className="p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <p className="mb-1.5 flex items-center justify-between text-xs">
              <span className="font-medium text-fg">Fit threshold</span>
              <span className="font-mono text-accent-light">{threshold}</span>
            </p>
            <input
              type="range"
              min={0}
              max={100}
              value={threshold}
              onChange={(e) => setThreshold(+e.target.value)}
              className="w-full accent-[#8b5cf6]"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:max-w-md">
            <span className="text-[11px] uppercase tracking-label text-faint">Category</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="input-dark w-auto min-w-[14rem] text-sm" aria-label="Filter by category">
              <option value="">All categories</option>
              {catalog.map((c) => (
                <option key={c.id} value={c.id}>{c.label}{c.auto ? " (auto)" : ""}</option>
              ))}
            </select>
            {category && (
              <button type="button" onClick={() => setCategory("")} className="text-xs text-muted underline-offset-2 hover:text-fg hover:underline">
                Clear
              </button>
            )}
          </div>
        </div>
        <p className="mt-3 border-t border-white/5 pt-2.5 text-[11px] leading-relaxed text-faint">
          Below the threshold, prospects are scored but filtered out of the ranked list. Categories are assigned on each prospect&apos;s detail page — auto categories (tiers, industry, outreach state) are computed from data.
        </p>
      </Card>

      {counts.total === 0 ? (
        <div className="glass flex flex-col items-center gap-3 p-12 text-center">
          <span className="icon-tile">
            <Icon name="layers" className="h-5 w-5" />
          </span>
          <p className="text-sm font-medium text-fg">No prospects yet</p>
          <p className="max-w-sm text-xs text-muted">
            Import your first list via CSV on <Link to="/bulk" className="text-accent-light underline">Bulk Analysis</Link>, run a{" "}
            <Link to="/search" search={{ q: "" }} className="text-accent-light underline">search</Link> to discover companies, or paste a company URL into Website Intelligence on the search page.
          </p>
        </div>
      ) : (
        <ProspectTable prospects={ranked} showSource />
      )}
    </div>
  );
}
