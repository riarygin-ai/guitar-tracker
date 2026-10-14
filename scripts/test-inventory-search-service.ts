/**
 * test-inventory-search-service.ts
 *
 * Coverage for src/lib/inventorySearchService.ts — the server-callable
 * search used by the read-only MCP search_inventory tool: term matching,
 * response trimming, empty/no-match behavior, cross-user isolation, and
 * the default status filter (excludes sold/traded, matching
 * searchInventoryItems' own existing default).
 *
 * Usage:  npx tsx scripts/test-inventory-search-service.ts
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning, setupAnalyticsTestFixtures,
} from './setup-analytics-test-fixtures';
import { searchInventoryForUser, INVENTORY_SEARCH_MAX_RESULTS } from '../src/lib/inventorySearchService';

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

const EXPECTED_FIELDS = ['item_id', 'brand', 'model', 'year', 'color', 'category', 'type', 'purpose', 'status', 'serial_number'].sort();

async function main() {
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  console.log('\n[fixtures] Ensuring shared local test fixtures exist...');
  const fixtures = await setupAnalyticsTestFixtures(admin);
  const clientA = await signIn(fixtures.userAEmail, fixtures.password);
  const clientB = await signIn(fixtures.userBEmail, fixtures.password);

  console.log('\n[A — free-text term matching]');
  {
    const byBrand = await searchInventoryForUser(clientA, { query: 'Fender' });
    check('a brand-name query returns at least one match', byBrand.length > 0, byBrand);
    check('every returned row genuinely matches (brand, model, color, year or serial)', byBrand.every((r) =>
      r.brand.toLowerCase().includes('fender') || r.model.toLowerCase().includes('fender')));

    const multiTerm = await searchInventoryForUser(clientA, { query: 'fender telecaster' });
    check('multi-term query requires every term to match (AND, not OR)', multiTerm.every((r) =>
      /fender/i.test(r.brand) && /telecaster/i.test(r.model)));

    const caseInsensitive = await searchInventoryForUser(clientA, { query: 'FENDER' });
    check('matching is case-insensitive', caseInsensitive.length === byBrand.length);
  }

  console.log('\n[B — empty / no-match search]');
  {
    const noMatch = await searchInventoryForUser(clientA, { query: 'ZZZ_NONEXISTENT_MODEL_ZZZ' });
    check('a query matching nothing returns an empty array, not an error', Array.isArray(noMatch) && noMatch.length === 0);

    const empty = await searchInventoryForUser(clientA, {});
    check('an empty query returns results (no filtering applied) rather than nothing', empty.length > 0);
  }

  console.log('\n[C — response trimming: exactly the intended small shape]');
  {
    const results = await searchInventoryForUser(clientA, { query: 'Fender' });
    check('at least one result to inspect', results.length > 0);
    const keys = Object.keys(results[0]).sort();
    check('result keys are EXACTLY the trimmed identity shape (no extra fields)', JSON.stringify(keys) === JSON.stringify(EXPECTED_FIELDS), keys);
    const asJson = JSON.stringify(results);
    check('no "notes" field anywhere in the response', !/"notes"/.test(asJson));
    check('no financial fields (value_in/value_out/estimated_sold_value/expenses) anywhere', !/value_in|value_out|estimated_sold_value|expenses|realized|potential/i.test(asJson));
    check('no leads/listing-history fields anywhere', !/lead|listing_cycle|price_history/i.test(asJson));
    check('no user/owner identifier of any kind in a result row', !('user_id' in results[0]) && !/user_id|owner_id|auth_user_id/.test(asJson));
  }

  console.log('\n[D — status filtering]');
  {
    const defaultResults = await searchInventoryForUser(clientA, {});
    check('default excludes sold/traded (matches existing searchInventoryItems default)', defaultResults.every((r) => r.status !== 'sold' && r.status !== 'traded'));

    const explicitSold = await searchInventoryForUser(clientA, { status: ['sold'] });
    check('an explicit status filter is honored (only sold returned, or none exist)', explicitSold.every((r) => r.status === 'sold'));
  }

  console.log('\n[E — brand / purpose structured filters]');
  {
    const byBrandFilter = await searchInventoryForUser(clientA, { brand: 'fender' });
    check('brand filter matches case-insensitively', byBrandFilter.length > 0 && byBrandFilter.every((r) => r.brand.toLowerCase().includes('fender')));

    const byBrandFilterNoMatch = await searchInventoryForUser(clientA, { brand: 'ZZZ_NO_SUCH_BRAND' });
    check('a brand filter matching nothing returns empty, not an error', byBrandFilterNoMatch.length === 0);
  }

  console.log('\n[F — max results cap]');
  {
    const results = await searchInventoryForUser(clientA, {});
    check(`results never exceed the documented max (${INVENTORY_SEARCH_MAX_RESULTS})`, results.length <= INVENTORY_SEARCH_MAX_RESULTS);
  }

  console.log('\n[G — cross-user isolation: search returns ONLY the authenticated caller\'s inventory]');
  {
    const aResults = await searchInventoryForUser(clientA, {});
    const bResults = await searchInventoryForUser(clientB, {});
    check('user A has results', aResults.length > 0);
    check('user B has results', bResults.length > 0);
    const aIds = new Set(aResults.map((r) => r.item_id));
    const bIds = new Set(bResults.map((r) => r.item_id));
    check('no item_id appears in both users\' result sets (disjoint inventories)', Array.from(aIds).every((id) => !bIds.has(id)));

    const bSearchingForAsBrand = await searchInventoryForUser(clientB, { query: 'Fender' });
    check('user B searching for a term that matches user A\'s items never returns user A\'s item ids', bSearchingForAsBrand.every((r) => !aIds.has(r.item_id)));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
