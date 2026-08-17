/**
 * Auth server functions — login / logout / getSession / guardModule.
 *
 * Sessions are HttpOnly signed cookies. Server fns may live in src/lib and be
 * imported from client components: the build transform replaces the handlers
 * with RPC stubs on the client, so the node-only imports below never run in
 * the browser. The cookie is set/cleared through the framework's request
 * context (setCookie/deleteCookie from @tanstack/react-start/server).
 *
 * Logins: the owner account (username "owner") is authenticated against
 * OPERION_OWNER_PASSWORD (env). Agent accounts come from the owner-managed
 * roster (data/agents/agents.json, see ./agents) — an agent's username +
 * password hash are looked up there; disabled agents cannot sign in. The agent
 * roster also counts toward "auth configured" (the app flips into login mode
 * when the first agent is added, even before an owner password is set).
 */

import { createServerFn } from "@tanstack/react-start";
import { deleteCookie, getCookie, setCookie } from "@tanstack/react-start/server";
import {
  OWNER_USERNAME,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  authConfig,
  issueSession,
  sessionSecret,
  storedHashes,
  verifyPassword,
  verifySession,
  type Role,
} from "./auth";

export interface SessionState {
  /** null when not signed in (or auth not configured) */
  role: Role | null;
  user: string | null;
  /** false → open mode: the app runs without logins */
  authConfigured: boolean;
  /** true → a valid signed session cookie was presented */
  authenticated: boolean;
}

/**
 * Roster-aware auth snapshot: count + secret material from the persisted agent
 * store. Loaded dynamically (./agents imports fs/crypto) so the client never
 * traces it.
 */
async function rosterState(): Promise<{ count: number; material: string }> {
  const { agentsCount, rosterSecretMaterial } = await import("./agents");
  return { count: agentsCount(), material: rosterSecretMaterial() };
}

async function currentSession(): Promise<SessionState> {
  const roster = await rosterState();
  const cfg = authConfig(process.env, roster.count);
  if (!cfg.enabled) return { role: null, user: null, authConfigured: false, authenticated: false };
  const session = verifySession(getCookie(SESSION_COOKIE), sessionSecret(process.env, roster.material));
  return session
    ? { role: session.role, user: session.user, authConfigured: true, authenticated: true }
    : { role: null, user: null, authConfigured: true, authenticated: false };
}

export const getSession = createServerFn({ method: "GET" }).handler(async (): Promise<SessionState> => currentSession());

export type LoginResult = { ok: true; role: Role } | { ok: false; error: "auth-disabled" | "invalid-credentials" };

export const login = createServerFn({ method: "POST" })
  .validator((d: { username: string; password: string }) => d)
  .handler(async ({ data }): Promise<LoginResult> => {
    const roster = await rosterState();
    const cfg = authConfig(process.env, roster.count);
    if (!cfg.enabled) return { ok: false, error: "auth-disabled" };
    const username = String(data.username ?? "").trim().toLowerCase();
    const password = String(data.password ?? "");
    const secret = sessionSecret(process.env, roster.material);
    let role: Role | null = null;
    let sessionUser: string | null = null;
    if (username === OWNER_USERNAME) {
      // Owner account is env-based. If OPERION_OWNER_PASSWORD is not set, owner
      // login simply cannot succeed (agents may still sign in) — acceptable.
      const { ownerHash } = storedHashes();
      if (ownerHash && verifyPassword(password, ownerHash)) role = "owner";
    } else {
      // Roster agent: look up the username, verify against the stored hash.
      const { findAgentByUsername } = await import("./agents");
      const agent = findAgentByUsername(username);
      if (agent && agent.active && verifyPassword(password, agent.hash)) {
        role = "agent";
        sessionUser = agent.username;
      }
    }
    if (!role) return { ok: false, error: "invalid-credentials" };
    setCookie(SESSION_COOKIE, issueSession(role, secret, sessionUser ?? undefined), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
    return { ok: true, role };
  });

export const logout = createServerFn({ method: "POST" })
  .validator((d: Record<string, never>) => d)
  .handler(async () => {
    deleteCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true as const };
  });

/** Modules that agent accounts must never access (hidden AND server-guarded). */
export type GuardedModule = "settings" | "providers";

export type GuardResult = { allowed: boolean; role: Role | null; authConfigured: boolean };

export const guardModule = createServerFn({ method: "POST" })
  .validator((d: { module: GuardedModule }) => d)
  .handler(async (): Promise<GuardResult> => {
    const s = await currentSession();
    if (!s.authConfigured) return { allowed: true, role: null, authConfigured: false };
    if (!s.authenticated || !s.role) return { allowed: false, role: null, authConfigured: true };
    // owner may access everything; agents may access nothing guarded
    return { allowed: s.role === "owner", role: s.role, authConfigured: true };
  });
