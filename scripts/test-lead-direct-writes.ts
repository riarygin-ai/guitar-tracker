/**
 * test-lead-direct-writes.ts
 *
 * Direct lead writes (record_lead_interaction / void_lead_event):
 *   P  — pure semantics (classification.ts): keys, offers, stage rules,
 *        rounds, waiting_on, ghost preconditions, responsiveness, timestamps
 *   W  — writes through a real signed-in RLS client against the local DB:
 *        create/update, matching + review/resolution, idempotency, dedupe,
 *        status rules, deal linking, auto-close, void, concurrency, legacy
 *        baseline, security/isolation.
 * Self-cleaning dedicated fixture (two users). Synthetic names only.
 *
 * Usage:  npx tsx scripts/test-lead-direct-writes.ts
 */

import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import {
  baseKey, contactKey, deriveNegotiationRounds, deriveResponsiveness, deriveSnapshot, deriveStageFromEvents, deriveWaitingOn,
  emptyBaseline, ghostPreconditionsMet, legacyStructuredStage, offerShape, type ClassifiableEvent,
} from '../src/lib/leads/classification';
import { recordLeadInteraction, voidLeadEvent, parseOccurredAt, isPlaceholderName, isNonUniqueDisplayName, type AgentEventInput, type WriteResult } from '../src/lib/leads/leadWriteService';
import { renderLeadSemanticsForPrompt, SEMANTICS_VERSION } from '../src/lib/leads/semantics';
import { getItemContextForMcp } from '../src/lib/analytics/itemContextMcp';
import { findContactHistoryForUser } from '../src/lib/analytics/contactHistoryService';
import { buildLeadActivity } from '../src/lib/analytics/leadActivityService';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 900) : ''); }
}

const PASSWORD = 'Direct-Writes-Fixture-Local-Only-1!';
const uuid = () => crypto.randomUUID();

// ── Pure helpers ─────────────────────────────────────────────────────────
let seq = 0;
const ev = (type: string, direction: ClassifiableEvent['direction'], payload: Record<string, unknown> = {}, o: Partial<ClassifiableEvent> = {}): ClassifiableEvent => ({
  id: ++seq, event_type: type, direction, occurred_at: new Date(Date.UTC(2026, 9, 1, 12, seq)).toISOString(),
  message_count: direction === 'INTERNAL' ? 0 : 1, expects_reply: type === 'MESSAGE' || type === 'OFFER', payload, ...o,
});
const cash = (n: number) => ({ offer: { cash_terms: 'AMOUNT', cash_amount: n, items: [] } });
const trade = (items: string[], terms: 'STRAIGHT' | 'OPEN' | 'AMOUNT', amt: number | null = null) => ({ offer: { cash_terms: terms, cash_amount: amt, items: items.map((d) => ({ description: d })) } });
const stage = (events: ClassifiableEvent[], status = 'OPEN', deal: number | null = null) => deriveStageFromEvents(events, status, deal);

