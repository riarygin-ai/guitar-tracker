// GT Lead Log import — sheet normalization (Part 10/13).
//
// Turns the raw 2D `values` array from fetchSheetValues() into typed
// RawSheetRow objects keyed by expected header name (never fixed column
// position), plus source-level fatal/warning detection (missing/duplicate
// headers, extra columns). Cell-level coercion (numbers, dates, blanks ->
// null) lives here too, shared by every row before per-field validation in
// validate.ts runs.

import { EXPECTED_HEADERS, type ExpectedHeader, type RawSheetRow, type SheetCellValue, type ValidationIssue } from './types';
import { SOURCE_FATAL, SOURCE_WARNING } from './errorCodes';

const EXPECTED_HEADER_SET = new Set<string>(EXPECTED_HEADERS);

function fatalIssue(code: string, message: string): ValidationIssue {
  return { rowNumber: null, leadId: null, itemId: null, classification: null, severity: 'error', code, message };
}

function warningIssue(code: string, message: string): ValidationIssue {
  return { rowNumber: null, leadId: null, itemId: null, classification: null, severity: 'warning', code, message };
}

export interface HeaderParseResult {
  // Maps expected header -> its column index in the sheet. Only present
  // when parsing succeeded with no fatal issues.
  headerIndex: Partial<Record<ExpectedHeader, number>>;
  fatalIssues: ValidationIssue[];
  warnings: ValidationIssue[];
}

export function parseHeaders(headerRow: SheetCellValue[]): HeaderParseResult {
  const fatalIssues: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const rawNames = headerRow.map((cell) => (typeof cell === 'string' ? cell.trim() : cell == null ? '' : String(cell)));

  // Duplicate expected headers (e.g. two "lead_id" columns) — fatal, since
  // there would be no deterministic column to read from.
  const seenCounts = new Map<string, number>();
  for (const name of rawNames) {
    if (!name) continue;
    seenCounts.set(name, (seenCounts.get(name) ?? 0) + 1);
  }
  const duplicated = Array.from(seenCounts.entries()).filter(([name, count]) => count > 1 && EXPECTED_HEADER_SET.has(name));
  if (duplicated.length > 0) {
    fatalIssues.push(
      fatalIssue(
        SOURCE_FATAL.DUPLICATE_HEADERS,
        `Duplicate header column(s): ${duplicated.map(([name]) => name).join(', ')}.`,
      ),
    );
  }

  const headerIndex: Partial<Record<ExpectedHeader, number>> = {};
  for (let i = 0; i < rawNames.length; i++) {
    const name = rawNames[i];
    if (EXPECTED_HEADER_SET.has(name) && !(name in headerIndex)) {
      headerIndex[name as ExpectedHeader] = i;
    }
  }

  const missing = EXPECTED_HEADERS.filter((h) => !(h in headerIndex));
  if (missing.length > 0) {
    fatalIssues.push(fatalIssue(SOURCE_FATAL.MISSING_HEADERS, `Missing expected column(s): ${missing.join(', ')}.`));
  }

  const extra = rawNames.filter((name) => name && !EXPECTED_HEADER_SET.has(name));
  if (extra.length > 0) {
    warnings.push(warningIssue(SOURCE_WARNING.EXTRA_COLUMNS, `Extra column(s) ignored: ${Array.from(new Set(extra)).join(', ')}.`));
  }

  return { headerIndex, fatalIssues, warnings };
}

function isRowBlank(row: SheetCellValue[]): boolean {
  return row.every((cell) => cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === ''));
}

