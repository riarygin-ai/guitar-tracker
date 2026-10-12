/**
 * test-listings-performance.ts
 *
 * Performance investigation + regression guard for the /listings request
 * graph: builds a realistically large local fixture (many items, many
 * listing cycles across 3 channels, several months of leads, cross-listed
 * items, several dozen realized deals) and then calls the exact same
 * server-side functions the three /listings API routes call —
 * getListingEvidenceForCurrentUser, getListingDemandEvidence (4W/8W/12W),
 * getListingItemActivity — measuring wall-clock duration and counting RPC
 * calls through a wrapped client (to catch an accidental N+1/repeated-call
 * regression, not just a raw timing regression, which is too environment-
 * dependent to assert tightly).
 *
 * This is NOT part of the default fast regression set (it is slow to set
 * up) — run it manually when investigating /listings performance:
 *
 *   npx tsx scripts/test-listings-performance.ts
 *
 * Set KEEP_FIXTURE=1 to skip cleanup (so a second run, e.g. after a SQL
 * change, reuses the exact same data for a fair before/after comparison).
 * Fixture rows are tagged (serial_number / notes prefixes) and looked up
 * before insert, so re-running with KEEP_FIXTURE=1 is idempotent rather
 * than duplicating volume.
 *
 * Local Supabase only (safety-gated); cleaned up unless KEEP_FIXTURE=1.
 */

import crypto from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import { getListingEvidenceForCurrentUser } from '../src/lib/analytics/listingEvidence';
import { getListingDemandEvidence } from '../src/lib/analytics/listingDemandEvidence';
import { getListingItemActivity } from '../src/lib/analytics/listingItemActivity';
import { itemActivityWindow } from '../src/lib/listingItemActivityHelpers';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}

const TAG = 'PERFFIX';
const FIXTURE_EMAIL = 'listings-performance-fixture@example.test';
const PASSWORD = 'Listings-Performance-Fixture-Local-1!';

// ── Fixture scale (section 16: "many leads, many listing cycles,
// cross-listed items, several months of history, multiple channels") ──────
const ITEM_COUNT = 150;
const HISTORY_DAYS = 270; // ~9 months
const LEADS_PER_ITEM_AVG = 7; // ~1050 leads total

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Wraps a client so every .rpc() call is counted by function name (proves no accidental N+1 across calls). */
function countingClient(client: SupabaseClient): { client: SupabaseClient; counts: () => Record<string, number> } {
  const counts: Record<string, number> = {};
  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'rpc') {
        return (fn: string, args: unknown) => { counts[fn] = (counts[fn] ?? 0) + 1; return (target.rpc as (f: string, a: unknown) => unknown)(fn, args); };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { client: proxy as SupabaseClient, counts: () => ({ ...counts }) };
}

async function timeMs<T>(label: string, fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  console.log(`  [timing] ${label}: ${ms.toFixed(0)}ms`);
  return { result, ms };
}

