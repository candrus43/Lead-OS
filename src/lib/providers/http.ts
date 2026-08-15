/**
 * Tiny server-side fetch helper: JSON in/out, timeout, and graceful errors.
 * Used by every API provider adapter. Never throws on HTTP errors — callers
 * decide how to degrade (fields stay Unknown).
 */

const DEFAULT_TIMEOUT_MS = 12_000;

export async function fetchJson<T>(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}
): Promise<T | undefined> {
  const { method = "GET", headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: ctrl.signal,
    });
    if (!res.ok) return undefined;
    const text = await res.text();
    if (!text) return undefined;
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort: extract a full domain from a website string ("www.x.com/path" → "x.com"). */
export function domainOf(website?: string): string {
  if (!website) return "";
  return website
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0]
    .trim();
}

export const now = () => new Date().toISOString();
