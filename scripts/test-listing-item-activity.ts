/**
 * test-listing-item-activity.ts
 *
 * DB-backed validation for "Lead Activity by Item" (migration
 * 20260919000000): listing_demand_item_activity_v1_0 and
 * lead_drilldown_item_attributed_ids_v1_0.
 *
 *  - exact 4W / 8W / 12W windows taken from weekly_trend boundaries
 *  - currently-listed items only; zero-lead items stay visible
 *  - ITEM attribution edge cases: before listing, after listing end,
 *    cancelled cycle, stale-active clipped at the realized exit date,
 *    multi-channel listing, NULL normalized channel (item-attributed but
 *    never channel-attributed), NULL first_contact_at
 *  - Offers = attributed leads with offer_type <> NONE (max 1 per lead);
 *    Last Lead is period-scoped
 *  - cross-check against Listing Demand Evidence itself
 *    (items[].item_attributed_leads_in_period, listing/channel days)
 *  - every displayed count reconciles with the exact /leads cohort
 *    (drill-down URL -> parseLeadFilters -> applyLeadFilters)
 *  - channel attribution unchanged; no cross-user leakage
 *
 * Local Supabase only (safety-gated); all rows are deleted before exit.
 *
 * Usage:  npx tsx scripts/test-listing-item-activity.ts
 */

import crypto from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import { getListingDemandEvidence } from '../src/lib/analytics/listingDemandEvidence';
import { getListingItemActivity } from '../src/lib/analytics/listingItemActivity';
import { loadLeadsForUser } from '../src/lib/leads/leadsServer';
import { applyLeadFilters, parseLeadFilters, itemAttributionRequest, attributionRequest } from '../src/lib/leads/leadFilters';
import { itemAttributedLeadsUrl, itemOffersUrl, itemSeriousPlusUrl } from '../src/lib/leads/leadDrilldownUrls';
import { itemActivityWindow, sortItemActivity, itemActiveChannelsLabel } from '../src/lib/listingItemActivityHelpers';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}

const PASSWORD = 'Item-Activity-Fixture-Local-Only-1!';

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
  const { data, error } = await admin.from(table).select('id').eq(col, val).maybeSingle();
  if (error || !data) throw new Error(`${table}.${col}=${val} not found`);
  return data.id as number;
}

