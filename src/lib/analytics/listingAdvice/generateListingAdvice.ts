// Listing Advice — server-only generation lifecycle + latest-advice lookup.
//
// generating (row inserted WITH the immutable packet + hash, before any model
// call) -> completed | failed. Owns the ONLY writes to listing_advice_runs
// (service_role). Never throws: every failure becomes a 'failed' row or a
// typed outcome, and a failure NEVER replaces the latest completed advice
// (latest = newest completed row; failed rows are just history).
//
// Concurrency: the DB allows at most one 'generating' row per user (partial
// unique index), so a double-click / second tab loses the insert and gets
// 'already_generating' — no duplicate model call. Rows left 'generating' by
// a crashed server are failed out after STALE_GENERATING_MS.
//
// Dependencies (context loader, model call) are injectable so the whole
// lifecycle can be tested against a real DB without a live model.

import type { SupabaseClient } from '@supabase/supabase-js';
import { LISTING_ADVICE_MODEL_ID, generateListingAdviceFromModel } from '../../openai';
import { sanitizeErrorMessage } from '../runAnalytics';
import { loadListingDemandContext, type ListingDemandContext } from '../advice/listingDemandContext';
import {
  LISTING_ADVICE_PROMPT_VERSION, LISTING_ADVICE_PROVIDER, LISTING_ADVICE_SCHEMA_VERSION,
  buildListingAdvicePacket, hashListingAdvicePacket, validateListingAdviceResponse,
  type ListingAdviceOutput, type ListingAdvicePacket,
} from './listingAdvice';

export const STALE_GENERATING_MS = 10 * 60 * 1000;

