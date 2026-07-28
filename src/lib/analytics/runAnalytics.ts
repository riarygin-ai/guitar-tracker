// Server-only module. Never import this in client components. Constructs
// no Supabase client of its own — the caller (the API route) supplies an
// already-authenticated caller's resolved app_users.id and a service-role
// client. This module never accepts a target user ID from anywhere other
// than that resolved app_users.id: requested_by_user_id and
// recommendation_target_user_id are ALWAYS the same value, the caller's
// own app user ID. See analytics/SEMANTIC_CONTRACT.md sections 9-13 for
// the evidence/recommendation/developer-scope boundary this enforces, and
// analytics/README.md for the runner's place in the Phase 2 autorunner
// plan (this is Phase 2 Step 3 — server-side execution + persistence
// only; no frontend trigger, no scheduled execution, no AI analysis).

import type { SupabaseClient } from '@supabase/supabase-js';

// ── Constants — must match the current snapshot contract exactly ───────────
// (analytics_runs' own DEFAULTs and build_analytics_snapshot_v1_2's own
// literals — see supabase/migrations/20260727000000_analytics_runs.sql and
// 20260801000000_build_analytics_snapshot_v1_2.sql). Bumping either requires
// updating both this file and the database migrations together — see the
// "duplicated logic" note in analytics/README.md.
//
// v1.2: new runs call build_analytics_snapshot_v1_2 (Channel Analytics
// module 1 — Deal In Channel Performance — see
// analytics/SEMANTIC_CONTRACT.md). v1.0/v1.1's builder functions and every
// previously stored v1.0/v1.1 analytics_runs.snapshot row are untouched and
// remain readable — this is a forward version bump, not a rewrite of
// history.
export const ANALYTICS_VERSION = '1.2';
export const EVIDENCE_SCOPE = 'shared_business_population';
const SNAPSHOT_SCHEMA_VERSION = '1.2';
const ANALYTICS_DEFINITION_VERSION = '1.2';
const SNAPSHOT_BUILDER_RPC = 'build_analytics_snapshot_v1_2';

// ── Types ────────────────────────────────────────────────────────────────

export type AnalyticsRunStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface AnalyticsRun {
  id: number;
  status: AnalyticsRunStatus;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  analytics_version: string;
  evidence_scope: string;
  snapshot: unknown | null;
}

const RUN_SELECT_COLUMNS =
  'id, status, created_at, started_at, completed_at, duration_ms, analytics_version, evidence_scope, snapshot';

/**
 * Thrown by runAnalyticsForCurrentUser. `publicMessage` and `status` are
 * safe to return to the browser as-is (no credentials, tokens, connection
 * strings, SQL, or stack traces — see sanitizeErrorMessage). `runId`, when
 * present, identifies the analytics_runs row that was marked 'failed', if
 * one exists.
 */
export class AnalyticsRunError extends Error {
  readonly status: number;
  readonly publicMessage: string;
  readonly runId?: number;

  constructor(publicMessage: string, status: number, runId?: number) {
    super(publicMessage);
    this.name = 'AnalyticsRunError';
    this.publicMessage = publicMessage;
    this.status = status;
    this.runId = runId;
  }
}

// ── Snapshot metadata validation ────────────────────────────────────────
// Type guard, not an unsafe cast. Only checks the top-level contract fields
// documented in analytics/README.md — does not validate the shape of
// evidence_aggregates/recommendation_candidates in detail (that full
// TypeScript schema is a later step, per this task's own scope).

interface ValidatedAnalyticsSnapshot {
  snapshot_schema_version: string;
  analytics_definition_version: string;
  generated_at: string;
  evidence_scope: string;
  recommendation_target_user_id: number;
  evidence_aggregates: Record<string, unknown>;
  recommendation_candidates: Record<string, unknown>;
}

export function isValidAnalyticsSnapshot(
  value: unknown,
  expectedTargetUserId: number,
): value is ValidatedAnalyticsSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;

  return (
    v.snapshot_schema_version === SNAPSHOT_SCHEMA_VERSION &&
    v.analytics_definition_version === ANALYTICS_DEFINITION_VERSION &&
    v.evidence_scope === EVIDENCE_SCOPE &&
    v.recommendation_target_user_id === expectedTargetUserId &&
    typeof v.evidence_aggregates === 'object' && v.evidence_aggregates !== null &&
    typeof v.recommendation_candidates === 'object' && v.recommendation_candidates !== null
  );
}

// ── Error sanitization ───────────────────────────────────────────────────
// Keeps a short, operationally useful description while stripping anything
// that could leak credentials, tokens, connection strings, full SQL, or a
// stack trace. Applied to every error_message persisted to analytics_runs
// and to every message returned to the browser.

const MAX_SANITIZED_MESSAGE_LENGTH = 500;

export function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  // First line only — drops any stack trace that got appended to the message.
  let message = raw.split('\n')[0]?.trim() || 'Unknown error';

  // Redact anything JWT-shaped (three base64url segments separated by dots).
  message = message.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[redacted-token]');

  // Redact Postgres/Supabase connection strings.
  message = message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-connection-string]');

  // Redact anything that looks like a bearer/authorization value.
  message = message.replace(/bearer\s+\S+/gi, 'bearer [redacted]');

  if (message.length > MAX_SANITIZED_MESSAGE_LENGTH) {
    message = message.slice(0, MAX_SANITIZED_MESSAGE_LENGTH) + '…';
  }

  return message;
}

