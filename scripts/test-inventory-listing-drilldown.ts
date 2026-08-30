/**
 * scripts/test-inventory-listing-drilldown.ts
 *
 * Focused validation for the Listing Dashboard -> Inventory drill-down fix
 * and the new Inventory -> More Filters -> Listing controls
 * (src/app/inventory/page.tsx, src/lib/inventoryListingFilters.ts).
 *
 * ── ROOT CAUSE (confirmed via live instrumentation, fixed in this same
 * change) ──────────────────────────────────────────────────────────────
 * The evidence-fetch effect in src/app/inventory/page.tsx included its own
 * `listingEvidenceLoading` state in its dependency array. Setting that
 * state to true is itself a dependency change, so the effect immediately
 * re-ran; its cleanup marked the in-flight request's local `cancelled`
 * flag true; the ORIGINAL fetch's `.then()` then discarded a SUCCESSFUL
 * response because `cancelled` was already true. Every listing-oriented
 * drill-down (`?channel_id=`, `?listing=`, `?age_bucket=`,
 * `?channel_count=`) got permanently stuck on "Loading listing filters..."
 * — the Inventory list never rendered filtered results at all. A second,
 * related but self-correcting bug (a `router.replace()` firing once with
 * stale/default filter values in the same effect-flush as URL
 * initialization) is also fixed here — see the `readyForUrlSync` state
 * gate in page.tsx.
 *
 * No React rendering framework exists in this project (see every other
 * scripts/test-*.ts) — Section A below is a static source-scan regression
 * guard for both fixes (encodes "never reintroduce this exact bug shape"
 * directly into the file that had it), matching this project's own
 * established convention (see test-listing-dashboard.ts's Section
 * H "no hardcoded channel name" source-scan). Sections B+ exercise the
 * real pure filter logic (buildListingLookups/matchesListingFilters) and
 * the real category/status data against a dedicated fixture pool and a
 * real build_listing_evidence_v1_0 RPC call — never a synthetic evidence
 * object — so drill-down counts are reconciled against genuine DB state,
 * the same way the Dashboard and Inventory pages themselves would see it.
 *
 * Usage:
 *   npx tsx scripts/test-inventory-listing-drilldown.ts
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
import { buildListingLookups, matchesListingFilters, hasAnyListingFilter } from '../src/lib/inventoryListingFilters';
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
  const { data, error } = await admin.from('brands').insert({ name }).select('id').single();
  if (error) throw new Error(`Failed to create brand "${name}": ${error.message}`);
  return data.id as number;
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
    model: spec.model, status: 'owned', estimated_sold_value: spec.estimatedSoldValue ?? null, serial_number: `INVFILT:${key}`,
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

// Mirrors the Inventory page's own default-status + category predicates
// exactly (src/app/inventory/page.tsx's filteredItems useMemo) — pure
// replicas, not imports, since that logic lives inline in a 'use client'
// page component this project's conventions never render in tests (see
// every other scripts/test-*.ts). Kept intentionally tiny and inlined
// here so a mismatch with the real page is easy to spot on review.
function matchesDefaultStatus(status: string, selectedStatuses: string[]): boolean {
  return selectedStatuses.length === 0 || selectedStatuses.includes(status);
}
function matchesCategory(itemCategoryName: string, selectedCategoryNames: string[]): boolean {
  return selectedCategoryNames.length === 0 || selectedCategoryNames.includes(itemCategoryName);
}

async function main() {
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ══════════════════════════════════════════════════════════════════════
  // Section A — source-level regression guards (no DB, no network)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[A — regression guards for the confirmed bugs]');
  const pageSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'inventory', 'page.tsx'), 'utf8');

  {
    // The exact bug: listingEvidenceLoading (or listingEvidenceError, which
    // would carry the identical self-cancel risk) present in the
    // evidence-fetch effect's own dependency array.
    const effectMatch = pageSource.match(/setListingEvidenceLoading\(true\)[\s\S]*?\}, \[([^\]]*)\]\);\s*\/\/ eslint-disable-line react-hooks\/exhaustive-deps/);
    check('evidence-fetch effect block found in source', !!effectMatch, 'could not locate the effect — source may have moved');
    const depsText = effectMatch?.[1] ?? '';
    check('evidence-fetch effect dependency array does NOT include listingEvidenceLoading (the confirmed self-cancel bug)', !/\blistingEvidenceLoading\b/.test(depsText), depsText);
    check('evidence-fetch effect still depends on hasAnyListingFilterActive', /\bhasAnyListingFilterActive\b/.test(depsText), depsText);
    check('evidence-fetch effect still depends on listingEvidence (so it never re-fetches once loaded)', /\blistingEvidence\b/.test(depsText), depsText);
  }

  {
    // The second bug: the write-to-URL effect gating on the ref directly
    // (isInitializedRef.current) instead of a real state value that only
    // becomes true on the render AFTER initialization actually committed.
    check('write-to-URL effect gates on readyForUrlSync state (not the ref directly)', /if \(!readyForUrlSync\) return;/.test(pageSource), 'stale-closure URL race regression');
    check('readyForUrlSync is set inside the init-from-URL effect, alongside isInitializedRef', /isInitializedRef\.current = true;\s*setReadyForUrlSync\(true\);/.test(pageSource));
    check('the write-to-URL effect\'s own dependency array includes readyForUrlSync', /\[readyForUrlSync, search, selectedStatuses/.test(pageSource));
  }

  {
    // Listing filters must never be a second independent React-only state
    // — clearFilters (Clear Filters button) must clear them exactly like
    // every other filter.
    const clearFn = pageSource.match(/function clearFilters\(\)\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? '';
    check('Clear Filters clears listingFilter', /setListingFilter\(null\)/.test(clearFn));
    check('Clear Filters clears selectedChannelIds', /setSelectedChannelIds\(\[\]\)/.test(clearFn));
    check('Clear Filters clears selectedAgeBuckets', /setSelectedAgeBuckets\(\[\]\)/.test(clearFn));
    check('Clear Filters clears selectedChannelCounts', /setSelectedChannelCounts\(\[\]\)/.test(clearFn));
  }

  {
    // Unlisted <-> Channel/Age/ChannelCount conflict clearing (task's own
    // "clear the conflicting control rather than silently return
    // misleading results" requirement).
    const statusFn = pageSource.match(/function selectListingStatus\([\s\S]*?\n\s*\}/)?.[0] ?? '';
    check('selecting Unlisted clears Channel/Age/ChannelCount', /value === 'unlisted'[\s\S]*setSelectedChannelIds\(\[\]\)[\s\S]*setSelectedAgeBuckets\(\[\]\)[\s\S]*setSelectedChannelCounts\(\[\]\)/.test(statusFn), statusFn);
    check('toggling a Channel clears Unlisted', /function toggleListingChannel[\s\S]*?listingFilter === 'unlisted'[\s\S]*?setListingFilter\(null\)/.test(pageSource));
    check('toggling an Age bucket clears Unlisted', /function toggleListingAgeBucket[\s\S]*?listingFilter === 'unlisted'[\s\S]*?setListingFilter\(null\)/.test(pageSource));
    check('toggling a Channel Count clears Unlisted', /function toggleListingChannelCount[\s\S]*?listingFilter === 'unlisted'[\s\S]*?setListingFilter\(null\)/.test(pageSource));
  }

  {
    // Dynamic channel list — never a hardcoded channel name, sourced from
    // Listing Evidence's own channel_summary (mirrors test-listing-
    // dashboard.ts's own "no hardcoded channel name" convention, extended
    // to this page).
    check('Listing Channel options are derived from listingEvidence.channel_summary, not hardcoded', /listingChannelOptions[\s\S]{0,200}listingEvidence\.channel_summary\.map/.test(pageSource));
    check('inventory page.tsx has no hardcoded "Reverb"/"Marketplace"/"Kijiji" literal', !/['"`](Reverb|Marketplace|Kijiji)['"`]/.test(pageSource));
  }

  {
    // Mobile-safe structure — same flex-wrap pill pattern already used by
    // every other filter group in this file (Status/Category/Purpose).
    const listingBlock = pageSource.match(/\{\/\* Listing \(Listing Evidence v1\.0[\s\S]*?<\/div>\s*<\/div>\s*<\/MoreFiltersToggle>/)?.[0] ?? '';
    check('Listing section block found in source', listingBlock.length > 0);
    check('Listing section uses flex-wrap pill rows (no fixed-width/overflow layout)', (listingBlock.match(/flex flex-wrap gap-2/g)?.length ?? 0) >= 3, listingBlock.length);
  }

  {
    // Multi-channel combinations must never imply exact filtering they
    // cannot deliver (task section 6) — already correct pre-existing
    // behavior in src/app/listings/page.tsx, guarded here so it can never
    // silently regress.
    const listingsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'listings', 'page.tsx'), 'utf8');
    check('a multi-channel combination row renders as non-clickable (plain <span>, not a Link)', /combo\.channel_ids\.length === 1 \? \(\s*<Link/.test(listingsSource));
    check('the Dashboard states exact multi-channel drill-down isn\'t supported', /Exact multi-channel combination drill-down isn(&apos;|')t supported yet/.test(listingsSource));
  }

  // ══════════════════════════════════════════════════════════════════════
  // Section B — real-data drill-down reconciliation
  // ══════════════════════════════════════════════════════════════════════
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const EMAIL = 'inventory-listing-drilldown-fixture@example.test';
  const { data: authUsers } = await admin.auth.admin.listUsers();
  let authUserId = authUsers?.users.find((u) => u.email === EMAIL)?.id ?? null;
  if (!authUserId) {
    const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: 'Inventory-Listing-Fixture-Local-Only-1!', email_confirm: true });
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

  const brandId = await ensureBrand(admin, 'InvFilt-Brand');
  const guitarSubtypeId = await subtypeId(admin, 'Guitars', 'Electric Guitar');
  const ampSubtypeId = await subtypeId(admin, 'Amps', 'Amp');
  const businessId = await purposeId(admin, 'Business');
  const hybridId = await purposeId(admin, 'Hybrid');
  const marketplaceId = await channelId(admin, 'Marketplace');
  const reverbId = await channelId(admin, 'Reverb');

  const createdItemIds: number[] = [];
  const createdDealIds: number[] = [];
  const createdListingIds: number[] = [];

  try {
    // reverbOld — Reverb only, 90+ days old (guitar, Business).
    const reverbOld = await insertItem(admin, 'reverb-old', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Reverb Old Guitar', estimatedSoldValue: 800 }, createdItemIds);
    await acquireItem(admin, userId, reverbOld, 'purchase', daysAgo(200), 500, createdDealIds);
    await insertListing(admin, userId, reverbOld, reverbId, daysAgo(120), null, createdListingIds);

    // crossFresh — Marketplace (fresh, <14d) AND Reverb (90+d) — the exact
    // "same item, different channels, different ages" scenario the task's
    // own channel+age coupling rule exists to prevent a false match on.
    const crossFresh = await insertItem(admin, 'cross-fresh', { userId, brandId, subtypeId: ampSubtypeId, purposeId: businessId, model: 'Cross Fresh Amp', estimatedSoldValue: 1500 }, createdItemIds);
    await acquireItem(admin, userId, crossFresh, 'purchase', daysAgo(150), 900, createdDealIds);
    await insertListing(admin, userId, crossFresh, marketplaceId, daysAgo(5), null, createdListingIds);
    await insertListing(admin, userId, crossFresh, reverbId, daysAgo(120), null, createdListingIds);

    // marketplaceGuitar — Marketplace only, fresh (guitar, Business) — for
    // the Channel + Category reconciliation scenario.
    const marketplaceGuitar = await insertItem(admin, 'marketplace-guitar', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Marketplace Fresh Guitar', estimatedSoldValue: 700 }, createdItemIds);
    await acquireItem(admin, userId, marketplaceGuitar, 'purchase', daysAgo(30), 400, createdDealIds);
    await insertListing(admin, userId, marketplaceGuitar, marketplaceId, daysAgo(3), null, createdListingIds);

    // unlistedBusiness / unlistedHybrid — open, zero active listings.
    const unlistedBusiness = await insertItem(admin, 'unlisted-business', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Unlisted Business Guitar', estimatedSoldValue: 600 }, createdItemIds);
    await acquireItem(admin, userId, unlistedBusiness, 'purchase', daysAgo(25), 350, createdDealIds);
    const unlistedHybrid = await insertItem(admin, 'unlisted-hybrid', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: hybridId, model: 'Unlisted Hybrid Guitar', estimatedSoldValue: 1100 }, createdItemIds);
    await acquireItem(admin, userId, unlistedHybrid, 'purchase', daysAgo(150), 700, createdDealIds);

    const { data: rawEvidence, error: rpcError } = await admin.rpc('build_listing_evidence_v1_0', { p_target_user_id: userId });
    if (rpcError || !rawEvidence) throw new Error(`build_listing_evidence_v1_0 failed: ${rpcError?.message}`);
    const evidence = rawEvidence as ListingEvidence;
    const lookup = buildListingLookups(evidence);

    // Real current inventory_items.status + category, exactly as the
    // Inventory page itself would read them (the item_listings_sync_
    // inventory_status trigger already promoted listed items to
    // status='listed' by the time we query here).
    const { data: dbItems, error: itemsError } = await admin
      .from('inventory_items')
      .select('id, status, item_subtype_id')
      .in('id', createdItemIds);
    if (itemsError || !dbItems) throw new Error(`Failed to read fixture item statuses: ${itemsError?.message}`);
    const { data: subtypeRows } = await admin.from('item_subtypes').select('id, category_id').in('id', [guitarSubtypeId, ampSubtypeId]);
    const { data: categoryRows } = await admin.from('item_categories').select('id, name').in('id', (subtypeRows ?? []).map((s) => s.category_id));
    const categoryNameBySubtypeId = new Map<number, string>((subtypeRows ?? []).map((s) => [s.id as number, (categoryRows ?? []).find((c) => c.id === s.category_id)?.name as string]));
    const categoryByItemId = new Map(dbItems.map((i) => [i.id as number, categoryNameBySubtypeId.get(i.item_subtype_id as number) ?? '']));
    const statusByItemId = new Map(dbItems.map((i) => [i.id as number, i.status as string]));

    const DEFAULT_STATUSES = ['owned', 'listed'];

    console.log('\n[B — Channel drill-down count matches Listing Dashboard]');
    {
      const reverbCard = evidence.channel_summary.find((c) => c.channel_id === reverbId);
      check('Reverb channel card exists in evidence', !!reverbCard);
      const inventoryPageCount = createdItemIds.filter((id) =>
        matchesDefaultStatus(statusByItemId.get(id)!, DEFAULT_STATUSES) &&
        matchesListingFilters(id, lookup, { listingFilter: null, channelIds: [reverbId], ageBuckets: [], channelCounts: [] }),
      ).length;
      check(`Inventory's own combined (status default + channel) count (${inventoryPageCount}) matches Listing Dashboard's Reverb card count (${reverbCard?.listed_item_count})`, inventoryPageCount === reverbCard?.listed_item_count, { inventoryPageCount, cardCount: reverbCard?.listed_item_count });
      check('the two Reverb-listed fixture items (reverbOld, crossFresh) are both present under channel_id=Reverb', matchesListingFilters(reverbOld, lookup, { listingFilter: null, channelIds: [reverbId], ageBuckets: [], channelCounts: [] }) && matchesListingFilters(crossFresh, lookup, { listingFilter: null, channelIds: [reverbId], ageBuckets: [], channelCounts: [] }));
    }

    console.log('\n[C — Channel + Category]');
    {
      const inventoryPageResult = createdItemIds.filter((id) =>
        matchesDefaultStatus(statusByItemId.get(id)!, DEFAULT_STATUSES) &&
        matchesCategory(categoryByItemId.get(id)!, ['Guitars']) &&
        matchesListingFilters(id, lookup, { listingFilter: null, channelIds: [reverbId], ageBuckets: [], channelCounts: [] }),
      );
      check('channel_id=Reverb & category=Guitars returns exactly reverbOld (crossFresh is an Amp, excluded by category)', inventoryPageResult.length === 1 && inventoryPageResult[0] === reverbOld, inventoryPageResult);
    }

    console.log('\n[D — Channel + Listing Age applies to the SAME channel]');
    {
      // crossFresh is Marketplace(fresh) + Reverb(90+d). channel_id=
      // Marketplace & age_bucket=D90_PLUS must NOT match it (Marketplace's
      // own listing is fresh — the 90+ age belongs to the OTHER channel).
      const marketplaceFreshMatches90Plus = matchesListingFilters(crossFresh, lookup, { listingFilter: null, channelIds: [marketplaceId], ageBuckets: ['D90_PLUS'], channelCounts: [] });
      check('an item is NOT matched by channel+age when the age belongs to a DIFFERENT channel than the one selected (Marketplace fresh, Reverb 90+, filtering Marketplace&90+)', !marketplaceFreshMatches90Plus);
      const marketplaceMatchesFresh = matchesListingFilters(crossFresh, lookup, { listingFilter: null, channelIds: [marketplaceId], ageBuckets: ['LT_14'], channelCounts: [] });
      check('the same item DOES match channel+age when both apply to the SAME channel (Marketplace & <14d)', marketplaceMatchesFresh);
      const reverbMatches90Plus = matchesListingFilters(crossFresh, lookup, { listingFilter: null, channelIds: [reverbId], ageBuckets: ['D90_PLUS'], channelCounts: [] });
      check('the same item DOES match Reverb & 90+d (that pairing is real for this item)', reverbMatches90Plus);
    }

    console.log('\n[E — Business + Unlisted]');
    {
      const businessUnlistedIds = createdItemIds.filter((id) =>
        matchesDefaultStatus(statusByItemId.get(id)!, DEFAULT_STATUSES) &&
        matchesListingFilters(id, lookup, { listingFilter: 'unlisted', channelIds: [], ageBuckets: [], channelCounts: [] }),
      );
      const businessUnlistedEvidenceCount = evidence.population_summary.unlisted_item_count_by_purpose.find((p) => p.purpose_bucket === 'business')?.item_count ?? -1;
      check('listing=unlisted matches exactly unlistedBusiness + unlistedHybrid (never a listed item)', businessUnlistedIds.length === 2 && businessUnlistedIds.includes(unlistedBusiness) && businessUnlistedIds.includes(unlistedHybrid), businessUnlistedIds);
      check('unlisted_item_count_by_purpose.business is >= 1 (the fixture unlisted business item counted)', businessUnlistedEvidenceCount >= 1, businessUnlistedEvidenceCount);
      const unlistedNeverMatchesChannel = matchesListingFilters(unlistedBusiness, lookup, { listingFilter: null, channelIds: [reverbId], ageBuckets: [], channelCounts: [] });
      check('an unlisted item never matches ANY channel filter (it has no active listing to be on that channel)', !unlistedNeverMatchesChannel);
    }

    console.log('\n[F — Active Channel Count]');
    {
      const twoChannelIds = createdItemIds.filter((id) => matchesListingFilters(id, lookup, { listingFilter: null, channelIds: [], ageBuckets: [], channelCounts: ['2'] }));
      check('channel_count=2 matches exactly crossFresh (the only 2-channel item)', twoChannelIds.length === 1 && twoChannelIds[0] === crossFresh, twoChannelIds);
      const oneChannelIds = createdItemIds.filter((id) => matchesListingFilters(id, lookup, { listingFilter: null, channelIds: [], ageBuckets: [], channelCounts: ['1'] }));
      check('channel_count=1 matches reverbOld and marketplaceGuitar (both single-channel)', oneChannelIds.length === 2 && oneChannelIds.includes(reverbOld) && oneChannelIds.includes(marketplaceGuitar), oneChannelIds);
    }

    console.log('\n[G — dynamic channel list, never hardcoded]');
    {
      const evidenceChannelNames = new Set(evidence.channel_summary.map((c) => c.channel_name));
      check('evidence.channel_summary contains the real channel names used by this fixture (Marketplace, Reverb) — the UI\'s Listing Channel list is sourced from exactly this array', evidenceChannelNames.has('Marketplace') && evidenceChannelNames.has('Reverb'), Array.from(evidenceChannelNames));
    }

    console.log('\n[H — existing non-listing filters still compose correctly]');
    {
      // Category alone (no listing filter at all) — hasAnyListingFilter
      // must be false, and the category predicate alone still isolates
      // the right items, proving Listing filters never leak into or block
      // unrelated filter combinations.
      const noListingFilterActive = !hasAnyListingFilter({ listingFilter: null, channelIds: [], ageBuckets: [], channelCounts: [] });
      check('hasAnyListingFilter is false when nothing listing-related is selected', noListingFilterActive);
      const categoryOnly = createdItemIds.filter((id) => matchesDefaultStatus(statusByItemId.get(id)!, DEFAULT_STATUSES) && matchesCategory(categoryByItemId.get(id)!, ['Amps']));
      check('category=Amps alone (no listing filter) matches exactly crossFresh', categoryOnly.length === 1 && categoryOnly[0] === crossFresh, categoryOnly);
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
