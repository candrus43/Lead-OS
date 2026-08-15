/**
 * Sample dataset — REMOVED by owner request (2026-08-12).
 *
 * The app previously seeded 13 fictional companies ("Lone Star Development
 * Partners", etc.) so the flow was clickable with zero API keys. The owner asked
 * for the app to start clean — real data only. This module now seeds NOTHING;
 * it exists only so any remaining import sites resolve to an empty list without
 * behavior changes. The prospect pool comes entirely from user CSV imports,
 * provider discovery, and website intelligence.
 */

import type { Prospect } from "./types";

/** Always empty — no fictional companies are seeded. */
export function buildSampleProspects(): Prospect[] {
  return [];
}

export const SAMPLE_PROSPECTS: Prospect[] = [];
