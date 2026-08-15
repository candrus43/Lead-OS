/**
 * Bulk async processing — server functions.
 *
 * The client starts a run (CSV text or provider discovery params) and receives
 * the run summary immediately; processing continues in the background on the
 * server. The client then polls getBulkRun for progress and fetches results one
 * page at a time (getBulkRunPage) — the full dataset is never sent to the
 * browser, and the server never holds it in memory (batches of 100 are
 * processed, persisted, and freed).
 */

import { createServerFn } from "@tanstack/react-start";
import type { CostRules } from "./fitScore";
import type { SearchFilters } from "./types";
import * as manager from "./bulk/manager";
import type { BulkRunPage, BulkRunSummary } from "./bulk/types";

const envMock = () => process.env.ENABLE_PROVIDER_MOCKS === "true";

export interface StartBulkRunInput {
  source:
    | { kind: "csv"; label?: string; fileName?: string; csvText: string }
    | { kind: "provider"; label?: string; providerId: string; filters: SearchFilters; maxResults?: number };
  mock: boolean;
  rules: CostRules;
}

export const startBulkRun = createServerFn({ method: "POST" })
  .validator((d: StartBulkRunInput) => d)
  .handler(async ({ data }): Promise<BulkRunSummary> => {
    const mock = data.mock || envMock();
    return manager.createRun({ source: data.source, mock, rules: data.rules });
  });

export const getBulkRun = createServerFn({ method: "POST" })
  .validator((d: { id: string }) => d)
  .handler(async ({ data }): Promise<BulkRunSummary | null> => manager.getRun(data.id));

export const listBulkRuns = createServerFn({ method: "GET" }).handler(
  async (): Promise<BulkRunSummary[]> => manager.listRuns()
);

export const cancelBulkRun = createServerFn({ method: "POST" })
  .validator((d: { id: string }) => d)
  .handler(async ({ data }): Promise<BulkRunSummary | null> => manager.cancelRun(data.id));

export const getBulkRunPage = createServerFn({ method: "POST" })
  .validator((d: { id: string; page: number; pageSize?: number }) => d)
  .handler(async ({ data }): Promise<BulkRunPage | null> =>
    manager.getPage(data.id, data.page, data.pageSize ?? 50)
  );
