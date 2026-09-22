import { NextRequest, NextResponse } from 'next/server';
import { authorizeAdminApiRequest } from '@/lib/leadImport/adminApiAuth';
import { isAdviceLanguage, normalizeAdviceLanguage } from '@/lib/analytics/advice/adviceLanguage';

const ROUTE_TAG = 'api/admin/users';

// Admin-only. GET lists every Guitar Tracker user with their preferred AI
// Advice language; PATCH changes one user's preferred_language. app_users' own
// RLS only exposes the caller's row, so cross-user access needs the service
// role — gated on the same bearer-token -> app_users.admin check as every
// other /api/admin route (authorizeAdminApiRequest). The language is validated
// here AND by the database CHECK constraint. Changing it never touches existing
// advice and never triggers generation — it applies on the NEXT analytics run.

export async function GET(req: NextRequest) {
  const auth = await authorizeAdminApiRequest(req, ROUTE_TAG);
  if (!auth.ok) return auth.response;

  const { data, error } = await auth.ctx.serviceClient
    .from('app_users')
    .select('id, email, display_name, preferred_language')
    .order('id', { ascending: true });

  if (error) {
    console.error(`[${ROUTE_TAG}] failed to load users:`, error.message);
    return NextResponse.json({ error: 'Failed to load users' }, { status: 500 });
  }

  const users = (data ?? []).map((u) => ({
    id: u.id as number,
    email: (u.email as string | null) ?? null,
    display_name: u.display_name as string,
    preferred_language: normalizeAdviceLanguage(u.preferred_language),
  }));
  return NextResponse.json({ users });
}

export async function PATCH(req: NextRequest) {
  const auth = await authorizeAdminApiRequest(req, ROUTE_TAG);
  if (!auth.ok) return auth.response;

  let body: { userId?: unknown; preferredLanguage?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const userId = body.userId;
  if (typeof userId !== 'number' || !Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: 'userId must be a positive integer' }, { status: 400 });
  }
  if (!isAdviceLanguage(body.preferredLanguage)) {
    return NextResponse.json({ error: 'Unsupported preferredLanguage' }, { status: 400 });
  }

  const { data, error } = await auth.ctx.serviceClient
    .from('app_users')
    .update({ preferred_language: body.preferredLanguage })
    .eq('id', userId)
    .select('id, preferred_language')
    .maybeSingle();

  if (error) {
    console.error(`[${ROUTE_TAG}] failed to update language:`, error.message);
    return NextResponse.json({ error: 'Failed to update language' }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  return NextResponse.json({ user: { id: data.id as number, preferred_language: normalizeAdviceLanguage(data.preferred_language) } });
}
