// Client-side fetch wrapper for GET /api/listing-item-activity — same
// "get session -> Bearer fetch -> validate" shape as the other evidence
// clients. One compact request per Trend Window (never per item).

import { supabase } from '@/lib/supabase';
import type { ItemActivityEntry } from './listingItemActivity';

export type ListingItemActivityFetchResult =
  | { status: 'success'; items: ItemActivityEntry[] }
  | { status: 'unauthenticated'; message: string }
  | { status: 'error'; message: string };

export async function fetchListingItemActivity(startDate: string, endDate: string): Promise<ListingItemActivityFetchResult> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return { status: 'unauthenticated', message: 'Not signed in — please sign in again.' };
  }

  const qs = new URLSearchParams({ start_date: startDate, end_date: endDate });
  let res: Response;
  try {
    res = await fetch(`/api/listing-item-activity?${qs.toString()}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
  } catch {
    return { status: 'error', message: 'Could not reach the server. Please try again.' };
  }
  if (!res.ok) {
    return { status: 'error', message: `Could not load item activity (server returned ${res.status}).` };
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return { status: 'error', message: 'Received an unexpected response from the server.' };
  }
  const items = (payload as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) {
    return { status: 'error', message: 'Item activity response had an unexpected shape.' };
  }
  return { status: 'success', items: items as ItemActivityEntry[] };
}
