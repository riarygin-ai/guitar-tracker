import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runListingAdviceRefresh } from '@/lib/analytics/coachRefresh';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// One model call; same budget as the other generation routes.
export const maxDuration = 120;

// POST /api/listing-advice/refresh — the /listings "Refresh Advice" button: the Listing Advice module of the
// Coach refresh ONLY (the weekly refresh and "Refresh Coach" run it automatically). Same service as the weekly
// refresh: canonical evidence, identical-input dedupe (no new model call when nothing changed), one generation in
// flight per user (DB-enforced), and a failure never replaces the latest completed advice. No request body.
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return NextResponse.json({ error: 'Missing authorization token' }, { status: 401 });

  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: authError } = await db.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data: appUser } = await db.from('app_users').select('id').eq('auth_user_id', user.id).single();
  if (!appUser) return NextResponse.json({ error: 'No app user found for this account' }, { status: 403 });

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[api/listing-advice/refresh] SUPABASE_SERVICE_ROLE_KEY is not configured');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const result = await runListingAdviceRefresh({ appUserId: appUser.id as number, serviceClient });
  // Only the status/code/card count go back — never the raw error detail.
  const body = { status: result.status, code: result.code, card_count: result.cardCount };
  if (result.status === 'skipped') return NextResponse.json(body, { status: 409 });
  if (result.status === 'failed') return NextResponse.json(body, { status: 502 });
  return NextResponse.json(body);
}
