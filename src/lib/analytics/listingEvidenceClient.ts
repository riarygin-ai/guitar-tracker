// Client-side fetch wrapper for GET /api/listing-evidence — the single
// place any client component goes to read Listing Evidence v1.0. Both the
// Listing Dashboard (src/app/listings/page.tsx) and the Inventory
// drill-down filters (src/app/inventory/page.tsx) import this rather than
// each re-implementing the "get session -> Bearer fetch -> parse" flow, so
// there is exactly one client-side path to the one authoritative evidence
// source (see the migration's own header: "Listing Evidence v1.0 must
// remain the single authoritative source for current listing state").

import { supabase } from '@/lib/supabase';
import type { ListingEvidence } from './listingEvidence';
import { isValidListingEvidence } from './listingEvidence';

export type ListingEvidenceFetchResult =
  | { status: 'success'; data: ListingEvidence }
  | { status: 'unauthenticated'; message: string }
  | { status: 'error'; message: string };

export async function fetchListingEvidence(): Promise<ListingEvidenceFetchResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return { status: 'unauthenticated', message: 'Not signed in — please sign in again.' };
  }

  let res: Response;
  try {
    res = await fetch('/api/listing-evidence', {
      method: 'GET',
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
  } catch {
    return { status: 'error', message: 'Could not reach the server. Please try again.' };
  }

  if (!res.ok) {
    return { status: 'error', message: `Could not load listing evidence (server returned ${res.status}).` };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { status: 'error', message: 'Received an unexpected response from the server.' };
  }

  const evidence = (payload as { target_user_listing_evidence?: unknown } | null)?.target_user_listing_evidence;
  if (!isValidListingEvidence(evidence)) {
    return { status: 'error', message: 'Listing evidence response had an unexpected shape.' };
  }

  return { status: 'success', data: evidence };
}
