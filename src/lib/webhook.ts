/**
 * Deal-closed webhook — CRM → Lead OS direction.
 *
 * The owner's CRM calls POST /api/webhooks/deal-closed when a deal closes. This
 * module is the server-side core: it authenticates the request with the Lead OS
 * API key (constant-time compare), validates the JSON payload, matches the deal
 * to an existing Lead OS prospect (by crmProspectId, else normalized
 * domain/website, else case-insensitive company name), records the closed deal
 * with full provenance in the persisted collection (data/deals/closed-deals.json),
 * and patches the matched prospect's persisted record with the won/deal fields.
 *
 * Design notes:
 *  - No TanStack imports here: serve.ts runs this module directly under Bun, and
 *    the built server bundle reaches the same code via webhookServer.ts. Both
 *    copies read/write the same files, so behavior is identical either way.
 *  - Idempotent on dealId: a repeat event updates the existing record, never
 *    duplicates it.
 *  - Unmatched deals are stored flagged {matched:false} — never dropped.
 *  - The API key lives in data/deals/apikey.txt (generated once, 48 hex chars)
 *    unless OPERION_LEADOS_API_KEY is set in the environment, in which case that
 *    value is authoritative. The key is never logged.
 *  - Every recorded field carries provenance {source:'crm-webhook', capturedAt,
 *    confidence:1, verificationStatus:'Verified'} — nothing is fabricated.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { randomBytes, timingSafeEqual } from "crypto";
import type { DealMatchBy, Prospect, Provenance } from "./types";

/* ------------------------------- constants -------------------------------- */

export const WEBHOOK_PATH = "/api/webhooks/deal-closed";
/**
 * Public health check for the webhook loop — GET, no auth. Any team can hit
 * this in one call to see whether the CRM → Lead OS loop is receiving events.
 */
export const WEBHOOK_HEALTH_PATH = "/api/webhooks/health";
/**
 * Public base URL of the working site — the CRM-facing webhook URL is
 * <this> + WEBHOOK_PATH. Keep in sync with the site label.
 */
export const WEBHOOK_BASE_URL = "https://operion-lead-os.ctonew.app";
export const WEBHOOK_HEADER_FORMAT = "Authorization: Bearer <LEAD_OS_API_KEY>";

/**
 * Illustrative example payload for the Settings-page integration card — the
 * CRM's real deal-closed shape: {dealId, stage, plan, customerName,
 * customerEmail, company, closedAt}. Uses reserved .example.com domains and a
 * clearly placeholder deal id — documentation, not real data.
 */
export const WEBHOOK_PAYLOAD_EXAMPLE: DealClosedPayloadExample = {
  dealId: "CRM-DEAL-1001",
  stage: "closed",
  plan: "Studio",
  customerName: "Jane Smith",
  customerEmail: "jane@customer.example.com",
  company: "Example Customer Co",
  closedAt: "2026-08-01T18:30:00Z",
};

/* --------------------------------- types ---------------------------------- */

/** Raw JSON body accepted by the webhook. All fields optional except dealId.
 *  This is the CRM's real payload shape: dealId, stage, plan, customerName,
 *  customerEmail, company, closedAt — plus the optional companyDomain /
 *  companyWebsite / crmProspectId the CRM team offered to include. dealValue /
 *  currency / companyName are accepted for backward compatibility. */
export interface DealClosedPayload {
  dealId?: unknown;
  stage?: unknown;
  plan?: unknown;
  customerName?: unknown;
  customerEmail?: unknown;
  /** Company name in the CRM's payload. */
  company?: unknown;
  closedAt?: unknown;
  companyDomain?: unknown;
  companyWebsite?: unknown;
  /** Backward-compat alias for company name. */
  companyName?: unknown;
  crmProspectId?: unknown;
  /** Backward-compat fields kept for older consumers. */
  dealValue?: unknown;
  currency?: unknown;
}

/** Concrete, serializable shape for the Settings-page payload example. */
export interface DealClosedPayloadExample {
  dealId: string;
  stage: string;
  plan: string;
  customerName: string;
  customerEmail: string;
  company: string;
  closedAt: string;
}

