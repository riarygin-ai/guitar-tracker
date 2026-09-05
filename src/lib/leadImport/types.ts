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
