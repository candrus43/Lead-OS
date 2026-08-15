/**
 * Operion CRM push — server function (extended multi-entity pipeline).
 *
 * Pushes a prospect to the owner's CRM through the full entity flow:
 *
 *   1. GET  /api/crm/lookup?domain=&email=   — see what already exists
 *   2. POST /api/crm/companies                — upsert the company by domain
 *   3. POST /api/crm/contacts                 — upsert the contact by email,
 *                                              linked to the company
 *   4. POST /api/crm/notes                    — attach the intelligence
 *                                              (fit score, recommended buyer,
 *                                              research summary, provenance)
 *   5. POST /api/crm/leads                    — create/refresh the actual DEAL
 *                                              (deduped by email)
 *
 * All calls are authenticated with x-api-key read from the server environment
 * (OPERION_CRM_API_KEY). The key never leaves the server and never appears in
 * any error message. Every step is surfaced independently: if one fails, the
 * response says which step failed and what the CRM's safe error code was, and
 * carries any entities already created so nothing silently disappears.
 *
 * Provenance: the company/contact/notes carry {source:'lead-os', capturedAt};
 * the deal result is persisted on the prospect client-side with
 * source 'crm-api' (see prospectTable.tsx persistCrmResult).
 *
 * Compliant by construction: only real fields we know from the prospect are
 * sent (name, email, company, phone, website, fit score, research lines) —
 * never a fabricated plan or score.
 */

import { createServerFn } from "@tanstack/react-start";

/** What the extended CRM push needs from a prospect (real fields only). */
export interface CrmPushPayload {
  customerName: string;
  customerEmail: string;
  company?: string;
  website?: string;
  phone?: string;
  source: string;
  /** Operion Fit Score — real, computed on the prospect. */
  fitScore?: number;
  recommendedBuyer?: string;
  /** 1–3 lines of honest research summary, "\n"-joined. */
  researchSummary?: string;
}

export type CrmSendCode = "created" | "duplicate" | "no-email" | "no-key" | "error";

/** Which pipeline step failed (error responses only). */
export type CrmPushStep = "lookup" | "companies" | "contacts" | "notes" | "leads";

export interface CrmSendResult {
  ok: boolean;
  code: CrmSendCode;
  /** Safe, human-readable detail — never the key, never raw payload echoes. */
  message?: string;
  dealId?: string;
  created?: boolean;
  duplicate?: boolean;
  /** ISO timestamp of the CRM acknowledgment (used for provenance). */
  capturedAt?: string;
  /** The step that failed — set on error so the UI can say exactly what broke. */
  step?: CrmPushStep;
  /** Company upsert outcome (persisted as crmCompanyId). */
  company?: { companyId: string; created: boolean; updated?: boolean };
  /** Contact upsert outcome (persisted as crmContactId). */
  contact?: { contactId: string; created: boolean };
  /** True when the notes step attached the intelligence to the company. */
  notesAttached?: boolean;
}

const CRM_LEADS_URL = process.env.CRM_ENDPOINT || "https://operion-crm.ctonew.app/api/crm/leads";
/** Derive the API base: the env override historically pointed at the leads
 *  endpoint itself; fall back to the canonical base when not. */
const CRM_BASE = CRM_LEADS_URL.endsWith("/leads")
  ? CRM_LEADS_URL.slice(0, -"/leads".length)
  : CRM_LEADS_URL.replace(/\/$/, "");

/** Normalize a domain/website for matching: lowercase, no protocol, no www,
 *  no path/query/hash, no trailing dot. Mirrors webhook.ts (kept here so this
 *  client-imported server-fn module never statically imports server-only code). */
