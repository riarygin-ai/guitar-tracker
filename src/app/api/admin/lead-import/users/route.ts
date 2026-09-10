import { NextRequest, NextResponse } from 'next/server';
import { authorizeAdminApiRequest } from '@/lib/leadImport/adminApiAuth';

const ROUTE_TAG = 'api/admin/lead-import/users';

// Admin-only user picker for the Lead Log Import config UI. app_users' own
// RLS restricts SELECT to the caller's own row (see
// 20260608000000_multi_user_support.sql), so listing every Guitar Tracker
// user for the admin's source-configuration dropdown requires a
// service-role read, gated on the same bearer-token -> admin-flag check as
// every other /api/admin/lead-import route.
export async function GET(req: NextRequest) {
  const auth = await authorizeAdminApiRequest(req, ROUTE_TAG);
  if (!auth.ok) return auth.response;
  const { serviceClient } = auth.ctx;

  const { data: users, error: usersError } = await serviceClient
    .from('app_users')
    .select('id, email, display_name')
    .order('display_name', { ascending: true });

  if (usersError) {
    console.error(`[${ROUTE_TAG}] failed to load users:`, usersError.message);
    return NextResponse.json({ error: 'Failed to load users' }, { status: 500 });
  }

  return NextResponse.json({ users: users ?? [] });
}
