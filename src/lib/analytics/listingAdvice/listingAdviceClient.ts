// Client-side wrappers for /api/listing-advice — same "get session -> Bearer
// fetch -> parse" shape as the other evidence clients. /listings only READS
// the latest persisted advice and can dismiss cards; it can never trigger
// generation (that lives solely in the Analytics workflow).

import { supabase } from '@/lib/supabase';
import type { LatestListingAdvice } from './generateListingAdvice';

export type LatestListingAdviceResponse = LatestListingAdvice & { viewer_is_admin: boolean; dismissed_keys: string[] };

async function bearer(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

export async function fetchLatestListingAdvice(): Promise<LatestListingAdviceResponse> {
  const token = await bearer();
  if (!token) throw new Error('Not signed in — please sign in again.');
  const res = await fetch('/api/listing-advice', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Could not load Listing Advice (server returned ${res.status}).`);
  const payload = (await res.json()) as Partial<LatestListingAdviceResponse>;
  if (!payload || !('latest' in payload)) throw new Error('Listing Advice response had an unexpected shape.');
  return {
    latest: payload.latest ?? null,
    generating: !!payload.generating,
    last_failure: payload.last_failure ?? null,
    viewer_is_admin: !!payload.viewer_is_admin,
    dismissed_keys: Array.isArray(payload.dismissed_keys) ? payload.dismissed_keys : [],
  };
}

export async function dismissListingAdvice(listingAdviceRunId: number, adviceCode: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const token = await bearer();
  if (!token) return { ok: false, message: 'Not signed in — please sign in again.' };
  try {
    const res = await fetch('/api/listing-advice/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ listingAdviceRunId, adviceCode }),
    });
    if (res.ok) return { ok: true };
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, message: payload.error ?? `Could not dismiss (server returned ${res.status}).` };
  } catch {
    return { ok: false, message: 'Could not reach the server. Please try again.' };
  }
}
