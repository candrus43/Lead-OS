/**
 * LLM parser adapter — server-side only. Reads OPENAI_API_KEY from env.
 * Returns null when no key is set so the client falls back to the rule-based
 * parser. Uses the OpenAI-compatible chat completions API (base URL overridable
 * via OPENAI_BASE_URL). The key never leaves the server.
 */

import { createServerFn } from "@tanstack/react-start";
import type { ParsedQuery } from "./types";

const SYSTEM_PROMPT = `You convert natural-language prospect-search queries into structured JSON filters for a B2B lead-intelligence engine (Operion). Respond with ONLY a JSON object, no markdown:
{
  "filters": {
    "industry": string | null,
    "subIndustry": string | null,
    "location": { "city": string | null, "state": string | null, "country": string | null, "radiusMiles": number | null } | null,
    "revenueMin": number | null,
    "revenueMax": number | null,
    "employeeMin": number | null,
    "employeeMax": number | null,
    "title": string | null,
    "keywords": string[] | null
  },
  "notes": string[]
}
Rules: state is a 2-letter US code. revenue in USD millions. employees are headcount. Extract only what the query states; null otherwise.`;

export interface LlmParseResult {
  configured: boolean;
  parsed?: ParsedQuery;
  error?: string;
}

export const parseWithLlmFn = createServerFn({ method: "POST" })
  .validator((d: { query: string }) => d)
  .handler(async ({ data }): Promise<LlmParseResult> => {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return { configured: false };
    const base = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: data.query },
          ],
        }),
      });
      if (!res.ok) return { configured: true, error: `upstream ${res.status}` };
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = json.choices?.[0]?.message?.content ?? "";
      const parsed = JSON.parse(content) as Omit<ParsedQuery, "parser">;
      return { configured: true, parsed: { ...parsed, parser: "llm" } as ParsedQuery };
    } catch (e) {
      return { configured: true, error: e instanceof Error ? e.message : "parse failed" };
    }
  }
);
