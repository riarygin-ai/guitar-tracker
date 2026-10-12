// Server-only. Lightweight structured diagnostics for the three /listings
// evidence endpoints (Listing Evidence, Listing Demand Evidence, Item
// Activity) — added while investigating intermittent
// "server returned 500" failures on /listings (2026-10). Deliberately NOT
// a monitoring framework: one small helper, called around each RPC call,
// that times the call and — on failure only — logs enough structured
// information to tell which endpoint, how long it ran before failing, and
// what KIND of failure it was (statement timeout, connection issue,
// PostgREST/SQL error, or an unexpected application exception), without
// ever logging raw lead/listing rows, notes, buyer information, secrets,
// or tokens. A SLOW success is also logged (a single line, above a fixed
// threshold) so a future "page felt slow but didn't technically error" can
// still be diagnosed from production logs.
//
// Never throws, never changes control flow — a logging failure here must
// never turn a successful (or already-failing) request into something
// worse.

export type ListingFailureCategory =
  | 'statement_timeout'
  | 'function_timeout'
  | 'connection_issue'
  | 'postgrest_error'
  | 'sql_error'
  | 'unexpected_exception';

interface SupabaseLikeError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

function isSupabaseLikeError(err: unknown): err is SupabaseLikeError {
  return typeof err === 'object' && err !== null && ('code' in err || 'message' in err);
}

// Postgres error code 57014 is "query_canceled" — by far the most common
// cause when a statement is cut off by statement_timeout. 08xxx is the
// "Connection Exception" class. PGRST-prefixed codes are PostgREST's own
// (schema cache, malformed RPC args, etc.), never a SQL/database failure.
export function classifyListingFailure(err: unknown): ListingFailureCategory {
  if (!isSupabaseLikeError(err)) return 'unexpected_exception';
  const code = (err.code ?? '').toUpperCase();
  const message = (err.message ?? '').toLowerCase();

  if (code === '57014' || message.includes('statement timeout') || message.includes('canceling statement')) return 'statement_timeout';
  if (message.includes('timed out') || message.includes('timeout')) return 'function_timeout';
  if (code.startsWith('08') || message.includes('connection') || message.includes('econnreset') || message.includes('fetch failed')) return 'connection_issue';
  if (code.startsWith('PGRST')) return 'postgrest_error';
  if (code) return 'sql_error';
  return 'unexpected_exception';
}

/** First 300 chars only — enough to identify the failure, never enough to carry a full row dump. */
function truncate(value: string | null | undefined, max = 300): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export interface ListingEndpointContext {
  /** Short, stable endpoint/function name, e.g. 'listing-evidence', 'listing-demand-evidence:build_listing_demand_evidence_v1_1'. */
  endpoint: string;
  appUserId: number;
  /** Request window/params relevant to the call — dates, trend_weeks — never free text. */
  params?: Record<string, string | number | boolean | null | undefined>;
}

/** A slower-than-usual successful call is still worth one log line in production (section 22/3). */
const SLOW_SUCCESS_THRESHOLD_MS = 3000;

export function logListingSuccess(ctx: ListingEndpointContext, durationMs: number): void {
  if (durationMs < SLOW_SUCCESS_THRESHOLD_MS) return;
  console.warn(`[listings:${ctx.endpoint}] slow (succeeded)`, JSON.stringify({
    endpoint: ctx.endpoint,
    appUserId: ctx.appUserId,
    durationMs: Math.round(durationMs),
    ...ctx.params,
  }));
}

export function logListingFailure(ctx: ListingEndpointContext, durationMs: number, err: unknown): ListingFailureCategory {
  const category = classifyListingFailure(err);
  const supabaseErr = isSupabaseLikeError(err) ? err : null;
  console.error(`[listings:${ctx.endpoint}] FAILED`, JSON.stringify({
    endpoint: ctx.endpoint,
    appUserId: ctx.appUserId,
    durationMs: Math.round(durationMs),
    category,
    dbErrorCode: supabaseErr?.code ?? null,
    dbErrorMessage: truncate(supabaseErr?.message),
    dbErrorHint: truncate(supabaseErr?.hint),
    ...ctx.params,
  }));
  return category;
}

/** Times `run`, logging a slow-success line or a structured failure line, then rethrows on failure (callers keep their own error handling/public-message mapping unchanged). */
export async function withListingDiagnostics<T>(ctx: ListingEndpointContext, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await run();
    logListingSuccess(ctx, Date.now() - startedAt);
    return result;
  } catch (err) {
    logListingFailure(ctx, Date.now() - startedAt, err);
    throw err;
  }
}
