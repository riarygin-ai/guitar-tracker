import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiUser } from '@/lib/apiUserClient';
import { loadLeadEventsForUser, LeadsLoadError } from '@/lib/leads/leadsServer';

// GET /api/leads/:id/events — read-only. The caller's own lead only (RLS
// client + explicit user filter). Returns every stored event of that lead,
// oldest first; the drawer decides what is shown (leadEventHistory.ts).
// 200 { events } / 404 / 400.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^\d{1,15}$/.test(id)) return NextResponse.json({ error: 'Invalid lead id' }, { status: 400 });

  const auth = await authenticateApiUser(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const events = await loadLeadEventsForUser(auth.db, auth.appUserId, Number(id));
    if (!events) return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
    return NextResponse.json({ events });
  } catch (e) {
    console.error('[api/leads/events]', e instanceof LeadsLoadError ? e.message : e);
    return NextResponse.json({ error: 'Could not load lead history' }, { status: 500 });
  }
}
