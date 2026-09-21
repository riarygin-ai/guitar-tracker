import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { dismissListingAdviceCard } from '@/lib/analytics/listingAdvice/listingAdviceDismissal';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// POST /api/listing-advice/dismiss  { listingAdviceRunId, adviceCode }
// Hides one Listing Advice card for 30 days (same policy/table as the general
// Coach's dismissal). Independent of generation. The client never supplies a
// user id or an advice key — see listingAdviceDismissal.ts.
export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const { listingAdviceRunId, adviceCode } = (body ?? {}) as { listingAdviceRunId?: unknown; adviceCode?: unknown };
  if (!Number.isInteger(listingAdviceRunId) || (listingAdviceRunId as number) <= 0) return NextResponse.json({ error: 'Invalid listingAdviceRunId' }, { status: 400 });
  if (typeof adviceCode !== 'string' || adviceCode.trim() === '') return NextResponse.json({ error: 'Invalid adviceCode' }, { status: 400 });

  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return NextResponse.json({ error: 'Missing authorization token' }, { status: 401 });

  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  const { data: { user }, error: authError } = await db.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data: appUser } = await db.from('app_users').select('id').eq('auth_user_id', user.id).single();
  if (!appUser) return NextResponse.json({ error: 'No app user found for this account' }, { status: 403 });

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[api/listing-advice/dismiss] SUPABASE_SERVICE_ROLE_KEY is not configured');
    return NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 });
  }
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const result = await dismissListingAdviceCard({ db, serviceClient, appUserId: appUser.id as number, listingAdviceRunId: listingAdviceRunId as number, adviceCode });
  if (result.status === 'not_found') return NextResponse.json({ error: 'Advice not found' }, { status: 404 });
  if (result.status === 'error') return NextResponse.json({ error: result.message }, { status: 500 });
  return NextResponse.json({ dismissed: true, advice_key: result.adviceKey, resurface_after: result.resurfaceAfter });
}
