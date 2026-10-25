import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiUser } from '@/lib/apiUserClient';
import { getItemLeadActivityForUser, ItemLeadActivityError } from '@/lib/analytics/itemLeadActivity';

// GET /api/lead-activity-by-item
//
// Read-only. /listings "Lead Activity by Item": every OPEN inventory item of
// the caller (listed or not) with at least one lead — lifetime lead /
// Negotiating+ / offer counts, lifetime Channel Days and Last Activity.
// Caller's own RLS-scoped client only (no service_role). Bounded by the
// caller's open inventory, so search / sort happen client-side.
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const auth = await authenticateApiUser(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const items = await getItemLeadActivityForUser(auth.db);
    return NextResponse.json({ items });
  } catch (e) {
    console.error('[api/lead-activity-by-item]', e instanceof ItemLeadActivityError ? e.message : e);
    return NextResponse.json({ error: 'Could not load lead activity by item' }, { status: 500 });
  }
}
