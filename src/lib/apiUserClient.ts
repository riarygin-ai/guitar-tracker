// Server-only. Bearer token → the caller's OWN RLS-scoped Supabase client +
// app_users.id — the same steps /api/leads performs inline. Never service_role.

import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

export type ApiUser = { db: SupabaseClient; appUserId: number };

export async function authenticateApiUser(req: NextRequest): Promise<ApiUser | NextResponse> {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return NextResponse.json({ error: 'Missing authorization token' }, { status: 401 });

  const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: authError } = await db.auth.getUser();
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: appUser } = await db.from('app_users').select('id').eq('auth_user_id', user.id).single();
  if (!appUser) return NextResponse.json({ error: 'No app user found for this account' }, { status: 403 });
  return { db, appUserId: appUser.id as number };
}
