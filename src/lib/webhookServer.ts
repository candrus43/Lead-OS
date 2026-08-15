/**
 * Deal-closed webhook — server functions for the UI.
 *
 * - getWebhookConfig: owner-only integration details for the Settings page
 *   (URL, header format, payload example, and the plaintext API key — this is
 *   the owner's own config surface).
 * - getClosedDeals: the persisted closed-deals collection + summary, consumed
 *   by the dashboard's outcome-based insights card (no secrets).
 * - getSecretsStatus: booleans ONLY — whether server fns see the CRM env key
 *   and whether the webhook key override is set. Values are never exposed.
 *
 * Server-only modules (./webhook with fs/crypto, ./authServer with auth) are
 * loaded via dynamic import INSIDE the handlers — the same pattern parser.ts
 * uses for its optional LLM adapter — so the client bundle never traces them.
 */

import { createServerFn } from "@tanstack/react-start";

export type WebhookConfigResult =
  | {
      allowed: true;
      method: "POST";
      url: string;
      headerFormat: string;
      payloadExample: import("./webhook").DealClosedPayloadExample;
      keySource: "generated" | "env";
      apiKey: string;
    }
  | { allowed: false };

export const getWebhookConfig = createServerFn({ method: "GET" }).handler(async (): Promise<WebhookConfigResult> => {
  const [{ allowedModule }, { getWebhookConfigInfo, getApiKey }] = await Promise.all([
    import("./ownerGuard"),
    import("./webhook"),
  ]);
  if (!allowedModule("settings")) return { allowed: false };
  const info = getWebhookConfigInfo();
  return { allowed: true, ...info, apiKey: getApiKey() };
});

export const getClosedDeals = createServerFn({ method: "GET" }).handler(async () => {
  const { listClosedDeals, closedDealsSummary } = await import("./webhook");
  return { records: listClosedDeals(), summary: closedDealsSummary() };
});

export const getSecretsStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ crmApiKeyPresent: boolean; leadosKeyOverride: boolean }> => ({
    crmApiKeyPresent: !!process.env.OPERION_CRM_API_KEY,
    leadosKeyOverride: !!process.env.OPERION_LEADOS_API_KEY,
  })
);
