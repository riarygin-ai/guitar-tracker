// GT Lead Log import — Preview orchestration (Part 12/13/14).
//
// Reads the ENTIRE populated Leads sheet every time (no watermark filter —
// Part 12 is explicit that last_source_updated_at_seen is informational
// only) and classifies every row. Never writes to item_leads.

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchSheetValues, GoogleSheetsError } from './googleSheets';
import { buildRawRows, parseHeaders } from './normalize';
import { validateAndClassifyRow, type ExistingLeadInfo, type ValidationContext } from './validate';
import { KNOWN_CHANNEL_NAMES } from './types';
import { SOURCE_FATAL } from './errorCodes';
import type { LeadImportSource, PreviewResult, RawSheetRow, RowValidationResult, SheetCellValue, ValidationIssue } from './types';

// One classification pass over a whole sheet: `preview` is the
// browser-safe summary, `rows` the server-only detail (including each
// valid row's normalized payload) the importer applies from.
export interface DetailedClassification {
  preview: PreviewResult;
  rows: RowValidationResult[];
}

function emptyCounts() {
  return { rowsScanned: 0, valid: 0, new: 0, updates: 0, unchanged: 0, sourceOlder: 0, invalid: 0, warnings: 0 };
}

function fatalResult(fatalIssues: ValidationIssue[]): PreviewResult {
  return { fatal: true, fatalIssues, sourceWarnings: [], counts: emptyCounts(), rows: [], maxSourceUpdatedAtObserved: null };
}

// Detects a duplicate lead_id anywhere in the sheet — a source-level fatal
// ambiguity (Part 13): we deliberately never pick one row and drop the
// other. Compares raw, trimmed, lowercased text so a duplicate is caught
// even before UUID-format validation runs.
function detectDuplicateLeadIds(rawRows: ReturnType<typeof buildRawRows>): ValidationIssue[] {
  const rowsByLeadId = new Map<string, number[]>();
  for (const row of rawRows) {
    const raw = row.cells.lead_id;
    if (raw === null || raw === undefined) continue;
    const text = String(raw).trim();
    if (text === '') continue;
    const key = text.toLowerCase();
    const list = rowsByLeadId.get(key) ?? [];
    list.push(row.rowNumber);
    rowsByLeadId.set(key, list);
  }

  const issues: ValidationIssue[] = [];
  for (const [leadId, rowNumbers] of Array.from(rowsByLeadId.entries())) {
    if (rowNumbers.length > 1) {
      issues.push({
        rowNumber: null,
        leadId,
        itemId: null,
        classification: null,
        severity: 'error',
        code: SOURCE_FATAL.DUPLICATE_LEAD_ID,
        message: `lead_id "${leadId}" appears ${rowNumbers.length} times (rows ${rowNumbers.join(', ')}).`,
      });
    }
  }
  return issues;
}

async function loadChannelNameToId(serviceClient: SupabaseClient): Promise<Map<string, number>> {
  const { data, error } = await serviceClient.from('deal_channels').select('id, name');
  if (error) throw new Error(`Failed to load deal_channels: ${error.message}`);

  const knownLower = new Set(KNOWN_CHANNEL_NAMES.map((n) => n.toLowerCase()));
  const map = new Map<string, number>();
  for (const row of (data ?? []) as { id: number; name: string }[]) {
    const lower = row.name.toLowerCase();
    if (knownLower.has(lower)) map.set(lower, row.id);
  }
  return map;
}

async function loadExistingLeadsByUser(
  serviceClient: SupabaseClient,
  userId: number,
): Promise<Map<string, ExistingLeadInfo>> {
  const { data, error } = await serviceClient
    .from('item_leads')
    .select('lead_id, inventory_item_id, source_updated_at, lead_quality')
    .eq('user_id', userId);
  if (error) throw new Error(`Failed to load existing item_leads: ${error.message}`);

  const map = new Map<string, ExistingLeadInfo>();
  for (const row of (data ?? []) as { lead_id: string; inventory_item_id: number; source_updated_at: string; lead_quality: ExistingLeadInfo['leadQuality'] }[]) {
    map.set(row.lead_id.toLowerCase(), {
      inventoryItemId: row.inventory_item_id,
      sourceUpdatedAt: new Date(row.source_updated_at).toISOString(),
      leadQuality: row.lead_quality,
    });
  }
  return map;
}

