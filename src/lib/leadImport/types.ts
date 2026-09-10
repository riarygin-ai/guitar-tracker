// GT Lead Log import — Phase 1 shared types.
//
// Mirrors supabase/migrations/20260908000000_lead_import_sources.sql and
// 20260908000001_item_leads.sql exactly. Preview-only in this phase — none
// of this drives a write path yet (see src/lib/leadImport/preview.ts).

export type LeadQuality = 'LOW' | 'ENGAGED' | 'SERIOUS' | 'HIGH_INTENT';
export type OfferType = 'NONE' | 'CASH' | 'TRADE' | 'MIXED';
export type LeadStatus =
  | 'OPEN'
  | 'GHOSTED'
  | 'DECLINED_BY_ME'
  | 'DECLINED_BY_THEM'
  | 'AGREED'
  | 'FAILED_AFTER_AGREEMENT'
  | 'COMPLETED';
export type OutcomeReason =
  | 'LOW_OFFER'
  | 'TRADE_NOT_INTERESTING'
  | 'PRICE'
  | 'CONDITION'
  | 'LOGISTICS'
  | 'NO_SHOW'
  | 'CHANGED_MIND'
  | 'FOUND_ANOTHER'
  | 'UNKNOWN';

export const LEAD_QUALITY_VALUES: readonly LeadQuality[] = ['LOW', 'ENGAGED', 'SERIOUS', 'HIGH_INTENT'];
export const OFFER_TYPE_VALUES: readonly OfferType[] = ['NONE', 'CASH', 'TRADE', 'MIXED'];
export const LEAD_STATUS_VALUES: readonly LeadStatus[] = [
  'OPEN', 'GHOSTED', 'DECLINED_BY_ME', 'DECLINED_BY_THEM', 'AGREED', 'FAILED_AFTER_AGREEMENT', 'COMPLETED',
];
export const OUTCOME_REASON_VALUES: readonly OutcomeReason[] = [
  'LOW_OFFER', 'TRADE_NOT_INTERESTING', 'PRICE', 'CONDITION', 'LOGISTICS', 'NO_SHOW', 'CHANGED_MIND', 'FOUND_ANOTHER', 'UNKNOWN',
];

// Highest intent level ever reached — must never decrease. Index = rank.
export const LEAD_QUALITY_RANK: Record<LeadQuality, number> = {
  LOW: 1, ENGAGED: 2, SERIOUS: 3, HIGH_INTENT: 4,
};

// Recognized raw `channel` sheet values that normalize to an existing
// deal_channels row of the same name (case-insensitive). 'Other' and blank
// are valid but intentionally excluded — they normalize to deal_channel_id
// NULL while preserving source_channel; anything else is INVALID_CHANNEL.
export const KNOWN_CHANNEL_NAMES = ['Marketplace', 'Kijiji', 'Reverb'] as const;

export interface LeadImportSource {
  id: number;
  user_id: number;
  source_code: 'GT_LEAD_LOG';
  source_name: string;
  provider: 'GOOGLE_SHEETS';
  spreadsheet_id: string;
  sheet_name: string;
  is_enabled: boolean;
  last_successful_import_at: string | null;
  last_source_updated_at_seen: string | null;
  created_at: string;
  updated_at: string;
}

export type NewLeadImportSource = Pick<
  LeadImportSource,
  'user_id' | 'source_name' | 'spreadsheet_id' | 'sheet_name' | 'is_enabled'
>;

// The exact column contract from the sheet's header row (Part 10). Order
// may change — always read by header name.
export const EXPECTED_HEADERS = [
  'item_id',
  'first_contact_at',
  'last_contact_at',
  'channel',
  'buyer_message_count',
  'our_message_count',
  'lead_quality',
  'offer_type',
  'initial_cash_offer',
  'best_cash_offer',
  'trade_item',
  'cash_component',
  'trade_est_value',
  'status',
  'outcome_reason',
  'notes',
  'lead_id',
  'updated_at',
] as const;

export type ExpectedHeader = (typeof EXPECTED_HEADERS)[number];

export type SheetCellValue = string | number | boolean | null;

// One raw sheet row, keyed by expected header name, plus its 1-based sheet
// row number (header row is row 1, so the first data row is row 2).
export interface RawSheetRow {
  rowNumber: number;
  cells: Record<ExpectedHeader, SheetCellValue>;
}

export type IssueSeverity = 'error' | 'warning';

export type RowClassification = 'NEW' | 'UPDATE' | 'UNCHANGED' | 'SOURCE_OLDER' | 'INVALID';

export interface ValidationIssue {
  rowNumber: number | null; // null for a source-level (whole-sheet) issue
  leadId: string | null;
  itemId: number | null;
  classification: RowClassification | null;
  severity: IssueSeverity;
  code: string;
  message: string;
}

