/**
 * test-lead-activity-service.ts
 *
 * Coverage for src/lib/analytics/leadActivityService.ts — the
 * server-callable dataset behind the read-only MCP get_lead_activity
 * tool. Confirms it reuses listing_demand_item_activity_v1_0 (the EXACT
 * "Lead Activity by Item" dataset, migration 20260919000000) unmodified
 * via the new self-scoped RPC wrapper (migration 20261013000000), that
 * its numbers match the existing service_role path exactly, and that
 * optional filtering never crosses users.
 *
 * Usage:  npx tsx scripts/test-lead-activity-service.ts
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning, setupAnalyticsTestFixtures,
} from './setup-analytics-test-fixtures';
import { getLeadActivityForUser, applyLeadActivityFilters } from '../src/lib/analytics/leadActivityService';
import { getListingItemActivity } from '../src/lib/analytics/listingItemActivity';

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

function toDateOnly(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// A "wide but still within the 400-day cap" window, wider than the 28-day
// default so it can plausibly surface more fixture activity — distinct
// from section G's deliberately >400-day window, which must stay that way.
const WIDE_START = toDateOnly(new Date(Date.now() - 300 * 86400000));

async function main() {
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  console.log('\n[fixtures] Ensuring shared local test fixtures exist...');
  const fixtures = await setupAnalyticsTestFixtures(admin);
  const clientA = await signIn(fixtures.userAEmail, fixtures.password);
  const clientB = await signIn(fixtures.userBEmail, fixtures.password);

  console.log('\n[A — {} returns the default (last 28 days) window and matches the existing service_role path exactly]');
  {
    const result = await getLeadActivityForUser(clientA, {});
    const today = toDateOnly(new Date());
    const expectedStart = toDateOnly(new Date(Date.now() - 27 * 86400000));
    check('end_date defaults to today', result.end_date === today, result.end_date);
    check('start_date defaults to 28 days before end_date', result.start_date === expectedStart, result.start_date);

    const viaServiceRole = await getListingItemActivity({ appUserId: fixtures.userAId, serviceClient: admin, startDate: result.start_date, endDate: result.end_date });
    check('item count matches the existing service_role-driven path exactly', result.items.length === viaServiceRole.length, { mcp: result.items.length, serviceRole: viaServiceRole.length });
    check('aggregate numbers match exactly (same canonical computation, not recomputed)', JSON.stringify([...result.items].sort((a, b) => a.item_id - b.item_id)) === JSON.stringify([...viaServiceRole].sort((a, b) => a.item_id - b.item_id)));
  }

  console.log('\n[B — item grouping/aggregates: every row has the expected shape]');
  {
    const result = await getLeadActivityForUser(clientA, {});
    check('at least one item in the default window', result.items.length > 0, result.items.length);
    check('every row has the canonical fields (item_id, active_channels, attributed-lead counts)', result.items.every((i) =>
      typeof i.item_id === 'number' &&
      Array.isArray(i.active_channels) &&
      typeof i.item_attributed_leads === 'number' &&
      typeof i.serious_plus_attributed_leads === 'number' &&
      typeof i.offer_attributed_leads === 'number'));
    check('serious_plus_attributed_leads never exceeds item_attributed_leads (subset, by definition)', result.items.every((i) => i.serious_plus_attributed_leads <= i.item_attributed_leads));
    check('offer_attributed_leads never exceeds item_attributed_leads (subset, by definition)', result.items.every((i) => i.offer_attributed_leads <= i.item_attributed_leads));
  }

  console.log('\n[C — explicit from_date/to_date]');
  {
    const wide = await getLeadActivityForUser(clientA, { from_date: WIDE_START, to_date: toDateOnly(new Date()) });
    check('explicit wide window is honored (not silently clamped to 28 days)', wide.start_date === WIDE_START);
    check('a wide-enough window surfaces at least as many items as the default window', wide.items.length >= (await getLeadActivityForUser(clientA, {})).items.length);
  }

  console.log('\n[D — item_ids filter]');
  {
    const all = await getLeadActivityForUser(clientA, { from_date: WIDE_START, to_date: toDateOnly(new Date()) });
    const targetId = all.items[0]?.item_id;
    check('fixture has at least one item-activity row to target', targetId != null);
    const filtered = await getLeadActivityForUser(clientA, { from_date: WIDE_START, to_date: toDateOnly(new Date()), item_ids: [targetId!] });
    check('item_ids filter returns exactly the one requested item', filtered.items.length === 1 && filtered.items[0].item_id === targetId);
  }

  console.log('\n[E — channel filter]');
  {
    const all = await getLeadActivityForUser(clientA, { from_date: WIDE_START, to_date: toDateOnly(new Date()) });
    const withChannel = all.items.find((i) => i.active_channels.length > 0);
    check('fixture has at least one item with an active channel', !!withChannel, all.items.map((i) => i.active_channels));
    const channelName = withChannel!.active_channels[0].channel_name;
    const filtered = await getLeadActivityForUser(clientA, { from_date: WIDE_START, to_date: toDateOnly(new Date()), channel: [channelName] });
    check('channel filter returns only items currently listed on that channel', filtered.items.length > 0 && filtered.items.every((i) => i.active_channels.some((c) => c.channel_name === channelName)));
    const noMatch = await getLeadActivityForUser(clientA, { from_date: WIDE_START, to_date: toDateOnly(new Date()), channel: ['ZZZ_NO_SUCH_CHANNEL'] });
    check('a channel that matches nothing returns an empty array, not an error', noMatch.items.length === 0);
  }

  console.log('\n[F — combined item_ids + channel behaves predictably]');
  {
    const all = await getLeadActivityForUser(clientA, { from_date: WIDE_START, to_date: toDateOnly(new Date()) });
    const withChannel = all.items.find((i) => i.active_channels.length > 0)!;
    const combined = await getLeadActivityForUser(clientA, {
      from_date: WIDE_START, to_date: toDateOnly(new Date()),
      item_ids: [withChannel.item_id], channel: [withChannel.active_channels[0].channel_name],
    });
    check('matching item_ids + channel returns exactly that one item', combined.items.length === 1 && combined.items[0].item_id === withChannel.item_id);

    const contradictory = await getLeadActivityForUser(clientA, {
      from_date: WIDE_START, to_date: toDateOnly(new Date()),
      item_ids: [withChannel.item_id], channel: ['ZZZ_NO_SUCH_CHANNEL'],
    });
    check('a contradictory combination (real item, impossible channel) returns empty, not an error', contradictory.items.length === 0);
  }

  console.log('\n[G — validation]');
  {
    let threw = false;
    try { await getLeadActivityForUser(clientA, { from_date: '2026-02-01', to_date: '2026-01-01' }); } catch { threw = true; }
    check('from_date after to_date is rejected', threw);

    threw = false;
    try { await getLeadActivityForUser(clientA, { from_date: '2020-01-01', to_date: '2021-06-01' }); } catch { threw = true; }
    check('a window wider than 400 days is rejected (same cap as /api/listing-item-activity)', threw);
  }

  console.log('\n[H — pure filter never mutates its input]');
  {
    const result = await getLeadActivityForUser(clientA, {});
    const before = JSON.stringify(result.items);
    applyLeadActivityFilters(result.items, { item_ids: [1] });
    check('the canonical items array is unchanged after being filtered', JSON.stringify(result.items) === before);
  }

  console.log('\n[I — cross-user isolation]');
  {
    const aResult = await getLeadActivityForUser(clientA, { from_date: WIDE_START, to_date: toDateOnly(new Date()) });
    const bResult = await getLeadActivityForUser(clientB, { from_date: WIDE_START, to_date: toDateOnly(new Date()) });
    const aIds = new Set(aResult.items.map((i) => i.item_id));
    const bIds = new Set(bResult.items.map((i) => i.item_id));
    // User B's shared fixture rows have no item_listings at all (built
    // primarily for other suites) — listing_demand_item_activity_v1_0 is
    // scoped to CURRENTLY LISTED items by definition, so an empty result
    // for user B here is correct, not a bug. The isolation checks below
    // (same-id overlap, cross-user probing) are what actually matter.
    check('user A has item-activity rows', aIds.size > 0);
    check('no item id appears in both users\' lead-activity datasets', Array.from(aIds).every((id) => !bIds.has(id)));

    if (aResult.items[0]) {
      const bProbingForAsItem = await getLeadActivityForUser(clientB, { from_date: WIDE_START, to_date: toDateOnly(new Date()), item_ids: [aResult.items[0].item_id] });
      check('user B requesting user A\'s real item_id via the filter returns nothing (not user A\'s row)', bProbingForAsItem.items.length === 0);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