function pureChecks() {
  console.log('\n[P1 — contact / qualifier keys]');
  check('case + whitespace insensitive', contactKey('  JANE   doe ') === 'jane doe');
  check('qualifier kept: "Nick (collector)"', contactKey('Nick (collector)') === 'nick (collector)');
  check('Nick (collector) != Nick (ES-325)', contactKey('Nick (collector)') !== contactKey('Nick (ES-325)'));
  check('qualifier spacing normalized', contactKey('Nick ( collector )') === contactKey('Nick (Collector)'));
  check('baseKey strips one trailing qualifier', baseKey('Nick (collector)') === 'nick' && baseKey('Nick') === 'nick');
  check('placeholders recognised', isPlaceholderName('Unknown') && isPlaceholderName(' marketplace buyer ') && !isPlaceholderName('Jane Doe'));
  check('"KijijiUser" is a valid name; "Kijiji User" stays a placeholder', !isPlaceholderName('KijijiUser') && isPlaceholderName('Kijiji User'));
  check('non-unique display name: KijijiUser on Kijiji only; short names are not generic',
    isNonUniqueDisplayName('Kijiji', contactKey('KijijiUser')) && isNonUniqueDisplayName('kijiji', contactKey(' kijijiuser ')) && !isNonUniqueDisplayName('Marketplace', contactKey('KijijiUser'))
      && ['JJ', 'CT', 'UJ', 'Jem'].every((n) => !isNonUniqueDisplayName('Kijiji', contactKey(n))));

  console.log('\n[P2 — offer shapes]');
  check('cash-only = CASH concrete', offerShape(cash(2800).offer as never).offer_type === 'CASH' && offerShape(cash(2800).offer as never).concrete);
  check('straight trade = TRADE concrete, cash 0', offerShape(trade(['PRS'], 'STRAIGHT').offer as never).cash_component === 0);
  check('PRS + 600 = MIXED concrete', offerShape(trade(['PRS'], 'AMOUNT', 600).offer as never).offer_type === 'MIXED' && offerShape(trade(['PRS'], 'AMOUNT', 600).offer as never).concrete);
  check('PRS + how much cash? = MIXED NOT concrete', offerShape(trade(['PRS'], 'OPEN').offer as never).concrete === false);

  console.log('\n[P3 — stage derivation]');
  check('availability question = INQUIRY', stage([ev('MESSAGE', 'INBOUND', { substance: 'BASIC' })]) === 'INQUIRY');
  check('detailed questions = ENGAGED', stage([ev('MESSAGE', 'INBOUND', { substance: 'SUBSTANTIVE' })]) === 'ENGAGED');
  check('named trade item with open terms = ENGAGED', stage([ev('OFFER', 'INBOUND', trade(['PRS'], 'OPEN'))]) === 'ENGAGED');
  check('concrete INBOUND cash offer = NEGOTIATING immediately', stage([ev('OFFER', 'INBOUND', cash(2800))]) === 'NEGOTIATING');
  check('INBOUND straight trade = NEGOTIATING', stage([ev('OFFER', 'INBOUND', trade(['PRS'], 'STRAIGHT'))]) === 'NEGOTIATING');
  check('our OUTBOUND offer alone does NOT advance (user-initiated)', stage([ev('OFFER', 'OUTBOUND', cash(3000))]) === 'INQUIRY');
  check('our OUTBOUND offer + basic unrelated buyer question stays below NEGOTIATING', stage([ev('OFFER', 'OUTBOUND', cash(3000)), ev('MESSAGE', 'INBOUND', { substance: 'BASIC' })]) === 'INQUIRY');
  check('our OUTBOUND offer + buyer responds to it = NEGOTIATING', stage([ev('OFFER', 'OUTBOUND', cash(3000)), ev('MESSAGE', 'INBOUND', { substance: 'BASIC', responds_to_offer: true })]) === 'NEGOTIATING');
  check('our OUTBOUND offer + buyer counter = NEGOTIATING', stage([ev('OFFER', 'OUTBOUND', cash(3000)), ev('OFFER', 'INBOUND', trade(['PRS'], 'OPEN'))]) === 'NEGOTIATING');
  check('AGREEMENT = HIGH_INTENT', stage([ev('OFFER', 'INBOUND', cash(2800)), ev('AGREEMENT', 'OUTBOUND')]) === 'HIGH_INTENT');
  check('PAYMENT done = HIGH_INTENT', stage([ev('LOGISTICS', 'INBOUND', { kind: 'PAYMENT', state: 'DONE' })]) === 'HIGH_INTENT');
  check('pickup at asking price with agreed time = HIGH_INTENT', stage([ev('LOGISTICS', 'INBOUND', { kind: 'MEETUP', state: 'CONFIRMED', at_asking_price: true })]) === 'HIGH_INTENT');
  check('meetup CONFIRMED without terms/asking price = ENGAGED only', stage([ev('LOGISTICS', 'INBOUND', { kind: 'MEETUP', state: 'CONFIRMED' })]) === 'ENGAGED');
  check('"I can come today" + offer (ready_to_execute) stays NEGOTIATING', stage([ev('OFFER', 'INBOUND', { ...cash(650), ready_to_execute: true })]) === 'NEGOTIATING');
  check('DEAL_LINKED = CONVERTED', stage([ev('DEAL_LINKED', 'INTERNAL', { deal_id: 1 })]) === 'CONVERTED');
  check('lowball (FAR_BELOW) is still NEGOTIATING', stage([ev('OFFER', 'INBOUND', { ...cash(100), assessment: 'FAR_BELOW' })]) === 'NEGOTIATING');
  check('message volume alone does nothing (30 basic messages = INQUIRY)', stage([ev('MESSAGE', 'INBOUND', { substance: 'BASIC' }, { message_count: 30 })]) === 'INQUIRY');

  console.log('\n[P4 — rounds / waiting_on / ghosting / responsiveness]');
  const r = [ev('OFFER', 'INBOUND', cash(2800)), ev('OFFER', 'INBOUND', cash(2800)), ev('OFFER', 'OUTBOUND', cash(3000)), ev('OFFER', 'INBOUND', cash(2900)), ev('OFFER', 'INBOUND', trade(['PRS'], 'OPEN'))];
  check('rounds count distinct concrete positions (restatement & open terms excluded)', deriveNegotiationRounds(0, r) === 3, deriveNegotiationRounds(0, r));
  check('waiting_on: INBOUND expects_reply -> US', deriveWaitingOn([ev('MESSAGE', 'INBOUND')], 'OPEN', null) === 'US');
  check('waiting_on: OUTBOUND expects_reply -> BUYER', deriveWaitingOn([ev('OFFER', 'OUTBOUND', cash(1))], 'OPEN', null) === 'BUYER');
  check('waiting_on: "thanks" (no reply expected) -> NONE', deriveWaitingOn([ev('MESSAGE', 'INBOUND', {}, { expects_reply: false })], 'OPEN', null) === 'NONE');
  check('waiting_on: terminal status -> NONE', deriveWaitingOn([ev('MESSAGE', 'INBOUND')], 'DECLINED_BY_THEM', null) === 'NONE');
  check('waiting_on: no events keeps legacy unknown (null)', deriveWaitingOn([], 'OPEN', null) === null);
  check('ghost: buyer-last conversation fails preconditions', !ghostPreconditionsMet([ev('MESSAGE', 'INBOUND')]));
  check('ghost: our counter alone fails (no follow-up)', !ghostPreconditionsMet([ev('MESSAGE', 'INBOUND'), ev('OFFER', 'OUTBOUND', cash(1))]));
  check('ghost: our counter + unanswered follow-up passes', ghostPreconditionsMet([ev('MESSAGE', 'INBOUND'), ev('OFFER', 'OUTBOUND', cash(1)), ev('MESSAGE', 'OUTBOUND', { follow_up: true })]));
  check('ghost: missed committed meetup passes', ghostPreconditionsMet([ev('MESSAGE', 'INBOUND'), ev('LOGISTICS', 'OUTBOUND', { kind: 'MEETUP', state: 'MISSED' }, { expects_reply: true })]));
  const resp = deriveResponsiveness({ status: 'OPEN', waiting_on: 'BUYER', last_inbound_at: '2026-10-01T12:00:00Z', last_outbound_at: '2026-10-02T12:00:00Z' }, new Date('2026-10-12T15:00:00Z'), { quietAfterDays: 7 });
  check('responsiveness: QUIET after the user threshold (read-time)', resp.label === 'QUIET' && resp.days_waiting === 10, resp);
  check('responsiveness threshold is a preference', deriveResponsiveness({ status: 'OPEN', waiting_on: 'BUYER', last_inbound_at: null, last_outbound_at: '2026-10-02T12:00:00Z' }, new Date('2026-10-12T15:00:00Z'), { quietAfterDays: 30 }).label === 'AWAITING_BUYER');

  console.log('\n[P5 — snapshot fold + legacy]');
  const s = deriveSnapshot(emptyBaseline(), [ev('OFFER', 'INBOUND', cash(1400)), ev('OFFER', 'OUTBOUND', cash(1800)), ev('OFFER', 'INBOUND', { ...cash(1500), assessment: 'NEAR' })]);
  check('snapshot = latest buyer position; initial/best derived', s.latest_cash_offer === 1500 && s.initial_cash_offer === 1400 && s.best_cash_offer === 1500 && s.offer_type === 'CASH', s);
  check('our counter never becomes the buyer offer', s.latest_cash_offer !== 1800);
  check('assessment from latest buyer offer, AI-sourced', s.offer_assessment === 'NEAR' && s.offer_assessment_source === 'AI');
  const s2 = deriveSnapshot(emptyBaseline(), [ev('OFFER', 'INBOUND', { ...cash(1400), assessment: 'NEAR' }), ev('OFFER', 'INBOUND', cash(1300))]);
  check('new buyer offer without assessment resets it to NULL', s2.offer_assessment === null && s2.offer_assessment_source === null);
  const base = { ...emptyBaseline(), peak_stage: 'NEGOTIATING' as const, peak_stage_source: 'LEGACY_AUDIT' as const, buyer_message_count: 3, our_message_count: 1, first_contact_at: '2026-09-01', last_contact_at: '2026-09-03' };
  const s3 = deriveSnapshot(base, [ev('MESSAGE', 'INBOUND', { substance: 'SUBSTANTIVE' }, { message_count: 2 })]);
  check('legacy baseline: peak kept (LEGACY_AUDIT), counts = baseline + deltas', s3.peak_stage === 'NEGOTIATING' && s3.peak_stage_source === 'LEGACY_AUDIT' && s3.buyer_message_count === 5 && s3.our_message_count === 1, s3);
  const s4 = deriveSnapshot(base, [ev('AGREEMENT', 'OUTBOUND')]);
  check('events raise the peak -> DERIVED with reached_at', s4.peak_stage === 'HIGH_INTENT' && s4.peak_stage_source === 'DERIVED' && s4.peak_stage_at != null);
  check('legacy structured: vague TRADE stays ENGAGED', legacyStructuredStage({ status: 'OPEN', deal_id: null, offer_type: 'MIXED', cash_component: null, initial_cash_offer: null, best_cash_offer: null, trade_item: 'PRS', lead_quality: 'SERIOUS' }) === 'ENGAGED');
  check('legacy structured: AGREED = HIGH_INTENT, COMPLETED = CONVERTED', legacyStructuredStage({ status: 'AGREED', deal_id: null, offer_type: 'NONE', cash_component: null, initial_cash_offer: null, best_cash_offer: null, trade_item: null, lead_quality: 'LOW' }) === 'HIGH_INTENT' && legacyStructuredStage({ status: 'COMPLETED', deal_id: null, offer_type: 'NONE', cash_component: null, initial_cash_offer: null, best_cash_offer: null, trade_item: null, lead_quality: 'LOW' }) === 'CONVERTED');

  console.log('\n[P6 — timestamps / prompt rendering]');
  check('date-only -> DATE precision at 12:00Z', parseOccurredAt('2026-10-12')?.precision === 'DATE' && parseOccurredAt('2026-10-12')?.iso === '2026-10-12T12:00:00.000Z');
  check('naive date-time = Toronto wall time (EDT)', parseOccurredAt('2026-10-12 21:16')?.iso === '2026-10-13T01:16:00.000Z', parseOccurredAt('2026-10-12 21:16'));
  check('explicit offset respected', parseOccurredAt('2026-10-12T21:16:00-04:00')?.iso === '2026-10-13T01:16:00.000Z');
  const prompt = renderLeadSemanticsForPrompt();
  check('semantics render includes every stage + Negotiating+', ['INQUIRY', 'ENGAGED', 'NEGOTIATING', 'HIGH_INTENT', 'CONVERTED', 'Negotiating+'].every((t) => prompt.includes(t)));
}