// Builds one RawSheetRow per non-blank data row. `dataRows` is `values`
// with the header row already removed; `rowNumber` is the 1-based sheet
// row number (header = row 1, so the first data row is row 2).
export function buildRawRows(
  dataRows: SheetCellValue[][],
  headerIndex: Partial<Record<ExpectedHeader, number>>,
): RawSheetRow[] {
  const rows: RawSheetRow[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    if (isRowBlank(row)) continue; // ignore completely blank trailing rows

    const cells = {} as Record<ExpectedHeader, SheetCellValue>;
    for (const header of EXPECTED_HEADERS) {
      const colIndex = headerIndex[header];
      cells[header] = colIndex === undefined ? null : (row[colIndex] ?? null);
    }
    rows.push({ rowNumber: i + 2, cells });
  }
  return rows;
}

// ── Cell coercion helpers ────────────────────────────────────────────────
// Blank source values become NULL, never empty strings, for every nullable
// structured field (Part 8).

export function cellToTrimmedStringOrNull(value: SheetCellValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  // A number/boolean typed into a text-ish column is still a value.
  return String(value);
}

export type NumberParseResult = { ok: true; value: number | null } | { ok: false };

// Blank -> {ok:true, value:null}. A genuinely unparsable non-blank value ->
// {ok:false} (caller raises the field-specific invalid code). Strips
// currency formatting ($, commas, spaces) from string cells as a defensive
// fallback — Sheets API UNFORMATTED_VALUE already returns numeric cells as
// JS numbers, so this only matters for a cell typed as literal text.
export function cellToNumberOrNull(value: SheetCellValue): NumberParseResult {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return { ok: true, value: null };
    const cleaned = trimmed.replace(/[$,\s]/g, '');
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false };
  }
  return { ok: false };
}

export type IntegerParseResult = { ok: true; value: number | null } | { ok: false };

export function cellToIntegerOrNull(value: SheetCellValue): IntegerParseResult {
  const parsed = cellToNumberOrNull(value);
  if (!parsed.ok) return { ok: false };
  if (parsed.value === null) return { ok: true, value: null };
  return Number.isInteger(parsed.value) ? { ok: true, value: parsed.value } : { ok: false };
}

const SHEETS_EPOCH_UTC_MS = Date.UTC(1899, 11, 30); // Google Sheets/Excel day-serial epoch
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function serialToUtcDate(serial: number): Date {
  return new Date(SHEETS_EPOCH_UTC_MS + serial * MS_PER_DAY);
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type DateParseResult = { ok: true; value: string | null } | { ok: false };

// Accepts a plain "YYYY-MM-DD" string cell, or a numeric Sheets date serial
// (an actual Sheets date-typed cell) — both normalize to the same
// "YYYY-MM-DD" string. Anything else is invalid.
export function cellToDateStringOrNull(value: SheetCellValue): DateParseResult {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { ok: false };
    const d = serialToUtcDate(Math.floor(value));
    if (Number.isNaN(d.getTime())) return { ok: false };
    return { ok: true, value: d.toISOString().slice(0, 10) };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return { ok: true, value: null };
    if (!DATE_ONLY_RE.test(trimmed)) return { ok: false };
    const d = new Date(`${trimmed}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return { ok: false };
    return { ok: true, value: trimmed };
  }
  return { ok: false };
}

export type TimestampParseResult = { ok: true; value: string | null } | { ok: false };

// Accepts an ISO-8601 UTC string (must carry an explicit 'Z' or '+00:00'
// offset — Part 9 requires the source updated_at to be an unambiguous UTC
// instant) or a numeric Sheets datetime serial (unambiguous by
// construction — Sheets stores an absolute instant once rendered as a
// serial). Returns a normalized ISO string (`Date#toISOString()`).
export function cellToUtcTimestampOrNull(value: SheetCellValue): TimestampParseResult {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { ok: false };
    const d = serialToUtcDate(value);
    if (Number.isNaN(d.getTime())) return { ok: false };
    return { ok: true, value: d.toISOString() };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return { ok: true, value: null };
    const hasExplicitUtcOffset = /Z$|[+-]00:?00$/.test(trimmed);
    if (!hasExplicitUtcOffset) return { ok: false };
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) return { ok: false };
    return { ok: true, value: d.toISOString() };
  }
  return { ok: false };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}
