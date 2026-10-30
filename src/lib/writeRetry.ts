// Bounded retry for IDEMPOTENT database mutations (RPC writes keyed by a
// mutation id the database replays). Transient infrastructure failures only;
// a business outcome is never retried here — the helper does not even look at
// `data`, only at a transport/database `error`.
//
// Why it is needed: postgrest-js retries GET/HEAD by itself, never an RPC
// (POST). A write whose response is lost (timeout, reset) may already be
// committed; re-sending the SAME request makes the database return the saved
// result (REPLAY) instead of writing twice. So every attempt re-sends the
// exact same request — the caller passes one closure over one request object,
// never a fresh mutation id.
//
// Classification is explicit (classifyWriteError). Unknown errors are NOT
// retryable.

export const WRITE_RETRY_MAX_ATTEMPTS = 3;
/** Attempt 2 waits ~75-150 ms, attempt 3 ~225-450 ms: under a second in total. */
export const WRITE_RETRY_BASE_DELAY_MS = 150;

export type TransientReason =
  | 'NETWORK'          // no HTTP response: connection reset/refused, socket closed, fetch failed
  | 'TIMEOUT'          // connect / headers / body timeout before a response
  | 'GATEWAY'          // 502 / 503 / 504 / 520-524 from the gateway in front of PostgREST
  | 'POOL'             // PostgREST could not reach / get a connection from Postgres (PGRST000-003)
  | 'CONNECTION'       // SQLSTATE class 08, 57P01-57P03 (connection lost, shutdown, cannot connect now)
  | 'RESOURCES'        // 53300 too_many_connections
  | 'DEADLOCK'         // 40P01 — transaction rolled back
  | 'SERIALIZATION';   // 40001 — transaction rolled back

export type WriteErrorClass =
  | { retryable: true; reason: TransientReason; code: string | null }
  | { retryable: false; reason: string; code: string | null };

/** Error shape surfaced by supabase-js (PostgrestError) plus anything thrown. */
export interface DbErrorLike {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
  name?: string;
  cause?: unknown;
}

const SQLSTATE_TRANSIENT: Record<string, TransientReason> = {
  '40001': 'SERIALIZATION',
  '40P01': 'DEADLOCK',
  '08000': 'CONNECTION', '08001': 'CONNECTION', '08003': 'CONNECTION', '08004': 'CONNECTION', '08006': 'CONNECTION',
  '57P01': 'CONNECTION', '57P02': 'CONNECTION', '57P03': 'CONNECTION',
  '53300': 'RESOURCES',
};
const POSTGREST_TRANSIENT = new Set(['PGRST000', 'PGRST001', 'PGRST002', 'PGRST003']);
const GATEWAY_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524]);
const NETWORK_CODES = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED'];
const TIMEOUT_CODES = ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'];

/**
 * Is this failure transient? `status` is the HTTP status supabase-js reports
 * (0 = no response at all). Business errors (RAISE EXCEPTION → P0001),
 * permission/RLS (42501, PGRST3xx), constraint/data errors (23xxx, 22xxx),
 * statement timeouts (57014 — the query itself is slow, retrying adds load),
 * plain 500s and everything unknown are NOT retryable.
 */
export function classifyWriteError(error: DbErrorLike | null | undefined, status?: number | null): WriteErrorClass {
  if (!error) return { retryable: false, reason: 'NO_ERROR', code: null };
  const raw = (error.code ?? '').trim();
  // A SQLSTATE (5 chars) or PostgREST code; a Node error code (ECONNRESET…) is a transport failure, read below.
  const code = /^[0-9A-Z]{5}$/.test(raw) || raw.startsWith('PGRST') ? raw : null;
  if (code && SQLSTATE_TRANSIENT[code]) return { retryable: true, reason: SQLSTATE_TRANSIENT[code], code };
  if (code && POSTGREST_TRANSIENT.has(code)) return { retryable: true, reason: 'POOL', code };
  if (code) return { retryable: false, reason: nonTransientReason(code), code };

  // No SQLSTATE / PostgREST code: transport-level failures.
  const cause = error.cause as { code?: string; name?: string } | undefined;
  const text = `${error.name ?? ''} ${error.message ?? ''} ${error.details ?? ''} ${raw} ${cause?.code ?? ''} ${cause?.name ?? ''}`;
  if (TIMEOUT_CODES.some((c) => text.includes(c)) || /\bTimeoutError\b/.test(text)) return { retryable: true, reason: 'TIMEOUT', code: null };
  if (NETWORK_CODES.some((c) => text.includes(c))) return { retryable: true, reason: 'NETWORK', code: null };
  // supabase-js reports status 0 only when fetch itself threw (no HTTP response). A manual abort is not retried.
  if (status === 0 && /fetch failed|network|socket/i.test(text) && !/AbortError/.test(text)) return { retryable: true, reason: 'NETWORK', code: null };
  if (status != null && GATEWAY_STATUS.has(status)) return { retryable: true, reason: 'GATEWAY', code: null };
  return { retryable: false, reason: status ? `HTTP_${status}` : 'UNKNOWN', code: null };
}

