/**
 * AI Company Research + Outreach Assistant — pure logic (no createServerFn),
 * shared by the template path and the LLM path (see researchServer.ts).
 *
 * HONESTY MODEL — never fabricate:
 *  - Every fact in a research brief comes from the prospect's real sourced
 *    fields (store fields, provider enrichment, website-intel evidence, or the
 *    deterministic fit engine). Nothing else.
 *  - Known gaps (fields with no data) are listed explicitly.
 *  - Template prose is assembled from facts only; where a needed detail is
 *    missing, drafts use an honest bracketed placeholder ([First name], …)
 *    instead of inventing one.
 *  - The LLM path (researchServer.ts) is given ONLY these facts + gaps and a
 *    strict prompt forbidding invented data.
 */

import type { Prospect, VerificationStatus } from "./types";
import { shortLocation } from "./types";
import { computeFit } from "./fitScore";

/* --------------------------------- types ---------------------------------- */

export type DraftType = "cold-email" | "linkedin" | "founder" | "executive" | "referral";

export const DRAFT_TYPES: { id: DraftType; label: string; hint: string }[] = [
  { id: "cold-email", label: "Cold email", hint: "Professional, concise, to the recommended contact" },
  { id: "linkedin", label: "LinkedIn intro", hint: "Short connection-note style" },
  { id: "founder", label: "Founder-to-founder", hint: "Peer voice, first-person" },
  { id: "executive", label: "Executive outreach", hint: "Higher-level, operational-visibility framing" },
  { id: "referral", label: "Referral / casual", hint: "Warm, low-pressure networking" },
];

/** One sourced fact that a brief (or draft) is allowed to rely on. */
export interface BriefFact {
  label: string; // e.g. "Industry", "Employees", "Fit signal: Multi-site"
  value: string; // display value, verbatim from sourced data
  source: string; // provenance: "csv-import", "website:<domain>", "fit-engine", …
  verificationStatus: VerificationStatus;
  capturedAt?: string;
}

export interface RecommendedContact {
  name: string; // real name, or "Unknown"
  title: string; // real title, or "Unknown"
  email?: string;
  phone?: string;
  source: string;
  verificationStatus: VerificationStatus;
  note: string; // why this contact is recommended
  /** true when no real contact record existed and we fall back to the fit engine's buyer role */
  fallbackToRole: boolean;
}

export interface BriefProse {
  overview: string;
  whyFit: string;
  painPoints: string;
  outreachAngle: string;
  contactNote: string;
}

export interface ResearchBrief {
  prospectId: string;
  companyName: string;
  generatedAt: string;
  mode: "ai" | "template";
  llmProvider?: string; // set when mode === "ai"
  llmError?: string; // set when the LLM was configured but failed → fell back to template
  overview: BriefFact[];
  whyFit: BriefFact[];
  painPoints: BriefFact[];
  recommendedContact: RecommendedContact | null;
  outreachAngle: BriefFact[];
  gaps: string[]; // known unknowns — drafts must never fill these with invented data
  allFacts: BriefFact[]; // union of every fact above (used for display + LLM context)
  prose: BriefProse; // template prose always present; LLM path may replace with AI prose
}

export interface OutreachDraft {
  type: DraftType;
  subject: string;
  body: string;
  mode: "ai" | "template";
  llmProvider?: string;
  llmError?: string;
  /** facts the draft is grounded in (the same allFacts as the brief) */
  groundedIn: BriefFact[];
  /** bracketed placeholders the human must fill before sending */
  placeholders: string[];
}

/* --------------------------- fact collection ------------------------------ */

const prov = (p: Prospect, key: keyof Prospect): { label: string; value: string; status: VerificationStatus; source: string; capturedAt?: string } | null => {
  const v = p[key];
  if (!v || typeof v !== "object" || !("value" in v)) return null;
  const pv = v as { value: unknown; source?: string; verificationStatus?: VerificationStatus; capturedAt?: string };
  const val = pv.value;
  if (val === undefined || val === null || val === "") return null;
  return {
    label: key,
    value: String(val),
    status: pv.verificationStatus ?? "Unknown",
    source: pv.source ?? "unknown",
    capturedAt: pv.capturedAt,
  };
};

