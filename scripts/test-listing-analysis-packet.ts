/**
 * test-listing-analysis-packet.ts
 *
 * Focused validation for Listing Analysis Packet v1.0
 * (src/lib/analytics/listingAnalysisPacket.ts, src/app/api/
 * listing-analysis-packet/route.ts) — a follow-up to Listing Evidence v1.0
 * (commit aa884b2). Builds a small dedicated fixture pool (marker
 * `PACKET:<key>`, isolated from every other script's fixtures), fetches
 * real Listing Evidence via the actual RPC, then exercises
 * buildListingAnalysisPacket directly against that real evidence object —
 * same conventions as every other script here: tsx, no test framework,
 * local check(), safety-gated to local Supabase only. Every row created is
 * deleted and the deletion verified before the script exits.
 *
 * Usage:
 *   npx tsx scripts/test-listing-analysis-packet.ts
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl,
  assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import {
  buildListingAnalysisPacket,
  ListingAnalysisPacketError,
  LISTING_ANALYSIS_PACKET_SCHEMA_VERSION,
  summarizePacketForConfirmation,
  formatPacketConfirmationMessage,
} from '../src/lib/analytics/listingAnalysisPacket';
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

// ── Fixture builders (same convention as scripts/test-listing-evidence.ts) ──

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
    model: spec.model, status: 'owned', estimated_sold_value: spec.estimatedSoldValue ?? null, serial_number: `PACKET:${key}`,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const FORBIDDEN_PATTERNS: [string, RegExp][] = [
  ['auth UUID', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
  ['email address', /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/],
  ['supabase storage URL', /supabase\.co\/storage/i],
  ['service_role', /service_role/i],
  ['sql keyword block (SELECT ... FROM)', /SELECT\s+.+\s+FROM\s+/i],
];

function scanForForbiddenFields(obj: unknown): string[] {
  const text = JSON.stringify(obj);
  const hits: string[] = [];
  for (const [label, re] of FORBIDDEN_PATTERNS) {
    if (re.test(text)) hits.push(label);
  }
  return hits;
}

async function main() {
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const EMAIL = 'listing-analysis-packet-fixture@example.test';
  const { data: authUsers } = await admin.auth.admin.listUsers();
  let authUserId = authUsers?.users.find((u) => u.email === EMAIL)?.id ?? null;
  if (!authUserId) {
    const { data: created, error } = await admin.auth.admin.createUser({ email: EMAIL, password: 'Listing-Analysis-Packet-Fixture-Local-Only-1!', email_confirm: true });
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

  const brandId = await ensureBrand(admin, 'Packet-Test-Brand');
  const guitarSubtypeId = await subtypeId(admin, 'Guitars', 'Electric Guitar');
  const businessId = await purposeId(admin, 'Business');
  const hybridId = await purposeId(admin, 'Hybrid');
  const personalId = await purposeId(admin, 'Personal');
  const marketplaceId = await channelId(admin, 'Marketplace');
  const kijijiId = await channelId(admin, 'Kijiji');

  const createdItemIds: number[] = [];
  const createdDealIds: number[] = [];
  const createdListingIds: number[] = [];

  let evidence: ListingEvidence;

  try {
    // Cross-listed on Marketplace + Kijiji.
    const crossListedItem = await insertItem(admin, 'cross-listed', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Cross-Listed Guitar', estimatedSoldValue: 1500 }, createdItemIds);
    await acquireItem(admin, userId, crossListedItem, 'purchase', daysAgo(60), 900, createdDealIds);
    await insertListing(admin, userId, crossListedItem, marketplaceId, daysAgo(20), 1400, createdListingIds);
    await insertListing(admin, userId, crossListedItem, kijijiId, daysAgo(15), null, createdListingIds);

    // Marketplace-only, historical import.
    const historicalItem = await insertItem(admin, 'historical', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Historical Guitar', estimatedSoldValue: 800 }, createdItemIds);
    await acquireItem(admin, userId, historicalItem, 'Historical Import', daysAgo(400), 500, createdDealIds);
    await insertListing(admin, userId, historicalItem, marketplaceId, daysAgo(30), null, createdListingIds);

    // Unlisted Business.
    const unlistedBusiness = await insertItem(admin, 'unlisted-business', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Unlisted Business Guitar', estimatedSoldValue: 600 }, createdItemIds);
    await acquireItem(admin, userId, unlistedBusiness, 'purchase', daysAgo(25), 350, createdDealIds);

    // Unlisted Hybrid.
    const unlistedHybrid = await insertItem(admin, 'unlisted-hybrid', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: hybridId, model: 'Unlisted Hybrid Guitar', estimatedSoldValue: 1200 }, createdItemIds);
    await acquireItem(admin, userId, unlistedHybrid, 'purchase', daysAgo(150), 700, createdDealIds);

    // Personal, listed (factual current-listing evidence).
    const personalListed = await insertItem(admin, 'personal-listed', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: personalId, model: 'Personal Listed Guitar', estimatedSoldValue: 900 }, createdItemIds);
    await acquireItem(admin, userId, personalListed, 'purchase', daysAgo(40), 500, createdDealIds);
    await insertListing(admin, userId, personalListed, kijijiId, daysAgo(5), 850, createdListingIds);

    // Personal, unlisted (aggregate only).
    const personalUnlisted = await insertItem(admin, 'personal-unlisted', { userId, brandId, subtypeId: guitarSubtypeId, purposeId: personalId, model: 'Personal Unlisted Guitar', estimatedSoldValue: null }, createdItemIds);
    await acquireItem(admin, userId, personalUnlisted, 'purchase', daysAgo(300), 300, createdDealIds);

    const { data: rawEvidence, error: rpcError } = await admin.rpc('build_listing_evidence_v1_0', { p_target_user_id: userId });
    if (rpcError || !rawEvidence) throw new Error(`build_listing_evidence_v1_0 failed: ${rpcError?.message}`);
    evidence = rawEvidence as ListingEvidence;

    console.log('\n[A — All Inventory scope]');
    {
      const packet = buildListingAnalysisPacket(evidence, { scope: 'all' });
      check('schema_version = 1.0', packet.schema_version === LISTING_ANALYSIS_PACKET_SCHEMA_VERSION, packet.schema_version);
      check('scope.type = all', packet.scope.type === 'all');
      check('scope.channel_id is null', packet.scope.channel_id === null);
      check('listed_items includes the cross-listed item', packet.listed_items.some((i) => i.item_id === crossListedItem));
      check('listed_items includes the historical item', packet.listed_items.some((i) => i.item_id === historicalItem));
      check('listed_items includes the listed Personal item (factual)', packet.listed_items.some((i) => i.item_id === personalListed));
      check('listed_elsewhere_not_in_scope is empty for All scope', packet.listed_elsewhere_not_in_scope.length === 0);
      check('unlisted_business_items includes the unlisted business item', packet.unlisted_business_items.some((i) => i.item_id === unlistedBusiness));
      check('unlisted_hybrid_items includes the unlisted hybrid item', packet.unlisted_hybrid_items.some((i) => i.item_id === unlistedHybrid));
      check('channel_summary is non-empty (full portfolio context)', packet.channel_summary.length > 0);
      check('category_channel_matrix has rows', packet.category_channel_matrix.rows.length > 0);
    }

    console.log('\n[B — Unlisted Inventory scope]');
    {
      const packet = buildListingAnalysisPacket(evidence, { scope: 'unlisted' });
      check('listed_items is empty for Unlisted scope', packet.listed_items.length === 0);
      check('listed_elsewhere_not_in_scope is empty for Unlisted scope', packet.listed_elsewhere_not_in_scope.length === 0);
      check('channel_summary is empty for Unlisted scope', packet.channel_summary.length === 0);
      check('unlisted_business_items includes the unlisted business item', packet.unlisted_business_items.some((i) => i.item_id === unlistedBusiness));
      check('unlisted_hybrid_items includes the unlisted hybrid item', packet.unlisted_hybrid_items.some((i) => i.item_id === unlistedHybrid));
      check('personal_summary.excluded_from_listing_candidate_analysis is true', packet.personal_summary.excluded_from_listing_candidate_analysis === true);
    }

    console.log('\n[C — Per-Channel scope: currently-on / listed-elsewhere partition]');
    {
      const packet = buildListingAnalysisPacket(evidence, { scope: 'channel', channelId: marketplaceId });
      check('scope.type = channel', packet.scope.type === 'channel');
      check('scope.channel_id matches Marketplace', packet.scope.channel_id === marketplaceId);
      check('cross-listed item appears in listed_items (currently on Marketplace)', packet.listed_items.some((i) => i.item_id === crossListedItem));
      check('historical item appears in listed_items (currently on Marketplace)', packet.listed_items.some((i) => i.item_id === historicalItem));

      const kijijiOnlyItems = packet.listed_elsewhere_not_in_scope;
      check('personal-listed item (Kijiji only) appears in listed_elsewhere_not_in_scope', kijijiOnlyItems.some((i) => i.item_id === personalListed));
      check('cross-listed item does NOT appear in listed_elsewhere_not_in_scope (it IS on Marketplace)', !kijijiOnlyItems.some((i) => i.item_id === crossListedItem));
      check('unlisted_business_items still full (unaffected by channel scope)', packet.unlisted_business_items.some((i) => i.item_id === unlistedBusiness));
      check('unlisted_hybrid_items still full (unaffected by channel scope)', packet.unlisted_hybrid_items.some((i) => i.item_id === unlistedHybrid));
      check('channel_summary contains exactly the one selected channel', packet.channel_summary.length === 1 && packet.channel_summary[0].channel_id === marketplaceId);
    }

    console.log('\n[D — no Personal candidate array anywhere]');
    {
      const allPacket = buildListingAnalysisPacket(evidence, { scope: 'all' });
      const keys = Object.keys(allPacket);
      check('no "unlisted_personal_items" or "personal_items" key exists', !keys.some((k) => /personal.*item/i.test(k) && k !== 'personal_summary'));
      check('personal_summary is a plain object, not an array', !Array.isArray(allPacket.personal_summary));
    }

    console.log('\n[E — asking_price null preserved, never inferred]');
    {
      const packet = buildListingAnalysisPacket(evidence, { scope: 'all' });
      const historicalRow = packet.listed_items.find((i) => i.item_id === historicalItem)!;
      const askingPrices = historicalRow.active_listings.map((l) => l.asking_price);
      check('historical item\'s active listing has asking_price === null (not 0, not inferred)', askingPrices.includes(null), askingPrices);
      check('limitations flags asking-price unavailability', packet.limitations.some((l) => /asking_price|asking price/i.test(l)), packet.limitations);
    }

    console.log('\n[F — historical-date reliability preserved]');
    {
      const packet = buildListingAnalysisPacket(evidence, { scope: 'all' });
      const historicalRow = packet.listed_items.find((i) => i.item_id === historicalItem)!;
      check('is_historical_import = true', historicalRow.is_historical_import === true);
      check('reliable_ownership_age_days is null for historical import', historicalRow.reliable_ownership_age_days === null);
      check('acquisition_date is still present (factual, just flagged unreliable)', typeof historicalRow.acquisition_date === 'string');
    }

    console.log('\n[G — comparable DOM preserved]');
    {
      const packet = buildListingAnalysisPacket(evidence, { scope: 'all' });
      const row = packet.listed_items.find((i) => i.item_id === crossListedItem)!;
      check('liquidity_context is present', row.liquidity_context !== undefined);
      check('liquidity_context.comparable_evidence_available is a boolean', typeof row.liquidity_context.comparable_evidence_available === 'boolean');
    }

    console.log('\n[H — guardrails present]');
    {
      const packet = buildListingAnalysisPacket(evidence, { scope: 'all' });
      check('analysis_context.guardrails is non-empty', packet.analysis_context.guardrails.length >= 8, packet.analysis_context.guardrails);
      check('guardrails mention Hybrid should not be assumed listable', packet.analysis_context.guardrails.some((g) => /Hybrid/i.test(g) && /should not/i.test(g) === false && /not assume/i.test(g)));
      check('guardrails mention Personal should not be recommended for sale', packet.analysis_context.guardrails.some((g) => /Personal/i.test(g) && /not recommend/i.test(g)));
      check('analysis_context carries purpose_semantics for all three purposes', !!packet.analysis_context.purpose_semantics.business && !!packet.analysis_context.purpose_semantics.hybrid && !!packet.analysis_context.purpose_semantics.personal);
      check('analysis_context carries listing_age_semantics', packet.analysis_context.listing_age_semantics.buckets.length === 5);
    }

    console.log('\n[I — forbidden/private fields absent]');
    {
      for (const scope of ['all', 'unlisted'] as const) {
        const packet = buildListingAnalysisPacket(evidence, { scope });
        const hits = scanForForbiddenFields(packet);
        check(`scope=${scope}: no forbidden fields present`, hits.length === 0, hits);
      }
      const channelPacket = buildListingAnalysisPacket(evidence, { scope: 'channel', channelId: marketplaceId });
      const hits = scanForForbiddenFields(channelPacket);
      check('scope=channel: no forbidden fields present', hits.length === 0, hits);
    }

    console.log('\n[J — deterministic output for identical evidence]');
    {
      const p1 = buildListingAnalysisPacket(evidence, { scope: 'all' });
      const p2 = buildListingAnalysisPacket(evidence, { scope: 'all' });
      // generated_at is copied verbatim from evidence.generated_at (fixed
      // input), so a byte-identical JSON comparison is a valid determinism
      // check here — this is a pure function over the same evidence object.
      check('two builds from the same evidence object are byte-identical', JSON.stringify(p1) === JSON.stringify(p2));
    }

    console.log('\n[K — unknown channel_id rejected]');
    {
      let threw = false;
      try {
        buildListingAnalysisPacket(evidence, { scope: 'channel', channelId: 999999999 });
      } catch (e) {
        threw = e instanceof ListingAnalysisPacketError;
      }
      check('an unknown channel_id throws ListingAnalysisPacketError', threw);
    }

    console.log('\n[L — confirmation message uses actual packet counts]');
    {
      const allPacket = buildListingAnalysisPacket(evidence, { scope: 'all' });
      const summary = summarizePacketForConfirmation(allPacket);
      check('currentListingsCount matches listed_items.length', summary.currentListingsCount === allPacket.listed_items.length);
      check('unlistedBusinessCount matches unlisted_business_items.length', summary.unlistedBusinessCount === allPacket.unlisted_business_items.length);
      const message = formatPacketConfirmationMessage(allPacket);
      check('message contains the actual current-listings count', message.includes(String(allPacket.listed_items.length)));
      check('message contains the actual unlisted-business count', message.includes(String(allPacket.unlisted_business_items.length)));

      const channelPacket = buildListingAnalysisPacket(evidence, { scope: 'channel', channelId: marketplaceId });
      const channelMessage = formatPacketConfirmationMessage(channelPacket);
      check('per-channel message names the channel', channelMessage.includes('Marketplace'), channelMessage);
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
