import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getLatestListingAdvice } from '@/lib/analytics/listingAdvice/generateListingAdvice';
import { normalizeAdviceLanguage } from '@/lib/analytics/advice/adviceLanguage';
import { getActiveListingDismissalKeys } from '@/lib/analytics/listingAdvice/listingAdviceDismissal';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

// GET /api/listing-advice -> the caller's latest COMPLETED Listing Advice (+ any newer
// failure, whether a generation is in flight, and their active dismissal keys). Read-only,
// through the caller's own RLS client: no model call and no generation of any kind.
//
// Listing Advice is generated ONLY by the Analytics workflow (Admin "Run Analytics" and the
// scheduled weekly run -> runAnalyticsWorkflow). There is deliberately no POST here: the
// generation service (generateListingAdvice) stays internal and is not exposed to /listings.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return NextResponse.json({ error: 'Missing authorization token' }, { status: 401 });

  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: authError } = await db.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: appUser } = await db.from('app_users').select('id, admin, preferred_language').eq('auth_user_id', user.id).single();
  if (!appUser) return NextResponse.json({ error: 'No app user found for this account' }, { status: 403 });

  try {
    const advice = await getLatestListingAdvice(db, appUser.id as number);
    const dismissedKeys = await getActiveListingDismissalKeys(db);
    return NextResponse.json({ ...advice, dismissed_keys: dismissedKeys, viewer_is_admin: appUser.admin === true, viewer_language: normalizeAdviceLanguage(appUser.preferred_language) });
  } catch (err) {
    console.error('[api/listing-advice] load failed:', err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'Could not load Listing Advice' }, { status: 500 });
  }
}
