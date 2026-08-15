/**
 * Auth core — pure server-side module (NO createServerFn so it can be tested
 * standalone under bun). Passwords are never stored or sent in plaintext:
 * env holds the plaintext at boot, we derive a salted scrypt hash in memory and
 * compare with constant-time equality. Sessions are HttpOnly cookies holding a
 * signed payload (HMAC-SHA256, SESSION_SECRET or a fallback derived from the
 * password hashes).
 *
 * Env contract:
 *   OPERION_OWNER_PASSWORD  — enables owner login (username "owner") and
 *                             switches the app into login-required mode.
 *   OPERION_AGENT_PASSWORD  — enables agent login (username "agent").
 *   SESSION_SECRET          — optional; derived from the password hashes when
 *                             absent so sessions still survive restarts.
 */

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export type Role = "owner" | "agent";
export interface SessionInfo {
  role: Role;
  user: string;
}

export const OWNER_USERNAME = "owner";
export const AGENT_USERNAME = "agent";
export const SESSION_COOKIE = "op_leados_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h
export const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;

export interface AuthConfig {
  /** true when at least one password is configured → the app requires login */
  enabled: boolean;
  owner: boolean;
  agent: boolean;
}

export function authConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const owner = !!env.OPERION_OWNER_PASSWORD;
  const agent = !!env.OPERION_AGENT_PASSWORD;
  return { enabled: owner || agent, owner, agent };
}

/** salted scrypt hash, "salt:hash" (salt 16 bytes hex, hash 64 bytes hex) */
function hashPassword(password: string): string {
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
  agentHash: string | null;
}

let memo: StoredHashes | null = null;

/** in-memory salted hashes derived once per process from env (never persisted) */
export function storedHashes(env: Record<string, string | undefined> = process.env): StoredHashes {
  if (!memo) {
    memo = {
      ownerHash: env.OPERION_OWNER_PASSWORD ? hashPassword(env.OPERION_OWNER_PASSWORD) : null,
      agentHash: env.OPERION_AGENT_PASSWORD ? hashPassword(env.OPERION_AGENT_PASSWORD) : null,
    };
  }
  return memo;
}

export function sessionSecret(env: Record<string, string | undefined> = process.env): string {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const { ownerHash, agentHash } = storedHashes(env);
  return createHash("sha256").update(`op-leados:${ownerHash ?? ""}:${agentHash ?? ""}`).digest("hex");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Issue a signed session token for the given role. */
export function issueSession(role: Role, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ role, exp: Date.now() + SESSION_TTL_MS })).toString("base64url");
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
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { role?: string; exp?: number };
    if (data.role !== "owner" && data.role !== "agent") return null;
    if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
    return { role: data.role, user: data.role };
  } catch {
    return null;
  }
}
