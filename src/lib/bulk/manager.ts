/**
 * Bulk run manager — server-side async processing engine.
 *
 * A run moves through Queued → Running (per-batch: Processing → Scoring →
 * Enriching → Verifying) → Complete / Cancelled / Error. Runs keep processing
 * in the background after the request returns; the UI polls run-level progress.
 *
 * Memory discipline:
 *   - Source data is streamed (CSV rows via a generator; provider discovery one
 *     page at a time) and grouped into batches of BATCH_SIZE.
 *   - Each batch is scored, passed through the fit-gated enrichment waterfall,
 *     persisted to disk, then dropped — the process never holds the whole set.
 *   - Results are served one page at a time from disk (a page spans at most two
 *     batch files).
 *
 * Persistence follows the site's file-based pattern: data/bulk/<runId>/meta.json
 * (run-level summary) + data/bulk/<runId>/batch-<seq>.json (≤100 items each) and
 * data/bulk/index.json (run id list). A run interrupted by a server restart is
 * honestly marked "error (interrupted)" on the next start.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import path from "path";
import type { Prospect } from "../types";
import { DEFAULT_COST_RULES, computeFit, type CostRules } from "../fitScore";
import { runWaterfall } from "../enrich";
import { buildRegistry, hasCapability, isProviderUsable, rowToProspect } from "../providers";
import { UsageTracker } from "../providers/costs";
import type { BulkRunItemResult, BulkRunPage, BulkRunSource, BulkRunSummary } from "./types";
import { countCsvRows, iterCsvRows } from "./csvStream";
import { mockDiscoverBulk } from "./mockDiscovery";

export const BATCH_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;
const MAX_CONCURRENT_RUNS = 3;
const MAX_RUNS_KEPT = 50;
/** Mock-mode pacing between batches so progress is observable in a dry run. */
const MOCK_BATCH_DELAY_MS = 200;

/* ------------------------------- storage ---------------------------------- */

function dataDir(): string {
  return process.env.BULK_DATA_DIR || path.join(process.cwd(), "data", "bulk");
}

function runDir(id: string): string {
  return path.join(dataDir(), id);
}

function metaPath(id: string): string {
  return path.join(runDir(id), "meta.json");
}

function batchPath(id: string, seq: number): string {
  return path.join(runDir(id), `batch-${seq}.json`);
}

function indexPath(): string {
  return path.join(dataDir(), "index.json");
}

function ensureDir(): void {
  mkdirSync(dataDir(), { recursive: true });
}

/** Atomic-ish write: tmp file then rename. */
function writeJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeMeta(meta: BulkRunSummary): void {
  writeJson(metaPath(meta.id), meta);
}

function readMeta(id: string): BulkRunSummary | null {
  return readJson<BulkRunSummary>(metaPath(id));
}

function writeBatch(id: string, seq: number, items: BulkRunItemResult[]): void {
  writeJson(batchPath(id, seq), items);
}

function loadBatch(id: string, seq: number): BulkRunItemResult[] {
  return readJson<BulkRunItemResult[]>(batchPath(id, seq)) ?? [];
}

/* ------------------------------ live state -------------------------------- */

interface LiveRun {
  meta: BulkRunSummary;
  /** Source payload held only while the run is active (freed when done). */
  csvText?: string;
  /** Items of the batch currently in flight (served live for pagination). */
  inFlight?: { seq: number; items: BulkRunItemResult[] };
  loop?: Promise<void>;
}

const live = new Map<string, LiveRun>();

/** Batch-file cache — a page touches at most 2 files; keep the last few hot. */
const batchCache = new Map<string, BulkRunItemResult[]>();
function cachedBatch(id: string, seq: number): BulkRunItemResult[] {
  const key = `${id}:${seq}`;
  const hit = batchCache.get(key);
  if (hit) return hit;
  const items = loadBatch(id, seq);
  batchCache.set(key, items);
  if (batchCache.size > 12) {
    const oldest = batchCache.keys().next().value;
    if (oldest) batchCache.delete(oldest as string);
  }
  return items;
}

