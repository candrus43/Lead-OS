/**
 * Auth server functions — login / logout / getSession / guardModule.
 *
 * Sessions are HttpOnly signed cookies. Server fns may live in src/lib and be
 * imported from client components: the build transform replaces the handlers
 * with RPC stubs on the client, so the node-only imports below never run in
 * the browser. The cookie is set/cleared through the framework's request
 * context (setCookie/deleteCookie from @tanstack/react-start/server).
 */

import { createServerFn } from "@tanstack/react-start";
import { deleteCookie, getCookie, setCookie } from "@tanstack/react-start/server";
import {
  AGENT_USERNAME,
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

function currentSession(): SessionState {
  const cfg = authConfig();
  if (!cfg.enabled) return { role: null, user: null, authConfigured: false, authenticated: false };
  const session = verifySession(getCookie(SESSION_COOKIE), sessionSecret());
  return session
    ? { role: session.role, user: session.user, authConfigured: true, authenticated: true }
    : { role: null, user: null, authConfigured: true, authenticated: false };
}

export const getSession = createServerFn({ method: "GET" }).handler(async (): Promise<SessionState> => currentSession());

export type LoginResult = { ok: true; role: Role } | { ok: false; error: "auth-disabled" | "invalid-credentials" };

export const login = createServerFn({ method: "POST" })
  .validator((d: { username: string; password: string }) => d)
  .handler(async ({ data }): Promise<LoginResult> => {
    const cfg = authConfig();
    if (!cfg.enabled) return { ok: false, error: "auth-disabled" };
    const username = String(data.username ?? "").trim().toLowerCase();
    const password = String(data.password ?? "");
    const hashes = storedHashes();
    let role: Role | null = null;
    if (username === OWNER_USERNAME && hashes.ownerHash && verifyPassword(password, hashes.ownerHash)) role = "owner";
    else if (username === AGENT_USERNAME && hashes.agentHash && verifyPassword(password, hashes.agentHash)) role = "agent";
    if (!role) return { ok: false, error: "invalid-credentials" };
    setCookie(SESSION_COOKIE, issueSession(role, sessionSecret()), {
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
    const s = currentSession();
    if (!s.authConfigured) return { allowed: true, role: null, authConfigured: false };
    if (!s.authenticated || !s.role) return { allowed: false, role: null, authConfigured: true };
    // owner may access everything; agents may access nothing guarded
    return { allowed: s.role === "owner", role: s.role, authConfigured: true };
  });
