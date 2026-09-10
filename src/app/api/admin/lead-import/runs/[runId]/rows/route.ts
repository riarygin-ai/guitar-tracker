import { NextRequest, NextResponse } from 'next/server';
import { authorizeAdminApiRequest } from '@/lib/leadImport/adminApiAuth';

const ROUTE_TAG = 'api/admin/lead-import/runs/[runId]/rows';
const MAX_ROWS = 500;

// Per-row audit detail for one import run, for the history section's
// expandable view. Defaults to the rows an admin actually needs to look at
// (INVALID / SOURCE_OLDER / anything that failed or was not applied);
// ?filter=all returns every audited row up to the cap.
//
// lead_import_run_rows never contains sheet `notes` or a copy of the lead
// payload, so this route cannot leak either.
export async function GET(req: NextRequest, context: { params: Promise<{ runId: string }> }) {
  const { runId: runIdParam } = await context.params;
  const runId = Number(runIdParam);
  if (!Number.isInteger(runId) || runId <= 0) {
    return NextResponse.json({ error: 'Invalid runId' }, { status: 400 });
  }

  const auth = await authorizeAdminApiRequest(req, ROUTE_TAG);
  if (!auth.ok) return auth.response;
  const { serviceClient } = auth.ctx;

  const filter = req.nextUrl.searchParams.get('filter') === 'all' ? 'all' : 'issues';

  let query = serviceClient
    .from('lead_import_run_rows')
    .select('*')
    .eq('import_run_id', runId)
    .order('sheet_row_number', { ascending: true })
    .limit(MAX_ROWS);

  if (filter === 'issues') {
    query = query.or(
      'classification.in.(INVALID,SOURCE_OLDER),result.in.(FAILED,SKIPPED_NOT_APPLIED)',
    );
  }

  const { data, error } = await query;
  if (error) {
    console.error(`[${ROUTE_TAG}] failed to load run rows:`, error.message);
    return NextResponse.json({ error: 'Failed to load run detail' }, { status: 500 });
  }

  return NextResponse.json({ rows: data ?? [], filter, truncatedAt: MAX_ROWS });
}
