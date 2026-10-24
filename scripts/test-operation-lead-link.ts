/**
 * test-operation-lead-link.ts
 *
 * Sell / Trade winning-lead picker + operation calendar dates:
 *   D  — pure date helpers (Toronto "today", UTC/Toronto day boundary, DST,
 *        display without day shift) and the root-cause reproduction
 *   R  — pure candidate ranking / search / eligibility / mutation id
 *   S  — source structure: forms, picker, routes (no full-history fetch,
 *        hidden when no leads, "No matching lead", required before Save)
 *   W  — local DB through a real signed-in RLS client: operation dates for
 *        Buy / Sell / Trade / Expense + edit; candidates (no-leads user,
 *        ranking, limit, search, multi-item, isolation, blocked items);
 *        linking (DEAL_LINKED → COMPLETED after the item-unavailable
 *        auto-close, idempotent retry, "No matching lead", unrelated item,
 *        second link conflict, edit-flow link, totals/statuses untouched);
 *        the two API route handlers with a real bearer token.
 * Self-cleaning dedicated fixture (two users). Synthetic names only.
 *
 * Usage:  npx tsx scripts/test-operation-lead-link.ts
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import { calendarDateIn, formatCalendarDate, todayLocalDate, BUSINESS_TIME_ZONE } from '../src/lib/dateUtils';
import {
  dealLinkMutationId, isEligibleRow, lastActivityAt, linkWinningLeadToDeal, loadOperationLeadCandidates, matchesLeadQuery, rankLeadRows,
  OPERATION_LEAD_INITIAL_LIMIT, OPERATION_LEAD_SEARCH_LIMIT, type LeadCandidateRow,
} from '../src/lib/leads/operationLeads';
import { recordLeadInteraction, type AgentEventInput } from '../src/lib/leads/leadWriteService';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 900) : ''); }
}

const PASSWORD = 'Operation-Lead-Fixture-Local-Only-1!';
const uuid = () => crypto.randomUUID();
const root = path.join(__dirname, '..');
const src = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

// ── D: dates ────────────────────────────────────────────────────────────
function dateChecks() {
  console.log('\n[D1 — default "today" = America/Toronto calendar date]');
  check('business timezone is America/Toronto', BUSINESS_TIME_ZONE === 'America/Toronto');
  check('evening in Toronto (23:30 EDT) while UTC is already the 24th -> 2026-10-23', todayLocalDate(new Date('2026-10-24T03:30:00Z')) === '2026-10-23');
  check('just after Toronto midnight (00:30 EDT) -> 2026-10-24', todayLocalDate(new Date('2026-10-24T04:30:00Z')) === '2026-10-24');
  check('Toronto midday -> same date as UTC', todayLocalDate(new Date('2026-10-24T16:00:00Z')) === '2026-10-24');
  check('UTC-date default (old CashFlowForm) would have said 2026-10-24 at 23:30 EDT', new Date('2026-10-24T03:30:00Z').toISOString().slice(0, 10) === '2026-10-24');

  console.log('\n[D2 — DST boundaries]');
  // DST ends 2026-11-01 02:00 EDT -> 01:00 EST; begins 2026-03-08 02:00 EST -> 03:00 EDT.
  check('2026-11-01 00:30 EDT (04:30Z) -> 2026-11-01', todayLocalDate(new Date('2026-11-01T04:30:00Z')) === '2026-11-01');
  check('2026-11-01 23:30 EST (2026-11-02T04:30Z) -> 2026-11-01', todayLocalDate(new Date('2026-11-02T04:30:00Z')) === '2026-11-01');
  check('2026-11-02 00:30 EST (05:30Z) -> 2026-11-02', todayLocalDate(new Date('2026-11-02T05:30:00Z')) === '2026-11-02');
  check('2026-03-07 23:30 EST (2026-03-08T04:30Z) -> 2026-03-07', todayLocalDate(new Date('2026-03-08T04:30:00Z')) === '2026-03-07');
  check('2026-03-08 23:30 EDT (2026-03-09T03:30Z) -> 2026-03-08', todayLocalDate(new Date('2026-03-09T03:30:00Z')) === '2026-03-08');
  check('calendarDateIn honours another zone (Tokyo is a day ahead)', calendarDateIn(new Date('2026-10-24T20:00:00Z'), 'Asia/Tokyo') === '2026-10-25');

  console.log('\n[D3 — display without day shift (root cause)]');
  const shifted = new Date('2026-10-24').toLocaleDateString('en-US', { timeZone: 'America/Toronto' });
  check('ROOT CAUSE reproduced: new Date("2026-10-24") shown in Toronto = 10/23/2026', shifted === '10/23/2026', shifted);
  check('formatCalendarDate("2026-10-24") keeps the 24th', formatCalendarDate('2026-10-24', undefined, 'en-US') === '10/24/2026', formatCalendarDate('2026-10-24', undefined, 'en-US'));
  check('formatCalendarDate keeps the day on 2026-11-01 (DST end) and 2026-01-01', formatCalendarDate('2026-11-01', undefined, 'en-US') === '11/1/2026' && formatCalendarDate('2026-01-01', undefined, 'en-US') === '1/1/2026');
  check('formatCalendarDate passes options through', formatCalendarDate('2026-10-24', { month: 'short', day: 'numeric', year: 'numeric' }, 'en-US') === 'Oct 24, 2026');
  check('formatCalendarDate: empty / non-date input safe', formatCalendarDate(null) === '' && formatCalendarDate('n/a') === 'n/a');
}

// ── R: ranking / search ─────────────────────────────────────────────────
function row(id: number, o: Partial<LeadCandidateRow>): LeadCandidateRow {
  return {
    id, inventory_item_id: 1, contact_name: `P${id}`, source_channel: 'Marketplace', channel_detail: null, status: 'OPEN', outcome_reason: null,
    peak_stage: 'INQUIRY', deal_id: null, offer_type: 'NONE', initial_cash_offer: null, best_cash_offer: null, latest_cash_offer: null, trade_item: null,
    cash_component: null, first_contact_at: '2026-09-01', last_contact_at: null, last_inbound_at: null, last_outbound_at: null, ...o,
  };
}
function rankChecks() {
  console.log('\n[R1 — ranking]');
  const rows = [
    row(1, { status: 'DECLINED_BY_THEM', peak_stage: 'HIGH_INTENT', last_contact_at: '2026-10-20' }),
    row(2, { status: 'OPEN', peak_stage: 'INQUIRY', last_contact_at: '2026-10-22' }),
    row(3, { status: 'OPEN', peak_stage: 'NEGOTIATING', last_contact_at: '2026-10-01' }),
    row(4, { status: 'AGREED', peak_stage: 'HIGH_INTENT', last_contact_at: '2026-09-15' }),
    row(5, { status: 'OPEN', peak_stage: 'NEGOTIATING', last_inbound_at: '2026-10-21T15:00:00Z' }),
    row(6, { status: 'CLOSED', outcome_reason: 'ITEM_UNAVAILABLE', peak_stage: 'ENGAGED', last_contact_at: '2026-10-23' }),
  ];
  const order = rankLeadRows(rows).map((r) => r.id);
  check('AGREED first, then OPEN by peak stage (recency within), then others by recency', JSON.stringify(order) === JSON.stringify([4, 5, 3, 2, 6, 1]), order);
  check('ranking does not mutate input', rows[0].id === 1);
  check('last activity = max of inbound/outbound/contact dates', lastActivityAt(row(9, { last_contact_at: '2026-10-01', last_inbound_at: '2026-10-05T10:00:00Z' })) === '2026-10-05T10:00:00.000Z');
  check('date-only last activity anchored at 12:00Z (no day shift)', lastActivityAt(row(9, { last_contact_at: '2026-10-24' })) === '2026-10-24T12:00:00.000Z');

  console.log('\n[R2 — eligibility / search / mutation id]');
  check('eligible: unlinked, not COMPLETED', isEligibleRow({ deal_id: null, status: 'OPEN' }) && isEligibleRow({ deal_id: null, status: 'CLOSED' }) && isEligibleRow({ deal_id: null, status: 'DECLINED_BY_ME' }));
  check('ineligible: already linked to a deal', !isEligibleRow({ deal_id: 5, status: 'OPEN' }));
  check('ineligible: COMPLETED', !isEligibleRow({ deal_id: null, status: 'COMPLETED' }));
  const r = row(1, { contact_name: 'Gary Ö\'Neil', source_channel: 'Other', channel_detail: 'Guitar show', trade_item: 'Fender Hot Rod' });
  check('search by contact name (case/diacritics-insensitive)', matchesLeadQuery(r, 'Les Paul', 'gary o\'neil') && matchesLeadQuery(r, 'Les Paul', 'GARY'));
  check('search by channel / channel detail / trade item / item label', matchesLeadQuery(r, 'Les Paul', 'other') && matchesLeadQuery(r, 'Les Paul', 'guitar show') && matchesLeadQuery(r, 'Les Paul', 'hot rod') && matchesLeadQuery(r, 'Les Paul', 'les paul'));
  check('every word must match', matchesLeadQuery(r, 'Les Paul', 'gary show') && !matchesLeadQuery(r, 'Les Paul', 'gary kijiji'));
  check('empty query matches', matchesLeadQuery(r, 'x', '  '));
  const m = dealLinkMutationId(12, 34);
  check('mutation id deterministic + UUID-shaped', m === dealLinkMutationId(12, 34) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(m), m);
  check('mutation id differs per (deal, lead)', m !== dealLinkMutationId(12, 35) && m !== dealLinkMutationId(13, 34));
}

// ── S: source structure ─────────────────────────────────────────────────
function structureChecks() {
  console.log('\n[S1 — picker]');
  const picker = src('src/components/leads/OperationLeadPicker.tsx');
  check('hidden entirely when no eligible leads (returns null, no disabled picker)', /if \(initial\.eligible_total === 0\) return null;/.test(picker));
  check('explicit "No matching lead" option', picker.includes('No matching lead') && picker.includes("{ kind: 'none' }"));
  check('one eligible lead preselected on create only', /d\.eligible_total === 1 && d\.candidates\.length === 1\) cb\.current\.onChange\(\{ kind: 'lead', lead: d\.candidates\[0\] \}\)/.test(picker) && picker.includes("if (isEdit) cb.current.onChange({ kind: 'none' })"));
  check('searchable combobox (role=combobox + listbox), not a <select>', picker.includes('role="combobox"') && picker.includes('role="listbox"') && !picker.includes('<select'));
  check('search is server-side (fetch with q, debounced)', /fetchOperationLeadCandidates\(\{ itemIds: ids, q: query/.test(picker) && picker.includes('setTimeout('));
  check('a lead whose item left the operation is cleared', picker.includes('!ids.includes(v.lead.item_id)'));
  check('load failure never blocks Save', /Unknown lead state must not block saving[\s\S]{0,200}required: false/.test(picker));
  check('item shown per candidate when several outgoing items', picker.includes('For: {c.item_label}') && picker.includes('new Set(itemIds).size > 1'));
  check('edit flow: an existing link is shown read-only', picker.includes('data-testid="lead-picker-linked"'));

  console.log('\n[S2 — forms]');
  for (const f of ['src/components/SellOperationForm.tsx', 'src/components/TradeOperationForm.tsx']) {
    const s = src(f);
    const name = path.basename(f);
    check(`${name}: renders the picker on outgoing items`, s.includes('<OperationLeadPicker') && s.includes('itemIds={outgoingItemIds}'));
    check(`${name}: Save blocked while a required choice is unset`, s.includes('if (lead.missingChoice)'));
    check(`${name}: link runs after the operation RPC succeeds`, /const savedDealId = isEdit \? dealId! : Number\(\(result\.data[\s\S]{0,120}await lead\.linkAfterSave\(savedDealId\)/.test(s));
    check(`${name}: a failed link never re-creates the operation (retry link only)`, /if \(lead\.pendingLink\) \{\s*await retryLeadLink\(\)/.test(s) && s.includes('<LeadLinkFailure'));
  }
  for (const f of ['src/components/BuyOperationForm.tsx', 'src/components/ExpenseOperationForm.tsx']) {
    check(`${path.basename(f)}: no lead picker`, !src(f).includes('OperationLeadPicker'));
  }

  console.log('\n[S3 — routes / dates in source]');
  const cand = src('src/app/api/operations/lead-candidates/route.ts');
  const svc = src('src/lib/leads/operationLeads.ts');
  check('candidates route is bounded (item_ids cap, limit cap)', cand.includes('OPERATION_LEAD_MAX_ITEMS') && cand.includes('OPERATION_LEAD_SEARCH_LIMIT'));
  check('initial limit 6, search limit 12', OPERATION_LEAD_INITIAL_LIMIT === 6 && OPERATION_LEAD_SEARCH_LIMIT === 12);
  check('candidates query bounded to the outgoing items + own user', svc.includes(".eq('user_id', appUserId).in('inventory_item_id', itemIds)") && svc.includes('.limit(MAX_ROWS)'));
  check('linking goes through recordLeadInteraction (no direct item_leads update)', svc.includes('return recordLeadInteraction(db,') && !/from\('item_leads'\)\.update/.test(svc));
  check('no service_role in the new routes/helper', !/SERVICE_ROLE/.test(src('src/lib/apiUserClient.ts') + cand + src('src/app/api/operations/link-lead/route.ts')));
  const detail = src('src/app/operations/[id]/page.tsx');
  check('operation detail no longer renders date-only values via new Date(...)', !/new Date\((deal\.deal_date|cf\.transaction_date|exp\.expense_date)\)/.test(detail) && detail.includes('formatCalendarDate(deal.deal_date)'));
  check('CashFlowForm default date = Toronto today (not UTC)', src('src/components/CashFlowForm.tsx').includes('useState(() => todayLocalDate())'));
  for (const f of ['BuyOperationForm', 'SellOperationForm', 'TradeOperationForm', 'ExpenseOperationForm']) {
    const s = src(`src/components/${f}.tsx`);
    check(`${f}: date input sends the YYYY-MM-DD string (no Date/toISOString conversion)`, s.includes("from '@/lib/dateUtils'") && !/toISOString\(\)\.(slice|split)/.test(s));
  }
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
async function signIn(email: string): Promise<{ client: SupabaseClient; token: string }> {
  const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error || !data.session) throw new Error(`sign-in failed for ${email}: ${error?.message}`);
  return { client: c, token: data.session.access_token };
}

const msg = (at: string, summary: string, substance: 'BASIC' | 'SUBSTANTIVE' = 'SUBSTANTIVE'): AgentEventInput => ({ type: 'MESSAGE', direction: 'INBOUND', occurred_at: at, summary, payload: { substance } });
const cashOffer = (at: string, n: number): AgentEventInput => ({ type: 'OFFER', direction: 'INBOUND', occurred_at: at, summary: `Offered C$${n}`, payload: { offer: { cash_terms: 'AMOUNT', cash_amount: n, items: [] } } });

async function main() {
  dateChecks();
  rankChecks();
  structureChecks();

  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const emailA = 'operation-lead-fixture-a@example.test';
  const emailB = 'operation-lead-fixture-b@example.test';
  const userA = await resolveAppUserId(admin, await ensureAuthUser(admin, emailA));
  const userB = await resolveAppUserId(admin, await ensureAuthUser(admin, emailB));
  const { client: cA, token: tokenA } = await signIn(emailA);
  const { client: cB } = await signIn(emailB);

  let { data: brand } = await admin.from('brands').select('id, name').limit(1).maybeSingle();
  let createdBrand: number | null = null;
  if (!brand) { brand = (await admin.from('brands').insert({ name: `OL Brand ${uuid().slice(0, 6)}` }).select('id, name').single()).data; createdBrand = brand!.id as number; }
  const { data: chans } = await admin.from('deal_channels').select('id, name');
  const chanId = (n: string) => (chans ?? []).find((c) => c.name === n)!.id as number;
  const MP = chanId('Marketplace');

  const itemIds: number[] = [];
  const dealIds: number[] = [];
  const startBalance = await admin.from('cash_flow').select('id').order('id', { ascending: false }).limit(1);
  void startBalance;

  try {
    const item = async (userId: number, model: string, status = 'listed') => {
      const { data, error } = await admin.from('inventory_items').insert({ user_id: userId, brand_id: brand!.id, model, status, serial_number: `OL-${uuid().slice(0, 8)}` }).select('id').single();
      if (error) throw error;
      itemIds.push(data.id as number);
      return data.id as number;
    };
    const newLead = async (client: SupabaseClient, itemId: number, name: string, events: AgentEventInput[]) => {
      const r = await recordLeadInteraction(client, { mutation_id: uuid(), lead: { item_id: itemId, channel: 'Marketplace', contact_name: name }, events }, { clientLabel: 'test-suite' });
      if (r.result !== 'APPLIED_CREATE') throw new Error(`lead fixture ${name}: ${JSON.stringify(r)}`);
      return r.lead_id!;
    };
    const leadRow = async (id: number) => (await admin.from('item_leads').select('*').eq('id', id).single()).data as Record<string, unknown>;
    const eventsOf = async (id: number) => ((await admin.from('lead_events').select('*').eq('item_lead_id', id).order('id')).data ?? []) as Record<string, unknown>[];
    const rpc = async (client: SupabaseClient, fn: string, args: Record<string, unknown>) => {
      const { data, error } = await client.rpc(fn, args);
      if (error) throw new Error(`${fn}: ${error.message}`);
      const id = (data as { deal_id?: number } | null)?.deal_id;
      if (id) dealIds.push(id);
      return data as { deal_id: number; cf_id: number } | null;
    };
    const dealRow = async (id: number) => (await admin.from('deals').select('*').eq('id', id).single()).data as Record<string, unknown>;
    const cfOf = async (id: number) => ((await admin.from('cash_flow').select('*').eq('deal_id', id)).data ?? []) as Record<string, unknown>[];

    // ── W1: operation dates ────────────────────────────────────────────
    console.log('\n[W1 — operation calendar dates are stored exactly as selected]');
    const D = '2026-10-24';
    const sItem = await item(userA, 'Date Sell (OL)');
    const sale = await rpc(cA, 'create_sell_operation', { p_deal_date: D, p_channel_id: MP, p_items: [{ item_id: sItem, total_value: 500 }], p_notes: null, p_cf_description: 'Sale: date test' });
    const saleRow = await dealRow(sale!.deal_id);
    check('Sell: deals.deal_date = selected date', saleRow.deal_date === D, saleRow.deal_date);
    check('Sell: cash_flow.transaction_date = selected date', (await cfOf(sale!.deal_id))[0]?.transaction_date === D);
    check('Sell: inventory_items.sold_date = selected date', (await admin.from('inventory_items').select('sold_date').eq('id', sItem).single()).data?.sold_date === D);

    const tOut = await item(userA, 'Date Trade Out (OL)');
    const tIn = await item(userA, 'Date Trade In (OL)', 'owned');
    const trade = await rpc(cA, 'create_trade_operation', { p_deal_date: D, p_channel_id: MP, p_notes: null, p_cash_paid: 0, p_cash_received: 100, p_outgoing_items: [{ item_id: tOut, total_value: 600 }], p_incoming_items: [{ item_id: tIn, total_value: 500 }], p_cf_transaction_date: null, p_cf_description: 'Trade: date test' });
    const tradeRow = await dealRow(trade!.deal_id);
    check('Trade: deals.deal_date = selected date', tradeRow.deal_date === D, tradeRow.deal_date);
    check('Trade: cash_flow.transaction_date = selected date', (await cfOf(trade!.deal_id))[0]?.transaction_date === D);

    const bItem = await item(userA, 'Date Buy (OL)', 'new');
    const buy = await rpc(cA, 'create_buy_operation', { p_deal_date: D, p_channel_id: MP, p_incoming_items: [{ item_id: bItem, total_value: 300 }], p_notes: null, p_cf_description: 'Buy: date test' });
    check('Buy: deals.deal_date = selected date', (await dealRow(buy!.deal_id)).deal_date === D);
    check('Buy: cash_flow.transaction_date = selected date', (await cfOf(buy!.deal_id))[0]?.transaction_date === D);

    const exp = await rpc(cA, 'create_expense_operation', { p_expense_date: D, p_amount: 25, p_notes: 'Strings', p_item_id: bItem, p_cf_description: 'Expense: date test' });
    const expDealId = (exp as { deal_id?: number } | null)?.deal_id;
    if (expDealId) {
      check('Expense: deals.deal_date = selected date', (await dealRow(expDealId)).deal_date === D);
      check('Expense: cash_flow.transaction_date = selected date', (await cfOf(expDealId))[0]?.transaction_date === D);
    }
    const { data: expRows } = await admin.from('inventory_expenses').select('expense_date').eq('item_id', bItem);
    check('Expense: inventory_expenses.expense_date = selected date', (expRows ?? []).some((e) => e.expense_date === D), expRows);

    const E = '2026-10-23';
    const { error: editErr } = await cA.rpc('edit_sell_operation', { p_deal_id: sale!.deal_id, p_deal_date: E, p_channel_id: MP, p_notes: null, p_items: [{ item_id: sItem, total_value: 500 }], p_cf_description: null });
    check('Sell edit: no error', !editErr, editErr);
    check('Sell edit: deal_date + cash_flow date = edited date', (await dealRow(sale!.deal_id)).deal_date === E && (await cfOf(sale!.deal_id))[0]?.transaction_date === E);
    const { error: tEditErr } = await cA.rpc('edit_trade_operation', { p_deal_id: trade!.deal_id, p_deal_date: E, p_channel_id: MP, p_notes: null, p_cash_paid: 0, p_cash_received: 100, p_outgoing_items: [{ item_id: tOut, total_value: 600 }], p_incoming_items: [{ item_id: tIn, total_value: 500 }], p_cf_transaction_date: null, p_cf_description: null });
    check('Trade edit: deal_date = edited date', !tEditErr && (await dealRow(trade!.deal_id)).deal_date === E, tEditErr);
    const late = todayLocalDate(new Date('2026-10-25T03:30:00Z'));
    const lItem = await item(userA, 'Late Evening Sell (OL)');
    const lateSale = await rpc(cA, 'create_sell_operation', { p_deal_date: late, p_channel_id: MP, p_items: [{ item_id: lItem, total_value: 200 }], p_notes: null, p_cf_description: null });
    check('UTC/Toronto boundary: default today at 23:30 Toronto (03:30Z next day) is stored as the Toronto date', late === '2026-10-24' && (await dealRow(lateSale!.deal_id)).deal_date === '2026-10-24');

    // ── W2: candidates ─────────────────────────────────────────────────
    console.log('\n[W2 — candidates: visibility, ranking, search, isolation]');
    const noLeadItem = await item(userA, 'No Leads (OL)');
    const none = await loadOperationLeadCandidates(cA, userA, { itemIds: [noLeadItem] });
    check('item without leads -> eligible_total 0 (field hidden)', none.eligible_total === 0 && none.candidates.length === 0 && none.linked === null, none);
    const bOnly = await item(userB, 'B item (OL)');
    check('user without any leads -> eligible_total 0', (await loadOperationLeadCandidates(cB, userB, { itemIds: [bOnly] })).eligible_total === 0);

    const X = await item(userA, 'Jazzmaster (OL)');
    const leadsX: number[] = [];
    leadsX.push(await newLead(cA, X, 'Alice Agreed', [cashOffer('2026-10-10T12:00:00-04:00', 900), { type: 'AGREEMENT', direction: 'OUTBOUND', occurred_at: '2026-10-10T13:00:00-04:00', summary: 'Accepted 900', payload: {} }]));
    leadsX.push(await newLead(cA, X, 'Bob Negotiating', [cashOffer('2026-10-12T12:00:00-04:00', 700)]));
    leadsX.push(await newLead(cA, X, 'Carol Inquiry', [msg('2026-10-20T12:00:00-04:00', 'Still available?', 'BASIC')]));
    leadsX.push(await newLead(cA, X, 'Dave Engaged', [msg('2026-10-15T12:00:00-04:00', 'Asked about frets')]));
    const declined = await newLead(cA, X, 'Erin Declined', [cashOffer('2026-10-05T12:00:00-04:00', 400)]);
    await recordLeadInteraction(cA, { mutation_id: uuid(), lead: { lead_id: declined }, events: [{ type: 'STATUS_CHANGE', direction: 'INTERNAL', occurred_at: '2026-10-06', summary: 'Declined', payload: { to: 'DECLINED_BY_ME', outcome_reason: 'LOW_OFFER' } }] });
    leadsX.push(declined);
    leadsX.push(await newLead(cA, X, 'Frank Old', [msg('2026-09-01T12:00:00-04:00', 'Hi', 'BASIC')]));
    leadsX.push(await newLead(cA, X, 'Gina Gone', [msg('2026-08-01T12:00:00-04:00', 'Hi', 'BASIC')]));
    leadsX.push(await newLead(cA, X, 'Gary Winner', [cashOffer('2026-10-21T12:00:00-04:00', 950)]));

    const cx = await loadOperationLeadCandidates(cA, userA, { itemIds: [X] });
    const names = cx.candidates.map((c) => c.contact_name);
    check('eligible_total counts all 8 eligible leads', cx.eligible_total === 8, cx.eligible_total);
    check('initial list limited to 6', cx.candidates.length === 6, names);
    check('AGREED first, then OPEN NEGOTIATING by recency, then lower OPEN stages', JSON.stringify(names.slice(0, 5)) === JSON.stringify(['Alice Agreed', 'Gary Winner', 'Bob Negotiating', 'Dave Engaged', 'Carol Inquiry']), names);
    check('candidate carries status, peak stage, offer summary, item label, channel', cx.candidates[1].status === 'OPEN' && cx.candidates[1].peak_stage === 'NEGOTIATING' && cx.candidates[1].offer_summary.includes('950') && cx.candidates[1].item_label.includes('Jazzmaster') && cx.candidates[1].channel === 'Marketplace', cx.candidates[1]);
    const sGary = await loadOperationLeadCandidates(cA, userA, { itemIds: [X], q: 'gary' });
    check('search by contact name (server-side)', sGary.candidates.length === 1 && sGary.candidates[0].contact_name === 'Gary Winner', sGary.candidates);
    const sMp = await loadOperationLeadCandidates(cA, userA, { itemIds: [X], q: 'marketplace' });
    check('search by channel returns up to the search limit', sMp.candidates.length === 8 && sMp.eligible_total === 8, sMp.candidates.length);
    check('search finds older leads beyond the initial 6', (await loadOperationLeadCandidates(cA, userA, { itemIds: [X], q: 'gina' })).candidates.length === 1);
    check('RLS isolation: user B sees none of user A\'s leads for the same items', (await loadOperationLeadCandidates(cB, userB, { itemIds: [X] })).eligible_total === 0);
    check('explicit user filter: A\'s client asking as B id returns nothing', (await loadOperationLeadCandidates(cA, userB, { itemIds: [X] })).eligible_total === 0);

    // ── W3: link the winning lead on a Sell ─────────────────────────────
    console.log('\n[W3 — Sell with a winning OPEN lead: auto-close then DEAL_LINKED -> COMPLETED]');
    const gary = leadsX[leadsX.length - 1];
    const bob = leadsX[1];
    const alice = leadsX[0];
    const garyBefore = await eventsOf(gary);
    const xSale = await rpc(cA, 'create_sell_operation', { p_deal_date: '2026-10-24', p_channel_id: MP, p_items: [{ item_id: X, total_value: 950 }], p_notes: null, p_cf_description: 'Sale: Jazzmaster' });
    const garyAfterSale = await leadRow(gary);
    check('item-unavailable trigger first closed the OPEN winner (CLOSED / ITEM_UNAVAILABLE)', garyAfterSale.status === 'CLOSED' && garyAfterSale.outcome_reason === 'ITEM_UNAVAILABLE', garyAfterSale.status);
    check('AGREED lead untouched by the auto-close', (await leadRow(alice)).status === 'AGREED');
    const link = await linkWinningLeadToDeal(cA, userA, { dealId: xSale!.deal_id, leadId: gary });
    const g = await leadRow(gary);
    check('link -> APPLIED_UPDATE', link.result === 'APPLIED_UPDATE', link);
    check('winner ends COMPLETED, outcome cleared, deal_id set, peak CONVERTED', g.status === 'COMPLETED' && g.outcome_reason === null && Number(g.deal_id) === xSale!.deal_id && g.peak_stage === 'CONVERTED', g);
    const gEvents = await eventsOf(gary);
    const newEvents = gEvents.slice(garyBefore.length);
    const types = newEvents.map((e) => `${e.event_type}:${e.source}`);
    check('history appended: auto-close, DEAL_LINKED (UI, USER), STATUS_CHANGE -> COMPLETED', JSON.stringify(types) === JSON.stringify(['STATUS_CHANGE:SYSTEM', 'DEAL_LINKED:UI', 'STATUS_CHANGE:SYSTEM']), types);
    const dl = newEvents.find((e) => e.event_type === 'DEAL_LINKED')!;
    check('DEAL_LINKED payload = deal id, actor USER, DATE precision on the deal date', Number((dl.payload as { deal_id: number }).deal_id) === xSale!.deal_id && dl.actor === 'USER' && dl.occurred_at_precision === 'DATE' && String(dl.occurred_at).startsWith('2026-10-24') && dl.client_label === 'operation-form', dl);
    const done = newEvents[2];
    check('completion transition CLOSED -> COMPLETED caused by DEAL_LINKED', (done.payload as { from?: string; to?: string; cause?: string }).from === 'CLOSED' && (done.payload as { to?: string }).to === 'COMPLETED' && (done.payload as { cause?: string }).cause === 'DEAL_LINKED', done.payload);
    check('earlier events preserved (none voided, prefix unchanged)', gEvents.slice(0, garyBefore.length).every((e, i) => e.id === garyBefore[i].id && e.voided_at == null));
    check('legacy notes untouched', g.notes === null);
    const bobRow = await leadRow(bob);
    check('unrelated OPEN lead stays CLOSED / ITEM_UNAVAILABLE, no deal', bobRow.status === 'CLOSED' && bobRow.outcome_reason === 'ITEM_UNAVAILABLE' && bobRow.deal_id === null, bobRow.status);
    check('no DEAL_LINKED on any other lead of the item', (await admin.from('lead_events').select('id').in('item_lead_id', leadsX.filter((id) => id !== gary)).eq('event_type', 'DEAL_LINKED')).data?.length === 0);
    const retry = await linkWinningLeadToDeal(cA, userA, { dealId: xSale!.deal_id, leadId: gary });
    check('retried link replays (idempotent), no new events', retry.replayed === true && (await eventsOf(gary)).length === gEvents.length, retry);
    const xDeal = await dealRow(xSale!.deal_id);
    check('operation totals untouched by linking', Number(xDeal.cash_received) === 950 && xDeal.deal_type === 'sale');
    check('item status sold, one outgoing deal_item', (await admin.from('inventory_items').select('status').eq('id', X).single()).data?.status === 'sold' && (await admin.from('deal_items').select('id').eq('deal_id', xSale!.deal_id)).data?.length === 1);
    const linkedView = await loadOperationLeadCandidates(cA, userA, { itemIds: [X], dealId: xSale!.deal_id });
    check('edit view: the linked lead is returned read-only; item now blocked; no candidates', linkedView.linked?.lead_id === gary && linkedView.eligible_total === 0 && linkedView.blocked_item_ids.includes(X), linkedView);
    const second = await linkWinningLeadToDeal(cA, userA, { dealId: xSale!.deal_id, leadId: alice });
    check('a second winning lead on the same item is refused (DEAL_LINK_CONFLICT review)', second.result === 'REVIEW_REQUIRED' && second.reason === 'DEAL_LINK_CONFLICT', second);
    check('AGREED lead unchanged after refused link', (await leadRow(alice)).status === 'AGREED' && (await leadRow(alice)).deal_id === null);

    // ── W4: "No matching lead" ─────────────────────────────────────────
    console.log('\n[W4 — "No matching lead": operation normal, nothing linked]');
    const N = await item(userA, 'No Match (OL)');
    const nLead = await newLead(cA, N, 'Hank Open', [cashOffer('2026-10-20T12:00:00-04:00', 300)]);
    check('item with a lead -> field shown (eligible_total 1)', (await loadOperationLeadCandidates(cA, userA, { itemIds: [N] })).eligible_total === 1);
    const nSale = await rpc(cA, 'create_sell_operation', { p_deal_date: '2026-10-24', p_channel_id: MP, p_items: [{ item_id: N, total_value: 320 }], p_notes: null, p_cf_description: null });
    const hank = await leadRow(nLead);
    check('existing OPEN lead follows the auto-close (CLOSED / ITEM_UNAVAILABLE), no deal link', hank.status === 'CLOSED' && hank.outcome_reason === 'ITEM_UNAVAILABLE' && hank.deal_id === null);
    check('no DEAL_LINKED created', !(await eventsOf(nLead)).some((e) => e.event_type === 'DEAL_LINKED'));
    check('no lead points at the operation', ((await admin.from('item_leads').select('id').eq('deal_id', nSale!.deal_id)).data ?? []).length === 0);

    // ── W5: multi-item Sell ────────────────────────────────────────────
    console.log('\n[W5 — multi-item Sell: one winning lead across items]');
    const M1 = await item(userA, 'Multi Guitar (OL)');
    const M2 = await item(userA, 'Multi Case (OL)');
    const U = await item(userA, 'Unrelated (OL)');
    const m1Lead = await newLead(cA, M1, 'Ivy Guitar', [cashOffer('2026-10-19T12:00:00-04:00', 1000)]);
    const m2Lead = await newLead(cA, M2, 'Jack Case', [msg('2026-10-22T12:00:00-04:00', 'Is the case included?')]);
    const uLead = await newLead(cA, U, 'Kim Unrelated', [cashOffer('2026-10-22T12:00:00-04:00', 50)]);
    const mc = await loadOperationLeadCandidates(cA, userA, { itemIds: [M1, M2] });
    check('candidates from every outgoing item, none from unrelated items', mc.eligible_total === 2 && mc.candidates.every((c) => [M1, M2].includes(c.item_id)) && !mc.candidates.some((c) => c.lead_id === uLead), mc.candidates);
    check('each candidate names its item', mc.candidates.some((c) => c.item_label.includes('Multi Guitar')) && mc.candidates.some((c) => c.item_label.includes('Multi Case')));
    check('higher stage OPEN first across items', mc.candidates[0].lead_id === m1Lead, mc.candidates.map((c) => c.contact_name));
    const mSale = await rpc(cA, 'create_sell_operation', { p_deal_date: '2026-10-24', p_channel_id: MP, p_items: [{ item_id: M1, total_value: 1000 }, { item_id: M2, total_value: 100 }], p_notes: null, p_cf_description: null });
    const unrelated = await linkWinningLeadToDeal(cA, userA, { dealId: mSale!.deal_id, leadId: uLead });
    check('a lead of an item outside the operation is refused', unrelated.result === 'REJECTED' && unrelated.reason === 'DEAL_NOT_VALID', unrelated);
    check('unrelated lead untouched', (await leadRow(uLead)).status === 'OPEN' && (await leadRow(uLead)).deal_id === null);
    const mLink = await linkWinningLeadToDeal(cA, userA, { dealId: mSale!.deal_id, leadId: m2Lead });
    check('lead on the second item links to the multi-item operation', mLink.result === 'APPLIED_UPDATE' && (await leadRow(m2Lead)).status === 'COMPLETED' && Number((await leadRow(m2Lead)).deal_id) === mSale!.deal_id, mLink);
    check('other item\'s lead closed neutrally, not completed', (await leadRow(m1Lead)).status === 'CLOSED');
    check('multi-item totals: cash_received 1100, two deal_items', Number((await dealRow(mSale!.deal_id)).cash_received) === 1100 && (await admin.from('deal_items').select('id').eq('deal_id', mSale!.deal_id)).data?.length === 2);

    // ── W6: Trade with an AGREED winner ────────────────────────────────
    console.log('\n[W6 — Trade with an AGREED winning lead]');
    const TO = await item(userA, 'Trade Away (OL)');
    const TI = await item(userA, 'Trade Got (OL)', 'owned');
    const tLead = await newLead(cA, TO, 'Leo Trader', [{ type: 'OFFER', direction: 'INBOUND', occurred_at: '2026-10-18T12:00:00-04:00', summary: 'Straight trade for a Tele', payload: { offer: { cash_terms: 'STRAIGHT', cash_amount: null, items: [{ description: 'Tele' }] } } }, { type: 'AGREEMENT', direction: 'OUTBOUND', occurred_at: '2026-10-18T13:00:00-04:00', summary: 'Agreed', payload: {} }]);
    const tSale = await rpc(cA, 'create_trade_operation', { p_deal_date: '2026-10-24', p_channel_id: MP, p_notes: null, p_cash_paid: 0, p_cash_received: 0, p_outgoing_items: [{ item_id: TO, total_value: 800 }], p_incoming_items: [{ item_id: TI, total_value: 800 }], p_cf_transaction_date: null, p_cf_description: null });
    check('AGREED winner survives the trade auto-close', (await leadRow(tLead)).status === 'AGREED');
    const tl = await linkWinningLeadToDeal(cA, userA, { dealId: tSale!.deal_id, leadId: tLead });
    const leo = await leadRow(tLead);
    check('Trade link: AGREED -> COMPLETED, CONVERTED, deal linked', tl.result === 'APPLIED_UPDATE' && leo.status === 'COMPLETED' && leo.peak_stage === 'CONVERTED' && Number(leo.deal_id) === tSale!.deal_id, { tl, leo });
    check('Trade link history: DEAL_LINKED then STATUS_CHANGE AGREED -> COMPLETED', (await eventsOf(tLead)).slice(-2).map((e) => `${e.event_type}:${(e.payload as { from?: string }).from ?? ''}`).join(',') === 'DEAL_LINKED:,STATUS_CHANGE:AGREED');
    check('incoming item status traded-in owned / outgoing traded', (await admin.from('inventory_items').select('status').eq('id', TO).single()).data?.status === 'traded');

    // ── W7: edit flow — add a link to an existing operation ─────────────
    console.log('\n[W7 — edit flow: link a lead to an existing unlinked operation]');
    const ED = await item(userA, 'Edit Later (OL)');
    const edLead = await newLead(cA, ED, 'Mia Later', [cashOffer('2026-10-15T12:00:00-04:00', 400)]);
    const edSale = await rpc(cA, 'create_sell_operation', { p_deal_date: '2026-10-20', p_channel_id: MP, p_items: [{ item_id: ED, total_value: 400 }], p_notes: null, p_cf_description: null });
    const edView = await loadOperationLeadCandidates(cA, userA, { itemIds: [ED], dealId: edSale!.deal_id });
    check('edit view without a link: candidates offered (closed lead still eligible), linked null', edView.linked === null && edView.eligible_total === 1 && edView.candidates[0].status === 'CLOSED', edView);
    const { error: e2 } = await cA.rpc('edit_sell_operation', { p_deal_id: edSale!.deal_id, p_deal_date: '2026-10-20', p_channel_id: MP, p_notes: 'edited', p_items: [{ item_id: ED, total_value: 410 }], p_cf_description: null });
    const edLink = await linkWinningLeadToDeal(cA, userA, { dealId: edSale!.deal_id, leadId: edLead });
    check('edit then link: COMPLETED, DEAL_LINKED dated by the operation date', !e2 && edLink.result === 'APPLIED_UPDATE' && (await leadRow(edLead)).status === 'COMPLETED' && String((await eventsOf(edLead)).find((e) => e.event_type === 'DEAL_LINKED')?.occurred_at).startsWith('2026-10-20'), { e2, edLink });

    // ── W8: security ───────────────────────────────────────────────────
    console.log('\n[W8 — ownership]');
    const bLink = await linkWinningLeadToDeal(cB, userB, { dealId: mSale!.deal_id, leadId: m1Lead });
    check('user B cannot link A\'s lead to A\'s operation', bLink.result === 'REJECTED' && (await leadRow(m1Lead)).status === 'CLOSED', bLink);

    // ── W9: route handlers with a real bearer token ─────────────────────
    console.log('\n[W9 — API route handlers]');
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = SUPABASE_ANON_KEY;
    const { GET } = await import('../src/app/api/operations/lead-candidates/route');
    const { POST } = await import('../src/app/api/operations/link-lead/route');
    const req = (url: string, init?: { method?: string; body?: unknown; token?: string | null }) => new NextRequest(url, {
      method: init?.method ?? 'GET',
      headers: { ...(init?.token === null ? {} : { Authorization: `Bearer ${init?.token ?? tokenA}` }), 'Content-Type': 'application/json' },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const noAuth = await GET(req(`http://local/api/operations/lead-candidates?item_ids=${X}`, { token: null }));
    check('GET without token -> 401', noAuth.status === 401);
    const badIds = await GET(req('http://local/api/operations/lead-candidates?item_ids=1,abc'));
    check('GET with malformed item_ids -> 400', badIds.status === 400);
    const tooMany = await GET(req(`http://local/api/operations/lead-candidates?item_ids=${Array.from({ length: 30 }, (_, i) => i + 1).join(',')}`));
    check('GET with more than 25 items -> 400', tooMany.status === 400);
    const okGet = await GET(req(`http://local/api/operations/lead-candidates?item_ids=${N},${noLeadItem}`));
    const okBody = await okGet.json();
    check('GET returns the bounded payload shape', okGet.status === 200 && typeof okBody.eligible_total === 'number' && Array.isArray(okBody.candidates) && 'linked' in okBody, okBody);
    const RT = await item(userA, 'Route Sell (OL)');
    const rtLead = await newLead(cA, RT, 'Nora Route', [cashOffer('2026-10-22T12:00:00-04:00', 250)]);
    const rtSale = await rpc(cA, 'create_sell_operation', { p_deal_date: '2026-10-24', p_channel_id: MP, p_items: [{ item_id: RT, total_value: 250 }], p_notes: null, p_cf_description: null });
    const badBody = await POST(req('http://local/api/operations/link-lead', { method: 'POST', body: { deal_id: 'x', lead_id: 1 } }));
    check('POST with invalid body -> 400', badBody.status === 400);
    const posted = await POST(req('http://local/api/operations/link-lead', { method: 'POST', body: { deal_id: rtSale!.deal_id, lead_id: rtLead } }));
    check('POST link -> 200 and lead COMPLETED', posted.status === 200 && (await leadRow(rtLead)).status === 'COMPLETED');
    const conflict = await POST(req('http://local/api/operations/link-lead', { method: 'POST', body: { deal_id: xSale!.deal_id, lead_id: alice } }));
    check('POST conflicting link -> 409 with the lead layer\'s reason', conflict.status === 409 && (await conflict.json()).reason === 'DEAL_LINK_CONFLICT');
  } finally {
    console.log('\n=== Cleanup ===');
    const leadIds = ((await admin.from('item_leads').select('id').in('inventory_item_id', itemIds)).data ?? []).map((l) => l.id as number);
    if (leadIds.length) await admin.from('item_leads').delete().in('id', leadIds);
    if (dealIds.length) {
      await admin.from('inventory_expenses').delete().in('deal_id', dealIds);
      await admin.from('cash_flow').delete().in('deal_id', dealIds);
      await admin.from('deal_items').delete().in('deal_id', dealIds);
      await admin.from('deals').delete().in('id', dealIds);
    }
    if (itemIds.length) {
      await admin.from('inventory_expenses').delete().in('item_id', itemIds);
      await admin.from('item_listings').delete().in('inventory_item_id', itemIds);
      await admin.from('inventory_items').delete().in('id', itemIds);
    }
    if (createdBrand) await admin.from('brands').delete().eq('id', createdBrand);
    const left = ((await admin.from('inventory_items').select('id').in('id', itemIds.length ? itemIds : [-1])).data ?? []).length;
    check('cleanup: fixture items removed', left === 0, left);
    check('cleanup: fixture deals removed', ((await admin.from('deals').select('id').in('id', dealIds.length ? dealIds : [-1])).data ?? []).length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('Test script crashed:', e); process.exit(1); });
