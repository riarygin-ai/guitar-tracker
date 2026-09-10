import { NextRequest, NextResponse } from 'next/server';
import { authorizeAdminApiRequest } from '@/lib/leadImport/adminApiAuth';
import type { LeadImportRun, LeadImportRunSummary } from '@/lib/leadImport/types';

const ROUTE_TAG = 'api/admin/lead-import/runs';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

// Recent import history for the admin page. Read-only.
//
// Service-role rather than RLS for the same reason Preview needs it: the
// admin is usually not the user whose leads a run imported, and
// lead_import_runs' own SELECT policy scopes an authenticated read to the
// caller's own rows (plus the admin bypass) — the source_name /
// display_name join below crosses users either way.
export async function GET(req: NextRequest) {
  const auth = await authorizeAdminApiRequest(req, ROUTE_TAG);
  if (!auth.ok) return auth.response;
  const { serviceClient } = auth.ctx;

  const sourceIdParam = req.nextUrl.searchParams.get('sourceId');
  const limitParam = Number(req.nextUrl.searchParams.get('limit'));
  const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : DEFAULT_LIMIT;

  let query = serviceClient
    .from('lead_import_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(limit);

  if (sourceIdParam !== null) {
    const sourceId = Number(sourceIdParam);
    if (!Number.isInteger(sourceId) || sourceId <= 0) {
      return NextResponse.json({ error: 'Invalid sourceId' }, { status: 400 });
    }
    query = query.eq('source_id', sourceId);
  }

  const { data: runs, error: runsError } = await query;
  if (runsError) {
    console.error(`[${ROUTE_TAG}] failed to load runs:`, runsError.message);
    return NextResponse.json({ error: 'Failed to load import history' }, { status: 500 });
  }

  const runRows = (runs ?? []) as LeadImportRun[];
  if (runRows.length === 0) return NextResponse.json({ runs: [] });

  // Decorate with the labels the history table shows. Two small lookups
  // rather than a PostgREST embed, so this route stays independent of the
  // FK-name-based join syntax.
  const sourceIds = Array.from(new Set(runRows.map((r) => r.source_id)));
  const userIds = Array.from(new Set(runRows.map((r) => r.user_id)));

  const [sourcesRes, usersRes] = await Promise.all([
    serviceClient.from('lead_import_sources').select('id, source_name').in('id', sourceIds),
    serviceClient.from('app_users').select('id, display_name').in('id', userIds),
  ]);

  const sourceNameById = new Map<number, string>(
    ((sourcesRes.data ?? []) as { id: number; source_name: string }[]).map((s) => [s.id, s.source_name]),
  );
  const displayNameById = new Map<number, string | null>(
    ((usersRes.data ?? []) as { id: number; display_name: string | null }[]).map((u) => [u.id, u.display_name]),
  );

  const summaries: LeadImportRunSummary[] = runRows.map((run) => ({
    ...run,
    source_name: sourceNameById.get(run.source_id) ?? `Source #${run.source_id}`,
    user_display_name: displayNameById.get(run.user_id) ?? null,
  }));

  return NextResponse.json({ runs: summaries });
}
