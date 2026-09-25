export const CSV_MAX_ROWS = 1000;
export const CSV_MAX_COLS = 200;

export interface CsvTable {
  rows: string[][];
  delimiter: string;
  /** Every record found (not only the ones kept). */
  totalRows: number;
  /** The widest record. */
  totalCols: number;
  truncatedRows: boolean;
  truncatedCols: boolean;
}

const CANDIDATES = [",", ";", "\t", "|"];

/** The delimiter that splits the first lines into the same, largest number of fields (quotes respected). */
export function detectDelimiter(text: string): string {
  const head = text.slice(0, 20_000);
  let best = ",";
  let bestScore = 0;
  for (const candidate of CANDIDATES) {
    const counts: number[] = [];
    let inQuotes = false;
    let count = 0;
    for (const char of head) {
      if (char === '"') inQuotes = !inQuotes;
      else if (!inQuotes && char === candidate) count += 1;
      else if (!inQuotes && char === "\n") {
        counts.push(count);
        count = 0;
        if (counts.length >= 10) break;
      }
    }
    const lines = counts.filter((n) => n > 0);
    if (lines.length === 0) continue;
    const consistent = lines.filter((n) => n === lines[0]).length;
    const score = consistent * 1000 + (lines[0] ?? 0);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Parses CSV text (RFC 4180 quoting, CRLF/LF/CR, a leading BOM ignored) in one pass. Only the first `maxRows` records
 * and `maxCols` fields are kept; the rest is only counted, so a huge file never builds a huge table.
 */
export function parseCsv(
  input: string,
  options: { maxRows?: number; maxCols?: number; delimiter?: string } = {},
): CsvTable {
  const maxRows = options.maxRows ?? CSV_MAX_ROWS;
  const maxCols = options.maxCols ?? CSV_MAX_COLS;
  const text = input.startsWith("﻿") ? input.slice(1) : input;
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false;
  let totalRows = 0;
  let totalCols = 0;

  const endField = () => {
    record.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    totalRows += 1;
    totalCols = Math.max(totalCols, record.length);
    if (rows.length < maxRows)
      rows.push(record.length > maxCols ? record.slice(0, maxCols) : record);
    record = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (inQuotes) {
      if (char === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text.charAt(i + 1) === "\n") i += 1;
      endRecord();
    } else {
      field += char;
      fieldStarted = true;
    }
  }
  if (fieldStarted || field !== "" || record.length > 0) endRecord();

  const width = Math.min(totalCols, maxCols);
  for (const row of rows) while (row.length < width) row.push("");
  return {
    rows,
    delimiter,
    totalRows,
    totalCols,
    truncatedRows: totalRows > maxRows,
    truncatedCols: totalCols > maxCols,
  };
}