export function normalizeDomain(input: string | null | undefined): string {
  if (!input) return "";
  let d = String(input).trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip protocol
  d = d.split(/[/?#]/)[0]; // strip path/query/hash
  d = d.replace(/^www\./, ""); // strip leading www.
  d = d.replace(/\.$/, ""); // strip trailing dot
  return d.trim();
}

interface CrmErrorBody {
  ok?: boolean;
  error?: string;
}

/** Safe one-line detail from a CRM response — the key is never included, and
 *  only the CRM's own short error code is echoed (never a raw body dump). */
function crmErrorDetail(status: number, body: CrmErrorBody | null): string {
  if (status === 401) return "the CRM rejected the API key (401 Unauthorized)";
  if (body && typeof body.error === "string" && body.error) {
    return `the CRM rejected the request (${body.error})`;
  }
  return `the CRM responded with HTTP ${status}`;
}

export const sendProspectToCrm = createServerFn({ method: "POST" })
  .validator((d: CrmPushPayload) => d)
  .handler(async ({ data }): Promise<CrmSendResult> => {
    const key = process.env.OPERION_CRM_API_KEY;
    if (!key) {
      return {
        ok: false,
        code: "no-key",
        message: "CRM not connected — add OPERION_CRM_API_KEY in Secrets",
      };
    }

    const customerEmail = String(data.customerEmail ?? "").trim().toLowerCase();
    if (!customerEmail) {
      return {
        ok: false,
        code: "no-email",
        message: "The CRM dedupes by email, so a contact email is required to push this prospect.",
      };
    }
    const customerName = String(data.customerName ?? "").trim();
    const companyName = String(data.company ?? "").trim();
    if (!customerName && !companyName) {
      return {
        ok: false,
        code: "error",
        message: "No contact name or company name on this prospect — nothing honest to send.",
      };
    }

    // Domain: normalize the prospect's website when present; otherwise derive
    // from the email host (a real, known part of the contact record — the CRM
    // find-or-creates companies by domain).
    const website = String(data.website ?? "").trim() || undefined;
    const domain = normalizeDomain(website) || normalizeDomain(customerEmail.split("@")[1] ?? "");
    const capturedAt = new Date().toISOString();

    // Progress carried across steps so a mid-pipeline failure reports what
    // already landed in the CRM.
    let company: CrmSendResult["company"];
    let contact: CrmSendResult["contact"];

    const stepFail = (step: CrmPushStep, status: number, body: CrmErrorBody | null): CrmSendResult => ({
      ok: false,
      code: "error",
      step,
      message: `Could not push to Operion CRM — the ${step} step failed: ${crmErrorDetail(status, body)}. Check OPERION_CRM_API_KEY in Secrets and try again.`,
      ...(company ? { company } : {}),
      ...(contact ? { contact } : {}),
    });

    const crmPost = async (path: string, payload: unknown): Promise<{ status: number; body: CrmErrorBody & Record<string, unknown> | null }> => {
      const res = await fetch(`${CRM_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => null)) as (CrmErrorBody & Record<string, unknown>) | null;
      return { status: res.status, body };
    };

    try {
      /* ------------------- 1. LOOKUP — what already exists ------------------ */
      const lookupRes = await fetch(`${CRM_BASE}/lookup?domain=${encodeURIComponent(domain)}&email=${encodeURIComponent(customerEmail)}`, {
        headers: { "x-api-key": key },
      });
      const lookupBody = (await lookupRes.json().catch(() => null)) as CrmErrorBody | null;
      if (lookupRes.status !== 200 || !lookupBody || lookupBody.ok !== true) {
        return stepFail("lookup", lookupRes.status, lookupBody);
      }

      /* ------------------- 2. COMPANIES — upsert by domain ------------------ */
      const companyFields: Record<string, unknown> = { provenance: { source: "lead-os", capturedAt } };
      if (typeof data.fitScore === "number" && Number.isFinite(data.fitScore)) companyFields.fitScore = data.fitScore;
      if (data.recommendedBuyer) companyFields.recommendedBuyer = data.recommendedBuyer;
      const companyRes = await crmPost("/companies", {
        domain,
        name: companyName,
        ...(website ? { website } : {}),
        fields: companyFields,
      });
      if (companyRes.status !== 200 || !companyRes.body || companyRes.body.ok !== true || typeof companyRes.body.companyId !== "string") {
        return stepFail("companies", companyRes.status, companyRes.body);
      }
      company = {
        companyId: companyRes.body.companyId as string,
        created: companyRes.body.created === true,
        ...(companyRes.body.updated === true ? { updated: true } : {}),
      };

      /* -------------------- 3. CONTACTS — upsert by email ------------------- */
      const contactRes = await crmPost("/contacts", {
        email: customerEmail,
        name: customerName || companyName,
        ...(data.phone ? { phone: String(data.phone).trim() } : {}),
        companyDomain: domain,
        fields: { provenance: { source: "lead-os", capturedAt } },
      });
      if (contactRes.status !== 200 || !contactRes.body || contactRes.body.ok !== true || typeof contactRes.body.contactId !== "string") {
        return stepFail("contacts", contactRes.status, contactRes.body);
      }
      contact = {
        contactId: contactRes.body.contactId as string,
        created: contactRes.body.created === true,
      };

      /* --------------- 4. NOTES — attach the intelligence -------------------- */
      // The CRM appends a single notes string (verified: arrays are rejected
      // with "notes must be a string"), so the 1–3 research lines are sent
      // "\n"-joined. Fields merge at the top level on the company.
      const notesText =
        String(data.researchSummary ?? "").trim() ||
        [typeof data.fitScore === "number" ? `Fit ${data.fitScore}/100` : "", data.recommendedBuyer ? `Recommended buyer: ${data.recommendedBuyer}` : ""]
          .filter(Boolean)
          .join("\n") ||
        "Pushed from Operion Lead OS";
      const notesRes = await crmPost("/notes", {
        companyId: company.companyId,
        notes: notesText,
        fields: { ...companyFields, researchSummary: notesText },
      });
      if (notesRes.status !== 200 || !notesRes.body || notesRes.body.ok !== true) {
        return stepFail("notes", notesRes.status, notesRes.body);
      }

      /* ---------------- 5. LEADS — the actual deal (by email) ---------------- */
      const leadRes = await crmPost("/leads", {
        customerName: customerName || companyName,
        customerEmail,
        ...(companyName ? { company: companyName } : {}),
        ...(data.phone ? { phone: String(data.phone).trim() } : {}),
        source: "Operion Lead OS",
      });
      if (leadRes.status !== 200 || !leadRes.body || leadRes.body.ok !== true || typeof leadRes.body.dealId !== "string") {
        return stepFail("leads", leadRes.status, leadRes.body);
      }
      const created = leadRes.body.created === true;
      return {
        ok: true,
        code: created ? "created" : "duplicate",
        dealId: leadRes.body.dealId as string,
        created,
        duplicate: !created,
        capturedAt,
        company,
        contact,
        notesAttached: true,
      };
    } catch {
      return {
        ok: false,
        code: "error",
        message: "Could not reach the Operion CRM (network error). Try again.",
        ...(company ? { company } : {}),
        ...(contact ? { contact } : {}),
      };
    }
  });
