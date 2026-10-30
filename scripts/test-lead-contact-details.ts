/**
 * test-lead-contact-details.ts
 *
 * Lead contact city / phone (migration 20261029000000):
 *   N — phone normalization / city keys (pure)
 *   C — enrichment + conflict planning (pure planContact) and picker hints
 *   W — record_lead_interaction through a real signed-in RLS client: offer +
 *       city + phone in one interaction, idempotency, same phone in another
 *       format, conflicts (REVIEW_REQUIRED → KEEP_EXISTING / REPLACE), audit
 *       NOTE events, matching (same phone / name + city / KijijiUser),
 *       separate leads across items
 *   H — find_contact_history by phone / name + city
 *   V — get_leads / get_item_context / /leads loader / operation picker
 *   S — RLS isolation, constraints, index
 * Self-cleaning dedicated fixture (two users). Synthetic names and 555 numbers only.
 *
 * Usage:  npx tsx scripts/test-lead-contact-details.ts
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import {
  cityKey, displayPhone, maskedPhone, normalizePhone, samePhone, validateCity, validatePhone,
} from '../src/lib/leads/contactDetails';
import { identityEvidence, planContact, recordLeadInteraction, type AgentEventInput, type WriteResult } from '../src/lib/leads/leadWriteService';
import { findContactHistoryForUser } from '../src/lib/analytics/contactHistoryService';
import { getLeadsForUser } from '../src/lib/analytics/leadsMcp';
import { getItemContextForMcp } from '../src/lib/analytics/itemContextMcp';
import { loadLeadsForUser } from '../src/lib/leads/leadsServer';
import { contactHints, loadOperationLeadCandidates } from '../src/lib/leads/operationLeads';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 900) : ''); }
}

const PASSWORD = 'Contact-Details-Fixture-Local-Only-1!';
const uuid = () => crypto.randomUUID();
const root = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');

// ── N / C: pure ──────────────────────────────────────────────────────────
function pureChecks() {
  console.log('\n[N1 — phone normalization: equivalent forms]');
  const forms = ['647-555-1234', '(647) 555-1234', '+1 647 555 1234', '1-647-555-1234', '647.555.1234', '6475551234', '+16475551234', ' 647 555 1234 '];
  check('all common forms → +16475551234', forms.every((f) => normalizePhone(f) === '+16475551234'), forms.map((f) => [f, normalizePhone(f)]));

  console.log('\n[N2 — invalid / ambiguous numbers are never normalized]');
  const bad: [string, string][] = [
    ['555-1234', 'local 7-digit number (no area code)'],
    ['+44 20 7946 0958', 'international'],
    ['+33 1 23 45 67 89', 'international'],
    ['647-555-1234 ext 22', 'extension'],
    ['647-555-1234 x22', 'extension'],
    ['(147) 555-1234', 'area code starting with 1'],
    ['(047) 555-1234', 'area code starting with 0'],
    ['647-155-1234', 'exchange starting with 1'],
    ['911-555-1234', 'N11 service code'],
    ['26475551234', '11 digits not starting with 1'],
    ['+6475551234', '+ with 10 digits (no country code)'],
    ['647-555-12345', 'too many digits'],
    ['call me', 'no digits'],
    ['', 'empty'],
  ];
  for (const [raw, why] of bad) check(`"${raw}" (${why}) → null`, normalizePhone(raw) === null, normalizePhone(raw));

  console.log('\n[N3 — validation / display / masking]');
  const v1 = validatePhone('6475551234');
  check('bare digits get a readable display form', v1.ok && v1.display === '(647) 555-1234' && v1.normalized === '+16475551234', v1);
  const v2 = validatePhone('(647)  555-1234');
  check('observed display kept (whitespace collapsed)', v2.ok && v2.display === '(647) 555-1234', v2);
  const v3 = validatePhone('+44 20 7946 0958');
  check('unnormalizable but plausible: display kept, normalized NULL', v3.ok && v3.display === '+44 20 7946 0958' && v3.normalized === null, v3);
  check('too few digits → rejected (not a phone)', !validatePhone('call me maybe').ok && !validatePhone('12345').ok);
  check('display form helper', displayPhone('647 555 1234') === '647 555 1234' && displayPhone('6475551234') === '(647) 555-1234');
  check('masked hint shows last 4 only', maskedPhone('(647) 555-1234') === '…1234' && maskedPhone(null) === null);
  check('samePhone: formats of one number are the same', samePhone({ phone: '(647) 555-1234', normalized: '+16475551234' }, { phone: '+1 647 555 1234', normalized: '+16475551234' }));
  check('samePhone: different numbers differ', !samePhone({ phone: '(416) 555-1234', normalized: '+14165551234' }, { phone: '(647) 555-1234', normalized: '+16475551234' }));
  check('samePhone: unnormalized numbers compare by digits', samePhone({ phone: '+44 20 7946 0958', normalized: null }, { phone: '+44-20-7946-0958', normalized: null }));

  console.log('\n[N4 — city]');
  check('city key ignores case, spacing and an Ontario suffix', cityKey('Oakville, ON') === 'oakville' && cityKey(' oakville ') === 'oakville' && cityKey('Oakville Ontario') === 'oakville');
  check('distinct cities stay distinct', cityKey('Burlington') !== cityKey('Oakville'));
  check('a city ending in "on" keeps it (Burlington, Brampton, Kingston)', cityKey('Burlington') === 'burlington' && cityKey('BURLINGTON, ON') === 'burlington' && cityKey('Brampton') === 'brampton' && cityKey('Kingston ON') === 'kingston', [cityKey('Burlington'), cityKey('BURLINGTON, ON')]);
  check('city validation: place names ok, numbers/empty rejected', validateCity('St. Catharines').ok && !validateCity('12345').ok && !validateCity('   ').ok && !validateCity('x'.repeat(81)).ok);

  console.log('\n[C1 — enrichment / conflict planning (planContact)]');
  const empty = { id: 1, contact_city: null, contact_phone: null, contact_phone_normalized: null };
  const inc = { city: 'Oakville', phone: '(647) 555-1234', phoneNormalized: '+16475551234' };
  const p1 = planContact(empty, inc, undefined);
  check('empty lead: city + phone filled, one audit note each', !('result' in p1) && p1.set.contact_city === 'Oakville' && p1.set.contact_phone === '(647) 555-1234' && p1.set.contact_phone_normalized === '+16475551234' && p1.notes.length === 2, p1);
  const stored = { id: 1, contact_city: 'Oakville', contact_phone: '(647) 555-1234', contact_phone_normalized: '+16475551234' };
  const p2 = planContact(stored, { city: 'oakville, on', phone: '+1 647 555 1234', phoneNormalized: '+16475551234' }, undefined);
  check('same values in other formats: no change, no note, stored display kept', !('result' in p2) && Object.keys(p2.set).length === 0 && p2.notes.length === 0 && p2.after.contact_phone === '(647) 555-1234', p2);
  const p3 = planContact(stored, { city: null, phone: '(416) 555-9876', phoneNormalized: '+14165559876' }, undefined);
  check('different phone: REVIEW_REQUIRED CONTACT_PHONE_CONFLICT with KEEP/REPLACE', 'result' in p3 && p3.result === 'REVIEW_REQUIRED' && p3.reason === 'CONTACT_PHONE_CONFLICT'
    && JSON.stringify(p3.allowed_contact_resolutions) === '["KEEP_EXISTING","REPLACE"]' && /Existing contact details/.test(p3.message ?? ''), p3);
  check('conflict message never prints full numbers', 'result' in p3 && !/555-9876|555-1234/.test(p3.message ?? ''), 'result' in p3 ? p3.message : null);
  const p4 = planContact(stored, { city: null, phone: '(416) 555-9876', phoneNormalized: '+14165559876' }, 'KEEP_EXISTING');
  check('KEEP_EXISTING: nothing set, warning', !('result' in p4) && Object.keys(p4.set).length === 0 && p4.warnings.includes('CONTACT_KEPT_EXISTING:contact_phone'), p4);
  const p5 = planContact(stored, { city: null, phone: '(416) 555-9876', phoneNormalized: '+14165559876' }, 'REPLACE');
  check('REPLACE: phone set + "changed" audit note', !('result' in p5) && p5.set.contact_phone === '(416) 555-9876' && /changed/.test(p5.notes[0]?.summary ?? '') && p5.notes[0]?.payload.change === 'CONTACT_PHONE', p5);
  const p6 = planContact(stored, { city: 'Burlington', phone: null, phoneNormalized: null }, undefined);
  check('different explicit city: REVIEW_REQUIRED CONTACT_CITY_CONFLICT (no silent overwrite)', 'result' in p6 && p6.reason === 'CONTACT_CITY_CONFLICT' && (p6.allowed_resolutions ?? []).length === 0, p6);
  const p7 = planContact(null, inc, undefined);
  check('new lead: details set on create', !('result' in p7) && p7.set.contact_city === 'Oakville' && p7.changes.contact_phone?.[0] === null);

  console.log('\n[C2 — identity evidence (explainable, no score)]');
  check('same phone', JSON.stringify(identityEvidence(stored, inc)) === '["same_phone","same_city"]');
  check('different phone, unknown city', JSON.stringify(identityEvidence({ contact_city: null, contact_phone: '416-555-0000', contact_phone_normalized: '+14165550000' }, inc)) === '["different_phone"]');
  check('nothing comparable → no evidence', identityEvidence(empty, inc).length === 0);
  check('no numeric identity score in the write service', !/identity_?score|match_?confidence/i.test(read('src', 'lib', 'leads', 'leadWriteService.ts')));

  console.log('\n[C3 — operation picker hints]');
  const hints = contactHints([
    { id: 1, contact_name: 'Mike', contact_city: 'Oakville', contact_phone: '647-555-1111' },
    { id: 2, contact_name: 'mike', contact_city: 'Toronto', contact_phone: null },
    { id: 3, contact_name: 'Anna', contact_city: 'Hamilton', contact_phone: '905-555-2222' },
    { id: 4, contact_name: 'Sam', contact_city: 'Barrie', contact_phone: '705-555-3333' },
    { id: 5, contact_name: 'Sam', contact_city: 'Barrie', contact_phone: '705-555-4444' },
    { id: 6, contact_name: 'Lee', contact_city: null, contact_phone: null },
    { id: 7, contact_name: 'Lee', contact_city: null, contact_phone: null },
  ]);
  check('same name: distinct cities are the hint', hints.get(1) === 'Oakville' && hints.get(2) === 'Toronto', Array.from(hints));
  check('unique name: no hint (no clutter)', !hints.has(3));
  check('same name + same city: masked phone, never the full number', hints.get(4) === 'Barrie · …3333' && hints.get(5) === 'Barrie · …4444', [hints.get(4), hints.get(5)]);
  check('nothing to tell them apart: no hint', hints.get(6) === null && hints.get(7) === null);
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

const msg = (direction: 'INBOUND' | 'OUTBOUND', at: string, summary: string): AgentEventInput => ({ type: 'MESSAGE', direction, occurred_at: at, summary, payload: { substance: 'SUBSTANTIVE' } });
const cashOffer = (at: string, amount: number, summary: string): AgentEventInput => ({ type: 'OFFER', direction: 'INBOUND', occurred_at: at, summary, payload: { offer: { cash_terms: 'AMOUNT', cash_amount: amount, items: [] } } });

async function main() {
  pureChecks();

  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const emailA = 'contact-details-fixture-a@example.test';
  const emailB = 'contact-details-fixture-b@example.test';
  const userA = await resolveAppUserId(admin, await ensureAuthUser(admin, emailA));
  const userB = await resolveAppUserId(admin, await ensureAuthUser(admin, emailB));
  const cA = await signIn(emailA);
  const cB = await signIn(emailB);
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });

  let { data: brand } = await admin.from('brands').select('id').limit(1).maybeSingle();
  let createdBrand: number | null = null;
  if (!brand) { brand = (await admin.from('brands').insert({ name: `CD Brand ${uuid().slice(0, 6)}` }).select('id').single()).data; createdBrand = brand!.id as number; }
  const itemIds: number[] = [];

  try {
    const item = async (userId: number, model: string) => {
      const { data, error } = await admin.from('inventory_items').insert({ user_id: userId, brand_id: brand!.id, model, status: 'listed', serial_number: `CD-${uuid().slice(0, 8)}` }).select('id').single();
      if (error) throw error;
      itemIds.push(data.id as number);
      return data.id as number;
    };
    const leadRow = async (id: number) => (await admin.from('item_leads').select('*').eq('id', id).single()).data as Record<string, unknown>;
    const eventsOf = async (id: number) => ((await admin.from('lead_events').select('*').eq('item_lead_id', id).is('voided_at', null).order('id')).data ?? []) as Record<string, unknown>[];
    const rec = (client: SupabaseClient, body: Omit<Parameters<typeof recordLeadInteraction>[1], 'mutation_id'> & { mutation_id?: string }) =>
      recordLeadInteraction(client, { mutation_id: body.mutation_id ?? uuid(), ...body } as never, { clientLabel: 'test-suite' });

    const G = await item(userA, 'Gibson (CD)');
    const F = await item(userA, 'Fender (CD)');
    const P = await item(userA, 'Pedal (CD)');
    const K = await item(userA, 'Kijiji item (CD)');
    const K2 = await item(userA, 'Kijiji item 2 (CD)');
    const BI = await item(userB, 'B item (CD)');

    // ── W1: one interaction = offer + city + phone ─────────────────────────
    console.log('\n[W1 — "I can do $2,800. I\'m in Oakville. Text me at 647-555-1234." in ONE interaction]');
    const m1 = uuid();
    const req1 = { mutation_id: m1, lead: { item_id: G, channel: 'Marketplace' as const, contact_name: 'John Fixture', contact_city: 'Oakville', contact_phone: '647-555-1234' },
      events: [cashOffer('2026-10-28T10:00:00-04:00', 2800, 'Buyer offered C$2,800 cash; lives in Oakville; gave phone')] };
    const r1 = await rec(cA, req1);
    check('APPLIED_CREATE', r1.result === 'APPLIED_CREATE' && !!r1.lead_id, r1);
    const L1 = r1.lead_id!;
    let row = await leadRow(L1);
    check('stored: city Oakville, phone display as observed, normalized +16475551234', row.contact_city === 'Oakville' && row.contact_phone === '647-555-1234' && row.contact_phone_normalized === '+16475551234', row);
    check('offer persisted in the same write (CASH 2800, NEGOTIATING)', row.offer_type === 'CASH' && Number(row.latest_cash_offer) === 2800 && row.peak_stage === 'NEGOTIATING', row);
    let evs = await eventsOf(L1);
    const notes1 = evs.filter((e) => e.event_type === 'NOTE');
    check('events: the buyer OFFER + one SYSTEM audit NOTE per contact field', evs.filter((e) => e.event_type === 'OFFER').length === 1 && notes1.length === 2 && notes1.every((n) => n.source === 'SYSTEM' && n.actor === 'SYSTEM'), evs.map((e) => [e.event_type, e.summary]));
    check('audit notes: "Contact city added: Oakville" / phone masked in summary', notes1.some((n) => n.summary === 'Contact city added: Oakville') && notes1.some((n) => n.summary === 'Contact phone added (…1234)'), notes1.map((n) => n.summary));
    check('audit payload keeps from/to for later review', notes1.some((n) => (n.payload as Record<string, unknown>).change === 'CONTACT_PHONE' && (n.payload as Record<string, unknown>).to_normalized === '+16475551234'));
    check('result reports contact changes and stored contact', JSON.stringify(r1.changes?.contact_city) === '[null,"Oakville"]' && JSON.stringify(r1.contact) === JSON.stringify({ contact_city: 'Oakville', contact_phone: '647-555-1234' }), r1);
    check('all events share one mutation (one logical interaction)', new Set(evs.map((e) => e.mutation_id)).size === 1);

    console.log('\n[W2 — idempotency]');
    const v1 = Number(row.version);
    const r1b = await rec(cA, req1);
    row = await leadRow(L1);
    check('same mutation_id replays: no new events, no field change, same result', r1b.replayed === true && (await eventsOf(L1)).length === evs.length && Number(row.version) === v1 && r1b.result === 'APPLIED_CREATE', r1b);
    const r1c = await rec(cA, { ...req1, lead: { ...req1.lead, contact_phone: '416-555-0000' } });
    check('same mutation_id with a different phone = MUTATION_ID_REUSED (no false write)', r1c.result === 'REJECTED' && r1c.reason === 'MUTATION_ID_REUSED', r1c);
    const r1d = await rec(cA, { lead: { item_id: G, channel: 'Marketplace', contact_name: 'John Fixture', contact_city: 'Oakville', contact_phone: '647-555-1234' }, events: req1.events });
    check('new mutation_id, same events + same details: NO_CHANGE, no audit row, no conflict', r1d.result === 'NO_CHANGE' && (await eventsOf(L1)).length === evs.length, r1d);

    console.log('\n[W3 — same phone in another format]');
    const r3 = await rec(cA, { lead: { item_id: G, channel: 'Marketplace', contact_name: 'John Fixture', contact_phone: '+1 647 555 1234' }, events: [msg('INBOUND', '2026-10-28T11:00:00-04:00', 'Asked if Saturday works')] });
    row = await leadRow(L1);
    check('APPLIED_UPDATE on the same lead, no contact change, stored display kept', r3.result === 'APPLIED_UPDATE' && r3.lead_id === L1 && !('contact_phone' in (r3.changes ?? {})) && row.contact_phone === '647-555-1234', r3);
    check('no audit note for an unchanged phone', (await eventsOf(L1)).filter((e) => e.event_type === 'NOTE').length === 2);

    console.log('\n[W4 — conflicting phone: never silently attached or overwritten]');
    const before = (await eventsOf(L1)).length;
    const mC = uuid();
    const conflictReq = { mutation_id: mC, lead: { item_id: G, channel: 'Marketplace' as const, contact_name: 'John Fixture', contact_phone: '(416) 555-9876' }, events: [msg('INBOUND', '2026-10-28T12:00:00-04:00', 'New number, same thread?')] };
    const r4 = await rec(cA, conflictReq);
    check('REVIEW_REQUIRED CONTACT_PHONE_CONFLICT; USE_LEAD / CREATE_NEW + KEEP/REPLACE offered', r4.result === 'REVIEW_REQUIRED' && r4.reason === 'CONTACT_PHONE_CONFLICT'
      && JSON.stringify(r4.allowed_resolutions) === '["USE_LEAD","CREATE_NEW"]' && JSON.stringify(r4.allowed_contact_resolutions) === '["KEEP_EXISTING","REPLACE"]', r4);
    check('candidate carries identity different_phone and a masked hint only', r4.candidates?.[0]?.identity?.includes('different_phone') === true && r4.candidates?.[0]?.phone_hint === '…1234', r4.candidates);
    check('nothing written on review', (await eventsOf(L1)).length === before && (await leadRow(L1)).contact_phone === '647-555-1234');
    const r4k = await rec(cA, { ...conflictReq, resolution: { action: 'USE_LEAD', lead_id: L1 }, contact_resolution: 'KEEP_EXISTING' });
    row = await leadRow(L1);
    check('KEEP_EXISTING: interaction logged, phone kept, warning, no contact note', r4k.result === 'APPLIED_UPDATE' && row.contact_phone === '647-555-1234' && (r4k.warnings ?? []).includes('CONTACT_KEPT_EXISTING:contact_phone')
      && (await eventsOf(L1)).filter((e) => e.event_type === 'NOTE').length === 2, r4k);
    const r4r = await rec(cA, { lead: { lead_id: L1, contact_phone: '(416) 555-9876' }, events: [msg('INBOUND', '2026-10-28T13:00:00-04:00', 'Confirmed new number')] });
    check('by lead_id: conflict still REVIEW_REQUIRED (planContact)', r4r.result === 'REVIEW_REQUIRED' && r4r.reason === 'CONTACT_PHONE_CONFLICT' && r4r.lead_id === L1, r4r);
    const r4s = await rec(cA, { lead: { lead_id: L1, contact_phone: '(416) 555-9876' }, events: [msg('INBOUND', '2026-10-28T13:00:00-04:00', 'Confirmed new number')], contact_resolution: 'REPLACE' });
    row = await leadRow(L1);
    const changeNote = (await eventsOf(L1)).filter((e) => e.event_type === 'NOTE').pop();
    check('REPLACE: phone replaced, normalized updated', r4s.result === 'APPLIED_UPDATE' && row.contact_phone === '(416) 555-9876' && row.contact_phone_normalized === '+14165559876', row);
    check('REPLACE is auditable: "Contact phone changed from …1234 to …9876 (confirmed by the user)"', changeNote?.summary === 'Contact phone changed from …1234 to …9876 (confirmed by the user)'
      && (changeNote?.payload as Record<string, unknown>).from === '647-555-1234', changeNote);

    console.log('\n[W5 — city: enrichment, conflict, replace]');
    const rC0 = await rec(cA, { lead: { item_id: F, channel: 'Marketplace', contact_name: 'Rita Fixture' }, events: [msg('INBOUND', '2026-10-28T09:00:00-04:00', 'Is it available?')] });
    const LR = rC0.lead_id!;
    check('lead without details: no contact block in the result', rC0.result === 'APPLIED_CREATE' && rC0.contact === undefined, rC0);
    const rC1 = await rec(cA, { lead: { lead_id: LR, contact_city: 'Burlington' }, events: [msg('INBOUND', '2026-10-28T09:30:00-04:00', '"I live in Burlington"')] });
    check('empty city + stated residence → APPLIED_UPDATE, city filled', rC1.result === 'APPLIED_UPDATE' && (await leadRow(LR)).contact_city === 'Burlington' && JSON.stringify(rC1.changes?.contact_city) === '[null,"Burlington"]', rC1);
    const rC2 = await rec(cA, { lead: { lead_id: LR, contact_city: 'Oakville' }, events: [msg('INBOUND', '2026-10-28T09:40:00-04:00', '"I live in Oakville"')] });
    check('different explicit city → REVIEW_REQUIRED CONTACT_CITY_CONFLICT, nothing written', rC2.result === 'REVIEW_REQUIRED' && rC2.reason === 'CONTACT_CITY_CONFLICT' && (await leadRow(LR)).contact_city === 'Burlington', rC2);
    const rC3 = await rec(cA, { lead: { lead_id: LR, contact_city: 'BURLINGTON, ON' }, events: [msg('INBOUND', '2026-10-28T09:50:00-04:00', 'Says Burlington again')] });
    check('same city in another spelling: no conflict, no change', rC3.result === 'APPLIED_UPDATE' && !('contact_city' in (rC3.changes ?? {})) && (await leadRow(LR)).contact_city === 'Burlington', rC3);
    const rC4 = await rec(cA, { lead: { lead_id: LR, contact_city: 'Oakville' }, events: [msg('INBOUND', '2026-10-28T09:40:00-04:00', '"I live in Oakville"')], contact_resolution: 'REPLACE' });
    check('REPLACE: city changed with audit note', rC4.result === 'APPLIED_UPDATE' && (await leadRow(LR)).contact_city === 'Oakville'
      && (await eventsOf(LR)).some((e) => e.summary === 'Contact city changed from Burlington to Oakville (confirmed by the user)'), rC4);

    console.log('\n[W6 — details only, events already recorded]');
    const rD = await rec(cA, { lead: { lead_id: LR, contact_phone: '905-555-0101' }, events: [msg('INBOUND', '2026-10-28T09:30:00-04:00', '"I live in Burlington"')] });
    check('re-sent events + a new phone: enrichment still recorded (NOTE only)', rD.result === 'APPLIED_UPDATE' && rD.skipped_events === undefined && (rD.warnings ?? []).includes('DUPLICATE_EVENTS_SKIPPED:1') && (await leadRow(LR)).contact_phone === '905-555-0101', rD);
    const rDry = await rec(cA, { lead: { item_id: P, channel: 'Kijiji', contact_name: 'Dry Fixture', contact_phone: '905-555-0202' }, events: [msg('INBOUND', '2026-10-28T09:00:00-04:00', 'hi')], dry_run: true });
    check('dry_run reports contact changes, writes nothing', rDry.dry_run === true && JSON.stringify(rDry.changes?.contact_phone) === '[null,"905-555-0202"]'
      && ((await admin.from('item_leads').select('id').eq('inventory_item_id', P)).data ?? []).length === 0, rDry);

    console.log('\n[W7 — same name + item + channel: phone selects, city only supports]');
    const rM1 = await rec(cA, { lead: { item_id: P, channel: 'Marketplace', contact_name: 'Mike', contact_city: 'Oakville', contact_phone: '647-555-7777' }, events: [msg('INBOUND', '2026-10-28T08:00:00-04:00', 'Mike A asks about the pedal')] });
    const MA = rM1.lead_id!;
    const rM2 = await rec(cA, { lead: { item_id: P, channel: 'Marketplace', contact_name: 'Mike', contact_city: 'Toronto' }, events: [msg('INBOUND', '2026-10-28T08:10:00-04:00', 'Another Mike asks')], resolution: { action: 'CREATE_NEW' } });
    const MB = rM2.lead_id!;
    check('two separate "Mike" leads exist (CREATE_NEW)', rM1.result === 'APPLIED_CREATE' && rM2.result === 'APPLIED_CREATE' && MA !== MB, [rM1, rM2]);
    const rM3 = await rec(cA, { lead: { item_id: P, channel: 'Marketplace', contact_name: 'Mike', contact_city: 'Oakville', contact_phone: '+1 (647) 555-7777' }, events: [msg('INBOUND', '2026-10-28T08:20:00-04:00', 'Mike, Oakville, same phone')] });
    check('incoming Mike + same phone → attaches to candidate A', rM3.result === 'APPLIED_UPDATE' && rM3.lead_id === MA && rM3.matched_by === 'item_channel_contact', rM3);
    const rM4 = await rec(cA, { lead: { item_id: P, channel: 'Marketplace', contact_name: 'Mike', contact_city: 'Oakville' }, events: [msg('INBOUND', '2026-10-28T08:30:00-04:00', 'Mike from Oakville, no phone')] });
    check('same name + same city, no phone → still review (supportive, not definitive)', rM4.result === 'REVIEW_REQUIRED' && rM4.reason === 'MULTIPLE_CONTACT_MATCHES', rM4);
    check('…with the same-city candidate ordered first and explained', rM4.candidates?.[0]?.lead_id === MA && rM4.candidates?.[0]?.identity?.includes('same_city') === true && /same city \(supportive, not proof\)/.test(rM4.candidates?.[0]?.why ?? ''), rM4.candidates);
    const rM5 = await rec(cA, { lead: { item_id: P, channel: 'Marketplace', contact_name: 'Michael Fixture', contact_phone: '647-555-7777' }, events: [msg('INBOUND', '2026-10-28T08:40:00-04:00', 'Signed as Michael')] });
    check('different name, same phone on this item → POSSIBLE_DUPLICATE, phone candidate', rM5.result === 'REVIEW_REQUIRED' && rM5.reason === 'POSSIBLE_DUPLICATE' && rM5.candidates?.some((c) => c.lead_id === MA && c.match === 'phone') === true, rM5);

    console.log('\n[W8 — same phone, different item: same likely contact, separate lead]');
    const rX = await rec(cA, { lead: { item_id: F, channel: 'Kijiji', contact_name: 'Mike', contact_phone: '647 555 7777' }, events: [msg('INBOUND', '2026-10-28T08:50:00-04:00', 'Mike asks about the Fender')] });
    check('APPLIED_CREATE — a new lead on the other item (never merged)', rX.result === 'APPLIED_CREATE' && rX.lead_id !== MA, rX);
    check('related_contacts: lead A matched_on phone', rX.related_contacts?.some((r) => r.lead_id === MA && r.matched_on === 'phone') === true, rX.related_contacts);

    console.log('\n[W9 — KijijiUser safety]');
    const rK1 = await rec(cA, { lead: { item_id: K, channel: 'Kijiji', contact_name: 'KijijiUser', contact_city: 'Barrie', contact_phone: '705-555-1212' }, events: [msg('INBOUND', '2026-10-28T07:00:00-04:00', 'KijijiUser 1 asks')] });
    const KU = rK1.lead_id!;
    const rK2 = await rec(cA, { lead: { item_id: K, channel: 'Kijiji', contact_name: 'KijijiUser', contact_city: 'Barrie' }, events: [msg('INBOUND', '2026-10-28T07:10:00-04:00', 'KijijiUser, Barrie, no phone')] });
    check('same KijijiUser + same city, no phone → POSSIBLE_DIFFERENT_PERSON (rule intact)', rK2.result === 'REVIEW_REQUIRED' && rK2.reason === 'POSSIBLE_DIFFERENT_PERSON', rK2);
    const rK3 = await rec(cA, { lead: { item_id: K, channel: 'Kijiji', contact_name: 'KijijiUser', contact_phone: '(705) 555-1212' }, events: [msg('INBOUND', '2026-10-28T07:20:00-04:00', 'KijijiUser, same phone')] });
    check('same KijijiUser + same normalized phone → attaches to that lead', rK3.result === 'APPLIED_UPDATE' && rK3.lead_id === KU, rK3);
    const rK4 = await rec(cA, { lead: { item_id: K, channel: 'Kijiji', contact_name: 'KijijiUser', contact_phone: '705-555-3434' }, events: [msg('INBOUND', '2026-10-28T07:30:00-04:00', 'KijijiUser, other phone')] });
    check('same KijijiUser + different phone → review, not attached', rK4.result === 'REVIEW_REQUIRED' && rK4.reason === 'CONTACT_PHONE_CONFLICT', rK4);
    const rK5 = await rec(cA, { lead: { item_id: K2, channel: 'Kijiji', contact_name: 'KijijiUser', contact_phone: '705-555-1212' }, events: [msg('INBOUND', '2026-10-28T07:40:00-04:00', 'KijijiUser on another item')] });
    check('KijijiUser + same phone on another item: new lead; related by phone', rK5.result === 'APPLIED_CREATE' && rK5.related_contacts?.some((r) => r.lead_id === KU && r.matched_on === 'phone') === true, rK5);
    const rK6 = await rec(cA, { lead: { item_id: K2, channel: 'Kijiji', contact_name: 'KijijiUser' }, events: [msg('INBOUND', '2026-10-28T07:50:00-04:00', 'KijijiUser, no phone')], resolution: { action: 'CREATE_NEW' } });
    check('KijijiUser without phone: the shared display name is NOT a related contact', rK6.result === 'APPLIED_CREATE' && !(rK6.related_contacts ?? []).some((r) => r.matched_on === 'name'), rK6.related_contacts);

    // ── H: find_contact_history ───────────────────────────────────────────
    console.log('\n[H1 — find_contact_history by phone (strongest)]');
    const h1 = await findContactHistoryForUser(cA, { contact_phone: '(647) 555-7777' });
    check('phone basis; every same-phone lead across items, any name', h1.basis === 'PHONE' && h1.phone_matches.length === 2 && h1.query.contact_phone_normalized === '+16475557777', h1.phone_matches.map((m) => [m.lead_id, m.contact_name]));
    check('careful wording: "Likely same contact: same normalized phone appears across 2 leads on 2 items."', h1.phone_summary?.statement === 'Likely same contact: same normalized phone appears across 2 leads on 2 items.', h1.phone_summary);
    check('never claims a guaranteed identity', !/guaranteed same|same person for sure|definitely/i.test(JSON.stringify(h1.phone_summary) + h1.semantics.join(' ')));
    check('summary counts the phone matches when no name was given', h1.summary.exact_match_count === 2 && h1.summary.distinct_item_count === 2 && h1.exact_matches.length === 0);
    const h2 = await findContactHistoryForUser(cA, { contact_name: 'Mike', contact_phone: '647-555-7777' });
    check('name + phone: name matches flag same_phone true/null per lead', h2.basis === 'NAME' && h2.exact_matches.some((m) => m.lead_id === MA && m.same_phone === true) && h2.exact_matches.some((m) => m.lead_id === MB && m.same_phone === null), h2.exact_matches.map((m) => [m.lead_id, m.same_phone]));
    const h3 = await findContactHistoryForUser(cA, { contact_phone: '416-555-0001' });
    check('unknown phone: empty, explicit statement', h3.phone_matches.length === 0 && /^No lead has this phone recorded/.test(h3.phone_summary?.statement ?? ''), h3.phone_summary);

    console.log('\n[H2 — name + city narrowing]');
    const h4 = await findContactHistoryForUser(cA, { contact_name: 'Mike', contact_city: 'oakville' });
    check('NAME_CITY: exact = same city; other city and unknown city listed apart, not counted', h4.basis === 'NAME_CITY' && h4.exact_matches.every((m) => m.contact_city === 'Oakville') && h4.exact_matches.some((m) => m.lead_id === MA)
      && h4.other_city_matches.some((m) => m.lead_id === MB) && h4.unknown_city_matches.some((m) => m.lead_id === rX.lead_id) && h4.summary.exact_match_count === h4.exact_matches.length, { e: h4.exact_matches.map((m) => m.lead_id), o: h4.other_city_matches.map((m) => m.lead_id), u: h4.unknown_city_matches.map((m) => m.lead_id) });
    check('semantics: name + city supports, does not prove', h4.semantics.some((s) => /supports identity but does not prove it/.test(s)));
    let cityOnly = '';
    try { await findContactHistoryForUser(cA, { contact_city: 'Oakville' }); } catch (e) { cityOnly = (e as Error).message; }
    check('city alone is not a search', /contact_name or contact_phone is required|city alone/.test(cityOnly), cityOnly);
    const h5 = await findContactHistoryForUser(cA, { contact_name: 'John Fixture' });
    check('name-only lookup preserved; records carry city / phone when recorded', h5.basis === 'NAME' && h5.exact_matches[0]?.contact_phone === '(416) 555-9876' && h5.coverage.leads_with_contact_phone >= 5, h5.exact_matches[0]);

    // ── V: read surfaces ──────────────────────────────────────────────────
    console.log('\n[V1 — get_leads / get_item_context]');
    const gl = await getLeadsForUser(cA, { item_ids: [G, F] });
    const glJohn = gl.leads.find((l) => l.lead_id === L1) as Record<string, unknown> | undefined;
    const glAny = gl.leads.find((l) => l.lead_id === rX.lead_id) as Record<string, unknown> | undefined;
    check('get_leads: contact_city / contact_phone present when recorded', glJohn?.contact_city === 'Oakville' && glJohn?.contact_phone === '(416) 555-9876', glJohn);
    check('get_leads: normalized phone not exposed', !JSON.stringify(gl).includes('contact_phone_normalized'));
    check('get_leads: no city key when none recorded (no empty placeholder)', glAny != null && !('contact_city' in glAny) && glAny.contact_phone === '647 555 7777', glAny);
    const ic = await getItemContextForMcp(cA, F);
    const icLead = ic && 'leads' in ic ? ic.leads.find((l) => l.lead_id === LR) as Record<string, unknown> | undefined : undefined;
    check('get_item_context: City / Phone shown on the lead when present', icLead?.contact_city === 'Oakville' && icLead?.contact_phone === '905-555-0101', icLead);
    const icNone = ic && 'leads' in ic ? ic.leads.find((l) => l.lead_id === rX.lead_id) as Record<string, unknown> | undefined : undefined;
    check('get_item_context: absent city omitted', icNone != null && !('contact_city' in icNone));

    console.log('\n[V2 — /leads loader and the operation lead picker]');
    const payload = await loadLeadsForUser({ db: cA, serviceClient: null, appUserId: userA });
    const ui = payload.leads.find((l) => l.id === MA);
    check('/leads rows carry contact_city / contact_phone for the drawer (not the normalized key)', ui?.contact_city === 'Oakville' && ui?.contact_phone === '647-555-7777' && !('contact_phone_normalized' in (ui ?? {})), ui);
    const pk = await loadOperationLeadCandidates(cA, userA, { itemIds: [P] });
    const cMA = pk.candidates.find((c) => c.lead_id === MA);
    const cMB = pk.candidates.find((c) => c.lead_id === MB);
    check('picker: same-name candidates get "· Oakville" / "· Toronto" hints', cMA?.contact_hint === 'Oakville' && cMB?.contact_hint === 'Toronto', pk.candidates);
    check('picker payload never contains a full phone number', !/555-7777|5557777/.test(JSON.stringify(pk)));
    const pkG = await loadOperationLeadCandidates(cA, userA, { itemIds: [G] });
    check('picker: a unique name gets no hint', pkG.candidates.every((c) => c.contact_hint === null), pkG.candidates);
    const pkQ = await loadOperationLeadCandidates(cA, userA, { itemIds: [P], q: 'toronto' });
    check('picker search matches the city', pkQ.candidates.length === 1 && pkQ.candidates[0].lead_id === MB, pkQ.candidates);

    console.log('\n[V3 — UI wiring]');
    const panel = read('src', 'components', 'leads', 'LeadDetailPanel.tsx');
    check('drawer shows city / phone under the name, each only when present', /\{lead\.contact_city && <span[^>]*data-contact-city/.test(panel) && /\{lead\.contact_phone && \(/.test(panel));
    check('long values wrap (overflow-wrap:anywhere)', /data-contact-city/.test(panel) && (panel.match(/\[overflow-wrap:anywhere\][^>]*data-contact-(city|phone)/g) ?? []).length === 2);
    const table = read('src', 'app', 'leads', 'page.tsx') + read('src', 'components', 'leads', 'LeadBadges.tsx');
    check('no new table columns for city / phone', !/contact_city|contact_phone/.test(table));
    const route = read('src', 'app', 'api', 'mcp', '[[...path]]', 'route.ts');
    check('MCP record_lead_interaction: optional lead.contact_city / contact_phone + contact_resolution', /contact_city: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(80\)\.optional\(\)/.test(route) && /contact_phone: z\.string\(\)\.trim\(\)\.min\(7\)\.max\(40\)\.optional\(\)/.test(route) && /contact_resolution: z\.enum\(CONTACT_RESOLUTIONS\)\.optional\(\)/.test(route));
    check('MCP guidance: residence only, never a meeting place; same call as the offer', /never for a meeting place or trip/.test(route) && /SAME call as the events of that interaction/.test(route));
    check('MCP find_contact_history: name optional, phone + city accepted; "likely the same contact" wording', /contact_name: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(200\)\.optional\(\)\.describe\('The person\\'s name as shown in the new message/.test(route) && /likely the same contact/.test(route));
    check('no new MCP tool for contacts', !/registerTool\(\s*'[a-z_]*contact(?!_history)/.test(route));

    // ── S: security / schema ─────────────────────────────────────────────
    console.log('\n[S1 — RLS isolation]');
    const { data: bSees } = await cB.from('item_leads').select('id, contact_phone, contact_city').in('id', [L1, MA]);
    check('user B cannot read user A\'s contact city / phone', (bSees ?? []).length === 0, bSees);
    const { data: anonSees } = await anon.from('item_leads').select('id, contact_phone').in('id', [L1, MA]);
    check('anon cannot read contact data', (anonSees ?? []).length === 0);
    const rB = await rec(cB, { lead: { lead_id: MA, contact_phone: '416-555-6666' }, events: [msg('INBOUND', '2026-10-28T10:00:00-04:00', 'cross-user attempt')] });
    check('user B cannot enrich user A\'s lead via record_lead_interaction (LEAD_NOT_FOUND)', rB.result === 'REJECTED' && rB.reason === 'LEAD_NOT_FOUND', rB);
    const { data: rpcB, error: rpcBErr } = await cB.rpc('apply_lead_interaction', { p_request: {
      mode: 'update', mutation_id: uuid(), request_hash: 'x', lead_id: MA, expected_version: Number((await leadRow(MA)).version), lead: {}, snapshot: {},
      contact: { contact_phone: '416-555-6666', contact_phone_normalized: '+14165556666' },
      events: [{ event_type: 'NOTE', direction: 'INTERNAL', occurred_at: new Date().toISOString(), summary: 'x', payload: {}, provenance: 'OBSERVED', actor: 'AI', source: 'MCP', mutation_seq: 0, content_hash: 'x' }],
    } });
    check('user B calling the RPC directly on A\'s lead: NOT_FOUND, phone untouched', (rpcB as { status?: string } | null)?.status === 'NOT_FOUND' && (await leadRow(MA)).contact_phone === '647-555-7777', { rpcB, rpcBErr });
    const { data: upd } = await cB.from('item_leads').update({ contact_phone: '416-555-6666' }).eq('id', MA).select('id');
    check('no direct UPDATE path for B', (upd ?? []).length === 0 && (await leadRow(MA)).contact_phone === '647-555-7777');
    const hB = await findContactHistoryForUser(cB, { contact_phone: '647-555-7777' });
    check('user B\'s phone lookup never sees user A\'s leads', hB.phone_matches.length === 0 && hB.coverage.leads_with_contact_phone === 0, hB.phone_summary);
    const rBown = await rec(cB, { lead: { item_id: BI, channel: 'Marketplace', contact_name: 'Mike', contact_phone: '647-555-7777' }, events: [msg('INBOUND', '2026-10-28T10:00:00-04:00', 'B\'s own Mike')] });
    check('the same phone on another user\'s lead: allowed, no cross-user related contacts', rBown.result === 'APPLIED_CREATE' && (rBown.related_contacts ?? []).length === 0, rBown);
    const { data: ownA } = await cA.from('item_leads').select('id, contact_phone').eq('id', MA);
    check('owner reads own contact data through RLS', ownA?.[0]?.contact_phone === '647-555-7777');

    console.log('\n[S2 — schema]');
    const { error: badNorm } = await admin.from('item_leads').update({ contact_phone_normalized: '6475551234' }).eq('id', MA);
    check('CHECK: malformed normalized value rejected', !!badNorm, badNorm);
    const { error: orphanNorm } = await admin.from('item_leads').update({ contact_phone: null }).eq('id', MA);
    check('CHECK: normalized phone requires a phone', !!orphanNorm, orphanNorm);
    const { error: padded } = await admin.from('item_leads').update({ contact_city: ' Oakville' }).eq('id', MA);
    check('CHECK: city stored trimmed', !!padded, padded);
    const idx = psql(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_item_leads_user_phone';`);
    check('partial (user_id, contact_phone_normalized) index, NOT unique', /\(user_id, contact_phone_normalized\)/.test(idx) && /WHERE \(contact_phone_normalized IS NOT NULL\)/.test(idx) && !/UNIQUE/.test(idx), idx);
    const uniq = psql(`SELECT count(*) FROM pg_indexes WHERE tablename = 'item_leads' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%phone%';`);
    check('no uniqueness on phone anywhere (one person, many leads)', uniq === '0', uniq);
    const mig = read('supabase', 'migrations', '20261029000000_item_leads_contact_city_phone.sql');
    check('no contacts table / contact_id introduced', !/CREATE TABLE|contact_id/i.test(mig));
    check('deployed lead migrations untouched (apply_lead_interaction re-created in the new migration only)', /CREATE OR REPLACE FUNCTION public\.apply_lead_interaction/.test(mig));
    check('no phone logging in the write path', !/console\.(log|info|warn|error)\([^)]*phone/i.test(read('src', 'lib', 'leads', 'leadWriteService.ts') + read('src', 'lib', 'analytics', 'contactHistoryService.ts')));
    const analytics = ['negotiationAnalytics.ts', 'leadActivityService.ts', 'inventoryAnalysisService.ts'].map((f) => { try { return read('src', 'lib', 'analytics', f); } catch { return ''; } }).join('\n');
    check('phone / city not added to generic analytics', !/contact_phone|contact_city/.test(analytics));
  } finally {
    console.log('\n=== Cleanup ===');
    if (itemIds.length) {
      await admin.from('item_leads').delete().in('inventory_item_id', itemIds);
      const { error } = await admin.from('inventory_items').delete().in('id', itemIds);
      check('cleanup: items deleted (leads/events cascade)', !error, error);
    }
    if (createdBrand) await admin.from('brands').delete().eq('id', createdBrand);
    const { count } = await admin.from('item_leads').select('id', { count: 'exact', head: true }).in('user_id', [userA, userB]);
    check('cleanup: no fixture leads left', count === 0, count);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });

export type { WriteResult };
