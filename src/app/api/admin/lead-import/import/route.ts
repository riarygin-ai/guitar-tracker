import { NextRequest, NextResponse } from 'next/server';
import { authorizeAdminApiRequest } from '@/lib/leadImport/adminApiAuth';
import { runLeadImport } from '@/lib/leadImport/importRun';
import type { LeadImportSource } from '@/lib/leadImport/types';

const ROUTE_TAG = 'api/admin/lead-import/import';

// Executes a real GT Lead Log import (Phase 2).
//
// ── THE BROWSER SENDS ONLY A SOURCE ID ────────────────────────────────────
// No lead payload, no counts, no Preview result, no user id, no timestamps.
// Everything is re-derived server-side: this route re-reads the whole
// sheet, re-normalizes, re-validates and re-classifies before applying
// anything (see src/lib/leadImport/importRun.ts). A Sheet that changed
// after the admin's Preview therefore imports whatever it actually says
// now, not what the browser last saw.
//
// Admin-only, on the same bearer-token -> admin-flag check as
// /api/admin/lead-import/preview; start_lead_import_run() independently
// re-verifies the requester's admin flag at the database layer too.
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
  const { appUserId, serviceClient } = auth.ctx;

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
    const result = await runLeadImport({
      serviceClient,
      source: source as LeadImportSource,
      requestedByUserId: appUserId,
    });

    if (!result.ok) {
      // The run never started and nothing was claimed or written. A
      // concurrent import of the same source is a 409, not a 500.
      const status = result.code === 'IMPORT_ALREADY_RUNNING' ? 409
        : result.code === 'SOURCE_NOT_FOUND' ? 404
        : result.code === 'REQUESTER_NOT_ADMIN' ? 403
        : result.code === 'SOURCE_DISABLED' ? 400
        : 500;
      return NextResponse.json({ error: result.message, code: result.code }, { status });
    }

    return NextResponse.json({ result: result.outcome });
  } catch (err) {
    console.error(`[${ROUTE_TAG}] unexpected error:`, err instanceof Error ? err.message : String(err));
    return NextResponse.json({ error: 'Unexpected server error while running the import' }, { status: 500 });
  }
}