async function ensureAuthUser(admin: SupabaseClient): Promise<string> {
  const { data: created, error } = await admin.auth.admin.createUser({ email: FIXTURE_EMAIL, password: PASSWORD, email_confirm: true });
  if (!error && created.user) return created.user.id;
  const { data: listed } = await admin.auth.admin.listUsers({ perPage: 200 });
  const match = listed?.users.find((u) => u.email === FIXTURE_EMAIL);
  if (match) return match.id;
  throw new Error(`Could not create or find auth user ${FIXTURE_EMAIL}: ${error?.message}`);
}
async function resolveAppUserId(admin: SupabaseClient, authUserId: string): Promise<number> {
  for (let i = 0; i < 10; i++) {
    const { data } = await admin.from('app_users').select('id').eq('auth_user_id', authUserId).maybeSingle();
    if (data) return data.id as number;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('app_users row never appeared');
}
async function ensureBrand(admin: SupabaseClient, name: string): Promise<number> {
  const { data: existing } = await admin.from('brands').select('id').eq('name', name).maybeSingle();
  if (existing) return existing.id as number;
  const { data, error } = await admin.from('brands').insert({ name }).select('id').single();
  if (error) throw error;
  return data.id as number;
}

async function buildFixture(admin: SupabaseClient): Promise<{ userId: number; itemIds: number[] }> {
  const userId = await resolveAppUserId(admin, await ensureAuthUser(admin));
  const brandId = await ensureBrand(admin, `${TAG}-Brand`);
  const { data: cat } = await admin.from('item_categories').select('id').eq('name', 'Guitars').single();
  const { data: sub } = await admin.from('item_subtypes').select('id').eq('category_id', cat!.id).eq('name', 'Electric Guitar').single();
  const { data: channels } = await admin.from('deal_channels').select('id').eq('is_listing_platform', true).order('id');
  const channelIds = (channels ?? []).map((c) => c.id as number);

  // Already built? (idempotent re-run with KEEP_FIXTURE=1). FORCE_REBUILD=1 wipes first —
  // used to recover from an interrupted/partial build left by a previous crashed run.
  const { data: existingItems } = await admin.from('inventory_items').select('id').eq('user_id', userId).like('serial_number', `${TAG}:%`);
  if ((existingItems?.length ?? 0) >= ITEM_COUNT && process.env.FORCE_REBUILD !== '1') {
    const { count: leadCount } = await admin.from('item_leads').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    const { count: listingCount } = await admin.from('item_listings').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    if ((leadCount ?? 0) > 0 && (listingCount ?? 0) > 0) {
      console.log(`  Fixture already present (${existingItems!.length} items, ${listingCount} listings, ${leadCount} leads) — reusing.`);
      return { userId, itemIds: existingItems!.map((i) => i.id as number) };
    }
    console.log('  Existing fixture is incomplete (a previous build was interrupted) — rebuilding from scratch.');
  }
  if ((existingItems?.length ?? 0) > 0) {
    await cleanupFixture(admin, userId, existingItems!.map((i) => i.id as number));
  }

  console.log(`  Building fixture: ${ITEM_COUNT} items over ${HISTORY_DAYS} days...`);
  const itemRows = Array.from({ length: ITEM_COUNT }, (_, i) => ({
    user_id: userId, brand_id: brandId, item_subtype_id: sub!.id, purpose_id: null,
    model: `${TAG} Model ${i}`, status: 'owned', serial_number: `${TAG}:${i}`,
  }));
  const itemIds: number[] = [];
  for (let i = 0; i < itemRows.length; i += 500) {
    const { data, error } = await admin.from('inventory_items').insert(itemRows.slice(i, i + 500)).select('id');
    if (error) throw new Error(`insert items: ${error.message}`);
    itemIds.push(...data.map((r) => r.id as number));
  }

  // Acquisition deals (one 'purchase' deal + deal_items row each, spread across the history window).
  const dealRows = itemIds.map((_, i) => ({ user_id: userId, deal_type: 'purchase', deal_date: daysAgo(HISTORY_DAYS - (i % HISTORY_DAYS)), deal_channel_id: null }));
  const dealIds: number[] = [];
  for (let i = 0; i < dealRows.length; i += 500) {
    const { data, error } = await admin.from('deals').insert(dealRows.slice(i, i + 500)).select('id');
    if (error) throw new Error(`insert acquisition deals: ${error.message}`);
    dealIds.push(...data.map((r) => r.id as number));
  }
  const acqDealItemRows = itemIds.map((itemId, i) => ({ user_id: userId, deal_id: dealIds[i], item_id: itemId, direction: 'in', total_value: 1000 + (i % 50) * 37 }));
  for (let i = 0; i < acqDealItemRows.length; i += 500) {
    const { error } = await admin.from('deal_items').insert(acqDealItemRows.slice(i, i + 500));
    if (error) throw new Error(`insert acquisition deal_items: ${error.message}`);
  }

  // Listing cycles: every item gets 1 cycle; every 3rd item is cross-listed (a 2nd channel); every 4th
  // item's first cycle already ended (a real previous cycle) before its current one.
  type ListingRow = { user_id: number; inventory_item_id: number; deal_channel_id: number; status: string; listed_at: string | null; ended_at: string | null; is_ai_generated: boolean };
  const listingRows: ListingRow[] = [];
  itemIds.forEach((itemId, i) => {
    const channel = channelIds[i % channelIds.length];
    const listedDaysAgo = HISTORY_DAYS - (i % HISTORY_DAYS) - 5;
    if (i % 4 === 0) {
      // A completed earlier cycle, then a fresh active one (previous_cycles_rollup exercised).
      // "days ago" is LARGER for older dates, so the ended cycle's listed_at must have a
      // STRICTLY LARGER days-ago value than its own ended_at (clamped to stay within history
      // and never invert past the item's own later `listedDaysAgo`).
      const olderListedAgo = Math.min(HISTORY_DAYS, listedDaysAgo + 60);
      const olderEndedAgo = Math.max(listedDaysAgo + 1, Math.min(olderListedAgo - 1, listedDaysAgo + 20));
      listingRows.push({ user_id: userId, inventory_item_id: itemId, deal_channel_id: channel, status: 'ended', listed_at: daysAgo(olderListedAgo), ended_at: daysAgo(olderEndedAgo), is_ai_generated: false });
    }
    listingRows.push({ user_id: userId, inventory_item_id: itemId, deal_channel_id: channel, status: 'active', listed_at: daysAgo(Math.max(0, listedDaysAgo)), ended_at: null, is_ai_generated: false });
    if (i % 3 === 0) {
      // Cross-listed on a second channel.
      const channel2 = channelIds[(i + 1) % channelIds.length];
      listingRows.push({ user_id: userId, inventory_item_id: itemId, deal_channel_id: channel2, status: 'active', listed_at: daysAgo(Math.max(0, listedDaysAgo - 3)), ended_at: null, is_ai_generated: false });
    }
  });
  for (let i = 0; i < listingRows.length; i += 500) {
    const { error } = await admin.from('item_listings').insert(listingRows.slice(i, i + 500));
    if (error) throw new Error(`insert listing cycles: ${error.message}`);
  }

  // Realized deals: every 6th item is sold, every 10th is traded — spread across the history window.
  const realizedDealRows: { user_id: number; deal_type: string; deal_date: string; deal_channel_id: number }[] = [];
  const realizedItemIdx: number[] = [];
  itemIds.forEach((_, i) => {
    if (i % 6 === 0) { realizedDealRows.push({ user_id: userId, deal_type: 'sale', deal_date: daysAgo(Math.max(0, HISTORY_DAYS - (i % HISTORY_DAYS) - 20)), deal_channel_id: channelIds[i % channelIds.length] }); realizedItemIdx.push(i); }
    else if (i % 10 === 0) { realizedDealRows.push({ user_id: userId, deal_type: 'trade', deal_date: daysAgo(Math.max(0, HISTORY_DAYS - (i % HISTORY_DAYS) - 20)), deal_channel_id: channelIds[i % channelIds.length] }); realizedItemIdx.push(i); }
  });
  const realizedDealIds: number[] = [];
  for (let i = 0; i < realizedDealRows.length; i += 500) {
    const { data, error } = await admin.from('deals').insert(realizedDealRows.slice(i, i + 500)).select('id');
    if (error) throw new Error(`insert realized deals: ${error.message}`);
    realizedDealIds.push(...data.map((r) => r.id as number));
  }
  const realizedDealItemRows = realizedItemIdx.map((itemIdx, i) => ({ user_id: userId, deal_id: realizedDealIds[i], item_id: itemIds[itemIdx], direction: 'out', total_value: 1200 }));
  for (let i = 0; i < realizedDealItemRows.length; i += 500) {
    const { error } = await admin.from('deal_items').insert(realizedDealItemRows.slice(i, i + 500));
    if (error) throw new Error(`insert realized deal_items: ${error.message}`);
  }
  // Mark those items sold/traded so analytics_item_lifecycle_v2 treats them as realized.
  for (let i = 0; i < realizedDealRows.length; i++) {
    await admin.from('inventory_items').update({ status: realizedDealRows[i].deal_type === 'sale' ? 'sold' : 'traded', sold_date: realizedDealRows[i].deal_date }).eq('id', itemIds[realizedItemIdx[i]]);
  }

  // Leads: spread across the full history window, varied quality/offer/status/channel, ~LEADS_PER_ITEM_AVG per item.
  const qualities = ['LOW', 'ENGAGED', 'SERIOUS', 'HIGH_INTENT'] as const;
  const statuses = ['OPEN', 'GHOSTED', 'DECLINED_BY_ME', 'AGREED', 'COMPLETED'] as const;
  const leadRows: Record<string, unknown>[] = [];
  itemIds.forEach((itemId, i) => {
    for (let j = 0; j < LEADS_PER_ITEM_AVG; j++) {
      const dayOffset = (i * 3 + j * 11) % HISTORY_DAYS;
      leadRows.push({
        user_id: userId, inventory_item_id: itemId, lead_id: crypto.randomUUID(),
        first_contact_at: daysAgo(dayOffset), deal_channel_id: channelIds[(i + j) % channelIds.length],
        lead_quality: qualities[(i + j) % qualities.length], offer_type: 'NONE',
        status: statuses[(i + j) % statuses.length],
        buyer_message_count: (j % 5), our_message_count: (j % 3),
        source_updated_at: new Date().toISOString(),
      });
    }
  });
  // lead_import_sources row (item_leads.source_id is NOT NULL).
  const { data: src, error: srcErr } = await admin.from('lead_import_sources')
    .upsert({ user_id: userId, source_code: 'GT_LEAD_LOG', provider: 'GOOGLE_SHEETS', source_name: `${TAG} Fixture`, spreadsheet_id: `${TAG}-fixture`, sheet_name: 'Leads', is_enabled: true }, { onConflict: 'user_id,source_code' })
    .select('id').single();
  if (srcErr) throw new Error(`lead_import_sources: ${srcErr.message}`);
  leadRows.forEach((r) => { r.source_id = src!.id; });
  for (let i = 0; i < leadRows.length; i += 500) {
    const { error } = await admin.from('item_leads').insert(leadRows.slice(i, i + 500));
    if (error) throw new Error(`insert leads (batch ${i}): ${error.message}`);
  }

  console.log(`  Fixture built: ${itemIds.length} items, ${listingRows.length} listing cycles, ${leadRows.length} leads, ${dealRows.length + realizedDealRows.length} deals.`);
  return { userId, itemIds };
}

async function cleanupFixture(admin: SupabaseClient, userId: number, itemIds: number[]): Promise<void> {
  await admin.from('item_leads').delete().eq('user_id', userId);
  await admin.from('item_listings').delete().eq('user_id', userId);
  await admin.from('deal_items').delete().eq('user_id', userId).in('item_id', itemIds);
  await admin.from('deals').delete().eq('user_id', userId);
  await admin.from('lead_import_sources').delete().eq('user_id', userId);
  await admin.from('inventory_items').delete().eq('user_id', userId);
}

async function main() {
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const { userId, itemIds } = await buildFixture(admin);
  const counted = countingClient(admin);

  try {
    console.log('\n=== Regression guard: the latest build_listing_evidence_v1_0 migration still uses the cheap cohort source ===');
    // Structural, not timing-based (timing is too environment-dependent to
    // assert in CI) — reads the migration file itself (the last CREATE OR
    // REPLACE wins) to catch an accidental revert to the full 13-layer
    // analytics-snapshot chain. See 20261012000001_listing_evidence_use_v2_1_
    // cohort.sql's own header for the full before/after measurement.
    {
      const fs: typeof import('fs') = await import('fs');
      const path: typeof import('path') = await import('path');
      const migDir = path.join(__dirname, '..', 'supabase', 'migrations');
      const latestListingEvidenceMigration = fs.readdirSync(migDir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .filter((f) => fs.readFileSync(path.join(migDir, f), 'utf8').includes('CREATE OR REPLACE FUNCTION public.build_listing_evidence_v1_0('))
        .pop();
      check('a build_listing_evidence_v1_0 migration exists', !!latestListingEvidenceMigration, latestListingEvidenceMigration);
      if (latestListingEvidenceMigration) {
        const raw = fs.readFileSync(path.join(migDir, latestListingEvidenceMigration), 'utf8');
        // Strip SQL `--` comments only — this migration's own header
        // comment legitimately mentions v2_13 (explaining what it used to
        // call), so the CODE is what must be checked, not the file text.
        const code = raw.replace(/--.*$/gm, '');
        check(`${latestListingEvidenceMigration} calls build_analytics_snapshot_v2_1, not a later/more-expensive wrapper version, for the liquidity cohort`, code.includes('public.build_analytics_snapshot_v2_1(p_target_user_id)') && !code.includes('build_analytics_snapshot_v2_13(p_target_user_id)'));
      }
    }


    console.log('\n=== Listing Evidence (build_listing_evidence_v1_0) ===');
    const { result: evidence, ms: evidenceMs } = await timeMs('getListingEvidenceForCurrentUser', () =>
      getListingEvidenceForCurrentUser({ appUserId: userId, serviceClient: counted.client }));
    check('Listing Evidence returns the fixture\'s listed items', evidence.listed_items.length > 0, evidence.listed_items.length);
    check('Listing Evidence completes well within the API timeout budget', evidenceMs < 15000, evidenceMs);

    console.log('\n=== Listing Demand Evidence — 4W / 8W / 12W (build_listing_demand_evidence_v1_1) ===');
    const today = daysAgo(0);
    const periodStart = daysAgo(6);
    const timings: Record<number, number> = {};
    for (const trendWeeks of [4, 8, 12] as const) {
      const countsBefore = counted.counts();
      const { result, ms } = await timeMs(`getListingDemandEvidence (${trendWeeks}W)`, () =>
        getListingDemandEvidence({ appUserId: userId, serviceClient: counted.client, startDate: periodStart, endDate: today, trendWeeks }));
      timings[trendWeeks] = ms;
      check(`${trendWeeks}W: weekly_trend has exactly ${trendWeeks} buckets`, result.weekly_trend.length === trendWeeks, result.weekly_trend.length);
      check(`${trendWeeks}W: exactly one RPC call for this single request (no repeated top-level call)`, (counted.counts()['build_listing_demand_evidence_v1_1'] ?? 0) === (countsBefore['build_listing_demand_evidence_v1_1'] ?? 0) + 1);
      check(`${trendWeeks}W completes well within the API timeout budget`, ms < 20000, ms);
    }
    check('12W is not wildly disproportionate to 4W (sub-linear/roughly-linear growth, not exponential)', timings[12] < timings[4] * 12, timings);

    console.log('\n=== Listing Item Activity (listing_demand_item_activity_v1_0) ===');
    const demand4w = await getListingDemandEvidence({ appUserId: userId, serviceClient: admin, startDate: periodStart, endDate: today, trendWeeks: 4 });
    const win = itemActivityWindow(demand4w)!;
    const { result: items, ms: itemMs } = await timeMs('getListingItemActivity', () =>
      getListingItemActivity({ appUserId: userId, serviceClient: counted.client, startDate: win.from, endDate: win.to }));
    check('Item Activity returns rows for the fixture', items.length > 0, items.length);
    check('Item Activity completes well within the API timeout budget', itemMs < 15000, itemMs);

    console.log('\n=== Full page load simulation (4W default — the common case) ===');
    const { ms: fullLoadMs } = await timeMs('Listing Evidence + Demand (4W) + Item Activity, in parallel (matches the page\'s own useSwrResource calls)', async () => {
      const demand = await getListingDemandEvidence({ appUserId: userId, serviceClient: admin, startDate: periodStart, endDate: today, trendWeeks: 4 });
      const w = itemActivityWindow(demand)!;
      await Promise.all([
        getListingEvidenceForCurrentUser({ appUserId: userId, serviceClient: admin }),
        getListingItemActivity({ appUserId: userId, serviceClient: admin, startDate: w.from, endDate: w.to }),
      ]);
    });
    check('a full default (4W) page load completes comfortably within the UI\'s expectations', fullLoadMs < 20000, fullLoadMs);

    console.log(`\n${passed} passed, ${failed} failed`);
  } finally {
    if (process.env.KEEP_FIXTURE === '1') {
      console.log('\nKEEP_FIXTURE=1 — leaving fixture rows in place for a repeat (before/after) run.');
    } else {
      console.log('\n=== Cleanup ===');
      await cleanupFixture(admin, userId, itemIds);
    }
  }
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
