/**
 * Owner-managed agent roster — persisted under data/agents/agents.json
 * (gitignored via /data/, same pattern as data/deals/closed-deals.json).
 *
 * The owner adds/removes agent accounts from Settings → Team / Agents as people
 * get hired. This module is server-only: it is loaded via dynamic import()
 * inside server-fn handlers (see agentsServer.ts / authServer.ts / ownerGuard.ts)
 * so the client bundle never traces fs/crypto.
 *
 * Security rules:
 *  - Passwords are never stored or logged in plaintext — only the salted scrypt
 *    "salt:hash" (hashPassword from ./auth). Never return hashes to clients.
 *  - listAgents() returns sanitized records only (no hash field).
 *  - The username "owner" is reserved for the env-password owner account.
 *  - Disabling an agent (active: false) blocks login but keeps the record.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { OWNER_USERNAME, hashPassword } from "./auth";

/* --------------------------------- types ---------------------------------- */

export interface AgentRecord {
  id: string;
  name: string;
  username: string;
  /** salted scrypt "salt:hash" — server-only, NEVER returned to clients */
  hash: string;
  createdAt: string; // ISO
  createdBy: "owner";
  active: boolean;
}

/** What clients may see — no hash, ever. */
export type SanitizedAgent = Omit<AgentRecord, "hash">;

export type AgentResult = { ok: true; agent: SanitizedAgent } | { ok: false; error: string };

/* ------------------------------- storage ---------------------------------- */

function agentsDir(): string {
  return process.env.AGENTS_DATA_DIR || path.join(process.cwd(), "data", "agents");
}

function agentsPath(): string {
  return path.join(agentsDir(), "agents.json");
}

function ensureDir(): void {
  mkdirSync(agentsDir(), { recursive: true });
}

function readText(p: string): string | null {
  try {
    if (!existsSync(p)) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Atomic-ish write: tmp file then rename (same pattern as data/deals). */
function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

let cache: { at: number; agents: AgentRecord[] } | null = null;
const CACHE_TTL_MS = 1500;

function readAgentsRaw(): AgentRecord[] {
  try {
    const raw = readText(agentsPath());
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as AgentRecord[]) : [];
  } catch {
    return [];
  }
}

/** Read the roster, tolerating an absent/empty/corrupt file (→ []). */
export function readAgents(): AgentRecord[] {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.agents;
  const agents = readAgentsRaw();
  cache = { at: now, agents };
  return agents;
}

function writeAgents(all: AgentRecord[]): void {
  ensureDir();
  writeJsonAtomic(agentsPath(), all);
  cache = { at: Date.now(), agents: all };
}

/** Number of roster agents — drives authConfig()'s enabled/agent flags. */
export function agentsCount(): number {
  return readAgents().length;
}

/**
 * Material mixed into the session-secret fallback (auth.ts sessionSecret):
 * a digest of every roster hash, so the fallback secret is never a constant
 * value once agents exist, and stays stable across restarts (the hashes are
 * persisted). Empty string when the roster is empty.
 */
export function rosterSecretMaterial(): string {
  const agents = readAgents();
  if (!agents.length) return "";
  return createHash("sha256").update(agents.map((a) => a.hash).join("|")).digest("hex");
}

/* ------------------------------ lookups ----------------------------------- */

function sanitize(a: AgentRecord): SanitizedAgent {
  return { id: a.id, name: a.name, username: a.username, createdAt: a.createdAt, createdBy: a.createdBy, active: a.active };
}

/** All agents, sanitized (no hashes), newest first. */
export function listAgents(): SanitizedAgent[] {
  return [...readAgents()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(sanitize);
}

export function findAgentByUsername(username: string): AgentRecord | null {
  const u = String(username ?? "").trim().toLowerCase();
  return readAgents().find((a) => a.username === u) ?? null;
}

export function findAgentById(id: string): AgentRecord | null {
  return readAgents().find((a) => a.id === id) ?? null;
}

/* ------------------------------ validation -------------------------------- */

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/; // 2–40 chars: lowercase alnum + . _ -

export function validateUsername(username: string): string | null {
  const u = String(username ?? "").trim().toLowerCase();
  if (u.length < 2 || u.length > 40) return "Username must be 2–40 characters.";
  if (u === OWNER_USERNAME) return `"${OWNER_USERNAME}" is reserved for the owner account.`;
  if (!USERNAME_RE.test(u)) return "Username may only contain lowercase letters, numbers, dots, dashes and underscores.";
  return null;
}

export function validatePassword(password: string): string | null {
  if (String(password ?? "").length < 8) return "Password must be at least 8 characters.";
  return null;
}

/* ------------------------------- mutations -------------------------------- */

export function createAgent(input: { name: string; username: string; password: string }): AgentResult {
  const name = String(input?.name ?? "").trim();
  const username = String(input?.username ?? "").trim().toLowerCase();
  const password = String(input?.password ?? "");
  if (!name) return { ok: false, error: "Name is required." };
  const uErr = validateUsername(username);
  if (uErr) return { ok: false, error: uErr };
  const pErr = validatePassword(password);
  if (pErr) return { ok: false, error: pErr };
  if (findAgentByUsername(username)) return { ok: false, error: `Username "${username}" is already taken.` };

  const record: AgentRecord = {
    id: randomUUID(),
    name,
    username,
    hash: hashPassword(password),
    createdAt: new Date().toISOString(),
    createdBy: "owner",
    active: true,
  };
  const all = readAgents();
  all.push(record);
  writeAgents(all);
  return { ok: true, agent: sanitize(record) };
}

/** Rename and/or enable/disable. Disabling blocks login but keeps the record. */
export function updateAgent(id: string, patch: { name?: string; active?: boolean }): AgentResult {
  const all = readAgents();
  const a = all.find((x) => x.id === id);
  if (!a) return { ok: false, error: "Agent not found." };
  if (patch?.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) return { ok: false, error: "Name is required." };
    a.name = name;
  }
  if (patch?.active !== undefined) a.active = !!patch.active;
  writeAgents(all);
  return { ok: true, agent: sanitize(a) };
}

export function resetAgentPassword(id: string, password: string): AgentResult {
  const pErr = validatePassword(password);
  if (pErr) return { ok: false, error: pErr };
  const all = readAgents();
  const a = all.find((x) => x.id === id);
  if (!a) return { ok: false, error: "Agent not found." };
  a.hash = hashPassword(password);
  writeAgents(all);
  return { ok: true, agent: sanitize(a) };
}

/** Hard delete — the record (and its hash) is removed from the roster. */
export function deleteAgent(id: string): AgentResult {
  const all = readAgents();
  const idx = all.findIndex((x) => x.id === id);
  if (idx < 0) return { ok: false, error: "Agent not found." };
  const [removed] = all.splice(idx, 1);
  writeAgents(all);
  return { ok: true, agent: sanitize(removed) };
}
