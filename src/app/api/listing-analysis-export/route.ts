import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  getListingEvidenceForCurrentUser,
  ListingEvidenceError,
} from '@/lib/analytics/listingEvidence';
import { buildAnalysisExportData } from '@/lib/analytics/listingAnalysisPacket';
import type { ItemListing, ItemListingPriceHistory } from '@/types';

const SUPABASE_URL      = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// GET only — read-only deterministic export: the complete Listing
// Analysis dataset ("Copy Analysis Data" / "Download Analysis Data" on
// the Listing Dashboard). Unlike /api/listing-analysis-packet, this route
// takes no scope — it always returns every currently-open inventory item
// (listed AND unlisted), each with its full item_listings history and,
// per listing cycle, its full item_listing_price_history. Same auth
// pattern as /api/listing-analysis-packet and /api/listing-evidence: the
// caller authenticates with their own bearer token, and the target user
// is always that token's own resolved app_users.id — never accepted from
// the client.
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
    console.error('[api/listing-analysis-export] SUPABASE_SERVICE_ROLE_KEY is not configured');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const targetUserId = appUser.id as number;

  try {
    const evidence = await getListingEvidenceForCurrentUser({
      appUserId: targetUserId,
      serviceClient,
    });

    // Two bulk, user-scoped reads (never a per-item/per-listing query) —
    // the join against `evidence`'s items happens in memory inside
    // buildAnalysisExportData below. Run in parallel since neither
    // depends on the other. user_id is always the server-resolved
    // target, matching this table's own RLS ownership model, even though
    // service_role bypasses RLS itself.
    const [listingsRes, priceHistoryRes] = await Promise.all([
      serviceClient.from('item_listings').select('*').eq('user_id', targetUserId),
      serviceClient.from('item_listing_price_history').select('*').eq('user_id', targetUserId),
    ]);

    if (listingsRes.error) {
      console.error('[api/listing-analysis-export] failed to load item_listings:', listingsRes.error.message);
      return NextResponse.json({ error: 'Failed to load listing history' }, { status: 500 });
    }
    if (priceHistoryRes.error) {
      console.error('[api/listing-analysis-export] failed to load item_listing_price_history:', priceHistoryRes.error.message);
      return NextResponse.json({ error: 'Failed to load price history' }, { status: 500 });
    }

    const data = buildAnalysisExportData({
      evidence,
      itemListings: (listingsRes.data ?? []) as ItemListing[],
      priceHistory: (priceHistoryRes.data ?? []) as ItemListingPriceHistory[],
    });

    return NextResponse.json({ target_user_analysis_export: data });
  } catch (err) {
    if (err instanceof ListingEvidenceError) {
      return NextResponse.json({ error: err.publicMessage }, { status: err.status });
    }

    console.error('[api/listing-analysis-export] unexpected error:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'Unexpected server error' }, { status: 500 });
  }
}
