import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isCoachRefreshInFlight, runCoachRefresh } from '@/lib/analytics/coachRefresh';

const SUPABASE_URL      = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Manual Coach refresh: Dashboard "Refresh Coach" and Admin "Run Analytics".
// Snapshot + two model calls; Fluid compute budget like the weekly cron.
export const maxDuration = 300;

// Deliberately no request-body parsing: the normal flow accepts no client
// input at all, so there is no field a client could use to supply a
// requested_by_user_id or a recommendation target other than themselves.
export async function POST(req: NextRequest) {
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
    console.error('[api/analytics/runs] SUPABASE_SERVICE_ROLE_KEY is not configured');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── One refresh at a time per user (double-click / during the weekly run) ──
  if (await isCoachRefreshInFlight(serviceClient, appUser.id as number)) {
    return NextResponse.json({ error: 'A Coach refresh is already running. Try again in a minute.', code: 'ALREADY_RUNNING' }, { status: 409 });
  }

  // ── The SAME orchestration as the Weekly Coach Refresh (runCoachRefresh):
  // General Coach + Listing Advice, independent. A failed snapshot fails only
  // the General module — Listing Advice still runs and is reported. Never
  // throws; every module outcome is persisted in its own table. ───────────
  const { run, analyticsRunId, general, listings } = await runCoachRefresh({ appUserId: appUser.id as number, serviceClient });
  const stages = { analytics: { status: run ? 'completed' : general.status }, business_coach: general, listing_advice: listings };

  if (!run) {
    const status = general.code === 'ALREADY_RUNNING' ? 409 : 500;
    // ANALYTICS_RUN_FAILED / ALREADY_RUNNING carry AnalyticsRunError's public message; anything else stays generic.
    const error = general.code === 'ANALYTICS_RUN_FAILED' || general.code === 'ALREADY_RUNNING' ? general.message ?? 'Analytics run failed' : 'Unexpected server error';
    return NextResponse.json({ error, code: general.code, runId: analyticsRunId, stages }, { status });
  }
  return NextResponse.json({ run, stages });
}