/** One persisted closed-deal record — every field provenance-wrapped. */
export interface ClosedDealRecord {
  dealId: string;
  matched: boolean;
  matchedBy?: DealMatchBy;
  prospectId?: string;
  prospectName?: string;
  fitScore?: number;
  fitBand?: string; // Excellent | Strong | Moderate | Weak
  fields: {
    dealId: Provenance<string>;
    dealValue?: Provenance<number>;
    currency?: Provenance<string>;
    stage?: Provenance<string>;
    plan?: Provenance<string>;
    closedAt?: Provenance<string>;
    companyDomain?: Provenance<string>;
    companyWebsite?: Provenance<string>;
    companyName?: Provenance<string>;
    crmProspectId?: Provenance<string>;
  };
  recordedAt: string; // ISO — first receipt
  updatedAt?: string; // ISO — set on idempotent updates
  idempotentUpdate?: boolean;
}

export interface ClosedDealsSummary {
  total: number;
  matched: number;
  unmatched: number;
  valueClosed: number; // sum of recorded dealValue
  valueClosedCount: number; // how many records carried a dealValue
  currencies: string[]; // distinct non-empty currencies (uppercased)
  byFitBand: { band: string; count: number; value?: number }[];
  hasValueData: boolean;
}

/* ------------------------------- storage ---------------------------------- */

function dataDir(): string {
  return process.env.WEBHOOK_DATA_DIR || path.join(process.cwd(), "data", "deals");
}

function keyPath(): string {
  return path.join(dataDir(), "apikey.txt");
}

function dealsPath(): string {
  return path.join(dataDir(), "closed-deals.json");
}

function ensureDir(): void {
  mkdirSync(dataDir(), { recursive: true });
}

