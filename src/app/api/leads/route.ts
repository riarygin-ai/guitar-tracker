import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { loadLeadsForUser, LeadsLoadError, type LeadAttributionRequest } from '@/lib/leads/leadsServer';
import { isValidDateParam } from '@/lib/leads/leadFilters';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// GET /api/leads[?channel_id=N&from=YYYY-MM-DD&to=YYYY-MM-DD]
//
// Read-only. Returns the authenticated caller's OWN leads (RLS-scoped
// client + explicit user_id filter; the target user is always the token's
// own app_users.id, never client-supplied). When channel_id + from + to are
// all present it additionally returns attributed_lead_ids: the exact
// channel-attributed cohort Listing Demand Evidence counts (see migration
// 20260918000000). Filtering/sorting/pagination happen client-side in the
// pure helpers under src/lib/leads.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const channelParam = sp.get('channel_id');
  const from = sp.get('from');
  const to = sp.get('to');

  let attribution: LeadAttributionRequest | null = null;
  if (channelParam !== null || from !== null || to !== null) {
    if (!channelParam || !/^\d{1,15}$/.test(channelParam) || !isValidDateParam(from) || !isValidDateParam(to)) {
      return NextResponse.json({ error: 'channel_id, from and to must all be valid when requesting an attributed cohort' }, { status: 400 });
    }
    if (from > to) {
      return NextResponse.json({ error: 'from must be on or before to' }, { status: 400 });
    }
    attribution = { channelId: Number(channelParam), from, to };
  }

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

  const { data: appUser } = await db.from('app_users').select('id').eq('auth_user_id', user.id).single();
  if (!appUser) {
    return NextResponse.json({ error: 'No app user found for this account' }, { status: 403 });
  }

  let serviceClient = null;
  if (attribution) {
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      console.error('[api/leads] SUPABASE_SERVICE_ROLE_KEY is not configured');
      return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
    }
    serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  try {
    const payload = await loadLeadsForUser({ db, serviceClient, appUserId: appUser.id as number, attribution });
    return NextResponse.json(payload);
  } catch (err) {
    if (err instanceof LeadsLoadError) {
      console.error('[api/leads] load failed:', err.message);
      return NextResponse.json({ error: 'Could not load leads' }, { status: 500 });
    }
    console.error('[api/leads] unexpected error:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'Unexpected server error' }, { status: 500 });
  }
}
