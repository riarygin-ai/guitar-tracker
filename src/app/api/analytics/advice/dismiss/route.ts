import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { computeAdviceKey } from '@/lib/analytics/advice/adviceKey';
import type { StructuredAdviceResponse } from '@/lib/analytics/advice/types';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const RESURFACE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Advice Dismissal / Resurface v1 — dismiss one Advice card from the
// Dashboard's active coach view for 30 days.
//
// The client never supplies user_id, and never supplies advice_key
// directly either: it identifies the card only by (analyticsRunAdviceId,
// adviceCode) — which completed revision, and which card within it — and
// this route loads that revision, verifies ownership via the SAME RLS
// policy every other read of analytics_run_advice already goes through
// (using the caller's own bearer token, never service_role, for this
// read), locates the matching card, and RECOMPUTES advice_key itself from
// that card's own advice_type/item_id/source_ids. A client can never
// dismiss a card it doesn't actually have access to, and can never forge
// an advice_key for a card that doesn't exist.
//
// This route never touches analytics_run_advice itself — no update, no
// delete. It only ever reads it (to recompute the key) and writes to the
// separate analytics_advice_dismissals table.
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { analyticsRunAdviceId, adviceCode } = (body ?? {}) as { analyticsRunAdviceId?: unknown; adviceCode?: unknown };

  if (!Number.isInteger(analyticsRunAdviceId) || (analyticsRunAdviceId as number) <= 0) {
    return NextResponse.json({ error: 'Invalid analyticsRunAdviceId' }, { status: 400 });
  }
  if (typeof adviceCode !== 'string' || adviceCode.trim() === '') {
    return NextResponse.json({ error: 'Invalid adviceCode' }, { status: 400 });
  }

  // ── Authenticate ─────────────────────────────────────────────────────
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return NextResponse.json({ error: 'Missing authorization token' }, { status: 401 });
  }

  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });

  const { data: { user }, error: authError } = await db.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ── Resolve app_users.id ──────────────────────────────────────────────
  const { data: appUser } = await db
    .from('app_users')
    .select('id')
    .eq('auth_user_id', user.id)
    .single();

  if (!appUser) {
    return NextResponse.json({ error: 'No app user found for this account' }, { status: 403 });
  }

  // ── Load the completed advice revision — RLS (bearer-scoped `db`
  // client, not service_role) already guarantees this can only return a
  // row owned by the caller. Same 404 for "doesn't exist" and "exists but
  // isn't yours" as the advice-generation route. ─────────────────────────
  const { data: adviceRow, error: adviceError } = await db
    .from('analytics_run_advice')
    .select('id, advice')
    .eq('id', analyticsRunAdviceId as number)
    .eq('status', 'completed')
    .maybeSingle();

  if (adviceError || !adviceRow) {
    return NextResponse.json({ error: 'Advice not found' }, { status: 404 });
  }

  const advice = adviceRow.advice as StructuredAdviceResponse | null;
  const card = advice?.advice_cards.find((c) => c.advice_code === adviceCode);
  if (!card) {
    return NextResponse.json({ error: 'Advice card not found in this revision' }, { status: 404 });
  }

  const adviceKey = computeAdviceKey(card);
  const dismissedAt = new Date();
  const resurfaceAfter = new Date(dismissedAt.getTime() + RESURFACE_WINDOW_MS);

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[api/analytics/advice/dismiss] SUPABASE_SERVICE_ROLE_KEY is not configured');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── Upsert — first dismiss creates the row; dismissing the same
  // advice_key again (whether still active or already resurfaced) refreshes
  // dismissed_at/resurface_after to a fresh 30-day window rather than
  // inserting a duplicate. The UNIQUE (user_id, advice_key) constraint plus
  // this single upsert also makes a double-click race harmless: a second
  // concurrent request for the same key lands on the same row. ───────────
  const { error: upsertError } = await serviceClient
    .from('analytics_advice_dismissals')
    .upsert(
      {
        user_id: appUser.id as number,
        advice_key: adviceKey,
        dismissed_at: dismissedAt.toISOString(),
        resurface_after: resurfaceAfter.toISOString(),
      },
      { onConflict: 'user_id,advice_key' },
    );

  if (upsertError) {
    console.error('[api/analytics/advice/dismiss] upsert failed:', upsertError.message);
    return NextResponse.json({ error: 'Failed to dismiss advice' }, { status: 500 });
  }

  return NextResponse.json({ dismissed: true, resurface_after: resurfaceAfter.toISOString() }, { status: 200 });
}
