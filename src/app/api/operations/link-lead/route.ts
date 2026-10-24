import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiUser } from '@/lib/apiUserClient';
import { linkWinningLeadToDeal, OperationLeadsError } from '@/lib/leads/operationLeads';

// POST /api/operations/link-lead  { deal_id, lead_id }
//
// Links the winning lead to a just-saved Sell / Trade operation through the
// lead write layer (DEAL_LINKED → COMPLETED). Idempotent per (deal, lead):
// retrying after a failure replays instead of writing twice. Returns the
// lead layer's WriteResult; 200 only for APPLIED_* / NO_CHANGE.
export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const { deal_id, lead_id } = (body ?? {}) as { deal_id?: unknown; lead_id?: unknown };
  if (!Number.isInteger(deal_id) || (deal_id as number) <= 0 || !Number.isInteger(lead_id) || (lead_id as number) <= 0) {
    return NextResponse.json({ error: 'deal_id and lead_id must be positive integers' }, { status: 400 });
  }

  const auth = await authenticateApiUser(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const result = await linkWinningLeadToDeal(auth.db, auth.appUserId, { dealId: deal_id as number, leadId: lead_id as number });
    const ok = result.result === 'APPLIED_UPDATE' || result.result === 'APPLIED_CREATE' || result.result === 'NO_CHANGE';
    return NextResponse.json(result, { status: ok ? 200 : 409 });
  } catch (e) {
    console.error('[api/operations/link-lead]', e instanceof OperationLeadsError ? e.message : e);
    return NextResponse.json({ result: 'REJECTED', message: 'Could not link the lead (server error). The operation itself was saved.' }, { status: 500 });
  }
}
