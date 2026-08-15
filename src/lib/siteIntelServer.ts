/**
 * Server function for Website Intelligence.
 *
 * The analyzer (src/lib/siteIntel.ts) runs server-side with plain fetch — the
 * client never sees intermediate fetches, only the resulting Prospect with its
 * provenance and evidence. Works with zero API keys.
 */

import { createServerFn } from "@tanstack/react-start";
import { analyzeSite } from "./siteIntel";
import type { SiteIntelResult } from "./siteIntel";

export type { SiteIntelResult } from "./siteIntel";

export const analyzeCompanyWebsite = createServerFn({ method: "POST" })
  .validator((d: { url: string }) => d)
  .handler(async ({ data }): Promise<SiteIntelResult> => analyzeSite(data.url));
