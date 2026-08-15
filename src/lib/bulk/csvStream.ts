/**
 * Streaming CSV row parser for bulk runs — never materializes the whole file.
 *
 * Same semantics as src/lib/csv.ts (quoted fields, commas in quotes, CRLF,
 * header normalization) but as a generator: rows are produced one at a time so
 * the server can convert → score → persist batch by batch without ever holding
 * every row in memory at once.
 */

export function* iterCsvRows(text: string): Generator<Record<string, string>> {
  const s = text.replace(/^\uFEFF/, "");
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let header: string[] | null = null;

  /** Returns the parsed record for the current row, or null for header/blank. */
  const finishRow = (): Record<string, string> | null => {
    const thisRow = row;
    row = [];
    cell = "";
    if (!thisRow.some((c) => c.trim() !== "")) return null;
    if (!header) {
      header = thisRow.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
      return null;
    }
    const out: Record<string, string> = {};
    header.forEach((h, i) => {
      if (h) out[h] = (thisRow[i] ?? "").trim();
    });
    return out;
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      const rec = finishRow();
      if (rec) yield rec;
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  const rec = finishRow();
  if (rec) yield rec;
}

/** Count data rows (excluding header + blank lines) without building objects. */
export function countCsvRows(text: string): number {
  let n = 0;
  for (const _row of iterCsvRows(text)) n++;
  return n;
}
