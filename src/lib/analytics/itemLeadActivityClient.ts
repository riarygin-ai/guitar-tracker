// Client-side fetch wrapper for GET /api/lead-activity-by-item — same
// "get session -> Bearer fetch -> validate" shape as the other evidence
// clients. One request for the whole section (never per item).

import { supabase } from '@/lib/supabase';
import type { ItemLeadActivityRow } from './itemLeadActivity';

export async function fetchItemLeadActivity(): Promise<{ status: 'success'; items: ItemLeadActivityRow[] } | { status: 'error'; message: string }> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return { status: 'error', message: 'Not signed in — please sign in again.' };
  let res: Response;
  try {
    res = await fetch('/api/lead-activity-by-item', { headers: { Authorization: `Bearer ${session.access_token}` } });
  } catch {
    return { status: 'error', message: 'Could not reach the server. Please try again.' };
  }
  if (!res.ok) return { status: 'error', message: `Could not load lead activity by item (server returned ${res.status}).` };
  const items = ((await res.json().catch(() => null)) as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return { status: 'error', message: 'Lead activity response had an unexpected shape.' };
  return { status: 'success', items: items as ItemLeadActivityRow[] };
}
