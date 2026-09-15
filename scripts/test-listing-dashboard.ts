/**
 * test-listing-dashboard.ts
 *
 * Focused validation for the Listings + Demand Dashboard v1.0
 * (src/app/listings/page.tsx) and the Inventory drill-down filters it
 * links to (src/lib/inventoryListingFilters.ts, src/lib/
 * listingDashboardHelpers.ts, src/lib/listingDemandDashboardHelpers.ts) —
 * a follow-up to Listing Evidence v1.0 (commit aa884b2) and Listing Demand
 * Evidence v1.0/v1.1. Builds a small dedicated fixture pool (marker
 * `DASH:<key>`), fetches real Listing Evidence via the actual RPC, then
 * reconciles the Dashboard's data-layer helpers against it directly.
 * There is no component-rendering test framework in this project (see
 * every other scripts/test-*.ts), so this exercises the extracted pure
 * logic the page renders from, plus static source-scans for the "never
 * hardcode a channel name" / "Personal is never a drill-down target" /
 * "no Asking Value headline KPI while null" / "removed KPIs and sections
 * stay removed" / "Overview never depends on Trend Window" / "a Demand
 * Evidence failure never gates the Listing Evidence snapshot" structural
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
import { getListingDemandEvidence } from '../src/lib/analytics/listingDemandEvidence';
import {
  parseTrendWeeksParam,
  trendWeeksUrl,
  fmtWeekLabel,
  fmtRate,
  buildMarketActivityRows,
  buildChannelActivityRows,
} from '../src/lib/listingDemandDashboardHelpers';

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
        path.join(__dirname, '..', 'src', 'lib', 'listingDemandDashboardHelpers.ts'),
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

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== Listings + Demand Dashboard (Listing Demand Evidence UI) ===');

    const pageSourcePath = path.join(__dirname, '..', 'src', 'app', 'listings', 'page.tsx');
    const pageSource = fs.readFileSync(pageSourcePath, 'utf8');

    console.log('\n[L — Overview has exactly the four intended snapshot KPIs]');
    {
      const overviewMatch = pageSource.match(/function OverviewSection[\s\S]*?\n}\n/);
      check('OverviewSection function found in page.tsx', !!overviewMatch);
      const overviewSource = overviewMatch ? overviewMatch[0] : '';
      for (const label of ['Listed Items', 'Listed Cost Basis', 'Estimated Listed Value', 'Estimated Equity']) {
        check(`Overview renders the "${label}" KPI`, overviewSource.includes(`label="${label}"`), overviewSource.slice(0, 200));
      }
      check('OverviewSection renders exactly 4 StatTile calls', (overviewSource.match(/<StatTile/g) ?? []).length === 4, overviewSource.match(/<StatTile/g));
      // OverviewSection's own signature only accepts Listing Evidence — by
      // construction it cannot vary with Trend Window/Demand Evidence.
      check('OverviewSection only takes `evidence: ListingEvidence` as a prop (never demandEvidence/trendWeeks)', /function OverviewSection\(\{ evidence \}: \{ evidence: ListingEvidence \}\)/.test(pageSource));
    }

    console.log('\n[M — removed KPIs/sections no longer render anywhere on the page]');
    {
      check('no "Active Channel Listings" KPI anywhere in page.tsx', !pageSource.includes('Active Channel Listings'));
      check('no "Cross-listed Items" KPI anywhere in page.tsx', !pageSource.includes('Cross-listed Items'));
      check('no "Channel Coverage" section title anywhere in page.tsx', !pageSource.includes('Channel Coverage'));
      check('no "Category × Channel" section title anywhere in page.tsx', !pageSource.includes('Category × Channel'));
      check('the old CrossListingSection/CategoryChannelSection components are gone', !/function CrossListingSection|function CategoryChannelSection/.test(pageSource));
    }

    console.log('\n[N — Trend Window: URL parsing/fallback (pure)]');
    {
      check('no query param -> default 4', parseTrendWeeksParam(null) === 4);
      check('trend_weeks=4 -> 4', parseTrendWeeksParam('4') === 4);
      check('trend_weeks=8 -> 8', parseTrendWeeksParam('8') === 8);
      check('trend_weeks=12 -> 12', parseTrendWeeksParam('12') === 12);
      for (const invalid of ['0', '3', '6', '20', '-4', '4.5', 'abc', '']) {
        check(`trend_weeks=${JSON.stringify(invalid)} safely falls back to 4 (never clamped/rounded)`, parseTrendWeeksParam(invalid) === 4, parseTrendWeeksParam(invalid));
      }
      check('trendWeeksUrl(4) omits the param (default -> bare /listings)', trendWeeksUrl(4) === '/listings');
      check('trendWeeksUrl(8) -> /listings?trend_weeks=8', trendWeeksUrl(8) === '/listings?trend_weeks=8');
      check('trendWeeksUrl(12) -> /listings?trend_weeks=12', trendWeeksUrl(12) === '/listings?trend_weeks=12');
    }

    console.log('\n[O — Trend Window: exactly one page-level selector, wired to the URL]');
    {
      check('page.tsx has exactly one TrendWindowControl usage (rendered once)', (pageSource.match(/<TrendWindowControl/g) ?? []).length === 1);
      check('the selector default label reads "Trend Window"', /Trend Window/.test(pageSource));
      check('changing the selector calls router.replace(trendWeeksUrl(...)) — URL is the source of truth', /router\.replace\(trendWeeksUrl\(/.test(pageSource));
      check('no second 4/8/12 control exists inside Market/Channel Activity (only TREND_WEEKS_OPTIONS.map appears once)', (pageSource.match(/TREND_WEEKS_OPTIONS\.map/g) ?? []).length === 1);
      check('the Admin 7/30/90-day summary preset is not exposed on /listings', !/\b7 days\b|\b30 days\b|\b90 days\b/.test(pageSource));
    }

    console.log('\n[P — error isolation: a Demand Evidence failure never gates the Listing Evidence snapshot]');
    {
      // The snapshot render gate must depend on `evidence` only.
      check('the snapshot sections are gated on `{evidence && (` only', /\{evidence && \(/.test(pageSource));
      check('that gate never also requires demandEvidence/demandError to be truthy/falsy', !/\{evidence && demandEvidence|\{evidence && !demandError|\{!demandError && evidence/.test(pageSource));
      const snapshotGateMatch = pageSource.match(/\{evidence && \(([\s\S]*?)\n {6}\)\}/);
      check('OverviewSection is rendered inside that gate', !!snapshotGateMatch && /<OverviewSection/.test(snapshotGateMatch[1]));
      check('UnlistedSection is rendered inside that gate', !!snapshotGateMatch && /<UnlistedSection/.test(snapshotGateMatch[1]));
      // Market/Channel Activity take their OWN independent loading/error
      // props rather than being wrapped in a page-wide demand-error block.
      check('MarketActivitySection receives its own independent error prop', /<MarketActivitySection[\s\S]{0,120}error=\{demandError\}/.test(pageSource));
      check('ChannelActivitySection receives its own independent error prop', /<ChannelActivitySection[\s\S]{0,120}error=\{demandError\}/.test(pageSource));
    }

    console.log('\n[Q — Market Activity / Channel Activity pure row-mapping, real Demand Evidence]');
    {
      for (const trendWeeks of [4, 8, 12] as const) {
        const demandEvidence = await getListingDemandEvidence({ appUserId: userId, serviceClient: admin, startDate: daysAgo(6), endDate: daysAgo(0), trendWeeks });

        const marketRows = buildMarketActivityRows(demandEvidence.weekly_trend);
        check(`Q.${trendWeeks} Market Activity renders exactly one row per weekly_trend entry (${trendWeeks})`, marketRows.length === demandEvidence.weekly_trend.length && marketRows.length === trendWeeks, marketRows.length);
        for (let i = 0; i < marketRows.length; i++) {
          const row = marketRows[i];
          const w = demandEvidence.weekly_trend[i];
          check(`Q.${trendWeeks}.${i} avgListedItems === evidence.avg_listed_items (no recalculation)`, row.avgListedItems === w.avg_listed_items);
          check(`Q.${trendWeeks}.${i} avgChannelExposure === evidence.avg_channel_exposure`, row.avgChannelExposure === w.avg_channel_exposure);
          check(`Q.${trendWeeks}.${i} leadsStarted === evidence.leads_started`, row.leadsStarted === w.leads_started);
          check(`Q.${trendWeeks}.${i} seriousPlusLeads === evidence.serious_plus_leads_from_cohort`, row.seriousPlusLeads === w.serious_plus_leads_from_cohort);
          check(`Q.${trendWeeks}.${i} realizedDeals === evidence.realized_deal_count`, row.realizedDeals === w.realized_deal_count);
          check(`Q.${trendWeeks}.${i} leadsPer100ChannelDays === evidence.leads_per_100_channel_listing_days`, row.leadsPer100ChannelDays === w.leads_per_100_channel_listing_days);
          check(`Q.${trendWeeks}.${i} weekLabel === fmtWeekLabel(start,end)`, row.weekLabel === fmtWeekLabel(w.start_date, w.end_date));
        }
        // No conversion rate/funnel field anywhere in a market row.
        check(`Q.${trendWeeks} no market row contains a conversion/funnel-named key`, marketRows.every((row) => !Object.keys(row).some((k) => /conversion|funnel/i.test(k))));

        const channelRows = buildChannelActivityRows(demandEvidence);
        check(`Q.${trendWeeks} Channel Activity renders exactly one row per evidence.channels entry (dynamic, never hardcoded)`, channelRows.length === demandEvidence.channels.length);
        check(`Q.${trendWeeks} channel names come straight from evidence (Marketplace/Kijiji/Reverb present)`, ['Marketplace', 'Kijiji', 'Reverb'].every((n) => channelRows.some((r) => r.channelName === n)), channelRows.map((r) => r.channelName));
        for (const row of channelRows) {
          const channel = demandEvidence.channels.find((c) => c.deal_channel_id === row.dealChannelId)!;
          check(`Q.${trendWeeks}/${row.channelName} channelListingDays === current.channel_listing_days`, row.channelListingDays === channel.current.channel_listing_days);
          check(`Q.${trendWeeks}/${row.channelName} attributedLeads === current.channel_attributed_leads`, row.attributedLeads === channel.current.channel_attributed_leads);
          check(`Q.${trendWeeks}/${row.channelName} seriousPlusLeads === current.serious_plus_attributed_leads_from_cohort`, row.seriousPlusLeads === channel.current.serious_plus_attributed_leads_from_cohort);
          check(`Q.${trendWeeks}/${row.channelName} realizedDeals === current.realized_deal_count_by_recorded_channel`, row.realizedDeals === channel.current.realized_deal_count_by_recorded_channel);
          check(`Q.${trendWeeks}/${row.channelName} leadsPer100ChannelDays === current.leads_per_100_channel_listing_days`, row.leadsPer100ChannelDays === channel.current.leads_per_100_channel_listing_days);
          // Weekly channel trend follows the selected Trend Window exactly.
          check(`Q.${trendWeeks}/${row.channelName} weeklyTrend has exactly ${trendWeeks} points, matching weekly_trend length`, row.weeklyTrend.length === demandEvidence.weekly_trend.length && row.weeklyTrend.length === trendWeeks);
          for (let i = 0; i < row.weeklyTrend.length; i++) {
            const w = demandEvidence.weekly_trend[i];
            const wc = w.channels.find((c) => c.deal_channel_id === row.dealChannelId);
            check(`Q.${trendWeeks}/${row.channelName} week[${i}] leadsPer100ChannelDays matches weekly_trend[${i}].channels`, row.weeklyTrend[i].leadsPer100ChannelDays === (wc?.leads_per_100_channel_listing_days ?? null));
            check(`Q.${trendWeeks}/${row.channelName} week[${i}] dates match weekly_trend[${i}]`, row.weeklyTrend[i].startDate === w.start_date && row.weeklyTrend[i].endDate === w.end_date);
          }
        }
      }
    }

    console.log('\n[R — fmtRate / fmtWeekLabel formatting (pure)]');
    {
      check('fmtRate(null) is an em-dash', fmtRate(null) === '—');
      check('fmtRate(12.345) rounds to 1 decimal by default', fmtRate(12.345) === '12.3', fmtRate(12.345));
      check('fmtRate(0) is "0.0", never an em-dash (0 is a real, meaningful rate)', fmtRate(0) === '0.0');
      check('fmtWeekLabel is timezone-free (pure string parsing, no Date/local-tz shift)', fmtWeekLabel('2026-08-25', '2026-08-31') === 'Aug 25 – Aug 31', fmtWeekLabel('2026-08-25', '2026-08-31'));
    }

    console.log('\n[S — no interpretive/causal language anywhere in the Listings page]');
    {
      // Scan only what a user would actually see — strip source comments
      // first, since a comment explicitly DISCLAIMING a concept (e.g. "no
      // conversion rate exists here") is the opposite of the concept
      // appearing as rendered UI copy. Same lesson as the Listing Demand
      // Evidence limitations-prose false positive fixed earlier: distinguish
      // "the word appears in an explanatory sentence" from "it's live
      // wording a user would read."
      const renderedTextOnly = pageSource.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const forbidden = [/is better/i, /is bad/i, /is worse/i, /demand is increasing/i, /demand is decreasing/i, /caused/i, /conversion rate/i, /market demand score/i];
      for (const re of forbidden) {
        check(`rendered page copy contains no interpretive phrase matching ${re}`, !re.test(renderedTextOnly));
      }
      check('Market Activity help text clarifies Leads/Realized Deals are side-by-side, not a funnel', /side-by-side/i.test(renderedTextOnly) && /not (?:as )?a funnel/i.test(renderedTextOnly));
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
