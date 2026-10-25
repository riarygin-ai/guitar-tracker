import { NextRequest, NextResponse } from 'next/server';
import { authenticateApiUser } from '@/lib/apiUserClient';
import { CONTACT_NAME_MAX, LeadContactEditError, renameLeadContact } from '@/lib/leads/leadContactEdit';

// POST /api/leads/:id/contact-name  { contact_name: string | null, expected_version, mutation_id, confirm? }
//
// The caller's own lead only (RLS client + explicit user filter + SECURITY
// DEFINER rename_lead_contact resolving identity from the token). Sets
// contact_name / contact_key / contact_name_source = USER_EDIT with an
// INTERNAL audit NOTE; stage, status, offers and counts are untouched.
// 200 RENAMED / NO_CHANGE; 409 CONFIRM_REQUIRED / BLOCKED / STALE; 404; 400.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^\d{1,15}$/.test(id)) return NextResponse.json({ error: 'Invalid lead id' }, { status: 400 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const { contact_name, expected_version, mutation_id, confirm } = (body ?? {}) as Record<string, unknown>;
  if (contact_name !== null && (typeof contact_name !== 'string' || contact_name.length > CONTACT_NAME_MAX * 2)) {
    return NextResponse.json({ error: 'contact_name must be a string or null' }, { status: 400 });
  }
  if (!Number.isInteger(expected_version)) return NextResponse.json({ error: 'expected_version is required' }, { status: 400 });
  if (typeof mutation_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mutation_id)) {
    return NextResponse.json({ error: 'mutation_id must be a UUID' }, { status: 400 });
  }

  const auth = await authenticateApiUser(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const r = await renameLeadContact(auth.db, auth.appUserId, {
      leadId: Number(id), contactName: contact_name as string | null, expectedVersion: expected_version as number, mutationId: mutation_id, confirm: confirm === true,
    });
    const status = r.result === 'RENAMED' || r.result === 'NO_CHANGE' ? 200 : r.result === 'NOT_FOUND' ? 404 : r.result === 'INVALID' ? 400 : 409;
    return NextResponse.json(r, { status });
  } catch (e) {
    console.error('[api/leads/contact-name]', e instanceof LeadContactEditError ? e.message : e);
    return NextResponse.json({ error: 'Could not save the name (server error).' }, { status: 500 });
  }
}
