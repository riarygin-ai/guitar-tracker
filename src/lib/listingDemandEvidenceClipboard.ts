// Core logic for the temporary "Listing Demand Evidence" admin/debug
// utility (Debug Tools, admin page) — Copy JSON / Download JSON for a
// 7/30/90-day preset window. Deliberately separated from React so it is
// testable without a DOM (same rationale as listingEvidenceClipboard.ts).
// Never logs or otherwise surfaces the access token; every returned
// message is a fixed, safe string, never a raw fetch/Supabase error body.
//
// ONE shared fetch function (fetchListingDemandEvidence) backs both Copy
// and Download — they never build the payload independently, so their
// output can never drift; they only diverge in what they do with the same
// JSON.stringify() result (clipboard.writeText vs a file download).

import type { ListingDemandEvidence, TrendWeeks } from './analytics/listingDemandEvidence';
import { DEFAULT_TREND_WEEKS } from './analytics/listingDemandEvidence';

export interface ListingDemandEvidenceDeps {
  getAccessToken: () => Promise<string | null>;
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  writeText: (text: string) => Promise<void>;
  // Triggers a browser file download of `json`, named `filename`. Injected
  // so this module stays DOM-free/testable.
  downloadFile: (filename: string, json: string) => void;
}

export type FetchListingDemandEvidenceResult =
  | { status: 'success'; evidence: ListingDemandEvidence }
  | { status: 'unauthenticated'; message: string }
  | { status: 'request_failed'; message: string };

export type CopyListingDemandEvidenceResult =
  | { status: 'success'; evidence: ListingDemandEvidence }
  | { status: 'unauthenticated'; message: string }
  | { status: 'request_failed'; message: string }
  | { status: 'clipboard_failed'; message: string }
  | { status: 'already_in_progress' };

export type DownloadListingDemandEvidenceResult =
  | { status: 'success'; evidence: ListingDemandEvidence; filename: string }
  | { status: 'unauthenticated'; message: string }
  | { status: 'request_failed'; message: string }
  | { status: 'already_in_progress' };

const ENDPOINT = '/api/listing-demand-evidence';

// Explicit inclusive [start_date, end_date] — never fabricated server-side.
// A 30-day preset over "today" spans today and the 29 days before it.
export interface ListingDemandDateRange {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
}

function toDateOnly(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Resolves a "last N days" preset to explicit inclusive dates, ending today (local calendar date). */
export function resolveDayCountPreset(days: 7 | 30 | 90, today: Date = new Date()): ListingDemandDateRange {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  return { startDate: toDateOnly(start), endDate: toDateOnly(end) };
}

function buildEndpointUrl(range: ListingDemandDateRange, trendWeeks: TrendWeeks): string {
  const params = new URLSearchParams({
    start_date: range.startDate,
    end_date: range.endDate,
    trend_weeks: String(trendWeeks),
  });
  return `${ENDPOINT}?${params.toString()}`;
}

export async function fetchListingDemandEvidence(
  deps: Pick<ListingDemandEvidenceDeps, 'getAccessToken' | 'fetchImpl'>,
  range: ListingDemandDateRange,
  trendWeeks: TrendWeeks = DEFAULT_TREND_WEEKS,
): Promise<FetchListingDemandEvidenceResult> {
  const token = await deps.getAccessToken();
  if (!token) {
    return { status: 'unauthenticated', message: 'Not signed in — please sign in again.' };
  }

  let res: Response;
  try {
    res = await deps.fetchImpl(buildEndpointUrl(range, trendWeeks), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { status: 'request_failed', message: 'Could not reach the server. Please try again.' };
  }

  if (!res.ok) {
    return { status: 'request_failed', message: `Could not load listing demand evidence (server returned ${res.status}).` };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { status: 'request_failed', message: 'Received an unexpected response from the server.' };
  }

  const evidence = (payload as { target_user_listing_demand_evidence?: unknown } | null)?.target_user_listing_demand_evidence;
  if (typeof evidence !== 'object' || evidence === null) {
    return { status: 'request_failed', message: 'Listing demand evidence response had an unexpected shape.' };
  }

  return { status: 'success', evidence: evidence as ListingDemandEvidence };
}

/** e.g. "listing-demand-evidence-2026-08-15_to_2026-09-13.json" */
export function buildListingDemandEvidenceFilename(range: ListingDemandDateRange): string {
  return `listing-demand-evidence-${range.startDate}_to_${range.endDate}.json`;
}

export async function copyListingDemandEvidenceToClipboard(
  deps: Pick<ListingDemandEvidenceDeps, 'getAccessToken' | 'fetchImpl' | 'writeText'>,
  range: ListingDemandDateRange,
  trendWeeks: TrendWeeks = DEFAULT_TREND_WEEKS,
): Promise<CopyListingDemandEvidenceResult> {
  const result = await fetchListingDemandEvidence(deps, range, trendWeeks);
  if (result.status !== 'success') return result;

  const text = JSON.stringify(result.evidence, null, 2);
  try {
    await deps.writeText(text);
  } catch {
    return { status: 'clipboard_failed', message: 'Could not copy to clipboard — your browser may be blocking clipboard access.' };
  }

  return { status: 'success', evidence: result.evidence };
}

export async function downloadListingDemandEvidenceAsFile(
  deps: Pick<ListingDemandEvidenceDeps, 'getAccessToken' | 'fetchImpl' | 'downloadFile'>,
  range: ListingDemandDateRange,
  trendWeeks: TrendWeeks = DEFAULT_TREND_WEEKS,
): Promise<DownloadListingDemandEvidenceResult> {
  const result = await fetchListingDemandEvidence(deps, range, trendWeeks);
  if (result.status !== 'success') return result;

  const filename = buildListingDemandEvidenceFilename(range);
  const text = JSON.stringify(result.evidence, null, 2);
  deps.downloadFile(filename, text);

  return { status: 'success', evidence: result.evidence, filename };
}

/**
 * Wraps copyListingDemandEvidenceToClipboard with an in-flight guard so
 * repeated clicks while a copy is already running never issue a second
 * request — same pattern as createListingEvidenceCopier.
 */
export function createListingDemandEvidenceCopier(
  deps: Pick<ListingDemandEvidenceDeps, 'getAccessToken' | 'fetchImpl' | 'writeText'>,
) {
  let inFlight = false;

  return {
    async copy(range: ListingDemandDateRange, trendWeeks: TrendWeeks = DEFAULT_TREND_WEEKS): Promise<CopyListingDemandEvidenceResult> {
      if (inFlight) return { status: 'already_in_progress' };
      inFlight = true;
      try {
        return await copyListingDemandEvidenceToClipboard(deps, range, trendWeeks);
      } finally {
        inFlight = false;
      }
    },
  };
}

/** Same in-flight guard shape as createListingDemandEvidenceCopier, for the Download action. */
export function createListingDemandEvidenceDownloader(
  deps: Pick<ListingDemandEvidenceDeps, 'getAccessToken' | 'fetchImpl' | 'downloadFile'>,
) {
  let inFlight = false;

  return {
    async download(range: ListingDemandDateRange, trendWeeks: TrendWeeks = DEFAULT_TREND_WEEKS): Promise<DownloadListingDemandEvidenceResult> {
      if (inFlight) return { status: 'already_in_progress' };
      inFlight = true;
      try {
        return await downloadListingDemandEvidenceAsFile(deps, range, trendWeeks);
      } finally {
        inFlight = false;
      }
    },
  };
}
