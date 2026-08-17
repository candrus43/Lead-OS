/**
 * Agent management server functions — owner-only.
 *
 * Every handler gates through ownerGuard.allowedModule("settings") (the same
 * rule as the rest of Settings: open mode allows; when auth is configured only
 * role "owner" passes). Server-only modules (./ownerGuard, ./agents) are loaded
 * via dynamic import() INSIDE the handlers — the established pattern — so the
 * client bundle never traces node-only code. Passwords travel from the client
 * to the server once over HTTPS and are only ever stored as salted scrypt
 * hashes; hashes are never returned by any of these fns.
 */

import { createServerFn } from "@tanstack/react-start";
import type { SanitizedAgent } from "./agents";

export type { SanitizedAgent } from "./agents";

export type AgentsListResult = { allowed: true; agents: SanitizedAgent[] } | { allowed: false };

export type AgentMutationResult =
  | { allowed: true; agent: SanitizedAgent | null; error: string | null }
  | { allowed: false };

const ownerGate = async (): Promise<boolean> => {
  const { allowedModule } = await import("./ownerGuard");
  return allowedModule("settings");
};

export const listAgents = createServerFn({ method: "GET" }).handler(async (): Promise<AgentsListResult> => {
  if (!(await ownerGate())) return { allowed: false };
  const { listAgents } = await import("./agents");
  return { allowed: true, agents: listAgents() };
});

export const createAgent = createServerFn({ method: "POST" })
  .validator((d: { name: string; username: string; password: string }) => d)
  .handler(async ({ data }): Promise<AgentMutationResult> => {
    if (!(await ownerGate())) return { allowed: false };
    const { createAgent } = await import("./agents");
    const res = createAgent(data);
    return res.ok ? { allowed: true, agent: res.agent, error: null } : { allowed: true, agent: null, error: res.error };
  });

export const updateAgent = createServerFn({ method: "POST" })
  .validator((d: { id: string; name?: string; active?: boolean }) => d)
  .handler(async ({ data }): Promise<AgentMutationResult> => {
    if (!(await ownerGate())) return { allowed: false };
    const { updateAgent } = await import("./agents");
    const res = updateAgent(data.id, { name: data.name, active: data.active });
    return res.ok ? { allowed: true, agent: res.agent, error: null } : { allowed: true, agent: null, error: res.error };
  });

export const resetAgentPassword = createServerFn({ method: "POST" })
  .validator((d: { id: string; password: string }) => d)
  .handler(async ({ data }): Promise<AgentMutationResult> => {
    if (!(await ownerGate())) return { allowed: false };
    const { resetAgentPassword } = await import("./agents");
    const res = resetAgentPassword(data.id, data.password);
    return res.ok ? { allowed: true, agent: res.agent, error: null } : { allowed: true, agent: null, error: res.error };
  });

export const deleteAgent = createServerFn({ method: "POST" })
  .validator((d: { id: string }) => d)
  .handler(async ({ data }): Promise<AgentMutationResult> => {
    if (!(await ownerGate())) return { allowed: false };
    const { deleteAgent } = await import("./agents");
    const res = deleteAgent(data.id);
    return res.ok ? { allowed: true, agent: res.agent, error: null } : { allowed: true, agent: null, error: res.error };
  });