export interface RowPreviewResult {
  rowNumber: number;
  leadId: string | null;
  itemId: number | null;
  classification: RowClassification;
  issues: ValidationIssue[];
}

export interface PreviewCounts {
  rowsScanned: number;
  valid: number;
  new: number;
  updates: number;
  unchanged: number;
  sourceOlder: number;
  invalid: number;
  warnings: number;
}

export interface PreviewResult {
  fatal: boolean;
  fatalIssues: ValidationIssue[];
  // Non-fatal, source-level (whole-sheet) warnings — e.g. extra columns.
  // Always empty when `fatal` is true.
  sourceWarnings: ValidationIssue[];
  counts: PreviewCounts;
  rows: RowPreviewResult[];
  maxSourceUpdatedAtObserved: string | null;
}

// ── Phase 2: normalized lead payload ───────────────────────────────────────
// The fully parsed, validated form of one sheet row, produced by the SAME
// validateAndClassifyRow() pass that Preview uses (never a second parsing
// path) and only ever non-null when that row has no error-severity issues.
// Field names are camelCase here and mapped to their item_leads column
// names once, in src/lib/leadImport/importRun.ts, on the way into
// apply_lead_import_batch().
export interface NormalizedLeadRow {
  sheetRowNumber: number;
  leadId: string;
  inventoryItemId: number;
  firstContactAt: string | null;
  lastContactAt: string | null;
  sourceChannel: string | null;
  dealChannelId: number | null;
  buyerMessageCount: number | null;
  ourMessageCount: number | null;
  leadQuality: LeadQuality;
  offerType: OfferType;
  initialCashOffer: number | null;
  bestCashOffer: number | null;
  tradeItem: string | null;
  cashComponent: number | null;
  tradeEstValue: number | null;
  status: LeadStatus;
  outcomeReason: OutcomeReason | null;
  notes: string | null;
  sourceUpdatedAt: string;
}

// Preview's browser-facing RowPreviewResult plus the server-only extras the
// importer needs. `normalized` carries sheet `notes` content, so this type
// must never be returned from an API route — Preview strips it down to
// RowPreviewResult before responding.
export interface RowValidationResult extends RowPreviewResult {
  normalized: NormalizedLeadRow | null;
  // The row's updated_at whenever it parsed, even if the row is INVALID for
  // some other reason — this is what feeds
  // lead_import_sources.last_source_updated_at_seen.
  parsedSourceUpdatedAt: string | null;
}

// ── Phase 2: import runs ───────────────────────────────────────────────────

export type ImportRunStatus = 'RUNNING' | 'COMPLETED' | 'COMPLETED_WITH_ERRORS' | 'FAILED';

export const IMPORT_RUN_STATUS_VALUES: readonly ImportRunStatus[] = [
  'RUNNING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED',
];

export type ImportRowResult =
  | 'INSERTED'
  | 'UPDATED'
  | 'SKIPPED_UNCHANGED'
  | 'SKIPPED_SOURCE_OLDER'
  | 'SKIPPED_INVALID'
  | 'SKIPPED_NOT_APPLIED'
  | 'FAILED';

// Mirrors public.lead_import_runs.
export interface LeadImportRun {
  id: number;
  source_id: number;
  user_id: number;
  requested_by_user_id: number;
  status: ImportRunStatus;
  started_at: string;
  completed_at: string | null;
  source_row_count: number;
  new_count: number;
  update_count: number;
  unchanged_count: number;
  source_older_count: number;
  invalid_count: number;
  inserted_count: number;
  updated_count: number;
  failed_count: number;
  source_max_updated_at: string | null;
  error_summary: string | null;
  created_at: string;
}

// Mirrors public.lead_import_run_rows. Deliberately carries no lead payload
// and no `notes`.
export interface LeadImportRunRow {
  id: number;
  import_run_id: number;
  sheet_row_number: number;
  lead_id: string | null;
  inventory_item_id: number | null;
  source_updated_at: string | null;
  classification: RowClassification;
  result: ImportRowResult;
  issue_codes: string[];
  issue_message: string | null;
  created_at: string;
}

// A run row decorated for the history UI (the source/user labels the admin
// page shows next to each run).
export interface LeadImportRunSummary extends LeadImportRun {
  source_name: string;
  user_display_name: string | null;
}

// What POST /api/admin/lead-import/import returns on a run that actually
// started (a refused start — conflict, disabled source — is an HTTP error
// instead).
export interface ImportRunOutcome {
  runId: number;
  status: ImportRunStatus;
  counts: {
    sourceRowCount: number;
    new: number;
    updates: number;
    unchanged: number;
    sourceOlder: number;
    invalid: number;
    inserted: number;
    updated: number;
    failed: number;
  };
  sourceMaxUpdatedAt: string | null;
  errorSummary: string | null;
  // Populated only when the sheet itself could not be read/parsed at all
  // (the same fatal issues Preview reports).
  fatalIssues: ValidationIssue[];
}