function readText(p: string): string | null {
  try {
    if (!existsSync(p)) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Atomic-ish write: tmp file then rename (same pattern as data/bulk). */
function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

/* ------------------------------- API key ---------------------------------- */

/** Env override is authoritative when present; the generated key is the fallback. */
export function apiKeyFromEnv(): string | null {
  const v = process.env.OPERION_LEADOS_API_KEY?.trim();
  return v ? v : null;
}

export function apiKeySource(): "generated" | "env" {
  return apiKeyFromEnv() ? "env" : "generated";
}

/** Returns the authoritative key: env override if set, else the persisted key
 *  (generated once on first use — 48 hex chars). Never logs it. */
export function getApiKey(): string {
  const env = apiKeyFromEnv();
  if (env) return env;
  ensureDir();
  const existing = readText(keyPath())?.trim();
  if (existing) return existing;
  const generated = randomBytes(24).toString("hex");
  writeFileSync(keyPath(), `${generated}\n`, { mode: 0o600 });
  return generated;
}

/** Constant-time comparison — never leaks the expected key length content. */
export function verifyApiKey(candidate: string | null | undefined): boolean {
  if (!candidate) return false;
  const expected = getApiKey();
  const a = Buffer.from(String(candidate), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ------------------------------ coercion ---------------------------------- */

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function prov<T>(value: T): Provenance<T> {
  return {
    value,
    source: "crm-webhook",
    capturedAt: new Date().toISOString(),
    confidence: 1,
    verificationStatus: "Verified",
  };
}

/** Normalize a domain/website for matching: lowercase, no protocol, no www,
 *  no path/query/hash, no trailing dot. */
export function normalizeDomain(input: string | null | undefined): string {
  if (!input) return "";
  let d = String(input).trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip protocol
  d = d.split(/[/?#]/)[0]; // strip path/query/hash
  d = d.replace(/^www\./, ""); // strip leading www.
  d = d.replace(/\.$/, ""); // strip trailing dot
  return d.trim();
}

/* --------------------------- prospect matching ---------------------------- */

interface ProspectRef {
  id: string;
  name: string;
  website: string | null;
  domain: string; // normalized website
  /** Lowercased contact emails on the persisted prospect (for email matching). */
  emails: string[];
  fitScore?: number;
  fitBand?: string;
  isSample: boolean;
}

/* Sample prospects no longer exist (owner request 2026-08-12 — the app starts
 * with an empty pool, real data only). Matching runs against prospects persisted
 * by bulk runs; website-intelligence and CSV imports are matched client-side. */

let bulkIndexCache: { at: number; refs: ProspectRef[] } | null = null;
const BULK_INDEX_TTL_MS = 10_000;

/** Index of prospects persisted by bulk runs (data/bulk/<run>/batch-*.json). */
function bulkRefs(): ProspectRef[] {
  const now = Date.now();
  if (bulkIndexCache && now - bulkIndexCache.at < BULK_INDEX_TTL_MS) return bulkIndexCache.refs;
  const refs: ProspectRef[] = [];
  const dir = process.env.BULK_DATA_DIR || path.join(process.cwd(), "data", "bulk");
  try {
    const indexRaw = readText(path.join(dir, "index.json"));
    if (!indexRaw) return refs;
    const ids = JSON.parse(indexRaw) as string[];
    for (const id of ids) {
      const runDir = path.join(dir, id);
      if (!existsSync(runDir)) continue;
      for (const f of readdirSync(runDir).filter((x) => x.startsWith("batch-") && x.endsWith(".json"))) {
        try {
          const items = JSON.parse(readFileSync(path.join(runDir, f), "utf8")) as {
            prospect?: Prospect & { fit?: { score: number; grade: string } };
          }[];
          for (const it of items) {
            const p = it?.prospect;
            if (!p?.id) continue;
            const emails = (p.contacts ?? [])
              .map((c) => c?.email?.value?.trim().toLowerCase())
              .filter((e): e is string => !!e);
            refs.push({
              id: p.id,
              name: p.companyName?.value ?? "",
              website: p.website?.value ?? null,
              domain: normalizeDomain(p.website?.value),
              emails,
              fitScore: p.fit?.score,
              fitBand: p.fit?.grade,
              isSample: false,
            });
          }
        } catch {
          // skip unreadable batch file
        }
      }
    }
  } catch {
    // no bulk data yet
  }
  bulkIndexCache = { at: now, refs };
  return refs;
}

function allRefs(): ProspectRef[] {
  return bulkRefs();
}

/** Tolerant match in the CRM's payload order: crmProspectId → domain/website
 *  (normalized) → company name (ci) → customerEmail (ci, against prospect
 *  contact emails). */
export function findProspectMatch(payload: DealClosedPayload): { ref: ProspectRef; matchedBy: DealMatchBy } | null {
  const crmProspectId = str(payload.crmProspectId);
  if (crmProspectId) {
    for (const ref of allRefs()) {
      if (ref.id === crmProspectId) return { ref, matchedBy: "crmProspectId" };
    }
  }
  const domain = normalizeDomain(str(payload.companyDomain));
  const website = normalizeDomain(str(payload.companyWebsite));
  if (domain || website) {
    for (const ref of allRefs()) {
      if (!ref.domain) continue;
      if (domain && ref.domain === domain) return { ref, matchedBy: "domain" };
      if (website && ref.domain === website) return { ref, matchedBy: "website" };
    }
  }
  // The CRM sends the company name as `company`; `companyName` kept as a
  // backward-compat alias.
  const name = str(payload.company) ?? str(payload.companyName);
  if (name) {
    const lower = name.toLowerCase();
    for (const ref of allRefs()) {
      if (ref.name.toLowerCase() === lower) return { ref, matchedBy: "name" };
    }
  }
  const customerEmail = str(payload.customerEmail)?.toLowerCase();
  if (customerEmail) {
    for (const ref of allRefs()) {
      if (ref.emails.includes(customerEmail)) return { ref, matchedBy: "email" };
    }
  }
  return null;
}

/* --------------------------- closed-deals store ---------------------------- */

export function readClosedDeals(): ClosedDealRecord[] {
  try {
    const raw = readText(dealsPath());
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ClosedDealRecord[]) : [];
  } catch {
    return [];
  }
}

function writeClosedDeals(all: ClosedDealRecord[]): void {
  writeJsonAtomic(dealsPath(), all);
}

export function listClosedDeals(): ClosedDealRecord[] {
  return [...readClosedDeals()].sort((a, b) => (b.recordedAt ?? "").localeCompare(a.recordedAt ?? ""));
}

/**
 * Idempotent upsert keyed on dealId: a duplicate event updates the existing
 * record (refreshing fields + provenance, upgrading a match if one now exists)
 * and never creates a second entry.
 */
export function recordClosedDeal(
  payload: DealClosedPayload,
  match: { ref: ProspectRef; matchedBy: DealMatchBy } | null
): { record: ClosedDealRecord; idempotentUpdate: boolean } {
  ensureDir();
  const all = readClosedDeals();
  const dealId = str(payload.dealId)!; // validated by the caller
  const nowIso = new Date().toISOString();
  const existing = all.find((r) => r.dealId === dealId);

  const fields: ClosedDealRecord["fields"] = {
    dealId: prov(dealId),
    ...(num(payload.dealValue) !== null ? { dealValue: prov(num(payload.dealValue)!) } : {}),
    ...(str(payload.currency) ? { currency: prov(str(payload.currency)!) } : {}),
    ...(str(payload.stage) ? { stage: prov(str(payload.stage)!) } : {}),
    ...(str(payload.plan) ? { plan: prov(str(payload.plan)!) } : {}),
    ...(str(payload.closedAt) ? { closedAt: prov(str(payload.closedAt)!) } : {}),
    ...(str(payload.companyDomain) ? { companyDomain: prov(str(payload.companyDomain)!) } : {}),
    ...(str(payload.companyWebsite) ? { companyWebsite: prov(str(payload.companyWebsite)!) } : {}),
    ...(str(payload.company) ? { companyName: prov(str(payload.company)!) } : {}),
    ...(str(payload.companyName) && !str(payload.company) ? { companyName: prov(str(payload.companyName)!) } : {}),
    ...(str(payload.crmProspectId) ? { crmProspectId: prov(str(payload.crmProspectId)!) } : {}),
  };

  if (existing) {
    // Duplicate event — update in place, never a second record.
    existing.fields = fields;
    if (match) {
      // A repeat event can upgrade a previously unmatched deal to matched.
      existing.matched = true;
      existing.matchedBy = match.matchedBy;
      existing.prospectId = match.ref.id;
      existing.prospectName = match.ref.name;
      if (match.ref.fitScore !== undefined) existing.fitScore = match.ref.fitScore;
      if (match.ref.fitBand) existing.fitBand = match.ref.fitBand;
    }
    existing.updatedAt = nowIso;
    existing.idempotentUpdate = true;
    writeClosedDeals(all);
    if (match) patchProspectDeal(fields, match);
    return { record: existing, idempotentUpdate: true };
  }

  const record: ClosedDealRecord = {
    dealId,
    matched: !!match,
    ...(match
      ? {
          matchedBy: match.matchedBy,
          prospectId: match.ref.id,
          prospectName: match.ref.name,
          ...(match.ref.fitScore !== undefined ? { fitScore: match.ref.fitScore } : {}),
          ...(match.ref.fitBand ? { fitBand: match.ref.fitBand } : {}),
        }
      : {}),
    fields,
    recordedAt: nowIso,
  };
  all.push(record);
  writeClosedDeals(all);
  if (match) patchProspectDeal(fields, match);
  return { record, idempotentUpdate: false };
}

/** Attach the won/deal fields to the matched prospect's persisted record
 *  (bulk-run batches are the persisted collection for their prospects). */
function patchProspectDeal(fields: ClosedDealRecord["fields"], match: { ref: ProspectRef; matchedBy: DealMatchBy }): void {
  if (match.ref.isSample) return;
  const dir = process.env.BULK_DATA_DIR || path.join(process.cwd(), "data", "bulk");
  try {
    const indexRaw = readText(path.join(dir, "index.json"));
    if (!indexRaw) return;
    const ids = JSON.parse(indexRaw) as string[];
    for (const id of ids) {
      const runDir = path.join(dir, id);
      if (!existsSync(runDir)) continue;
      for (const f of readdirSync(runDir).filter((x) => x.startsWith("batch-") && x.endsWith(".json"))) {
        const file = path.join(runDir, f);
        try {
          const items = JSON.parse(readFileSync(file, "utf8")) as { index: number; prospect?: Prospect }[];
          let changed = false;
          for (const it of items) {
            if (it.prospect?.id === match.ref.id && !it.prospect.deal) {
              it.prospect.deal = {
                status: prov<"won">("won"),
                dealId: fields.dealId,
                ...(fields.dealValue ? { dealValue: fields.dealValue } : {}),
                ...(fields.currency ? { currency: fields.currency } : {}),
                ...(fields.stage ? { stage: fields.stage } : {}),
                ...(fields.plan ? { plan: fields.plan } : {}),
                ...(fields.closedAt ? { closedAt: fields.closedAt } : {}),
                matchedBy: match.matchedBy,
                recordedAt: fields.dealId.capturedAt,
              };
              changed = true;
            }
          }
          if (changed) writeJsonAtomic(file, items);
        } catch {
          // skip unreadable/untouched batch file
        }
      }
    }
  } catch {
    // best effort — the collection is the source of truth
  }
}

/* -------------------------------- summary ---------------------------------- */

export function closedDealsSummary(): ClosedDealsSummary {
  const all = readClosedDeals();
  const byBand = new Map<string, { count: number; value: number }>();
  let valueClosed = 0;
  let valueClosedCount = 0;
  const currencies = new Set<string>();
  for (const r of all) {
    if (r.fields.dealValue !== undefined) {
      valueClosed += r.fields.dealValue.value;
      valueClosedCount++;
    }
    if (r.fields.currency?.value) currencies.add(r.fields.currency.value.toUpperCase());
    const band = r.fitBand ?? "unmatched";
    const cur = byBand.get(band) ?? { count: 0, value: 0 };
    cur.count++;
    if (r.fields.dealValue !== undefined) cur.value += r.fields.dealValue.value;
    byBand.set(band, cur);
  }
  const byFitBand = [...byBand.entries()]
    .map(([band, v]) => ({ band, count: v.count, ...(v.value ? { value: Math.round(v.value * 100) / 100 } : {}) }))
    .sort((a, b) => b.count - a.count);
  return {
    total: all.length,
    matched: all.filter((r) => r.matched).length,
    unmatched: all.filter((r) => !r.matched).length,
    valueClosed: Math.round(valueClosed * 100) / 100,
    valueClosedCount,
    currencies: [...currencies].sort(),
    byFitBand,
    hasValueData: valueClosedCount > 0,
  };
}

/* ----------------------------- webhook config ------------------------------ */

export interface WebhookConfigInfo {
  method: "POST";
  url: string;
  headerFormat: string;
  payloadExample: DealClosedPayloadExample;
  keySource: "generated" | "env";
  keySet: boolean;
  /** Public health URL (GET, no auth) — reflects the persisted store. */
  healthUrl: string;
}

export function getWebhookConfigInfo(): WebhookConfigInfo {
  return {
    method: "POST",
    url: `${WEBHOOK_BASE_URL}${WEBHOOK_PATH}`,
    headerFormat: WEBHOOK_HEADER_FORMAT,
    payloadExample: WEBHOOK_PAYLOAD_EXAMPLE,
    keySource: apiKeySource(),
    keySet: true,
    healthUrl: `${WEBHOOK_BASE_URL}${WEBHOOK_HEALTH_PATH}`,
  };
}

/* ------------------------------- HTTP handler ------------------------------ */

/**
 * CORS headers — the owner's CRM is a browser SPA that calls this endpoint
 * cross-origin (fetch from operion-crm.ctonew.app). The endpoint is gated by a
 * secret API key, so allowing any origin is safe; the key is the gate.
 */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type, X-API-Key",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

/** POST /api/webhooks/deal-closed — public route, authenticated by API key. */
export async function handleDealClosedWebhook(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    // CORS preflight for the CRM's browser fetch.
    return new Response(null, { status: 204, headers: { ...CORS_HEADERS, "access-control-max-age": "86400" } });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "method-not-allowed", detail: "POST required" }, 405);
  }
  // API key auth (Bearer preferred; X-API-Key accepted). Constant-time compare.
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const candidate = bearer ?? req.headers.get("x-api-key")?.trim() ?? null;
  if (!verifyApiKey(candidate)) {
    return json(
      { ok: false, error: "unauthorized", detail: "valid Lead OS API key required — header: Authorization: Bearer <LEAD_OS_API_KEY>" },
      401
    );
  }

  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return json({ ok: false, error: "invalid-json", detail: "request body could not be read" }, 400);
  }
  if (!bodyText) return json({ ok: false, error: "invalid-json", detail: "empty body — send a JSON payload" }, 400);
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return json({ ok: false, error: "invalid-json", detail: "body is not valid JSON" }, 400);
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return json({ ok: false, error: "invalid-json", detail: "payload must be a JSON object" }, 400);
  }
  const p = payload as DealClosedPayload;
  if (!str(p.dealId)) {
    return json(
      { ok: false, error: "missing-field", field: "dealId", detail: "dealId (string) is required; all other fields are optional" },
      400
    );
  }

  try {
    const match = findProspectMatch(p);
    const { record, idempotentUpdate } = recordClosedDeal(p, match);
    return json(
      {
        ok: true,
        dealId: record.dealId,
        matched: record.matched,
        ...(record.matchedBy ? { matchedBy: record.matchedBy } : {}),
        ...(record.prospectId ? { prospectId: record.prospectId } : {}),
        ...(record.prospectName ? { prospectName: record.prospectName } : {}),
        status: record.matched ? "won" : "stored-unmatched",
        storedFlagged: !record.matched,
        idempotentUpdate,
        recordedAt: record.recordedAt,
      },
      200
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: "internal", detail: msg }, 500);
  }
}

