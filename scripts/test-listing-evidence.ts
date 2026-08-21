/**
 * test-listing-evidence.ts
 *
 * Focused validation for Listing Evidence v1.0
 * (supabase/migrations/20260904000000_build_listing_evidence_v1_0.sql,
 * src/lib/analytics/listingEvidence.ts). Same conventions as the other
 * scripts in this directory — tsx, no test framework, local check(),
 * safety-gated against a disposable local Supabase instance only.
 *
 * Builds a dedicated set of fixtures (marked via serial_number
 * `LISTEV:<key>`, isolated from scripts/setup-analytics-test-fixtures.ts'
 * own fixtures) covering every scenario from this task's Part 13: single-
 * channel, three-channel cross-listing, multiple items on one channel, an
 * ended listing, a cancelled listing, a relisted item (prior ended cycle +
 * new active cycle), a draft (no listed_at) row, Business/Hybrid/Personal
 * unlisted items, a listed Personal item, a historical-import item, missing
 * estimated_sold_value, missing asking_price, and expenses folded into cost
 * basis. Every row created is deleted and the deletion verified before the
 * script exits.
 *
 * Usage:
 *   npx tsx scripts/test-listing-evidence.ts
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl,
  assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';

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

// ── Fixture builders — direct table writes, service role. The
// create_*_operation RPCs rely on get_app_user_id()/auth.uid() session
// context a service-role connection doesn't have, so user_id is always set
// explicitly (same pattern as scripts/setup-analytics-test-fixtures.ts). ──

async function ensureBrand(admin: SupabaseClient, name: string): Promise<number> {
  const { data: existing } = await admin.from('brands').select('id').eq('name', name).maybeSingle();
  if (existing) return existing.id as number;
  const { data: created, error } = await admin.from('brands').insert({ name }).select('id').single();
  if (error) throw new Error(`Failed to create brand "${name}": ${error.message}`);
  return created.id as number;
}

async function subtypeId(admin: SupabaseClient, categoryName: string, subtypeName: string): Promise<number> {
  const { data: category, error: categoryError } = await admin
    .from('item_categories').select('id').eq('name', categoryName).maybeSingle();
  if (categoryError || !category) throw new Error(`Category "${categoryName}" not found: ${categoryError?.message ?? 'no row'}`);
  const { data, error } = await admin
    .from('item_subtypes').select('id').eq('category_id', category.id).eq('name', subtypeName).maybeSingle();
  if (error || !data) throw new Error(`Subtype "${categoryName}/${subtypeName}" not found: ${error?.message ?? 'no row'}`);
  return data.id as number;
}

async function purposeId(admin: SupabaseClient, name: string): Promise<number> {
  const { data, error } = await admin.from('item_purposes').select('id').ilike('name', name).maybeSingle();
  if (error || !data) throw new Error(`Purpose "${name}" not found: ${error?.message ?? 'no row'}`);
  return data.id as number;
}

async function channelId(admin: SupabaseClient, name: string): Promise<number> {
  const { data, error } = await admin.from('deal_channels').select('id').eq('name', name).maybeSingle();
  if (error || !data) throw new Error(`Deal channel "${name}" not found: ${error?.message ?? 'no row'}`);
  return data.id as number;
}

interface ItemSpec {
  userId: number;
  brandId: number;
  subtypeId: number;
  purposeId: number;
  model: string;
  estimatedSoldValue?: number | null;
}

async function insertItem(admin: SupabaseClient, key: string, spec: ItemSpec, createdItemIds: number[]): Promise<number> {
  const { data, error } = await admin
    .from('inventory_items')
    .insert({
      user_id: spec.userId,
      brand_id: spec.brandId,
      item_subtype_id: spec.subtypeId,
      purpose_id: spec.purposeId,
      model: spec.model,
      status: 'owned',
      estimated_sold_value: spec.estimatedSoldValue ?? null,
      serial_number: `LISTEV:${key}`,
    })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to insert item "${key}" (${spec.model}): ${error.message}`);
  createdItemIds.push(data.id as number);
  return data.id as number;
}

async function acquireItem(
  admin: SupabaseClient,
  userId: number,
  itemId: number,
  dealType: string,
  acquisitionDate: string,
  value: number,
  createdDealIds: number[],
): Promise<void> {
  const { data: deal, error: dealError } = await admin
    .from('deals')
    .insert({ user_id: userId, deal_type: dealType, deal_date: acquisitionDate, deal_channel_id: null })
    .select('id')
    .single();
  if (dealError) throw new Error(`Failed to insert acquisition deal for item ${itemId}: ${dealError.message}`);
  createdDealIds.push(deal.id as number);

  const { error: itemError } = await admin
    .from('deal_items')
    .insert({ user_id: userId, deal_id: deal.id, item_id: itemId, direction: 'in', total_value: value });
  if (itemError) throw new Error(`Failed to insert acquisition deal_item for item ${itemId}: ${itemError.message}`);
}

async function insertListing(
  admin: SupabaseClient,
  userId: number,
  itemId: number,
  chId: number,
  status: 'draft' | 'active' | 'ended' | 'cancelled',
  listedAt: string | null,
  endedAt: string | null,
  askingPrice: number | null,
  createdListingIds: number[],
): Promise<number> {
  const { data, error } = await admin
    .from('item_listings')
    .insert({
      user_id: userId,
      inventory_item_id: itemId,
      deal_channel_id: chId,
      status,
      listed_at: listedAt,
      ended_at: endedAt,
      cancelled_at: status === 'cancelled' ? new Date().toISOString() : null,
      asking_price: askingPrice,
      is_ai_generated: false,
    })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to insert listing (item=${itemId}, channel=${chId}, status=${status}): ${error.message}`);
  createdListingIds.push(data.id as number);
  return data.id as number;
}

async function insertExpense(
  admin: SupabaseClient,
  userId: number,
  itemId: number,
  amount: number,
  createdExpenseIds: number[],
): Promise<void> {
  const { data, error } = await admin
    .from('inventory_expenses')
    .insert({ user_id: userId, item_id: itemId, expense_date: daysAgo(10), amount, notes: 'Listing Evidence test expense' })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to insert expense for item ${itemId}: ${error.message}`);
  createdExpenseIds.push(data.id as number);
}

// ── Types (loose — this is a test script, not the type source of truth) ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function findListed(evidence: Json, itemId: number): Json | undefined {
  return (evidence.listed_items as Json[]).find((r) => r.item_id === itemId);
}
function findUnlisted(evidence: Json, bucket: 'business' | 'hybrid' | 'unclassified', itemId: number): Json | undefined {
  return (evidence.unlisted_open_inventory[bucket] as Json[]).find((r) => r.item_id === itemId);
}

async function main() {
  // ── Safety gate ───────────────────────────────────────────────────────────
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const EMAIL = 'listing-evidence-fixture@example.test';
  const { data: authUsers } = await admin.auth.admin.listUsers();
  let authUserId = authUsers?.users.find((u) => u.email === EMAIL)?.id ?? null;
  if (!authUserId) {
    const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: 'Listing-Evidence-Fixture-Local-Only-1!', email_confirm: true });
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

  const brandId = await ensureBrand(admin, 'ListingEvidence-Test-Brand');
  const guitarSubtypeId = await subtypeId(admin, 'Guitars', 'Electric Guitar');
  const ampSubtypeId = await subtypeId(admin, 'Amps', 'Amp');
  const businessId = await purposeId(admin, 'Business');
  const hybridId = await purposeId(admin, 'Hybrid');
  const personalId = await purposeId(admin, 'Personal');
  const marketplaceId = await channelId(admin, 'Marketplace');
  const kijijiId = await channelId(admin, 'Kijiji');
  const reverbId = await channelId(admin, 'Reverb');
  const nonListingChannelId = await channelId(admin, 'Regular Buyer / Seller');

  const createdItemIds: number[] = [];
  const createdDealIds: number[] = [];
  const createdListingIds: number[] = [];
  const createdExpenseIds: number[] = [];

  try {
    // Clean up any leftover rows from a prior aborted run of this same script.
    const { data: leftover } = await admin.from('inventory_items').select('id').like('serial_number', 'LISTEV:%');
    if (leftover && leftover.length > 0) {
      const ids = leftover.map((r) => r.id as number);
      await admin.from('item_listings').delete().in('inventory_item_id', ids);
      await admin.from('inventory_expenses').delete().in('item_id', ids);
      const { data: dealRows } = await admin.from('deal_items').select('deal_id').in('item_id', ids);
      await admin.from('deal_items').delete().in('item_id', ids);
      if (dealRows) await admin.from('deals').delete().in('id', dealRows.map((r) => r.deal_id as number));
      await admin.from('inventory_items').delete().in('id', ids);
      console.log(`[cleanup] removed ${ids.length} leftover fixture item(s) from a prior run`);
    }

    // ══════════════════════════════════════════════════════════════════
    // Build fixtures
    // ══════════════════════════════════════════════════════════════════

    // 1) One item on one channel (Business).
    const oneChannelItem = await insertItem(admin, 'one-channel', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'One-Channel Guitar', estimatedSoldValue: 900 }, createdItemIds);
    await acquireItem(admin, userId, oneChannelItem, 'purchase', daysAgo(60), 500, createdDealIds);
    await insertListing(admin, userId, oneChannelItem, marketplaceId, 'active', daysAgo(20), null, 850, createdListingIds);

    // 2) One item on three channels (cross-listed, Business).
    const threeChannelItem = await insertItem(admin, 'three-channel', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Three-Channel Guitar', estimatedSoldValue: 2000 }, createdItemIds);
    await acquireItem(admin, userId, threeChannelItem, 'purchase', daysAgo(90), 1200, createdDealIds);
    await insertListing(admin, userId, threeChannelItem, marketplaceId, 'active', daysAgo(10), null, 1800, createdListingIds);
    await insertListing(admin, userId, threeChannelItem, kijijiId, 'active', daysAgo(9), null, 1800, createdListingIds);
    await insertListing(admin, userId, threeChannelItem, reverbId, 'active', daysAgo(8), null, 1850, createdListingIds);

    // 3) A second item also on Marketplace (multiple items, same channel).
    const secondMarketplaceItem = await insertItem(admin, 'second-marketplace', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Second Marketplace Guitar', estimatedSoldValue: 700 }, createdItemIds);
    await acquireItem(admin, userId, secondMarketplaceItem, 'purchase', daysAgo(40), 400, createdDealIds);
    await insertListing(admin, userId, secondMarketplaceItem, marketplaceId, 'active', daysAgo(5), null, 650, createdListingIds);

    // 4) Ended listing only — no active listing, so it's unlisted.
    const endedOnlyItem = await insertItem(admin, 'ended-only', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Ended-Only Guitar', estimatedSoldValue: 600 }, createdItemIds);
    await acquireItem(admin, userId, endedOnlyItem, 'purchase', daysAgo(80), 300, createdDealIds);
    await insertListing(admin, userId, endedOnlyItem, marketplaceId, 'ended', daysAgo(70), daysAgo(50), 550, createdListingIds);

    // 5) Cancelled listing only — no active listing, so it's unlisted.
    const cancelledOnlyItem = await insertItem(admin, 'cancelled-only', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Cancelled-Only Guitar', estimatedSoldValue: 500 }, createdItemIds);
    await acquireItem(admin, userId, cancelledOnlyItem, 'purchase', daysAgo(30), 250, createdDealIds);
    await insertListing(admin, userId, cancelledOnlyItem, kijijiId, 'cancelled', null, null, null, createdListingIds);

    // 6) Relisted item — one prior ended cycle on Kijiji, one current active
    // cycle on Kijiji.
    const relistedItem = await insertItem(admin, 'relisted', { userId, brandId, subtypeId: ampSubtypeId, purposeId: businessId, model: 'Relisted Amp', estimatedSoldValue: 1200 }, createdItemIds);
    await acquireItem(admin, userId, relistedItem, 'purchase', daysAgo(100), 700, createdDealIds);
    await insertListing(admin, userId, relistedItem, kijijiId, 'ended', daysAgo(90), daysAgo(60), 1000, createdListingIds);
    await insertListing(admin, userId, relistedItem, kijijiId, 'active', daysAgo(15), null, 1100, createdListingIds);

    // 7) Draft row (no listed_at) — must never count as active/listed.
    const draftItem = await insertItem(admin, 'draft-only', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Draft-Only Guitar', estimatedSoldValue: 400 }, createdItemIds);
    await acquireItem(admin, userId, draftItem, 'purchase', daysAgo(20), 200, createdDealIds);
    await insertListing(admin, userId, draftItem, marketplaceId, 'draft', null, null, null, createdListingIds);

    // 8) Listing on a non-listing-capable channel must never surface as an
    // active listing exposure (data model proof, not just naming).
    const nonListingChannelItem = await insertItem(admin, 'non-listing-channel', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Non-Listing-Channel Guitar', estimatedSoldValue: 300 }, createdItemIds);
    await acquireItem(admin, userId, nonListingChannelItem, 'purchase', daysAgo(15), 150, createdDealIds);
    // Directly insert bypassing app-level channel validation, since this
    // scenario tests that the evidence function itself gates on
    // is_listing_platform rather than trusting the caller.
    await insertListing(admin, userId, nonListingChannelItem, nonListingChannelId, 'active', daysAgo(5), null, null, createdListingIds);

    // 9) Business unlisted.
    const businessUnlisted = await insertItem(admin, 'business-unlisted', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Business Unlisted Guitar', estimatedSoldValue: 800 }, createdItemIds);
    await acquireItem(admin, userId, businessUnlisted, 'purchase', daysAgo(25), 450, createdDealIds);

    // 10) Hybrid unlisted.
    const hybridUnlisted = await insertItem(admin, 'hybrid-unlisted', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: hybridId, model: 'Hybrid Unlisted Guitar', estimatedSoldValue: 1500 }, createdItemIds);
    await acquireItem(admin, userId, hybridUnlisted, 'purchase', daysAgo(200), 900, createdDealIds);

    // 11) Personal unlisted.
    const personalUnlisted = await insertItem(admin, 'personal-unlisted', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: personalId, model: 'Personal Unlisted Guitar', estimatedSoldValue: null }, createdItemIds);
    await acquireItem(admin, userId, personalUnlisted, 'purchase', daysAgo(300), 300, createdDealIds);

    // 12) Listed Personal item — factual current-listing evidence, but not a
    // candidate.
    const personalListed = await insertItem(admin, 'personal-listed', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: personalId, model: 'Personal Listed Guitar', estimatedSoldValue: 1000 }, createdItemIds);
    await acquireItem(admin, userId, personalListed, 'purchase', daysAgo(50), 600, createdDealIds);
    await insertListing(admin, userId, personalListed, marketplaceId, 'active', daysAgo(3), null, 950, createdListingIds);

    // 13) Historical-import item — acquisition-date/ownership-age unreliable.
    const historicalItem = await insertItem(admin, 'historical-import', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Historical Import Guitar', estimatedSoldValue: 1100 }, createdItemIds);
    await acquireItem(admin, userId, historicalItem, 'Historical Import', daysAgo(500), 650, createdDealIds);
    await insertListing(admin, userId, historicalItem, reverbId, 'active', daysAgo(12), null, 999, createdListingIds);

    // 14) Missing estimated sold value.
    const missingEsv = await insertItem(admin, 'missing-esv', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Missing ESV Guitar', estimatedSoldValue: null }, createdItemIds);
    await acquireItem(admin, userId, missingEsv, 'purchase', daysAgo(45), 350, createdDealIds);
    await insertListing(admin, userId, missingEsv, marketplaceId, 'active', daysAgo(7), null, 400, createdListingIds);

    // 15) Missing asking price.
    const missingAskingPrice = await insertItem(admin, 'missing-asking-price', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Missing Asking Price Guitar', estimatedSoldValue: 600 }, createdItemIds);
    await acquireItem(admin, userId, missingAskingPrice, 'purchase', daysAgo(18), 300, createdDealIds);
    await insertListing(admin, userId, missingAskingPrice, kijijiId, 'active', daysAgo(6), null, null, createdListingIds);

    // 16) Expenses folded into cost basis / upside.
    const withExpenses = await insertItem(admin, 'with-expenses', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'With Expenses Guitar', estimatedSoldValue: 1000 }, createdItemIds);
    await acquireItem(admin, userId, withExpenses, 'purchase', daysAgo(35), 500, createdDealIds);
    await insertExpense(admin, userId, withExpenses, 75, createdExpenseIds);
    await insertExpense(admin, userId, withExpenses, 25, createdExpenseIds);
    await insertListing(admin, userId, withExpenses, marketplaceId, 'active', daysAgo(4), null, 950, createdListingIds);

    // ══════════════════════════════════════════════════════════════════
    // Call the RPC
    // ══════════════════════════════════════════════════════════════════
    const { data: evidence, error: rpcError } = await admin.rpc('build_listing_evidence_v1_0', { p_target_user_id: userId });
    if (rpcError || !evidence) throw new Error(`build_listing_evidence_v1_0 failed: ${rpcError?.message}`);

    console.log('\n[A — top-level contract]');
    check('schema_version is 1.0', evidence.schema_version === '1.0', evidence.schema_version);
    check('generated_at present', typeof evidence.generated_at === 'string');
    check('evidence_scope present', typeof evidence.evidence_scope === 'string');
    check('listing_age_semantics.buckets has 5 entries', evidence.listing_age_semantics?.buckets?.length === 5);

    console.log('\n[B — reconciliation: every check must pass]');
    for (const r of evidence.reconciliation as Json[]) {
      check(`reconciliation: ${r.check} (expected ${r.expected}, actual ${r.actual})`, r.passed === true, r);
    }

    console.log('\n[C — one item on one channel]');
    {
      const row = findListed(evidence, oneChannelItem);
      check('appears in listed_items', !!row, row);
      check('active_channel_count = 1', row?.active_channel_count === 1, row?.active_channel_count);
      check('exactly one active listing, on Marketplace', row?.active_listings?.length === 1 && row.active_listings[0].channel_name === 'Marketplace', row?.active_listings);
    }

    console.log('\n[D — one item on three channels]');
    {
      const row = findListed(evidence, threeChannelItem);
      check('active_channel_count = 3', row?.active_channel_count === 3, row?.active_channel_count);
      const names = (row?.active_listings ?? []).map((l: Json) => l.channel_name).sort();
      check('active_listings cover Marketplace, Kijiji, Reverb', JSON.stringify(names) === JSON.stringify(['Kijiji', 'Marketplace', 'Reverb']), names);
      const combo = (evidence.cross_listing_evidence.combinations as Json[]).find((c: Json) => c.item_count >= 1 && c.channel_names.length === 3);
      check('cross_listing_evidence has a 3-channel combination', !!combo, evidence.cross_listing_evidence.combinations);
      check('cross_listing_evidence.max_active_channel_count >= 3', evidence.cross_listing_evidence.max_active_channel_count >= 3, evidence.cross_listing_evidence.max_active_channel_count);
    }

    console.log('\n[E — multiple items, same channel]');
    {
      const marketplace = (evidence.channel_summary as Json[]).find((c: Json) => c.channel_name === 'Marketplace');
      check('Marketplace listed_item_count >= 2', (marketplace?.listed_item_count ?? 0) >= 2, marketplace?.listed_item_count);
    }

    console.log('\n[F — ended listing]');
    {
      check('ended-only item does not appear in listed_items', !findListed(evidence, endedOnlyItem));
      const row = findUnlisted(evidence, 'business', endedOnlyItem);
      check('ended-only item appears in unlisted business inventory', !!row, row);
    }

    console.log('\n[G — cancelled listing]');
    {
      check('cancelled-only item does not appear in listed_items', !findListed(evidence, cancelledOnlyItem));
      const row = findUnlisted(evidence, 'business', cancelledOnlyItem);
      check('cancelled-only item appears in unlisted business inventory', !!row, row);
    }

    console.log('\n[H — relisted item: prior ended cycle + current active cycle]');
    {
      const row = findListed(evidence, relistedItem);
      check('appears in listed_items with an active Kijiji cycle', row?.active_listings?.[0]?.channel_name === 'Kijiji', row?.active_listings);
      const prev = (row?.previous_listing_cycles_by_channel ?? []).find((p: Json) => p.channel_name === 'Kijiji');
      check('previous_listing_cycles_by_channel shows 1 completed Kijiji cycle', prev?.completed_cycle_count === 1, prev);
    }

    console.log('\n[I — draft row (missing listing date)]');
    {
      check('draft-only item does not appear in listed_items', !findListed(evidence, draftItem));
      const row = findUnlisted(evidence, 'business', draftItem);
      check('draft-only item appears in unlisted business inventory', !!row, row);
    }

    console.log('\n[J — non-listing-capable channel never surfaces as an exposure]');
    {
      check('non-listing-channel item does not appear in listed_items', !findListed(evidence, nonListingChannelItem));
      check('population_summary.stale_active_listings_excluded_count is a number (data-quality visibility)', typeof evidence.population_summary.stale_active_listings_excluded_count === 'number');
    }

    console.log('\n[K — Business/Hybrid/Personal unlisted treatment]');
    {
      check('business-unlisted item in unlisted_open_inventory.business', !!findUnlisted(evidence, 'business', businessUnlisted));
      const hybridRow = findUnlisted(evidence, 'hybrid', hybridUnlisted);
      check('hybrid-unlisted item in unlisted_open_inventory.hybrid', !!hybridRow);
      check('hybrid-unlisted item disposition_mode is selective_realization', hybridRow?.disposition_mode === 'selective_realization', hybridRow?.disposition_mode);
      check('personal-unlisted item NOT in business/hybrid arrays', !findUnlisted(evidence, 'business', personalUnlisted) && !findUnlisted(evidence, 'hybrid', personalUnlisted));
      check('personal_summary.personal_unlisted_item_count >= 1', evidence.unlisted_open_inventory.personal_summary.personal_unlisted_item_count >= 1, evidence.unlisted_open_inventory.personal_summary);
      check('personal_summary.excluded_from_listing_candidate_analysis is true', evidence.unlisted_open_inventory.personal_summary.excluded_from_listing_candidate_analysis === true);
    }

    console.log('\n[L — listed Personal item: factual, not a candidate]');
    {
      const row = findListed(evidence, personalListed);
      check('appears in listed_items (factual — it IS listed)', !!row, row);
      check('purpose_name is Personal', row?.purpose_name === 'Personal', row?.purpose_name);
      check('personal_summary.personal_listed_item_count >= 1', evidence.unlisted_open_inventory.personal_summary.personal_listed_item_count >= 1);
    }

    console.log('\n[M — historical import: acquisition-date/ownership-age unreliable]');
    {
      const row = findListed(evidence, historicalItem);
      check('is_historical_import = true', row?.is_historical_import === true, row?.is_historical_import);
      check('reliable_ownership_age_days is null', row?.reliable_ownership_age_days === null, row?.reliable_ownership_age_days);
      check('acquisition_date is still present (factual, just flagged unreliable)', typeof row?.acquisition_date === 'string');
    }

    console.log('\n[N — missing estimated sold value]');
    {
      const row = findListed(evidence, missingEsv);
      check('cost_basis is still computed', row?.cost_basis === 350, row?.cost_basis);
      check('estimated_sold_value is null', row?.estimated_sold_value === null);
      check('estimated_net_upside is null (cannot compute without ESV)', row?.estimated_net_upside === null);
      check('estimated_upside_percent is null', row?.estimated_upside_percent === null);
    }

    console.log('\n[O — missing asking price]');
    {
      const row = findListed(evidence, missingAskingPrice);
      check('active listing asking_price is null, no crash', row?.active_listings?.[0]?.asking_price === null, row?.active_listings);
    }

    console.log('\n[P — expenses included in cost basis / upside]');
    {
      const row = findListed(evidence, withExpenses);
      check('cost_basis = acquisition_value(500) + expenses(75+25) = 600', row?.cost_basis === 600, row?.cost_basis);
      check('estimated_net_upside = 1000 - 600 = 400', row?.estimated_net_upside === 400, row?.estimated_net_upside);
      check('inventory_expenses = 100', row?.inventory_expenses === 100, row?.inventory_expenses);
    }

    console.log('\n[Q — purpose_semantics / module_limitations present and non-empty]');
    {
      check('purpose_semantics.business.disposition_mode = active_realization', evidence.purpose_semantics?.business?.disposition_mode === 'active_realization', evidence.purpose_semantics?.business);
      check('purpose_semantics.hybrid.disposition_mode = selective_realization', evidence.purpose_semantics?.hybrid?.disposition_mode === 'selective_realization');
      check('purpose_semantics.personal.disposition_mode = opportunistic_realization', evidence.purpose_semantics?.personal?.disposition_mode === 'opportunistic_realization');
      check('purpose_semantics.guardrails non-empty', (evidence.purpose_semantics?.guardrails?.length ?? 0) > 0);
      check('module_limitations non-empty', (evidence.module_limitations?.length ?? 0) > 0);
    }

    console.log('\n[R — no forbidden fields present (spot check)]');
    {
      const flat = JSON.stringify(evidence);
      check('no auth UUID pattern present', !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(flat), 'UUID-shaped string found');
      check('no email address present', !/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(flat), 'email-shaped string found');
    }
  } finally {
    // ══════════════════════════════════════════════════════════════════
    // Cleanup — every created row deleted, deletion verified.
    // ══════════════════════════════════════════════════════════════════
    console.log('\n[cleanup]');
    if (createdListingIds.length) await admin.from('item_listings').delete().in('id', createdListingIds);
    if (createdExpenseIds.length) await admin.from('inventory_expenses').delete().in('id', createdExpenseIds);
    if (createdItemIds.length) await admin.from('deal_items').delete().in('item_id', createdItemIds);
    if (createdDealIds.length) await admin.from('deals').delete().in('id', createdDealIds);
    if (createdItemIds.length) await admin.from('inventory_items').delete().in('id', createdItemIds);

    const { data: remainingItems } = await admin.from('inventory_items').select('id').in('id', createdItemIds);
    const { data: remainingListings } = await admin.from('item_listings').select('id').in('id', createdListingIds.length ? createdListingIds : [-1]);
    check('all fixture items deleted', (remainingItems?.length ?? 0) === 0, remainingItems);
    check('all fixture listings deleted', (remainingListings?.length ?? 0) === 0, remainingListings);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
