import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getListingItemActivity, ListingItemActivityError } from '@/lib/analytics/listingItemActivity';
import { isValidDateParam } from '@/lib/leads/leadFilters';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_WINDOW_DAYS = 400;

// GET /api/listing-item-activity?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
//
// Read-only, compact per-item buyer activity for the caller's currently
// listed items over the given period (the /listings Trend Window — the
// page passes weekly_trend[0].start_date .. weekly_trend[last].end_date
// straight from Listing Demand Evidence). Same auth pattern as
// /api/listing-demand-evidence: bearer token -> the caller's OWN
// app_users.id, never client-supplied. All numbers come from the
// listing_demand_item_activity_v1_0 RPC (migration 20260919000000).
export async function GET(req: NextRequest) {
  const start = req.nextUrl.searchParams.get('start_date');
  const end = req.nextUrl.searchParams.get('end_date');
  if (!isValidDateParam(start)) return NextResponse.json({ error: 'start_date is required and must be YYYY-MM-DD' }, { status: 400 });
  if (!isValidDateParam(end)) return NextResponse.json({ error: 'end_date is required and must be YYYY-MM-DD' }, { status: 400 });
  if (start > end) return NextResponse.json({ error: 'start_date must be on or before end_date' }, { status: 400 });
  const spanDays = (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
  if (spanDays > MAX_WINDOW_DAYS) return NextResponse.json({ error: `window must be at most ${MAX_WINDOW_DAYS} days` }, { status: 400 });

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
    console.error('[api/listing-item-activity] SUPABASE_SERVICE_ROLE_KEY is not configured');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const items = await getListingItemActivity({ appUserId: appUser.id as number, serviceClient, startDate: start, endDate: end });
    return NextResponse.json({ start_date: start, end_date: end, items });
  } catch (err) {
    if (err instanceof ListingItemActivityError) {
      console.error('[api/listing-item-activity] load failed:', err.message);
      return NextResponse.json({ error: 'Could not load item activity' }, { status: 500 });
    }
    console.error('[api/listing-item-activity] unexpected error:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'Unexpected server error' }, { status: 500 });
  }
}
