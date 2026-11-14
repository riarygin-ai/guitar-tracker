import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { resurfaceAdvice } from '@/lib/analytics/listingAdvice/listingAdviceDismissal';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// POST /api/advice-dismissals/resurface { adviceKey } — ends the caller's own active dismissal now, for a
// General Coach (v2:…) or Listing Advice (listing:v1:…) card. Same table, namespaces never merged: the key names
// exactly one of the caller's rows. user_id is server-resolved; advice rows are never touched.
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return NextResponse.json({ error: 'Missing authorization token' }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { adviceKey?: unknown } | null;
  const adviceKey = typeof body?.adviceKey === 'string' ? body.adviceKey.trim() : '';
  if (!adviceKey || adviceKey.length > 500 || !/^(v2:|listing:v1:)/.test(adviceKey)) {
    return NextResponse.json({ error: 'adviceKey is required' }, { status: 400 });
  }

  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: authError } = await db.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data: appUser } = await db.from('app_users').select('id').eq('auth_user_id', user.id).single();
  if (!appUser) return NextResponse.json({ error: 'No app user found for this account' }, { status: 403 });

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[api/advice-dismissals/resurface] SUPABASE_SERVICE_ROLE_KEY is not configured');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const result = await resurfaceAdvice({ serviceClient, appUserId: appUser.id as number, adviceKey });
  if (result.status === 'resurfaced') return NextResponse.json({ resurfaced: true });
  if (result.status === 'not_found') return NextResponse.json({ error: 'No active dismissal for this advice' }, { status: 404 });
  return NextResponse.json({ error: result.message }, { status: 500 });
}
