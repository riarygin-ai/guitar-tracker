/**
 * test-inventory-analysis-service.ts
 *
 * Coverage for src/lib/analytics/inventoryAnalysisService.ts — the
 * server-callable dataset behind the read-only MCP get_inventory_analysis
 * tool. Confirms it reuses buildAnalysisExportData (the EXACT "Copy/
 * Download Analysis Data" dataset builder) unmodified, that the new
 * self-scoped RPC wrapper (build_listing_evidence_v1_0_for_current_user,
 * migration 20261013000000) resolves identity itself, and that optional
 * filtering never mutates the canonical dataset or crosses users.
 *
 * Usage:  npx tsx scripts/test-inventory-analysis-service.ts
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning, setupAnalyticsTestFixtures,
} from './setup-analytics-test-fixtures';
import {
  getCanonicalInventoryAnalysis, applyInventoryAnalysisFilters, getInventoryAnalysisForUser,
} from '../src/lib/analytics/inventoryAnalysisService';
import { getListingEvidenceForCurrentUser } from '../src/lib/analytics/listingEvidence';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}

async function signIn(email: string, password: string): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`sign-in failed for ${email}: ${error?.message}`);
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
    auth: { persistSession: false },
  });
}

async function main() {
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  console.log('\n[fixtures] Ensuring shared local test fixtures exist...');
  const fixtures = await setupAnalyticsTestFixtures(admin);
  const clientA = await signIn(fixtures.userAEmail, fixtures.password);
  const clientB = await signIn(fixtures.userBEmail, fixtures.password);

  console.log('\n[A — {} returns the same canonical dataset as the existing service_role Analysis Export path]');
  {
    const canonical = await getCanonicalInventoryAnalysis(clientA);

    // The pre-existing, service_role-driven path (same evidence, different
    // transport) — used here ONLY as an independent cross-check, never as
    // part of the MCP tool's own code path.
    const evidenceViaServiceRole = await getListingEvidenceForCurrentUser({ appUserId: fixtures.userAId, serviceClient: admin });

    check('population_summary matches the service_role path exactly (same underlying evidence)', JSON.stringify(canonical.summary) === JSON.stringify(evidenceViaServiceRole.population_summary));
    check('listed_items count matches', canonical.listed_items.length === evidenceViaServiceRole.listed_items.length);
    check('at least one listed item present (realistic fixture)', canonical.listed_items.length > 0, canonical.listed_items.length);
    check('scope is "all" (never narrowed to one channel) for the default call', canonical.scope.type === 'all');
  }

  console.log('\n[B — listed AND unlisted open items both represented]');
  {
    const canonical = await getCanonicalInventoryAnalysis(clientA);
    const unlistedTotal = canonical.unlisted_business_items.length + canonical.unlisted_hybrid_items.length + canonical.unlisted_unclassified_items.length;
    check('listed_items is non-empty', canonical.listed_items.length > 0);
    check('at least one unlisted bucket is non-empty (fixture has unlisted open items too)', unlistedTotal > 0, unlistedTotal);
  }

  console.log('\n[C — listing history is preserved, including price history]');
  {
    const before = await getCanonicalInventoryAnalysis(clientA);
    const withHistory = before.listed_items.find((i) => i.listing_history.length > 0);
    check('at least one item carries listing_history', !!withHistory, before.listed_items.map((i) => i.listing_history.length));

    // The shared analytics fixture (built for other suites) doesn't happen
    // to include a price CHANGE — seed exactly one directly so this check
    // actually exercises price_history pass-through rather than trusting
    // an empty array. buildAnalysisExportData itself (the function this
    // service reuses unmodified) already has its own dedicated coverage
    // elsewhere; this is only confirming the wiring here surfaces it.
    const listingId = withHistory!.listing_history[0].id;
    await admin.from('item_listing_price_history').insert({
      user_id: fixtures.userAId, item_listing_id: listingId, old_asking_price: 100, new_asking_price: 120, changed_at: new Date().toISOString(),
    });

    const after = await getCanonicalInventoryAnalysis(clientA);
    const item = after.listed_items.find((i) => i.listing_history.some((c) => c.id === listingId));
    const cycle = item?.listing_history.find((c) => c.id === listingId);
    check('listing_history entries carry their own price_history (not collapsed to latest price only)', !!cycle && cycle.price_history.some((p) => p.new_asking_price === 120));

    await admin.from('item_listing_price_history').delete().eq('item_listing_id', listingId).eq('new_asking_price', 120);
  }

  console.log('\n[D — single filter: brand]');
  {
    const result = await getInventoryAnalysisForUser(clientA, { brand: ['Fender'] });
    const all = [...result.data.listed_items, ...result.data.unlisted_business_items, ...result.data.unlisted_hybrid_items, ...result.data.unlisted_unclassified_items];
    check('at least one Fender item matched', all.length > 0, all.length);
    check('every returned item is actually Fender (case-insensitive exact match, not substring)', all.every((i) => i.brand_name?.toLowerCase() === 'fender'));
  }

  console.log('\n[E — single filter: status]');
  {
    const listedOnly = await getInventoryAnalysisForUser(clientA, { status: ['listed'] });
    check('status: ["listed"] returns listed_items but no unlisted buckets', listedOnly.data.listed_items.length > 0 && listedOnly.data.unlisted_business_items.length === 0 && listedOnly.data.unlisted_hybrid_items.length === 0 && listedOnly.data.unlisted_unclassified_items.length === 0);

    const unlistedOnly = await getInventoryAnalysisForUser(clientA, { status: ['unlisted'] });
    check('status: ["unlisted"] returns no listed_items', unlistedOnly.data.listed_items.length === 0);
  }

  console.log('\n[F — multiple combined filters]');
  {
    const result = await getInventoryAnalysisForUser(clientA, { brand: ['Fender'], status: ['listed'] });
    check('combined brand+status: every item is Fender AND listed (no unlisted buckets)', result.data.listed_items.every((i) => i.brand_name?.toLowerCase() === 'fender') && result.data.unlisted_business_items.length === 0 && result.data.unlisted_hybrid_items.length === 0 && result.data.unlisted_unclassified_items.length === 0);
  }

  console.log('\n[G — item_ids filter]');
  {
    const canonical = await getCanonicalInventoryAnalysis(clientA);
    const targetId = canonical.listed_items[0]?.item_id ?? canonical.unlisted_business_items[0]?.item_id;
    check('fixture has at least one item to target', targetId != null);
    const result = await getInventoryAnalysisForUser(clientA, { item_ids: [targetId!] });
    const all = [...result.data.listed_items, ...result.data.unlisted_business_items, ...result.data.unlisted_hybrid_items, ...result.data.unlisted_unclassified_items];
    check('item_ids filter returns exactly the one requested item', all.length === 1 && all[0].item_id === targetId);
  }

  console.log('\n[H — include_listing_history: false strips history without changing counts]');
  {
    const full = await getInventoryAnalysisForUser(clientA, {});
    const stripped = await getInventoryAnalysisForUser(clientA, { include_listing_history: false });
    check('item_count is identical with history stripped', full.item_count === stripped.item_count);
    check('listing_history is empty on every item when stripped', stripped.data.listed_items.every((i) => i.listing_history.length === 0));
    check('listing_history is still present (non-empty somewhere) when not stripped', full.data.listed_items.some((i) => i.listing_history.length > 0));
  }

  console.log('\n[I — filtering never mutates the canonical dataset]');
  {
    const canonical = await getCanonicalInventoryAnalysis(clientA);
    const before = JSON.stringify(canonical);
    applyInventoryAnalysisFilters(canonical, { brand: ['Fender'], status: ['listed'], include_listing_history: false });
    applyInventoryAnalysisFilters(canonical, { item_ids: [999999] });
    check('the canonical object is byte-identical after being filtered twice with different filters', JSON.stringify(canonical) === before);
  }

  console.log('\n[J — cross-user isolation]');
  {
    const aCanonical = await getCanonicalInventoryAnalysis(clientA);
    const bCanonical = await getCanonicalInventoryAnalysis(clientB);
    const aIds = new Set([...aCanonical.listed_items, ...aCanonical.unlisted_business_items, ...aCanonical.unlisted_hybrid_items, ...aCanonical.unlisted_unclassified_items].map((i) => i.item_id));
    const bIds = new Set([...bCanonical.listed_items, ...bCanonical.unlisted_business_items, ...bCanonical.unlisted_hybrid_items, ...bCanonical.unlisted_unclassified_items].map((i) => i.item_id));
    check('user A has items', aIds.size > 0);
    check('user B has items', bIds.size > 0);
    check('no item id appears in both users\' datasets', Array.from(aIds).every((id) => !bIds.has(id)));

    const bFilteredForAsBrand = await getInventoryAnalysisForUser(clientB, { brand: ['Fender'] });
    const bFiltered = [...bFilteredForAsBrand.data.listed_items, ...bFilteredForAsBrand.data.unlisted_business_items, ...bFilteredForAsBrand.data.unlisted_hybrid_items, ...bFilteredForAsBrand.data.unlisted_unclassified_items];
    check('user B filtering by a brand that exists in user A\'s inventory never returns user A\'s item ids', bFiltered.every((i) => !aIds.has(i.item_id)));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
