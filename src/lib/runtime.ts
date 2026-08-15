/**
 * Runtime config — server-side. Reports which providers are configured, whether
 * mock (dry-run) mode is on, whether the LLM adapter has a key, default cost
 * rules, and the per-provider cost map. Booleans/numbers only: secrets stay on
 * the server.
 */

import { createServerFn } from "@tanstack/react-start";
import { providerDefs } from "./providers";
import { defaultCostMap } from "./providers/costs";
import type { Capability } from "./providers/types";
import { DEFAULT_COST_RULES, DEFAULT_FIT_THRESHOLD } from "./fitScore";

export interface RuntimeConfig {
  providers: ReturnType<typeof providerDefs>;
  llm: { configured: boolean; provider: string };
  costRules: typeof DEFAULT_COST_RULES;
  defaultFitThreshold: number;
  /** server-level dry-run flag (ENABLE_PROVIDER_MOCKS) */
  mockMode: boolean;
  costMap: Record<string, Partial<Record<Capability, number>>>;
}

const envMock = () => process.env.ENABLE_PROVIDER_MOCKS === "true";

export const getRuntimeConfig = createServerFn({ method: "GET" }).handler(
  async (): Promise<RuntimeConfig> => {
    const mock = envMock();
    return {
      providers: providerDefs(process.env, mock),
      llm: {
        configured: !!(process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL),
        provider: process.env.OPENAI_BASE_URL ? "openai-compatible" : "openai",
      },
      costRules: DEFAULT_COST_RULES,
      defaultFitThreshold: DEFAULT_FIT_THRESHOLD,
      mockMode: mock,
      costMap: defaultCostMap(),
    };
  }
);