export interface ListingAdviceRunRow {
  id: number;
  user_id: number;
  status: 'generating' | 'completed' | 'failed';
  provider: string;
  model: string;
  schema_version: string;
  prompt_version: string;
  window_start: string;
  window_end: string;
  input_hash: string;
  input_packet: ListingAdvicePacket;
  output: ListingAdviceOutput | null;
  generated_at: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

const RUN_COLUMNS =
  'id, user_id, status, provider, model, schema_version, prompt_version, window_start, window_end, input_hash, input_packet, output, generated_at, error_code, error_message, created_at, updated_at';

export type GenerateListingAdviceOutcome =
  | { status: 'completed'; run: ListingAdviceRunRow }
  | { status: 'failed'; run: ListingAdviceRunRow }
  | { status: 'already_generating' }
  | { status: 'context_unavailable'; message: string }
  | { status: 'error'; message: string };

export interface GenerateListingAdviceDeps {
  loadContext?: (params: { appUserId: number; serviceClient: SupabaseClient }) => Promise<ListingDemandContext>;
  callModel?: (packet: ListingAdvicePacket) => Promise<{ raw: string; model: string }>;
  now?: () => Date;
}

async function markFailed(serviceClient: SupabaseClient, id: number, code: string, message: string): Promise<ListingAdviceRunRow | null> {
  const { data, error } = await serviceClient
    .from('listing_advice_runs')
    .update({ status: 'failed', error_code: code, error_message: message })
    .eq('id', id)
    .select(RUN_COLUMNS)
    .single();
  if (error || !data) {
    console.error('[generateListingAdvice] could not persist failed status for run', id, ':', sanitizeErrorMessage(error));
    return null;
  }
  return data as unknown as ListingAdviceRunRow;
}

export async function generateListingAdvice(params: {
  appUserId: number;
  serviceClient: SupabaseClient;
  deps?: GenerateListingAdviceDeps;
}): Promise<GenerateListingAdviceOutcome> {
  const { appUserId, serviceClient } = params;
  const loadContext = params.deps?.loadContext ?? ((p) => loadListingDemandContext(p));
  const callModel = params.deps?.callModel ?? ((packet: ListingAdvicePacket) => generateListingAdviceFromModel(packet));
  const now = params.deps?.now ?? (() => new Date());

  // 0. Fail out generations abandoned by a crashed server so they can't block this user forever.
  const staleBefore = new Date(now().getTime() - STALE_GENERATING_MS).toISOString();
  await serviceClient
    .from('listing_advice_runs')
    .update({ status: 'failed', error_code: 'STALE_GENERATING', error_message: 'Generation did not finish and was abandoned.' })
    .eq('user_id', appUserId)
    .eq('status', 'generating')
    .lt('created_at', staleBefore);

  // 1. Canonical evidence, live, server-side. Optional enrichment: failure = no attempt, nothing persisted.
  let ctx: ListingDemandContext;
  try {
    ctx = await loadContext({ appUserId, serviceClient });
  } catch (err) {
    console.error('[generateListingAdvice] listing demand context unavailable:', sanitizeErrorMessage(err));
    return { status: 'context_unavailable', message: 'Listing demand evidence is unavailable right now.' };
  }

  // 2. Deterministic packet + hash, persisted BEFORE the model call (immutable from here on).
  const packet = buildListingAdvicePacket(ctx);
  const inputHash = hashListingAdvicePacket(packet);

  const { data: inserted, error: insertError } = await serviceClient
    .from('listing_advice_runs')
    .insert({
      user_id: appUserId,
      status: 'generating',
      provider: LISTING_ADVICE_PROVIDER,
      model: LISTING_ADVICE_MODEL_ID,
      schema_version: LISTING_ADVICE_SCHEMA_VERSION,
      prompt_version: LISTING_ADVICE_PROMPT_VERSION,
      window_start: packet.window.start_date,
      window_end: packet.window.end_date,
      input_hash: inputHash,
      input_packet: packet,
    })
    .select('id')
    .single();

  if (insertError || !inserted) {
    if (insertError && (insertError as { code?: string }).code === '23505') return { status: 'already_generating' };
    console.error('[generateListingAdvice] could not create run:', sanitizeErrorMessage(insertError));
    return { status: 'error', message: 'Could not start Listing Advice generation.' };
  }
  const runId = inserted.id as number;

  // 3. Model call with that same packet.
  let raw: string;
  try {
    raw = (await callModel(packet)).raw;
  } catch (err) {
    const row = await markFailed(serviceClient, runId, 'OPENAI_ERROR', sanitizeErrorMessage(err));
    return row ? { status: 'failed', run: row } : { status: 'error', message: 'Generation failed.' };
  }

  // 4. Strict validation against the packet's closed source list.
  const validation = validateListingAdviceResponse(raw, packet.allowed_source_ids);
  if (!validation.valid || !validation.output) {
    const row = await markFailed(serviceClient, runId, 'INVALID_RESPONSE', `Response failed validation: ${validation.reasons.join(', ')}`);
    return row ? { status: 'failed', run: row } : { status: 'error', message: 'Generation failed.' };
  }

  // 5. Persist the exact validated output; the row is frozen from here on.
  const { data: completed, error: completeError } = await serviceClient
    .from('listing_advice_runs')
    .update({ status: 'completed', output: validation.output, generated_at: now().toISOString() })
    .eq('id', runId)
    .select(RUN_COLUMNS)
    .single();
  if (completeError || !completed) {
    const row = await markFailed(serviceClient, runId, 'FAILED_TO_PERSIST_COMPLETED_ADVICE', sanitizeErrorMessage(completeError));
    return row ? { status: 'failed', run: row } : { status: 'error', message: 'Generation failed.' };
  }
  return { status: 'completed', run: completed as unknown as ListingAdviceRunRow };
}

// ── Latest advice (read) ───────────────────────────────────────────────────

export interface LatestListingAdvice {
  /** Newest COMPLETED run (deterministic: generated_at DESC, id DESC) — never a failed/generating row. */
  latest: ListingAdviceRunRow | null;
  /** A generation is in flight right now. */
  generating: boolean;
  /** Most recent failed attempt NEWER than `latest` (or any failure when nothing completed yet); non-destructive local error. */
  last_failure: { error_code: string; error_message: string; created_at: string } | null;
}

/** Runs through the given client — pass the caller's own RLS client so only their rows are visible. */
export async function getLatestListingAdvice(client: SupabaseClient, userId: number): Promise<LatestListingAdvice> {
  const { data: latestRows, error } = await client
    .from('listing_advice_runs')
    .select(RUN_COLUMNS)
    .eq('user_id', userId)
    .eq('status', 'completed')
    .order('generated_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1);
  if (error) throw new Error(`listing_advice_runs: ${error.message}`);
  const latest = ((latestRows ?? [])[0] as unknown as ListingAdviceRunRow | undefined) ?? null;

  const { data: generatingRows } = await client
    .from('listing_advice_runs').select('id').eq('user_id', userId).eq('status', 'generating').limit(1);

  let failureQuery = client
    .from('listing_advice_runs')
    .select('error_code, error_message, created_at')
    .eq('user_id', userId)
    .eq('status', 'failed')
    .order('created_at', { ascending: false })
    .limit(1);
  if (latest?.generated_at) failureQuery = failureQuery.gt('created_at', latest.created_at);
  const { data: failedRows } = await failureQuery;
  const f = (failedRows ?? [])[0] as { error_code: string; error_message: string; created_at: string } | undefined;

  return { latest, generating: (generatingRows ?? []).length > 0, last_failure: f ?? null };
}