let initialized = false;
function init(): void {
  if (initialized) return;
  initialized = true;
  ensureDir();
  const ids = readJson<string[]>(indexPath()) ?? [];
  for (const id of ids) {
    const meta = readMeta(id);
    if (!meta) continue;
    // A run that was mid-flight when the server restarted can't resume its
    // loop — mark it honestly rather than leave it stuck "running".
    if (meta.status === "running" || meta.status === "queued") {
      meta.status = "error";
      meta.currentStage = "error";
      meta.stageDetail = "interrupted by server restart — start a new run";
      meta.error = "interrupted by server restart";
      meta.finishedAt = new Date().toISOString();
      meta.runningCount = 0;
      writeMeta(meta);
    }
    live.set(id, { meta });
  }
}

function writeIndex(): void {
  ensureDir();
  const ids = [...live.keys()];
  writeJson(indexPath(), ids.slice(-MAX_RUNS_KEPT));
}

function summaryOf(meta: BulkRunSummary): BulkRunSummary {
  return JSON.parse(JSON.stringify(meta)) as BulkRunSummary;
}

/* -------------------------------- creation -------------------------------- */

/** Source payload accepted from the client (CSV text is server-side only). */
export type CreateBulkRunSource =
  | { kind: "csv"; label?: string; fileName?: string; csvText: string }
  | { kind: "provider"; label?: string; providerId: string; filters?: import("../types").SearchFilters; maxResults?: number };

export interface CreateBulkRunInput {
  source: CreateBulkRunSource;
  mock: boolean;
  rules: CostRules;
}

