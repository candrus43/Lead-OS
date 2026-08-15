/** Small shared helpers for provider adapters. */

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/** Deterministic contact id from company + index. */
export function contactId(companyName: string, idx: number, provider: string): string {
  return `${slug(companyName)}-${provider}-c${idx}`;
}
