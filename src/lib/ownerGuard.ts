/**
 * Owner-only server-side module guard — used by server fns that must never
 * answer for agent accounts (mirrors guardModule's rule in authServer.ts).
 *
 * This module is server-only: it is loaded via dynamic import() from inside
 * server-fn handlers (see webhookServer.ts / agentsServer.ts) so the client
 * bundle never traces it — auth.ts imports node:crypto and would break the
 * client build if it were statically imported from a file the browser loads.
 * The agent roster (./agents, fs-backed) is loaded dynamically for the same
 * reason, so this guard stays async.
 */

import { authConfig, sessionSecret, verifySession, SESSION_COOKIE } from "./auth";
import { getCookie } from "@tanstack/react-start/server";

export type GuardedModuleName = "settings" | "providers";

/**
 * Same rule as guardModule: open mode allows; otherwise owner only. Roster-aware:
 * authConfig()/sessionSecret() receive the agent count + roster material so the
 * app flips into login mode when the first agent is added.
 */
export async function allowedModule(_module: GuardedModuleName): Promise<boolean> {
  const { agentsCount, rosterSecretMaterial } = await import("./agents");
  const cfg = authConfig(process.env, agentsCount());
  if (!cfg.enabled) return true; // open mode: everything reachable
  const session = verifySession(getCookie(SESSION_COOKIE), sessionSecret(process.env, rosterSecretMaterial()));
  return session?.role === "owner";
}
