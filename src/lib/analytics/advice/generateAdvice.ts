// Auditable AI Advice v1.0 — generation orchestrator. Server-only. Owns the
// full pending -> generating -> completed|failed lifecycle for one
// analytics_run_advice revision. Never called from client components;
// callers are API routes (src/app/api/analytics/runs/...) that have
// already authenticated the caller and resolved their app_users.id.
//
// This module is the ONLY place that writes to analytics_run_advice. It
// NEVER writes to analytics_runs — the run it interprets is loaded fresh
// by id and never mutated, matching "the advice generator must load the
// saved snapshot by existing run ID... must never reconstruct historical
// advice from current live inventory data."

import type { SupabaseClient } from '@supabase/supabase-js';
import { generateAnalyticsAdvice, ADVICE_MODEL_ID } from '@/lib/openai';
import { sanitizeErrorMessage } from '@/lib/analytics/runAnalytics';
import { buildAdviceInputPacket } from './buildInputPacket';
import { hashCanonicalInputPacket } from './canonicalHash';
import { validateAdviceResponse } from './validateAdviceResponse';
import { ADVICE_PROVIDER, ADVICE_SCHEMA_VERSION, PROMPT_TEMPLATE_VERSION } from './types';
import type { AdviceStatus, AnalyticsRunAdviceRow } from './types';

export type GenerateAdviceOutcome =
  | { status: 'completed'; row: AnalyticsRunAdviceRow }
  | { status: 'failed'; row: AnalyticsRunAdviceRow }
  | { status: 'skipped'; reason: string };

export interface GenerateAdviceForRunParams {
  runId: number;
  /** The authenticated caller's own app_users.id — the ONLY user this
   *  function will ever generate or load advice on behalf of. */
  requestingUserId: number;
  serviceClient: SupabaseClient;
  /** 'auto' — the idempotent, at-most-once-per-run initial generation
   *  (fired right after a run completes). Silently skips (status:
   *  'skipped') if any revision already exists for this run, rather than
   *  creating a duplicate. 'retry' — an explicit user-triggered Retry/
   *  Regenerate: always creates revision_number + 1, regardless of how
   *  many revisions already exist. */
  mode: 'auto' | 'retry';
}

const ADVICE_ROW_COLUMNS =
  'id, analytics_run_id, user_id, revision_number, status, provider, model, advice_schema_version, prompt_template_version, canonical_input_hash, input_packet, advice, source_refs, generated_at, error_code, error_message, created_at, updated_at';

/** Row shape returned by the claim_next_analytics_run_advice_revision RPC —
 *  a subset of the full advice row (no input_packet/advice/source_refs/
 *  error fields, since a freshly claimed row never has them yet) plus the
 *  was_created flag that distinguishes "this call created a new pending
 *  row" from "auto mode found an existing revision and returned it
 *  unchanged". */
interface ClaimedAdviceRevision {
  id: number;
  analytics_run_id: number;
  user_id: number;
  revision_number: number;
  status: AdviceStatus;
  provider: string;
  model: string;
  advice_schema_version: string;
  prompt_template_version: string;
  created_at: string;
  updated_at: string;
  was_created: boolean;
}

async function markFailed(
  serviceClient: SupabaseClient,
  rowId: number,
  errorCode: string,
  errorMessage: string,
): Promise<AnalyticsRunAdviceRow> {
  const { data, error } = await serviceClient
    .from('analytics_run_advice')
    .update({ status: 'failed', error_code: errorCode, error_message: errorMessage })
    .eq('id', rowId)
    .select(ADVICE_ROW_COLUMNS)
    .single();

  if (error || !data) {
    // Extremely unlikely (the row was just inserted/updated by this same
    // process) — log and synthesize a minimal row so the caller always
    // gets a well-formed result rather than a throw.
    console.error('[generateAdvice] failed to persist failed status for advice row', rowId, ':', sanitizeErrorMessage(error));
  }
  return (data as unknown as AnalyticsRunAdviceRow) ?? {
    id: rowId,
    status: 'failed',
    error_code: errorCode,
    error_message: errorMessage,
  } as AnalyticsRunAdviceRow;
}

/**
 * Executes one advice generation attempt for an existing, completed
 * analytics_runs row. Never throws — every failure path is captured as a
 * 'failed' analytics_run_advice row (or a 'skipped' outcome for the
 * idempotent-auto-mode short-circuit) so a caller can safely await this
 * without a try/catch, exactly like runAnalyticsForCurrentUser's own
 * completed/failed contract but returned rather than thrown, since advice
 * failure must never propagate as an error the run-creation flow has to
 * handle.
 */
