import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { generateListingAdvice, getLatestListingAdvice } from '@/lib/analytics/listingAdvice/generateListingAdvice';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// GET  /api/listing-advice  -> the caller's latest COMPLETED Listing Advice (+ whether a
//                              generation is in flight and any newer failure). Read through
//                              the caller's own RLS client; no model call, no generation.
// POST /api/listing-advice  -> manual refresh: generate a new Listing Advice run for the
//                              caller. No request body — the target user is always the
//                              token's own app_users.id, never client-supplied.
//
// Listing Advice is optional enrichment: /listings never depends on either call succeeding.

async function authenticate(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { error: NextResponse.json({ error: 'Missing authorization token' }, { status: 401 }) } as const;

  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: authError } = await db.auth.getUser();
  if (authError || !user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const;

  const { data: appUser } = await db.from('app_users').select('id, admin').eq('auth_user_id', user.id).single();
  if (!appUser) return { error: NextResponse.json({ error: 'No app user found for this account' }, { status: 403 }) } as const;

  return { db, appUserId: appUser.id as number, isAdmin: appUser.admin === true } as const;
}

export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if ('error' in auth) return auth.error;
  try {
    const advice = await getLatestListingAdvice(auth.db, auth.appUserId);
    return NextResponse.json({ ...advice, viewer_is_admin: auth.isAdmin });
  } catch (err) {
    console.error('[api/listing-advice] load failed:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'Could not load Listing Advice' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if ('error' in auth) return auth.error;

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[api/listing-advice] SUPABASE_SERVICE_ROLE_KEY is not configured');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const outcome = await generateListingAdvice({ appUserId: auth.appUserId, serviceClient });

  switch (outcome.status) {
    case 'completed':
      return NextResponse.json({ status: 'completed', run: outcome.run });
    case 'failed':
      return NextResponse.json({ status: 'failed', error: outcome.run.error_message ?? 'Generation failed', error_code: outcome.run.error_code }, { status: 502 });
    case 'already_generating':
      return NextResponse.json({ status: 'already_generating', error: 'Listing Advice is already being generated.' }, { status: 409 });
    case 'context_unavailable':
      return NextResponse.json({ status: 'context_unavailable', error: outcome.message }, { status: 503 });
    default:
      return NextResponse.json({ status: 'error', error: outcome.message }, { status: 500 });
  }
}
