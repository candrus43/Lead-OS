/**
 * LLM client — server-side only, plain module (NO createServerFn so it can be
 * imported from researchServer.ts and tested standalone under bun).
 *
 * Reads OPENAI_API_KEY from env; the key never leaves the server. Returns a
 * no-op result when no key is configured so callers can fall back to
 * deterministic template output. OpenAI-compatible endpoints are supported via
 * OPENAI_BASE_URL / OPENAI_MODEL.
 */

export interface LlmOk {
  ok: true;
  content: string; // raw assistant message content
  provider: string;
  model: string;
}

export interface LlmFail {
  ok: false;
  error: string; // human-readable, no secrets
  provider: string;
}

export type LlmResult = LlmOk | LlmFail;

export function isLlmConfigured(): boolean {
  return !!(process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL);
}

export function llmProvider(): string {
  return process.env.OPENAI_BASE_URL ? "openai-compatible" : "openai";
}

export function llmModel(): string {
  return process.env.OPENAI_MODEL || "gpt-4o-mini";
}

/**
 * One chat completion round-trip. Returns the assistant's content verbatim.
 * temperature defaults to 0 for deterministic grounded output.
 */
export async function chatCompletion(
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number } = {}
): Promise<LlmResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { ok: false, error: "no OPENAI_API_KEY configured", provider: llmProvider() };
  const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: llmModel(),
        temperature: opts.temperature ?? 0,
        max_tokens: opts.maxTokens ?? 900,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) return { ok: false, error: `upstream ${res.status}`, provider: llmProvider() };
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) return { ok: false, error: "empty response", provider: llmProvider() };
    return { ok: true, content, provider: llmProvider(), model: llmModel() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "LLM request failed", provider: llmProvider() };
  }
}
