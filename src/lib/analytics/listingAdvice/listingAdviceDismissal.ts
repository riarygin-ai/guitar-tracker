// Server-only. Dismissal of a Listing Advice card, independent of
// generation: a user can dismiss cards on /listings but cannot regenerate
// them there. Reuses the existing analytics_advice_dismissals table and its
// fixed 30-day resurface policy (same rules as the general Coach) with a
// `listing:`-namespaced advice_key (see listingAdviceKey.ts) — no new schema.
//
// The client never supplies user_id or advice_key: it names a completed run
// and a card (adviceCode); the run is read through the CALLER'S OWN RLS
// client (so a foreign/nonexistent run is simply "not found"), the key is
// recomputed here from that card's cited sources, and only the dismissals
// table is written (never listing_advice_runs — advice rows stay immutable).

import type { SupabaseClient } from '@supabase/supabase-js';
import { listingAdviceKey, LISTING_ADVICE_KEY_PREFIX } from '../../listingAdviceKey';
import type { ListingAdviceOutput } from './listingAdvice';

export const LISTING_DISMISS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type DismissListingAdviceResult =
  | { status: 'dismissed'; adviceKey: string; resurfaceAfter: string }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

export async function dismissListingAdviceCard(params: {
  /** The caller's own RLS-scoped client. */
  db: SupabaseClient;
  serviceClient: SupabaseClient;
  appUserId: number;
  listingAdviceRunId: number;
  adviceCode: string;
  now?: Date;
}): Promise<DismissListingAdviceResult> {
  const { db, serviceClient, appUserId, listingAdviceRunId, adviceCode } = params;
  const now = params.now ?? new Date();

  const { data: run, error } = await db
    .from('listing_advice_runs')
    .select('id, output')
    .eq('id', listingAdviceRunId)
    .eq('status', 'completed')
    .maybeSingle();
  if (error || !run) return { status: 'not_found' };

  const card = (run.output as ListingAdviceOutput | null)?.cards.find((c) => c.advice_code === adviceCode);
  if (!card) return { status: 'not_found' };

  const adviceKey = listingAdviceKey(card);
  const resurfaceAfter = new Date(now.getTime() + LISTING_DISMISS_WINDOW_MS).toISOString();
  const { error: upsertError } = await serviceClient
    .from('analytics_advice_dismissals')
    .upsert({ user_id: appUserId, advice_key: adviceKey, dismissed_at: now.toISOString(), resurface_after: resurfaceAfter }, { onConflict: 'user_id,advice_key' });
  if (upsertError) return { status: 'error', message: 'Failed to dismiss advice' };

  return { status: 'dismissed', adviceKey, resurfaceAfter };
}

/** The caller's currently active (not yet resurfaced) Listing Advice dismissal keys — read through their RLS client. */
export async function getActiveListingDismissalKeys(db: SupabaseClient, now: Date = new Date()): Promise<string[]> {
  const { data, error } = await db
    .from('analytics_advice_dismissals')
    .select('advice_key')
    .like('advice_key', `${LISTING_ADVICE_KEY_PREFIX}%`)
    .gt('resurface_after', now.toISOString());
  if (error) throw new Error(`analytics_advice_dismissals: ${error.message}`);
  return (data ?? []).map((r) => r.advice_key as string);
}