/** Collect every real sourced fact about a prospect. Returns facts + gaps. */
export function collectFacts(p: Prospect): { facts: BriefFact[]; gaps: string[] } {
  const facts: BriefFact[] = [];
  const gaps: string[] = [];
  const push = (label: string, value: string, source: string, status: VerificationStatus, capturedAt?: string) => {
    facts.push({ label, value, source, verificationStatus: status, capturedAt });
  };

  const name = prov(p, "companyName");
  if (name) push("Company name", name.value, name.source, name.status, name.capturedAt);
  else gaps.push("Company name is unknown");

  const industry = prov(p, "industry");
  if (industry && industry.value !== "Unknown") {
    push("Industry", industry.value, industry.source, industry.status, industry.capturedAt);
    const sub = prov(p, "subIndustry");
    if (sub && sub.value) push("Sub-industry", sub.value, sub.source, sub.status, sub.capturedAt);
  } else gaps.push("Industry is unknown");

  const loc = p.location;
  if (loc?.value && (loc.value.city || loc.value.state || loc.value.country)) {
    push("Location", shortLocation(loc.value), loc.source, loc.verificationStatus, loc.capturedAt);
  } else gaps.push("Location is unknown");

  const emp = prov(p, "employees");
  if (emp) push("Employees", emp.value, emp.source, emp.status, emp.capturedAt);
  else gaps.push("Employee count is unknown");

  const rev = prov(p, "revenue");
  if (rev) push("Revenue", rev.value, rev.source, rev.status, rev.capturedAt);
  else gaps.push("Revenue is unknown");

  const web = prov(p, "website");
  if (web) push("Website", web.value, web.source, web.status, web.capturedAt);
  else gaps.push("Website is unknown");

  const desc = prov(p, "description");
  if (desc) push("Description", desc.value.length > 220 ? desc.value.slice(0, 220) + "…" : desc.value, desc.source, desc.status, desc.capturedAt);

  if (p.isSample) push("Data kind", "Fictional sample data (demo)", "sample-data", "Unknown");
  if (p.mock) push("Data kind", "Mock (dry-run) provider data", `mock:${p.sourceProvider}`, "Unknown");

  // Website intelligence evidence — real findings from the public site.
  const intel = p.websiteIntel;
  if (intel) {
    push("Website analysis", `${intel.domain} · ${intel.pagesFetched} page(s) analyzed`, `website:${intel.domain}`, "High Confidence", intel.analyzedAt);
    for (const e of intel.evidence.slice(0, 12)) {
      if (!e.label || !e.detail) continue;
      push(`Site: ${e.label}`, e.detail.length > 140 ? e.detail.slice(0, 140) + "…" : e.detail, `website:${intel.domain}`, e.status, intel.analyzedAt);
    }
    for (const w of intel.warnings) {
      gaps.push(`Website analysis warning: ${w}`);
    }
  }

  return { facts, gaps };
}

