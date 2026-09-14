import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  getListingDemandEvidence,
  ListingDemandEvidenceError,
} from '@/lib/analytics/listingDemandEvidence';

const SUPABASE_URL      = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/listing-demand-evidence?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
//
// Read-only, deterministic Listing Demand Evidence v1.0 export — no DB
// mutation of any kind. Same auth pattern as /api/listing-evidence: the
// caller authenticates with their own bearer token, and the target user is
// always that token's own resolved app_users.id — never accepted from the
// client (kept intentionally own-user-only, exactly like Listing Evidence
// itself, which has no admin-target-user override either; see this
// task's final report for why an admin target-user parameter was
// deliberately NOT added in v1).
export async function GET(req: NextRequest) {
  const startDateParam = req.nextUrl.searchParams.get('start_date');
  const endDateParam = req.nextUrl.searchParams.get('end_date');

  if (!startDateParam || !DATE_ONLY_RE.test(startDateParam)) {
    return NextResponse.json({ error: 'start_date is required and must be YYYY-MM-DD' }, { status: 400 });
  }
  if (!endDateParam || !DATE_ONLY_RE.test(endDateParam)) {
    return NextResponse.json({ error: 'end_date is required and must be YYYY-MM-DD' }, { status: 400 });
  }
  if (startDateParam > endDateParam) {
    return NextResponse.json({ error: 'start_date must be on or before end_date' }, { status: 400 });
  }

  // ── Authenticate ─────────────────────────────────────────────────────────────
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

  // ── Resolve app_users.id ──────────────────────────────────────────────────────
  const { data: appUser } = await db
    .from('app_users')
    .select('id')
    .eq('auth_user_id', user.id)
    .single();

  if (!appUser) {
    return NextResponse.json({ error: 'No app user found for this account' }, { status: 403 });
  }

  // ── Construct the service-role client ────────────────────────────────────────
  // Never derived from anything client-supplied. Used only from this point on,
  // strictly server-side, and never returned to the caller.
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[api/listing-demand-evidence] SUPABASE_SERVICE_ROLE_KEY is not configured');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── Compute listing demand evidence for the authenticated user only ──────────
  try {
    const evidence = await getListingDemandEvidence({
      appUserId: appUser.id as number,
      serviceClient,
      startDate: startDateParam,
      endDate: endDateParam,
    });

    return NextResponse.json({ target_user_listing_demand_evidence: evidence });
  } catch (err) {
    if (err instanceof ListingDemandEvidenceError) {
      return NextResponse.json({ error: err.publicMessage }, { status: err.status });
    }

    console.error('[api/listing-demand-evidence] unexpected error:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'Unexpected server error' }, { status: 500 });
  }
}