function nonTransientReason(code: string): string {
  if (code === 'P0001') return 'BUSINESS_RULE';
  if (code === '42501' || code.startsWith('PGRST3')) return 'PERMISSION';
  if (code.startsWith('23')) return 'INTEGRITY';
  if (code.startsWith('22')) return 'INVALID_DATA';
  if (code === '57014') return 'STATEMENT_TIMEOUT';
  return `SQLSTATE_${code}`;
}

export interface RetryLogger {
  warn: (msg: string) => void;
}

export interface IdempotentMutationOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  logger?: RetryLogger;
}

export interface IdempotentMutationOutcome<R> {
  /** The last response (success, a non-retryable error, or the final transient error). */
  response: R;
  attempts: number;
  /** Set when the final response is still a transient error (attempts exhausted). */
  exhausted: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs `attempt` — ONE fixed idempotent request — up to maxAttempts times while
 * it fails transiently. Never retries a response without an error (business
 * outcomes live in `data` and are the caller's to interpret). A thrown error
 * is classified the same way; a non-transient throw propagates immediately.
 * Logs only the label, attempt number and failure class — never request data.
 */
export async function executeIdempotentMutation<R extends { error: DbErrorLike | null; status?: number | null }>(
  label: string,
  attempt: () => PromiseLike<R>,
  opts: IdempotentMutationOptions = {},
): Promise<IdempotentMutationOutcome<R>> {
  const max = Math.max(1, opts.maxAttempts ?? WRITE_RETRY_MAX_ATTEMPTS);
  const base = opts.baseDelayMs ?? WRITE_RETRY_BASE_DELAY_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const log = opts.logger ?? console;
  for (let n = 1; ; n++) {
    let response: R;
    try {
      response = await attempt();
    } catch (thrown) {
      const e = thrown as DbErrorLike;
      const cls = classifyWriteError({ message: e?.message ?? String(thrown), code: e?.code, name: e?.name, cause: e?.cause }, null);
      if (!cls.retryable || n >= max) {
        if (cls.retryable) log.warn(`[write-retry] ${label} failed after ${n} attempts (${cls.reason})`);
        throw thrown;
      }
      await backoff(label, n, max, cls, base, sleep, random, log);
      continue;
    }
    if (!response.error) {
      if (n > 1) log.warn(`[write-retry] ${label} succeeded on attempt ${n}`);
      return { response, attempts: n, exhausted: false };
    }
    const cls = classifyWriteError(response.error, response.status ?? null);
    if (!cls.retryable) return { response, attempts: n, exhausted: false };
    if (n >= max) {
      log.warn(`[write-retry] ${label} failed after ${n} attempts (${cls.reason}${cls.code ? ' ' + cls.code : ''})`);
      return { response, attempts: n, exhausted: true };
    }
    await backoff(label, n, max, cls, base, sleep, random, log);
  }
}

async function backoff(label: string, n: number, max: number, cls: WriteErrorClass, base: number, sleep: (ms: number) => Promise<void>, random: () => number, log: RetryLogger) {
  // Exponential (x3) with jitter in [50%, 100%].
  const ms = Math.round(base * 3 ** (n - 1) * (0.5 + random() * 0.5));
  log.warn(`[write-retry] ${label} attempt ${n}/${max} transient (${cls.reason}${cls.code ? ' ' + cls.code : ''}); retrying in ${ms}ms`);
  await sleep(ms);
}