/** Fit-engine facts (score, signals, buyer, pain) — deterministic, explainable. */
export function collectFitFacts(p: Prospect): {
  whyFit: BriefFact[];
  painPoints: BriefFact[];
  buyer: { recommended: string; secondary: string };
} {
  const fit = p.fit ?? computeFit(p);
  const whyFit: BriefFact[] = [];
  const painPoints: BriefFact[] = [];
  const src = "fit-engine";
  const now = new Date().toISOString();

  whyFit.push({
    label: "Operion Fit Score",
    value: `${fit.score}/100 (${fit.grade})`,
    source: src,
    verificationStatus: "High Confidence",
    capturedAt: now,
  });
  whyFit.push({ label: "Fit threshold", value: `passes fit ≥ 55: ${fit.thresholdMet ? "yes" : "no"}`, source: src, verificationStatus: "High Confidence", capturedAt: now });
  for (const r of fit.reasons.slice(0, 10)) {
    whyFit.push({ label: `Fit signal: ${r.label}`, value: r.note, source: src, verificationStatus: "High Confidence", capturedAt: now });
  }
  if (!fit.reasons.length) {
    whyFit.push({ label: "Fit signals", value: "No positive signals detected — low fit", source: src, verificationStatus: "High Confidence", capturedAt: now });
  }
  whyFit.push({ label: "Recommended buyer", value: fit.recommendedBuyer, source: src, verificationStatus: "High Confidence", capturedAt: now });
  whyFit.push({ label: "Secondary buyer", value: fit.secondaryBuyer, source: src, verificationStatus: "High Confidence", capturedAt: now });

  painPoints.push({ label: "Likely pain point (fit engine)", value: fit.likelyPainPoint, source: src, verificationStatus: "High Confidence", capturedAt: now });
  for (const r of fit.reasons.slice(0, 6)) {
    painPoints.push({ label: `Signal detail: ${r.label}`, value: r.note, source: src, verificationStatus: "High Confidence", capturedAt: now });
  }

  return { whyFit, painPoints, buyer: { recommended: fit.recommendedBuyer, secondary: fit.secondaryBuyer } };
}

/** Contacts as facts (real, sourced) + the recommended contact record. */
export function collectContactFacts(p: Prospect): {
  facts: BriefFact[];
  recommended: RecommendedContact | null;
  gaps: string[];
} {
  const facts: BriefFact[] = [];
  const gaps: string[] = [];
  const fit = p.fit ?? computeFit(p);
  const primary = p.contacts.find((c) => c.isPrimary) ?? p.contacts[0];

  for (const c of p.contacts.slice(0, 6)) {
    const who = `${c.fullName.value} — ${c.title.value}`;
    facts.push({ label: "Decision maker", value: who, source: c.fullName.source, verificationStatus: c.fullName.verificationStatus, capturedAt: c.fullName.capturedAt });
    if (c.email) facts.push({ label: `Email (${c.fullName.value})`, value: c.email.value, source: c.email.source, verificationStatus: c.email.verificationStatus, capturedAt: c.email.capturedAt });
    if (c.phone) facts.push({ label: `Phone (${c.fullName.value})`, value: c.phone.value, source: c.phone.source, verificationStatus: c.phone.verificationStatus, capturedAt: c.phone.capturedAt });
  }

  if (primary) {
    const name = primary.fullName.value !== "Unknown" ? primary.fullName.value : "Unknown";
    const title = primary.title.value !== "Unknown" ? primary.title.value : "Unknown";
    const statuses = [primary.fullName.verificationStatus, primary.title.verificationStatus, primary.email?.verificationStatus, primary.phone?.verificationStatus].filter(
      (s): s is VerificationStatus => !!s
    );
    const status: VerificationStatus = statuses.length ? statuses.sort((a, b) => bestOrder(a) - bestOrder(b))[0] : "Unknown";
    const note =
      name !== "Unknown"
        ? `Primary decision-maker contact${primary.email || primary.phone ? " with reachable details" : " (no email or phone on file yet)"} from ${primary.fullName.source}.`
        : `No named decision-maker on file — the fit engine recommends ${fit.recommendedBuyer}.`;
    facts.push({ label: "Recommended contact", value: `${name} · ${title}`, source: primary.fullName.source, verificationStatus: status, capturedAt: primary.fullName.capturedAt });
    return {
      facts,
      recommended: {
        name,
        title,
        email: primary.email?.value,
        phone: primary.phone?.value,
        source: primary.fullName.source,
        verificationStatus: status,
        note,
        fallbackToRole: false,
      },
      gaps,
    };
  }

  gaps.push("No decision-maker contact record");
  return {
    facts,
    recommended: {
      name: "Unknown",
      title: fit.recommendedBuyer,
      source: "fit-engine",
      verificationStatus: "Unknown",
      note: `No decision-maker contact record exists yet — the fit engine recommends the ${fit.recommendedBuyer} role at this company.`,
      fallbackToRole: true,
    },
    gaps,
  };
}

