/**
 * test-write-retry.ts
 *
 * Bounded transient retry for idempotent writes (src/lib/writeRetry.ts):
 *   K — retryability classifier (pure)
 *   R — executeIdempotentMutation: attempts, backoff, logging (pure, fake sleep)
 *   W — real writes against the local DB through a signed-in RLS client wrapped
 *       in a proxy that injects transient failures / LOST RESPONSES in front of
 *       the real RPC: record_lead_interaction, void_lead_event, manage_listing
 *       (apply_listing_changes), rename_lead_contact, create_operation_with_winning_lead.
 *       Every attempt must carry the same mutation id; exactly one business
 *       mutation may exist afterwards.
 *
 * Usage:  npx tsx scripts/test-write-retry.ts
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import { classifyWriteError, executeIdempotentMutation, WRITE_RETRY_MAX_ATTEMPTS, type DbErrorLike } from '../src/lib/writeRetry';
import { recordLeadInteraction, voidLeadEvent, type AgentEventInput } from '../src/lib/leads/leadWriteService';
import { applyListingChanges } from '../src/lib/listings/listingWriteService';
import { renameLeadContact } from '../src/lib/leads/leadContactEdit';
import { createOperationWithWinningLead } from '../src/lib/leads/operationLeads';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 900) : ''); }
}

const PASSWORD = 'Write-Retry-Fixture-Local-Only-1!';
const uuid = () => crypto.randomUUID();
const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// Error shapes exactly as supabase-js surfaces them.
const FETCH_RESET: DbErrorLike = { message: 'TypeError: fetch failed', details: 'TypeError: fetch failed\n\nCaused by: Error: read ECONNRESET (ECONNRESET)', hint: '', code: '' };
const HEADERS_TIMEOUT: DbErrorLike = { message: 'TypeError: fetch failed', details: 'TypeError: fetch failed\n\nCaused by: HeadersTimeoutError: Headers Timeout Error (UND_ERR_HEADERS_TIMEOUT)', hint: '', code: '' };
const DEADLOCK: DbErrorLike = { message: 'deadlock detected', code: '40P01', details: 'Process 1 waits for ShareLock on transaction 2', hint: '' };
const SERIALIZATION: DbErrorLike = { message: 'could not serialize access due to concurrent update', code: '40001', details: '', hint: '' };
const transient = (e: DbErrorLike, status = 0) => ({ data: null, error: e, status });

// ── K: classifier ────────────────────────────────────────────────────────
function classifierChecks() {
  console.log('\n[K1 — retryable]');
  const yes: [string, DbErrorLike, number | null, string][] = [
    ['deadlock 40P01', DEADLOCK, 500, 'DEADLOCK'],
    ['serialization 40001', SERIALIZATION, 500, 'SERIALIZATION'],
    ['connection failure 08006', { message: 'connection failure', code: '08006' }, 500, 'CONNECTION'],
    ['admin shutdown 57P01', { message: 'terminating connection due to administrator command', code: '57P01' }, 503, 'CONNECTION'],
    ['cannot connect now 57P03', { message: 'the database system is starting up', code: '57P03' }, 503, 'CONNECTION'],
    ['too many connections 53300', { message: 'sorry, too many clients already', code: '53300' }, 500, 'RESOURCES'],
    ['PostgREST cannot connect PGRST000', { message: 'Could not connect with the database', code: 'PGRST000' }, 503, 'POOL'],
    ['PostgREST pool timeout PGRST003', { message: 'Timed out acquiring connection from connection pool.', code: 'PGRST003' }, 504, 'POOL'],
    ['fetch failed + ECONNRESET (status 0)', FETCH_RESET, 0, 'NETWORK'],
    ['fetch failed, no cause (status 0)', { message: 'TypeError: fetch failed', details: '', code: '' }, 0, 'NETWORK'],
    ['headers timeout (UND_ERR_HEADERS_TIMEOUT)', HEADERS_TIMEOUT, 0, 'TIMEOUT'],
    ['connect timeout ETIMEDOUT', { message: 'TypeError: fetch failed', details: 'connect ETIMEDOUT 1.2.3.4:443', code: '' }, 0, 'TIMEOUT'],
    ['TimeoutError (AbortSignal.timeout)', { message: 'TimeoutError: The operation was aborted due to timeout', code: '' }, 0, 'TIMEOUT'],
    ['502 gateway (HTML body, no code)', { message: '<html>502 Bad Gateway</html>' }, 502, 'GATEWAY'],
    ['503 (no code)', { message: 'Service Unavailable' }, 503, 'GATEWAY'],
    ['504 (no code)', { message: 'Gateway Timeout' }, 504, 'GATEWAY'],
    ['522 Cloudflare connection timed out', { message: 'error code: 522' }, 522, 'GATEWAY'],
  ];
  for (const [label, e, status, reason] of yes) {
    const c = classifyWriteError(e, status);
    check(`${label} → retry (${reason})`, c.retryable && c.reason === reason, c);
  }

  console.log('\n[K2 — never retried]');
  const no: [string, DbErrorLike, number | null, string][] = [
    ['business RAISE (P0001 VALIDATION_ERROR)', { message: 'VALIDATION_ERROR: bad', code: 'P0001' }, 400, 'BUSINESS_RULE'],
    ['business RAISE (P0001 DEAL_NOT_VALID)', { message: 'DEAL_NOT_VALID', code: 'P0001' }, 400, 'BUSINESS_RULE'],
    ['RLS / permission 42501', { message: 'permission denied for table item_leads', code: '42501' }, 403, 'PERMISSION'],
    ['JWT expired PGRST301', { message: 'JWT expired', code: 'PGRST301' }, 401, 'PERMISSION'],
    ['unique violation 23505', { message: 'duplicate key value', code: '23505' }, 409, 'INTEGRITY'],
    ['check violation 23514', { message: 'violates check constraint', code: '23514' }, 400, 'INTEGRITY'],
    ['invalid input 22P02', { message: 'invalid input syntax for type uuid', code: '22P02' }, 400, 'INVALID_DATA'],
    ['statement timeout 57014', { message: 'canceling statement due to statement timeout', code: '57014' }, 500, 'STATEMENT_TIMEOUT'],
    ['unknown SQLSTATE XX000', { message: 'internal error', code: 'XX000' }, 500, 'SQLSTATE_XX000'],
    ['plain 500, no code', { message: 'Internal Server Error' }, 500, 'HTTP_500'],
    ['400, no code', { message: 'Bad Request' }, 400, 'HTTP_400'],
    ['manual abort (AbortError, status 0)', { message: 'AbortError: This operation was aborted', code: '' }, 0, 'UNKNOWN'],
    ['unknown error, no status', { message: 'something odd' }, null, 'UNKNOWN'],
    ['DNS failure ENOTFOUND (configuration, not transient)', { message: 'TypeError: fetch failed', details: 'getaddrinfo ENOTFOUND db.invalid', code: '' }, null, 'UNKNOWN'],
  ];
  for (const [label, e, status, reason] of no) {
    const c = classifyWriteError(e, status);
    check(`${label} → no retry (${reason})`, !c.retryable && c.reason === reason, c);
  }
  check('no error → not retryable', !classifyWriteError(null).retryable);
}

// ── R: helper ────────────────────────────────────────────────────────────
async function helperChecks() {
  console.log('\n[R1 — attempts]');
  const mk = (script: (n: number) => { data: unknown; error: DbErrorLike | null; status: number }) => {
    const seen: unknown[] = [];
    const delays: number[] = [];
    const logs: string[] = [];
    const request = { mutation_id: uuid(), phone: '647-555-1234' };
    let n = 0;
    const run = () => executeIdempotentMutation('test_write', () => { n++; seen.push(request); return Promise.resolve(script(n)); }, {
      sleep: async (ms) => { delays.push(ms); }, random: () => 1, logger: { warn: (m) => logs.push(m) },
    });
    return { run, seen, delays, logs, request, calls: () => n };
  };
  check('policy: 3 total attempts', WRITE_RETRY_MAX_ATTEMPTS === 3);

  const ok = mk(() => ({ data: { status: 'OK' }, error: null, status: 200 }));
  const r1 = await ok.run();
  check('success on first attempt: 1 call, no delay, no log', r1.attempts === 1 && ok.calls() === 1 && ok.delays.length === 0 && ok.logs.length === 0 && !r1.exhausted, { r1, logs: ok.logs });

  const one = mk((n) => (n === 1 ? transient(FETCH_RESET) : { data: { status: 'OK' }, error: null, status: 200 }));
  const r2 = await one.run();
  check('transient then success: 2 calls, same request object both times', r2.attempts === 2 && one.calls() === 2 && one.seen.every((s) => s === one.request), r2);
  check('…one warning for the retry + one for the recovery', one.logs.length === 2 && /attempt 1\/3 transient \(NETWORK\)/.test(one.logs[0]) && /succeeded on attempt 2/.test(one.logs[1]), one.logs);

  const two = mk((n) => (n <= 2 ? transient(DEADLOCK, 500) : { data: { status: 'OK' }, error: null, status: 200 }));
  const r3 = await two.run();
  check('two transient then success: 3 calls, success returned', r3.attempts === 3 && two.calls() === 3 && r3.response.error === null && !r3.exhausted, r3);
  check('backoff is short and exponential (random=1 → 150ms, 450ms)', JSON.stringify(two.delays) === '[150,450]', two.delays);

  const three = mk(() => transient(FETCH_RESET));
  const r4 = await three.run();
  check('three transient failures: exactly 3 calls, final error returned, exhausted', r4.attempts === 3 && three.calls() === 3 && r4.exhausted && r4.response.error === FETCH_RESET, r4);
  check('…final log says "failed after 3 attempts"', three.logs.some((l) => /failed after 3 attempts \(NETWORK\)/.test(l)), three.logs);
  check('logs never contain request data (mutation id / phone)', [...one.logs, ...two.logs, ...three.logs].every((l) => !l.includes(three.request.mutation_id) && !/555/.test(l)));

  const lowJitter = mk(() => transient(SERIALIZATION, 500));
  await executeIdempotentMutation('j', () => Promise.resolve(transient(SERIALIZATION, 500)), { sleep: async (ms) => { lowJitter.delays.push(ms); }, random: () => 0, logger: { warn: () => {} } });
  check('jitter floor: 75ms, 225ms (total wait < 1s)', JSON.stringify(lowJitter.delays) === '[75,225]', lowJitter.delays);

  for (const [label, e, status] of [
    ['business error (P0001)', { message: 'VALIDATION_ERROR: x', code: 'P0001' }, 400],
    ['RLS error (42501)', { message: 'permission denied', code: '42501' }, 403],
    ['unknown DB error (XX000)', { message: 'internal', code: 'XX000' }, 500],
  ] as [string, DbErrorLike, number][]) {
    const h = mk(() => ({ data: null, error: e, status }));
    const r = await h.run();
    check(`${label}: 1 call, returned as-is, no log`, r.attempts === 1 && h.calls() === 1 && r.response.error === e && !r.exhausted && h.logs.length === 0, r);
  }
  const biz = mk(() => ({ data: { status: 'REVIEW_REQUIRED' }, error: null, status: 200 }));
  const rb = await biz.run();
  check('a business outcome in data (REVIEW_REQUIRED) is never retried', rb.attempts === 1 && biz.calls() === 1);

  let thrownCalls = 0;
  const rt = await executeIdempotentMutation('t', () => { thrownCalls++; if (thrownCalls === 1) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); return Promise.resolve({ data: 1, error: null, status: 200 }); }, { sleep: async () => {}, logger: { warn: () => {} } });
  check('a thrown network error is retried', rt.attempts === 2 && thrownCalls === 2);
  let bugCalls = 0;
  let caught: unknown = null;
  try { await executeIdempotentMutation('t', () => { bugCalls++; throw new TypeError('x is not a function'); }, { sleep: async () => {}, logger: { warn: () => {} } }); } catch (e) { caught = e; }
  check('a thrown programming error propagates after 1 call', bugCalls === 1 && caught instanceof TypeError);
}

// ── W: real writes behind a fault-injecting proxy ───────────────────────
type Fault = 'reset' | 'timeout' | 'deadlock' | 'serialization' | 'lost' | 'p0001' | 'rls' | 'unknown';
interface RpcSpy { calls: { fn: string; args: unknown }[]; faults: Fault[] }

/** The real signed-in client, except rpc(fn) consumes one scripted fault per call for `target`. */
function faulty(client: SupabaseClient, target: string, spy: RpcSpy): SupabaseClient {
  return new Proxy(client, {
    get(t, prop) {
      if (prop === 'rpc') {
        return async (fn: string, args: unknown) => {
          if (fn !== target) return t.rpc(fn, args as never);
          spy.calls.push({ fn, args: JSON.parse(JSON.stringify(args)) });
          const fault = spy.faults.shift();
          switch (fault) {
            case 'reset': return transient(FETCH_RESET);
            case 'timeout': return transient(HEADERS_TIMEOUT);
            case 'deadlock': return transient(DEADLOCK, 500);
            case 'serialization': return transient(SERIALIZATION, 500);
            case 'lost': { await t.rpc(fn, args as never); return transient(FETCH_RESET); } // committed, response lost
            case 'p0001': return { data: null, error: { message: 'VALIDATION_ERROR: injected', code: 'P0001', details: '', hint: '' }, status: 400 };
            case 'rls': return { data: null, error: { message: 'permission denied for function', code: '42501', details: '', hint: '' }, status: 403 };
            case 'unknown': return { data: null, error: { message: 'internal error', code: 'XX000', details: '', hint: '' }, status: 500 };
            default: return t.rpc(fn, args as never);
          }
        };
      }
      const v = Reflect.get(t, prop);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

async function ensureAuthUser(admin: SupabaseClient, email: string): Promise<string> {
  const { data: created, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (!error && created.user) return created.user.id;
  const { data: listed } = await admin.auth.admin.listUsers({ perPage: 200 });
  const match = listed?.users.find((u) => u.email === email);
  if (match) return match.id;
  throw new Error(`Could not create or find auth user ${email}: ${error?.message}`);
}
async function resolveAppUserId(admin: SupabaseClient, authUserId: string): Promise<number> {
  for (let i = 0; i < 10; i++) {
    const { data } = await admin.from('app_users').select('id').eq('auth_user_id', authUserId).maybeSingle();
    if (data) return data.id as number;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('app_users row never appeared');
}

const msg = (at: string, summary: string): AgentEventInput => ({ type: 'MESSAGE', direction: 'INBOUND', occurred_at: at, summary, payload: { substance: 'SUBSTANTIVE' } });
const fast = { retry: { sleep: async () => {}, logger: { warn: () => {} } } };

async function dbChecks() {
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = 'write-retry-fixture@example.test';
  const userA = await resolveAppUserId(admin, await ensureAuthUser(admin, email));
  const cA = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signErr } = await cA.auth.signInWithPassword({ email, password: PASSWORD });
  if (signErr) throw signErr;

  const { data: brand } = await admin.from('brands').select('id').limit(1).single();
  const { data: chans } = await admin.from('deal_channels').select('id, name');
  const MKT = (chans ?? []).find((c) => c.name === 'Marketplace')!.id as number;
  const itemIds: number[] = [];
  const dealIds: number[] = [];
  const item = async (model: string, status = 'listed') => {
    const { data, error } = await admin.from('inventory_items').insert({ user_id: userA, brand_id: brand!.id, model, status, serial_number: `WR-${uuid().slice(0, 8)}` }).select('id').single();
    if (error) throw error;
    itemIds.push(data.id as number);
    return data.id as number;
  };
  const eventsWith = async (mutationId: string) => ((await admin.from('lead_events').select('id, event_type').eq('mutation_id', mutationId)).data ?? []);
  const leadEvents = async (leadId: number) => ((await admin.from('lead_events').select('id, event_type, voided_at').eq('item_lead_id', leadId)).data ?? []);

  try {
    const I = await item('Retry Jazzmaster');

    console.log('\n[W1 — record_lead_interaction: first attempt succeeds]');
    const s0: RpcSpy = { calls: [], faults: [] };
    const w0 = await recordLeadInteraction(faulty(cA, 'apply_lead_interaction', s0), { mutation_id: uuid(), lead: { item_id: I, channel: 'Marketplace', contact_name: 'Retry Ann' }, events: [msg('2026-10-28T10:00:00-04:00', 'First question')] }, fast);
    check('APPLIED_CREATE with one RPC call, no replay flag', w0.result === 'APPLIED_CREATE' && s0.calls.length === 1 && w0.replayed === undefined, w0);
    const L = w0.lead_id!;

    console.log('\n[W2 — transient first failure, second succeeds]');
    const m2 = uuid();
    const s2: RpcSpy = { calls: [], faults: ['reset'] };
    const w2 = await recordLeadInteraction(faulty(cA, 'apply_lead_interaction', s2), { mutation_id: m2, lead: { lead_id: L }, events: [msg('2026-10-28T10:05:00-04:00', 'Second message')] }, fast);
    check('APPLIED_UPDATE after 2 RPC calls', w2.result === 'APPLIED_UPDATE' && s2.calls.length === 2, { w2, calls: s2.calls.length });
    check('both attempts sent the same mutation_id and identical request', s2.calls.every((c) => (c.args as { p_request: { mutation_id: string } }).p_request.mutation_id === m2) && JSON.stringify(s2.calls[0].args) === JSON.stringify(s2.calls[1].args));
    check('exactly one business mutation (one event under this mutation id)', (await eventsWith(m2)).length === 1);

    console.log('\n[W3 — two transient failures (deadlock, serialization), third succeeds]');
    const m3 = uuid();
    const s3: RpcSpy = { calls: [], faults: ['deadlock', 'serialization'] };
    const w3 = await recordLeadInteraction(faulty(cA, 'apply_lead_interaction', s3), { mutation_id: m3, lead: { lead_id: L }, events: [msg('2026-10-28T10:10:00-04:00', 'Third message')] }, fast);
    check('APPLIED_UPDATE on the third attempt, one mutation', w3.result === 'APPLIED_UPDATE' && s3.calls.length === 3 && (await eventsWith(m3)).length === 1, { w3, calls: s3.calls.length });

    console.log('\n[W4 — network timeout then success]');
    const m4 = uuid();
    const s4: RpcSpy = { calls: [], faults: ['timeout'] };
    const w4 = await recordLeadInteraction(faulty(cA, 'apply_lead_interaction', s4), { mutation_id: m4, lead: { lead_id: L }, events: [msg('2026-10-28T10:12:00-04:00', 'Fourth message')] }, fast);
    check('headers timeout retried → APPLIED_UPDATE, one mutation', w4.result === 'APPLIED_UPDATE' && s4.calls.length === 2 && (await eventsWith(m4)).length === 1, w4);

    console.log('\n[W5 — three transient failures: bounded, final error]');
    const m5 = uuid();
    const s5: RpcSpy = { calls: [], faults: ['reset', 'reset', 'reset', 'reset'] };
    let e5: Error | null = null;
    try { await recordLeadInteraction(faulty(cA, 'apply_lead_interaction', s5), { mutation_id: m5, lead: { lead_id: L }, events: [msg('2026-10-28T10:15:00-04:00', 'Never lands')] }, fast); } catch (e) { e5 = e as Error; }
    check('exactly 3 RPC calls, then the existing error surfaces (with attempt count)', s5.calls.length === 3 && !!e5 && /apply_lead_interaction: TypeError: fetch failed \(3 attempts\)/.test(e5.message), { calls: s5.calls.length, e: e5?.message });
    check('nothing written', (await eventsWith(m5)).length === 0);

    console.log('\n[W6 — response LOST after a successful write]');
    const m6 = uuid();
    const before6 = (await leadEvents(L)).length;
    const s6: RpcSpy = { calls: [], faults: ['lost'] };
    const req6 = { mutation_id: m6, lead: { lead_id: L, contact_phone: '647-555-0606' }, events: [cashOfferEvent()] };
    const w6 = await recordLeadInteraction(faulty(cA, 'apply_lead_interaction', s6), req6, fast);
    const ev6 = await eventsWith(m6);
    check('caller gets the original result (APPLIED_UPDATE), not an error', w6.result === 'APPLIED_UPDATE' && w6.lead_id === L, w6);
    check('…reported as this call\'s write (no replayed flag), with version + event ids', w6.replayed === undefined && typeof w6.version === 'number' && (w6.event_ids ?? []).length === ev6.length, w6);
    check('…same mutation_id on the retry', s6.calls.length === 2 && s6.calls.every((c) => (c.args as { p_request: { mutation_id: string } }).p_request.mutation_id === m6));
    check('no duplicate events: one OFFER + one phone NOTE, written once', ev6.length === 2 && (await leadEvents(L)).length === before6 + 2, ev6);
    const again = await recordLeadInteraction(cA, req6);
    check('a later re-send by the caller (same mutation_id) still replays, no new events', again.replayed === true && (await leadEvents(L)).length === before6 + 2, again);

    console.log('\n[W7 — semantic outcomes are never retried]');
    const s7: RpcSpy = { calls: [], faults: [] };
    const w7 = await recordLeadInteraction(faulty(cA, 'apply_lead_interaction', s7), { mutation_id: uuid(), lead: { lead_id: L, contact_phone: '416-555-0707' }, events: [msg('2026-10-28T10:30:00-04:00', 'Different number')] }, fast);
    check('REVIEW_REQUIRED (existing phone differs): returned immediately, no RPC call', w7.result === 'REVIEW_REQUIRED' && w7.reason === 'CONTACT_PHONE_CONFLICT' && s7.calls.length === 0, w7);
    const K = await item('Retry Kijiji amp');
    await recordLeadInteraction(cA, { mutation_id: uuid(), lead: { item_id: K, channel: 'Kijiji', contact_name: 'KijijiUser' }, events: [msg('2026-10-28T09:00:00-04:00', 'KijijiUser one')] });
    const s7b: RpcSpy = { calls: [], faults: [] };
    const w7b = await recordLeadInteraction(faulty(cA, 'apply_lead_interaction', s7b), { mutation_id: uuid(), lead: { item_id: K, channel: 'Kijiji', contact_name: 'KijijiUser' }, events: [msg('2026-10-28T09:10:00-04:00', 'KijijiUser two?')] }, fast);
    check('REVIEW_REQUIRED (possible different KijijiUser): no RPC call', w7b.result === 'REVIEW_REQUIRED' && w7b.reason === 'POSSIBLE_DIFFERENT_PERSON' && s7b.calls.length === 0, w7b);
    const s7c: RpcSpy = { calls: [], faults: [] };
    const w7c = await recordLeadInteraction(faulty(cA, 'apply_lead_interaction', s7c), { mutation_id: uuid(), lead: { lead_id: L }, events: [{ type: 'OFFER', direction: 'INBOUND', occurred_at: '2026-10-28T10:31:00-04:00', summary: 'bad offer', payload: { offer: { cash_terms: 'WEIRD' } } }] }, fast);
    check('REJECTED (invalid offer structure): no RPC call', w7c.result === 'REJECTED' && w7c.reason === 'VALIDATION_ERROR' && s7c.calls.length === 0, w7c);
    const s7d: RpcSpy = { calls: [], faults: ['p0001'] };
    const w7d = await recordLeadInteraction(faulty(cA, 'apply_lead_interaction', s7d), { mutation_id: uuid(), lead: { lead_id: L }, events: [msg('2026-10-28T10:32:00-04:00', 'db validation')] }, fast);
    check('database validation error (P0001): REJECTED after exactly 1 call', w7d.result === 'REJECTED' && w7d.reason === 'VALIDATION_ERROR' && s7d.calls.length === 1, { w7d, calls: s7d.calls.length });
    for (const [fault, label] of [['rls', 'permission/RLS (42501)'], ['unknown', 'unknown DB error (XX000)']] as [Fault, string][]) {
      const sp: RpcSpy = { calls: [], faults: [fault] };
      let err: Error | null = null;
      try { await recordLeadInteraction(faulty(cA, 'apply_lead_interaction', sp), { mutation_id: uuid(), lead: { lead_id: L }, events: [msg('2026-10-28T10:33:00-04:00', label)] }, fast); } catch (e) { err = e as Error; }
      check(`${label}: surfaces after exactly 1 call (no retry)`, sp.calls.length === 1 && !!err && !/attempts\)/.test(err.message), { calls: sp.calls.length, e: err?.message });
    }

    console.log('\n[W8 — void_lead_event: lost response]');
    const target = (await eventsWith(m4))[0].id as number;
    const ver = Number(((await admin.from('item_leads').select('version').eq('id', L).single()).data as { version: number }).version);
    const mv = uuid();
    const s8: RpcSpy = { calls: [], faults: ['lost'] };
    const w8 = await voidLeadEvent(faulty(cA, 'apply_lead_interaction', s8), { mutation_id: mv, event_id: target, reason: 'logged twice by mistake', expected_version: ver }, fast);
    const voided = ((await admin.from('lead_events').select('id').eq('voided_by_mutation_id', mv)).data ?? []);
    check('APPLIED_UPDATE as this call\'s write (voided ids, version), event voided once', w8.result === 'APPLIED_UPDATE' && w8.replayed === undefined && JSON.stringify(w8.voided_event_ids) === JSON.stringify([target]) && typeof w8.version === 'number' && voided.length === 1 && s8.calls.length === 2, { w8, voided });

    console.log('\n[W9 — manage_listing (apply_listing_changes): lost response]');
    const LI = await item('Retry listing item', 'owned');
    const ml = uuid();
    const s9: RpcSpy = { calls: [], faults: ['lost'] };
    const w9 = await applyListingChanges(faulty(cA, 'apply_listing_changes', s9), { mutationId: ml, itemId: LI, source: 'MCP', actions: [{ action: 'LIST', dealChannelId: MKT, askingPrice: 1500, tradeEnabled: false, date: '2026-10-27' }] }, fast.retry);
    const listings = ((await admin.from('item_listings').select('id').eq('inventory_item_id', LI)).data ?? []);
    const muts = ((await admin.from('item_listing_mutations').select('id').eq('mutation_id', ml)).data ?? []);
    check('APPLIED, reported as this call\'s write (replay false)', w9.status === 'APPLIED' && w9.replay === false && s9.calls.length === 2, w9);
    check('exactly one listing and one mutation record', listings.length === 1 && muts.length === 1, { listings, muts });
    const s9b: RpcSpy = { calls: [], faults: ['reset', 'reset', 'reset'] };
    const w9b = await applyListingChanges(faulty(cA, 'apply_listing_changes', s9b), { mutationId: uuid(), itemId: LI, source: 'MCP', actions: [{ action: 'UPDATE', dealChannelId: MKT, askingPrice: 1400 }] }, fast.retry);
    check('three transient failures: existing REJECTED WRITE_FAILED contract, after 3 calls', w9b.status === 'REJECTED' && w9b.code === 'WRITE_FAILED' && /\(3 attempts\)/.test(w9b.message ?? '') && s9b.calls.length === 3, w9b);
    const s9c: RpcSpy = { calls: [], faults: [] };
    const w9c = await applyListingChanges(faulty(cA, 'apply_listing_changes', s9c), { mutationId: uuid(), itemId: LI, source: 'MCP', actions: [{ action: 'LIST', dealChannelId: MKT, askingPrice: 1500, date: '2026-10-27' }] }, fast.retry);
    check('business REVIEW_REQUIRED (listing already active): 1 call', w9c.status === 'REVIEW_REQUIRED' && s9c.calls.length === 1, w9c);

    console.log('\n[W10 — rename_lead_contact: lost response]');
    const verR = Number(((await admin.from('item_leads').select('version').eq('id', L).single()).data as { version: number }).version);
    const s10: RpcSpy = { calls: [], faults: ['lost'] };
    const before10 = (await leadEvents(L)).length;
    const w10 = await renameLeadContact(faulty(cA, 'rename_lead_contact', s10), userA, { leadId: L, contactName: 'Retry Ann B', expectedVersion: verR, mutationId: uuid() });
    check('RENAMED once (one audit NOTE), 2 calls', w10.result === 'RENAMED' && w10.lead.contact_name === 'Retry Ann B' && (await leadEvents(L)).length === before10 + 1 && s10.calls.length === 2, { w10, calls: s10.calls.length });

    console.log('\n[W11 — create_operation_with_winning_lead: lost response]');
    const OI = await item('Retry sold item');
    const ol = await recordLeadInteraction(cA, { mutation_id: uuid(), lead: { item_id: OI, channel: 'Marketplace', contact_name: 'Retry Buyer' }, events: [msg('2026-10-28T11:00:00-04:00', 'Wants it')] });
    const opKey = uuid();
    const s11: RpcSpy = { calls: [], faults: ['lost'] };
    const op = { p_deal_date: '2026-10-28', p_channel_id: MKT, p_items: [{ item_id: OI, total_value: 900 }], p_notes: null, p_cf_description: 'Sale: retry test' };
    const w11 = await createOperationWithWinningLead(faulty(cA, 'create_operation_with_winning_lead', s11), userA, { kind: 'sale', operation: op, leadId: ol.lead_id!, operationKey: opKey }, undefined, fast.retry);
    if (w11.ok) dealIds.push(w11.deal_id);
    const deals = ((await admin.from('deal_items').select('deal_id').eq('item_id', OI).eq('direction', 'out')).data ?? []);
    for (const d of deals) if (!dealIds.includes(d.deal_id as number)) dealIds.push(d.deal_id as number);
    check('ok with the reserved deal id, not flagged replayed; same deal id on both attempts', w11.ok && !w11.replayed && s11.calls.length === 2
      && s11.calls.every((c) => (c.args as { p_deal_id: number }).p_deal_id === (w11.ok ? w11.deal_id : -1)), { w11, calls: s11.calls.map((c) => (c.args as { p_deal_id: number }).p_deal_id) });
    check('exactly one sale created and one lead link', deals.length === 1 && ((await admin.from('item_leads').select('deal_id').eq('id', ol.lead_id!).single()).data as { deal_id: number }).deal_id === deals[0].deal_id, deals);

    console.log('\n[W12 — wiring]');
    const lws = read('src', 'lib', 'leads', 'leadWriteService.ts');
    check('apply_lead_interaction goes through the helper (record + void share callRpc)', /executeIdempotentMutation\('apply_lead_interaction'/.test(lws) && (lws.match(/await callRpc\(/g) ?? []).length === 2);
    check('no mutation id is generated inside the retry path', !/executeIdempotentMutation\([^)]*randomUUID/.test(lws + read('src', 'lib', 'writeRetry.ts')));
    const supa = read('src', 'lib', 'supabase.ts');
    check('non-idempotent operation RPCs (no mutation id) are NOT retried', !/executeIdempotentMutation/.test(supa));
  } finally {
    console.log('\n=== Cleanup ===');
    if (dealIds.length) {
      await admin.from('item_leads').update({ deal_id: null }).in('deal_id', dealIds);
    }
    if (itemIds.length) await admin.from('item_leads').delete().in('inventory_item_id', itemIds);
    if (dealIds.length) {
      await admin.from('inventory_expenses').delete().in('deal_id', dealIds);
      await admin.from('cash_flow').delete().in('deal_id', dealIds);
      await admin.from('deal_items').delete().in('deal_id', dealIds);
      await admin.from('deals').delete().in('id', dealIds);
    }
    if (itemIds.length) {
      await admin.from('item_listings').delete().in('inventory_item_id', itemIds);
      await admin.from('item_listing_mutations').delete().in('inventory_item_id', itemIds);
      const { error } = await admin.from('inventory_items').delete().in('id', itemIds);
      check('cleanup: fixture items deleted', !error, error);
    }
    await admin.from('deal_id_reservations').delete().eq('user_id', userA);
  }
}

function cashOfferEvent(): AgentEventInput {
  return { type: 'OFFER', direction: 'INBOUND', occurred_at: '2026-10-28T10:20:00-04:00', summary: 'Offered C$1,500 cash', payload: { offer: { cash_terms: 'AMOUNT', cash_amount: 1500, items: [] } } };
}

(async () => {
  classifierChecks();
  await helperChecks();
  await dbChecks();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => { console.error('FATAL:', err); process.exit(1); });
