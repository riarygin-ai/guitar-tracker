import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  getListingEvidenceForCurrentUser,
  ListingEvidenceError,
} from '@/lib/analytics/listingEvidence';

const SUPABASE_URL      = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// GET only — this is a read-only evidence export, not an operation. No
// request body, no query params accepted: the normal flow accepts no
// client input at all, so there is no field a client could use to request
// evidence for a user other than themselves. Mirrors the auth pattern in
// src/app/api/analytics/runs/route.ts exactly.
export async function GET(req: NextRequest) {
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
    console.error('[api/listing-evidence] SUPABASE_SERVICE_ROLE_KEY is not configured');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── Compute listing evidence for the authenticated user only ─────────────────
  try {
    const evidence = await getListingEvidenceForCurrentUser({
      appUserId: appUser.id as number,
      serviceClient,
    });

    return NextResponse.json({ target_user_listing_evidence: evidence });
  } catch (err) {
    if (err instanceof ListingEvidenceError) {
      return NextResponse.json({ error: err.publicMessage }, { status: err.status });
    }

    console.error('[api/listing-evidence] unexpected error:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'Unexpected server error' }, { status: 500 });
  }
}