async function loadItemOwnerByItemId(
  serviceClient: SupabaseClient,
  itemIds: number[],
): Promise<Map<number, number>> {
  if (itemIds.length === 0) return new Map();
  const { data, error } = await serviceClient.from('inventory_items').select('id, user_id').in('id', itemIds);
  if (error) throw new Error(`Failed to load inventory_items ownership: ${error.message}`);

  const map = new Map<number, number>();
  for (const row of (data ?? []) as { id: number; user_id: number }[]) {
    map.set(row.id, row.user_id);
  }
  return map;
}

// deals.id -> owning app_users.id, and deals.id -> its OUTGOING ('out')
// item ids, for every deal_id referenced anywhere in the sheet. A deal
// absent from the first map simply doesn't exist (DEAL_NOT_FOUND); a deal
// present with no entry in the second map has no outgoing items at all
// (DEAL_ITEM_MISMATCH, same as an empty set).
async function loadDealContextByDealId(
  serviceClient: SupabaseClient,
  dealIds: number[],
): Promise<{ dealOwnerByDealId: Map<number, number>; dealOutgoingItemIdsByDealId: Map<number, Set<number>> }> {
  if (dealIds.length === 0) return { dealOwnerByDealId: new Map(), dealOutgoingItemIdsByDealId: new Map() };

  const [dealsRes, outgoingRes] = await Promise.all([
    serviceClient.from('deals').select('id, user_id').in('id', dealIds),
    serviceClient.from('deal_items').select('deal_id, item_id').eq('direction', 'out').in('deal_id', dealIds),
  ]);
  if (dealsRes.error) throw new Error(`Failed to load deals ownership: ${dealsRes.error.message}`);
  if (outgoingRes.error) throw new Error(`Failed to load deal_items (outgoing): ${outgoingRes.error.message}`);

  const dealOwnerByDealId = new Map<number, number>();
  for (const row of (dealsRes.data ?? []) as { id: number; user_id: number }[]) {
    dealOwnerByDealId.set(row.id, row.user_id);
  }

  const dealOutgoingItemIdsByDealId = new Map<number, Set<number>>();
  for (const row of (outgoingRes.data ?? []) as { deal_id: number; item_id: number }[]) {
    const set = dealOutgoingItemIdsByDealId.get(row.deal_id) ?? new Set<number>();
    set.add(row.item_id);
    dealOutgoingItemIdsByDealId.set(row.deal_id, set);
  }

  return { dealOwnerByDealId, dealOutgoingItemIdsByDealId };
}

export interface RunPreviewParams {
  serviceClient: SupabaseClient;
  source: LeadImportSource;
}

// Reads one source's whole sheet, mapping a GoogleSheetsError into the same
// source-level fatal issue Preview reports rather than throwing. Shared by
// Preview and Import so both hit the source exactly the same way — Import
// re-reads through this too, never trusting a Preview result the browser
// sends back (see src/lib/leadImport/importRun.ts).
export type SourceReadResult =
  | { ok: true; values: SheetCellValue[][] }
  | { ok: false; fatalIssue: ValidationIssue };

export async function readSourceSheet(source: LeadImportSource): Promise<SourceReadResult> {
  try {
    return { ok: true, values: await fetchSheetValues(source.spreadsheet_id, source.sheet_name) };
  } catch (err) {
    if (err instanceof GoogleSheetsError) {
      return {
        ok: false,
        fatalIssue: {
          rowNumber: null, leadId: null, itemId: null, classification: null,
          severity: 'error', code: err.code, message: err.message,
        },
      };
    }
    throw err;
  }
}

export async function runLeadImportPreview({ serviceClient, source }: RunPreviewParams): Promise<PreviewResult> {
  const read = await readSourceSheet(source);
  if (!read.ok) return fatalResult([read.fatalIssue]);
  return classifySheetValues(read.values, source, serviceClient);
}

