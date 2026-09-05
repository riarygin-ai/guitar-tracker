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
import { ROW_ISSUE, SOURCE_FATAL } from './errorCodes';
import type { LeadImportSource, PreviewResult, RowPreviewResult, SheetCellValue, ValidationIssue } from './types';

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

export interface RunPreviewParams {
  serviceClient: SupabaseClient;
  source: LeadImportSource;
}

export async function runLeadImportPreview({ serviceClient, source }: RunPreviewParams): Promise<PreviewResult> {
  let values: SheetCellValue[][];
  try {
    values = await fetchSheetValues(source.spreadsheet_id, source.sheet_name);
  } catch (err) {
    if (err instanceof GoogleSheetsError) {
      return fatalResult([
        { rowNumber: null, leadId: null, itemId: null, classification: null, severity: 'error', code: err.code, message: err.message },
      ]);
    }
    throw err;
  }

  return classifySheetValues(values, source, serviceClient);
}

// The classification core, split out from runLeadImportPreview so tests can
// drive it with an in-memory `values` array (no real Google Sheets call —
// see scripts/test-lead-import.ts) while production always goes through
// runLeadImportPreview's fetchSheetValues() call above.
export async function classifySheetValues(
  values: SheetCellValue[][],
  source: LeadImportSource,
  serviceClient: SupabaseClient,
): Promise<PreviewResult> {
  const headerRow = values[0] ?? [];
  const { headerIndex, fatalIssues: headerFatalIssues, warnings: headerWarnings } = parseHeaders(headerRow);
  if (headerFatalIssues.length > 0) return fatalResult(headerFatalIssues);

  const rawRows = buildRawRows(values.slice(1), headerIndex);

  const dupIssues = detectDuplicateLeadIds(rawRows);
  if (dupIssues.length > 0) return fatalResult(dupIssues);

  const itemIds = Array.from(new Set(
    rawRows
      .map((r) => r.cells.item_id)
      .map((v) => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN))
      .filter((n) => Number.isInteger(n) && n > 0),
  ));

  const [channelNameToId, existingLeadsByLeadId, itemOwnerByItemId] = await Promise.all([
    loadChannelNameToId(serviceClient),
    loadExistingLeadsByUser(serviceClient, source.user_id),
    loadItemOwnerByItemId(serviceClient, itemIds),
  ]);

  const ctx: ValidationContext = {
    sourceUserId: source.user_id,
    channelNameToId,
    existingLeadsByLeadId,
    itemOwnerByItemId,
  };

  const rows: RowPreviewResult[] = rawRows.map((raw) => validateAndClassifyRow(raw, ctx));

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

    const rowUpdatedAtIssue = row.issues.find((i) => i.code === ROW_ISSUE.INVALID_UPDATED_AT || i.code === ROW_ISSUE.MISSING_UPDATED_AT);
    if (!rowUpdatedAtIssue) {
      const cellsRow = rawRows.find((r) => r.rowNumber === row.rowNumber);
      const updatedAtCell = cellsRow?.cells.updated_at;
      if (typeof updatedAtCell === 'string' || typeof updatedAtCell === 'number') {
        const iso = new Date(updatedAtCell).toISOString();
        if (!maxSourceUpdatedAtObserved || iso > maxSourceUpdatedAtObserved) maxSourceUpdatedAtObserved = iso;
      }
    }
  }
  counts.warnings += headerWarnings.length;

  return {
    fatal: false,
    fatalIssues: [],
    sourceWarnings: headerWarnings,
    counts,
    rows,
    maxSourceUpdatedAtObserved,
  };
}
