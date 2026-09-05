import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { runLeadImportPreview } from '@/lib/leadImport/preview';
import type { LeadImportSource } from '@/lib/leadImport/types';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Read-only GT Lead Log Preview (Phase 1). Never writes to item_leads.
//
// Admin-only: Preview must cross-reference inventory ownership for
// whichever user the selected source belongs to, which may not be the
// caller themselves — RLS alone (scoped to the caller's own rows) cannot
// do that, so this route authenticates the caller with their own bearer
// token first, independently verifies admin==true server-side (never
// trusts a client-supplied flag), and only then uses service_role for the
// actual cross-user reads. Mirrors the bearer-token -> resolve app_users.id
// -> service-role pattern used by /api/analytics/runs and
// /api/analytics/advice/dismiss.
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { sourceId } = (body ?? {}) as { sourceId?: unknown };
  if (!Number.isInteger(sourceId) || (sourceId as number) <= 0) {
    return NextResponse.json({ error: 'Invalid sourceId' }, { status: 400 });
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

  // ── Resolve app_users.id + admin flag ─────────────────────────────────
  const { data: appUser } = await db
    .from('app_users')
    .select('id, admin')
    .eq('auth_user_id', user.id)
    .single();

  if (!appUser) {
    return NextResponse.json({ error: 'No app user found for this account' }, { status: 403 });
  }
  if (!appUser.admin) {
    return NextResponse.json({ error: 'Admin privileges required' }, { status: 403 });
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[api/admin/lead-import/preview] SUPABASE_SERVICE_ROLE_KEY is not configured');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: source, error: sourceError } = await serviceClient
    .from('lead_import_sources')
    .select('*')
    .eq('id', sourceId as number)
    .maybeSingle();

  if (sourceError) {
    console.error('[api/admin/lead-import/preview] failed to load source:', sourceError.message);
    return NextResponse.json({ error: 'Failed to load source configuration' }, { status: 500 });
  }
  if (!source) {
    return NextResponse.json({ error: 'Source not found' }, { status: 404 });
  }

  try {
    const result = await runLeadImportPreview({ serviceClient, source: source as LeadImportSource });
    return NextResponse.json({ result });
  } catch (err) {
    console.error('[api/admin/lead-import/preview] unexpected error:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'Unexpected server error while running preview' }, { status: 500 });
  }
}
