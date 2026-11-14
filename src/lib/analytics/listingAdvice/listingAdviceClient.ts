// Client-side wrappers for /api/listing-advice — same "get session -> Bearer
// fetch -> parse" shape as the other evidence clients: read the latest
// persisted advice, dismiss / resurface cards, and the listing-only
// "Refresh Advice" (the weekly Coach refresh generates it automatically).

import { supabase } from '@/lib/supabase';
import { normalizeAdviceLanguage, type AdviceLanguage } from '../advice/adviceLanguage';
import type { LatestListingAdvice } from './generateListingAdvice';
import type { WeeklyCoachStatusPayload } from '../coachState';

export type LatestListingAdviceResponse = LatestListingAdvice & { viewer_is_admin: boolean; dismissed_keys: string[];
  /** Active dismissals with their resurface instant. */
  dismissals: { advice_key: string; resurface_after: string }[];
  /** Viewer's CURRENT preferred_language — only a fallback for legacy runs with no stored language. */
  viewer_language: AdviceLanguage };

async function bearer(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

export async function fetchLatestListingAdvice(): Promise<LatestListingAdviceResponse> {
  const token = await bearer();
  if (!token) throw new Error('Not signed in — please sign in again.');
  const res = await fetch('/api/listing-advice', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Could not load Listing Advice (server returned ${res.status}).`);
  const payload = (await res.json()) as Partial<LatestListingAdviceResponse>;
  if (!payload || !('latest' in payload)) throw new Error('Listing Advice response had an unexpected shape.');
  return {
    latest: payload.latest ?? null,
    generating: !!payload.generating,
    last_failure: payload.last_failure ?? null,
    viewer_is_admin: !!payload.viewer_is_admin,
    viewer_language: normalizeAdviceLanguage(payload.viewer_language),
    dismissed_keys: Array.isArray(payload.dismissed_keys) ? payload.dismissed_keys : [],
    dismissals: Array.isArray(payload.dismissals) ? payload.dismissals : [],
  };
}

export async function dismissListingAdvice(listingAdviceRunId: number, adviceCode: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const token = await bearer();
  if (!token) return { ok: false, message: 'Not signed in — please sign in again.' };
  try {
    const res = await fetch('/api/listing-advice/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ listingAdviceRunId, adviceCode }),
    });
    if (res.ok) return { ok: true };
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, message: payload.error ?? `Could not dismiss (server returned ${res.status}).` };
  } catch {
    return { ok: false, message: 'Could not reach the server. Please try again.' };
  }
}

// ── Coach refresh / resurface / weekly status (shared by Dashboard + /listings) ──

export type RefreshOutcome =
  | { ok: true; unchanged: boolean }
  | { ok: false; reason: 'already_running' | 'failed' | 'network'; message?: string };

async function post(url: string, body?: unknown): Promise<Response | null> {
  const token = await bearer();
  if (!token) return null;
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    return null;
  }
}

/** Listing Advice only (/listings "Refresh Advice"). */
export async function refreshListingAdvice(): Promise<RefreshOutcome> {
  const res = await post('/api/listing-advice/refresh');
  if (!res) return { ok: false, reason: 'network' };
  const payload = (await res.json().catch(() => ({}))) as { code?: string };
  if (res.status === 409) return { ok: false, reason: 'already_running' };
  if (!res.ok) return { ok: false, reason: 'failed' };
  return { ok: true, unchanged: payload.code === 'UNCHANGED_INPUT' };
}

/** The full Coach refresh (General Coach + Listing Advice) — same orchestration as the weekly run. */
export async function refreshCoach(): Promise<RefreshOutcome> {
  const res = await post('/api/analytics/runs');
  if (!res) return { ok: false, reason: 'network' };
  const payload = (await res.json().catch(() => ({}))) as { code?: string };
  if (res.status === 409) return { ok: false, reason: 'already_running' };
  // A failed snapshot still refreshed Listing Advice; the caller reloads both modules either way.
  if (!res.ok) return { ok: false, reason: 'failed', message: payload.code };
  return { ok: true, unchanged: false };
}

/** Ends an active dismissal now (General or Listing card). */
export async function resurfaceAdvice(adviceKey: string): Promise<{ ok: boolean }> {
  const res = await post('/api/advice-dismissals/resurface', { adviceKey });
  return { ok: !!res && res.ok };
}

export async function fetchWeeklyCoachStatus(): Promise<WeeklyCoachStatusPayload | null> {
  const token = await bearer();
  if (!token) return null;
  try {
    const res = await fetch('/api/analytics/automation/status', { headers: { Authorization: `Bearer ${token}` } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
