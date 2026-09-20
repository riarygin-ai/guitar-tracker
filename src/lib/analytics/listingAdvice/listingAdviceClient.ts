// Client-side wrappers for /api/listing-advice — same "get session -> Bearer
// fetch -> parse" shape as the other evidence clients. The browser never
// calls the model; POST only asks the server to generate.

import { supabase } from '@/lib/supabase';
import type { LatestListingAdvice } from './generateListingAdvice';

export type LatestListingAdviceResponse = LatestListingAdvice & { viewer_is_admin: boolean };

async function bearer(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

export async function fetchLatestListingAdvice(): Promise<LatestListingAdviceResponse> {
  const token = await bearer();
  if (!token) throw new Error('Not signed in \u2014 please sign in again.');
  const res = await fetch('/api/listing-advice', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Could not load Listing Advice (server returned ${res.status}).`);
  const payload = (await res.json()) as Partial<LatestListingAdviceResponse>;
  if (!payload || !('latest' in payload)) throw new Error('Listing Advice response had an unexpected shape.');
  return { latest: payload.latest ?? null, generating: !!payload.generating, last_failure: payload.last_failure ?? null, viewer_is_admin: !!payload.viewer_is_admin };
}

export type GenerateListingAdviceResult =
  | { ok: true }
  | { ok: false; message: string; alreadyGenerating: boolean };

export async function requestListingAdviceGeneration(): Promise<GenerateListingAdviceResult> {
  const token = await bearer();
  if (!token) return { ok: false, message: 'Not signed in \u2014 please sign in again.', alreadyGenerating: false };
  let res: Response;
  try {
    res = await fetch('/api/listing-advice', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  } catch {
    return { ok: false, message: 'Could not reach the server. Please try again.', alreadyGenerating: false };
  }
  if (res.ok) return { ok: true };
  const payload = (await res.json().catch(() => ({}))) as { error?: string; status?: string };
  return { ok: false, message: payload.error ?? `Generation failed (server returned ${res.status}).`, alreadyGenerating: res.status === 409 };
}
