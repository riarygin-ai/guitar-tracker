/**
 * test-listing-analysis-export.ts
 *
 * Focused validation for the "Copy Analysis Data" / "Download Analysis
 * Data" complete-dataset export — buildAnalysisExportData (src/lib/
 * analytics/listingAnalysisPacket.ts), GET /api/listing-analysis-export
 * (src/app/api/listing-analysis-export/route.ts), and the client copy/
 * download logic (src/lib/analysisExportClipboard.ts). A follow-up to
 * Listing Analysis Packet v1.0 (scripts/test-listing-analysis-packet.ts) —
 * that packet builder and its per-channel "Copy {Channel} Analysis"
 * quick-copy buttons are untouched by this feature and are NOT
 * re-validated here.
 *
 * Section A drives buildAnalysisExportData directly against real
 * evidence (via the actual build_listing_evidence_v1_0 RPC) plus real
 * item_listings/item_listing_price_history rows — same conventions as
 * every other script here: tsx, no test framework, local check(),
 * safety-gated to local Supabase only.
 *
 * Section B is pure logic/unit coverage of analysisExportClipboard.ts —
 * getAccessToken, fetch, writeText, and downloadFile are all injected
 * dependencies, so none of it needs a DOM or a running Next.js server.
 *
 * Usage:
 *   npx tsx scripts/test-listing-analysis-export.ts
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl,
  assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import {
  buildAnalysisExportData,
  summarizeAnalysisExportForConfirmation,
  formatAnalysisExportConfirmationMessage,
  type AnalysisExportData,
} from '../src/lib/analytics/listingAnalysisPacket';
import {
  fetchAnalysisExportData,
  copyAnalysisExportToClipboard,
  downloadAnalysisExportAsFile,
  createAnalysisExportCopier,
  createAnalysisExportDownloader,
  buildAnalysisExportFilename,
  type AnalysisExportDeps,
} from '../src/lib/analysisExportClipboard';
import type { ListingEvidence } from '../src/lib/analytics/listingEvidence';
import type { ItemListing, ItemListingPriceHistory } from '../src/types';

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

// ── Fixture builders (same convention as scripts/test-listing-analysis-packet.ts) ──

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
async function insertItem(
  admin: SupabaseClient,
  key: string,
  spec: { userId: number; brandId: number; subtypeId: number; purposeId: number | null; model: string; estimatedSoldValue?: number | null },
  createdItemIds: number[],
): Promise<number> {
  const { data, error } = await admin.from('inventory_items').insert({
    user_id: spec.userId, brand_id: spec.brandId, item_subtype_id: spec.subtypeId, purpose_id: spec.purposeId,
    model: spec.model, status: 'owned', estimated_sold_value: spec.estimatedSoldValue ?? null, serial_number: `EXPORT:${key}`,
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
async function insertListingCycle(
  admin: SupabaseClient,
  spec: {
    userId: number; itemId: number; channelId: number;
    status: 'active' | 'ended' | 'cancelled' | 'draft';
    listedAt?: string | null; endedAt?: string | null; cancelledAt?: string | null;
    askingPrice?: number | null; title?: string | null;
  },
  createdListingIds: number[],
): Promise<number> {
  const { data, error } = await admin.from('item_listings').insert({
    user_id: spec.userId, inventory_item_id: spec.itemId, deal_channel_id: spec.channelId,
    status: spec.status, listed_at: spec.listedAt ?? null, ended_at: spec.endedAt ?? null, cancelled_at: spec.cancelledAt ?? null,
    asking_price: spec.askingPrice ?? null, title: spec.title ?? null, is_ai_generated: false,
  }).select('id').single();
  if (error) throw new Error(`Failed to insert listing cycle (item=${spec.itemId}, channel=${spec.channelId}, status=${spec.status}): ${error.message}`);
  createdListingIds.push(data.id as number);
  return data.id as number;
}
async function updateAskingPrice(admin: SupabaseClient, listingId: number, price: number): Promise<void> {
  const { error } = await admin.from('item_listings').update({ asking_price: price }).eq('id', listingId);
  if (error) throw new Error(`Failed to update asking_price for listing ${listingId}: ${error.message}`);
}

async function ensureTestUser(admin: SupabaseClient, email: string, password: string): Promise<number> {
  const { data: authUsers } = await admin.auth.admin.listUsers();
  let authUserId = authUsers?.users.find((u) => u.email === email)?.id ?? null;
  if (!authUserId) {
    const { data: created, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !created.user) throw new Error(`Failed to create test user ${email}: ${error?.message}`);
    authUserId = created.user.id;
  }
  let userId: number | null = null;
  for (let attempt = 0; attempt < 10 && !userId; attempt++) {
    const { data } = await admin.from('app_users').select('id').eq('auth_user_id', authUserId).maybeSingle();
    if (data) userId = data.id as number;
    else await new Promise((r) => setTimeout(r, 200));
  }
  if (!userId) throw new Error(`app_users row for ${email} never appeared`);
  return userId;
}

function fakeResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

async function main() {
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const userA = await ensureTestUser(admin, 'listing-analysis-export-fixture-a@example.test', 'Listing-Analysis-Export-Fixture-Local-Only-1!');
  const userB = await ensureTestUser(admin, 'listing-analysis-export-fixture-b@example.test', 'Listing-Analysis-Export-Fixture-Local-Only-1!');

  const brandId = await ensureBrand(admin, 'Export-Test-Brand');
  const guitarSubtypeId = await subtypeId(admin, 'Guitars', 'Electric Guitar');
  const businessId = await purposeId(admin, 'Business');
  const marketplaceId = await channelId(admin, 'Marketplace');
  const kijijiId = await channelId(admin, 'Kijiji');
  const reverbId = await channelId(admin, 'Reverb');

  const createdItemIds: number[] = [];
  const createdDealIds: number[] = [];
  const createdListingIds: number[] = [];

  let userAExport: AnalysisExportData;

  try {
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== Fixtures ===');

    // 1) Currently listed item, ONE listing cycle.
    const singleCycleItem = await insertItem(admin, 'single-cycle', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Single-Cycle Guitar', estimatedSoldValue: 900 }, createdItemIds);
    await acquireItem(admin, userA, singleCycleItem, 'purchase', daysAgo(60), 500, createdDealIds);
    const singleCycleListingId = await insertListingCycle(admin, { userId: userA, itemId: singleCycleItem, channelId: marketplaceId, status: 'active', listedAt: daysAgo(10), askingPrice: 700 }, createdListingIds);

    // 2) Listed item with MULTIPLE previous cycles on the SAME platform
    //    (an ended cycle, then a fresh active one) — the task's own
    //    conceptual example shape.
    const multiCycleItem = await insertItem(admin, 'multi-cycle', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Multi-Cycle Guitar', estimatedSoldValue: 1200 }, createdItemIds);
    await acquireItem(admin, userA, multiCycleItem, 'purchase', daysAgo(120), 700, createdDealIds);
    await insertListingCycle(admin, { userId: userA, itemId: multiCycleItem, channelId: reverbId, status: 'ended', listedAt: daysAgo(90), endedAt: daysAgo(70), askingPrice: 1000 }, createdListingIds);
    const multiCycleActiveId = await insertListingCycle(admin, { userId: userA, itemId: multiCycleItem, channelId: reverbId, status: 'active', listedAt: daysAgo(20), askingPrice: 1100 }, createdListingIds);

    // 3) A listing cycle with SEVERAL asking-price changes.
    const priceChangesItem = await insertItem(admin, 'price-changes', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Price-Changes Guitar', estimatedSoldValue: 1000 }, createdItemIds);
    await acquireItem(admin, userA, priceChangesItem, 'purchase', daysAgo(50), 600, createdDealIds);
    const priceChangesListingId = await insertListingCycle(admin, { userId: userA, itemId: priceChangesItem, channelId: marketplaceId, status: 'active', listedAt: daysAgo(30), askingPrice: 800 }, createdListingIds);
    await new Promise((r) => setTimeout(r, 20));
    await updateAskingPrice(admin, priceChangesListingId, 750);
    await new Promise((r) => setTimeout(r, 20));
    await updateAskingPrice(admin, priceChangesListingId, 900);

    // 4) Currently UNLISTED item that WAS listed previously.
    const previouslyListedItem = await insertItem(admin, 'previously-listed', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Previously-Listed Guitar', estimatedSoldValue: 650 }, createdItemIds);
    await acquireItem(admin, userA, previouslyListedItem, 'purchase', daysAgo(200), 400, createdDealIds);
    await insertListingCycle(admin, { userId: userA, itemId: previouslyListedItem, channelId: kijijiId, status: 'ended', listedAt: daysAgo(150), endedAt: daysAgo(130), askingPrice: 600 }, createdListingIds);

    // 5) Item that has NEVER been listed.
    const neverListedItem = await insertItem(admin, 'never-listed', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Never-Listed Guitar', estimatedSoldValue: 500 }, createdItemIds);
    await acquireItem(admin, userA, neverListedItem, 'purchase', daysAgo(30), 300, createdDealIds);

    // 6) Different listing platforms for the SAME item, both currently active.
    const multiPlatformItem = await insertItem(admin, 'multi-platform', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'Multi-Platform Guitar', estimatedSoldValue: 1400 }, createdItemIds);
    await acquireItem(admin, userA, multiPlatformItem, 'purchase', daysAgo(80), 900, createdDealIds);
    await insertListingCycle(admin, { userId: userA, itemId: multiPlatformItem, channelId: marketplaceId, status: 'active', listedAt: daysAgo(25), askingPrice: 1300 }, createdListingIds);
    await insertListingCycle(admin, { userId: userA, itemId: multiPlatformItem, channelId: kijijiId, status: 'active', listedAt: daysAgo(18), askingPrice: null }, createdListingIds);

    // 7) Unlisted item with an unmapped/unclassified purpose — must still
    //    appear somewhere in the export (never silently dropped).
    const unclassifiedItem = await insertItem(admin, 'unclassified', { userId: userA, brandId, subtypeId: guitarSubtypeId, purposeId: null, model: 'Unclassified Guitar', estimatedSoldValue: 400 }, createdItemIds);
    await acquireItem(admin, userA, unclassifiedItem, 'purchase', daysAgo(15), 250, createdDealIds);

    // 8) User B fixture — must NEVER appear in user A's export.
    const userBItem = await insertItem(admin, 'user-b-item', { userId: userB, brandId, subtypeId: guitarSubtypeId, purposeId: businessId, model: 'User B Guitar', estimatedSoldValue: 1000 }, createdItemIds);
    await acquireItem(admin, userB, userBItem, 'purchase', daysAgo(40), 600, createdDealIds);
    await insertListingCycle(admin, { userId: userB, itemId: userBItem, channelId: reverbId, status: 'active', listedAt: daysAgo(5), askingPrice: 950 }, createdListingIds);

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== Section A: buildAnalysisExportData (real evidence + real DB rows) ===');

    const { data: rawEvidenceA, error: rpcErrorA } = await admin.rpc('build_listing_evidence_v1_0', { p_target_user_id: userA });
    if (rpcErrorA || !rawEvidenceA) throw new Error(`build_listing_evidence_v1_0 (user A) failed: ${rpcErrorA?.message}`);
    const evidenceA = rawEvidenceA as ListingEvidence;

    const { data: itemListingsA } = await admin.from('item_listings').select('*').eq('user_id', userA);
    const { data: priceHistoryA } = await admin.from('item_listing_price_history').select('*').eq('user_id', userA);

    userAExport = buildAnalysisExportData({
      evidence: evidenceA,
      itemListings: (itemListingsA ?? []) as ItemListing[],
      priceHistory: (priceHistoryA ?? []) as ItemListingPriceHistory[],
    });

    const allExportedItems = [
      ...userAExport.listed_items,
      ...userAExport.unlisted_business_items,
      ...userAExport.unlisted_hybrid_items,
      ...userAExport.unlisted_unclassified_items,
    ];
    const findExported = (itemId: number) => allExportedItems.find((i) => i.item_id === itemId);

    console.log('\n[1 — currently listed item, one listing cycle]');
    {
      const row = findExported(singleCycleItem);
      check('item is present in the export', !!row, singleCycleItem);
      check('item appears in listed_items', userAExport.listed_items.some((i) => i.item_id === singleCycleItem));
      check('listing_history has exactly one entry', row?.listing_history.length === 1, row?.listing_history);
      const entry = row?.listing_history[0];
      check('entry.id matches the inserted listing id', entry?.id === singleCycleListingId);
      check('entry.channel_id/channel_name resolve to Marketplace', entry?.channel_id === marketplaceId && entry?.channel_name === 'Marketplace', entry);
      check('entry.status is active', entry?.status === 'active');
      check('entry.asking_price is the current price', entry?.asking_price === 700, entry?.asking_price);
      check('entry has exactly one price_history row (the initial insert)', entry?.price_history.length === 1, entry?.price_history);
      check('price_history entry: old=null, new=700', entry?.price_history[0]?.old_asking_price === null && entry?.price_history[0]?.new_asking_price === 700, entry?.price_history[0]);
    }

    console.log('\n[2 — listed item with multiple previous cycles, same platform]');
    {
      const row = findExported(multiCycleItem);
      check('item appears in listed_items (has a currently active cycle)', userAExport.listed_items.some((i) => i.item_id === multiCycleItem));
      check('listing_history preserves BOTH cycles (never collapsed to one row per platform)', row?.listing_history.length === 2, row?.listing_history);
      const [first, second] = row?.listing_history ?? [];
      check('cycles are ordered chronologically (ended cycle before the newer active one)', first?.status === 'ended' && second?.status === 'active', row?.listing_history);
      check('both cycles are on the same channel (Reverb)', first?.channel_id === reverbId && second?.channel_id === reverbId);
      check('the ended cycle carries its own ended_at', first?.ended_at === daysAgo(70), first?.ended_at);
      check('the active cycle has no ended_at', second?.ended_at === null);
      check('the currently active cycle id matches', second?.id === multiCycleActiveId);
    }

    console.log('\n[3 — listing with several asking-price changes]');
    {
      const row = findExported(priceChangesItem);
      check('item is present', !!row);
      check('listing_history has exactly one cycle', row?.listing_history.length === 1);
      const entry = row?.listing_history[0];
      check('entry id matches the listing', entry?.id === priceChangesListingId);
      check('price_history has exactly 3 entries (insert + 2 updates)', entry?.price_history.length === 3, entry?.price_history);
      const ph = entry?.price_history ?? [];
      check('price_history is ordered chronologically (changed_at ascending)', ph.every((p, i) => i === 0 || p.changed_at >= ph[i - 1].changed_at), ph.map((p) => p.changed_at));
      check('sequence is 800 -> 750 -> 900, never collapsed to only the latest', ph[0]?.new_asking_price === 800 && ph[1]?.new_asking_price === 750 && ph[2]?.new_asking_price === 900, ph);
      check('each entry chains old->new correctly', ph[0]?.old_asking_price === null && ph[1]?.old_asking_price === 800 && ph[2]?.old_asking_price === 750, ph);
      check('every price_history entry carries item_listing_id for association', ph.every((p) => p.item_listing_id === priceChangesListingId), ph);
      check('entry.asking_price (current) is the final value 900', entry?.asking_price === 900);
    }

    console.log('\n[4 — currently unlisted item that was listed previously]');
    {
      const row = findExported(previouslyListedItem);
      check('item is present', !!row);
      check('item does NOT appear in listed_items (no active cycle)', !userAExport.listed_items.some((i) => i.item_id === previouslyListedItem));
      check('item appears in unlisted_business_items', userAExport.unlisted_business_items.some((i) => i.item_id === previouslyListedItem));
      check('listing_history is NOT empty — its past cycle is preserved', (row?.listing_history.length ?? 0) === 1, row?.listing_history);
      check('the preserved cycle is the ended Kijiji cycle', row?.listing_history[0]?.status === 'ended' && row?.listing_history[0]?.channel_name === 'Kijiji', row?.listing_history[0]);
    }

    console.log('\n[5 — item that has never been listed]');
    {
      const row = findExported(neverListedItem);
      check('item is present (unlisted items are not excluded)', !!row);
      check('item appears in unlisted_business_items', userAExport.unlisted_business_items.some((i) => i.item_id === neverListedItem));
      check('listing_history is an empty array, not omitted/null', Array.isArray(row?.listing_history) && row?.listing_history.length === 0, row?.listing_history);
    }

    console.log('\n[6 — different listing platforms for the same item]');
    {
      const row = findExported(multiPlatformItem);
      check('item appears in listed_items', userAExport.listed_items.some((i) => i.item_id === multiPlatformItem));
      check('listing_history has one entry per platform', row?.listing_history.length === 2, row?.listing_history);
      const channels = (row?.listing_history ?? []).map((e) => e.channel_name).sort();
      check('both Marketplace and Kijiji are present', JSON.stringify(channels) === JSON.stringify(['Kijiji', 'Marketplace']), channels);
      const kijijiEntry = row?.listing_history.find((e) => e.channel_id === kijijiId);
      check('a cycle with no asking price yet keeps asking_price null (never inferred)', kijijiEntry?.asking_price === null, kijijiEntry);
      check('a null asking_price never generated a price_history row', kijijiEntry?.price_history.length === 0, kijijiEntry?.price_history);
    }

    console.log('\n[7 — unlisted item with an unmapped purpose is never silently dropped]');
    {
      check('item appears in unlisted_unclassified_items (a new, additive array)', userAExport.unlisted_unclassified_items.some((i) => i.item_id === unclassifiedItem));
      const row = userAExport.unlisted_unclassified_items.find((i) => i.item_id === unclassifiedItem);
      check('it is not duplicated into any other bucket', !userAExport.listed_items.some((i) => i.item_id === unclassifiedItem) && !userAExport.unlisted_business_items.some((i) => i.item_id === unclassifiedItem) && !userAExport.unlisted_hybrid_items.some((i) => i.item_id === unclassifiedItem));
      check('it still carries listing_history (empty, since never listed)', Array.isArray(row?.listing_history) && row?.listing_history.length === 0);
    }

    console.log('\n[8 — no other user\'s data appears]');
    {
      const exportText = JSON.stringify(userAExport);
      check('user B\'s item_id never appears', !allExportedItems.some((i) => i.item_id === userBItem));
      check('user B\'s model name never appears anywhere in the export', !exportText.includes('User B Guitar'), 'leaked');
      check('user B\'s listing id never appears as any listing_history.id', !allExportedItems.some((i) => i.listing_history.some((h) => h.channel_id === reverbId && h.asking_price === 950)));
    }

    console.log('\n[9 — existing packet fields are preserved verbatim]');
    {
      check('schema_version present', userAExport.schema_version === '1.0');
      check('scope is {type: all} — always the complete dataset, no per-scope filtering', userAExport.scope.type === 'all' && userAExport.scope.channel_id === null);
      check('analysis_context present with guardrails', userAExport.analysis_context.guardrails.length > 0);
      check('summary (population_summary) present', typeof userAExport.summary.open_item_count === 'number');
      check('channel_summary present and non-empty', userAExport.channel_summary.length > 0);
      check('category_channel_matrix present', Array.isArray(userAExport.category_channel_matrix.rows));
      check('cross_listing present', Array.isArray(userAExport.cross_listing.combinations));
      check('listed_elsewhere_not_in_scope preserved (always empty for the complete dataset)', userAExport.listed_elsewhere_not_in_scope.length === 0);
      check('personal_summary present', userAExport.personal_summary.excluded_from_listing_candidate_analysis === true);
      check('limitations present', Array.isArray(userAExport.limitations));
    }

    console.log('\n[10 — deterministic / idempotent output]');
    {
      const rebuilt = buildAnalysisExportData({
        evidence: evidenceA,
        itemListings: (itemListingsA ?? []) as ItemListing[],
        priceHistory: (priceHistoryA ?? []) as ItemListingPriceHistory[],
      });
      check('two builds from the same inputs are byte-identical', JSON.stringify(rebuilt) === JSON.stringify(userAExport));
    }

    console.log('\n[11 — confirmation summary reflects actual counts]');
    {
      const summary = summarizeAnalysisExportForConfirmation(userAExport);
      check('itemCount matches the total across every bucket', summary.itemCount === allExportedItems.length, summary);
      check('currentListingsCount matches listed_items.length', summary.currentListingsCount === userAExport.listed_items.length);
      const message = formatAnalysisExportConfirmationMessage(userAExport);
      check('message includes the actual item count', message.includes(String(summary.itemCount)), message);
      check('message includes the actual listing-cycle count', message.includes(String(summary.listingCycleCount)), message);
    }

    // ═══════════════════════════════════════════════════════════════════
    console.log('\n=== Section B: analysisExportClipboard.ts (pure logic, injected deps) ===');

    console.log('\n[B1 — fetch hits the export endpoint with the Bearer token, no scope params]');
    {
      let capturedInput: string | null = null;
      let capturedInit: RequestInit | undefined;
      const deps = {
        getAccessToken: async () => 'test-access-token-123',
        fetchImpl: async (input: string, init?: RequestInit) => {
          capturedInput = input; capturedInit = init;
          return fakeResponse(200, { target_user_analysis_export: userAExport });
        },
      };
      const result = await fetchAnalysisExportData(deps);
      check('result is success', result.status === 'success', result);
      check('called /api/listing-analysis-export with no query string at all', capturedInput === '/api/listing-analysis-export', capturedInput);
      check('method is GET', capturedInit?.method === 'GET');
      const headers = capturedInit?.headers as Record<string, string> | undefined;
      check('Authorization header carries the Bearer token', headers?.Authorization === 'Bearer test-access-token-123', headers);
    }

    console.log('\n[B2 — no target user ID is ever sent by the client]');
    {
      let capturedInput: string | null = null;
      const deps = {
        getAccessToken: async () => 'tok',
        fetchImpl: async (input: string) => { capturedInput = input; return fakeResponse(200, { target_user_analysis_export: userAExport }); },
      };
      await fetchAnalysisExportData(deps);
      check('request URL never contains user_id/target_user/uid', !/user_id|target_user|uid=/i.test(capturedInput ?? ''), capturedInput);
    }

    console.log('\n[B3 — unauthenticated session: no request, safe error]');
    {
      let fetchCalled = false;
      const deps = {
        getAccessToken: async () => null,
        fetchImpl: async () => { fetchCalled = true; return fakeResponse(200, {}); },
      };
      const result = await fetchAnalysisExportData(deps);
      check('fetch was never called', !fetchCalled);
      check('result status is unauthenticated', result.status === 'unauthenticated', result);
    }

    console.log('\n[B4 — Copy and Download build from the exact SAME shared fetch — outputs are identical]');
    {
      let fetchCallCount = 0;
      const deps: AnalysisExportDeps = {
        getAccessToken: async () => 'tok',
        fetchImpl: async () => { fetchCallCount++; return fakeResponse(200, { target_user_analysis_export: userAExport }); },
        writeText: async () => {},
        downloadFile: () => {},
      };

      const copyResult = await copyAnalysisExportToClipboard(deps);
      const downloadResult = await downloadAnalysisExportAsFile(deps);

      check('copy succeeded', copyResult.status === 'success', copyResult);
      check('download succeeded', downloadResult.status === 'success', downloadResult);
      if (copyResult.status === 'success' && downloadResult.status === 'success') {
        check('copy and download data are structurally identical', JSON.stringify(copyResult.data) === JSON.stringify(downloadResult.data));
      }
      check('each action independently fetched the export (2 calls total, no shared cache)', fetchCallCount === 2, fetchCallCount);
    }

    console.log('\n[B5 — copy writes exactly JSON.stringify(data, null, 2) to the clipboard]');
    {
      const captured: { text: string | null } = { text: null };
      const deps: AnalysisExportDeps = {
        getAccessToken: async () => 'tok',
        fetchImpl: async () => fakeResponse(200, { target_user_analysis_export: userAExport }),
        writeText: async (text) => { captured.text = text; },
        downloadFile: () => {},
      };
      const result = await copyAnalysisExportToClipboard(deps);
      check('result is success', result.status === 'success');
      check('copied text round-trips to exactly what the server returned', captured.text != null && JSON.stringify(JSON.parse(captured.text)) === JSON.stringify(userAExport), captured.text?.slice(0, 80));
      check('copied JSON is pretty-printed', captured.text != null && captured.text.includes('\n  '));
    }

    console.log('\n[B6 — download triggers exactly one file save, filename matches the required pattern, content identical to copy]');
    {
      const captured: { filename: string | null; json: string | null } = { filename: null, json: null };
      const deps: AnalysisExportDeps = {
        getAccessToken: async () => 'tok',
        fetchImpl: async () => fakeResponse(200, { target_user_analysis_export: userAExport }),
        writeText: async () => {},
        downloadFile: (filename, json) => { captured.filename = filename; captured.json = json; },
      };
      const result = await downloadAnalysisExportAsFile(deps);
      check('result is success', result.status === 'success', result);
      check('filename ends in .json', !!captured.filename?.endsWith('.json'), captured.filename);
      check('filename matches guitar-tracker-analysis-YYYY-MM-DD.json', !!captured.filename && /^guitar-tracker-analysis-\d{4}-\d{2}-\d{2}\.json$/.test(captured.filename), captured.filename);
      check('downloaded JSON round-trips to exactly what the server returned', captured.json != null && JSON.stringify(JSON.parse(captured.json)) === JSON.stringify(userAExport));

      // Same underlying data as a Copy done in the same "session" — content
      // identity, independent of which action the user pressed.
      const copyDeps: AnalysisExportDeps = { ...deps, writeText: async () => {} };
      const copyResult = await copyAnalysisExportToClipboard(copyDeps);
      if (copyResult.status === 'success' && captured.json != null) {
        check('download content === copy content (byte-identical JSON)', JSON.stringify(JSON.parse(captured.json)) === JSON.stringify(copyResult.data));
      }
    }

    console.log('\n[B7 — buildAnalysisExportFilename uses local calendar date, zero-padded]');
    {
      const name = buildAnalysisExportFilename(new Date(2026, 8, 5)); // month is 0-indexed: Sept 5, 2026
      check('single-digit month/day are zero-padded', name === 'guitar-tracker-analysis-2026-09-05.json', name);
    }

    console.log('\n[B8 — failed endpoint response copies/downloads nothing]');
    {
      let writeCalled = false; let downloadCalled = false;
      const deps: AnalysisExportDeps = {
        getAccessToken: async () => 'tok',
        fetchImpl: async () => fakeResponse(500, { error: 'Unexpected server error' }),
        writeText: async () => { writeCalled = true; },
        downloadFile: () => { downloadCalled = true; },
      };
      const copyResult = await copyAnalysisExportToClipboard(deps);
      const downloadResult = await downloadAnalysisExportAsFile(deps);
      check('writeText was never called', !writeCalled);
      check('downloadFile was never called', !downloadCalled);
      check('copy result is request_failed', copyResult.status === 'request_failed', copyResult);
      check('download result is request_failed', downloadResult.status === 'request_failed', downloadResult);
      if (copyResult.status === 'request_failed') check('message never echoes the raw server error body', !copyResult.message.includes('Unexpected server error'));
    }

    console.log('\n[B9 — clipboard write denied: safe failure, no crash]');
    {
      const deps: AnalysisExportDeps = {
        getAccessToken: async () => 'tok',
        fetchImpl: async () => fakeResponse(200, { target_user_analysis_export: userAExport }),
        writeText: async () => { throw new Error('NotAllowedError: permission denied'); },
        downloadFile: () => {},
      };
      const result = await copyAnalysisExportToClipboard(deps);
      check('result status is clipboard_failed (not a thrown exception)', result.status === 'clipboard_failed', result);
      if (result.status === 'clipboard_failed') check('message never leaks the raw clipboard error', !result.message.includes('NotAllowedError'));
    }

    console.log('\n[B10 — concurrent copy prevented (in-flight guard)]');
    {
      let fetchCallCount = 0;
      let resolveFirst: (() => void) | null = null;
      const deps: AnalysisExportDeps = {
        getAccessToken: async () => 'tok',
        fetchImpl: async () => {
          fetchCallCount++;
          if (fetchCallCount === 1) await new Promise<void>((resolve) => { resolveFirst = resolve; });
          return fakeResponse(200, { target_user_analysis_export: userAExport });
        },
        writeText: async () => {},
        downloadFile: () => {},
      };
      const copier = createAnalysisExportCopier(deps);

      const firstCall = copier.copy();
      const secondResult = await copier.copy();
      check('second concurrent call is rejected as already_in_progress', secondResult.status === 'already_in_progress', secondResult);
      check('fetch was only called once so far', fetchCallCount === 1, fetchCallCount);

      resolveFirst!();
      const firstResult = await firstCall;
      check('first call still completes successfully', firstResult.status === 'success', firstResult);

      const thirdResult = await copier.copy();
      check('a new call after completion is allowed through', thirdResult.status === 'success', thirdResult);
      check('fetch was called exactly twice total', fetchCallCount === 2, fetchCallCount);
    }

    console.log('\n[B11 — concurrent download prevented (independent in-flight guard from copy)]');
    {
      let fetchCallCount = 0;
      let resolveFirst: (() => void) | null = null;
      const deps: AnalysisExportDeps = {
        getAccessToken: async () => 'tok',
        fetchImpl: async () => {
          fetchCallCount++;
          if (fetchCallCount === 1) await new Promise<void>((resolve) => { resolveFirst = resolve; });
          return fakeResponse(200, { target_user_analysis_export: userAExport });
        },
        writeText: async () => {},
        downloadFile: () => {},
      };
      const downloader = createAnalysisExportDownloader(deps);

      const firstCall = downloader.download();
      const secondResult = await downloader.download();
      check('second concurrent download is rejected as already_in_progress', secondResult.status === 'already_in_progress', secondResult);

      resolveFirst!();
      const firstResult = await firstCall;
      check('first download still completes successfully', firstResult.status === 'success', firstResult);
    }

    console.log('\n[B12 — no token is rendered or logged]');
    {
      const SECRET_TOKEN = 'super-secret-export-token-should-never-leak';
      const originalConsole = { log: console.log, error: console.error, warn: console.warn };
      const consoleCalls: unknown[][] = [];
      console.log = (...args: unknown[]) => { consoleCalls.push(args); };
      console.error = (...args: unknown[]) => { consoleCalls.push(args); };
      console.warn = (...args: unknown[]) => { consoleCalls.push(args); };
      try {
        const deps: AnalysisExportDeps = {
          getAccessToken: async () => SECRET_TOKEN,
          fetchImpl: async () => fakeResponse(500, { error: 'boom' }),
          writeText: async () => {},
          downloadFile: () => {},
        };
        await copyAnalysisExportToClipboard(deps);
        await downloadAnalysisExportAsFile({ ...deps, fetchImpl: async () => fakeResponse(200, { target_user_analysis_export: userAExport }) });
      } finally {
        console.log = originalConsole.log; console.error = originalConsole.error; console.warn = originalConsole.warn;
      }
      check('nothing was ever logged to the console', consoleCalls.length === 0, consoleCalls);
      check('the secret token never appears in console output', !JSON.stringify(consoleCalls).includes(SECRET_TOKEN));
    }
  } finally {
    console.log('\n=== Cleanup ===');
    if (createdListingIds.length) { const { error } = await admin.from('item_listings').delete().in('id', createdListingIds); check('cleanup: item_listings deleted', !error, error); }
    if (createdItemIds.length) await admin.from('deal_items').delete().in('item_id', createdItemIds);
    if (createdDealIds.length) await admin.from('deals').delete().in('id', createdDealIds);
    if (createdItemIds.length) { const { error } = await admin.from('inventory_items').delete().in('id', createdItemIds); check('cleanup: inventory_items deleted', !error, error); }

    const { data: remainingItems } = await admin.from('inventory_items').select('id').in('id', createdItemIds.length ? createdItemIds : [-1]);
    check('all fixture items deleted', (remainingItems?.length ?? 0) === 0, remainingItems);
    const { data: remainingPriceHistory } = await admin.from('item_listing_price_history').select('id').in('item_listing_id', createdListingIds.length ? createdListingIds : [-1]);
    check('all fixture price history cascade-deleted with their item_listings', (remainingPriceHistory?.length ?? 0) === 0, remainingPriceHistory);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