function bestOrder(s: VerificationStatus): number {
  return ["Verified", "High Confidence", "Likely", "Unverified", "Unknown"].indexOf(s);
}

/* ------------------------- template prose builder -------------------------- */

function fmtFact(facts: BriefFact[], label: string): string | undefined {
  return facts.find((f) => f.label === label)?.value;
}

function listOf(facts: BriefFact[], prefix: string): string[] {
  return facts.filter((f) => f.label.startsWith(prefix)).map((f) => f.value);
}

/** Company overview prose — assembled from real fields only. */
export function templateOverview(p: Prospect, facts: BriefFact[]): string {
  const parts: string[] = [];
  const name = p.companyName.value;
  const indLine = industryLine(p);
  const loc = shortLocation(p.location.value);
  const desc = fmtFact(facts, "Description");

  if (indLine && loc && loc !== "—") parts.push(`${name} is a ${indLine} company based in ${loc}.`);
  else if (indLine) parts.push(`${name} is a ${indLine} company.`);
  else if (loc && loc !== "—") parts.push(`${name} is based in ${loc}.`);
  else parts.push(`${name}.`);

  const emp = fmtFact(facts, "Employees");
  if (emp) parts.push(`Employee count on file: ${emp}.`);
  const rev = fmtFact(facts, "Revenue");
  if (rev) parts.push(`Revenue on file: ${rev}.`);
  const web = fmtFact(facts, "Website");
  if (web) parts.push(`Website: ${web}.`);
  if (desc) parts.push(`Description: “${desc}”.`);
  if (p.isSample) parts.push("(This is fictional sample data used to demo the engine.)");
  return parts.join(" ");
}

/** Why Operion may fit — grounded in the fit engine's real signals/reasons. */
export function templateWhyFit(p: Prospect, _whyFit: BriefFact[]): string {
  const fit = p.fit ?? computeFit(p);
  const parts: string[] = [];
  parts.push(
    `Scored ${fit.score}/100 (${fit.grade}) against Operion's ideal customer profile${fit.thresholdMet ? " — above the fit threshold" : " — below the fit threshold"}.`
  );
  if (fit.reasons.length) {
    const labels = fit.reasons.slice(0, 5).map((r) => r.label);
    parts.push(`Detected signals: ${labels.join("; ")}${fit.reasons.length > 5 ? ` (and ${fit.reasons.length - 5} more)` : ""}.`);
  } else {
    parts.push("No positive operational signals were detected.");
  }
  parts.push(`The fit engine maps this profile to the ${fit.recommendedBuyer} as the recommended buyer (secondary: ${fit.secondaryBuyer}).`);
  return parts.join(" ");
}

/** Likely operational pain points — from the fit engine's pain + signal notes. */
export function templatePainPoints(p: Prospect, painPoints: BriefFact[]): string {
  const fit = p.fit ?? computeFit(p);
  const parts: string[] = [];
  parts.push(fit.likelyPainPoint);
  const notes = listOf(painPoints, "Signal detail:").slice(0, 3);
  if (notes.length) parts.push(`Signal-level detail: ${notes.join(" ")}`);
  if (!fit.reasons.length) parts.push("No operational signals were detected, so no specific pain point can be inferred from the data.");
  return parts.join(" ");
}

