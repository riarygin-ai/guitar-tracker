import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  getListingEvidenceForCurrentUser,
  ListingEvidenceError,
} from '@/lib/analytics/listingEvidence';
import {
  buildListingAnalysisPacket,
  ListingAnalysisPacketError,
  type ListingAnalysisPacketScopeType,
} from '@/lib/analytics/listingAnalysisPacket';

const SUPABASE_URL      = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VALID_SCOPES: ListingAnalysisPacketScopeType[] = ['all', 'channel', 'unlisted'];

// GET only — read-only deterministic export, same auth pattern as
// src/app/api/listing-evidence/route.ts. Query params: scope=all|channel|
// unlisted (required), channel_id=<number> (required when scope=channel).
// No user id is ever accepted from the client — the target user is always
// the token-authenticated caller's own resolved app_users.id.
export async function GET(req: NextRequest) {
  const scopeParam = req.nextUrl.searchParams.get('scope');
  if (!scopeParam || !VALID_SCOPES.includes(scopeParam as ListingAnalysisPacketScopeType)) {
    return NextResponse.json({ error: 'Invalid or missing scope. Expected one of: all, channel, unlisted.' }, { status: 400 });
  }
  const scope = scopeParam as ListingAnalysisPacketScopeType;

  let channelId: number | undefined;
  if (scope === 'channel') {
    const raw = req.nextUrl.searchParams.get('channel_id');
    const parsed = raw != null ? Number(raw) : NaN;
    if (!Number.isInteger(parsed)) {
      return NextResponse.json({ error: 'channel_id is required and must be an integer when scope=channel.' }, { status: 400 });
    }
    channelId = parsed;
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
    console.error('[api/listing-analysis-packet] SUPABASE_SERVICE_ROLE_KEY is not configured');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── Compute evidence, then build the packet — for the authenticated
  // user only ───────────────────────────────────────────────────────────────
  try {
    const evidence = await getListingEvidenceForCurrentUser({
      appUserId: appUser.id as number,
      serviceClient,
    });

    const packet = buildListingAnalysisPacket(evidence, { scope, channelId });

    return NextResponse.json({ target_user_listing_analysis_packet: packet });
  } catch (err) {
    if (err instanceof ListingEvidenceError) {
      return NextResponse.json({ error: err.publicMessage }, { status: err.status });
    }
    if (err instanceof ListingAnalysisPacketError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    console.error('[api/listing-analysis-packet] unexpected error:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'Unexpected server error' }, { status: 500 });
  }
}
