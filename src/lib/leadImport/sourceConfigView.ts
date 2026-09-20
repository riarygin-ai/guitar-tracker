// Pure view-model helpers for the Admin -> Lead Log Import "Source
// configuration" card (src/app/admin/lead-import/page.tsx), extracted so the
// UX rules are testable without rendering React:
//
//  • the page defaults to the CURRENT authenticated Guitar Tracker user
//    and that user's saved GT_LEAD_LOG source (one per user);
//  • a saved source is shown as a compact summary — the edit form (user
//    picker, source name, spreadsheet, sheet, enabled) only exists inside
//    "Change configuration";
//  • the form draft is always rebuilt from the SELECTED user's own source
//    (or neutral defaults), so one user's spreadsheet/sheet can never leak
//    into another user's form;
//  • Preview/Import are offered only when a source exists, and they always
//    act on the saved source id — never on form values.
//
// Hiding controls here is UX, not security: /api/admin/lead-import/* and
// the lead_import_sources RLS remain the authoritative admin checks.

import type { LeadImportSource } from './types';

export const DEFAULT_SHEET_NAME = 'Leads';

export interface ConfigDraft {
  sourceName: string;
  spreadsheetInput: string;
  sheetName: string;
  isEnabled: boolean;
}

/** Form values for one user: their saved source, or neutral defaults — never anything from another user. */
export function buildConfigDraft(
  existing: Pick<LeadImportSource, 'source_name' | 'spreadsheet_id' | 'sheet_name' | 'is_enabled'> | null | undefined,
  userDisplayName: string | null | undefined,
): ConfigDraft {
  return {
    sourceName: existing?.source_name ?? (userDisplayName ? `${userDisplayName} GT Lead Log` : ''),
    spreadsheetInput: existing?.spreadsheet_id ?? '',
    sheetName: existing?.sheet_name ?? DEFAULT_SHEET_NAME,
    isEnabled: existing?.is_enabled ?? true,
  };
}

export type ConfigPanelMode = 'edit' | 'summary' | 'setup';

/** edit = "Change configuration"/"Configure source" form; summary = saved source; setup = nothing configured yet. */
export function configPanelMode(source: LeadImportSource | null | undefined, editing: boolean): ConfigPanelMode {
  if (editing) return 'edit';
  return source ? 'summary' : 'setup';
}

/** Preview/Import need a saved source and are not offered while editing or in the setup state. */
export function canOfferPreview(source: LeadImportSource | null | undefined, editing: boolean): boolean {
  return configPanelMode(source, editing) === 'summary';
}

/** Normal-view user: always the authenticated user (initially, and again after Cancel / a successful Save). */
export function defaultSelectedUserId(authenticatedUserId: number): number {
  return authenticatedUserId;
}

/** Compact, human-readable spreadsheet label — never the raw long id as a primary field. */
export function describeSpreadsheet(spreadsheetId: string | null | undefined): string {
  const id = (spreadsheetId ?? '').trim();
  if (!id) return 'Not configured';
  return id.length > 8 ? `Configured (…${id.slice(-6)})` : 'Configured';
}

export interface SourceSummary {
  title: string;
  spreadsheetLabel: string;
  sheetName: string;
  statusLabel: 'Enabled' | 'Disabled';
  lastSuccessfulImportAt: string | null;
}

export function summarizeSource(source: LeadImportSource): SourceSummary {
  return {
    title: source.source_name,
    spreadsheetLabel: describeSpreadsheet(source.spreadsheet_id),
    sheetName: source.sheet_name,
    statusLabel: source.is_enabled ? 'Enabled' : 'Disabled',
    lastSuccessfulImportAt: source.last_successful_import_at ?? null,
  };
}

export function formatImportTimestamp(iso: string | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Never';
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}