/** Outreach angle — grounded in industry/location/website evidence only. */
export function templateOutreachAngle(p: Prospect, facts: BriefFact[]): string {
  const fit = p.fit ?? computeFit(p);
  const parts: string[] = [];
  const ind = p.industry.value !== "Unknown" ? p.industry.value : "operator";
  const loc = shortLocation(p.location.value);
  const site = listOf(facts, "Site: ").slice(0, 3);
  const emp = fmtFact(facts, "Employees");

  const anchor: string[] = [];
  if (p.signals.constructionActivity || p.signals.creActivity) anchor.push("active projects and properties");
  if (p.signals.multipleLocations || p.signals.multipleEntities) anchor.push("multiple locations/entities");
  if (p.signals.hospitalityOperations) anchor.push("day-to-day site operations");
  if (p.signals.growthRate) anchor.push("rapid growth");
  if (p.signals.spreadsheetHeavy || p.signals.disconnectedSoftware) anchor.push("manual, spreadsheet-heavy processes");

  const where = loc !== "—" ? ` in ${loc}` : "";
  const who = anchor.length ? `${ind}${where} juggling ${anchor.slice(0, 2).join(" and ")}` : `${ind}${where}`;
  parts.push(`Lead with the ${fit.recommendedBuyer.toLowerCase()}-relevant angle: ${who}, and the operational friction the fit engine flagged — ${fit.likelyPainPoint.toLowerCase()}`);

  if (site.length) {
    parts.push(`Website evidence to reference: ${site.join(" · ")}.`);
  } else if (emp) {
    parts.push(`Size context to reference: ${emp} employees on file.`);
  }
  if (p.isSample) parts.push("(Sample record — demo only.)");
  return parts.join(" ");
}

/** Contact recommendation prose. */
export function templateContactNote(rec: RecommendedContact | null): string {
  if (!rec) return "No contact identified.";
  return rec.note;
}

/** Build the full template brief (facts + prose + gaps) — the grounding for BOTH paths. */
export function buildTemplateBrief(p: Prospect): ResearchBrief {
  const { facts, gaps } = collectFacts(p);
  const { whyFit, painPoints } = collectFitFacts(p);
  const contact = collectContactFacts(p);

  const overviewFacts = facts.filter((f) =>
    ["Company name", "Industry", "Sub-industry", "Location", "Employees", "Revenue", "Website", "Description", "Data kind"].some((l) => f.label === l)
  );
  const outreachFacts = [
    ...facts.filter((f) =>
      ["Industry", "Sub-industry", "Location", "Employees", "Revenue", "Website"].some((l) => f.label === l)
    ),
    ...facts.filter((f) => f.label.startsWith("Site: ")),
  ];
  const allFacts = dedupeFacts([...overviewFacts, ...whyFit, ...painPoints, ...contact.facts, ...outreachFacts]);
  const allGaps = dedupe([...gaps, ...contact.gaps, ...(p.websiteIntel?.warnings ?? []).map((w) => `Website analysis warning: ${w}`)]);

  return {
    prospectId: p.id,
    companyName: p.companyName.value,
    generatedAt: new Date().toISOString(),
    mode: "template",
    overview: overviewFacts,
    whyFit,
    painPoints,
    recommendedContact: contact.recommended,
    outreachAngle: outreachFacts,
    gaps: allGaps,
    allFacts,
    prose: {
      overview: templateOverview(p, overviewFacts),
      whyFit: templateWhyFit(p, whyFit),
      painPoints: templatePainPoints(p, painPoints),
      outreachAngle: templateOutreachAngle(p, outreachFacts),
      contactNote: templateContactNote(contact.recommended),
    },
  };
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list));
}

