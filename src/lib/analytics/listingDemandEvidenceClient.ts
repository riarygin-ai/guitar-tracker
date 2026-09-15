// Client-side fetch wrapper for GET /api/listing-demand-evidence — the
// single place any client component goes to read Listing Demand Evidence
// v1.0/v1.1 for the current user. Mirrors listingEvidenceClient.ts's
// "get session -> Bearer fetch -> parse" shape exactly, so there is one
// consistent pattern for both evidence sources. This is distinct from
// src/lib/listingDemandEvidenceClipboard.ts, which is a deps-injectable
// module built for the Admin Debug Tools' Copy/Download flows and their
// tests — this module has no injected deps and is meant for ordinary
// product-page data fetching (currently /listings).

import { supabase } from '@/lib/supabase';
import type { ListingDemandEvidence, TrendWeeks } from './listingDemandEvidence';
import { isValidListingDemandEvidence } from './listingDemandEvidence';

export type ListingDemandEvidenceFetchResult =
  | { status: 'success'; data: ListingDemandEvidence }
  | { status: 'unauthenticated'; message: string }
  | { status: 'error'; message: string };

export interface FetchListingDemandEvidenceForCurrentUserParams {
  startDate: string; // YYYY-MM-DD, inclusive
  endDate: string;   // YYYY-MM-DD, inclusive
  trendWeeks: TrendWeeks;
}

export async function fetchListingDemandEvidenceForCurrentUser(
  params: FetchListingDemandEvidenceForCurrentUserParams,
): Promise<ListingDemandEvidenceFetchResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return { status: 'unauthenticated', message: 'Not signed in — please sign in again.' };
  }

  const qs = new URLSearchParams({
    start_date: params.startDate,
    end_date: params.endDate,
    trend_weeks: String(params.trendWeeks),
  });

  let res: Response;
  try {
    res = await fetch(`/api/listing-demand-evidence?${qs.toString()}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
  } catch {
    return { status: 'error', message: 'Could not reach the server. Please try again.' };
  }

  if (!res.ok) {
    return { status: 'error', message: `Could not load demand evidence (server returned ${res.status}).` };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { status: 'error', message: 'Received an unexpected response from the server.' };
  }

  const evidence = (payload as { target_user_listing_demand_evidence?: unknown } | null)?.target_user_listing_demand_evidence;
  if (!isValidListingDemandEvidence(evidence)) {
    return { status: 'error', message: 'Listing demand evidence response had an unexpected shape.' };
  }

  return { status: 'success', data: evidence };
}