// ── Runner ───────────────────────────────────────────────────────────────

export interface RunAnalyticsParams {
  /** public.app_users.id of the authenticated caller — already resolved by
   *  the route handler via the normal authenticated client. This is the
   *  ONLY user ID this function ever uses, for both requested_by_user_id
   *  and recommendation_target_user_id. There is no parameter to override
   *  the recommendation target with a different user. */
  appUserId: number;
  /** Service-role client. Required because analytics_runs denies
   *  authenticated-client writes and build_analytics_snapshot_v1 is
   *  service_role-only by design (see the migrations this module wraps). */
  serviceClient: SupabaseClient;
}

/**
 * Executes one analytics run for the given app user and persists its
 * result in analytics_runs, following the pending -> running ->
 * completed/failed lifecycle exactly as the database CHECK constraints
 * require (see 20260727000000_analytics_runs.sql).
 *
 * requested_by_user_id and recommendation_target_user_id are ALWAYS
 * appUserId — there is no code path that accepts a different target.
 *
 * Concurrency note: this function does not lock, queue, deduplicate, or
 * cancel runs. Calling it twice for the same user creates two independent
 * rows that both run to completion (or failure) independently. See
 * analytics/README.md for this documented, deliberate limitation.
 *
 * Throws AnalyticsRunError on any failure that should be reported to the
 * caller (HTTP layer maps `.status`/`.publicMessage` to the response).
 */
export async function runAnalyticsForCurrentUser(
  params: RunAnalyticsParams,
): Promise<AnalyticsRun> {
  const { appUserId, serviceClient } = params;

  // ── 1. Insert pending row ────────────────────────────────────────────
  const { data: inserted, error: insertError } = await serviceClient
    .from('analytics_runs')
    .insert({
      requested_by_user_id: appUserId,
      recommendation_target_user_id: appUserId,
      analytics_version: ANALYTICS_VERSION,
      evidence_scope: EVIDENCE_SCOPE,
      status: 'pending',
    })
    .select('id')
    .single();

  if (insertError || !inserted) {
    console.error('[runAnalytics] failed to insert pending run:', sanitizeErrorMessage(insertError));
    throw new AnalyticsRunError('Failed to create analytics run', 500);
  }

  const runId = inserted.id as number;

  // ── 2. Transition to running ─────────────────────────────────────────
  const { error: runningError } = await serviceClient
    .from('analytics_runs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', runId);

  if (runningError) {
    console.error('[runAnalytics] failed to transition run', runId, 'to running:', sanitizeErrorMessage(runningError));
    throw new AnalyticsRunError('Failed to start analytics run', 500, runId);
  }

  // Monotonic clock — not affected by system clock adjustments, available
  // globally in the Node.js runtime this route handler runs under.
  const startMark = performance.now();

  try {
    // ── 3. Call the snapshot builder ────────────────────────────────────
    const { data: snapshot, error: builderError } = await serviceClient.rpc(
      SNAPSHOT_BUILDER_RPC,
      { p_recommendation_target_user_id: appUserId },
    );

    if (builderError) {
      throw new Error(`Snapshot builder error: ${builderError.message}`);
    }

    // ── 4. Validate returned snapshot metadata before persisting ────────
    if (!isValidAnalyticsSnapshot(snapshot, appUserId)) {
      throw new Error('Snapshot builder returned unexpected or inconsistent metadata');
    }

    const durationMs = Math.max(0, Math.round(performance.now() - startMark));

    // ── 5. Persist completed run ─────────────────────────────────────────
    const { data: completedRun, error: completeError } = await serviceClient
      .from('analytics_runs')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        duration_ms: durationMs,
        snapshot,
        error_message: null,
      })
      .eq('id', runId)
      .select(RUN_SELECT_COLUMNS)
      .single();

    if (completeError || !completedRun) {
      console.error('[runAnalytics] failed to persist completed run', runId, ':', sanitizeErrorMessage(completeError));
      throw new AnalyticsRunError('Analytics run completed but could not be saved', 500, runId);
    }

    return completedRun as unknown as AnalyticsRun;
  } catch (executionError) {
    // AnalyticsRunError thrown by the completion-persist step above should
    // propagate as-is — it already represents a terminal condition and its
    // own message is already safe to surface.
    if (executionError instanceof AnalyticsRunError) {
      throw executionError;
    }

    const durationMs = Math.max(0, Math.round(performance.now() - startMark));
    const sanitizedMessage = sanitizeErrorMessage(executionError);

    // ── 6. Persist failed run ─────────────────────────────────────────
    const { error: failError } = await serviceClient
      .from('analytics_runs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        duration_ms: durationMs,
        error_message: sanitizedMessage,
      })
      .eq('id', runId);

    if (failError) {
      // The run row is now stuck in 'running' — log both failures
      // distinctly so an operator can find and fix it manually. Never
      // expose either failure's raw detail to the caller.
      console.error('[runAnalytics] execution failed for run', runId, ':', sanitizedMessage);
      console.error('[runAnalytics] failed to persist failed status for run', runId, ':', sanitizeErrorMessage(failError));
      throw new AnalyticsRunError('Analytics run failed and could not be recorded', 500, runId);
    }

    console.error('[runAnalytics] execution failed for run', runId, ', recorded as failed:', sanitizedMessage);
    throw new AnalyticsRunError('Analytics run failed', 500, runId);
  }
}
