// GT Lead Log import — Phase 2 import orchestration.
//
// ── WHAT AN IMPORT ACTUALLY DOES ──────────────────────────────────────────
// The browser sends nothing but a source id. Everything else is re-derived
// here, server-side, on every single run:
//
//   1. claim the source's single RUNNING slot (start_lead_import_run)
//   2. re-read the ENTIRE Google Sheet (no watermark, no delta filter)
//   3. re-normalize and re-validate every row
//   4. re-load the DB's current leads / items / channels
//   5. re-classify NEW / UPDATE / UNCHANGED / SOURCE_OLDER / INVALID
//   6. apply only the valid NEW/UPDATE rows, in ONE database transaction
//
// A Preview result is never imported. The sheet may have changed between
// Preview and Import, so the classification Import applies is always its
// own, produced by the same classifySheetValuesDetailed() pass Preview
// uses — there is deliberately no second set of lead parsing rules.
//
// ── WHAT IS NEVER TAKEN FROM THE CLIENT ───────────────────────────────────
// user_id, source ownership, inventory ownership, the normalized deal
// channel and every source timestamp come from lead_import_sources / the
// sheet / the database — never from a request payload. The database
// re-checks ownership and the channel mapping again inside
// apply_lead_import_batch().
//
// ── FAILURE ───────────────────────────────────────────────────────────────
// A failed apply rolls back every lead write, audit row, run count and
// source-metadata change together; the run row itself was committed by the
// claim in step 1, so the attempt is then marked FAILED in a separate
// transaction and stays visible in import history. Retrying is always
// safe: per-row source_updated_at makes a re-run of an already-applied
// batch classify as UNCHANGED and write nothing.

import type { SupabaseClient } from '@supabase/supabase-js';
import { classifySheetValuesDetailed, readSourceSheet } from './preview';
import type {
  ImportRowResult,
  ImportRunOutcome,
  LeadImportSource,
  RowValidationResult,
  ValidationIssue,
} from './types';

// Row-level audit payload for lead_import_run_rows. Deliberately carries no
// `notes` and no copy of the lead payload.
interface AuditRowPayload {
  sheet_row_number: number;
  lead_id: string | null;
  inventory_item_id: number | null;
  source_updated_at: string | null;
  classification: RowValidationResult['classification'];
  result: ImportRowResult;
  issue_codes: string[];
  issue_message: string | null;
}

interface ApplyRowPayload extends Omit<AuditRowPayload, 'result' | 'lead_id' | 'inventory_item_id'> {
  lead_id: string;
  inventory_item_id: number;
  first_contact_at: string | null;
  last_contact_at: string | null;
  source_channel: string | null;
  deal_channel_id: number | null;
  buyer_message_count: number | null;
  our_message_count: number | null;
  lead_quality: string;
  offer_type: string;
  initial_cash_offer: number | null;
  best_cash_offer: number | null;
  trade_item: string | null;
  cash_component: number | null;
  trade_est_value: number | null;
  status: string;
  outcome_reason: string | null;
  notes: string | null;
  source_updated_at: string;
}

export type ImportStartFailureCode =
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_DISABLED'
  | 'IMPORT_ALREADY_RUNNING'
  | 'REQUESTER_NOT_ADMIN'
  | 'START_FAILED';

export type RunLeadImportResult =
  // The run started. `outcome.status` says how it ended — including FAILED,
  // which is a completed attempt with a history row, not a refusal.
  | { ok: true; outcome: ImportRunOutcome }
  // The run never started; nothing was claimed and nothing was written.
  | { ok: false; code: ImportStartFailureCode; message: string };

const MAX_ISSUE_MESSAGE_LENGTH = 500;
const MAX_ERROR_SUMMARY_LENGTH = 2000;

