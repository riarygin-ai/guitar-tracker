/**
 * test-get-leads.ts
 *
 * MCP get_leads (raw lead rows across the complete history):
 *   P — pure ordering
 *   S — route wiring / schema
 *   W — local DB through a real signed-in RLS client: owned / listed / sold /
 *       traded coverage, every filter, AND/OR semantics, notes on/off,
 *       pagination + whole-set summary, deterministic order, isolation,
 *       snapshot parity with get_item_context, and a fixed query count.
 * Self-cleaning dedicated fixture (two users). Synthetic names only.
 *
 * Usage:  npx tsx scripts/test-get-leads.ts
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import { compareLeadsForListing, getLeadsForUser, type GetLeadsResult } from '../src/lib/analytics/leadsMcp';
import { getItemContextForMcp } from '../src/lib/analytics/itemContextMcp';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? JSON.stringify(detail).slice(0, 700) : ''); }
}

const PASSWORD = 'Get-Leads-Fixture-Local-Only-1!';
const uuid = () => crypto.randomUUID();
const root = path.join(__dirname, '..');

let requests = 0;
const countingFetch: typeof fetch = (input, init) => { requests++; return fetch(input, init); };

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
  const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: countingFetch } });
  const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return c;
}

async function main() {
  console.log('\n[P — ordering]');
  const o = [{ id: 1, last_activity_date: '2026-10-01' }, { id: 2, last_activity_date: null }, { id: 3, last_activity_date: '2026-10-05' }, { id: 4, last_activity_date: '2026-10-05' }];
  check('latest activity first, ties by id DESC, undated last', JSON.stringify([...o].sort(compareLeadsForListing).map((x) => x.id)) === '[4,3,1,2]');

  console.log('\n[S — route]');
  const route = fs.readFileSync(path.join(root, 'src/app/api/mcp/[[...path]]/route.ts'), 'utf8');
  const blk = route.slice(route.indexOf("'get_leads',"), route.indexOf('registerTool(', route.indexOf("'get_leads',")));
  check('get_leads registered read-only with the request-scoped client', /readOnlyHint:\s*true,\s*destructiveHint:\s*false/.test(blk) && blk.includes('getLeadsForUser(supabase, args)'));
  check('schema: item_ids, status, peak_stage, channel, contact_name, origin, include_notes, limit, offset — no user id', ['item_ids', 'status', 'peak_stage', 'channel', 'contact_name', 'origin', 'include_notes', 'limit', 'offset'].every((k) => blk.includes(`${k}: z.`)) && !/user_id|owner/.test(blk.replace(/authenticated user/g, '')));
  check('description separates get_leads / get_lead_activity / get_item_context / find_contact_history', /RAW lead records/.test(blk) && /get_lead_activity/.test(blk) && /get_item_context with lead_id \+ full_history/.test(blk) && /find_contact_history/.test(blk));
  const svc = fs.readFileSync(path.join(root, 'src/lib/analytics/leadsMcp.ts'), 'utf8');
  check('service reuses the get_item_context snapshot serializer, no service_role', svc.includes('...leadSnapshotView(r,') && !/SERVICE_ROLE|serviceClient/.test(svc));

  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const userA = await resolveAppUserId(admin, await ensureAuthUser(admin, 'get-leads-a@example.test'));
  const userB = await resolveAppUserId(admin, await ensureAuthUser(admin, 'get-leads-b@example.test'));
  const cA = await signIn('get-leads-a@example.test');
  const cB = await signIn('get-leads-b@example.test');

  const { data: brand } = await admin.from('brands').insert({ name: `GL Brand ${uuid().slice(0, 6)}` }).select('id').single();
  const { data: chans } = await admin.from('deal_channels').select('id, name');
  const ch = (n: string) => (chans ?? []).find((c) => c.name === n)!.id as number;
  const itemIds: number[] = [];
  let sourceId: number | null = null;

  try {
    const item = async (userId: number, model: string, status: string) => {
      const { data, error } = await admin.from('inventory_items').insert({ user_id: userId, brand_id: brand!.id, model, year: 2001, color: 'Sunburst', status, serial_number: `GL-${uuid().slice(0, 8)}` }).select('id').single();
      if (error) throw error;
      itemIds.push(data.id as number);
      return data.id as number;
    };
    let seq = 0;
    const lead = async (userId: number, itemId: number, o: Record<string, unknown>) => {
      seq++;
      const { data, error } = await admin.from('item_leads').insert({
        user_id: userId, inventory_item_id: itemId, lead_id: uuid(), origin: 'DIRECT', last_write_source: 'MCP', source_channel: 'Marketplace', deal_channel_id: ch('Marketplace'),
        offer_type: 'NONE', status: 'OPEN', peak_stage: 'INQUIRY', peak_stage_source: 'DERIVED', source_updated_at: '2026-10-01T00:00:00Z',
        first_contact_at: `2026-09-${String(10 + (seq % 18)).padStart(2, '0')}`, ...o,
      }).select('id').single();
      if (error) throw error;
      return data.id as number;
    };
    const { data: src } = await admin.from('lead_import_sources').upsert({ user_id: userA, source_code: 'GT_LEAD_LOG', provider: 'GOOGLE_SHEETS', source_name: 'GL', spreadsheet_id: `gl-${userA}`, sheet_name: 'Leads', is_enabled: true }, { onConflict: 'user_id,source_code' }).select('id').single();
    sourceId = src!.id as number;
    const owned = await item(userA, 'Owned GL', 'owned');
    const listed = await item(userA, 'Listed GL', 'listed');
    const sold = await item(userA, 'Sold GL', 'listed');
    const tradedOut = await item(userA, 'Traded GL', 'listed');
    const tradedIn = await item(userA, 'Traded-in GL', 'new');
    const bItem = await item(userB, 'B GL', 'owned');

    const longNote = 'JJ asked weight; '.repeat(400) + 'END-OF-NOTE';
    const L = {
      ownedNameless: await lead(userA, owned, { contact_name: null, notes: longNote, last_contact_at: '2026-10-20' }),
      ownedNamed: await lead(userA, owned, { contact_name: 'Ann Owner', contact_name_source: 'DIRECT', contact_key: 'ann owner', status: 'AGREED', peak_stage: 'HIGH_INTENT', last_contact_at: '2026-10-22', notes: 'Ann note' }),
      listedKijiji: await lead(userA, listed, { contact_name: 'Ken Kijiji', contact_name_source: 'DIRECT', contact_key: 'ken kijiji', source_channel: 'Kijiji', deal_channel_id: ch('Kijiji'), peak_stage: 'NEGOTIATING', offer_type: 'CASH', initial_cash_offer: 500, best_cash_offer: 550 }),
      listedNamelessKijiji: await lead(userA, listed, { contact_name: null, source_channel: 'Kijiji', deal_channel_id: ch('Kijiji'), status: 'DECLINED_BY_THEM', outcome_reason: 'PRICE', peak_stage: 'ENGAGED', last_contact_at: '2026-10-10' }),
      soldWinner: await lead(userA, sold, { contact_name: 'Sam Sold', contact_name_source: 'DIRECT', contact_key: 'sam sold', peak_stage: 'NEGOTIATING', offer_type: 'CASH', initial_cash_offer: 700, best_cash_offer: 700, last_contact_at: '2026-10-05' }),
      soldOther: await lead(userA, sold, { contact_name: null, source_channel: 'Reverb', deal_channel_id: ch('Reverb'), peak_stage: 'INQUIRY' }),
      traded: await lead(userA, tradedOut, { contact_name: 'Tia Trade', contact_name_source: 'DIRECT', contact_key: 'tia trade', status: 'AGREED', peak_stage: 'HIGH_INTENT', last_contact_at: '2026-10-08' }),
      sheetOrigin: await lead(userA, listed, { origin: 'SHEET', last_write_source: 'BACKFILL', source_id: sourceId, lead_quality: 'LOW', contact_name: null, peak_stage: 'INQUIRY' }),
      bLead: await lead(userB, bItem, { contact_name: null, notes: 'B secret note' }),
    };
    // Sell + trade through the real operation RPCs (sold / traded statuses, auto-close of OPEN leads).
    const { error: sellErr } = await cA.rpc('create_sell_operation', { p_deal_date: '2026-10-06', p_channel_id: ch('Marketplace'), p_items: [{ item_id: sold, total_value: 700 }], p_notes: null, p_cf_description: null });
    const { error: tradeErr } = await cA.rpc('create_trade_operation', { p_deal_date: '2026-10-09', p_channel_id: ch('Marketplace'), p_notes: null, p_cash_paid: 0, p_cash_received: 0, p_outgoing_items: [{ item_id: tradedOut, total_value: 900 }], p_incoming_items: [{ item_id: tradedIn, total_value: 900 }], p_cf_transaction_date: null, p_cf_description: null });
    if (sellErr || tradeErr) throw new Error(`fixture ops: ${sellErr?.message ?? tradeErr?.message}`);
    const mine = (r: GetLeadsResult) => r.leads.filter((l) => itemIds.includes(l.item.item_id));
    const ids = (r: GetLeadsResult) => mine(r).map((l) => l.lead_id);
    const fixtureA = Object.entries(L).filter(([k, v]) => k !== 'bLead' && v != null).map(([, v]) => v as number);

    console.log('\n[W1 — complete history]');
    const all = await getLeadsForUser(cA, { item_ids: itemIds });
    check('empty-ish args (item scope only) return every lead of the user on owned / listed / sold / traded items', fixtureA.every((id) => ids(all).includes(id)) && all.summary.total_matches === fixtureA.length, { got: ids(all), want: fixtureA });
    const byItemStatus = Object.fromEntries(mine(all).map((l) => [l.lead_id, l.item.status]));
    check('sold and traded items included with their current item status', byItemStatus[L.soldWinner] === 'sold' && byItemStatus[L.traded] === 'traded' && byItemStatus[L.ownedNamed] === 'owned');
    const noArgs = await getLeadsForUser(cA);
    check('no arguments: whole history, default limit 200, offset 0', noArgs.summary.limit === 200 && noArgs.summary.offset === 0 && fixtureA.every((id) => noArgs.leads.some((l) => l.lead_id === id) || noArgs.summary.has_more));
    const row = mine(all).find((l) => l.lead_id === L.ownedNamed)!;
    check('item identity: brand / model / year / color / status / type / purpose keys present', row.item.brand?.startsWith('GL Brand') === true && row.item.model === 'Owned GL' && row.item.year === 2001 && row.item.color === 'Sunburst' && 'category' in row.item && 'type' in row.item && 'purpose' in row.item, row.item);
    check('lead fields: version, contact_name_source, channel, origin, peak_stage, responsiveness, latest_buyer_offer, needs_resolution, last_activity_date', row.version >= 1 && row.contact_name_source === 'DIRECT' && row.channel === 'Marketplace' && row.origin === 'DIRECT' && row.peak_stage === 'HIGH_INTENT' && 'waiting_on' in row.responsiveness && 'offer_type' in row.latest_buyer_offer && Array.isArray(row.needs_resolution) && row.last_activity_date === '2026-10-22');
    const ctx = await getItemContextForMcp(cA, owned, {});
    const ctxLead = ctx && !('error' in ctx) ? ctx.leads.find((l) => l.lead_id === L.ownedNamed)! : null;
    const strip = (x: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(x).filter(([k]) => !['legacy_notes', 'events_total', 'events_voided', 'events_omitted', 'events', 'contact_name_source', 'last_activity_date', 'item'].includes(k))));
    check('snapshot fields identical to get_item_context for the same lead', !!ctxLead && strip(row as never) === strip(ctxLead as never));
    const agreedOnTraded = mine(all).find((l) => l.lead_id === L.traded)!;
    check('needs_resolution same rule as get_item_context (AGREED on a traded item flagged)', agreedOnTraded.needs_resolution.includes('ITEM_UNAVAILABLE_WHILE_AGREED'));

    console.log('\n[W2 — filters]');
    const missing = await getLeadsForUser(cA, { item_ids: itemIds, contact_name: 'missing' });
    check('contact_name "missing": only NULL names', mine(missing).length > 0 && mine(missing).every((l) => l.contact_name === null) && ids(missing).includes(L.ownedNameless) && !ids(missing).includes(L.ownedNamed));
    const present = await getLeadsForUser(cA, { item_ids: itemIds, contact_name: 'present' });
    check('contact_name "present": only named leads', mine(present).length > 0 && mine(present).every((l) => l.contact_name !== null));
    check('missing + present = all', missing.summary.total_matches + present.summary.total_matches === all.summary.total_matches);
    const st = await getLeadsForUser(cA, { item_ids: itemIds, status: ['AGREED'] });
    check('status filter', mine(st).length === 2 && mine(st).every((l) => l.status === 'AGREED'));
    const st2 = await getLeadsForUser(cA, { item_ids: itemIds, status: ['AGREED', 'DECLINED_BY_THEM'] });
    check('multiple statuses = OR', st2.summary.total_matches === 3 && mine(st2).every((l) => ['AGREED', 'DECLINED_BY_THEM'].includes(l.status)));
    const neg = await getLeadsForUser(cA, { item_ids: itemIds, peak_stage: ['NEGOTIATING', 'HIGH_INTENT', 'CONVERTED'] });
    check('peak_stage filter (Negotiating+)', mine(neg).length === 4 && mine(neg).every((l) => ['NEGOTIATING', 'HIGH_INTENT', 'CONVERTED'].includes(l.peak_stage ?? '')));
    const kij = await getLeadsForUser(cA, { item_ids: itemIds, channel: ['kijiji'] });
    check('channel filter (case-insensitive label)', mine(kij).length === 2 && mine(kij).every((l) => l.channel === 'Kijiji'));
    const one = await getLeadsForUser(cA, { item_ids: [sold] });
    check('item_ids filter', JSON.stringify(ids(one).sort()) === JSON.stringify([L.soldWinner, L.soldOther].sort()));
    const combo = await getLeadsForUser(cA, { item_ids: itemIds, channel: ['Kijiji'], contact_name: 'missing' });
    check('combined filters = AND', JSON.stringify(ids(combo)) === JSON.stringify([L.listedNamelessKijiji]));
    const originDirect = await getLeadsForUser(cA, { item_ids: itemIds, origin: ['DIRECT'] });
    const originSheet = await getLeadsForUser(cA, { item_ids: itemIds, origin: ['SHEET'] });
    check('origin filter (DIRECT vs SHEET partition)', mine(originDirect).every((l) => l.origin === 'DIRECT') && JSON.stringify(ids(originSheet)) === JSON.stringify([L.sheetOrigin]) && originDirect.summary.total_matches === fixtureA.length - 1);

    console.log('\n[W3 — notes]');
    check('include_notes false (default): no legacy_notes key at all', mine(all).every((l) => !('legacy_notes' in l)) && !JSON.stringify(all).includes('END-OF-NOTE'));
    const withNotes = await getLeadsForUser(cA, { item_ids: itemIds, include_notes: true });
    const nl = mine(withNotes).find((l) => l.lead_id === L.ownedNameless)!;
    check('include_notes true: COMPLETE notes, never truncated', nl.legacy_notes === longNote && (nl.legacy_notes ?? '').endsWith('END-OF-NOTE'));
    check('leads without notes return legacy_notes: null', mine(withNotes).find((l) => l.lead_id === L.soldOther)!.legacy_notes === null);

    console.log('\n[W4 — pagination + summary + order]');
    const p1 = await getLeadsForUser(cA, { item_ids: itemIds, limit: 3, offset: 0 });
    const p2 = await getLeadsForUser(cA, { item_ids: itemIds, limit: 3, offset: 3 });
    const p3 = await getLeadsForUser(cA, { item_ids: itemIds, limit: 3, offset: 6 });
    const pagedIds = [...p1.leads, ...p2.leads, ...p3.leads].map((l) => l.lead_id);
    check('pages: returned / has_more / next_offset', p1.summary.returned === 3 && p1.summary.has_more && p1.summary.next_offset === 3 && p2.summary.next_offset === 6 && (p3.summary.has_more === (all.summary.total_matches > 9)));
    check('pages concatenate to the full ordered list (no gaps / repeats)', JSON.stringify(pagedIds) === JSON.stringify(all.leads.map((l) => l.lead_id).slice(0, pagedIds.length)) && new Set(pagedIds).size === pagedIds.length);
    check('summary describes the full filtered set on every page', p1.summary.total_matches === all.summary.total_matches && JSON.stringify(p2.summary.by_status) === JSON.stringify(all.summary.by_status) && p3.summary.missing_contact_names === missing.summary.total_matches);
    const sumStatus = Object.values(all.summary.by_status).reduce((a, b) => a + b, 0);
    check('by_status / by_peak_stage / by_channel each sum to total_matches', sumStatus === all.summary.total_matches && Object.values(all.summary.by_peak_stage).reduce((a, b) => a + b, 0) === all.summary.total_matches && Object.values(all.summary.by_channel).reduce((a, b) => a + b, 0) === all.summary.total_matches);
    check('order: latest real contact first (Ann Oct 22, nameless Oct 20, …)', all.leads[0].lead_id === L.ownedNamed && all.leads[1].lead_id === L.ownedNameless);
    const again = await getLeadsForUser(cA, { item_ids: itemIds });
    check('deterministic: identical order on repeat', JSON.stringify(again.leads.map((l) => l.lead_id)) === JSON.stringify(all.leads.map((l) => l.lead_id)));
    const autoClosed = mine(all).find((l) => l.lead_id === L.soldOther)!;
    check('system auto-close does not make an old lead look newly active (last_activity_date = its first contact)', autoClosed.status === 'CLOSED' && autoClosed.last_activity_date != null && autoClosed.last_activity_date < '2026-10-01', autoClosed.last_activity_date);
    check('limit is capped at 500', (await getLeadsForUser(cA, { item_ids: itemIds, limit: 9999 })).summary.limit === 500);

    console.log('\n[W5 — isolation]');
    const aAll = await getLeadsForUser(cA, { include_notes: true, limit: 500 });
    check('user A never sees user B\'s leads or notes', !aAll.leads.some((l) => l.lead_id === L.bLead) && !JSON.stringify(aAll).includes('B secret note'));
    const cross = await getLeadsForUser(cA, { item_ids: [bItem], include_notes: true });
    check('A asking for B\'s item id: nothing (no rows, no item identity)', cross.summary.total_matches === 0 && cross.leads.length === 0 && !JSON.stringify(cross).includes('B GL'));
    const bView = await getLeadsForUser(cB, { item_ids: itemIds.filter((i) => i !== bItem), include_notes: true });
    check('user B asking for A\'s item ids: nothing', bView.summary.total_matches === 0 && bView.leads.length === 0);
    const bOwn = await getLeadsForUser(cB, { item_ids: itemIds });
    check('…while B still sees exactly their own lead', JSON.stringify(bOwn.leads.map((l) => l.lead_id)) === JSON.stringify([L.bLead]));

    console.log('\n[W6 — fixed query count (no N+1)]');
    requests = 0; await getLeadsForUser(cA, { item_ids: [sold], include_notes: true }); const small = requests;
    for (let i = 0; i < 30; i++) await lead(userA, listed, { contact_name: null, notes: `bulk ${i}` });
    requests = 0; await getLeadsForUser(cA, { item_ids: itemIds, include_notes: true }); const large = requests;
    check('same number of HTTP queries for 2 leads and ~40 leads with notes', small === large && large <= 6, { small, large });
  } finally {
    console.log('\n=== Cleanup ===');
    if (itemIds.length) {
      const { data: dis } = await admin.from('deal_items').select('deal_id').in('item_id', itemIds);
      const dealIds = Array.from(new Set((dis ?? []).map((d) => d.deal_id as number)));
      if (dealIds.length) {
        await admin.from('cash_flow').delete().in('deal_id', dealIds);
        await admin.from('deal_items').delete().in('deal_id', dealIds);
        await admin.from('deals').delete().in('id', dealIds);
      }
      await admin.from('item_leads').delete().in('inventory_item_id', itemIds);
      await admin.from('item_listings').delete().in('inventory_item_id', itemIds);
      await admin.from('inventory_items').delete().in('id', itemIds);
    }
    if (sourceId) await admin.from('lead_import_sources').delete().eq('id', sourceId);
    if (brand) await admin.from('brands').delete().eq('id', brand.id);
    check('cleanup: fixture items removed', ((await admin.from('inventory_items').select('id').in('id', itemIds.length ? itemIds : [-1])).data ?? []).length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error('Test script crashed:', e); process.exit(1); });
