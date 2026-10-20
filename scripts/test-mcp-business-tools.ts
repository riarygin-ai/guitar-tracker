/**
 * test-mcp-business-tools.ts
 *
 * Coverage for the four MCP tools added on 2026-10-19:
 *   find_contact_history    -> src/lib/analytics/contactHistoryService.ts (+ src/lib/leads/contactName.ts)
 *   get_operations_analysis -> src/lib/analytics/operationsService.ts
 *   get_operation_context   -> src/lib/analytics/operationsService.ts
 *   get_deal_chain          -> src/lib/analytics/dealChainService.ts (+ src/lib/tradeChain.ts)
 *
 * Pure checks first (name normalization/matching, date range), then one
 * dedicated, self-cleaning fixture: two users, Buy/Sell/multi-item Trade/
 * Expense/Historical operations across channels, item expenses, a
 * multi-step trade chain, and leads with contact names. Every service call
 * runs through a real signed-in (authenticated, RLS-scoped) client.
 *
 * Usage:  npx tsx scripts/test-mcp-business-tools.ts
 */

import crypto from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import { normalizeContactName, possibleNameMatch } from '../src/lib/leads/contactName';
import { findContactHistoryForUser, ContactHistoryServiceError } from '../src/lib/analytics/contactHistoryService';
import {
  getOperationsAnalysisForUser, getOperationContextForUser, resolveOperationsRange, monthsBefore, OperationsServiceError,
  type OperationsAnalysisResult,
} from '../src/lib/analytics/operationsService';
import { getDealChainForUser } from '../src/lib/analytics/dealChainService';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? JSON.stringify(detail) : ''); }
}
const near = (a: number | null | undefined, b: number) => a != null && Math.abs(a - b) < 0.011;
const kb = (o: unknown) => (JSON.stringify(o).length / 1024).toFixed(1);

const PASSWORD = 'Business-Tools-Fixture-Local-Only-1!';
const NOW = new Date('2026-10-19T16:00:00Z');

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
async function lookupId(admin: SupabaseClient, table: string, col: string, val: string): Promise<number> {
  const { data, error } = await admin.from(table).select('id').eq(col, val).limit(1).maybeSingle();
  if (error || !data) throw new Error(`${table}.${col}=${val} not found`);
  return data.id as number;
}
async function signIn(email: string): Promise<SupabaseClient> {
  const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return c;
}

function pureChecks() {
  console.log('\n[P1 — contact name normalization]');
  check('case + repeated whitespace + trim', normalizeContactName('  JOHN   smith ') === 'john smith');
  check('periods/commas removed', normalizeContactName('John S.') === 'john s' && normalizeContactName('Smith, John') === 'smith john');
  check('accents and apostrophe variants', normalizeContactName('Zoë O’Neil') === "zoe o'neil");

  console.log('\n[P2 — conservative possible matches]');
  check('"john s" ~ "john smith" = last_name_initial', possibleNameMatch('john s', 'john smith')?.reason === 'last_name_initial');
  check('"john smith" ~ "johnny smith" = first_name_prefix', possibleNameMatch('john smith', 'johnny smith')?.reason === 'first_name_prefix');
  check('"john smith" ~ "john smith jr" = extra_name_token', possibleNameMatch('john smith', 'john smith jr')?.reason === 'extra_name_token');
  check('"john smith" ~ "john a smith" = extra_name_token', possibleNameMatch('john smith', 'john a smith')?.reason === 'extra_name_token');
  check('"john" ~ "john smith" = first_name_only (low score)', possibleNameMatch('john', 'john smith')?.reason === 'first_name_only' && possibleNameMatch('john', 'john smith')!.score < 0.5);
  check('"john smith" vs "john smithson" is NOT a match', possibleNameMatch('john smith', 'john smithson') === null);
  check('"john smith" vs "jane smith" is NOT a match', possibleNameMatch('john smith', 'jane smith') === null);
  check('"jo smith" vs "john smith" is NOT a match (prefix < 3 chars)', possibleNameMatch('jo smith', 'john smith') === null);
  check('different last names never match', possibleNameMatch('john smith', 'john brown') === null);
  check('exact equality is not a "possible" match', possibleNameMatch('john smith', 'john smith') === null);

  console.log('\n[P3 — operations date range]');
  const def = resolveOperationsRange(undefined, undefined, '2026-10-19');
  check('default = last 6 months ending today', def.from_date === '2026-04-19' && def.to_date === '2026-10-19' && def.default_applied);
  check('only to_date -> 6 months before it', resolveOperationsRange(undefined, '2026-09-30', '2026-10-19').from_date === '2026-03-30');
  check('only from_date -> through today', resolveOperationsRange('2026-09-01', undefined, '2026-10-19').to_date === '2026-10-19');
  check('month-end clamping (Aug 31 - 6 months = Feb 28)', monthsBefore('2026-08-31', 6) === '2026-02-28');
  let threw = false; try { resolveOperationsRange('2026-10-01', '2026-09-01', '2026-10-19'); } catch (e) { threw = e instanceof OperationsServiceError; }
  check('from after to is rejected', threw);
  threw = false; try { resolveOperationsRange('2026-02-30', undefined, '2026-10-19'); } catch (e) { threw = e instanceof OperationsServiceError; }
  check('invalid calendar date is rejected', threw);
}