/* ------------------------------- health check ------------------------------ */

/**
 * Public health payload for GET /api/webhooks/health — a minimal, derived
 * snapshot of the persisted closed-deals store. Exposes ONLY dealId +
 * timestamps: no API keys, no payloads, no prospect details. It reads the same
 * store the receiver writes (data/deals/closed-deals.json), so an empty store
 * reports exactly that — no record means no webhook has been received since
 * deployment. lastDeliveryError is always null today: the receiver returns a
 * 4xx/5xx to the caller instead of persisting rejection events; if we ever
 * record them, this field will surface the latest one.
 */
export interface WebhookHealth {
  status: "ok";
  endpoint: string;
  lastReceived: { dealId: string | null; at: string | null };
  totalReceived: number;
  lastDeliveryError: string | null;
  store: string;
  note: string;
}

function storeLabel(): string {
  const p = dealsPath();
  const rel = path.relative(process.cwd(), p);
  return rel && !rel.startsWith("..") ? rel : p;
}

export function webhookHealth(): WebhookHealth {
  // listClosedDeals() sorts by recordedAt desc, so the newest event is first.
  // totalReceived counts distinct deals in the store — idempotent repeats
  // update in place and never add records, so this is the persisted truth.
  const all = listClosedDeals();
  const latest = all[0] ?? null;
  return {
    status: "ok",
    endpoint: WEBHOOK_PATH,
    lastReceived: latest ? { dealId: latest.dealId, at: latest.recordedAt } : { dealId: null, at: null },
    totalReceived: all.length,
    lastDeliveryError: null,
    store: storeLabel(),
    note: "no record means no webhook has been received since deployment",
  };
}

/** GET /api/webhooks/health — public (no API key) by design: it must answer
 *  for anyone on the team without secrets, and it leaks nothing sensitive. */
export function handleWebhookHealth(req: Request): Response {
  if (req.method === "OPTIONS") {
    // CORS preflight for browser-side health checks.
    return new Response(null, { status: 204, headers: { ...CORS_HEADERS, "access-control-max-age": "86400" } });
  }
  if (req.method !== "GET") {
    return json({ ok: false, error: "method-not-allowed", detail: "GET required" }, 405);
  }
  return json(webhookHealth(), 200);
}
