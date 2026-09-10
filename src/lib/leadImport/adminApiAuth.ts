// Shared admin authorization for the /api/admin/lead-import/* routes.
//
// Extracted verbatim from the Phase 1 preview/users routes (same checks,
// same status codes, same messages) so Phase 2's import/history routes
// cannot drift from it.
//
// The pattern, mirroring /api/analytics/runs and /api/analytics/advice/
// dismiss: authenticate the caller with THEIR OWN bearer token, resolve
// app_users.id + admin server-side from that token (never a client-supplied
// flag), and only then hand back a service-role client for the cross-user
// reads/writes RLS deliberately cannot grant.

import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export interface AdminApiContext {
  // The authenticated admin's own app_users.id — the requester, never the
  // user an import writes leads for.
  appUserId: number;
  serviceClient: SupabaseClient;
}

export type AdminApiAuthResult =
  | { ok: true; ctx: AdminApiContext }
  | { ok: false; response: NextResponse };

export async function authorizeAdminApiRequest(req: NextRequest, routeTag: string): Promise<AdminApiAuthResult> {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return { ok: false, response: NextResponse.json({ error: 'Missing authorization token' }, { status: 401 }) };
  }

  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });

  const { data: { user }, error: authError } = await db.auth.getUser();
  if (authError || !user) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const { data: appUser } = await db
    .from('app_users')
    .select('id, admin')
    .eq('auth_user_id', user.id)
    .single();

  if (!appUser) {
    return { ok: false, response: NextResponse.json({ error: 'No app user found for this account' }, { status: 403 }) };
  }
  if (!appUser.admin) {
    return { ok: false, response: NextResponse.json({ error: 'Admin privileges required' }, { status: 403 }) };
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error(`[${routeTag}] SUPABASE_SERVICE_ROLE_KEY is not configured`);
    return { ok: false, response: NextResponse.json({ error: 'Server misconfiguration' }, { status: 500 }) };
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return { ok: true, ctx: { appUserId: appUser.id as number, serviceClient } };
}
