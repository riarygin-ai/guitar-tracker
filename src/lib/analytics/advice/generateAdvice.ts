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
import type { AnalyticsRunAdviceRow } from './types';

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
  'id, analytics_run_id, user_id, revision_number, status, provider, model, advice_schema_version, prompt_template_version, canonical_input_hash, advice, source_refs, generated_at, error_code, error_message, created_at, updated_at';

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

  // ── 2. Determine the next revision number ──────────────────────────
  const { data: existingRevisions } = await serviceClient
    .from('analytics_run_advice')
    .select('revision_number')
    .eq('analytics_run_id', runId)
    .order('revision_number', { ascending: false })
    .limit(1);

  const highestRevision = existingRevisions && existingRevisions.length > 0 ? (existingRevisions[0].revision_number as number) : 0;

  if (mode === 'auto' && highestRevision > 0) {
    // Idempotent: initial automatic generation only ever happens once per
    // run — a browser refresh, rerender, repeated poll, or duplicate
    // server request must never create a second revision on its own.
    return { status: 'skipped', reason: 'ADVICE_ALREADY_EXISTS_FOR_RUN' };
  }

  const nextRevision = highestRevision + 1;

  // ── 3. Insert the pending row. The UNIQUE(analytics_run_id,
  // revision_number) constraint is the real concurrency guard: if two
  // requests race for the same revision_number, only one INSERT can
  // succeed. ────────────────────────────────────────────────────────────
  const { data: inserted, error: insertError } = await serviceClient
    .from('analytics_run_advice')
    .insert({
      analytics_run_id: runId,
      user_id: requestingUserId,
      revision_number: nextRevision,
      status: 'pending',
      provider: ADVICE_PROVIDER,
      // The model this attempt is expected to use — reconciled with
      // whatever generateAnalyticsAdvice() actually reports below (today
      // always the same value; kept as a real reconciliation step, not an
      // assumption, in case a future per-request override is added).
      model: ADVICE_MODEL_ID,
      advice_schema_version: ADVICE_SCHEMA_VERSION,
      prompt_template_version: PROMPT_TEMPLATE_VERSION,
    })
    .select(ADVICE_ROW_COLUMNS)
    .single();

  if (insertError || !inserted) {
    // Unique-violation (23505) means another concurrent request already
    // claimed this revision — exactly the idempotency guarantee this
    // function exists to provide, not a real error.
    if ((insertError as { code?: string } | null)?.code === '23505') {
      return { status: 'skipped', reason: 'CONCURRENT_GENERATION_ALREADY_IN_PROGRESS' };
    }
    console.error('[generateAdvice] failed to insert pending advice row for run', runId, ':', sanitizeErrorMessage(insertError));
    return { status: 'skipped', reason: 'FAILED_TO_CREATE_ADVICE_ROW' };
  }

  const rowId = inserted.id as number;

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

  // ── 5. Canonical hash, then flip to 'generating'. ────────────────────
  const canonicalInputHash = hashCanonicalInputPacket(packet);
  const { error: generatingError } = await serviceClient
    .from('analytics_run_advice')
    .update({ status: 'generating', canonical_input_hash: canonicalInputHash })
    .eq('id', rowId);

  if (generatingError) {
    const row = await markFailed(serviceClient, rowId, 'FAILED_TO_TRANSITION_TO_GENERATING', sanitizeErrorMessage(generatingError));
    return { status: 'failed', row };
  }

  // ── 6. Call OpenAI. ───────────────────────────────────────────────────
  let raw: string;
  let resolvedModel: string;
  try {
    const result = await generateAnalyticsAdvice(packet);
    raw = result.raw;
    resolvedModel = result.model;
  } catch (openAiError) {
    const row = await markFailed(serviceClient, rowId, 'OPENAI_ERROR', sanitizeErrorMessage(openAiError));
    return { status: 'failed', row };
  }

  // Record the actual model used even on a later validation failure, so
  // diagnostics always show what was attempted.
  await serviceClient.from('analytics_run_advice').update({ model: resolvedModel }).eq('id', rowId);

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