// ── DB helpers ───────────────────────────────────────────────────────────
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
async function signIn(email: string): Promise<SupabaseClient> {
  const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return c;
}
function psql(sql: string): string {
  return execFileSync('docker', ['exec', '-i', 'supabase_db_my-next-app', 'psql', '-U', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'], { input: sql }).toString().trim();
}

const msg = (direction: 'INBOUND' | 'OUTBOUND', at: string, summary: string, payload: Record<string, unknown> = { substance: 'SUBSTANTIVE' }, o: Partial<AgentEventInput> = {}): AgentEventInput => ({ type: 'MESSAGE', direction, occurred_at: at, summary, payload, ...o });
const offer = (direction: 'INBOUND' | 'OUTBOUND', at: string, summary: string, payload: Record<string, unknown>, o: Partial<AgentEventInput> = {}): AgentEventInput => ({ type: 'OFFER', direction, occurred_at: at, summary, payload, ...o });

async function main() {
  pureChecks();

  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const emailA = 'direct-writes-fixture-a@example.test';
  const emailB = 'direct-writes-fixture-b@example.test';
  const userA = await resolveAppUserId(admin, await ensureAuthUser(admin, emailA));
  const userB = await resolveAppUserId(admin, await ensureAuthUser(admin, emailB));
  const cA = await signIn(emailA);
  const cB = await signIn(emailB);
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });

  let { data: brand } = await admin.from('brands').select('id').limit(1).maybeSingle();
  let createdBrand: number | null = null;
  if (!brand) { brand = (await admin.from('brands').insert({ name: `DW Brand ${uuid().slice(0, 6)}` }).select('id').single()).data; createdBrand = brand!.id as number; }
  const { data: chans } = await admin.from('deal_channels').select('id, name');
  const chanId = (n: string) => (chans ?? []).find((c) => c.name === n)!.id as number;

  const itemIds: number[] = [];
  const dealIds: number[] = [];
  const sourceIds: number[] = [];

  try {
    const item = async (userId: number, model: string, status = 'listed') => {
      const { data, error } = await admin.from('inventory_items').insert({ user_id: userId, brand_id: brand!.id, model, status, serial_number: `DW-${uuid().slice(0, 8)}` }).select('id').single();
      if (error) throw error;
      itemIds.push(data.id as number);
      return data.id as number;
    };
    const deal = async (userId: number, type: string, outItem: number) => {
      const { data, error } = await admin.from('deals').insert({ user_id: userId, deal_type: type, deal_date: '2026-10-15', deal_channel_id: chanId('Marketplace'), cash_paid: 0, cash_received: 100, fees: 0 }).select('id').single();
      if (error) throw error;
      dealIds.push(data.id as number);
      const { error: e2 } = await admin.from('deal_items').insert({ user_id: userId, deal_id: data.id, item_id: outItem, direction: 'out', total_value: 100 });
      if (e2) throw e2;
      return data.id as number;
    };
    const leadRow = async (id: number) => (await admin.from('item_leads').select('*').eq('id', id).single()).data as Record<string, unknown>;
    const eventsOf = async (id: number) => ((await admin.from('lead_events').select('*').eq('item_lead_id', id).order('id')).data ?? []) as Record<string, unknown>[];
    const rec = (client: SupabaseClient, body: Omit<Parameters<typeof recordLeadInteraction>[1], 'mutation_id'> & { mutation_id?: string }) =>
      recordLeadInteraction(client, { mutation_id: body.mutation_id ?? uuid(), ...body } as never, { clientLabel: 'test-suite' });

    const X = await item(userA, 'Jazzmaster (DW)');
    const Y = await item(userA, 'Les Paul (DW)');
    const Z = await item(userA, 'Strat (DW)');
    const Q = await item(userA, 'Telecaster (DW)');
    const BI = await item(userB, 'B item (DW)');

    console.log('\n[W1 — create + update]');
    const r1 = await rec(cA, { lead: { item_id: X, channel: 'Marketplace', contact_name: 'Jane Doe' }, events: [msg('INBOUND', '2026-10-10T14:00:00-04:00', 'Asked about neck profile and frets')] });
    check('new relationship -> APPLIED_CREATE', r1.result === 'APPLIED_CREATE' && r1.matched_by === 'new' && !!r1.lead_id, r1);
    const L1 = r1.lead_id!;
    let row = await leadRow(L1);
    check('direct lead: origin DIRECT, no legacy quality, no source, name DIRECT, key', row.origin === 'DIRECT' && row.lead_quality === null && row.source_id === null && row.contact_name_source === 'DIRECT' && row.contact_key === 'jane doe', row);
    check('stage ENGAGED (DERIVED), waiting_on US, buyer count 1', row.peak_stage === 'ENGAGED' && row.peak_stage_source === 'DERIVED' && row.waiting_on === 'US' && row.buyer_message_count === 1 && row.semantics_version === SEMANTICS_VERSION, row);
    check('notes untouched (null)', row.notes === null);

    const r2 = await rec(cA, { lead: { item_id: X, channel: 'Marketplace', contact_name: '  jane   DOE ' }, events: [offer('INBOUND', '2026-10-11T10:00:00-04:00', 'Offered C$2,800 cash', cash(2800))] });
    check('exact match (case/space) -> APPLIED_UPDATE item_channel_contact', r2.result === 'APPLIED_UPDATE' && r2.lead_id === L1 && r2.matched_by === 'item_channel_contact', r2);
    check('changes report peak ENGAGED -> NEGOTIATING', JSON.stringify(r2.changes?.peak_stage) === JSON.stringify(['ENGAGED', 'NEGOTIATING']), r2.changes);
    row = await leadRow(L1);
    check('snapshot CASH 2800, initial=best=2800, rounds 1', row.offer_type === 'CASH' && Number(row.latest_cash_offer) === 2800 && Number(row.initial_cash_offer) === 2800 && Number(row.best_cash_offer) === 2800 && row.negotiation_rounds === 1, row);

    console.log('\n[W2 — negotiation rounds, several events in one mutation]');
    const r3 = await rec(cA, { lead: { lead_id: L1 }, events: [
      offer('OUTBOUND', '2026-10-11T11:00:00-04:00', 'We countered C$3,000', cash(3000)),
      offer('INBOUND', '2026-10-11T12:00:00-04:00', 'Buyer moved to C$2,900', cash(2900)),
    ] });
    check('two events in one mutation -> APPLIED_UPDATE by lead_id', r3.result === 'APPLIED_UPDATE' && r3.matched_by === 'lead_id' && r3.event_ids?.length === 2, r3);
    row = await leadRow(L1);
    check('latest buyer 2900, initial 2800, best 2900, rounds 3, waiting_on US', Number(row.latest_cash_offer) === 2900 && Number(row.initial_cash_offer) === 2800 && Number(row.best_cash_offer) === 2900 && row.negotiation_rounds === 3 && row.waiting_on === 'US', row);
    check('our messages counted (1), buyer 3', row.our_message_count === 1 && row.buyer_message_count === 3, row);

    const mAgree = uuid();
    const agreeReq = { mutation_id: mAgree, lead: { lead_id: L1 }, events: [
      { type: 'AGREEMENT', direction: 'OUTBOUND', occurred_at: '2026-10-11T13:00:00-04:00', summary: 'We accepted C$2,900', payload: {} },
      { type: 'LOGISTICS', direction: 'INBOUND', occurred_at: '2026-10-11T13:05:00-04:00', summary: 'Pickup Saturday 2pm agreed', payload: { kind: 'MEETUP', state: 'CONFIRMED', scheduled_for: '2026-10-18T14:00:00-04:00' }, expects_reply: false },
    ] as AgentEventInput[] };
    const r4 = await rec(cA, agreeReq);
    row = await leadRow(L1);
    const evs4 = await eventsOf(L1);
    check('agreement -> status AGREED, peak HIGH_INTENT', r4.result === 'APPLIED_UPDATE' && row.status === 'AGREED' && row.peak_stage === 'HIGH_INTENT', { r4, row });
    check('system STATUS_CHANGE OPEN->AGREED recorded with the mutation', evs4.some((e) => e.event_type === 'STATUS_CHANGE' && (e.payload as { to?: string }).to === 'AGREED' && e.mutation_id === mAgree && e.source === 'SYSTEM'));
    check('meetup confirmation without expected reply -> waiting_on NONE', row.waiting_on === 'NONE', row.waiting_on);
    check('client label stored', evs4.some((e) => e.client_label === 'test-suite'));

    console.log('\n[W3 — idempotency + dedupe]');
    const before5 = (await eventsOf(L1)).length;
    const r5 = await rec(cA, agreeReq);
    check('same mutation + same request -> original result replayed', r5.replayed === true && r5.result === 'APPLIED_UPDATE' && JSON.stringify(r5.event_ids) === JSON.stringify(r4.event_ids), r5);
    check('replay wrote nothing', (await eventsOf(L1)).length === before5);
    const r6 = await rec(cA, { ...agreeReq, events: [msg('INBOUND', '2026-10-11T13:10:00-04:00', 'Different content')] });
    check('same mutation + different request -> REJECTED MUTATION_ID_REUSED', r6.result === 'REJECTED' && r6.reason === 'MUTATION_ID_REUSED', r6);
    const r7 = await rec(cA, { lead: { lead_id: L1 }, events: [offer('INBOUND', '2026-10-11T12:00:00-04:00', 'Buyer moved to C$2,900', cash(2900))] });
    check('same screenshot under a new mutation_id -> NO_CHANGE', r7.result === 'NO_CHANGE' && r7.reason === 'DUPLICATE_EVENTS', r7);
    const r8 = await rec(cA, { lead: { lead_id: L1 }, events: [msg('INBOUND', '2026-10-12T09:00:00-04:00', 'Still on for Saturday?', { substance: 'BASIC' })] });
    const r8b = await rec(cA, { lead: { lead_id: L1 }, events: [msg('INBOUND', '2026-10-13T09:00:00-04:00', 'Still on for Saturday?', { substance: 'BASIC' })] });
    check('identical-looking message at a different time is NOT deduped', r8.result === 'APPLIED_UPDATE' && r8b.result === 'APPLIED_UPDATE', [r8.result, r8b.result]);
    const dry = await rec(cA, { lead: { lead_id: L1 }, events: [msg('INBOUND', '2026-10-14T09:00:00-04:00', 'dry run message')], dry_run: true });
    check('dry_run returns the would-be result and writes nothing', dry.dry_run === true && dry.result === 'APPLIED_UPDATE' && !(await eventsOf(L1)).some((e) => e.summary === 'dry run message'), dry);

    console.log('\n[W4 — qualifiers, possible matches, review + resolution]');
    const n1 = await rec(cA, { lead: { item_id: Y, channel: 'Kijiji', contact_name: 'Nick (collector)' }, events: [offer('INBOUND', '2026-10-05', 'LP + 500', trade(['Les Paul Standard'], 'AMOUNT', 500))] });
    const n2 = await rec(cA, { lead: { item_id: Y, channel: 'Kijiji', contact_name: 'Nick (ES-325)' }, events: [offer('INBOUND', '2026-10-06', 'ES-325 straight', trade(['ES-325'], 'STRAIGHT'))] });
    check('Nick (collector) and Nick (ES-325) are two distinct leads', n1.result === 'APPLIED_CREATE' && n2.result === 'APPLIED_CREATE' && n1.lead_id !== n2.lead_id, [n1, n2]);
    const mNick = uuid();
    const nickReq = { mutation_id: mNick, lead: { item_id: Y, channel: 'Kijiji' as const, contact_name: 'Nick' }, events: [msg('INBOUND', '2026-10-07', 'Is it available?', { substance: 'BASIC' })] };
    const n3 = await rec(cA, nickReq);
    check('bare "Nick" -> REVIEW POSSIBLE_DUPLICATE with both candidates', n3.result === 'REVIEW_REQUIRED' && n3.reason === 'POSSIBLE_DUPLICATE' && (n3.candidates ?? []).length === 2 && (n3.allowed_resolutions ?? []).includes('CREATE_NEW'), n3);
    check('review wrote nothing', (await admin.from('lead_events').select('id').eq('mutation_id', mNick)).data?.length === 0);
    const n4 = await rec(cA, { ...nickReq, resolution: { action: 'USE_LEAD', lead_id: n1.lead_id } });
    check('resolution USE_LEAD appends to the chosen lead', n4.result === 'APPLIED_UPDATE' && n4.lead_id === n1.lead_id && n4.matched_by === 'resolution', n4);
    const n5 = await rec(cA, nickReq);
    check('retry of the original call (same mutation_id) replays the applied result', n5.replayed === true && n5.lead_id === n1.lead_id, n5);
    const js = await rec(cA, { lead: { item_id: Y, channel: 'Kijiji', contact_name: 'John Smith' }, events: [msg('INBOUND', '2026-10-05', 'q')] });
    const j2 = await rec(cA, { lead: { item_id: Y, channel: 'Kijiji', contact_name: 'John' }, events: [msg('INBOUND', '2026-10-06', 'q2')] });
    check('first name only vs full name -> REVIEW POSSIBLE_DUPLICATE', js.result === 'APPLIED_CREATE' && j2.result === 'REVIEW_REQUIRED' && j2.reason === 'POSSIBLE_DUPLICATE', j2);
    const j3 = await rec(cA, { lead: { item_id: Y, channel: 'Kijiji', contact_name: 'John' }, events: [msg('INBOUND', '2026-10-06', 'q2')], resolution: { action: 'CREATE_NEW' } });
    check('resolution CREATE_NEW creates a separate lead', j3.result === 'APPLIED_CREATE' && j3.lead_id !== js.lead_id, j3);

    console.log('\n[W4b — non-unique display name (KijijiUser) never auto-matches]');
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
    const K = await item(userA, 'Bluesbreaker (DW)');
    const k1 = await rec(cA, { lead: { item_id: K, channel: 'Kijiji', contact_name: 'KijijiUser' }, events: [msg('INBOUND', daysAgo(2), 'What is the approximate value?', { substance: 'BASIC' })] });
    const k1Row = k1.lead_id ? await leadRow(k1.lead_id) : {};
    check('first KijijiUser on item/Kijiji -> APPLIED_CREATE, name stored as-is', k1.result === 'APPLIED_CREATE' && k1Row.contact_name === 'KijijiUser' && k1Row.contact_key === 'kijijiuser' && k1Row.status === 'OPEN', [k1, k1Row]);
    const k1Events = (await eventsOf(k1.lead_id!)).length;
    const mK = uuid();
    const kReq = { mutation_id: mK, lead: { item_id: K, channel: 'Kijiji' as const, contact_name: 'kijijiuser' }, events: [offer('INBOUND', daysAgo(1), 'Offered C$4,000 cash', cash(4000))] };
    const k2 = await rec(cA, kReq);
    check('recent OPEN KijijiUser lead is NOT auto-matched -> REVIEW POSSIBLE_DIFFERENT_PERSON', k2.result === 'REVIEW_REQUIRED' && k2.reason === 'POSSIBLE_DIFFERENT_PERSON' && /non-unique/.test(k2.message ?? ''), k2);
    check('review carries the candidate and USE_LEAD / CREATE_NEW', (k2.candidates ?? []).length === 1 && k2.candidates![0].lead_id === k1.lead_id && ['USE_LEAD', 'CREATE_NEW'].every((a) => (k2.allowed_resolutions ?? []).includes(a as never)), k2);
    check('review wrote nothing', (await admin.from('lead_events').select('id').eq('mutation_id', mK)).data?.length === 0 && (await eventsOf(k1.lead_id!)).length === k1Events);
    const kConfirm = await rec(cA, { ...kReq, mutation_id: uuid(), resolution: { action: 'CONFIRM' } });
    check('CONFIRM does not bypass the non-unique rule', kConfirm.result === 'REVIEW_REQUIRED' && kConfirm.reason === 'POSSIBLE_DIFFERENT_PERSON', kConfirm);
    const k3 = await rec(cA, { ...kReq, resolution: { action: 'USE_LEAD', lead_id: k1.lead_id } });
    check('USE_LEAD appends to the chosen KijijiUser lead', k3.result === 'APPLIED_UPDATE' && k3.lead_id === k1.lead_id && k3.matched_by === 'resolution' && (await eventsOf(k1.lead_id!)).length === k1Events + 1, k3);
    const k1After = (await eventsOf(k1.lead_id!)).length;
    const kOther = { lead: { item_id: K, channel: 'Kijiji' as const, contact_name: 'KijijiUser' }, events: [offer('INBOUND', daysAgo(0), 'Different person: offered a Tele straight trade', trade(['Telecaster'], 'STRAIGHT'))] };
    const k4 = await rec(cA, kOther);
    const k5 = await rec(cA, { ...kOther, resolution: { action: 'CREATE_NEW' } });
    const k5Row = k5.lead_id ? await leadRow(k5.lead_id) : {};
    check('another KijijiUser -> REVIEW, then CREATE_NEW makes a second independent lead', k4.result === 'REVIEW_REQUIRED' && k5.result === 'APPLIED_CREATE' && k5.lead_id !== k1.lead_id && k5Row.contact_name === 'KijijiUser' && k5Row.inventory_item_id === K, [k4, k5]);
    check('the two KijijiUser leads stay independent', (await eventsOf(k1.lead_id!)).length === k1After && (await eventsOf(k5.lead_id!)).every((e) => e.summary !== 'Offered C$4,000 cash') && Number((await leadRow(k1.lead_id!)).latest_cash_offer) === 4000 && (await leadRow(k5.lead_id!)).offer_type === 'TRADE');
    const k6 = await rec(cA, { lead: { item_id: K, channel: 'Kijiji', contact_name: 'KijijiUser' }, events: [msg('INBOUND', daysAgo(0), 'still available?', { substance: 'BASIC' })] });
    check('two KijijiUser leads -> REVIEW MULTIPLE_CONTACT_MATCHES', k6.result === 'REVIEW_REQUIRED' && k6.reason === 'MULTIPLE_CONTACT_MATCHES', k6);
    for (const [name, channel] of [['Johnny Caleb', 'Kijiji'], ['JJ', 'Kijiji'], ['CT', 'Marketplace'], ['KijijiUser', 'Marketplace']] as const) {
      const KI = await item(userA, `${name} scope (DW)`); // fresh item: no cross-channel siblings
      const a1 = await rec(cA, { lead: { item_id: KI, channel, contact_name: name }, events: [msg('INBOUND', daysAgo(2), `${name} first message`, { substance: 'BASIC' })] });
      const a2 = await rec(cA, { lead: { item_id: KI, channel, contact_name: name }, events: [msg('INBOUND', daysAgo(1), `${name} follow-up`, { substance: 'BASIC' })] });
      check(`"${name}" on ${channel}: normal auto-match unchanged (APPLIED_UPDATE item_channel_contact)`, a1.result === 'APPLIED_CREATE' && a2.result === 'APPLIED_UPDATE' && a2.lead_id === a1.lead_id && a2.matched_by === 'item_channel_contact', [a1, a2]);
    }

    console.log('\n[W5 — channels, cross-channel, cross-item]');
    const cc = await rec(cA, { lead: { item_id: X, channel: 'Kijiji', contact_name: 'Jane Doe' }, events: [msg('INBOUND', '2026-10-12', 'hi')] });
    check('same contact on another channel -> REVIEW CROSS_CHANNEL_MATCH', cc.result === 'REVIEW_REQUIRED' && cc.reason === 'CROSS_CHANNEL_MATCH', cc);
    const ig = await rec(cA, { lead: { item_id: Q, channel: 'Other', channel_detail: 'Instagram', contact_name: 'Sam Lee' }, events: [msg('INBOUND', '2026-10-12', 'ig dm')] });
    const sms = await rec(cA, { lead: { item_id: Q, channel: 'Other', channel_detail: 'SMS', contact_name: 'Sam Lee' }, events: [msg('INBOUND', '2026-10-12', 'sms')] });
    check('Other/Instagram created; Other/SMS same name is NOT auto-merged (REVIEW)', ig.result === 'APPLIED_CREATE' && sms.result === 'REVIEW_REQUIRED' && sms.reason === 'CROSS_CHANNEL_MATCH', [ig, sms]);
    check('channel_detail stored on the lead', (await leadRow(ig.lead_id!)).channel_detail === 'Instagram');
    const badDetail = await rec(cA, { lead: { item_id: Q, channel: 'Marketplace', channel_detail: 'Group', contact_name: 'Pat Kim' }, events: [msg('INBOUND', '2026-10-12', 'x')] });
    check('channel_detail on Marketplace -> REJECTED VALIDATION_ERROR', badDetail.result === 'REJECTED' && badDetail.reason === 'VALIDATION_ERROR', badDetail);
    const xi = await rec(cA, { lead: { item_id: Y, channel: 'Marketplace', contact_name: 'Jane Doe' }, events: [msg('INBOUND', '2026-10-12', 'interested in the LP too')] });
    check('same contact on another item -> created, related context returned (not blocked)', xi.result === 'APPLIED_CREATE' && (xi.related_contacts ?? []).some((r) => r.lead_id === L1), xi);

    console.log('\n[W6 — missing contact / placeholders / invalid input]');
    const nm = await rec(cA, { lead: { item_id: Q, channel: 'Reverb' }, events: [offer('INBOUND', '2026-10-12', 'Reverb offer C$1,500', cash(1500))] });
    const ph = await rec(cA, { lead: { item_id: Q, channel: 'Reverb', contact_name: 'Unknown' }, events: [offer('INBOUND', '2026-10-12', 'Reverb offer C$1,500', cash(1500))] });
    check('no name -> REVIEW CONTACT_NAME_MISSING; placeholder "Unknown" too', nm.reason === 'CONTACT_NAME_MISSING' && ph.reason === 'CONTACT_NAME_MISSING' && nm.result === 'REVIEW_REQUIRED', [nm, ph]);
    const un = await rec(cA, { lead: { item_id: Q, channel: 'Reverb' }, events: [offer('INBOUND', '2026-10-12', 'Reverb offer C$1,500', cash(1500))], resolution: { action: 'CREATE_UNNAMED' } });
    check('CREATE_UNNAMED creates a lead with no contact identity', un.result === 'APPLIED_CREATE' && (await leadRow(un.lead_id!)).contact_name === null && (await leadRow(un.lead_id!)).contact_key === null, un);
    const foreignItem = await rec(cA, { lead: { item_id: BI, channel: 'Marketplace', contact_name: 'Jane Doe' }, events: [msg('INBOUND', '2026-10-12', 'x')] });
    const missingItem = await rec(cA, { lead: { item_id: 999999999, channel: 'Marketplace', contact_name: 'Jane Doe' }, events: [msg('INBOUND', '2026-10-12', 'x')] });
    check('foreign item and nonexistent item are indistinguishable (ITEM_NOT_FOUND)', foreignItem.reason === 'ITEM_NOT_FOUND' && missingItem.reason === 'ITEM_NOT_FOUND' && foreignItem.message?.replace(String(BI), '#') === missingItem.message?.replace('999999999', '#'), [foreignItem, missingItem]);
    const legacyType = await rec(cA, { lead: { lead_id: L1 }, events: [{ type: 'LEGACY_SNAPSHOT' as never, direction: 'INTERNAL', occurred_at: '2026-10-12', summary: 'x', payload: {} }] });
    check('LEGACY_SNAPSHOT cannot be submitted', legacyType.result === 'REJECTED' && legacyType.reason === 'VALIDATION_ERROR', legacyType);
    const badOffer = await rec(cA, { lead: { lead_id: L1 }, events: [offer('INBOUND', '2026-10-12', 'x', { offer: { cash_terms: 'AMOUNT', items: [] } })] });
    check('malformed offer -> REJECTED VALIDATION_ERROR', badOffer.reason === 'VALIDATION_ERROR', badOffer);
    const future = await rec(cA, { lead: { lead_id: L1 }, events: [msg('INBOUND', '2030-01-01', 'future')] });
    check('future occurred_at rejected', future.reason === 'VALIDATION_ERROR', future);

    console.log('\n[W7 — stage rules end-to-end]');
    const ui = await rec(cA, { lead: { item_id: Q, channel: 'Marketplace', contact_name: 'Ivy Davis' }, events: [offer('OUTBOUND', '2026-10-12T21:00:00-04:00', 'We proposed our Studio for their Strat', trade(['Fender Strat'], 'STRAIGHT'))] });
    check('user-initiated outbound proposal alone: INQUIRY, waiting on BUYER', ui.result === 'APPLIED_CREATE' && (await leadRow(ui.lead_id!)).peak_stage === 'INQUIRY' && (await leadRow(ui.lead_id!)).waiting_on === 'BUYER', await leadRow(ui.lead_id!));
    await rec(cA, { lead: { lead_id: ui.lead_id }, events: [msg('INBOUND', '2026-10-12T21:16:00-04:00', '"yea I think I would"', { substance: 'BASIC', responds_to_offer: true })] });
    check('buyer engages with our proposal -> NEGOTIATING', (await leadRow(ui.lead_id!)).peak_stage === 'NEGOTIATING');
    const lb = await rec(cA, { lead: { item_id: Q, channel: 'Kijiji', contact_name: 'Lowball Larry' }, events: [offer('INBOUND', '2026-10-12', 'C$110 on a C$180 ask', { ...cash(110), assessment: 'FAR_BELOW' }, { message_count: 1 })] });
    const lbRow = await leadRow(lb.lead_id!);
    check('lowball: NEGOTIATING + FAR_BELOW (AI)', lbRow.peak_stage === 'NEGOTIATING' && lbRow.offer_assessment === 'FAR_BELOW' && lbRow.offer_assessment_source === 'AI', lbRow);
    await rec(cA, { lead: { lead_id: lb.lead_id }, events: [offer('INBOUND', '2026-10-13', 'C$120 now', cash(120))] });
    check('new buyer offer without assessment resets it', (await leadRow(lb.lead_id!)).offer_assessment === null);
    const chatty = await rec(cA, { lead: { item_id: Q, channel: 'Kijiji', contact_name: 'Chatty Cathy' }, events: [msg('INBOUND', '2026-10-12', 'lots of small talk', { substance: 'BASIC' }, { message_count: 25 })] });
    check('25 basic messages: still INQUIRY, count 25', (await leadRow(chatty.lead_id!)).peak_stage === 'INQUIRY' && (await leadRow(chatty.lead_id!)).buyer_message_count === 25);

    console.log('\n[W8 — ghosting + reopen]');
    const g = await rec(cA, { lead: { item_id: Z, channel: 'Marketplace', contact_name: 'Gary Ghost' }, events: [offer('INBOUND', '2026-10-01', 'Offered C$700', cash(700))] });
    const gNo = await rec(cA, { lead: { lead_id: g.lead_id }, events: [{ type: 'STATUS_CHANGE', direction: 'INTERNAL', occurred_at: '2026-10-09', summary: 'Mark ghosted', payload: { to: 'GHOSTED', outcome_reason: 'UNKNOWN' } }] });
    check('GHOSTED without our pending ask -> REVIEW GHOST_PRECONDITIONS_UNMET', gNo.result === 'REVIEW_REQUIRED' && gNo.reason === 'GHOST_PRECONDITIONS_UNMET', gNo);
    await rec(cA, { lead: { lead_id: g.lead_id }, events: [offer('OUTBOUND', '2026-10-02', 'Countered C$800', cash(800)), msg('OUTBOUND', '2026-10-05', 'Following up — still interested?', { substance: 'BASIC', follow_up: true })] });
    check('unanswered_followups = 1, waiting on BUYER', (await leadRow(g.lead_id!)).unanswered_followups === 1 && (await leadRow(g.lead_id!)).waiting_on === 'BUYER');
    const gYes = await rec(cA, { lead: { lead_id: g.lead_id }, events: [{ type: 'STATUS_CHANGE', direction: 'INTERNAL', occurred_at: '2026-10-09', summary: 'Mark ghosted', payload: { to: 'GHOSTED', outcome_reason: 'UNKNOWN' } }] });
    check('GHOSTED with objective preconditions -> applied, waiting_on NONE', gYes.result === 'APPLIED_UPDATE' && (await leadRow(g.lead_id!)).status === 'GHOSTED' && (await leadRow(g.lead_id!)).waiting_on === 'NONE', gYes);
    const back = await rec(cA, { lead: { item_id: Z, channel: 'Marketplace', contact_name: 'Gary Ghost' }, events: [msg('INBOUND', '2026-10-12', 'Sorry, been busy — still available?', { substance: 'BASIC' })] });
    row = await leadRow(g.lead_id!);
    check('returning buyer reopens the ghosted lead (reopen_count 1, followups reset)', back.result === 'APPLIED_UPDATE' && row.status === 'OPEN' && row.reopen_count === 1 && row.unanswered_followups === 0 && row.waiting_on === 'US', { back, row });

    console.log('\n[W9 — deal linking, COMPLETED, final leads]');
    const noDeal = await rec(cA, { lead: { lead_id: g.lead_id }, events: [{ type: 'STATUS_CHANGE', direction: 'INTERNAL', occurred_at: '2026-10-12', summary: 'done', payload: { to: 'COMPLETED' } }] });
    check('COMPLETED without a deal -> REJECTED DEAL_REQUIRED', noDeal.result === 'REJECTED' && noDeal.reason === 'DEAL_REQUIRED', noDeal);
    const wrongDeal = await deal(userA, 'sale', Y);
    const badLink = await rec(cA, { lead: { lead_id: g.lead_id }, events: [{ type: 'DEAL_LINKED', direction: 'INTERNAL', occurred_at: '2026-10-12', summary: 'link', payload: { deal_id: wrongDeal } }] });
    check('deal without this item on its outgoing side -> REJECTED DEAL_NOT_VALID', badLink.result === 'REJECTED' && badLink.reason === 'DEAL_NOT_VALID', badLink);

    // Auto-close: OPEN leads closed, AGREED + DECLINED untouched.
    const agreed = await rec(cA, { lead: { item_id: Z, channel: 'Kijiji', contact_name: 'Alice Agreed' }, events: [offer('INBOUND', '2026-10-10', 'C$750', cash(750)), { type: 'AGREEMENT', direction: 'OUTBOUND', occurred_at: '2026-10-10', summary: 'accepted', payload: {} }] });
    const declined = await rec(cA, { lead: { item_id: Z, channel: 'Reverb', contact_name: 'Dan Declined' }, events: [offer('INBOUND', '2026-10-10', 'C$500', cash(500)), { type: 'STATUS_CHANGE', direction: 'INTERNAL', occurred_at: '2026-10-10', summary: 'too low', payload: { to: 'DECLINED_BY_ME', outcome_reason: 'LOW_OFFER' } }] });
    const saleZ = await deal(userA, 'sale', Z);
    const { error: soldErr } = await admin.from('inventory_items').update({ status: 'sold' }).eq('id', Z);
    check('item marked sold', !soldErr, soldErr);
    const gRow = await leadRow(g.lead_id!);
    check('OPEN lead -> CLOSED / ITEM_UNAVAILABLE, waiting_on NONE', gRow.status === 'CLOSED' && gRow.outcome_reason === 'ITEM_UNAVAILABLE' && gRow.waiting_on === 'NONE', gRow);
    check('SYSTEM STATUS_CHANGE event written for the close', (await eventsOf(g.lead_id!)).some((e) => e.event_type === 'STATUS_CHANGE' && e.source === 'SYSTEM' && (e.payload as { trigger?: string }).trigger === 'AUTO_ITEM_UNAVAILABLE'));
    check('AGREED lead NOT auto-closed', (await leadRow(agreed.lead_id!)).status === 'AGREED');
    check('DECLINED lead untouched', (await leadRow(declined.lead_id!)).status === 'DECLINED_BY_ME' && (await leadRow(declined.lead_id!)).outcome_reason === 'LOW_OFFER');
    const flag = await rec(cA, { lead: { lead_id: agreed.lead_id }, events: [{ type: 'NOTE', direction: 'INTERNAL', occurred_at: '2026-10-15', summary: 'checking in', payload: {} }] });
    check('AGREED lead on a sold item is flagged ITEM_UNAVAILABLE_WHILE_AGREED', (flag.warnings ?? []).includes('ITEM_UNAVAILABLE_WHILE_AGREED'), flag);
    const win = await rec(cA, { lead: { lead_id: g.lead_id }, events: [{ type: 'DEAL_LINKED', direction: 'INTERNAL', occurred_at: '2026-10-15', summary: 'Sold to Gary', payload: { deal_id: saleZ } }] });
    row = await leadRow(g.lead_id!);
    check('winning buyer: CLOSED/ITEM_UNAVAILABLE -> COMPLETED via DEAL_LINKED, CONVERTED', win.result === 'APPLIED_UPDATE' && row.status === 'COMPLETED' && row.outcome_reason === null && Number(row.deal_id) === saleZ && row.peak_stage === 'CONVERTED', { win, row });
    const conflict = await rec(cA, { lead: { lead_id: agreed.lead_id }, events: [{ type: 'DEAL_LINKED', direction: 'INTERNAL', occurred_at: '2026-10-15', summary: 'link too', payload: { deal_id: saleZ } }] });
    check('second lead claiming the same item deal -> REVIEW DEAL_LINK_CONFLICT', conflict.result === 'REVIEW_REQUIRED' && conflict.reason === 'DEAL_LINK_CONFLICT', conflict);
    const fin = await rec(cA, { lead: { item_id: Z, channel: 'Marketplace', contact_name: 'Gary Ghost' }, events: [msg('INBOUND', '2026-10-16', 'Thanks again, love it', { substance: 'BASIC' })] });
    check('new buyer activity on a COMPLETED lead -> REVIEW EVENT_ON_FINAL_LEAD', fin.result === 'REVIEW_REQUIRED' && fin.reason === 'EVENT_ON_FINAL_LEAD', fin);
    const reopenC = await rec(cA, { lead: { lead_id: g.lead_id }, events: [{ type: 'STATUS_CHANGE', direction: 'INTERNAL', occurred_at: '2026-10-16', summary: 'reopen', payload: { to: 'OPEN' } }] });
    check('COMPLETED -> OPEN is a DESTRUCTIVE_TRANSITION review', reopenC.result === 'REVIEW_REQUIRED' && reopenC.reason === 'DESTRUCTIVE_TRANSITION', reopenC);
    check('completed lead untouched by later auto-close paths', (await leadRow(g.lead_id!)).status === 'COMPLETED');

    console.log('\n[W10 — void (correction)]');
    const voidTarget = (await eventsOf(L1)).find((e) => e.event_type === 'OFFER' && (e.payload as { offer?: { cash_amount?: number } }).offer?.cash_amount === 2900)!;
    const verNow = (await leadRow(L1)).version as number;
    const vStale = await voidLeadEvent(cA, { mutation_id: uuid(), event_id: voidTarget.id as number, reason: 'logged twice by mistake', expected_version: verNow - 1 });
    check('stale expected_version -> REJECTED CONCURRENT_UPDATE (retryable)', vStale.result === 'REJECTED' && vStale.reason === 'CONCURRENT_UPDATE' && vStale.retryable === true && vStale.current_version === verNow, vStale);
    const mVoid = uuid();
    const v1 = await voidLeadEvent(cA, { mutation_id: mVoid, event_id: voidTarget.id as number, reason: 'buyer never sent 2900', expected_version: verNow });
    row = await leadRow(L1);
    check('void -> APPLIED_UPDATE; snapshot recomputed (latest 2800, best 2800, rounds 2)', v1.result === 'APPLIED_UPDATE' && Number(row.latest_cash_offer) === 2800 && Number(row.best_cash_offer) === 2800 && row.negotiation_rounds === 2, { v1, row });
    const voided = (await eventsOf(L1)).find((e) => e.id === voidTarget.id)!;
    check('event kept (never deleted) with void markers', voided.voided_at != null && voided.void_reason === 'buyer never sent 2900' && voided.voided_by_mutation_id === mVoid);
    const v2 = await voidLeadEvent(cA, { mutation_id: mVoid, event_id: voidTarget.id as number, reason: 'buyer never sent 2900', expected_version: verNow });
    check('void replay -> replayed', v2.replayed === true, v2);
    const v3 = await voidLeadEvent(cA, { mutation_id: uuid(), event_id: voidTarget.id as number, reason: 'again', expected_version: row.version as number });
    check('void of an already-voided event -> NO_CHANGE', v3.result === 'NO_CHANGE', v3);
    const agreementEv = (await eventsOf(L1)).find((e) => e.event_type === 'AGREEMENT')!;
    const v4 = await voidLeadEvent(cA, { mutation_id: uuid(), event_id: agreementEv.id as number, reason: 'not actually agreed', expected_version: row.version as number });
    check('voiding an AGREEMENT without confirm -> REVIEW DESTRUCTIVE_TRANSITION', v4.result === 'REVIEW_REQUIRED' && v4.reason === 'DESTRUCTIVE_TRANSITION', v4);
    const v5 = await voidLeadEvent(cA, { mutation_id: uuid(), event_id: agreementEv.id as number, reason: 'not actually agreed', expected_version: row.version as number, confirm: true });
    row = await leadRow(L1);
    check('confirmed void of AGREEMENT: caused status change voided too, back to OPEN, peak recomputed to NEGOTIATING', v5.result === 'APPLIED_UPDATE' && row.status === 'OPEN' && row.peak_stage === 'NEGOTIATING' && (v5.voided_event_ids ?? []).length === 2, { v5, row });
    const legacySnapVoid = await voidLeadEvent(cA, { mutation_id: uuid(), event_id: 1, reason: 'nope', expected_version: 1 });
    check('void of a foreign/nonexistent event id -> REJECTED EVENT_NOT_FOUND', legacySnapVoid.result === 'REJECTED' && legacySnapVoid.reason === 'EVENT_NOT_FOUND', legacySnapVoid);

    console.log('\n[W11 — concurrency]');
    const before11 = (await leadRow(L1)).version as number;
    const [c1, c2] = await Promise.all([
      rec(cA, { lead: { lead_id: L1 }, events: [msg('INBOUND', '2026-10-15T10:00:00-04:00', 'parallel one')] }),
      rec(cA, { lead: { lead_id: L1 }, events: [msg('INBOUND', '2026-10-15T10:01:00-04:00', 'parallel two')] }),
    ]);
    const after11 = await leadRow(L1);
    check('two concurrent writes on the same lead both apply (one rebased)', c1.result === 'APPLIED_UPDATE' && c2.result === 'APPLIED_UPDATE', [c1, c2]);
    check('version advanced by exactly 2 and both events present', (after11.version as number) === before11 + 2 && (await eventsOf(L1)).filter((e) => String(e.summary).startsWith('parallel')).length === 2, after11.version);
    const { data: stale } = await cA.rpc('apply_lead_interaction', { p_request: { mode: 'update', mutation_id: uuid(), lead_id: L1, expected_version: before11, snapshot: {}, events: [] } });
    check('stale expected_version at the DB -> CONFLICT (nothing written)', (stale as { status?: string })?.status === 'CONFLICT', stale);
    const P = await item(userA, 'Race item (DW)');
    const race = await rec(cA, { lead: { item_id: P, channel: 'Marketplace', contact_name: 'Rachel Race' }, events: [msg('INBOUND', '2026-10-14', 'first')] });
    const [raceWrite, raceSold] = await Promise.all([
      rec(cA, { lead: { lead_id: race.lead_id }, events: [msg('INBOUND', '2026-10-15', 'during sale')] }),
      admin.from('inventory_items').update({ status: 'sold' }).eq('id', P),
    ]);
    const raceRow = await leadRow(race.lead_id!);
    check('auto-close concurrent with an interaction: no error, lead ends CLOSED, history consistent', !raceSold.error && ['APPLIED_UPDATE', 'REVIEW_REQUIRED'].includes(raceWrite.result) && raceRow.status === 'CLOSED', { raceWrite, raceRow });

    console.log('\n[W12 — legacy (Sheet) lead: first direct write baselines it]');
    const { data: src } = await admin.from('lead_import_sources').upsert({ user_id: userA, source_code: 'GT_LEAD_LOG', provider: 'GOOGLE_SHEETS', source_name: 'DW', spreadsheet_id: `dw-${userA}`, sheet_name: 'Leads', is_enabled: true }, { onConflict: 'user_id,source_code' }).select('id').single();
    sourceIds.push(src!.id as number);
    const { data: legacy, error: legacyErr } = await admin.from('item_leads').insert({
      user_id: userA, source_id: src!.id, inventory_item_id: Q, lead_id: uuid(), source_channel: 'Kijiji', deal_channel_id: chanId('Kijiji'),
      lead_quality: 'SERIOUS', offer_type: 'TRADE', trade_item: 'Old PRS', cash_component: 0, status: 'OPEN', notes: 'Legacy prose note — must survive.',
      buyer_message_count: 3, our_message_count: 1, first_contact_at: '2026-09-01', last_contact_at: '2026-09-03', contact_name: 'Leo Legacy', contact_name_source: 'LEAD_LOG',
      contact_key: 'leo legacy', peak_stage: 'NEGOTIATING', peak_stage_source: 'LEGACY_AUDIT', source_updated_at: '2026-09-03T00:00:00Z',
    }).select('id').single();
    check('legacy lead inserted', !legacyErr, legacyErr);
    const lg = await rec(cA, { lead: { item_id: Q, channel: 'Kijiji', contact_name: 'leo LEGACY' }, events: [msg('INBOUND', '2026-10-14', 'Back again — still have it?', { substance: 'SUBSTANTIVE' }, { message_count: 2 })] });
    const lgRow = await leadRow(legacy!.id as number);
    const lgEvents = await eventsOf(legacy!.id as number);
    check('matched the legacy lead; LEGACY_SNAPSHOT synthesized first (seq 0, SYSTEM)', lg.result === 'APPLIED_UPDATE' && lgEvents[0].event_type === 'LEGACY_SNAPSHOT' && lgEvents[0].mutation_seq === 0 && lgEvents[0].source === 'SYSTEM', lgEvents.map((e) => e.event_type));
    check('counts = legacy 3/1 + 2 buyer; peak kept LEGACY_AUDIT NEGOTIATING; legacy quality + notes untouched', lgRow.buyer_message_count === 5 && lgRow.our_message_count === 1 && lgRow.peak_stage === 'NEGOTIATING' && lgRow.peak_stage_source === 'LEGACY_AUDIT' && lgRow.lead_quality === 'SERIOUS' && lgRow.notes === 'Legacy prose note — must survive.', lgRow);
    check('legacy lead is now direct-owned (last_write_source MCP), source_updated_at advanced', lgRow.last_write_source === 'MCP' && Date.parse(String(lgRow.source_updated_at)) > Date.parse('2026-10-01'), lgRow);

    console.log('\n[W14 — read tools: get_item_context (full notes + events), get_lead_activity, find_contact_history]');
    const longNote = 'Long legacy narrative. ' + 'Detail about frets, case, serial and negotiation. '.repeat(40);
    await admin.from('item_leads').update({ notes: longNote }).eq('id', legacy!.id as number);
    const ctxQ = await getItemContextForMcp(cA, Q, {}, new Date('2026-10-21T15:00:00Z'));
    check('get_item_context returns structured JSON with item_context text + leads', !!ctxQ && !('error' in ctxQ) && typeof ctxQ.item_context === 'string' && Array.isArray(ctxQ.leads), ctxQ && 'error' in ctxQ ? ctxQ : null);
    const okCtx = ctxQ as Exclude<typeof ctxQ, null | { error: 'LEAD_NOT_FOUND' }>;
    const lgView = okCtx.leads.find((l) => l.lead_id === legacy!.id)!;
    check(`full legacy notes are returned untruncated (${longNote.trim().length} chars)`, lgView.legacy_notes === longNote && lgView.legacy_notes!.length > 1500, lgView.legacy_notes?.length);
    check('item_context text no longer carries the compact 200-char lead notes', !okCtx.item_context.includes('Note: Long legacy narrative'));
    check('per-lead snapshot fields present', lgView.peak_stage === 'NEGOTIATING' && lgView.legacy_quality === 'SERIOUS' && lgView.responsiveness.waiting_on === 'US' && typeof lgView.version === 'number' && Array.isArray(lgView.needs_resolution), lgView);
    check('events included with explicit totals', lgView.events_total >= 2 && lgView.events.some((e) => e.type === 'LEGACY_SNAPSHOT') && lgView.events_omitted === 0, { total: lgView.events_total, omitted: lgView.events_omitted });
    // Event cap policy: > 20 events on an active lead -> capped, omitted stated, full_history returns all.
    const many = await rec(cA, { lead: { item_id: Q, channel: 'Kijiji', contact_name: 'Mia Many' }, events: Array.from({ length: 10 }, (_, i) => msg('INBOUND', `2026-10-0${1 + (i % 9)}T1${i}:00:00-04:00`, `message ${i}`, { substance: 'BASIC' })) });
    await rec(cA, { lead: { lead_id: many.lead_id }, events: Array.from({ length: 10 }, (_, i) => msg('OUTBOUND', `2026-10-1${i}T09:00:00-04:00`, `reply ${i}`, { substance: 'BASIC' }, { expects_reply: false })) });
    await rec(cA, { lead: { lead_id: many.lead_id }, events: Array.from({ length: 5 }, (_, i) => msg('INBOUND', `2026-10-20T0${i}:00:00-04:00`, `late ${i}`, { substance: 'BASIC' })) });
    const capped = (await getItemContextForMcp(cA, Q, { lead_id: many.lead_id })) as typeof okCtx;
    const mv = capped.leads[0];
    check('lead_id filter returns only that lead', capped.leads.length === 1 && mv.lead_id === many.lead_id);
    check('default policy caps an active lead at 20 events and states events_omitted', mv.events.length === 20 && mv.events_total === 25 && mv.events_omitted === 5, { shown: mv.events.length, total: mv.events_total, omitted: mv.events_omitted });
    const fullH = (await getItemContextForMcp(cA, Q, { lead_id: many.lead_id, full_history: true })) as typeof okCtx;
    check('full_history returns every event', fullH.leads[0].events.length === 25 && fullH.leads[0].events_omitted === 0);
    const voidedView = (await getItemContextForMcp(cA, X, { lead_id: L1, full_history: true })) as typeof okCtx;
    check('full_history includes voided events flagged with their reason', voidedView.leads[0].events.some((e) => e.voided && e.void_reason === 'buyer never sent 2900'));
    check('foreign item -> null; lead not on item -> LEAD_NOT_FOUND', (await getItemContextForMcp(cB, Q)) === null && JSON.stringify(await getItemContextForMcp(cA, Q, { lead_id: L1 })) === JSON.stringify({ error: 'LEAD_NOT_FOUND' }));
    console.log(`  size: get_item_context(item Q, ${okCtx.leads.length} leads) default ${(JSON.stringify(okCtx).length / 1024).toFixed(1)} KB; full_history (25-event lead) ${(JSON.stringify(fullH).length / 1024).toFixed(1)} KB`);

    const ch1 = await findContactHistoryForUser(cA, { contact_name: 'Nick' });
    check('find_contact_history "Nick": no exact, both qualified Nicks as qualifier_variant possible matches', ch1.summary.exact_match_count === 0 && ch1.possible_matches.filter((p) => p.match_reason === 'qualifier_variant').length >= 2, ch1.summary);
    const ch2 = await findContactHistoryForUser(cA, { contact_name: 'nick (COLLECTOR)' });
    check('"Nick (collector)" matches exactly one lead with stage fields', ch2.summary.exact_match_count === 1 && ch2.exact_matches[0].peak_stage === 'NEGOTIATING' && ch2.summary.highest_stage === 'NEGOTIATING' && 'highest_quality' in ch2.summary, ch2.summary);
    const ch3 = await findContactHistoryForUser(cA, { contact_name: 'Sam Lee', channel: 'Other', channel_detail: 'SMS' });
    check('channel_detail keeps Other/Instagram separate from Other/SMS', ch3.summary.exact_match_count === 0 && ch3.other_channel_matches.length === 1 && ch3.other_channel_matches[0].channel_detail === 'Instagram', ch3.summary);
    const ch4 = await findContactHistoryForUser(cA, { contact_name: 'Jane Doe' });
    check('summary outcomes: item relationships + agreement/completed counts', ch4.summary.item_relationship_count === 2 && typeof ch4.summary.agreement_count === 'number' && typeof ch4.summary.completed_count === 'number' && ch4.exact_matches.every((m) => 'waiting_on' in m && 'last_event_at' in m), ch4.summary);

    const activity = buildLeadActivity({
      items: [{ item_id: 1, item_display_name: 'I' }],
      leads: [
        { ...(await leadRow(L1)), channel_name: 'Marketplace', peak_stage: 'NEGOTIATING' } as never,
        { ...(await leadRow(legacy!.id as number)), channel_name: 'Kijiji' } as never,
        { ...(await leadRow(chatty.lead_id!)), channel_name: 'Kijiji' } as never,
      ].map((l: Record<string, unknown>) => ({ ...l, inventory_item_id: 1 })) as never,
      resolved: { bucket: 'week', mode: 'rolling', start_date: '2026-09-28', end_date: '2026-10-25', periods: [{ start_date: '2026-10-19', end_date: '2026-10-25', label: 'w', is_partial: true }] } as never,
      filters: {}, today: '2026-10-21',
    });
    const life = activity.items[0].lifetime;
    check('get_lead_activity: stage_counts + negotiating_plus (direct lead without legacy quality counted)', life.stage_counts.NEGOTIATING === 2 && life.stage_counts.INQUIRY === 1 && life.negotiating_plus_count === 2 && life.high_intent_plus_count === 0, life);
    check('get_lead_activity: legacy quality block still present (one release)', life.serious_plus_count === 1 && 'engaged_count' in life && activity.semantics.some((s) => s.startsWith('LEGACY')), life);

    console.log('\n[W13 — security / isolation]');
    const bLead = await rec(cB, { lead: { lead_id: L1 }, events: [msg('INBOUND', '2026-10-14', 'intrusion')] });
    check('another user cannot write to A\'s lead (LEAD_NOT_FOUND)', bLead.result === 'REJECTED' && bLead.reason === 'LEAD_NOT_FOUND', bLead);
    const { data: bRpc } = await cB.rpc('apply_lead_interaction', { p_request: { mode: 'update', mutation_id: uuid(), lead_id: L1, expected_version: 1, snapshot: {}, events: [{ event_type: 'NOTE' }] } });
    check('direct RPC on A\'s lead as B -> NOT_FOUND', (bRpc as { status?: string })?.status === 'NOT_FOUND', bRpc);
    const { data: bEvents } = await cB.from('lead_events').select('id').eq('item_lead_id', L1);
    check('B sees none of A\'s events (RLS)', (bEvents ?? []).length === 0);
    const bVoid = await voidLeadEvent(cB, { mutation_id: uuid(), event_id: agreementEv.id as number, reason: 'intrusion', expected_version: 1 });
    check('B cannot void A\'s event (EVENT_NOT_FOUND)', bVoid.reason === 'EVENT_NOT_FOUND', bVoid);
    const { error: anonErr } = await anon.rpc('apply_lead_interaction', { p_request: { mode: 'create', mutation_id: uuid() } });
    check('anonymous caller rejected', !!anonErr, anonErr);
    const { error: insErr } = await cA.from('lead_events').insert({ user_id: userA, item_lead_id: L1, event_type: 'NOTE', direction: 'INTERNAL', occurred_at: new Date().toISOString(), summary: 'x', provenance: 'OBSERVED', actor: 'AI', source: 'MCP', content_hash: 'x' });
    const { error: updErr, data: updData } = await cA.from('lead_events').update({ summary: 'tampered' }).eq('item_lead_id', L1).select('id');
    const { error: delErr, data: delData } = await cA.from('lead_events').delete().eq('item_lead_id', L1).select('id');
    check('authenticated cannot INSERT lead_events directly', !!insErr, insErr);
    check('authenticated cannot UPDATE/DELETE lead_events', (!!updErr || (updData ?? []).length === 0) && (!!delErr || (delData ?? []).length === 0), [updErr, delErr]);
    const { error: leadUpd, data: leadUpdData } = await cA.from('item_leads').update({ status: 'COMPLETED' }).eq('id', L1).select('id');
    check('authenticated cannot UPDATE item_leads directly', !!leadUpd || (leadUpdData ?? []).length === 0, leadUpd);
    const { error: svcTamper } = await admin.from('lead_events').update({ summary: 'tampered' }).eq('item_lead_id', L1);
    check('even service_role cannot rewrite an event (append-only trigger)', !!svcTamper && /append-only/.test(svcTamper.message), svcTamper);
    const cat = psql(`
      SELECT p.proname || ':' || p.prosecdef || ':' || array_to_string(p.proconfig, ',')
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('apply_lead_interaction', 'item_leads_close_on_item_unavailable') ORDER BY 1;
      SELECT 'anon_exec=' || has_function_privilege('anon', 'public.apply_lead_interaction(jsonb)', 'EXECUTE');
      SELECT 'auth_exec=' || has_function_privilege('authenticated', 'public.apply_lead_interaction(jsonb)', 'EXECUTE');
      SELECT 'auth_backfill=' || has_function_privilege('authenticated', 'public.apply_lead_semantics_backfill_v1(jsonb)', 'EXECUTE');
      SELECT 'auth_ins=' || has_table_privilege('authenticated', 'public.lead_events', 'INSERT') || ',' || has_table_privilege('authenticated', 'public.lead_events', 'UPDATE') || ',' || has_table_privilege('authenticated', 'public.lead_events', 'DELETE');
      SELECT 'auth_leads_write=' || has_table_privilege('authenticated', 'public.item_leads', 'UPDATE');`);
    check('SECURITY DEFINER functions pin search_path', /apply_lead_interaction:(t|true):search_path=public, pg_temp/.test(cat) && /item_leads_close_on_item_unavailable:(t|true):search_path=public, pg_temp/.test(cat), cat);
    check('grants: anon no EXECUTE; authenticated EXECUTE write fn only; no backfill', cat.includes('anon_exec=false') && cat.includes('auth_exec=true') && cat.includes('auth_backfill=false'), cat);
    check('authenticated has no INSERT/UPDATE/DELETE on lead_events, no UPDATE on item_leads', cat.includes('auth_ins=false,false,false') && cat.includes('auth_leads_write=false'), cat);
  } finally {
    console.log('\n=== Cleanup ===');
    if (itemIds.length) {
      await admin.from('item_leads').delete().in('inventory_item_id', itemIds);
      await admin.from('deal_items').delete().in('item_id', itemIds);
    }
    if (dealIds.length) await admin.from('deals').delete().in('id', dealIds);
    if (itemIds.length) { const { error } = await admin.from('inventory_items').delete().in('id', itemIds); check('cleanup: items deleted (events cascade)', !error, error); }
    if (sourceIds.length) await admin.from('lead_import_sources').delete().in('id', sourceIds);
    if (createdBrand) await admin.from('brands').delete().eq('id', createdBrand);
    const { count } = await admin.from('lead_events').select('id', { count: 'exact', head: true }).in('user_id', [userA, userB]);
    check('cleanup: no fixture events left', count === 0, count);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });

export type { WriteResult };