export async function generateAdviceForRun(params: GenerateAdviceForRunParams): Promise<GenerateAdviceOutcome> {
  const { runId, requestingUserId, serviceClient, mode } = params;

  // ── 1. Load the run fresh, by id — never trust a caller-supplied
  // snapshot, never substitute the newest run for the one requested. ────
  const { data: run, error: runError } = await serviceClient
    .from('analytics_runs')
    .select('id, status, snapshot, analytics_version, evidence_scope, recommendation_target_user_id')
    .eq('id', runId)
    .maybeSingle();

  if (runError || !run) {
    return { status: 'skipped', reason: 'RUN_NOT_FOUND' };
  }
  if (run.recommendation_target_user_id !== requestingUserId) {
    // Never generate or reveal advice for a run that isn't the caller's
    // own — mirrors analytics_runs' own RLS boundary at the application
    // layer for this server-side (RLS-bypassing service-role) path.
    return { status: 'skipped', reason: 'RUN_NOT_OWNED_BY_CALLER' };
  }
  if (run.status !== 'completed') {
    return { status: 'skipped', reason: 'RUN_NOT_COMPLETED' };
  }

  // ── 2. Atomically claim (or, for 'auto' mode when one already exists,
  // retrieve) the next revision via the DB-serialized RPC. Allocation and
  // the "skip when any revision already exists" check happen inside the
  // SAME transaction, under a pg_advisory_xact_lock keyed by runId — this
  // is the concurrency guard, not a client-side read-then-insert race.
  // The RPC re-validates run existence/ownership/completed-status itself
  // (defense in depth against a race between the step-1 fetch above and
  // this call), so its exceptions are mapped to the same outcome
  // vocabulary as step 1. ─────────────────────────────────────────────────
  const { data: claimedRows, error: claimError } = await serviceClient.rpc('claim_next_analytics_run_advice_revision', {
    p_analytics_run_id: runId,
    p_user_id: requestingUserId,
    p_mode: mode,
    p_provider: ADVICE_PROVIDER,
    p_model: ADVICE_MODEL_ID,
    p_advice_schema_version: ADVICE_SCHEMA_VERSION,
    p_prompt_template_version: PROMPT_TEMPLATE_VERSION,
  });

  if (claimError) {
    const message = sanitizeErrorMessage(claimError);
    if (message.includes('RUN_NOT_FOUND')) return { status: 'skipped', reason: 'RUN_NOT_FOUND' };
    if (message.includes('RUN_NOT_OWNED_BY_CALLER')) return { status: 'skipped', reason: 'RUN_NOT_OWNED_BY_CALLER' };
    if (message.includes('RUN_NOT_COMPLETED')) return { status: 'skipped', reason: 'RUN_NOT_COMPLETED' };
    console.error('[generateAdvice] revision claim RPC failed for run', runId, ':', message);
    return { status: 'skipped', reason: 'FAILED_TO_CREATE_ADVICE_ROW' };
  }

  const claimed = (claimedRows as ClaimedAdviceRevision[] | null)?.[0];
  if (!claimed) {
    console.error('[generateAdvice] revision claim RPC returned no row for run', runId);
    return { status: 'skipped', reason: 'FAILED_TO_CREATE_ADVICE_ROW' };
  }

  if (!claimed.was_created) {
    // 'auto' mode found an existing revision and returned it unchanged —
    // the idempotent no-duplicate-on-refresh/poll/retry-request guarantee.
    return { status: 'skipped', reason: 'ADVICE_ALREADY_EXISTS_FOR_RUN' };
  }

  const rowId = claimed.id;

  // ── 4. Build the deterministic packet from the SAVED snapshot only. ──
  const { packet, sourceRegistry, notes } = buildAdviceInputPacket({
    runId: run.id as number,
    analyticsVersion: run.analytics_version as string,
    evidenceScope: run.evidence_scope as string,
    snapshot: run.snapshot,
  });

  if (!packet) {
    const row = await markFailed(serviceClient, rowId, 'NO_VALID_EVIDENCE', `This run has no citable deterministic evidence: ${notes.join(', ')}`);
    return { status: 'failed', row };
  }

  // ── 5. Canonical hash from the EXACT persisted packet, then flip to
  // 'generating' — this single update is also the only place
  // canonical_input_hash and input_packet are ever set (both immutable
  // afterward, DB-trigger enforced). The packet built above is the same
  // object hashed here and persisted here: never rebuilt, never
  // reconstructed later. ────────────────────────────────────────────────
  const canonicalInputHash = hashCanonicalInputPacket(packet);
  const { error: generatingError } = await serviceClient
    .from('analytics_run_advice')
    .update({ status: 'generating', canonical_input_hash: canonicalInputHash, input_packet: packet })
    .eq('id', rowId);

  if (generatingError) {
    const row = await markFailed(serviceClient, rowId, 'FAILED_TO_TRANSITION_TO_GENERATING', sanitizeErrorMessage(generatingError));
    return { status: 'failed', row };
  }

  // ── 6. Call OpenAI with that same packet. ────────────────────────────
  let raw: string;
  try {
    const result = await generateAnalyticsAdvice(packet);
    raw = result.raw;
  } catch (openAiError) {
    const row = await markFailed(serviceClient, rowId, 'OPENAI_ERROR', sanitizeErrorMessage(openAiError));
    return { status: 'failed', row };
  }

  // `model` was already set at claim time and is immutable from here on —
  // generateAnalyticsAdvice() always uses ADVICE_MODEL_ID (no per-request
  // override exists), so there is nothing to reconcile.

  // ── 7. Validate the structured response + every source ID. ──────────
  const validation = validateAdviceResponse(raw, sourceRegistry);
  if (!validation.valid || !validation.response) {
    const row = await markFailed(serviceClient, rowId, 'INVALID_RESPONSE', `Response failed validation: ${validation.reasons.join(', ')}`);
    return { status: 'failed', row };
  }

  // ── 8. Persist the exact validated response. Completed rows are never
  // updated again after this. ──────────────────────────────────────────
  const { data: completed, error: completeError } = await serviceClient
    .from('analytics_run_advice')
    .update({
      status: 'completed',
      advice: validation.response,
      source_refs: sourceRegistry,
      generated_at: new Date().toISOString(),
    })
    .eq('id', rowId)
    .select(ADVICE_ROW_COLUMNS)
    .single();

  if (completeError || !completed) {
    const row = await markFailed(serviceClient, rowId, 'FAILED_TO_PERSIST_COMPLETED_ADVICE', sanitizeErrorMessage(completeError));
    return { status: 'failed', row };
  }

  return { status: 'completed', row: completed as unknown as AnalyticsRunAdviceRow };
}
