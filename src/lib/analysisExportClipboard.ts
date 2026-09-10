// Core logic for the "Copy Analysis Data" / "Download Analysis Data"
// controls on the Listing Dashboard — the complete-dataset export (every
// currently-open item, listed and unlisted, with full listing_history and
// price_history). Deliberately separated from React (same rationale as
// src/lib/analysisPacketClipboard.ts) so it's testable without a DOM.
// Never logs or otherwise surfaces the access token; every returned
// message is a fixed, safe string, never a raw fetch/Supabase error body.
//
// ONE shared fetch function (fetchAnalysisExportData) backs both actions —
// Copy and Download never build the dataset independently, so their
// output can never drift from each other; they only diverge in what they
// do with the same JSON.stringify()'d result (clipboard.writeText vs a
// file download).

import type { AnalysisExportData } from './analytics/listingAnalysisPacket';

export interface AnalysisExportDeps {
  getAccessToken: () => Promise<string | null>;
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  writeText: (text: string) => Promise<void>;
  // Triggers a browser file download of `json`, named `filename`. Injected
  // so this module stays DOM-free/testable — the component supplies the
  // real Blob + anchor-click implementation.
  downloadFile: (filename: string, json: string) => void;
}

export type FetchAnalysisExportResult =
  | { status: 'success'; data: AnalysisExportData }
  | { status: 'unauthenticated'; message: string }
  | { status: 'request_failed'; message: string };

export type CopyAnalysisExportResult =
  | { status: 'success'; data: AnalysisExportData }
  | { status: 'unauthenticated'; message: string }
  | { status: 'request_failed'; message: string }
  | { status: 'clipboard_failed'; message: string }
  | { status: 'already_in_progress' };

export type DownloadAnalysisExportResult =
  | { status: 'success'; data: AnalysisExportData; filename: string }
  | { status: 'unauthenticated'; message: string }
  | { status: 'request_failed'; message: string }
  | { status: 'already_in_progress' };

const ENDPOINT = '/api/listing-analysis-export';

export async function fetchAnalysisExportData(
  deps: Pick<AnalysisExportDeps, 'getAccessToken' | 'fetchImpl'>,
): Promise<FetchAnalysisExportResult> {
  const token = await deps.getAccessToken();
  if (!token) {
    return { status: 'unauthenticated', message: 'Not signed in — please sign in again.' };
  }

  let res: Response;
  try {
    res = await deps.fetchImpl(ENDPOINT, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { status: 'request_failed', message: 'Could not reach the server. Please try again.' };
  }

  if (!res.ok) {
    return { status: 'request_failed', message: `Could not load the analysis data (server returned ${res.status}).` };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { status: 'request_failed', message: 'Received an unexpected response from the server.' };
  }

  const data = (payload as { target_user_analysis_export?: unknown } | null)?.target_user_analysis_export;
  if (typeof data !== 'object' || data === null) {
    return { status: 'request_failed', message: 'Analysis export response had an unexpected shape.' };
  }

  return { status: 'success', data: data as AnalysisExportData };
}

/** e.g. "guitar-tracker-analysis-2026-09-10.json" — local calendar date, zero-padded. */
export function buildAnalysisExportFilename(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `guitar-tracker-analysis-${y}-${m}-${d}.json`;
}

export async function copyAnalysisExportToClipboard(
  deps: Pick<AnalysisExportDeps, 'getAccessToken' | 'fetchImpl' | 'writeText'>,
): Promise<CopyAnalysisExportResult> {
  const result = await fetchAnalysisExportData(deps);
  if (result.status !== 'success') return result;

  const text = JSON.stringify(result.data, null, 2);
  try {
    await deps.writeText(text);
  } catch {
    return { status: 'clipboard_failed', message: 'Could not copy to clipboard — your browser may be blocking clipboard access.' };
  }

  return { status: 'success', data: result.data };
}

export async function downloadAnalysisExportAsFile(
  deps: Pick<AnalysisExportDeps, 'getAccessToken' | 'fetchImpl' | 'downloadFile'>,
): Promise<DownloadAnalysisExportResult> {
  const result = await fetchAnalysisExportData(deps);
  if (result.status !== 'success') return result;

  const filename = buildAnalysisExportFilename();
  const text = JSON.stringify(result.data, null, 2);
  deps.downloadFile(filename, text);

  return { status: 'success', data: result.data, filename };
}

/**
 * Wraps copyAnalysisExportToClipboard with an in-flight guard so repeated
 * clicks while a copy is already running never issue a second request —
 * same pattern as createAnalysisPacketCopier.
 */
export function createAnalysisExportCopier(deps: Pick<AnalysisExportDeps, 'getAccessToken' | 'fetchImpl' | 'writeText'>) {
  let inFlight = false;

  return {
    async copy(): Promise<CopyAnalysisExportResult> {
      if (inFlight) return { status: 'already_in_progress' };
      inFlight = true;
      try {
        return await copyAnalysisExportToClipboard(deps);
      } finally {
        inFlight = false;
      }
    },
  };
}

/** Same in-flight guard shape as createAnalysisExportCopier, for the Download action. */
export function createAnalysisExportDownloader(deps: Pick<AnalysisExportDeps, 'getAccessToken' | 'fetchImpl' | 'downloadFile'>) {
  let inFlight = false;

  return {
    async download(): Promise<DownloadAnalysisExportResult> {
      if (inFlight) return { status: 'already_in_progress' };
      inFlight = true;
      try {
        return await downloadAnalysisExportAsFile(deps);
      } finally {
        inFlight = false;
      }
    },
  };
}
