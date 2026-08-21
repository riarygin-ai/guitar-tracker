// Core logic for the "Copy Analysis Data" / "Preview JSON" controls on the
// Listing Dashboard. Deliberately separated from React (same rationale as
// src/lib/listingEvidenceClipboard.ts) so it is testable without a DOM.
// Never logs or otherwise surfaces the access token; every returned
// message is a fixed, safe string, never a raw fetch/Supabase error body.

import type { ListingAnalysisPacket, ListingAnalysisPacketScopeType } from './analytics/listingAnalysisPacket';

export interface AnalysisPacketDeps {
  getAccessToken: () => Promise<string | null>;
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  writeText: (text: string) => Promise<void>;
}

export interface AnalysisPacketScopeSelection {
  scope: ListingAnalysisPacketScopeType;
  channelId?: number;
}

export type FetchAnalysisPacketResult =
  | { status: 'success'; packet: ListingAnalysisPacket }
  | { status: 'unauthenticated'; message: string }
  | { status: 'request_failed'; message: string };

export type CopyAnalysisPacketResult =
  | { status: 'success'; packet: ListingAnalysisPacket }
  | { status: 'unauthenticated'; message: string }
  | { status: 'request_failed'; message: string }
  | { status: 'clipboard_failed'; message: string }
  | { status: 'already_in_progress' };

function buildEndpointUrl(selection: AnalysisPacketScopeSelection): string {
  const params = new URLSearchParams({ scope: selection.scope });
  if (selection.scope === 'channel' && selection.channelId != null) {
    params.set('channel_id', String(selection.channelId));
  }
  return `/api/listing-analysis-packet?${params.toString()}`;
}

export async function fetchAnalysisPacket(
  deps: AnalysisPacketDeps,
  selection: AnalysisPacketScopeSelection,
): Promise<FetchAnalysisPacketResult> {
  const token = await deps.getAccessToken();
  if (!token) {
    return { status: 'unauthenticated', message: 'Not signed in — please sign in again.' };
  }

  let res: Response;
  try {
    res = await deps.fetchImpl(buildEndpointUrl(selection), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { status: 'request_failed', message: 'Could not reach the server. Please try again.' };
  }

  if (!res.ok) {
    return { status: 'request_failed', message: `Could not load the analysis packet (server returned ${res.status}).` };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { status: 'request_failed', message: 'Received an unexpected response from the server.' };
  }

  const packet = (payload as { target_user_listing_analysis_packet?: unknown } | null)?.target_user_listing_analysis_packet;
  if (typeof packet !== 'object' || packet === null) {
    return { status: 'request_failed', message: 'Analysis packet response had an unexpected shape.' };
  }

  return { status: 'success', packet: packet as ListingAnalysisPacket };
}

export async function copyAnalysisPacketToClipboard(
  deps: AnalysisPacketDeps,
  selection: AnalysisPacketScopeSelection,
): Promise<CopyAnalysisPacketResult> {
  const result = await fetchAnalysisPacket(deps, selection);
  if (result.status !== 'success') return result;

  const text = JSON.stringify(result.packet, null, 2);
  try {
    await deps.writeText(text);
  } catch {
    return { status: 'clipboard_failed', message: 'Could not copy to clipboard — your browser may be blocking clipboard access.' };
  }

  return { status: 'success', packet: result.packet };
}

/**
 * Wraps copyAnalysisPacketToClipboard with an in-flight guard so repeated
 * clicks while a copy is already running never issue a second request —
 * same pattern as createListingEvidenceCopier.
 */
export function createAnalysisPacketCopier(deps: AnalysisPacketDeps) {
  let inFlight = false;

  return {
    async copy(selection: AnalysisPacketScopeSelection): Promise<CopyAnalysisPacketResult> {
      if (inFlight) {
        return { status: 'already_in_progress' };
      }
      inFlight = true;
      try {
        return await copyAnalysisPacketToClipboard(deps, selection);
      } finally {
        inFlight = false;
      }
    },
  };
}
