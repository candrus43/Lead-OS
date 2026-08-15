/**
 * Server functions for AI Company Research + AI Outreach Assistant.
 *
 * The client sends the prospect (its own data — same pattern as
 * runEnrichment); the server composes a research brief and/or an outreach
 * draft from that prospect's REAL sourced fields only. When OPENAI_API_KEY is
 * configured the LLM adapter is used with a strict no-fabrication prompt; when
 * it isn't (or the call fails) the deterministic template path produces the
 * same output shape. The key never leaves the server.
 */

import { createServerFn } from "@tanstack/react-start";
import type { Prospect } from "./types";
import { isLlmConfigured, llmProvider, chatCompletion } from "./llmClient";
import {
  buildTemplateBrief,
  researchUserPrompt,
  RESEARCH_SYSTEM_PROMPT,
  withLlmProse,
  withLlmError,
  draftSystemPrompt,
  draftUserPrompt,
  templateDraft,
  withLlmDraft,
  withDraftLlmError,
  type ResearchBrief,
  type DraftType,
  type OutreachDraft,
  type BriefProse,
} from "./research";

export type { ResearchBrief, OutreachDraft, DraftType } from "./research";

export interface ResearchResult {
  brief: ResearchBrief;
}

export interface DraftResult {
  draft: OutreachDraft;
  brief: ResearchBrief; // grounding brief (facts + gaps) so the UI can show what the draft is based on
}

/** Try the LLM; return the parsed prose or null (fall back to template). */
async function llmProseFor(brief: ResearchBrief): Promise<{ prose: BriefProse; provider: string } | null> {
  if (!isLlmConfigured()) return null;
  const res = await chatCompletion(RESEARCH_SYSTEM_PROMPT, researchUserPrompt(brief), { temperature: 0, maxTokens: 1000 });
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.content) as Partial<BriefProse>;
    const prose: BriefProse = {
      overview: String(parsed.overview ?? "").trim(),
      whyFit: String(parsed.whyFit ?? "").trim(),
      painPoints: String(parsed.painPoints ?? "").trim(),
      outreachAngle: String(parsed.outreachAngle ?? "").trim(),
      contactNote: String(parsed.contactNote ?? "").trim(),
    };
    if (!prose.overview && !prose.whyFit && !prose.painPoints && !prose.outreachAngle) return null;
    return { prose, provider: res.provider };
  } catch {
    return null;
  }
}

async function llmDraftFor(brief: ResearchBrief, type: DraftType): Promise<{ subject: string; body: string; provider: string } | null> {
  if (!isLlmConfigured()) return null;
  const res = await chatCompletion(draftSystemPrompt(type), draftUserPrompt(brief, type), { temperature: 0.4, maxTokens: 700 });
  if (!res.ok) return null;
  try {
    const parsed = JSON.parse(res.content) as { subject?: string; body?: string };
    const subject = String(parsed.subject ?? "").trim();
    const body = String(parsed.body ?? "").trim();
    if (!body) return null;
    return { subject, body, provider: res.provider };
  } catch {
    return null;
  }
}

export const researchCompany = createServerFn({ method: "POST" })
  .validator((d: { prospect: Prospect }) => d)
  .handler(async ({ data }): Promise<ResearchResult> => {
    const brief = buildTemplateBrief(data.prospect);
    const ai = await llmProseFor(brief);
    if (ai) return { brief: withLlmProse(brief, ai.prose, ai.provider) };
    // No key, or the LLM failed → deterministic template brief (with an honest error note when configured but failing).
    const err = isLlmConfigured() ? `LLM unavailable — fell back to template (${llmProvider()})` : undefined;
    return { brief: err ? withLlmError(brief, err) : brief };
  });

export const generateDraft = createServerFn({ method: "POST" })
  .validator((d: { prospect: Prospect; type: DraftType }) => d)
  .handler(async ({ data }): Promise<DraftResult> => {
    const brief = buildTemplateBrief(data.prospect);
    let draft = templateDraft(data.prospect, brief, data.type);
    const ai = await llmDraftFor(brief, data.type);
    if (ai) {
      draft = withLlmDraft(draft, ai.subject, ai.body, ai.provider);
    } else if (isLlmConfigured()) {
      draft = withDraftLlmError(draft, `LLM unavailable — fell back to template (${llmProvider()})`);
    }
    return { draft, brief };
  });
