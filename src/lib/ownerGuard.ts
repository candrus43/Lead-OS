/**
 * Owner-only server-side module guard — used by server fns that must never
 * answer for agent accounts (mirrors guardModule's rule in authServer.ts).
 *
 * This module is server-only: it is loaded via dynamic import() from inside
 * server-fn handlers (see webhookServer.ts) so the client bundle never traces
 * it — auth.ts imports node:crypto and would break the client build if it were
 * statically imported from a file the browser loads.
 */

import { authConfig, sessionSecret, verifySession, SESSION_COOKIE } from "./auth";
import { getCookie } from "@tanstack/react-start/server";

export type GuardedModuleName = "settings" | "providers";

/** Same rule as guardModule: open mode allows; otherwise owner only. */
export function allowedModule(_module: GuardedModuleName): boolean {
  const cfg = authConfig();
  if (!cfg.enabled) return true; // open mode: everything reachable
  const session = verifySession(getCookie(SESSION_COOKIE), sessionSecret());
  return session?.role === "owner";
}