// Preview's browser-facing view of a classification pass: identical to
// classifySheetValuesDetailed() with every row's server-only `normalized`
// payload (which carries sheet `notes`) stripped off.
//
// Split out from runLeadImportPreview so tests can drive it with an
// in-memory `values` array (no real Google Sheets call — see
// scripts/test-lead-import.ts) while production always goes through
// runLeadImportPreview's readSourceSheet() call above.
export async function classifySheetValues(
  values: SheetCellValue[][],
  source: LeadImportSource,
  serviceClient: SupabaseClient,
): Promise<PreviewResult> {
  const { preview } = await classifySheetValuesDetailed(values, source, serviceClient);
  return preview;
}

// The single classification core. Import calls this directly for the
// normalized payloads; Preview calls it through classifySheetValues()
// above. There is deliberately no second parsing/validation path.
export async function classifySheetValuesDetailed(
  values: SheetCellValue[][],
  source: LeadImportSource,
  serviceClient: SupabaseClient,
): Promise<DetailedClassification> {
  const headerRow = values[0] ?? [];
  const { headerIndex, fatalIssues: headerFatalIssues, warnings: headerWarnings } = parseHeaders(headerRow);
  if (headerFatalIssues.length > 0) return { preview: fatalResult(headerFatalIssues), rows: [] };

  const rawRows = buildRawRows(values.slice(1), headerIndex);

  const dupIssues = detectDuplicateLeadIds(rawRows);
  if (dupIssues.length > 0) return { preview: fatalResult(dupIssues), rows: [] };

  const collectCandidateIds = (cell: (r: RawSheetRow) => SheetCellValue) => Array.from(new Set(
    rawRows
      .map(cell)
      .map((v) => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN))
      .filter((n) => Number.isInteger(n) && n > 0),
  ));
  const itemIds = collectCandidateIds((r) => r.cells.item_id);
  const dealIds = collectCandidateIds((r) => r.cells.deal_id);

  const [channelNameToId, existingLeadsByLeadId, itemOwnerByItemId, dealContext] = await Promise.all([
    loadChannelNameToId(serviceClient),
    loadExistingLeadsByUser(serviceClient, source.user_id),
    loadItemOwnerByItemId(serviceClient, itemIds),
    loadDealContextByDealId(serviceClient, dealIds),
  ]);

  const ctx: ValidationContext = {
    sourceUserId: source.user_id,
    channelNameToId,
    existingLeadsByLeadId,
    itemOwnerByItemId,
    dealOwnerByDealId: dealContext.dealOwnerByDealId,
    dealOutgoingItemIdsByDealId: dealContext.dealOutgoingItemIdsByDealId,
  };

  const rows: RowValidationResult[] = rawRows.map((raw) => validateAndClassifyRow(raw, ctx));

  const counts = emptyCounts();
  counts.rowsScanned = rows.length;
  let maxSourceUpdatedAtObserved: string | null = null;

  for (const row of rows) {
    switch (row.classification) {
      case 'NEW': counts.new++; counts.valid++; break;
      case 'UPDATE': counts.updates++; counts.valid++; break;
      case 'UNCHANGED': counts.unchanged++; counts.valid++; break;
      case 'SOURCE_OLDER': counts.sourceOlder++; counts.valid++; break;
      case 'INVALID': counts.invalid++; break;
    }
    counts.warnings += row.issues.filter((i) => i.severity === 'warning').length;

    // MAX over every row whose updated_at itself parsed — a row that is
    // INVALID for some *other* reason still contributes an observed source
    // timestamp. Read from the validation pass's own normalized value
    // rather than re-derived from the raw cell, so a Sheets date serial is
    // interpreted by the same rule cellToUtcTimestampOrNull() applied.
    if (row.parsedSourceUpdatedAt !== null) {
      if (!maxSourceUpdatedAtObserved || row.parsedSourceUpdatedAt > maxSourceUpdatedAtObserved) {
        maxSourceUpdatedAtObserved = row.parsedSourceUpdatedAt;
      }
    }
  }
  counts.warnings += headerWarnings.length;

  const preview: PreviewResult = {
    fatal: false,
    fatalIssues: [],
    sourceWarnings: headerWarnings,
    counts,
    // Strip the server-only fields — this object is what the Preview API
    // returns to the browser.
    rows: rows.map(({ rowNumber, leadId, itemId, classification, issues }) => ({
      rowNumber, leadId, itemId, classification, issues,
    })),
    maxSourceUpdatedAtObserved,
  };

  return { preview, rows };
}
