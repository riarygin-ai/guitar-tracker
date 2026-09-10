import { NextRequest, NextResponse } from 'next/server';
import { authorizeAdminApiRequest } from '@/lib/leadImport/adminApiAuth';
import { runLeadImportPreview } from '@/lib/leadImport/preview';
import type { LeadImportSource } from '@/lib/leadImport/types';

const ROUTE_TAG = 'api/admin/lead-import/preview';

// Read-only GT Lead Log Preview. Never writes to item_leads.
//
// Admin-only: Preview must cross-reference inventory ownership for
// whichever user the selected source belongs to, which may not be the
// caller themselves — RLS alone (scoped to the caller's own rows) cannot
// do that, so authorizeAdminApiRequest() authenticates the caller with
// their own bearer token first, independently verifies admin==true
// server-side (never trusts a client-supplied flag), and only then hands
// back service_role for the actual cross-user reads. Mirrors the
// bearer-token -> resolve app_users.id -> service-role pattern used by
// /api/analytics/runs and /api/analytics/advice/dismiss.
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { sourceId } = (body ?? {}) as { sourceId?: unknown };
  if (!Number.isInteger(sourceId) || (sourceId as number) <= 0) {
    return NextResponse.json({ error: 'Invalid sourceId' }, { status: 400 });
  }

  const auth = await authorizeAdminApiRequest(req, ROUTE_TAG);
  if (!auth.ok) return auth.response;
  const { serviceClient } = auth.ctx;

  const { data: source, error: sourceError } = await serviceClient
    .from('lead_import_sources')
    .select('*')
    .eq('id', sourceId as number)
    .maybeSingle();

  if (sourceError) {
    console.error(`[${ROUTE_TAG}] failed to load source:`, sourceError.message);
    return NextResponse.json({ error: 'Failed to load source configuration' }, { status: 500 });
  }
  if (!source) {
    return NextResponse.json({ error: 'Source not found' }, { status: 404 });
  }

  try {
    const result = await runLeadImportPreview({ serviceClient, source: source as LeadImportSource });
    return NextResponse.json({ result });
  } catch (err) {
    console.error(`[${ROUTE_TAG}] unexpected error:`, err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'Unexpected server error while running preview' }, { status: 500 });
  }
}
