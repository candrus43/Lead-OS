/**
 * Tiny server-side fetch helper: JSON in/out, timeout, and graceful errors.
 * Used by every API provider adapter. By default it never throws on HTTP
 * errors — callers decide how to degrade (fields stay Unknown).
 *
 * With `throwOnError: true` a non-OK response throws instead of returning
 * undefined, so real provider callers can surface API refusals (e.g. Apollo
 * "API not included in your Free plan") honestly to the user instead of a
 * silent zero. The thrown message is derived from the JSON error body when
 * parseable ({ error: "…" } or { message: "…" }) plus the HTTP status; an
 * unparseable body throws `HTTP <status>`.
 */

const DEFAULT_TIMEOUT_MS = 12_000;

/** Best-effort human-readable message from a JSON error body. */
function errorMessageFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.error === "string" && b.error.trim()) return b.error.trim();
  if (typeof b.message === "string" && b.message.trim()) return b.message.trim();
  // some APIs (Hunter) return { errors: [...] }; PDL returns { error: [...] }
  if (Array.isArray(b.error)) {
    const parts = b.error
      .map((e) => (typeof e === "string" ? e : (e as { message?: unknown })?.message))
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0);
    if (parts.length) return parts.join("; ");
  }
  if (Array.isArray(b.errors)) {
    const parts = b.errors
      .map((e) => (typeof e === "string" ? e : (e as { message?: string })?.message))
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0);
    if (parts.length) return parts.join("; ");
  }
  return undefined;
}

export async function fetchJson<T>(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number; throwOnError?: boolean } = {}
): Promise<T | undefined> {
  const { method = "GET", headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS, throwOnError = false } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if (!throwOnError) return undefined;
      let msg: string | undefined;
      let text = "";
      try {
        text = await res.text();
        msg = errorMessageFromBody(JSON.parse(text));
      } catch {
        // unparseable body — fall through to the bare status message
      }
      if (msg) throw new Error(`HTTP ${res.status}: ${msg}`);
      throw new Error(text ? `HTTP ${res.status}: ${text.slice(0, 200)}` : `HTTP ${res.status}`);
    }
    const text = await res.text();
    if (!text) return undefined;
    return JSON.parse(text) as T;
  } catch (e) {
    if (throwOnError) throw e; // provider errors propagate to the caller
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