export function createRun(input: CreateBulkRunInput): BulkRunSummary {
  init();
  const activeCount = [...live.values()].filter((r) => r.meta.status === "queued" || r.meta.status === "running").length;
  if (activeCount >= MAX_CONCURRENT_RUNS) {
    throw new Error(`Too many concurrent runs (max ${MAX_CONCURRENT_RUNS}) — wait for an active run to finish.`);
  }
  const source = input.source;
  const id = `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  // The persisted source never carries the raw CSV text — the client gets a
  // summary back, and shipping megabytes of CSV back per poll would defeat the
  // whole point of server-side processing.
  const metaSource: BulkRunSource =
    source.kind === "csv"
      ? {
          kind: "csv",
          label: source.label ?? source.fileName ?? "CSV upload",
          fileName: source.fileName,
        }
      : {
          kind: "provider",
          label: source.label ?? source.providerId ?? "Provider discovery",
          providerId: source.providerId,
          filters: source.filters,
          maxResults: source.maxResults,
        };
  const meta: BulkRunSummary = {
    id,
    status: "queued",
    source: metaSource,
    mock: input.mock,
    rules: { ...DEFAULT_COST_RULES, ...input.rules },
    createdAt: new Date().toISOString(),
    totalCount: source.kind === "csv" ? countCsvRows(source.csvText ?? "") : Math.min(source.maxResults ?? 1000, 10000),
    processedCount: 0,
    completeCount: 0,
    errorCount: 0,
    cancelledCount: 0,
    currentStage: "queued",
    stageDetail: "waiting to start",
    runningCount: 0,
    cost: 0,
    usage: [],
    batchSize: BATCH_SIZE,
    cancelRequested: false,
    batchesCompleted: 0,
  };
  const run: LiveRun = { meta, csvText: source.kind === "csv" ? source.csvText : undefined };
  live.set(id, run);
  writeMeta(meta);
  writeIndex();
  const loop = processRun(id);
  run.loop = loop;
  void loop;
  return summaryOf(meta);
}

/* --------------------------------- cancel --------------------------------- */

export function cancelRun(id: string): BulkRunSummary | null {
  const run = live.get(id);
  const meta = run?.meta;
  if (!meta) return null;
  if (meta.status === "queued" || meta.status === "running") {
    meta.cancelRequested = true;
    meta.stageDetail = "cancel requested — stopping after the current batch";
    writeMeta(meta);
  }
  return summaryOf(meta);
}

/* ------------------------------ read helpers ------------------------------ */

export function getRun(id: string): BulkRunSummary | null {
  init();
  const run = live.get(id);
  if (run) return summaryOf(run.meta);
  const meta = readMeta(id);
  if (!meta) return null;
  live.set(id, { meta });
  return summaryOf(meta);
}

export function listRuns(): BulkRunSummary[] {
  init();
  const out: BulkRunSummary[] = [];
  for (const [id, run] of live) {
    out.push(run ? summaryOf(run.meta) : summaryOf(readMeta(id) as BulkRunSummary));
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_RUNS_KEPT);
}

/** Synthesized row for items that haven't been processed yet. */
function synthItem(index: number, meta: BulkRunSummary): BulkRunItemResult {
  if (meta.status === "cancelled") return { index, status: "Cancelled", cost: 0 };
  if (meta.status === "error" && index >= meta.processedCount) return { index, status: "Queued", cost: 0, error: meta.error };
  return { index, status: "Queued", cost: 0 };
}

export function getPage(id: string, page: number, pageSize: number = DEFAULT_PAGE_SIZE): BulkRunPage | null {
  init();
  const run = live.get(id);
  const meta = run?.meta ?? readMeta(id);
  if (!meta) return null;
  const total = Math.max(meta.totalCount, meta.processedCount, 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, page), totalPages);
  const startIdx = (p - 1) * pageSize;
  const endIdx = Math.min(startIdx + pageSize, total);
  const items: BulkRunItemResult[] = [];
  const completeSeq = meta.batchesCompleted;
  const inFlight = run?.inFlight;

  for (let idx = startIdx; idx < endIdx; idx++) {
    const seq = Math.floor(idx / BATCH_SIZE);
    if (inFlight && seq === inFlight.seq) {
      const item = inFlight.items.find((it) => it.index === idx);
      items.push(item ?? synthItem(idx, meta));
    } else if (seq < completeSeq) {
      const batch = cachedBatch(id, seq);
      const item = batch.find((it) => it.index === idx);
      items.push(item ?? synthItem(idx, meta));
    } else {
      items.push(synthItem(idx, meta));
    }
  }
  return {
    runId: id,
    page: p,
    pageSize,
    totalItems: total,
    totalPages,
    items,
    runStatus: meta.status,
    processedCount: meta.processedCount,
  };
}

/* --------------------------- the processing loop -------------------------- */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function processRun(id: string): Promise<void> {
  const run = live.get(id);
  if (!run) return;
  const meta = run.meta;
  const startedWall = Date.now();
  meta.status = "running";
  meta.startedAt = new Date().toISOString();
  meta.currentStage = "discovering";
  meta.stageDetail = meta.source.kind === "csv" ? "reading CSV" : "discovering companies";
  writeMeta(meta);

  const discoveryTracker = new UsageTracker(process.env);
  const enrichTracker = new UsageTracker(process.env);
  let seq = 0;

  try {
    for await (const batch of sourceBatches(run, discoveryTracker)) {
      if (meta.cancelRequested) break;
      const items: BulkRunItemResult[] = [];
      const waterfallInput: Prospect[] = [];
      const waterfallItemIdx: number[] = [];

      // ---- Stage: Processing + Scoring (free, deterministic) ----
      meta.currentStage = "scoring";
      meta.stageDetail = `Batch ${seq + 1} — scoring ${batch.length} prospects`;
      meta.runningCount = batch.length;
      writeMeta(meta);
      for (const raw of batch) {
        const index = meta.processedCount + items.length;
        if (raw.error) {
          items.push({ index, status: "Error", cost: 0, error: raw.error });
          continue;
        }
        const p: Prospect = { ...raw.prospect!, fit: computeFit(raw.prospect!) };
        items.push({ index, status: "Scoring", prospect: p, cost: 0 });
        waterfallInput.push(p);
        waterfallItemIdx.push(items.length - 1);
      }
      run.inFlight = { seq, items: items.map((it) => ({ ...it })) };
      if (meta.mock) await sleep(MOCK_BATCH_DELAY_MS);

      // ---- Stage: Enriching + Verifying (fit-gated waterfall, budget-shared) ----
      if (waterfallInput.length) {
        meta.currentStage = "enriching";
        meta.stageDetail = `Batch ${seq + 1} — enrichment waterfall (fit ≥ ${meta.rules.onlyEnrichCompanyAboveFit} gate, max ${meta.rules.maxEnrichPerRun} calls)`;
        writeMeta(meta);
        run.inFlight = { seq, items: items.map((it) => ({ ...it, status: it.prospect ? "Enriching" : it.status })) as BulkRunItemResult[] };
        if (meta.mock) await sleep(MOCK_BATCH_DELAY_MS);
        const report = await runWaterfall(waterfallInput, {
          rules: meta.rules,
          mock: meta.mock,
          env: process.env,
          tracker: enrichTracker,
        });
        for (let k = 0; k < waterfallItemIdx.length; k++) {
          const itemIdx = waterfallItemIdx[k];
          const ep = report.prospects[k];
          const fit = items[itemIdx].prospect?.fit;
          if (ep.reason === "enriched") {
            items[itemIdx] = {
              index: items[itemIdx].index,
              status: "Complete",
              prospect: { ...ep.prospect, fit },
              cost: ep.cost,
              steps: ep.steps,
              enriched: true,
            };
          } else {
            items[itemIdx] = {
              index: items[itemIdx].index,
              status: "Complete",
              prospect: { ...ep.prospect, fit },
              cost: 0,
              steps: ep.steps,
              error: ep.skipReason,
              enriched: false,
            };
          }
        }
        if (report.stoppedReason) meta.stoppedReason = report.stoppedReason;
      }

      // ---- Stage: Verifying (visible when the waterfall ran verify steps) ----
      meta.currentStage = "verifying";
      meta.stageDetail = `Batch ${seq + 1} — verifying contact data`;
      writeMeta(meta);
      run.inFlight = {
        seq,
        items: items.map((it) => {
          const hasVerify = it.steps?.some((s) => s.capability === "verifyEmail" || s.capability === "verifyPhone");
          return hasVerify ? { ...it, status: "Verifying" as const } : it;
        }),
      };
      if (meta.mock) await sleep(MOCK_BATCH_DELAY_MS);

      // ---- Persist the batch, update progress, free it ----
      meta.stageDetail = `Batch ${seq + 1} — persisting results`;
      writeBatch(meta.id, seq, items);
      seq++;
      meta.batchesCompleted = seq;
      meta.processedCount += items.length;
      meta.completeCount += items.filter((it) => it.status === "Complete").length;
      meta.errorCount += items.filter((it) => it.status === "Error").length;
      meta.cost = discoveryTracker.totalCost() + enrichTracker.totalCost();
      meta.usage = [...discoveryTracker.list(), ...enrichTracker.list()];
      meta.runningCount = 0;
      run.inFlight = undefined;
      const elapsedMs = Date.now() - startedWall;
      const remaining = Math.max(0, meta.totalCount - meta.processedCount);
      if (meta.processedCount > 0) {
        const perItem = elapsedMs / meta.processedCount;
        meta.etaSeconds = Math.max(0, Math.round((perItem * remaining) / 1000));
      }
      meta.stageDetail =
        meta.processedCount >= meta.totalCount
          ? "finalizing"
          : `Batch ${seq + 1} of ${Math.ceil(meta.totalCount / BATCH_SIZE)} — ${meta.processedCount}/${meta.totalCount} processed`;
      writeMeta(meta);
      if (meta.mock) await sleep(MOCK_BATCH_DELAY_MS);
    }

    // ---- Terminal state ----
    if (meta.cancelRequested) {
      meta.status = "cancelled";
      meta.currentStage = "cancelled";
      meta.stageDetail = `Cancelled after ${meta.processedCount} of ${meta.totalCount} items`;
      meta.cancelledCount = Math.max(0, meta.totalCount - meta.processedCount);
    } else {
      meta.status = "complete";
      meta.currentStage = "complete";
      meta.stageDetail = `All ${meta.processedCount} items processed`;
    }
    meta.finishedAt = new Date().toISOString();
    meta.durationSec = Math.round((Date.now() - startedWall) / 1000);
    meta.etaSeconds = 0;
    meta.runningCount = 0;
    writeMeta(meta);
  } catch (err) {
    meta.status = "error";
    meta.currentStage = "error";
    const msg = err instanceof Error ? err.message : String(err);
    meta.error = msg;
    meta.stageDetail = `Run failed: ${msg}`;
    meta.finishedAt = new Date().toISOString();
    meta.runningCount = 0;
    writeMeta(meta);
  } finally {
    run.inFlight = undefined;
    run.csvText = undefined;
    writeIndex();
    // Trim old run dirs beyond the keep cap (oldest first).
    const all = listRuns();
    if (all.length > MAX_RUNS_KEPT) {
      for (const old of all.slice(MAX_RUNS_KEPT)) {
        const dir = runDir(old.id);
        if (existsSync(dir)) {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            // best effort
          }
        }
        live.delete(old.id);
      }
    }
  }
}

/* ------------------------------ batch sources ----------------------------- */

/** Streams the run's source into batches of ≤ BATCH_SIZE items. */
async function* sourceBatches(run: LiveRun, discoveryTracker: UsageTracker): AsyncGenerator<{ prospect?: Prospect; error?: string }[]> {
  const meta = run.meta;
  const src = meta.source;

  if (src.kind === "csv") {
    const text = run.csvText ?? "";
    let buf: { prospect?: Prospect; error?: string }[] = [];
    for (const row of iterCsvRows(text)) {
      const p = rowToProspect(row, "csv", false);
      buf.push(p ? { prospect: p } : { error: "row could not be converted (missing company name)" });
      if (buf.length >= BATCH_SIZE) {
        yield buf;
        buf = [];
        if (meta.cancelRequested) break;
      }
    }
    if (buf.length) yield buf;
    run.csvText = undefined; // source text no longer needed
    return;
  }

  // ---- Provider discovery ----
  const providerId = src.providerId ?? "google-places";
  const maxResults = Math.min(src.maxResults ?? 1000, 10000);
  const registry = buildRegistry(process.env, meta.mock);
  const prov = registry.find((r) => r.def.id === providerId);
  if (!prov || !isProviderUsable(prov.def) || !hasCapability(prov, "discoverCompanies")) {
    throw new Error(
      `Discovery source "${providerId}" is not available${meta.mock ? " in mock mode" : ""} — configure its API key in Secrets or enable Dry run in Settings.`
    );
  }

  if (meta.mock) {
    let base = 0;
    while (base < maxResults) {
      const n = Math.min(BATCH_SIZE, maxResults - base);
      const chunk = mockDiscoverBulk(providerId, src.filters ?? {}, n, base);
      // One "page" per ~20 results — matches the single-call mock's page size.
      discoveryTracker.record(providerId, "discoverCompanies", Math.max(1, Math.ceil(n / 20)), true);
      yield chunk.map((p) => ({ prospect: p }));
      base += n;
      if (meta.cancelRequested) break;
    }
    meta.totalCount = Math.min(meta.totalCount, base);
    return;
  }

  // Real providers: page through until maxResults or exhaustion.
  let offset = 0;
  let got = 0;
  while (got < maxResults) {
    const page = await prov.discoverCompanies!({ ...(src.filters ?? {}), offset }, { mock: false, tracker: discoveryTracker });
    const list = (page ?? []).slice(0, maxResults - got);
    if (!list.length) break;
    yield list.map((p) => ({ prospect: p }));
    got += list.length;
    if (list.length < 20) break; // provider exhausted
    offset += list.length;
  }
  meta.totalCount = Math.min(meta.totalCount, got);
}
