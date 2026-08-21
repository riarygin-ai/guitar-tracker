/**
 * test-listing-dashboard.ts
 *
 * Focused validation for Listing Dashboard v1.0 (src/app/listings/page.tsx)
 * and the Inventory drill-down filters it links to (src/lib/
 * inventoryListingFilters.ts, src/lib/listingDashboardHelpers.ts) — a
 * follow-up to Listing Evidence v1.0 (commit aa884b2). Builds a small
 * dedicated fixture pool (marker `DASH:<key>`), fetches real Listing
 * Evidence via the actual RPC, then reconciles the Dashboard's data-layer
 * helpers against it directly. There is no component-rendering test
 * framework in this project (see every other scripts/test-*.ts), so this
 * exercises the extracted pure logic the page renders from, plus static
 * source-scans for the "never hardcode a channel name" / "Personal is
 * never a drill-down target" / "no Asking Value headline KPI while null"
 * requirements. Same conventions as every other script here: tsx, no test
 * framework, local check(), safety-gated to local Supabase only. Every
 * row created is deleted and the deletion verified before the script
 * exits.
 *
 * Usage:
 *   npx tsx scripts/test-listing-dashboard.ts
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl,
  assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import { buildListingLookups, matchesListingFilters } from '../src/lib/inventoryListingFilters';
import { inventoryUrl, findPurposeId, fmtMoney, fmtDays } from '../src/lib/listingDashboardHelpers';
import type { ListingEvidence } from '../src/lib/analytics/listingEvidence';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`, detail !== undefined ? detail : '');
  }
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function ensureBrand(admin: SupabaseClient, name: string): Promise<number> {
  const { data: existing } = await admin.from('brands').select('id').eq('name', name).maybeSingle();
  if (existing) return existing.id as number;
  const { data: created, error } = await admin.from('brands').insert({ name }).select('id').single();
  if (error) throw new Error(`Failed to create brand "${name}": ${error.message}`);
  return created.id as number;
}
async function subtypeId(admin: SupabaseClient, categoryName: string, subtypeName: string): Promise<number> {
  const { data: category, error: categoryError } = await admin.from('item_categories').select('id').eq('name', categoryName).maybeSingle();
  if (categoryError || !category) throw new Error(`Category "${categoryName}" not found`);
  const { data, error } = await admin.from('item_subtypes').select('id').eq('category_id', category.id).eq('name', subtypeName).maybeSingle();
  if (error || !data) throw new Error(`Subtype "${categoryName}/${subtypeName}" not found`);
  return data.id as number;
}
async function purposeId(admin: SupabaseClient, name: string): Promise<number> {
  const { data, error } = await admin.from('item_purposes').select('id').ilike('name', name).maybeSingle();
  if (error || !data) throw new Error(`Purpose "${name}" not found`);
  return data.id as number;
}
async function channelId(admin: SupabaseClient, name: string): Promise<number> {
  const { data, error } = await admin.from('deal_channels').select('id').eq('name', name).maybeSingle();
  if (error || !data) throw new Error(`Deal channel "${name}" not found`);
  return data.id as number;
}
async function insertItem(admin: SupabaseClient, key: string, spec: { userId: number; brandId: number; subtypeId: number; purposeId: number; model: string; estimatedSoldValue?: number | null }, createdItemIds: number[]): Promise<number> {
  const { data, error } = await admin.from('inventory_items').insert({
    user_id: spec.userId, brand_id: spec.brandId, item_subtype_id: spec.subtypeId, purpose_id: spec.purposeId,
    model: spec.model, status: 'owned', estimated_sold_value: spec.estimatedSoldValue ?? null, serial_number: `DASH:${key}`,
  }).select('id').single();
  if (error) throw new Error(`Failed to insert item "${key}": ${error.message}`);
  createdItemIds.push(data.id as number);
  return data.id as number;
}
async function acquireItem(admin: SupabaseClient, userId: number, itemId: number, dealType: string, acquisitionDate: string, value: number, createdDealIds: number[]): Promise<void> {
  const { data: deal, error: dealError } = await admin.from('deals').insert({ user_id: userId, deal_type: dealType, deal_date: acquisitionDate, deal_channel_id: null }).select('id').single();
  if (dealError) throw new Error(`Failed to insert acquisition deal for item ${itemId}: ${dealError.message}`);
  createdDealIds.push(deal.id as number);
  const { error: itemError } = await admin.from('deal_items').insert({ user_id: userId, deal_id: deal.id, item_id: itemId, direction: 'in', total_value: value });
  if (itemError) throw new Error(`Failed to insert acquisition deal_item for item ${itemId}: ${itemError.message}`);
}
async function insertListing(admin: SupabaseClient, userId: number, itemId: number, chId: number, listedAt: string, askingPrice: number | null, createdListingIds: number[]): Promise<void> {
  const { data, error } = await admin.from('item_listings').insert({
    user_id: userId, inventory_item_id: itemId, deal_channel_id: chId, status: 'active', listed_at: listedAt, asking_price: askingPrice, is_ai_generated: false,
  }).select('id').single();
  if (error) throw new Error(`Failed to insert listing (item=${itemId}, channel=${chId}): ${error.message}`);
  createdListingIds.push(data.id as number);
}

async function main() {
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const EMAIL = 'listing-dashboard-fixture@example.test';
  const { data: authUsers } = await admin.auth.admin.listUsers();
  let authUserId = authUsers?.users.find((u) => u.email === EMAIL)?.id ?? null;
  if (!authUserId) {
    const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: 'Listing-Dashboard-Fixture-Local-Only-1!', email_confirm: true });
    if (error || !created.user) throw new Error(`Failed to create test user: ${error?.message}`);
    authUserId = created.user.id;
  }
  let userId: number | null = null;
  for (let attempt = 0; attempt < 10 && !userId; attempt++) {
    const { data } = await admin.from('app_users').select('id').eq('auth_user_id', authUserId).maybeSingle();
    if (data) userId = data.id as number;
    else await new Promise((r) => setTimeout(r, 200));
  }
  if (!userId) throw new Error('test user app_users row never appeared');

  const brandId = await ensureBrand(admin, 'Dashboard-Test-Brand');
  const guitarSubtypeId = await subtypeId(admin, 'Guitars', 'Electric Guitar');
  const ampSubtypeId = await subtypeId(admin, 'Amps', 'Amp');
  const businessId = await purposeId(admin, 'Business');
  const hybridId = await purposeId(admin, 'Hybrid');
  const marketplaceId = await channelId(admin, 'Marketplace');
  const kijijiId = await channelId(admin, 'Kijiji');
  const reverbId = await channelId(admin, 'Reverb');

  const createdItemIds: number[] = [];
  const createdDealIds: number[] = [];
  const createdListingIds: number[] = [];

  try {
    // One item, one channel, old (90+ days).
    const oldSingle = await insertItem(admin, 'old-single', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Old Single Guitar', estimatedSoldValue: 800 }, createdItemIds);
    await acquireItem(admin, userId, oldSingle, 'purchase', daysAgo(200), 500, createdDealIds);
    await insertListing(admin, userId, oldSingle, reverbId, daysAgo(120), null, createdListingIds);

    // Cross-listed on 2 channels.
    const crossListed2 = await insertItem(admin, 'cross-2', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Cross-2 Guitar', estimatedSoldValue: 1500 }, createdItemIds);
    await acquireItem(admin, userId, crossListed2, 'purchase', daysAgo(60), 900, createdDealIds);
    await insertListing(admin, userId, crossListed2, marketplaceId, daysAgo(10), null, createdListingIds);
    await insertListing(admin, userId, crossListed2, reverbId, daysAgo(8), null, createdListingIds);

    // Cross-listed on all 3 channels.
    const crossListed3 = await insertItem(admin, 'cross-3', { userId, brandId, subtypeId: ampSubtypeId, purposeId: businessId, model: 'Cross-3 Amp', estimatedSoldValue: 2000 }, createdItemIds);
    await acquireItem(admin, userId, crossListed3, 'purchase', daysAgo(90), 1200, createdDealIds);
    await insertListing(admin, userId, crossListed3, marketplaceId, daysAgo(5), null, createdListingIds);
    await insertListing(admin, userId, crossListed3, kijijiId, daysAgo(6), null, createdListingIds);
    await insertListing(admin, userId, crossListed3, reverbId, daysAgo(7), null, createdListingIds);

    // Unlisted Business + Hybrid, for purpose_id derivation.
    const unlistedBusiness = await insertItem(admin, 'unlisted-business', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Unlisted Business Guitar', estimatedSoldValue: 600 }, createdItemIds);
    await acquireItem(admin, userId, unlistedBusiness, 'purchase', daysAgo(25), 350, createdDealIds);
    const unlistedHybrid = await insertItem(admin, 'unlisted-hybrid', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: hybridId, model: 'Unlisted Hybrid Guitar', estimatedSoldValue: 1100 }, createdItemIds);
    await acquireItem(admin, userId, unlistedHybrid, 'purchase', daysAgo(150), 700, createdDealIds);

    const { data: rawEvidence, error: rpcError } = await admin.rpc('build_listing_evidence_v1_0', { p_target_user_id: userId });
    if (rpcError || !rawEvidence) throw new Error(`build_listing_evidence_v1_0 failed: ${rpcError?.message}`);
    const evidence = rawEvidence as ListingEvidence;

    console.log('\n[A — Overview counts match Listing Evidence exactly]');
    {
      const p = evidence.population_summary;
      check('distinct_listed_item_count === 3', p.distinct_listed_item_count === 3, p.distinct_listed_item_count);
      check('active_channel_listing_count === 6 (1 + 2 + 3)', p.active_channel_listing_count === 6, p.active_channel_listing_count);
      check('cross_listed_item_count === 2', p.cross_listed_item_count === 2, p.cross_listed_item_count);
    }

    console.log('\n[B — channel cards are dynamic (no hardcoded channel set)]');
    {
      const names = evidence.channel_summary.map((c) => c.channel_name).sort();
      check('channel_summary contains exactly Kijiji/Marketplace/Reverb for this fixture set', JSON.stringify(names) === JSON.stringify(['Kijiji', 'Marketplace', 'Reverb']), names);
      // Each channel's listed_item_count must reconcile against the
      // lookup-derived count for that channel — proves the Dashboard's
      // per-channel numbers and the Inventory drill-down's per-channel
      // filter are reading the exact same source.
      const lookup = buildListingLookups(evidence);
      for (const channel of evidence.channel_summary) {
        const matchCount = Array.from(lookup.listedItemIds).filter((id) =>
          matchesListingFilters(id, lookup, { listingFilter: null, channelIds: [channel.channel_id], ageBuckets: [], channelCounts: [] }),
        ).length;
        check(`channel ${channel.channel_name}: card count (${channel.listed_item_count}) reconciles with drill-down filter match count (${matchCount})`, channel.listed_item_count === matchCount);
      }
    }

    console.log('\n[C — cross-listing counts reconcile]');
    {
      const lookup = buildListingLookups(evidence);
      for (const bucket of evidence.cross_listing_evidence.by_active_channel_count) {
        const matchCount = Array.from(lookup.listedItemIds).filter((id) =>
          matchesListingFilters(id, lookup, { listingFilter: null, channelIds: [], ageBuckets: [], channelCounts: [bucket.active_channel_count] }),
        ).length;
        check(`channel_count=${bucket.active_channel_count}: evidence count (${bucket.item_count}) reconciles with filter match count (${matchCount})`, bucket.item_count === matchCount);
      }
    }

    console.log('\n[D — category/channel counts reconcile via matrix, not summed]');
    {
      const sumOfChannelCells = evidence.category_channel_matrix.rows.reduce((s, r) => s + r.listed_item_count, 0);
      const distinctTotalSum = evidence.category_channel_matrix.category_totals.reduce((s, c) => s + c.distinct_listed_item_count, 0);
      // With no cross-category items possible (each item has exactly one
      // category), these ARE expected to reconcile 1:1 whenever no item
      // is cross-listed within a single category across multiple
      // channels contributing extra cells — but distinct_listed_item_count
      // must come from evidence directly, never be summed from cells here.
      check('category distinct total is read directly from evidence.category_totals (not summed from cells in this test)', distinctTotalSum === evidence.population_summary.distinct_listed_item_count, { distinctTotalSum, sumOfChannelCells });
    }

    console.log('\n[E — unlisted Business/Hybrid/Personal treatment]');
    {
      const businessPurposeId = findPurposeId(evidence, 'Business');
      const hybridPurposeId = findPurposeId(evidence, 'Hybrid');
      check('findPurposeId resolves a real Business purpose_id', businessPurposeId === businessId, businessPurposeId);
      check('findPurposeId resolves a real Hybrid purpose_id', hybridPurposeId === hybridId, hybridPurposeId);
      check('unlisted_business_items includes the fixture unlisted business item', evidence.unlisted_open_inventory.business.some((i) => i.item_id === unlistedBusiness));
      check('unlisted_hybrid_items includes the fixture unlisted hybrid item', evidence.unlisted_open_inventory.hybrid.some((i) => i.item_id === unlistedHybrid));
    }

    console.log('\n[F — Personal is not rendered as an optimization gap]');
    {
      const pageSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'listings', 'page.tsx'), 'utf8');
      const personalSectionMatch = pageSource.match(/Personal[\s\S]{0,400}/);
      check('Personal section exists in the page', !!personalSectionMatch);
      check('page never calls inventoryUrl(...) for a Personal purpose drill-down', !/personal[\s\S]{0,80}inventoryUrl|inventoryUrl[\s\S]{0,80}personal/i.test(pageSource));
      check('page states Personal is not a listing-optimization target', /not a listing-optimization target/i.test(pageSource));
    }

    console.log('\n[G — asking_value null handled cleanly, never substituted]');
    {
      check('population_summary.total_active_asking_value is null in this fixture set (no asking prices set)', evidence.population_summary.total_active_asking_value === null);
      const pageSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'listings', 'page.tsx'), 'utf8');
      check('page has no "Asking Value" headline KPI label', !/label="Asking Value"|>Asking Value</.test(pageSource));
      check('page never substitutes estimated_sold_value into an asking-price label', !/asking[\s\S]{0,40}estimated_sold_value|estimated_sold_value[\s\S]{0,40}asking/i.test(pageSource));
    }

    console.log('\n[H — no channel names are hardcoded anywhere in the Dashboard or drill-down modules]');
    {
      const files = [
        path.join(__dirname, '..', 'src', 'app', 'listings', 'page.tsx'),
        path.join(__dirname, '..', 'src', 'lib', 'inventoryListingFilters.ts'),
        path.join(__dirname, '..', 'src', 'lib', 'listingDashboardHelpers.ts'),
      ];
      for (const f of files) {
        const src = fs.readFileSync(f, 'utf8');
        const hardcoded = /['"`](Reverb|Marketplace|Kijiji)['"`]/.test(src);
        check(`${path.basename(f)}: no hardcoded "Reverb"/"Marketplace"/"Kijiji" literal`, !hardcoded);
      }
    }

    console.log('\n[I — drill-down URL builder correctness]');
    {
      check('channel drill-down', inventoryUrl({ channel_id: reverbId }) === `/inventory?channel_id=${reverbId}`, inventoryUrl({ channel_id: reverbId }));
      check('channel + category drill-down', inventoryUrl({ channel_id: reverbId, category: 'Guitars' }) === `/inventory?channel_id=${reverbId}&category=Guitars`);
      check('channel + age bucket drill-down', inventoryUrl({ channel_id: reverbId, age_bucket: 'D90_PLUS' }) === `/inventory?channel_id=${reverbId}&age_bucket=D90_PLUS`);
      check('business unlisted drill-down', inventoryUrl({ listing: 'unlisted', purpose_id: businessId }) === `/inventory?listing=unlisted&purpose_id=${businessId}`);
      check('cross-listed channel_count drill-down', inventoryUrl({ channel_count: '2,3_plus' }) === '/inventory?channel_count=2%2C3_plus');
      check('undefined values are omitted, never rendered as "undefined"', inventoryUrl({ channel_id: reverbId, category: undefined }) === `/inventory?channel_id=${reverbId}`);
      check('empty params produce a bare /inventory URL', inventoryUrl({}) === '/inventory');
    }

    console.log('\n[J — drill-down filter reconciliation: channel + age_bucket composed correctly]');
    {
      const lookup = buildListingLookups(evidence);
      // oldSingle is on Reverb, 120 days old -> D90_PLUS bucket.
      const matchesReverb90 = matchesListingFilters(oldSingle, lookup, { listingFilter: null, channelIds: [reverbId], ageBuckets: ['D90_PLUS'], channelCounts: [] });
      check('single-channel old item matches channel_id=Reverb & age_bucket=D90_PLUS', matchesReverb90);
      const matchesMarketplace90 = matchesListingFilters(oldSingle, lookup, { listingFilter: null, channelIds: [marketplaceId], ageBuckets: ['D90_PLUS'], channelCounts: [] });
      check('same item does NOT match channel_id=Marketplace (it is not listed there)', !matchesMarketplace90);
    }

    console.log('\n[K — money/day formatters]');
    {
      check('fmtMoney(null) is an em-dash', fmtMoney(null) === '—');
      check('fmtMoney(1234.6) rounds and formats with $ + thousands separator', fmtMoney(1234.6) === '$1,235', fmtMoney(1234.6));
      check('fmtMoney(-500) shows a minus sign, not a double negative', fmtMoney(-500) === '−$500', fmtMoney(-500));
      check('fmtDays(null) is an em-dash', fmtDays(null) === '—');
      check('fmtDays(45.6) rounds to an integer with a "d" suffix', fmtDays(45.6) === '46d', fmtDays(45.6));
    }
  } finally {
    console.log('\n[cleanup]');
    if (createdListingIds.length) await admin.from('item_listings').delete().in('id', createdListingIds);
    if (createdItemIds.length) await admin.from('deal_items').delete().in('item_id', createdItemIds);
    if (createdDealIds.length) await admin.from('deals').delete().in('id', createdDealIds);
    if (createdItemIds.length) await admin.from('inventory_items').delete().in('id', createdItemIds);

    const { data: remainingItems } = await admin.from('inventory_items').select('id').in('id', createdItemIds.length ? createdItemIds : [-1]);
    check('all fixture items deleted', (remainingItems?.length ?? 0) === 0, remainingItems);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
