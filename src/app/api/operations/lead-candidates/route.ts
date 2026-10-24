import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiUser } from '@/lib/apiUserClient';
import { loadOperationLeadCandidates, OperationLeadsError, OPERATION_LEAD_MAX_ITEMS, OPERATION_LEAD_SEARCH_LIMIT } from '@/lib/leads/operationLeads';

// GET /api/operations/lead-candidates?item_ids=1,2[&q=text][&limit=N][&deal_id=N]
//
// Read-only. Winning-lead candidates for a Sell / Trade operation: the
// caller's own eligible leads on the given OUTGOING items, ranked, searched
// and limited server-side (initial 6, search up to 12). eligible_total = 0
// tells the form to hide the Lead field. deal_id (edit flow) additionally
// returns the lead already linked to that operation.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const rawIds = (sp.get('item_ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (rawIds.length > OPERATION_LEAD_MAX_ITEMS || rawIds.some((s) => !/^\d{1,15}$/.test(s))) {
    return NextResponse.json({ error: `item_ids must be up to ${OPERATION_LEAD_MAX_ITEMS} comma-separated ids` }, { status: 400 });
  }
  const dealParam = sp.get('deal_id');
  if (dealParam !== null && !/^\d{1,15}$/.test(dealParam)) return NextResponse.json({ error: 'deal_id must be an id' }, { status: 400 });
  const limitParam = sp.get('limit');
  const limit = limitParam === null ? undefined : Number(limitParam);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > OPERATION_LEAD_SEARCH_LIMIT)) {
    return NextResponse.json({ error: `limit must be 1-${OPERATION_LEAD_SEARCH_LIMIT}` }, { status: 400 });
  }
  const q = (sp.get('q') ?? '').slice(0, 100);

  const auth = await authenticateApiUser(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const result = await loadOperationLeadCandidates(auth.db, auth.appUserId, {
      itemIds: rawIds.map(Number), q, limit, dealId: dealParam === null ? null : Number(dealParam),
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof OperationLeadsError) {
      console.error('[api/operations/lead-candidates]', e.message);
      return NextResponse.json({ error: 'Could not load leads' }, { status: 500 });
    }
    throw e;
  }
}
