import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { generateAdviceForRun } from '@/lib/analytics/advice/generateAdvice';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Generate AI Advice / Retry — for an EXISTING analytics_runs row only.
// Every explicit, user-triggered click (whether this run has no advice
// yet, or a prior attempt failed) always requests a NEW revision — the
// idempotent "skip if a revision already exists" guard is exclusively for
// the automatic post-run-completion trigger (see POST /api/analytics/runs,
// which calls generateAdviceForRun with mode: 'auto'), never for this
// explicit endpoint.
//
// Deliberately no request body: the only input is the run id in the URL,
// and the caller can never supply their own target user — mirrors POST
// /api/analytics/runs' own "no client input" contract exactly.
export async function POST(req: NextRequest, context: { params: Promise<{ runId: string }> }) {
  const { runId: runIdParam } = await context.params;
  const runId = Number(runIdParam);
  if (!Number.isInteger(runId) || runId <= 0) {
    return NextResponse.json({ error: 'Invalid run id' }, { status: 400 });
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

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[api/analytics/runs/[runId]/advice] SUPABASE_SERVICE_ROLE_KEY is not configured');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── Generate — ownership is re-checked inside generateAdviceForRun
  // itself (never trusts that the run id in the URL belongs to this
  // caller just because the request was authenticated). ─────────────────
  const outcome = await generateAdviceForRun({
    runId,
    requestingUserId: appUser.id as number,
    serviceClient,
    mode: 'retry',
  });

  if (outcome.status === 'skipped') {
    if (outcome.reason === 'RUN_NOT_FOUND' || outcome.reason === 'RUN_NOT_OWNED_BY_CALLER') {
      // Same 404 for "doesn't exist" and "exists but isn't yours" — never
      // reveal whether a run id belongs to someone else.
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }
    if (outcome.reason === 'RUN_NOT_COMPLETED') {
      return NextResponse.json({ error: 'This run has not completed yet' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Advice generation could not be started', reason: outcome.reason }, { status: 409 });
  }

  return NextResponse.json({ advice: outcome.row }, { status: outcome.status === 'failed' ? 502 : 200 });
}
