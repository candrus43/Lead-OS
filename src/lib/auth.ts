/**
 * Auth core — pure server-side module (NO createServerFn so it can be tested
 * standalone under bun). Passwords are never stored or sent in plaintext:
 * env holds the owner password at boot, we derive a salted scrypt hash in memory
 * and compare with constant-time equality. Sessions are HttpOnly cookies holding
 * a signed payload (HMAC-SHA256, SESSION_SECRET or a fallback derived from the
 * password hashes plus the agent roster).
 *
 * Env contract:
 *   OPERION_OWNER_PASSWORD  — enables owner login (username "owner") and
 *                             switches the app into login-required mode.
 *   SESSION_SECRET          — optional; derived from the owner hash + roster
 *                             material when absent so sessions still survive
 *                             restarts (and are never a constant value once
 *                             any login is configured).
 *
 * Agent accounts are NOT env-based: the owner manages a persisted roster
 * (data/agents/agents.json) from Settings → Team / Agents. The roster lives in
 * src/lib/agents.ts (server-only); authConfig()/sessionSecret() take the roster
 * size/material as parameters so this module stays pure and bun-testable.
 */

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export type Role = "owner" | "agent";
export interface SessionInfo {
  role: Role;
  user: string;
}

export const OWNER_USERNAME = "owner";
export const SESSION_COOKIE = "op_leados_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h
export const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;

export interface AuthConfig {
  /** true when at least one login is configured → the app requires login */
  enabled: boolean;
  owner: boolean;
  /** true when roster agents exist → agent login is available */
  agent: boolean;
}

/**
 * @param rosterCount number of persisted agent accounts (0 when the roster
 *        store is empty/absent) — passed by server callers that can read the
 *        store; this module itself stays fs-free.
 */
export function authConfig(env: Record<string, string | undefined> = process.env, rosterCount = 0): AuthConfig {
  const owner = !!env.OPERION_OWNER_PASSWORD;
  const agent = rosterCount > 0;
  return { enabled: owner || agent, owner, agent };
}

/** salted scrypt hash, "salt:hash" (salt 16 bytes hex, hash 64 bytes hex) */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

/** constant-time comparison against a stored "salt:hash" value */
export function verifyPassword(password: string, stored: string): boolean {
  const sep = stored.indexOf(":");
  if (sep <= 0) return false;
  const salt = stored.slice(0, sep);
  const expected = Buffer.from(stored.slice(sep + 1), "hex");
  if (!salt || expected.length === 0) return false;
  const candidate = scryptSync(password, salt, 64);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

interface StoredHashes {
  ownerHash: string | null;
}

let memo: StoredHashes | null = null;

/** in-memory salted hash derived once per process from env (never persisted) */
export function storedHashes(env: Record<string, string | undefined> = process.env): StoredHashes {
  if (!memo) {
    memo = { ownerHash: env.OPERION_OWNER_PASSWORD ? hashPassword(env.OPERION_OWNER_PASSWORD) : null };
  }
  return memo;
}

/**
 * Session signing secret. SESSION_SECRET wins when set; otherwise the fallback
 * mixes the owner hash with the agent roster's secret material so it is stable
 * within a process and never a constant when any login is configured.
 */
export function sessionSecret(env: Record<string, string | undefined> = process.env, rosterMaterial = ""): string {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const { ownerHash } = storedHashes(env);
  return createHash("sha256").update(`op-leados:${ownerHash ?? ""}:${rosterMaterial}`).digest("hex");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Issue a signed session token for the given role. `username` is embedded so
 * the UI can show who is signed in (roster agents carry their username; owner
 * and legacy sessions fall back to the role name).
 */
export function issueSession(role: Role, secret: string, username?: string): string {
  const user = username && username.trim() ? username.trim() : role;
  const payload = Buffer.from(JSON.stringify({ role, user, exp: Date.now() + SESSION_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** Verify a session token (signature + expiry). Returns null when invalid. */
export function verifySession(token: string | null | undefined, secret: string): SessionInfo | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { role?: string; user?: string; exp?: number };
    if (data.role !== "owner" && data.role !== "agent") return null;
    if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
    const user = typeof data.user === "string" && data.user ? data.user : data.role;
    return { role: data.role, user };
  } catch {
    return null;
  }
}