function dedupeFacts(list: BriefFact[]): BriefFact[] {
  const seen = new Set<string>();
  const out: BriefFact[] = [];
  for (const f of list) {
    const key = `${f.label}|${f.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/* ------------------------------ LLM prompts -------------------------------- */

/** Serialize the grounding (facts + gaps) for the LLM — the ONLY context it gets. */
export function groundingPayload(brief: ResearchBrief): { facts: unknown[]; gaps: string[] } {
  return {
    facts: brief.allFacts.map((f) => ({
      label: f.label,
      value: f.value,
      source: f.source,
      verificationStatus: f.verificationStatus,
    })),
    gaps: brief.gaps,
  };
}

export const RESEARCH_SYSTEM_PROMPT = `You are the research analyst for Operion, an operations platform that unifies entities, projects, documents, and workflows for real-estate, construction, and hospitality operators.

You will receive a JSON array of SOURCED FACTS about one prospect company and a list of KNOWN GAPS (fields with no data). Every fact has a label, value, source, and verification status.

HARD RULES — non-negotiable:
1. Use ONLY the provided facts. Never invent, assume, or add any company fact, name, number, statistic, claim, location, or detail that is not present in the facts.
2. Never present a gap as if it were data. If something is unknown, say it is unknown or omit it.
3. Do not speculate about the company's business beyond what the facts state.
4. Reflect verification honestly: when a fact is Unverified or Likely (e.g. something found on the public website), phrase it as "the website lists…" or similar — never assert unverified data as established fact.
5. When no positive signals exist, say the fit is low and no specific pain point can be inferred.
6. Output ONLY valid JSON, no markdown, no commentary:
{
  "overview": "...",      // 2-4 sentences: who the company is, from the facts only
  "whyFit": "...",        // 2-4 sentences: why Operion's platform may fit, grounded in the fit score, detected signals, and recommended buyer
  "painPoints": "...",    // 2-4 sentences: likely operational pain points, derived strictly from the detected signals (multi-entity, multi-location, project volume, documents, disconnected software, etc.)
  "outreachAngle": "...", // 2-3 sentences: a suggested outreach angle grounded in the company's industry, location, and website findings
  "contactNote": "..."    // 1-2 sentences: who to contact and why, from the contact facts (or note honestly that no decision-maker contact data exists and suggest the recommended buyer role)
}`;

export function researchUserPrompt(brief: ResearchBrief): string {
  const g = groundingPayload(brief);
  return `SOURCED FACTS:\n${JSON.stringify(g.facts, null, 1)}\n\nKNOWN GAPS:\n${JSON.stringify(g.gaps, null, 1)}`;
}

export function draftSystemPrompt(type: DraftType): string {
  const typeDesc = DRAFT_TYPES.find((d) => d.id === type)?.label ?? type;
  return `You are an outreach-draft assistant for Operion, an operations platform that unifies entities, projects, documents, and workflows for real-estate, construction, and hospitality operators.

You will receive a JSON array of SOURCED FACTS about one prospect company, a list of KNOWN GAPS, and the company's research brief (recommended contact + outreach angle). Draft exactly ONE ${typeDesc} message to the recommended contact.

HARD RULES — non-negotiable:
1. Use ONLY the provided facts. Never invent company facts, names, numbers, stats, project names, or claims not present in the facts.
2. If a needed detail is missing (e.g. the contact's first name, a company location, an email), use an honest bracketed placeholder like [First name] or [City] — never invent a value.
3. Do not mention specific projects, metrics, or outcomes unless the facts contain them.
4. You may describe Operion's offering in general terms (an operations platform that unifies entities, projects, documents, and workflows for real-estate/construction/hospitality operators) — this describes Operion, not the prospect, and is allowed.
5. Keep it professional, specific to the prospect's real context, and short. One message only — no follow-up sequences, no send automation.
6. ${type === "linkedin" || type === "referral" ? 'For this casual type keep it to 2-4 short sentences.' : 'For this formal type keep it to 120-180 words, with a clear, low-pressure ask.'}
7. Output ONLY valid JSON, no markdown:
{"subject": "...", "body": "..."}`;
}

export function draftUserPrompt(brief: ResearchBrief, type: DraftType): string {
  const g = groundingPayload(brief);
  const rec = brief.recommendedContact;
  return `MESSAGE TYPE: ${type}\n\nRECOMMENDED CONTACT:\n${rec ? JSON.stringify({ name: rec.name, title: rec.title, email: rec.email ?? null, phone: rec.phone ?? null, source: rec.source }, null, 1) : "null"}\n\nOUTREACH ANGLE (from research):\n${brief.prose.outreachAngle}\n\nSOURCED FACTS:\n${JSON.stringify(g.facts, null, 1)}\n\nKNOWN GAPS:\n${JSON.stringify(g.gaps, null, 1)}`;
}

/* --------------------------- template drafts ------------------------------- */

function detectPlaceholders(text: string): string[] {
  const m = text.match(/\[[^\]]+\]/g) ?? [];
  return Array.from(new Set(m));
}

function greeting(rec: RecommendedContact | null, casual: boolean): string {
  if (!rec) return casual ? "Hey there," : "Hello,";
  const first = rec.name !== "Unknown" ? rec.name.split(" ")[0] : "";
  if (first) return casual ? `Hey ${first},` : `Hi ${first},`;
  if (rec.title !== "Unknown") return `Hi ${rec.title},`;
  return casual ? "Hey there," : "Hello,";
}

function industryLine(p: Prospect): string | null {
  const ind = p.industry.value !== "Unknown" ? p.industry.value : null;
  const sub = p.subIndustry?.value ? p.subIndustry.value : null;
  if (sub && ind && (sub.includes(ind) || ind.includes(sub))) return sub;
  const parts = [sub, ind].filter(Boolean);
  return parts.join(", ") || null;
}

function locLine(p: Prospect): string | null {
  const loc = shortLocation(p.location.value);
  return loc !== "—" ? loc : null;
}

function signalPhrase(p: Prospect): string[] {
  const map: [keyof Prospect["signals"], string][] = [
    ["multipleEntities", "multiple operating entities"],
    ["multipleLocations", "multiple locations"],
    ["constructionActivity", "active construction"],
    ["creActivity", "commercial real estate activity"],
    ["hospitalityOperations", "hospitality operations"],
    ["projectVolume", "high project volume"],
    ["documentBurden", "heavy document load"],
    ["departments", "multiple departments"],
    ["businessUnits", "multiple business units"],
    ["growthRate", "rapid growth"],
    ["acquisitionActivity", "recent acquisition activity"],
    ["portfolioOwnership", "a property portfolio"],
    ["workflowComplexity", "complex workflows"],
    ["operationalComplexity", "high operational complexity"],
    ["spreadsheetHeavy", "spreadsheet-heavy processes"],
    ["disconnectedSoftware", "disconnected software tools"],
  ];
  return map.filter(([k]) => p.signals[k]).slice(0, 3).map(([, v]) => v);
}

function painSentence(p: Prospect): string {
  const fit = p.fit ?? computeFit(p);
  return fit.likelyPainPoint;
}

/** Deterministic draft for each type — real facts only, [brackets] for missing. */
export function templateDraft(p: Prospect, brief: ResearchBrief, type: DraftType): OutreachDraft {
  const rec = brief.recommendedContact;
  const name = rec && rec.name !== "Unknown" ? rec.name : null;
  const title = rec && rec.title !== "Unknown" ? rec.title : null;
  const first = name ? name.split(" ")[0] : "[First name]";
  const company = p.companyName.value;
  const ind = industryLine(p);
  const loc = locLine(p);
  const signals = signalPhrase(p);
  const pain = painSentence(p);
  const web = p.website?.value ?? "";
  const siteEv = listOf(brief.allFacts, "Site: ").slice(0, 2);

  let subject = "";
  let body = "";

  switch (type) {
    case "cold-email": {
      subject = `${company} — ${signals[0] ?? "operational ops"}${loc ? ` in ${loc}` : ""}`;
      const intro = ind ? `${company} is a ${ind} company${loc ? ` based in ${loc}` : ""}` : `${company}`;
      body = [
        greeting(rec, false),
        "",
        `I'm reaching out from Operion. ${intro}, and the profile matches the operators we built for${signals.length ? ` — ${signals.join(", ")}` : ""}.`,
        "",
        `In short: ${pain}`,
        "",
        `Operion is an operations platform that unifies entities, projects, documents, and workflows for ${ind ?? "real-estate, construction, and hospitality"} operators — one source of truth instead of spreadsheets and disconnected tools.`,
        "",
        `Would a 20-minute call next week be worth your time to see whether it's relevant to ${company}?`,
        "",
        `Best,\n[Your name]\n[Your title], Operion`,
      ].join("\n");
      break;
    }
    case "linkedin": {
      subject = "";
      body = [
        `Hi ${first}, I came across ${company}${ind ? ` (${ind}${loc ? `, ${loc}` : ""})` : ""} and saw ${signals.join(", ") || "the kind of operational profile"} — the exact situation Operion's platform was built for.`,
        `${pain}`,
        `If you'd ever like to see how similar operators keep it in one place, happy to share — no strings.`,
      ].join("\n");
      break;
    }
    case "founder": {
      subject = `${company} × Operion — a quick thought`;
      const opener = first !== "[First name]" ? `Hey ${first},` : `Hey${title ? ` ${title},` : ","}`;
      body = [
        opener,
        "",
        `I'm [Your name], founder at Operion — we build an operations platform for ${ind ?? "real-estate, construction, and hospitality"} operators.`,
        "",
        `Looking at ${company}${loc ? ` in ${loc}` : ""}, the ${signals.join(", ") || "operational profile"} stood out. It's the pattern we started the company for: ${pain}`,
        "",
        `If that resonates, I'd genuinely enjoy comparing notes — 20 minutes, no deck required.`,
        "",
        `— [Your name], Operion`,
      ].join("\n");
      break;
    }
    case "executive": {
      subject = `${company} — operational visibility${signals.length ? ` across ${signals[0]}` : ""}`;
      body = [
        greeting(rec, false),
        "",
        `I lead Operion, an operations platform used by ${ind ?? "real-estate, construction, and hospitality"} operators to keep entities, projects, and workflows in one source of truth.`,
        "",
        `${company}'s profile${loc ? ` in ${loc}` : ""} (${signals.join(", ") || "significant operational surface area"}) points to a familiar pattern: ${pain}`,
        "",
        `That's exactly where manual coordination starts costing real money — and where we focus.`,
        "",
        `Worth 20 minutes to see whether this is relevant to ${company}?`,
        "",
        `Best,\n[Your name], Operion`,
      ].join("\n");
      break;
    }
    case "referral": {
      subject = "";
      body = [
        `Hey ${first !== "[First name]" ? first : title ?? "there"},`,
        "",
        `We haven't met — I found ${company} while researching ${ind ?? "operators"}${loc ? ` in ${loc}` : ""}${web ? ` (${web})` : ""}.`,
        siteEv.length ? `A few things on the site caught my eye: ${siteEv.join(" · ")}.` : "",
        `The team behind Operion works with ${ind ?? "operators"} on operational software. If it's ever relevant, happy to connect — and if not, no worries at all.`,
      ]
        .filter((s) => s !== "")
        .join("\n");
      break;
    }
  }

  return {
    type,
    subject,
    body,
    mode: "template",
    groundedIn: brief.allFacts,
    placeholders: detectPlaceholders(body + " " + subject),
  };
}

/** Finalize a brief whose AI prose succeeded: keep facts, swap prose, label AI. */
export function withLlmProse(brief: ResearchBrief, prose: BriefProse, provider: string): ResearchBrief {
  return { ...brief, mode: "ai", llmProvider: provider, prose };
}

/** Finalize a brief when the LLM failed: keep template prose, record the error. */
export function withLlmError(brief: ResearchBrief, error: string): ResearchBrief {
  return { ...brief, mode: "template", llmError: error };
}

export function withLlmDraft(draft: OutreachDraft, subject: string, body: string, provider: string): OutreachDraft {
  return { ...draft, subject, body, mode: "ai", llmProvider: provider, placeholders: detectPlaceholders(`${subject} ${body}`) };
}

export function withDraftLlmError(draft: OutreachDraft, error: string): OutreachDraft {
  return { ...draft, mode: "template", llmError: error };
}