async function main() {
  pureChecks();

  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const emailA = 'business-tools-fixture-a@example.test';
  const emailB = 'business-tools-fixture-b@example.test';
  const userA = await resolveAppUserId(admin, await ensureAuthUser(admin, emailA));
  const userB = await resolveAppUserId(admin, await ensureAuthUser(admin, emailB));

  const ch = {
    marketplace: await lookupId(admin, 'deal_channels', 'name', 'Marketplace'),
    kijiji: await lookupId(admin, 'deal_channels', 'name', 'Kijiji'),
    reverb: await lookupId(admin, 'deal_channels', 'name', 'Reverb'),
  };
  const electric = await lookupId(admin, 'item_subtypes', 'name', 'Electric Guitar');
  const ampSubtype = await lookupId(admin, 'item_subtypes', 'name', 'Amp');
  const business = await lookupId(admin, 'item_purposes', 'name', 'Business');
  const createdBrandIds: number[] = [];
  const brand = async (name: string) => {
    const { data } = await admin.from('brands').select('id').eq('name', name).maybeSingle();
    if (data) return data.id as number;
    const { data: ins, error } = await admin.from('brands').insert({ name }).select('id').single();
    if (error) throw error;
    createdBrandIds.push(ins.id as number);
    return ins.id as number;
  };
  const gibson = await brand('Gibson');
  const fender = await brand('Fender');
  const prs = await brand('PRS');
  const squier = await brand('Squier');

  const itemIds: number[] = [];
  const dealIds: number[] = [];
  const leadIds: number[] = [];
  const sourceIds: number[] = [];
  const expenseIds: number[] = [];

  try {
    console.log('\n=== Fixtures ===');
    const item = async (userId: number, brandId: number, model: string, o: Record<string, unknown> = {}) => {
      const { data, error } = await admin.from('inventory_items').insert({
        user_id: userId, brand_id: brandId, model, status: 'owned', year: 2020, color: 'Sunburst', item_subtype_id: electric,
        serial_number: `BT-${crypto.randomUUID().slice(0, 8)}`, ...o,
      }).select('id').single();
      if (error) throw error;
      itemIds.push(data.id as number);
      return data.id as number;
    };
    const deal = async (userId: number, type: string, date: string, channelId: number | null, o: Record<string, unknown> = {}) => {
      const { data, error } = await admin.from('deals').insert({ user_id: userId, deal_type: type, deal_date: date, deal_channel_id: channelId, cash_paid: 0, cash_received: 0, fees: 0, ...o }).select('id').single();
      if (error) throw error;
      dealIds.push(data.id as number);
      return data.id as number;
    };
    const leg = async (userId: number, dealId: number, itemId: number, direction: 'in' | 'out', value: number) => {
      const { error } = await admin.from('deal_items').insert({ user_id: userId, deal_id: dealId, item_id: itemId, direction, total_value: value });
      if (error) throw error;
    };
    const setStatus = (id: number, status: string) => admin.from('inventory_items').update({ status }).eq('id', id);

    // ── Operations + chain fixture (user A, September 2026) ───────────────
    const I1 = await item(userA, gibson, 'Les Paul (BT)', { purpose_id: business });
    const I2 = await item(userA, fender, 'Stratocaster (BT)');
    const I3 = await item(userA, prs, 'Custom 24 (BT)');
    const I4 = await item(userA, squier, 'Champion Amp (BT)', { item_subtype_id: ampSubtype, estimated_sold_value: 650 });
    const I5 = await item(userA, gibson, 'SG Historical (BT)');
    const I6 = await item(userA, fender, 'Telecaster October (BT)');

    const dHist = await deal(userA, 'Historical Import', '2026-09-01', null, { cash_paid: null, cash_received: null });
    await leg(userA, dHist, I5, 'in', 600);
    const dBuy1 = await deal(userA, 'purchase', '2026-09-02', ch.marketplace, { cash_paid: 1000 });
    await leg(userA, dBuy1, I1, 'in', 1000);
    const dBuy2 = await deal(userA, 'purchase', '2026-09-03', ch.kijiji, { cash_paid: 800 });
    await leg(userA, dBuy2, I2, 'in', 800);
    const dExp = await deal(userA, 'expense', '2026-09-05', null, { cash_paid: 50, notes: 'Fret level' });
    {
      const { data, error } = await admin.from('inventory_expenses').insert({ user_id: userA, deal_id: dExp, item_id: I1, expense_date: '2026-09-05', amount: 50, notes: 'Fret level' }).select('id').single();
      if (error) throw error;
      expenseIds.push(data.id as number);
    }
    // Multi-item trade: gave I1 + I2, received I3 + I4 + $300.
    const dTrade = await deal(userA, 'trade', '2026-09-10', ch.marketplace, { cash_received: 300, notes: 'Two-for-two plus cash' });
    await leg(userA, dTrade, I1, 'out', 1400);
    await leg(userA, dTrade, I2, 'out', 900);
    await leg(userA, dTrade, I3, 'in', 1500);
    await leg(userA, dTrade, I4, 'in', 500);
    await setStatus(I1, 'traded'); await setStatus(I2, 'traded');
    const dSell = await deal(userA, 'sale', '2026-09-20', ch.reverb, { cash_received: 1800 });
    await leg(userA, dSell, I3, 'out', 1800);
    await setStatus(I3, 'sold');
    const dBuyOct = await deal(userA, 'purchase', '2026-10-01', ch.kijiji, { cash_paid: 400 });
    await leg(userA, dBuyOct, I6, 'in', 400);

    // Separate simple chain J: buy -> sell.
    const J1 = await item(userA, fender, 'Jazzmaster (BT)');
    const dJBuy = await deal(userA, 'purchase', '2026-06-01', ch.kijiji, { cash_paid: 500 });
    await leg(userA, dJBuy, J1, 'in', 500);
    const dJSell = await deal(userA, 'sale', '2026-06-15', ch.marketplace, { cash_received: 700 });
    await leg(userA, dJSell, J1, 'out', 700);
    await setStatus(J1, 'sold');

    // Multi-step chain K: buy -> trade (+$100 paid) -> trade (+$200 received) -> sell.
    const K1 = await item(userA, gibson, 'Explorer (BT)');
    const K2 = await item(userA, prs, 'SE (BT)');
    const K3 = await item(userA, fender, 'Mustang (BT)');
    const dK1 = await deal(userA, 'purchase', '2026-05-01', ch.marketplace, { cash_paid: 1000 });
    await leg(userA, dK1, K1, 'in', 1000);
    const dK2 = await deal(userA, 'trade', '2026-05-10', ch.marketplace, { cash_paid: 100 });
    await leg(userA, dK2, K1, 'out', 1100); await leg(userA, dK2, K2, 'in', 1200);
    const dK3 = await deal(userA, 'trade', '2026-05-20', ch.kijiji, { cash_received: 200 });
    await leg(userA, dK3, K2, 'out', 1300); await leg(userA, dK3, K3, 'in', 1100);
    const dK4 = await deal(userA, 'sale', '2026-05-30', ch.reverb, { cash_received: 1500 });
    await leg(userA, dK4, K3, 'out', 1500);
    for (const k of [K1, K2]) await setStatus(k, 'traded');
    await setStatus(K3, 'sold');

    // User B — must never leak.
    const B1 = await item(userB, gibson, 'B-Only Flying V (BT)');
    const dB = await deal(userB, 'sale', '2026-09-15', ch.marketplace, { cash_received: 9999, notes: 'B-SECRET-DEAL' });
    await leg(userB, dB, B1, 'out', 9999);

    // ── Leads with contact names ──────────────────────────────────────────
    const source = async (userId: number) => {
      const { data, error } = await admin.from('lead_import_sources').upsert({ user_id: userId, source_code: 'GT_LEAD_LOG', provider: 'GOOGLE_SHEETS', source_name: 'Business Tools Fixture', spreadsheet_id: `bt-${userId}`, sheet_name: 'Leads', is_enabled: true }, { onConflict: 'user_id,source_code' }).select('id').single();
      if (error) throw error;
      sourceIds.push(data.id as number);
      return data.id as number;
    };
    const srcA = await source(userA);
    const srcB = await source(userB);
    const lead = async (userId: number, srcId: number, itemId: number, o: Record<string, unknown>) => {
      const { data, error } = await admin.from('item_leads').insert({
        user_id: userId, source_id: srcId, inventory_item_id: itemId, lead_id: crypto.randomUUID(), lead_quality: 'LOW', offer_type: 'NONE', status: 'OPEN',
        source_updated_at: new Date().toISOString(), ...o,
      }).select('id').single();
      if (error) throw error;
      leadIds.push(data.id as number);
      return data.id as number;
    };
    const L1 = await lead(userA, srcA, I1, { contact_name: 'John Smith', deal_channel_id: ch.marketplace, source_channel: 'Marketplace', first_contact_at: '2026-08-20', last_contact_at: '2026-08-22', lead_quality: 'SERIOUS', offer_type: 'CASH', best_cash_offer: 1200, status: 'DECLINED_BY_ME', notes: 'Lowballed at 1200' });
    const L2 = await lead(userA, srcA, I3, { contact_name: '  john   SMITH ', deal_channel_id: ch.marketplace, source_channel: 'Marketplace', first_contact_at: '2026-09-12', last_contact_at: '2026-09-18', lead_quality: 'HIGH_INTENT', offer_type: 'CASH', best_cash_offer: 1800, status: 'COMPLETED', deal_id: dSell });
    const L3 = await lead(userA, srcA, I2, { contact_name: 'John Smith', deal_channel_id: ch.kijiji, source_channel: 'Kijiji', first_contact_at: '2026-07-01', lead_quality: 'ENGAGED' });
    const L4 = await lead(userA, srcA, I4, { contact_name: 'John S.', deal_channel_id: ch.marketplace, source_channel: 'Marketplace', first_contact_at: '2026-09-25' });
    const L5 = await lead(userA, srcA, I1, { contact_name: 'Johnny Smith', deal_channel_id: ch.marketplace, source_channel: 'Marketplace', first_contact_at: '2026-08-01' });
    await lead(userA, srcA, I1, { contact_name: 'John Smithson', deal_channel_id: ch.marketplace, source_channel: 'Marketplace', first_contact_at: '2026-08-02' });
    await lead(userA, srcA, I2, { contact_name: null, deal_channel_id: ch.marketplace, source_channel: 'Marketplace', first_contact_at: '2026-08-03' });
    const L8 = await lead(userA, srcA, I1, { contact_name: 'John Smith Jr', deal_channel_id: ch.marketplace, source_channel: 'Marketplace', first_contact_at: '2026-08-04' });
    await lead(userB, srcB, B1, { contact_name: 'John Smith', deal_channel_id: ch.marketplace, source_channel: 'Marketplace', first_contact_at: '2026-09-01', notes: 'B-SECRET-LEAD' });

    const clientA = await signIn(emailA);
    const clientB = await signIn(emailB);
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });

    // ══ find_contact_history ══════════════════════════════════════════════
    console.log('\n[C1 — exact matches: normalized name + channel]');
    const c1 = await findContactHistoryForUser(clientA, { contact_name: 'JOHN smith', channel: 'marketplace', item_id: I1 });
    check('normalized query echoed', c1.query.normalized_contact_name === 'john smith' && c1.query.channel === 'marketplace' && c1.query.item_id === I1);
    check('exact = L1 + L2 (case / repeated whitespace / trim ignored)', JSON.stringify(c1.exact_matches.map((m) => m.lead_id).sort()) === JSON.stringify([L1, L2].sort()), c1.exact_matches.map((m) => m.lead_id));
    check('same name on Kijiji is NOT exact; returned under other_channel_matches', c1.other_channel_matches.length === 1 && c1.other_channel_matches[0].lead_id === L3);
    check('same_item flag marks only the I1 lead', c1.exact_matches.find((m) => m.lead_id === L1)?.same_item === true && c1.exact_matches.find((m) => m.lead_id === L2)?.same_item === false && c1.summary.same_item_match_count === 1);
    check('other-item history is still returned (item_id never narrows)', c1.exact_matches.some((m) => m.item.item_id === I3));
    check('sold item history is returned with its current status', c1.exact_matches.find((m) => m.lead_id === L2)?.item.status === 'sold');
    check('linked deal id carried and counted', c1.exact_matches.find((m) => m.lead_id === L2)?.linked_deal_id === dSell && c1.summary.linked_deal_count === 1 && c1.summary.linked_deal_ids[0] === dSell);
    check('summary first/last contact + highest quality', c1.summary.first_contact === '2026-08-20' && c1.summary.last_contact === '2026-09-18' && c1.summary.highest_quality === 'High intent', c1.summary);
    check('newest first ordering', c1.exact_matches[0].lead_id === L2);
    check('lead record carries canonical fields', (() => { const r = c1.exact_matches.find((m) => m.lead_id === L1)!; return r.offer_summary === '$1,200 cash' && r.status === 'Declined by me' && r.notes === 'Lowballed at 1200' && r.item.brand === 'Gibson' && r.channel === 'Marketplace'; })());
    check('possible matches kept separate: John S. / Johnny Smith / John Smith Jr (never "John Smithson")', JSON.stringify(c1.possible_matches.map((p) => p.lead_id).sort()) === JSON.stringify([L4, L5, L8].sort()), c1.possible_matches.map((p) => [p.contact_name, p.match_reason]));
    check('possible matches carry reason + score, and are not counted as history', c1.possible_matches.every((p) => !!p.match_reason && p.match_score > 0) && c1.summary.exact_match_count === 2 && c1.summary.possible_match_count === 3);
    check('coverage reports leads without a contact name', c1.coverage.leads_without_contact_name >= 1 && c1.coverage.leads_with_contact_name === 7, c1.coverage);

    console.log('\n[C2 — other query shapes]');
    const c2 = await findContactHistoryForUser(clientA, { contact_name: 'john smith' });
    check('no channel -> every same-name lead is exact (3)', c2.summary.exact_match_count === 3 && c2.other_channel_matches.length === 0);
    const c3 = await findContactHistoryForUser(clientA, { contact_name: 'John Smith', channel: 'Marketplace', include_possible_matches: false });
    check('include_possible_matches=false -> none', c3.possible_matches.length === 0 && c3.summary.possible_match_count === 0);
    const c4 = await findContactHistoryForUser(clientA, { contact_name: 'Zed Zebra' });
    check('unknown contact -> empty, not an error', c4.exact_matches.length === 0 && c4.possible_matches.length === 0 && c4.summary.first_contact === null);
    let emptyErr = false; try { await findContactHistoryForUser(clientA, { contact_name: ' . , ' }); } catch (e) { emptyErr = e instanceof ContactHistoryServiceError; }
    check('a name with no letters/digits is rejected', emptyErr);

    console.log('\n[C3 — isolation]');
    check('user A never sees user B\'s lead', !JSON.stringify(c2).includes('B-SECRET'));
    const cb = await findContactHistoryForUser(clientB, { contact_name: 'John Smith' });
    check('user B sees only their own John Smith', cb.exact_matches.length === 1 && cb.exact_matches[0].item.item_id === B1 && cb.coverage.leads_with_contact_name === 1);
    const foreign = await findContactHistoryForUser(clientA, { contact_name: 'John Smith', channel: 'Marketplace', item_id: B1 });
    check('a foreign item_id reveals nothing (marks nothing, same results)', foreign.summary.same_item_match_count === 0 && foreign.summary.exact_match_count === 2);
    check('anonymous caller gets nothing (rejected or empty)',await findContactHistoryForUser(anon, { contact_name: 'John Smith' }).then((r) => r.coverage.leads_with_contact_name === 0 && r.exact_matches.length === 0, () => true));

    // ══ get_operations_analysis ═══════════════════════════════════════════
    console.log('\n[O1 — September summary]');
    const sep = await getOperationsAnalysisForUser(clientA, { from_date: '2026-09-01', to_date: '2026-09-30' }, NOW);
    const s = sep.summary;
    check('period echoed, not default', sep.period.from_date === '2026-09-01' && sep.period.to_date === '2026-09-30' && !sep.period.default_applied);
    check('6 operations: 1 historical, 2 buys, 1 expense, 1 trade, 1 sell', s.operation_count === 6 && s.historical_count === 1 && s.buy_count === 2 && s.expense_count === 1 && s.trade_count === 1 && s.sell_count === 1, s);
    check('cash_in 2100 (trade 300 once, not x4 legs + sale 1800)', s.cash_in === 2100, s.cash_in);
    check('cash_out 1850 (buys 1800 + expense 50)', s.cash_out === 1850, s.cash_out);
    check('net cash impact 250', s.net_cash_impact === 250);
    check('sales_cash_received 1800', s.sales_cash_received === 1800);
    check('realized profit 750 (trade 350+100, sale 300)', s.realized_profit === 750, s.realized_profit);
    check('realized deals 2, items disposed 3, avg 375', s.realized_deal_count === 2 && s.items_disposed_count === 3 && s.avg_realized_profit_per_realized_deal === 375);
    check('weighted ROI = 750 / 3300 = 22.73%', near(s.realized_roi_percent_weighted, 22.73) && s.roi_basis_item_count === 3, s.realized_roi_percent_weighted);
    check('exit_value_total 4100 = value_out_total', s.exit_value_total === 4100 && s.value_out_total === 4100);
    check('value_in_total 4400 (incl. historical 600)', s.value_in_total === 4400, s.value_in_total);
    check('expense operations 50, fees 0', s.expense_operations_total === 50 && s.fees_recorded_total === 0);
    check('summary equals the sum of returned rows', sep.operations.length === s.operation_count && sep.operations.reduce((a, r) => a + r.cash_impact, 0) === s.net_cash_impact && sep.operations.reduce((a, r) => a + (r.realized_profit ?? 0), 0) === s.realized_profit);
    check('other user\'s deal never appears', !JSON.stringify(sep).includes('B-SECRET') && sep.operations.every((r) => r.deal_id !== dB));
    check('rows are chronological', sep.operations.map((r) => r.date).join() === [...sep.operations.map((r) => r.date)].sort().join());

    console.log('\n[O2 — multi-item trade row is not multiplied]');
    const tr = sep.operations.find((r) => r.deal_id === dTrade)!;
    check('trade row: 2 out legs, 2 in legs, cash once', tr.items_out.length === 2 && tr.items_in.length === 2 && tr.cash_in === 300 && tr.cash_impact === 300);
    check('trade per-item gains: Les Paul 350 (incl. $50 expense), Strat 100', tr.items_out.find((o) => o.item_id === I1)?.realized_gain === 350 && tr.items_out.find((o) => o.item_id === I2)?.realized_gain === 100 && tr.realized_profit === 450);
    check('per-item ROI uses value_in denominator (350/1000 = 35%)', near(tr.items_out.find((o) => o.item_id === I1)?.realized_roi_percent ?? null, 35));
    const exp = sep.operations.find((r) => r.deal_id === dExp)!;
    check('expense row links its item', exp.expense_items.length === 1 && exp.expense_items[0].item_id === I1 && exp.expense_items[0].amount === 50 && exp.cash_impact === -50);

    console.log('\n[O3 — breakdowns]');
    const byCh = (r: OperationsAnalysisResult, name: string) => r.by_channel.find((c) => c.channel === name);
    check('Marketplace: buy + trade, cash_out 1000, cash_in 300, profit 450', byCh(sep, 'Marketplace')?.operation_count === 2 && byCh(sep, 'Marketplace')?.cash_out === 1000 && byCh(sep, 'Marketplace')?.realized_profit === 450);
    check('Reverb: sale 1800, profit 300', byCh(sep, 'Reverb')?.cash_in === 1800 && byCh(sep, 'Reverb')?.realized_profit === 300);
    check('Kijiji: one buy, cash_out 800', byCh(sep, 'Kijiji')?.operation_count === 1 && byCh(sep, 'Kijiji')?.cash_out === 800);
    check('"No channel": historical + expense', byCh(sep, 'No channel')?.operation_count === 2);
    check('channel breakdown sums to the summary', sep.by_channel.reduce((a, c) => a + c.operation_count, 0) === 6 && sep.by_channel.reduce((a, c) => a + c.realized_profit, 0) === 750);
    check('operation-type breakdown: trade realized 450, sale 300, purchase cash_out 1800', sep.by_operation_type.find((t) => t.operation_type === 'trade')?.realized_profit === 450 && sep.by_operation_type.find((t) => t.operation_type === 'sale')?.realized_profit === 300 && sep.by_operation_type.find((t) => t.operation_type === 'purchase')?.cash_out === 1800 && sep.by_operation_type.find((t) => t.operation_type === 'purchase')?.operation_label === 'Buy');

    console.log('\n[O4 — filters]');
    const f = (x: object) => getOperationsAnalysisForUser(clientA, { from_date: '2026-09-01', to_date: '2026-09-30', ...x }, NOW);
    check('single channel', (await f({ channel: ['reverb'] })).operations.map((r) => r.deal_id).join() === String(dSell));
    const multi = await f({ channel: ['Marketplace', 'Reverb'] });
    check('multiple channels (OR)', multi.summary.operation_count === 3 && multi.summary.realized_profit === 750);
    check('"No channel" filter', (await f({ channel: ['No channel'] })).summary.operation_count === 2);
    check('operation_type filter', (await f({ operation_type: ['trade'] })).operations.map((r) => r.deal_id).join() === String(dTrade));
    check('item_ids filter (I3: trade + sale)', JSON.stringify((await f({ item_ids: [I3] })).operations.map((r) => r.deal_id)) === JSON.stringify([dTrade, dSell]));
    const fen = await f({ brand: ['fender'] });
    check('brand filter selects operations involving a Fender; matching-item profit = 100', JSON.stringify(fen.operations.map((r) => r.deal_id)) === JSON.stringify([dBuy2, dTrade]) && fen.summary.matching_items_realized_profit === 100, fen.summary);
    check('category filter (Amps -> trade only)', (await f({ category: ['Amps'] })).operations.map((r) => r.deal_id).join() === String(dTrade));
    check('type filter (Amp subtype -> trade only)', (await f({ type: ['amp'] })).operations.map((r) => r.deal_id).join() === String(dTrade));
    check('purpose filter (Business = Les Paul: buy, expense, trade)', JSON.stringify((await f({ purpose: ['Business'] })).operations.map((r) => r.deal_id)) === JSON.stringify([dBuy1, dExp, dTrade]));
    check('combined: brand Fender AND channel Marketplace -> trade only', (await f({ brand: ['Fender'], channel: ['Marketplace'] })).operations.map((r) => r.deal_id).join() === String(dTrade));
    check('inclusive single-day boundary', (await getOperationsAnalysisForUser(clientA, { from_date: '2026-09-20', to_date: '2026-09-20' }, NOW)).operations.map((r) => r.deal_id).join() === String(dSell));
    const dflt = await getOperationsAnalysisForUser(clientA, {}, NOW);
    check('default period = 2026-04-19..2026-10-19, includes Oct buy and the May/June chains', dflt.period.default_applied && dflt.period.from_date === '2026-04-19' && dflt.operations.some((r) => r.deal_id === dBuyOct) && dflt.operations.some((r) => r.deal_id === dK1));
    const bAll = await getOperationsAnalysisForUser(clientB, {}, NOW);
    check('user B sees only their own operation', bAll.operations.map((r) => r.deal_id).join() === String(dB));

    // ══ get_operation_context ═════════════════════════════════════════════
    console.log('\n[X1 — operation context]');
    const buy = (await getOperationContextForUser(clientA, dBuy1))!;
    check('buy: received Les Paul at 1000, cash impact -1000, label Buy', buy.operation_label === 'Buy' && buy.gave.length === 0 && buy.received[0].item_id === I1 && buy.received[0].assigned_value_in === 1000 && buy.cash_impact === -1000 && buy.summary.startsWith('Paid: $1,000 cash'));
    check('buy: received item shows its later disposal deal', buy.received[0].disposed_in_deal_id === dTrade);
    const sell = (await getOperationContextForUser(clientA, dSell))!;
    check('sell: gave PRS, value out 1800, gain 300, ROI 20%, acquired in the trade', sell.gave.length === 1 && sell.gave[0].realized_gain === 300 && near(sell.gave[0].realized_roi_percent, 20) && sell.gave[0].acquired_in_deal_id === dTrade && sell.gave[0].acquisition_type === 'trade' && sell.realized_profit === 300);
    check('sell: linked lead surfaced with contact name', sell.linked_leads.length === 1 && sell.linked_leads[0].lead_id === L2 && sell.linked_leads[0].contact_name?.trim() === 'john   SMITH');
    const trade = (await getOperationContextForUser(clientA, dTrade))!;
    check('trade: gave 2 / received 2, directions correct', trade.gave.map((g) => g.item_id).sort().join() === [I1, I2].sort().join() && trade.received.map((r) => r.item_id).sort().join() === [I3, I4].sort().join());
    check('trade: cash component and realized profit', trade.cash_received === 300 && trade.cash_impact === 300 && trade.realized_profit === 450 && near(trade.realized_roi_percent_weighted, 25));
    check('trade: summary reads Gave ... Received ... + $300 cash', /^Gave: .*Les Paul.*Stratocaster.*\. Received: .*Custom 24.*Champion Amp.* \+ \$300 cash$/.test(trade.summary), trade.summary);
    check('trade: given item carries its $50 expense; received amp shows potential reward (650-500)', trade.gave.find((g) => g.item_id === I1)?.item_expenses === 50 && trade.received.find((r) => r.item_id === I4)?.potential_reward === 150);
    const expense = (await getOperationContextForUser(clientA, dExp))!;
    check('expense: linked expense row, cash impact -50', expense.expenses.length === 1 && expense.expenses[0].item?.item_id === I1 && expense.expenses[0].amount === 50 && expense.cash_impact === -50);
    check('foreign operation is unavailable', (await getOperationContextForUser(clientB, dTrade)) === null);
    check('nonexistent operation behaves the same', (await getOperationContextForUser(clientA, 999999999)) === null);
    check('user A cannot open user B\'s deal', (await getOperationContextForUser(clientA, dB)) === null);

    // ══ get_deal_chain ════════════════════════════════════════════════════
    console.log('\n[D1 — buy -> sell]');
    const cj = (await getDealChainForUser(clientA, J1))!;
    check('steps: buy then sell, chronological', cj.lineage.steps.map((st) => st.deal_id).join() === [dJBuy, dJSell].join());
    check('running profit 200 and capital profit 200', cj.lineage.final_running_profit === 200 && cj.capital_summary.total_invested === 500 && cj.capital_summary.cash_extracted === 700 && cj.capital_summary.profit === 200);

    console.log('\n[D2 — multi-step trade chain with cash components]');
    const ck = (await getDealChainForUser(clientA, K2))!;
    check('root item is K1 regardless of the item asked about', ck.capital_summary.root_item_ids.join() === String(K1));
    check('4 steps in date order', ck.lineage.steps.map((st) => st.deal_id).join() === [dK1, dK2, dK3, dK4].join() && ck.lineage.steps.map((st) => st.date).join() === '2026-05-01,2026-05-10,2026-05-20,2026-05-30');
    check('trade cash components per step', ck.lineage.steps[1].cash_paid === 100 && ck.lineage.steps[2].cash_received === 200);
    check('capital: invested 1100, extracted 1700, profit 600', ck.capital_summary.total_invested === 1100 && ck.capital_summary.cash_extracted === 1700 && ck.capital_summary.profit === 600, ck.capital_summary);
    check('resulting item ids follow the lineage', ck.lineage.steps[1].resulting_item_ids.join() === String(K2) && ck.lineage.steps[2].resulting_item_ids.join() === String(K3));

    console.log('\n[D3 — multi-item branch (two roots, sibling asset) + expenses]');
    const ci = (await getDealChainForUser(clientA, I3))!;
    check('lineage = Les Paul + Strat + PRS; steps buy, buy, trade, sell', ci.lineage.item_ids.join() === [I1, I2, I3].sort((a, b) => a - b).join() && ci.lineage.steps.map((st) => st.deal_id).join() === [dBuy1, dBuy2, dTrade, dSell].join());
    check('step profit: trade 450 (lineage legs only), sell 300, running 750', ci.lineage.steps[2].step_profit === 450 && ci.lineage.steps[3].step_profit === 300 && ci.lineage.final_running_profit === 750);
    check('amp is a bundle sibling (on_lineage=false) and an other_descendant', ci.lineage.steps[2].received.find((r) => r.item_id === I4)?.on_lineage === false && ci.other_descendants.map((d) => d.item_id).join() === String(I4));
    check('capital: two roots, invested 1800+50, extracted 300+1800 once, assets 650, profit 900', ci.capital_summary.root_item_ids.sort((a, b) => a - b).join() === [I1, I2].sort((a, b) => a - b).join() && ci.capital_summary.total_invested === 1850 && ci.capital_summary.cash_extracted === 2100 && ci.capital_summary.current_assets === 650 && ci.capital_summary.expenses === 50 && ci.capital_summary.profit === 900, ci.capital_summary);
    check('ROI 900/1850 = 48.65%', near(ci.capital_summary.roi_percent, 48.65));
    check('capital tree: Les Paul traded -> PRS sold + amp held; Strat converges (already_counted)', (() => { const flat = JSON.stringify(ci.capital_tree); return flat.includes('"outcome":"sold"') && flat.includes('"outcome":"held"') && flat.includes('"outcome":"already_counted"'); })());

    console.log('\n[D4 — isolation]');
    check('foreign item unavailable', (await getDealChainForUser(clientB, I3)) === null);
    check('nonexistent item unavailable', (await getDealChainForUser(clientA, 999999999)) === null);
    const cB = (await getDealChainForUser(clientB, B1))!;
    const aOnlyIds = new Set([...dealIds, ...itemIds].filter((id) => id !== dB && id !== B1));
    const bChainIds = [...cB.lineage.steps.map((st) => st.deal_id), ...cB.lineage.item_ids, ...cB.capital_summary.root_item_ids];
    check('user B\'s chain contains none of user A\'s deals/items', cB.lineage.steps.length === 1 && cB.lineage.steps[0].deal_id === dB && bChainIds.every((id) => !aOnlyIds.has(id)) && !JSON.stringify(cB).includes('Les Paul'), bChainIds);
    check('item with a single Buy returns a one-step chain', (await getDealChainForUser(clientA, I6))?.lineage.steps.length === 1);

    console.log('\n[S — response sizes (informational)]');
    const ninety = await getOperationsAnalysisForUser(clientA, { from_date: '2026-07-21', to_date: '2026-10-19' }, NOW);
    const year = await getOperationsAnalysisForUser(clientA, { from_date: '2025-10-20', to_date: '2026-10-19' }, NOW);
    console.log(`  fixture: operations default ${kb(dflt)} KB (${dflt.operations.length} ops), 90d ${kb(ninety)} KB, 1y ${kb(year)} KB (${year.operations.length} ops); definitions block ${kb(dflt.definitions)} KB`);
    console.log(`  fixture: contact history ${kb(c1)} KB, operation context (trade) ${kb(trade)} KB, deal chain (I3) ${kb(ci)} KB`);
    check('size measurement ran', true);
  } finally {
    console.log('\n=== Cleanup ===');
    if (leadIds.length) await admin.from('item_leads').delete().in('id', leadIds);
    if (expenseIds.length) await admin.from('inventory_expenses').delete().in('id', expenseIds);
    if (itemIds.length) await admin.from('deal_items').delete().in('item_id', itemIds);
    if (dealIds.length) await admin.from('cash_flow').delete().in('deal_id', dealIds);
    if (dealIds.length) await admin.from('deals').delete().in('id', dealIds);
    if (itemIds.length) { const { error } = await admin.from('inventory_items').delete().in('id', itemIds); check('cleanup: inventory_items deleted', !error, error); }
    if (sourceIds.length) await admin.from('lead_import_sources').delete().in('id', sourceIds);
    if (createdBrandIds.length) await admin.from('brands').delete().in('id', createdBrandIds);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