async function main() {
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const emailA = 'item-activity-fixture-a@example.test';
  const emailB = 'item-activity-fixture-b@example.test';
  const authA = await ensureAuthUser(admin, emailA);
  const authB = await ensureAuthUser(admin, emailB);
  const userA = await resolveAppUserId(admin, authA);
  const userB = await resolveAppUserId(admin, authB);

  let brandId: number;
  const { data: brandRow } = await admin.from('brands').select('id').eq('name', 'Item-Activity-Test-Brand').maybeSingle();
  if (brandRow) brandId = brandRow.id as number;
  else { const { data, error } = await admin.from('brands').insert({ name: 'Item-Activity-Test-Brand' }).select('id').single(); if (error) throw error; brandId = data.id as number; }
  const { data: cat } = await admin.from('item_categories').select('id').eq('name', 'Guitars').single();
  const { data: sub } = await admin.from('item_subtypes').select('id').eq('category_id', cat!.id).eq('name', 'Electric Guitar').single();
  const subtypeId = sub!.id as number;
  const marketplaceId = await lookupId(admin, 'deal_channels', 'name', 'Marketplace');
  const kijijiId = await lookupId(admin, 'deal_channels', 'name', 'Kijiji');
  const reverbId = await lookupId(admin, 'deal_channels', 'name', 'Reverb');

  const itemIds: number[] = [];
  const dealIds: number[] = [];
  const listingIds: number[] = [];
  const leadIds: number[] = [];
  const sourceIds: number[] = [];

  async function source(userId: number): Promise<number> {
    const { data, error } = await admin.from('lead_import_sources').upsert(
      { user_id: userId, source_code: 'GT_LEAD_LOG', provider: 'GOOGLE_SHEETS', source_name: 'Item Activity Fixture', spreadsheet_id: `item-activity-${userId}`, sheet_name: 'Leads', is_enabled: true },
      { onConflict: 'user_id,source_code' },
    ).select('id').single();
    if (error) throw error;
    sourceIds.push(data.id as number);
    return data.id as number;
  }
  async function item(userId: number, key: string, model: string): Promise<number> {
    const { data, error } = await admin.from('inventory_items').insert({ user_id: userId, brand_id: brandId, item_subtype_id: subtypeId, purpose_id: null, model, status: 'owned', serial_number: `IAF:${key}` }).select('id').single();
    if (error) throw error;
    itemIds.push(data.id as number);
    const { data: deal, error: dealErr } = await admin.from('deals').insert({ user_id: userId, deal_type: 'purchase', deal_date: '2019-10-01', deal_channel_id: null }).select('id').single();
    if (dealErr) throw dealErr;
    dealIds.push(deal.id as number);
    const { error: diErr } = await admin.from('deal_items').insert({ user_id: userId, deal_id: deal.id, item_id: data.id, direction: 'in', total_value: 100 });
    if (diErr) throw diErr;
    return data.id as number;
  }
  async function listing(userId: number, itemId: number, channelId: number, status: 'active' | 'ended' | 'cancelled', listedAt: string | null, endedAt: string | null, cancelledAt: string | null = null) {
    const { data, error } = await admin.from('item_listings').insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: channelId, status, listed_at: listedAt, ended_at: endedAt, cancelled_at: cancelledAt, is_ai_generated: false }).select('id').single();
    if (error) throw error;
    listingIds.push(data.id as number);
  }
  async function lead(userId: number, srcId: number, itemId: number, o: { first: string | null; channel: number | null; quality?: string; offer?: 'NONE' | 'CASH' | 'TRADE' | 'MIXED' }): Promise<number> {
    const offer = o.offer ?? 'NONE';
    const { data, error } = await admin.from('item_leads').insert({
      user_id: userId, source_id: srcId, inventory_item_id: itemId, lead_id: crypto.randomUUID(),
      first_contact_at: o.first, last_contact_at: o.first, deal_channel_id: o.channel, source_channel: o.channel === null ? 'Other' : null,
      lead_quality: o.quality ?? 'LOW', offer_type: offer, status: 'OPEN', source_updated_at: new Date().toISOString(),
      cash_component: offer === 'TRADE' ? 0 : offer === 'MIXED' ? 100 : null,
      trade_item: offer === 'TRADE' || offer === 'MIXED' ? 'Trade thing' : null,
      best_cash_offer: offer === 'CASH' ? 500 : null,
      buyer_message_count: 3, our_message_count: 1,
    }).select('id').single();
    if (error) throw error;
    leadIds.push(data.id as number);
    return data.id as number;
  }
  const itemCohort = async (user: number, itemId: number, from: string, to: string): Promise<number[]> => {
    const { data, error } = await admin.rpc('lead_drilldown_item_attributed_ids_v1_0', { p_target_user_id: user, p_item_id: itemId, p_period_start: from, p_period_end: to });
    if (error) throw new Error(`item cohort rpc failed: ${error.message}`);
    return ((data ?? []) as { lead_row_id: number }[]).map((r) => r.lead_row_id).sort((a, b) => a - b);
  };
  const channelCohort = async (user: number, channel: number, from: string, to: string): Promise<number[]> => {
    const { data, error } = await admin.rpc('lead_drilldown_channel_attributed_ids_v1_0', { p_target_user_id: user, p_deal_channel_id: channel, p_period_start: from, p_period_end: to });
    if (error) throw new Error(`channel cohort rpc failed: ${error.message}`);
    return ((data ?? []) as { lead_row_id: number }[]).map((r) => r.lead_row_id).sort((a, b) => a - b);
  };

  const END = '2020-01-30';

  try {
    console.log('\n=== Fixtures ===');
    const srcA = await source(userA);
    const srcB = await source(userB);

    // X1 — cross-listed: Marketplace ended 01-05..01-20 + Kijiji active from 01-10 (currently listed)
    const x1 = await item(userA, 'x1', 'Activity X1');
    await listing(userA, x1, marketplaceId, 'ended', '2020-01-05', '2020-01-20');
    await listing(userA, x1, kijijiId, 'active', '2020-01-10', null);
    const x1_before = await lead(userA, srcA, x1, { first: '2020-01-03', channel: marketplaceId });                          // before any exposure
    const x1_a = await lead(userA, srcA, x1, { first: '2020-01-05', channel: marketplaceId, quality: 'SERIOUS', offer: 'CASH' });   // first exposure day
    const x1_nullchan = await lead(userA, srcA, x1, { first: '2020-01-12', channel: null, quality: 'HIGH_INTENT', offer: 'TRADE' }); // NULL channel, item exposure exists
    const x1_late = await lead(userA, srcA, x1, { first: '2020-01-25', channel: marketplaceId, quality: 'LOW' });                  // Marketplace ended; Kijiji still active
    const x1_after_window = await lead(userA, srcA, x1, { first: '2020-02-15', channel: kijijiId });                                 // outside window
    const x1_nodate = await lead(userA, srcA, x1, { first: null, channel: marketplaceId });

    // X2 — currently listed, zero leads
    const x2 = await item(userA, 'x2', 'Activity X2');
    await listing(userA, x2, reverbId, 'active', '2020-01-01', null);

    // X3 — stale-active Reverb, realized 01-10: NOT currently listed
    const x3 = await item(userA, 'x3', 'Activity X3');
    await listing(userA, x3, reverbId, 'active', '2020-01-02', null);
    {
      const { data: deal, error } = await admin.from('deals').insert({ user_id: userA, deal_type: 'sale', deal_date: '2020-01-10', deal_channel_id: null, cash_received: 500 }).select('id').single();
      if (error) throw error;
      dealIds.push(deal.id as number);
      await admin.from('deal_items').insert({ user_id: userA, deal_id: deal.id, item_id: x3, direction: 'out', total_value: 500 });
      await admin.from('inventory_items').update({ status: 'sold', sold_date: '2020-01-10' }).eq('id', x3);
    }
    const x3_before_exit = await lead(userA, srcA, x3, { first: '2020-01-08', channel: reverbId, quality: 'ENGAGED' });
    const x3_after_exit = await lead(userA, srcA, x3, { first: '2020-01-15', channel: reverbId, quality: 'SERIOUS' });

    // X4 — cancelled Marketplace cycle, then an active Reverb cycle from 01-20
    const x4 = await item(userA, 'x4', 'Activity X4');
    await listing(userA, x4, marketplaceId, 'cancelled', '2020-01-01', null, '2020-01-02');
    await listing(userA, x4, reverbId, 'active', '2020-01-20', null);
    const x4_cancelled = await lead(userA, srcA, x4, { first: '2020-01-03', channel: marketplaceId });
    const x4_active = await lead(userA, srcA, x4, { first: '2020-01-21', channel: reverbId, offer: 'MIXED' });

    // X5 — long-running Reverb listing; leads chosen to differ per Trend Window
    const x5 = await item(userA, 'x5', 'Activity X5');
    await listing(userA, x5, reverbId, 'active', '2019-11-15', null);
    const x5_8w = await lead(userA, srcA, x5, { first: '2019-12-20', channel: reverbId, quality: 'SERIOUS' }); // in 8W + 12W, not 4W
    const x5_12w = await lead(userA, srcA, x5, { first: '2019-11-20', channel: reverbId });                      // 12W only

    // User B — same shape; must never leak into A
    const b1 = await item(userB, 'b1', 'Activity B1');
    await listing(userB, b1, reverbId, 'active', '2020-01-01', null);
    const b1_lead = await lead(userB, srcB, b1, { first: '2020-01-05', channel: reverbId, quality: 'SERIOUS', offer: 'CASH' });

    const windows: Record<number, { from: string; to: string }> = {};
    const evidenceByWeeks = new Map<number, Awaited<ReturnType<typeof getListingDemandEvidence>>>();
    for (const w of [4, 8, 12] as const) {
      const ev = await getListingDemandEvidence({ appUserId: userA, serviceClient: admin, startDate: '2020-01-24', endDate: END, trendWeeks: w });
      evidenceByWeeks.set(w, ev);
      windows[w] = itemActivityWindow(ev)!;
    }

    console.log('\n[A — exact Trend Window boundaries come from weekly_trend]');
    check('4W window = 2020-01-03 .. 2020-01-30', windows[4].from === '2020-01-03' && windows[4].to === END, windows[4]);
    check('8W window = 2019-12-06 .. 2020-01-30', windows[8].from === '2019-12-06' && windows[8].to === END, windows[8]);
    check('12W window = 2019-11-08 .. 2020-01-30', windows[12].from === '2019-11-08' && windows[12].to === END, windows[12]);
    for (const w of [4, 8, 12] as const) {
      const ev = evidenceByWeeks.get(w)!;
      check(`${w}W: window spans exactly ${w} weekly buckets`, ev.weekly_trend.length === w && windows[w].from === ev.weekly_trend[0].start_date && windows[w].to === ev.weekly_trend[w - 1].end_date);
    }
    check('windows are nested (4W ⊂ 8W ⊂ 12W) and end on the same day', windows[12].from < windows[8].from && windows[8].from < windows[4].from);

    const act = async (w: 4 | 8 | 12) => getListingItemActivity({ appUserId: userA, serviceClient: admin, startDate: windows[w].from, endDate: windows[w].to });
    const byId = (rows: Awaited<ReturnType<typeof act>>, id: number) => rows.find((r) => r.item_id === id);

    console.log('\n[B — 4W item activity]');
    const a4 = await act(4);
    check('only currently listed items: X1, X2, X4, X5 (X3 realized, user B excluded)', JSON.stringify(a4.map((r) => r.item_id).sort((a, b) => a - b)) === JSON.stringify([x1, x2, x4, x5].sort((a, b) => a - b)), a4.map((r) => r.item_id));
    check('realized (stale-active) item X3 is NOT listed', !byId(a4, x3));
    check('other user\'s item never appears', !byId(a4, b1));
    const r1 = byId(a4, x1)!;
    check('X1 leads = 3 (first-exposure-day, NULL-channel, late-via-Kijiji)', r1.item_attributed_leads === 3, r1);
    check('X1 Serious+ = 2 (SERIOUS + HIGH_INTENT)', r1.serious_plus_attributed_leads === 2, r1);
    check('X1 Offers = 2 (CASH + TRADE; NONE not counted)', r1.offer_attributed_leads === 2, r1);
    check('X1 Last Lead is period-scoped: 2020-01-25 (NOT the later 2020-02-15 lead)', r1.last_attributed_lead_date === '2020-01-25', r1.last_attributed_lead_date);
    check('X1 channel days = Marketplace 16 (01-05..01-20) + Kijiji 21 (01-10..01-30) = 37', r1.channel_listing_days === 37, r1.channel_listing_days);
    check('X1 item listing days = 26 (01-05..01-30 union)', r1.item_listing_days === 26, r1.item_listing_days);
    check('X1 active channel names shown: Marketplace not active any more, Kijiji only', itemActiveChannelsLabel(r1) === 'Kijiji', itemActiveChannelsLabel(r1));
    const r2 = byId(a4, x2)!;
    check('X2 (zero leads) remains visible with 0/0/0 and last lead NULL', !!r2 && r2.item_attributed_leads === 0 && r2.serious_plus_attributed_leads === 0 && r2.offer_attributed_leads === 0 && r2.last_attributed_lead_date === null, r2);
    check('X2 still reports its exposure (28 channel days in the 4W window)', r2.channel_listing_days === 28, r2.channel_listing_days);
    const r4 = byId(a4, x4)!;
    check('X4: cancelled-cycle lead excluded, active-cycle lead counted (1 lead, 1 offer, 0 Serious+)', r4.item_attributed_leads === 1 && r4.offer_attributed_leads === 1 && r4.serious_plus_attributed_leads === 0, r4);
    check('X4 last lead 2020-01-21', r4.last_attributed_lead_date === '2020-01-21');
    const r5 = byId(a4, x5)!;
    check('X5 has no 4W leads (its leads fall in 8W/12W only)', r5.item_attributed_leads === 0 && r5.last_attributed_lead_date === null, r5);

    console.log('\n[C — 8W and 12W follow the same exact window]');
    const a8 = await act(8);
    const a12 = await act(12);
    check('8W: X5 has 1 lead (12-20), Serious+ 1, last 2019-12-20', byId(a8, x5)!.item_attributed_leads === 1 && byId(a8, x5)!.serious_plus_attributed_leads === 1 && byId(a8, x5)!.last_attributed_lead_date === '2019-12-20', byId(a8, x5));
    check('12W: X5 has 2 leads, Serious+ 1', byId(a12, x5)!.item_attributed_leads === 2 && byId(a12, x5)!.serious_plus_attributed_leads === 1, byId(a12, x5));
    check('12W: X5 last lead is still the latest in-window lead (2019-12-20)', byId(a12, x5)!.last_attributed_lead_date === '2019-12-20');
    check('X1 is unchanged 4W -> 8W -> 12W (its listing starts 2020-01-05)', [a8, a12].every((r) => byId(r, x1)!.item_attributed_leads === 3 && byId(r, x1)!.last_attributed_lead_date === '2020-01-25'));
    check('exposure grows with the wider window (X5 channel days 4W < 8W < 12W)', byId(a4, x5)!.channel_listing_days < byId(a8, x5)!.channel_listing_days && byId(a8, x5)!.channel_listing_days < byId(a12, x5)!.channel_listing_days);
    check('same currently-listed set for every window', [a8, a12].every((r) => r.length === a4.length));

    console.log('\n[D — default sort keeps zero-lead listings visible]');
    const sorted = sortItemActivity(a4);
    check('sorted: X1 (3 leads) first, then X4 (1), zero-lead items after', sorted[0].item_id === x1 && sorted[1].item_id === x4 && sorted.length === 4, sorted.map((r) => r.item_id));
    check('zero-lead items X2/X5 kept, ordered by name ASC', sorted[2].item_id === x2 && sorted[3].item_id === x5);

    console.log('\n[E — cross-check against Listing Demand Evidence (same window)]');
    for (const w of [4, 8, 12] as const) {
      const ev = await getListingDemandEvidence({ appUserId: userA, serviceClient: admin, startDate: windows[w].from, endDate: windows[w].to, trendWeeks: 4 });
      const rows = await act(w);
      for (const row of rows) {
        const e = ev.items.find((i) => i.item_id === row.item_id);
        check(`${w}W item ${row.item_id}: leads === evidence item_attributed_leads_in_period`, !!e && e.item_attributed_leads_in_period === row.item_attributed_leads, { e: e?.item_attributed_leads_in_period, row: row.item_attributed_leads });
        check(`${w}W item ${row.item_id}: item/channel listing days === evidence`, !!e && e.item_listing_days_in_period === row.item_listing_days && e.channel_listing_days_in_period === row.channel_listing_days);
      }
      check(`${w}W: item set === evidence currently-listed items`, ev.items.length === rows.length && ev.items.every((i) => rows.some((r) => r.item_id === i.item_id)));
    }

    console.log('\n[F — every displayed count reconciles with the exact /leads cohort]');
    const payload = await loadLeadsForUser({ db: admin, serviceClient: admin, appUserId: userA, attribution: null });
    for (const w of [4, 8, 12] as const) {
      const win = windows[w];
      for (const row of await act(w)) {
        const src = { itemId: row.item_id, leads: row.item_attributed_leads, seriousPlus: row.serious_plus_attributed_leads, offers: row.offer_attributed_leads };
        const ids = await itemCohort(userA, row.item_id, win.from, win.to);
        const set = new Set(ids);
        const count = (url: string | null) => {
          if (url === null) return 0;
          const f = parseLeadFilters((k) => new URL(url, 'http://x').searchParams.get(k));
          return applyLeadFilters(payload.leads, f, null, set).length;
        };
        check(`${w}W item ${row.item_id}: Leads ${row.item_attributed_leads} === cohort count`, ids.length === row.item_attributed_leads && count(itemAttributedLeadsUrl(win, src)) === row.item_attributed_leads);
        check(`${w}W item ${row.item_id}: Serious+ ${row.serious_plus_attributed_leads} === cohort + serious_plus`, count(itemSeriousPlusUrl(win, src)) === row.serious_plus_attributed_leads);
        check(`${w}W item ${row.item_id}: Offers ${row.offer_attributed_leads} === cohort + offers=1`, count(itemOffersUrl(win, src)) === row.offer_attributed_leads);
        const noLink = row.item_attributed_leads === 0 ? itemAttributedLeadsUrl(win, src) === null : true;
        check(`${w}W item ${row.item_id}: zero counts produce no link`, noLink && (row.serious_plus_attributed_leads !== 0 || itemSeriousPlusUrl(win, src) === null) && (row.offer_attributed_leads !== 0 || itemOffersUrl(win, src) === null));
      }
    }

    console.log('\n[G — ITEM attribution edge cases (cohort membership)]');
    const w4 = windows[4];
    const c1 = await itemCohort(userA, x1, w4.from, w4.to);
    check('X1 cohort is exactly {first-exposure-day, NULL-channel, late-via-Kijiji}', JSON.stringify(c1) === JSON.stringify([x1_a, x1_nullchan, x1_late].sort((a, b) => a - b)), c1);
    check('lead BEFORE listing starts excluded', !c1.includes(x1_before));
    check('lead AFTER the window excluded', !c1.includes(x1_after_window));
    check('NULL first_contact_at excluded', !c1.includes(x1_nodate));
    check('NULL normalized channel lead IS item-attributed', c1.includes(x1_nullchan));
    check('lead tagged Marketplace after Marketplace ended is still item-attributed (Kijiji exposure that day)', c1.includes(x1_late));
    const c4 = await itemCohort(userA, x4, w4.from, w4.to);
    check('X4: lead during CANCELLED cycle excluded, active-cycle lead included', !c4.includes(x4_cancelled) && c4.includes(x4_active) && c4.length === 1, c4);
    const c3 = await itemCohort(userA, x3, '2020-01-01', END);
    check('X3 (stale-active): pre-exit lead attributed, post-exit lead excluded (clipped at exit_date)', JSON.stringify(c3) === JSON.stringify([x3_before_exit]) && !c3.includes(x3_after_exit), c3);
    check('period boundary: one-day window on first exposure day includes the lead', JSON.stringify(await itemCohort(userA, x1, '2020-01-05', '2020-01-05')) === JSON.stringify([x1_a]));
    check('period boundary: window ending the day BEFORE first exposure has none', (await itemCohort(userA, x1, '2019-12-01', '2020-01-04')).length === 0);
    check('X5 8W/12W cohorts', (await itemCohort(userA, x5, windows[8].from, windows[8].to)).join() === [x5_8w].join() && (await itemCohort(userA, x5, windows[12].from, windows[12].to)).join() === [x5_8w, x5_12w].sort((a, b) => a - b).join());

    console.log('\n[H — item attribution vs channel attribution stay distinct]');
    const mkt = await channelCohort(userA, marketplaceId, w4.from, w4.to);
    check('NULL-channel lead is item-attributed but in NO channel cohort', c1.includes(x1_nullchan) && ![...mkt, ...(await channelCohort(userA, kijijiId, w4.from, w4.to)), ...(await channelCohort(userA, reverbId, w4.from, w4.to))].includes(x1_nullchan));
    check('Marketplace-tagged lead on 01-25 is item-attributed but NOT Marketplace-channel-attributed', c1.includes(x1_late) && !mkt.includes(x1_late));
    check('channel cohort semantics unchanged: Marketplace = {01-05 lead} only', JSON.stringify(mkt) === JSON.stringify([x1_a]), mkt);
    const ev4 = evidenceByWeeks.get(4)!;
    for (const ch of ev4.channels) {
      const ids = await channelCohort(userA, ch.deal_channel_id, ev4.period.start_date, ev4.period.end_date);
      check(`channel ${ch.channel_name}: RPC count still === evidence channel_attributed_leads`, ids.length === ch.current.channel_attributed_leads, { ids: ids.length, ev: ch.current.channel_attributed_leads });
    }

    console.log('\n[I — URL semantics: raw item filter vs attributed cohort]');
    const rawUrl = `/leads?item_id=${x1}&from=${w4.from}&to=${w4.to}`;
    const rawF = parseLeadFilters((k) => new URL(rawUrl, 'http://x').searchParams.get(k));
    const rawCount = applyLeadFilters(payload.leads, rawF, null, null).length;
    check('raw item_id + from/to is NOT item-attributed and includes the before-listing lead', !rawF.itemAttributed && itemAttributionRequest(rawF) === null && rawCount === 4, rawCount);
    const attrF = parseLeadFilters((k) => new URL(`${rawUrl}&item_attributed=1`, 'http://x').searchParams.get(k));
    check('item_attributed=1 with item_id + from + to activates the cohort request', attrF.itemAttributed && itemAttributionRequest(attrF)?.itemId === x1 && attributionRequest(attrF) === null);
    check('cohort count (3) differs from the raw count (4)', applyLeadFilters(payload.leads, attrF, null, new Set(c1)).length === 3);
    check('without the cohort set, an attributed URL yields nothing (never silently raw)', applyLeadFilters(payload.leads, attrF, null, null).length === 0);

    console.log('\n[J — user isolation]');
    const bAct = await getListingItemActivity({ appUserId: userB, serviceClient: admin, startDate: windows[4].from, endDate: windows[4].to });
    check('user B activity contains only B\'s item, with its own counts', bAct.length === 1 && bAct[0].item_id === b1 && bAct[0].item_attributed_leads === 1 && bAct[0].offer_attributed_leads === 1, bAct);
    check('A\'s activity never contains B\'s item', !a4.some((r) => r.item_id === b1));
    check('item cohort RPC: A asking for B\'s item gets nothing', (await itemCohort(userA, b1, w4.from, w4.to)).length === 0);
    check('item cohort RPC: B\'s own item returns exactly B\'s lead', JSON.stringify(await itemCohort(userB, b1, w4.from, w4.to)) === JSON.stringify([b1_lead]));
    check('A\'s cohort for A\'s items never includes B\'s lead', !c1.includes(b1_lead));

    const signIn = async (email: string) => {
      const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
      if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
      return c;
    };
    const clientA = await signIn(emailA);
    const viaRls = await loadLeadsForUser({ db: clientA, serviceClient: admin, appUserId: userA, attribution: null, itemAttribution: { itemId: x1, from: w4.from, to: w4.to } });
    check('RLS client A loads its own leads + the item cohort payload', viaRls.item_attributed_lead_ids !== null && viaRls.item_attributed_lead_ids.length === 3 && !viaRls.leads.some((l) => l.id === b1_lead));
    const spoof = await loadLeadsForUser({ db: clientA, serviceClient: admin, appUserId: userB, attribution: null });
    check('RLS client A asking for B\'s user id sees zero leads', spoof.leads.length === 0);
    for (const fn of ['listing_demand_item_activity_v1_0', 'lead_drilldown_item_attributed_ids_v1_0', '_lead_item_attributed_v1_0']) {
      const args = fn === 'listing_demand_item_activity_v1_0'
        ? { p_target_user_id: userA, p_period_start: w4.from, p_period_end: w4.to }
        : fn === 'lead_drilldown_item_attributed_ids_v1_0'
          ? { p_target_user_id: userA, p_item_id: x1, p_period_start: w4.from, p_period_end: w4.to }
          : { p_target_user_id: userA, p_period_start: w4.from, p_period_end: w4.to };
      const { error } = await clientA.rpc(fn, args);
      check(`authenticated users cannot call ${fn} directly (service_role only)`, !!error);
    }
  } finally {
    console.log('\n=== Cleanup ===');
    if (leadIds.length) { const { error } = await admin.from('item_leads').delete().in('id', leadIds); check('cleanup: item_leads deleted', !error, error); }
    if (listingIds.length) { const { error } = await admin.from('item_listings').delete().in('id', listingIds); check('cleanup: item_listings deleted', !error, error); }
    if (itemIds.length) await admin.from('deal_items').delete().in('item_id', itemIds);
    if (dealIds.length) await admin.from('deals').delete().in('id', dealIds);
    if (itemIds.length) { const { error } = await admin.from('inventory_items').delete().in('id', itemIds); check('cleanup: inventory_items deleted', !error, error); }
    if (sourceIds.length) await admin.from('lead_import_sources').delete().in('id', sourceIds);
    const { data: remaining } = await admin.from('item_leads').select('id').in('id', leadIds.length ? leadIds : [-1]);
    check('all fixture leads deleted', (remaining?.length ?? 0) === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
