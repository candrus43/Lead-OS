/**
 * Bulk async processing — shared types.
 *
 * A bulk run takes a large prospect set (CSV upload or provider discovery),
 * processes it server-side in batches (discover → score → enrich → verify),
 * persists results to disk, and exposes run-level progress + server-paginated
 * results. The browser never receives the full dataset, and the server never
 * holds it all in memory at once (batches of 100 are processed and freed).
 */

import type { SearchFilters } from "../types";
import type { CostRules } from "../fitScore";
import type { UsageEntry } from "../providers/costs";
import type { EnrichmentStep } from "../enrich";

/** Run lifecycle. */
export type BulkRunStatus = "queued" | "running" | "complete" | "cancelled" | "error";

/** Per-prospect lifecycle inside a run. */
export type ProspectRunStatus =
  | "Queued"
  | "Processing"
  | "Scoring"
  | "Enriching"
  | "Verifying"
  | "Complete"
  | "Error"
  | "Cancelled";

/** Where the run's prospects come from. */
export interface BulkRunSource {
  kind: "csv" | "provider";
  /** Human label for the source (shown in history). */
  label: string;
  fileName?: string;
  providerId?: string;
  filters?: SearchFilters;
  maxResults?: number;
}

/** One persisted/derived row of run results. */
export interface BulkRunItemResult {
  /** 0-based position within the run (stable across pages). */
  index: number;
  status: ProspectRunStatus;
  /** Scored (and where applicable enriched) prospect. */
  prospect?: import("../types").Prospect;
  /** Estimated USD spent enriching this prospect (0 if skipped/error). */
  cost: number;
  steps?: EnrichmentStep[];
  /** True when the enrichment waterfall actually enriched this prospect. */
  enriched?: boolean;
  /** Skip/error reason (skipped by fit gate, dedupe, budget, or a row/run error). */
  error?: string;
}

/** Run-level summary — what the UI polls. */
export interface BulkRunSummary {
  id: string;
  status: BulkRunStatus;
  source: BulkRunSource;
  mock: boolean;
  rules: CostRules;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  totalCount: number;
  processedCount: number;
  completeCount: number;
  errorCount: number;
  cancelledCount: number;
  currentStage: string; // queued | discovering | scoring | enriching | verifying | complete | cancelled | error
  stageDetail?: string;
  /** Items currently in flight in the active batch. */
  runningCount: number;
  etaSeconds?: number;
  /** Estimated USD so far (discovery + enrichment). */
  cost: number;
  usage: UsageEntry[];
  batchSize: number;
  cancelRequested: boolean;
  batchesCompleted: number;
  stoppedReason?: string; // e.g. maxEnrichPerRun reached
  error?: string; // fatal run error
  durationSec?: number;
}

/** One page of a run's results. */
export interface BulkRunPage {
  runId: string;
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  items: BulkRunItemResult[];
  runStatus: BulkRunStatus;
  processedCount: number;
}