function trimTo(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

// One short, code-derived sentence per row — errors first, then warnings.
// Never sheet content beyond what validate.ts already put in the message.
function issueMessageFor(row: RowValidationResult): string | null {
  const preferred = row.issues.find((i) => i.severity === 'error') ?? row.issues[0];
  if (!preferred) return null;
  const message = trimTo(preferred.message, MAX_ISSUE_MESSAGE_LENGTH);
  return message === '' ? null : message;
}

function issueCodesFor(row: RowValidationResult): string[] {
  return Array.from(new Set(row.issues.map((i) => i.code)));
}

const SKIP_RESULT_BY_CLASSIFICATION: Record<string, ImportRowResult> = {
  UNCHANGED: 'SKIPPED_UNCHANGED',
  SOURCE_OLDER: 'SKIPPED_SOURCE_OLDER',
  INVALID: 'SKIPPED_INVALID',
};

function auditRowFor(row: RowValidationResult, result: ImportRowResult): AuditRowPayload {
  return {
    sheet_row_number: row.rowNumber,
    lead_id: row.leadId,
    inventory_item_id: row.itemId,
    source_updated_at: row.parsedSourceUpdatedAt,
    classification: row.classification,
    result,
    issue_codes: issueCodesFor(row),
    issue_message: issueMessageFor(row),
  };
}

function applyRowFor(row: RowValidationResult): ApplyRowPayload {
  // Guarded by the caller: only rows with a non-null `normalized` payload
  // (i.e. no error-severity issue) ever reach here.
  const n = row.normalized!;
  return {
    sheet_row_number: n.sheetRowNumber,
    lead_id: n.leadId,
    inventory_item_id: n.inventoryItemId,
    first_contact_at: n.firstContactAt,
    last_contact_at: n.lastContactAt,
    source_channel: n.sourceChannel,
    deal_channel_id: n.dealChannelId,
    buyer_message_count: n.buyerMessageCount,
    our_message_count: n.ourMessageCount,
    lead_quality: n.leadQuality,
    offer_type: n.offerType,
    initial_cash_offer: n.initialCashOffer,
    best_cash_offer: n.bestCashOffer,
    trade_item: n.tradeItem,
    cash_component: n.cashComponent,
    trade_est_value: n.tradeEstValue,
    status: n.status,
    outcome_reason: n.outcomeReason,
    notes: n.notes,
    source_updated_at: n.sourceUpdatedAt,
    classification: row.classification,
    issue_codes: issueCodesFor(row),
    issue_message: issueMessageFor(row),
  };
}

function startFailureCodeFor(message: string): ImportStartFailureCode {
  if (message.includes('IMPORT_ALREADY_RUNNING')) return 'IMPORT_ALREADY_RUNNING';
  if (message.includes('SOURCE_NOT_FOUND')) return 'SOURCE_NOT_FOUND';
  if (message.includes('SOURCE_DISABLED')) return 'SOURCE_DISABLED';
  if (message.includes('REQUESTER_NOT_ADMIN')) return 'REQUESTER_NOT_ADMIN';
  return 'START_FAILED';
}

export const START_FAILURE_MESSAGES: Record<ImportStartFailureCode, string> = {
  IMPORT_ALREADY_RUNNING: 'An import for this source is already running. Wait for it to finish, then try again.',
  SOURCE_NOT_FOUND: 'Source not found.',
  SOURCE_DISABLED: 'This source is disabled. Enable it before importing.',
  REQUESTER_NOT_ADMIN: 'Admin privileges required.',
  START_FAILED: 'Could not start the import.',
};

interface ClassificationCounts {
  sourceRowCount: number;
  new: number;
  updates: number;
  unchanged: number;
  sourceOlder: number;
  invalid: number;
}

const EMPTY_COUNTS: ClassificationCounts = {
  sourceRowCount: 0, new: 0, updates: 0, unchanged: 0, sourceOlder: 0, invalid: 0,
};

export interface RunLeadImportParams {
  serviceClient: SupabaseClient;
  source: LeadImportSource;
  requestedByUserId: number;
}

export async function runLeadImport({
  serviceClient,
  source,
  requestedByUserId,
}: RunLeadImportParams): Promise<RunLeadImportResult> {
  // ── 1. Claim the source's single RUNNING slot ────────────────────────
  const { data: startData, error: startError } = await serviceClient.rpc('start_lead_import_run', {
    p_source_id: source.id,
    p_requested_by_user_id: requestedByUserId,
  });

  if (startError) {
    const code = startFailureCodeFor(startError.message ?? '');
    return { ok: false, code, message: START_FAILURE_MESSAGES[code] };
  }

  const runId = Number(startData);
  if (!Number.isInteger(runId) || runId <= 0) {
    return { ok: false, code: 'START_FAILED', message: START_FAILURE_MESSAGES.START_FAILED };
  }

  // From here on the run row exists and is RUNNING — every exit path must
  // finalize it, or the source stays claimed until the stale-run reaper in
  // start_lead_import_run() releases it.
  const failRun = async (
    errorSummary: string,
    auditRows: AuditRowPayload[],
    counts: ClassificationCounts,
    failedCount: number,
    sourceMaxUpdatedAt: string | null,
    fatalIssues: ValidationIssue[],
  ): Promise<RunLeadImportResult> => {
    const { error: failError } = await serviceClient.rpc('fail_lead_import_run', {
      p_run_id: runId,
      p_error_summary: trimTo(errorSummary, MAX_ERROR_SUMMARY_LENGTH),
      p_audit_rows: auditRows,
      p_source_row_count: counts.sourceRowCount,
      p_new_count: counts.new,
      p_update_count: counts.updates,
      p_unchanged_count: counts.unchanged,
      p_source_older_count: counts.sourceOlder,
      p_invalid_count: counts.invalid,
      p_failed_count: failedCount,
      p_source_max_updated_at: sourceMaxUpdatedAt,
    });

    if (failError) {
      // The run stays RUNNING and will be released by
      // start_lead_import_run()'s stale-run reaper on the next attempt. No
      // lead was written either way, so this is a history gap, not a data
      // problem — but it must be visible in the server log.
      console.error(`[leadImport] could not record the failure of run ${runId}:`, failError.message);
    }

    return {
      ok: true,
      outcome: {
        runId,
        status: 'FAILED',
        counts: {
          sourceRowCount: counts.sourceRowCount,
          new: counts.new,
          updates: counts.updates,
          unchanged: counts.unchanged,
          sourceOlder: counts.sourceOlder,
          invalid: counts.invalid,
          inserted: 0,
          updated: 0,
          failed: failedCount,
        },
        sourceMaxUpdatedAt,
        errorSummary: trimTo(errorSummary, MAX_ERROR_SUMMARY_LENGTH),
        fatalIssues,
      },
    };
  };

  try {
    // ── 2. Re-read the entire sheet ────────────────────────────────────
    const read = await readSourceSheet(source);
    if (!read.ok) {
      return await failRun(
        `${read.fatalIssue.code}: ${read.fatalIssue.message}`,
        [], EMPTY_COUNTS, 0, null, [read.fatalIssue],
      );
    }

    // ── 3/4/5. Re-normalize, re-validate, reload DB state, re-classify ─
    const { preview, rows } = await classifySheetValuesDetailed(read.values, source, serviceClient);

    if (preview.fatal) {
      return await failRun(
        preview.fatalIssues.map((i) => `${i.code}: ${i.message}`).join(' '),
        [], EMPTY_COUNTS, 0, null, preview.fatalIssues,
      );
    }

    const counts: ClassificationCounts = {
      sourceRowCount: preview.counts.rowsScanned,
      new: preview.counts.new,
      updates: preview.counts.updates,
      unchanged: preview.counts.unchanged,
      sourceOlder: preview.counts.sourceOlder,
      invalid: preview.counts.invalid,
    };
    const sourceMaxUpdatedAt = preview.maxSourceUpdatedAtObserved;

    // ── 6. Split into what gets applied and what gets skipped ──────────
    // Row-level invalidity never blocks the rest of the sheet: only this
    // row is skipped (and audited), every other valid change still goes in.
    const eligible = rows.filter(
      (r) => (r.classification === 'NEW' || r.classification === 'UPDATE') && r.normalized !== null,
    );
    const applyRows = eligible.map(applyRowFor);
    const skipRows = rows
      .filter((r) => r.classification !== 'NEW' && r.classification !== 'UPDATE')
      .map((r) => auditRowFor(r, SKIP_RESULT_BY_CLASSIFICATION[r.classification] ?? 'SKIPPED_INVALID'));

    const { data: applyData, error: applyError } = await serviceClient.rpc('apply_lead_import_batch', {
      p_run_id: runId,
      p_apply_rows: applyRows,
      p_skip_rows: skipRows,
      p_source_row_count: counts.sourceRowCount,
      p_new_count: counts.new,
      p_update_count: counts.updates,
      p_unchanged_count: counts.unchanged,
      p_source_older_count: counts.sourceOlder,
      p_invalid_count: counts.invalid,
      p_source_max_updated_at: sourceMaxUpdatedAt,
    });

    if (applyError) {
      // The whole apply transaction rolled back — no lead write, no audit
      // row and no source-metadata advance survived it. Record the attempt
      // with every eligible row marked FAILED so the run is reconstructable.
      const auditRows = [
        ...eligible.map((r) => auditRowFor(r, 'FAILED')),
        ...skipRows,
      ];
      return await failRun(
        applyError.message || 'The import transaction failed and was rolled back. No leads were changed.',
        auditRows, counts, eligible.length, sourceMaxUpdatedAt, [],
      );
    }

    const applied = (applyData ?? {}) as {
      status?: ImportRunOutcome['status'];
      inserted_count?: number;
      updated_count?: number;
      failed_count?: number;
    };

    return {
      ok: true,
      outcome: {
        runId,
        status: applied.status ?? 'COMPLETED',
        counts: {
          sourceRowCount: counts.sourceRowCount,
          new: counts.new,
          updates: counts.updates,
          unchanged: counts.unchanged,
          sourceOlder: counts.sourceOlder,
          invalid: counts.invalid,
          inserted: applied.inserted_count ?? 0,
          updated: applied.updated_count ?? 0,
          failed: applied.failed_count ?? 0,
        },
        sourceMaxUpdatedAt,
        errorSummary: null,
        fatalIssues: [],
      },
    };
  } catch (err) {
    // Anything unexpected (a network fault mid-run, a thrown Sheets error
    // that isn't a GoogleSheetsError) still has to release the claim.
    const message = err instanceof Error ? err.message : String(err);
    return await failRun(`Unexpected import failure: ${message}`, [], EMPTY_COUNTS, 0, null, []);
  }
}
