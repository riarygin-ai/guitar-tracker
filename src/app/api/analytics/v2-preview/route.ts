import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL      = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Manual/testing inspection path for Analytics v2.1 (Open Inventory Decision
// Support v2.1) ONLY. Calls build_analytics_snapshot_v2_1 directly and
// returns it — nothing is persisted to analytics_runs, and this route is
// never called by the production "Run Analytics" flow (POST /api/analytics/
// runs, which still calls v1.8 via runAnalyticsForCurrentUser). Kept
// separate deliberately: production runs stay on v1.8 until the v2
// evidence modules are sufficiently complete.
export async function POST(req: NextRequest) {
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

  const { data: appUser } = await db
    .from('app_users')
    .select('id')
    .eq('auth_user_id', user.id)
    .single();

  if (!appUser) {
    return NextResponse.json({ error: 'No app user found for this account' }, { status: 403 });
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[api/analytics/v2-preview] SUPABASE_SERVICE_ROLE_KEY is not configured');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: snapshot, error } = await serviceClient.rpc('build_analytics_snapshot_v2_1', {
    p_target_user_id: appUser.id,
  });

  if (error) {
    console.error('[api/analytics/v2-preview] build_analytics_snapshot_v2_1 failed:', error.message);
    return NextResponse.json({ error: 'Could not build the v2.1 preview snapshot' }, { status: 500 });
  }

  return NextResponse.json({ snapshot });
}
