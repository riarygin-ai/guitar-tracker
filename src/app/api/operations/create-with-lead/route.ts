import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiUser } from '@/lib/apiUserClient';
import { createOperationWithWinningLead, OperationLeadsError, type OperationKind, type OperationParams } from '@/lib/leads/operationLeads';

// POST /api/operations/create-with-lead
//   { kind: 'sale' | 'trade', operation: { ...create_sell_operation / create_trade_operation named args }, lead_id, operation_key }
//
// A NEW Sell / Trade whose winning lead was chosen: operation + DEAL_LINKED
// (→ COMPLETED) + neutral close of the other OPEN leads in one transaction
// (create_operation_with_winning_lead). Nothing is saved unless all of it is.
// Idempotent per operation_key. Without a chosen lead the forms keep calling
// the operation RPC directly.
export async function POST(req: NextRequest) {
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const { kind, operation, lead_id, operation_key } = (body ?? {}) as { kind?: unknown; operation?: unknown; lead_id?: unknown; operation_key?: unknown };
  if (kind !== 'sale' && kind !== 'trade') return NextResponse.json({ error: "kind must be 'sale' or 'trade'" }, { status: 400 });
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return NextResponse.json({ error: 'operation must be an object' }, { status: 400 });
  if (!Number.isInteger(lead_id) || (lead_id as number) <= 0) return NextResponse.json({ error: 'lead_id must be a positive integer' }, { status: 400 });
  if (typeof operation_key !== 'string') return NextResponse.json({ error: 'operation_key is required' }, { status: 400 });

  const auth = await authenticateApiUser(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const r = await createOperationWithWinningLead(auth.db, auth.appUserId, {
      kind: kind as OperationKind, operation: operation as OperationParams, leadId: lead_id as number, operationKey: operation_key,
    });
    if (r.ok) return NextResponse.json({ deal_id: r.deal_id, replayed: r.replayed });
    return NextResponse.json({ error: r.message, result: r.result ?? null }, { status: r.status });
  } catch (e) {
    console.error('[api/operations/create-with-lead]', e instanceof OperationLeadsError ? e.message : e);
    return NextResponse.json({ error: 'Could not save the operation (server error). Nothing was saved.' }, { status: 500 });
  }
}
