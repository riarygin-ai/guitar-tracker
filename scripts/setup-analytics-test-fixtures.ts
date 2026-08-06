/**
 * scripts/setup-analytics-test-fixtures.ts
 *
 * Local-only, deterministic fixture bootstrap for scripts/test-analytics-runner.ts.
 * Creates two auth users, their app_users records, reference data, and a
 * NAMED, idempotent set of inventory/deal/listing scenarios — returned as a
 * manifest (`FixtureResult.items`, keyed by descriptive scenario name ->
 * the actual locally-generated `inventory_items.id`) so tests never need to
 * hardcode a magic numeric item_id. `FixtureResult.expected` carries a
 * handful of numeric expectations computed directly from this file's own
 * fixture-input constants (never copied from a prior test run's output,
 * never read back from the analytics result being verified).
 *
 * ── WHY NAMED SCENARIOS INSTEAD OF LITERAL IDS ──────────────────────────
 * `inventory_items.id` is `GENERATED ALWAYS AS IDENTITY` — there is no way
 * to choose it directly. An earlier version of this file left item
 * creation anonymous and asked tests to guess historical literal IDs (2,
 * 44, 104, ...) inherited from a long-gone, never-committed fixture
 * script. That doesn't work: IDs depend on exact insertion order/count,
 * which nothing in this repository records. This version instead tags
 * every fixture item's `serial_number` with a stable `FIXTURE:<key>`
 * marker, looks that marker up on every run, and returns a name -> id
 * manifest — the identity value is still whatever Postgres assigns, but
 * nothing outside this file ever needs to know or guess it.
 *
 * ── SAFETY ────────────────────────────────────────────────────────────
 * Hard-fails unless the resolved Supabase URL's hostname is localhost /
 * 127.0.0.1 / ::1, and hard-fails if that local instance isn't actually
 * reachable. Never reads .env.local or any production credential — every
 * connection value comes from process.env (shell-exported only) with
 * well-known, publicly-documented Supabase LOCAL DEV demo defaults
 * (same fixed demo JWTs every `supabase start` on every machine uses)
 * so this also works out of the box with zero env setup.
 *
 * Idempotent: running twice is safe — every scenario is looked up by its
 * `FIXTURE:<key>` serial_number marker before being (re)created, so a
 * partial prior run resumes cleanly instead of duplicating or skipping
 * wholesale.
 *
 * Usage:
 *   npx tsx scripts/setup-analytics-test-fixtures.ts
 *
 * Also importable — scripts/test-analytics-runner.ts calls
 * `setupAnalyticsTestFixtures()` directly rather than re-running this
 * file as a subprocess.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ── Local-only connection — NEVER dotenv.config()'d from .env.local. ───────
// These are Supabase's own well-known, publicly documented local-dev demo
// values (issuer "supabase-demo"), identical on every machine that runs
// `supabase start` with default config — not a secret, and never valid
// against any real/remote project.
const LOCAL_SUPABASE_URL_DEFAULT = 'http://127.0.0.1:54321';
const LOCAL_SERVICE_ROLE_KEY_DEFAULT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const LOCAL_ANON_KEY_DEFAULT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || LOCAL_SUPABASE_URL_DEFAULT;
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || LOCAL_SERVICE_ROLE_KEY_DEFAULT;
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || LOCAL_ANON_KEY_DEFAULT;

export const TEST_USER_A_EMAIL = 'analytics-fixture-user-a@example.test';
export const TEST_USER_B_EMAIL = 'analytics-fixture-user-b@example.test';
export const TEST_USER_PASSWORD = 'Analytics-Fixture-Local-Only-1!';

// ── Safety guards ────────────────────────────────────────────────────────

export function resolvedSupabaseUrlHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    throw new Error(`Refusing to run: could not parse Supabase URL "${url}".`);
  }
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

// The local Supabase CLI's fixed API port for this project (supabase/config.toml
// [api] port = 54321) — never the hosted `https://<ref>.supabase.co` origin,
// which carries no port at all. Checking the port in addition to the hostname
// means a hostname-only allowlist can't be satisfied by some future local
// proxy/tunnel that forwards a "localhost" name to a remote database.
const LOCAL_SUPABASE_API_PORT = '54321';

/** Hard-fails unless `url`'s hostname is localhost/127.0.0.1/::1 AND (when a
 *  port is present in the URL, which the local stack always sets) that port
 *  is exactly the local Supabase CLI's API port. Always prints the resolved
 *  URL first, so a caller never runs anything destructive without seeing
 *  exactly what it's about to touch.
 *
 *  This is a fail-closed allowlist, not a denylist: it does not attempt to
 *  recognize "*.supabase.co" and block it specifically — any hostname other
 *  than the three local ones is rejected outright, so a hosted project ref
 *  can never pass regardless of what it looks like. There is deliberately no
 *  environment-variable escape hatch (e.g. an "ALLOW_REMOTE_TEST_DB" flag) —
 *  a database-writing test that needs to run against something other than
 *  the disposable local stack should not exist. */
export function assertLocalSupabaseUrl(url: string): void {
  console.log(`[safety] Resolved Supabase URL: ${url}`);
  const hostname = resolvedSupabaseUrlHostname(url);
  const parsed = new URL(url);
  if (!LOCAL_HOSTNAMES.has(hostname)) {
    throw new Error(
      `Refusing to run: Supabase URL "${url}" (hostname "${hostname}") is not local. ` +
      'This script must only ever run against a disposable local Supabase stack. ' +
      'Run `supabase start`, and if NEXT_PUBLIC_SUPABASE_URL is exported in your shell, ' +
      'point it at http://127.0.0.1:54321 before retrying. .env.local is never read by this script.',
    );
  }
  if (parsed.port && parsed.port !== LOCAL_SUPABASE_API_PORT) {
    throw new Error(
      `Refusing to run: Supabase URL "${url}" has hostname "${hostname}" (local) but port ` +
      `"${parsed.port}" does not match the local Supabase CLI's API port (${LOCAL_SUPABASE_API_PORT}). ` +
      'Run `supabase status` to confirm the correct local API URL before retrying.',
    );
  }
}

/** Hard-fails if the local instance at `url` isn't actually reachable —
 *  distinguishes "wrong URL" from "right URL, stack not running". Hits
 *  PostgREST's root endpoint (proven reliable through the local Kong
 *  gateway) rather than /auth/v1/health, which was observed to hang
 *  indefinitely through this project's local gateway routing. */
export async function assertLocalSupabaseIsRunning(url: string, apikey: string): Promise<void> {
  try {
    const res = await fetch(`${url}/rest/v1/`, { headers: { apikey }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`health check returned HTTP ${res.status}`);
  } catch (err) {
    throw new Error(
      `Refusing to run: local Supabase does not appear to be running at ${url} ` +
      `(${err instanceof Error ? err.message : String(err)}). Run \`supabase start\` first.`,
    );
  }
}

// ── Small helpers ────────────────────────────────────────────────────────

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Matches PERCENTILE_CONT(0.5) over exactly two values — linear
 *  interpolation at the midpoint, which for n=2 is the plain average. */
function median2(a: number, b: number): number {
  return (a + b) / 2;
}

async function ensureAuthUser(admin: SupabaseClient, email: string): Promise<string> {
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: TEST_USER_PASSWORD,
    email_confirm: true,
  });
  if (!createError && created.user) return created.user.id;

  // Already exists — look it up. listUsers is paginated; this fixture
  // set is small enough that a couple of pages is always enough, but we
  // page defensively rather than assume page 1 always has it.
  for (let page = 1; page <= 20; page++) {
    const { data: listed, error: listError } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (listError) throw new Error(`Failed to list auth users while resolving ${email}: ${listError.message}`);
    const match = listed.users.find((u) => u.email === email);
    if (match) return match.id;
    if (listed.users.length < 200) break;
  }
  throw new Error(`Could not create or find auth user ${email}: ${createError?.message}`);
}

async function resolveAppUserId(admin: SupabaseClient, authUserId: string, email: string): Promise<number> {
  // handle_new_auth_user() fires synchronously on auth.users insert, so
  // the app_users row should already exist — poll briefly in case of
  // any replication lag on a slow machine.
  for (let attempt = 0; attempt < 10; attempt++) {
    const { data, error } = await admin.from('app_users').select('id').eq('auth_user_id', authUserId).maybeSingle();
    if (error) throw new Error(`Failed to resolve app_users row for ${email}: ${error.message}`);
    if (data) return data.id as number;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`app_users row for ${email} (auth_user_id=${authUserId}) never appeared — handle_new_auth_user trigger may be broken.`);
}

async function ensureBrand(admin: SupabaseClient, name: string): Promise<number> {
  const { data: existing } = await admin.from('brands').select('id').eq('name', name).maybeSingle();
  if (existing) return existing.id as number;
  const { data: created, error } = await admin.from('brands').insert({ name }).select('id').single();
  if (error) throw new Error(`Failed to create brand "${name}": ${error.message}`);
  return created.id as number;
}

async function ensureSubtype(admin: SupabaseClient, categoryName: string, subtypeName: string): Promise<number> {
  const { data: category, error: categoryError } = await admin
    .from('item_categories').select('id').eq('name', categoryName).maybeSingle();
  if (categoryError || !category) throw new Error(`Category "${categoryName}" not found: ${categoryError?.message ?? 'no row'}`);
  const { data: existing } = await admin
    .from('item_subtypes').select('id').eq('category_id', category.id).eq('name', subtypeName).maybeSingle();
  if (existing) return existing.id as number;
  const { data: created, error } = await admin
    .from('item_subtypes').insert({ category_id: category.id, name: subtypeName }).select('id').single();
  if (error) throw new Error(`Failed to create subtype "${categoryName}/${subtypeName}": ${error.message}`);
  return created.id as number;
}

async function ensurePurpose(admin: SupabaseClient, name: string): Promise<number> {
  const { data: existing } = await admin.from('item_purposes').select('id').ilike('name', name).maybeSingle();
  if (existing) return existing.id as number;
  const { data: created, error } = await admin.from('item_purposes').insert({ name }).select('id').single();
  if (error) throw new Error(`Failed to create purpose "${name}": ${error.message}`);
  return created.id as number;
}

async function ensureChannelId(admin: SupabaseClient, name: string): Promise<number> {
  const { data, error } = await admin.from('deal_channels').select('id').eq('name', name).maybeSingle();
  if (error || !data) throw new Error(`Deal channel "${name}" not found (expected seeded by migration): ${error?.message ?? 'no row'}`);
  return data.id as number;
}

// ── Item/deal/listing builders (direct table writes, service role — the
// create_*_operation RPCs rely on get_app_user_id()/auth.uid() session
// context that a service-role connection doesn't have, so user_id is set
// explicitly here instead of relying on the column DEFAULT). ────────────

interface ItemSpec {
  userId: number;
  brandId: number;
  subtypeId: number | null;
  purposeId: number | null;
  model: string;
  status: 'owned' | 'listed' | 'sold' | 'traded';
  soldDate?: string | null;
  estimatedSoldValue?: number | null;
}

async function insertItem(admin: SupabaseClient, key: string, spec: ItemSpec): Promise<number> {
  const { data, error } = await admin
    .from('inventory_items')
    .insert({
      user_id: spec.userId,
      brand_id: spec.brandId,
      item_subtype_id: spec.subtypeId,
      purpose_id: spec.purposeId,
      model: spec.model,
      status: spec.status,
      sold_date: spec.soldDate ?? null,
      estimated_sold_value: spec.estimatedSoldValue ?? null,
      serial_number: `FIXTURE:${key}`,
    })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to insert item "${key}" (${spec.model}): ${error.message}`);
  return data.id as number;
}

async function insertDeal(
  admin: SupabaseClient,
  userId: number,
  dealType: string,
  dealDate: string,
  channelId: number | null,
  notes?: string,
): Promise<number> {
  const { data, error } = await admin
    .from('deals')
    .insert({ user_id: userId, deal_type: dealType, deal_date: dealDate, deal_channel_id: channelId, notes: notes ?? null })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to insert ${dealType} deal: ${error.message}`);
  return data.id as number;
}

async function insertDealItem(
  admin: SupabaseClient,
  userId: number,
  dealId: number,
  itemId: number,
  direction: 'in' | 'out',
  totalValue: number | null,
): Promise<void> {
  const { error } = await admin
    .from('deal_items')
    .insert({ user_id: userId, deal_id: dealId, item_id: itemId, direction, total_value: totalValue });
  if (error) throw new Error(`Failed to insert deal_item (deal=${dealId}, item=${itemId}, dir=${direction}): ${error.message}`);
}

async function insertListing(
  admin: SupabaseClient,
  userId: number,
  itemId: number,
  channelId: number,
  listedAt: string | null,
): Promise<void> {
  // Fires the item_listings_sync_inventory_status trigger, which promotes
  // owned -> listed automatically when listed_at IS NOT NULL — matches
  // real app behavior, so items are inserted as 'owned' first. Note:
  // item_listings enforces UNIQUE(inventory_item_id, deal_channel_id) —
  // at most one listing record per item+channel pair, ever.
  const { error } = await admin
    .from('item_listings')
    .insert({ user_id: userId, inventory_item_id: itemId, deal_channel_id: channelId, listed_at: listedAt, is_ai_generated: false });
  if (error) throw new Error(`Failed to insert listing (item=${itemId}, channel=${channelId}): ${error.message}`);
}

/** Acquire one item via a purchase/trade-in/historical deal, in one call. */
async function acquireItem(
  admin: SupabaseClient,
  key: string,
  spec: Omit<ItemSpec, 'status' | 'soldDate'>,
  acquisitionType: 'purchase' | 'trade' | 'Historical Import' | 'Historical Purchase' | 'Historical Trade',
  acquisitionDate: string,
  channelId: number | null,
  value: number | null,
): Promise<{ itemId: number; dealId: number }> {
  const itemId = await insertItem(admin, key, { ...spec, status: 'owned', soldDate: null });
  const dealId = await insertDeal(admin, spec.userId, acquisitionType, acquisitionDate, channelId);
  await insertDealItem(admin, spec.userId, dealId, itemId, 'in', value);
  return { itemId, dealId };
}

async function realizeItem(
  admin: SupabaseClient,
  userId: number,
  itemId: number,
  exitType: 'sale' | 'trade',
  exitDate: string,
  channelId: number | null,
  value: number,
): Promise<number> {
  const dealId = await insertDeal(admin, userId, exitType, exitDate, channelId);
  await insertDealItem(admin, userId, dealId, itemId, 'out', value);
  await admin.from('inventory_items').update({ status: exitType === 'sale' ? 'sold' : 'traded', sold_date: exitDate }).eq('id', itemId);
  return dealId;
}

// ── Fixture-input constants used to independently derive expected values ──
// (never copied from a prior test run's output, never read back from the
// analytics result being verified — see FixtureResult.expected below).

export const PROFIT_BAND_ITEM_A = { acquisitionValue: 4200, exitValue: 4700, acquireDaysAgo: 260, exitDaysAgo: 230 };
export const PROFIT_BAND_ITEM_B = { acquisitionValue: 4800, exitValue: 5300, acquireDaysAgo: 260, exitDaysAgo: 230 };
export const LOW_UPSIDE_ITEM = { acquisitionValue: 1000, estimatedSoldValue: 1100 };
export const HIGH_CAPITAL_ITEM = { acquisitionValue: 5200 };

function computeExpected() {
  const a = PROFIT_BAND_ITEM_A;
  const b = PROFIT_BAND_ITEM_B;
  const netProfitA = a.exitValue - a.acquisitionValue;
  const netProfitB = b.exitValue - b.acquisitionValue;
  const holdingDaysA = a.acquireDaysAgo - a.exitDaysAgo;
  const holdingDaysB = b.acquireDaysAgo - b.exitDaysAgo;
  const profitPer30A = (netProfitA / holdingDaysA) * 30;
  const profitPer30B = (netProfitB / holdingDaysB) * 30;
  const roiA = (netProfitA / a.acquisitionValue) * 100;
  const roiB = (netProfitB / b.acquisitionValue) * 100;

  return {
    profitBand: {
      itemA: { ...a, netProfit: netProfitA, holdingDays: holdingDaysA, roiPercent: round2(roiA) },
      itemB: { ...b, netProfit: netProfitB, holdingDays: holdingDaysB, roiPercent: round2(roiB) },
      medianNetProfit: round2(median2(netProfitA, netProfitB)),
      medianNetProfitPer30HoldingDays: round2(median2(profitPer30A, profitPer30B)),
      profitToAcquisitionCapitalPercent: round2(((netProfitA + netProfitB) / (a.acquisitionValue + b.acquisitionValue)) * 100),
      medianRoiPercent: round2(median2(roiA, roiB)),
    },
    lowEstimatedUpsidePercent: round2(
      ((LOW_UPSIDE_ITEM.estimatedSoldValue - LOW_UPSIDE_ITEM.acquisitionValue) / LOW_UPSIDE_ITEM.acquisitionValue) * 100,
    ),
  };
}

// ── Main fixture build ───────────────────────────────────────────────────

export interface FixtureItemManifest {
  // v1.0-v1.1
  businessFastSale: number;
  openFenderPositiveBand: number;
  businessZeroAssignedSale: number;
  businessZeroAssignedTrade: number;
  businessUnknownValueSale: number;
  // v1.2-v1.5 (channels, listings)
  historicalImportRealized: number;
  historicalImportOpenNoChannel: number;
  kijijiToKijijiSaleOne: number;
  kijijiToKijijiSaleTwo: number;
  sharedAcquisitionExitA: number;
  sharedAcquisitionExitB: number;
  separateAcquisitionSharedExitA: number;
  separateAcquisitionSharedExitB: number;
  crossListedMarketplaceKijiji: number;
  openMarketplaceListing: number;
  nonListingChannelRecord: number;
  draftListingNoDate: number;
  reverbOpenSoleSample: number;
  historicalTradedNoExitChannel: number;
  tradedViaReverb: number;
  historicalPurchaseViaRegular: number;
  // v1.6 (category/type)
  ampsPedalItem: number;
  pedalsPedalItem: number;
  acousticPairA: number;
  acousticPairB: number;
  uncategorizedItem: number;
  // v1.7 (capital/liquidity)
  profitBandItemA: number;
  profitBandItemB: number;
  // v1.8 (open inventory decision support)
  allBusinessFallbackItem: number;
  highCapitalExposureOpen: number;
  lowEstimatedUpsideOpen: number;
  lowConfidenceCohortComparableOne: number;
  lowConfidenceCohortComparableTwo: number;
  lowConfidenceCohortComparableThree: number;
  lowConfidenceCohortComparableFour: number;
  lowConfidenceCohortComparableFive: number;
  businessLongDomOpen: number;
  // Purpose-Aware Foundation
  missingPurposeItem: number;
  missingPolicyItem: number;
  // v2.1/v2.2 (Hybrid/Personal)
  hybridRecentOpen: number;
  hybridHistoricalOpen: number;
  personalOpenItem: number;
  // v2.11 (per-platform listing-to-exit timing)
  sameDayListingAndExit: number;
  listingAfterExitInvalidOrder: number;
  // v2.13 (Pattern Discovery Evidence Foundation)
  historicalTradeRealized: number;
  realizedItemWithExpenses: number;
  // User B
  userBZeroAssignedOpenOne: number;
  userBZeroAssignedOpenTwo: number;
  userBRealizedMarketplace: number;
  userBOpenFender: number;
  userBRealizedReverb: number;
  userBHybridOpenOne: number;
  userBHybridOpenTwo: number;
  userBPersonalOpen: number;
  userBHistoricalImportOpen: number;
}

export interface FixtureResult {
  userAId: number;
  userBId: number;
  userAEmail: string;
  userBEmail: string;
  password: string;
  items: FixtureItemManifest;
  expected: ReturnType<typeof computeExpected>;
}

async function loadExistingFixtureItemIds(admin: SupabaseClient): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const { data, error } = await admin
    .from('inventory_items')
    .select('id, serial_number')
    .like('serial_number', 'FIXTURE:%');
  if (error) throw new Error(`Failed to load existing fixture items: ${error.message}`);
  for (const row of data ?? []) {
    const key = (row.serial_number as string).slice('FIXTURE:'.length);
    map.set(key, row.id as number);
  }
  return map;
}

export async function setupAnalyticsTestFixtures(admin: SupabaseClient): Promise<FixtureResult> {
  console.log('[fixtures] Resolving/creating auth users...');
  const authAId = await ensureAuthUser(admin, TEST_USER_A_EMAIL);
  const authBId = await ensureAuthUser(admin, TEST_USER_B_EMAIL);
  const userAId = await resolveAppUserId(admin, authAId, TEST_USER_A_EMAIL);
  const userBId = await resolveAppUserId(admin, authBId, TEST_USER_B_EMAIL);
  console.log(`[fixtures] userA app_users.id=${userAId}, userB app_users.id=${userBId}`);

  console.log('[fixtures] Ensuring reference data (brands, categories/subtypes, purposes, channels)...');
  const brand = {
    fender: await ensureBrand(admin, 'Fender'),
    gibson: await ensureBrand(admin, 'Gibson'),
    ibanez: await ensureBrand(admin, 'Ibanez'),
    prs: await ensureBrand(admin, 'PRS'),
    squier: await ensureBrand(admin, 'Squier'),
    danelectro: await ensureBrand(admin, 'Danelectro'),
    // Dedicated, single-purpose brands — see the scenarios that use them
    // for exactly why they must never be shared with any other item.
    epiphone: await ensureBrand(admin, 'Epiphone'),
    takamine: await ensureBrand(admin, 'Takamine'),
    yamaha: await ensureBrand(admin, 'Yamaha'),
  };
  const subtype = {
    electricGuitar: await ensureSubtype(admin, 'Guitars', 'Electric Guitar'),
    acousticGuitar: await ensureSubtype(admin, 'Guitars', 'Acoustic Guitar'),
    // Intentional cross-category namesake — same Type name ("Pedal") under
    // two different Categories, exercising the "same Type name under
    // different Categories stays separate" behavior (item_subtypes'
    // UNIQUE constraint is (category_id, name), not name alone).
    ampsPedal: await ensureSubtype(admin, 'Amps', 'Pedal'),
    pedalsPedal: await ensureSubtype(admin, 'Pedals', 'Pedal'),
    parts: await ensureSubtype(admin, 'Parts', 'Parts'),
  };
  const purpose = {
    business: await ensurePurpose(admin, 'Business'),
    hybrid: await ensurePurpose(admin, 'Hybrid'),
    personal: await ensurePurpose(admin, 'Personal'),
    // Deliberately unmapped in analytics_purpose_policy — exercises
    // purpose_policy_status = 'missing_policy'.
    loaner: await ensurePurpose(admin, 'Loaner'),
  };
  const channel = {
    marketplace: await ensureChannelId(admin, 'Marketplace'),
    kijiji: await ensureChannelId(admin, 'Kijiji'),
    reverb: await ensureChannelId(admin, 'Reverb'),
    regular: await ensureChannelId(admin, 'Regular Buyer / Seller'),
  };

  const existing = await loadExistingFixtureItemIds(admin);
  const items: Partial<FixtureItemManifest> = {};

  /** Ensures one scenario is idempotent: if a fixture item with this exact
   *  `key` already exists (from a prior run), reuse its id; otherwise run
   *  `factory` to create it fresh. `factory` is responsible for creating
   *  every item, deal, deal_item, and listing row the scenario needs. */
  async function ensure<K extends keyof FixtureItemManifest>(key: K, factory: () => Promise<number>): Promise<void> {
    if (existing.has(key)) {
      items[key] = existing.get(key)!;
      return;
    }
    items[key] = await factory();
  }

  /** Same idea for a scenario that creates TWO items sharing one deal —
   *  both keys are checked together so a partially-completed prior run
   *  never leaves an orphaned single item without its pair. */
  async function ensurePair<KA extends keyof FixtureItemManifest, KB extends keyof FixtureItemManifest>(
    keyA: KA,
    keyB: KB,
    factory: () => Promise<[number, number]>,
  ): Promise<void> {
    if (existing.has(keyA) && existing.has(keyB)) {
      items[keyA] = existing.get(keyA)!;
      items[keyB] = existing.get(keyB)!;
      return;
    }
    const [idA, idB] = await factory();
    items[keyA] = idA;
    items[keyB] = idB;
  }

  console.log('[fixtures] Ensuring inventory/deal/listing fixture scenarios for userA...');

  // businessFastSale — acquired via Regular Buyer/Seller, sold via
  // Marketplace, ALSO listed briefly (short DOM) before the sale so it can
  // serve as a fast-moving comparable for longer-DOM items in the same
  // brand+type+band+purpose cohort.
  await ensure('businessFastSale', async () => {
    const { itemId } = await acquireItem(
      admin, 'businessFastSale', { userId: userAId, brandId: brand.fender, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Fender Stratocaster' },
      'purchase', daysAgo(600), channel.regular, 500,
    );
    await insertListing(admin, userAId, itemId, channel.marketplace, daysAgo(580));
    await realizeItem(admin, userAId, itemId, 'sale', daysAgo(560), channel.marketplace, 800);
    return itemId;
  });

  // openFenderPositiveBand — open Fender item, positive $1-999 band,
  // listed on Kijiji (kept off Reverb so reverbOpenSoleSample is the only
  // open+Reverb-listed item in the whole fixture set).
  await ensure('openFenderPositiveBand', async () => {
    const { itemId } = await acquireItem(
      admin, 'openFenderPositiveBand', { userId: userAId, brandId: brand.fender, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Fender Telecaster' },
      'purchase', daysAgo(120), channel.regular, 450,
    );
    await insertListing(admin, userAId, itemId, channel.kijiji, daysAgo(90));
    return itemId;
  });

  // businessZeroAssignedSale — zero-assigned acquisition value, realized sale.
  await ensure('businessZeroAssignedSale', async () => {
    const { itemId } = await acquireItem(
      admin, 'businessZeroAssignedSale', { userId: userAId, brandId: brand.fender, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Fender Jazzmaster (trade-in credit)' },
      'trade', daysAgo(500), channel.marketplace, 0,
    );
    await realizeItem(admin, userAId, itemId, 'sale', daysAgo(480), channel.marketplace, 200);
    return itemId;
  });

  // businessZeroAssignedTrade — zero-assigned acquisition value, realized TRADE exit.
  await ensure('businessZeroAssignedTrade', async () => {
    const { itemId } = await acquireItem(
      admin, 'businessZeroAssignedTrade', { userId: userAId, brandId: brand.gibson, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Gibson SG (bundled, zero value)' },
      'trade', daysAgo(400), channel.kijiji, 0,
    );
    await realizeItem(admin, userAId, itemId, 'trade', daysAgo(380), channel.kijiji, 150);
    return itemId;
  });

  // businessUnknownValueSale — UNKNOWN acquisition value (deal_items.total_value
  // NULL on the incoming side), realized sale. Brand is DEDICATED (Epiphone,
  // used nowhere else) so this brand never has a positive-value item —
  // exercises all_business_distinct_brand_count > positive_acquisition_
  // distinct_brand_count.
  await ensure('businessUnknownValueSale', async () => {
    const { itemId } = await acquireItem(
      admin, 'businessUnknownValueSale', { userId: userAId, brandId: brand.epiphone, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Epiphone (value unknown)' },
      'purchase', daysAgo(450), channel.marketplace, null,
    );
    await realizeItem(admin, userAId, itemId, 'sale', daysAgo(430), channel.marketplace, 300);
    return itemId;
  });

  // historicalImportRealized — Historical Import, later realized via a
  // separate sale deal: reliable listing/exit/DOM, unreliable
  // acquisition_date, excluded from holding_days but included in
  // profit/ROI/DOM.
  await ensure('historicalImportRealized', async () => {
    const itemId = await insertItem(admin, 'historicalImportRealized', { userId: userAId, brandId: brand.gibson, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Gibson Les Paul (historical import)', status: 'owned' });
    const dealId = await insertDeal(admin, userAId, 'Historical Import', daysAgo(900), null, 'Historical inventory import');
    await insertDealItem(admin, userAId, dealId, itemId, 'in', 900);
    await insertListing(admin, userAId, itemId, channel.marketplace, daysAgo(30));
    await realizeItem(admin, userAId, itemId, 'sale', daysAgo(10), channel.marketplace, 1400);
    return itemId;
  });

  // historicalImportOpenNoChannel — Historical Import, OPEN, never listed
  // (no Deal In channel, no listing channel) — exercises missing-channel
  // and historical-excluded-from-ownership-age behavior.
  await ensure('historicalImportOpenNoChannel', async () => {
    const itemId = await insertItem(admin, 'historicalImportOpenNoChannel', { userId: userAId, brandId: brand.gibson, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Gibson ES-335 (historical import, open)', status: 'owned' });
    const dealId = await insertDeal(admin, userAId, 'Historical Import', daysAgo(800), null, 'Historical inventory import');
    await insertDealItem(admin, userAId, dealId, itemId, 'in', 700);
    return itemId;
  });

  // kijijiToKijijiSaleOne/Two — two independent same-channel (Kijiji ->
  // Kijiji) journeys.
  await ensure('kijijiToKijijiSaleOne', async () => {
    const { itemId } = await acquireItem(
      admin, 'kijijiToKijijiSaleOne', { userId: userAId, brandId: brand.prs, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'PRS SE Custom' },
      'purchase', daysAgo(300), channel.kijiji, 350,
    );
    await realizeItem(admin, userAId, itemId, 'sale', daysAgo(280), channel.kijiji, 500);
    return itemId;
  });
  await ensure('kijijiToKijijiSaleTwo', async () => {
    const { itemId } = await acquireItem(
      admin, 'kijijiToKijijiSaleTwo', { userId: userAId, brandId: brand.squier, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Squier Classic Vibe' },
      'purchase', daysAgo(300), channel.kijiji, 350,
    );
    await realizeItem(admin, userAId, itemId, 'sale', daysAgo(280), channel.kijiji, 500);
    return itemId;
  });

  // sharedAcquisitionExitA/B — shared acquisition deal (one Reverb
  // purchase, two items), separate exit deals.
  await ensurePair('sharedAcquisitionExitA', 'sharedAcquisitionExitB', async () => {
    const item1 = await insertItem(admin, 'sharedAcquisitionExitA', { userId: userAId, brandId: brand.fender, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Fender Mustang (shared-deal A)', status: 'owned' });
    const item2 = await insertItem(admin, 'sharedAcquisitionExitB', { userId: userAId, brandId: brand.gibson, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Gibson SG Standard (shared-deal B)', status: 'owned' });
    const dealId = await insertDeal(admin, userAId, 'purchase', daysAgo(250), channel.reverb);
    await insertDealItem(admin, userAId, dealId, item1, 'in', 400);
    await insertDealItem(admin, userAId, dealId, item2, 'in', 600);
    await realizeItem(admin, userAId, item1, 'sale', daysAgo(200), channel.marketplace, 550);
    await realizeItem(admin, userAId, item2, 'sale', daysAgo(190), channel.marketplace, 850);
    return [item1, item2];
  });

  // separateAcquisitionSharedExitA/B — separate acquisition deals, shared
  // exit (trade) deal.
  await ensurePair('separateAcquisitionSharedExitA', 'separateAcquisitionSharedExitB', async () => {
    const { itemId: item1 } = await acquireItem(
      admin, 'separateAcquisitionSharedExitA', { userId: userAId, brandId: brand.ibanez, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Ibanez AZ (separate-acq A)' },
      'purchase', daysAgo(220), channel.regular, 300,
    );
    const { itemId: item2 } = await acquireItem(
      admin, 'separateAcquisitionSharedExitB', { userId: userAId, brandId: brand.squier, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Squier Bullet (separate-acq B)' },
      'purchase', daysAgo(210), channel.regular, 200,
    );
    const dealId = await insertDeal(admin, userAId, 'trade', daysAgo(150), channel.kijiji);
    await insertDealItem(admin, userAId, dealId, item1, 'out', 350);
    await insertDealItem(admin, userAId, dealId, item2, 'out', 250);
    await admin.from('inventory_items').update({ status: 'traded', sold_date: daysAgo(150) }).in('id', [item1, item2]);
    return [item1, item2];
  });

  // crossListedMarketplaceKijiji — cross-listed (Marketplace + Kijiji),
  // later realized via Marketplace.
  await ensure('crossListedMarketplaceKijiji', async () => {
    const { itemId } = await acquireItem(
      admin, 'crossListedMarketplaceKijiji', { userId: userAId, brandId: brand.fender, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Fender Player Plus (cross-listed)' },
      'purchase', daysAgo(180), channel.regular, 500,
    );
    await insertListing(admin, userAId, itemId, channel.marketplace, daysAgo(150));
    await insertListing(admin, userAId, itemId, channel.kijiji, daysAgo(145));
    await realizeItem(admin, userAId, itemId, 'sale', daysAgo(100), channel.marketplace, 750);
    return itemId;
  });

  // openMarketplaceListing — open, single Marketplace listing. (A
  // duplicate-record-on-the-same-channel scenario was attempted here in an
  // earlier version but item_listings enforces UNIQUE(inventory_item_id,
  // deal_channel_id) — the DB structurally forbids two physical listing
  // rows for the same item+channel. See test-analytics-runner.ts's v1.5
  // section for how that legacy "records collapse to exposure" assertion
  // was corrected to reflect this guaranteed invariant instead.)
  await ensure('openMarketplaceListing', async () => {
    const { itemId } = await acquireItem(
      admin, 'openMarketplaceListing', { userId: userAId, brandId: brand.gibson, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Gibson J-45 (Marketplace listing)' },
      'purchase', daysAgo(80), channel.regular, 900,
    );
    await insertListing(admin, userAId, itemId, channel.marketplace, daysAgo(70));
    return itemId;
  });

  // nonListingChannelRecord — listing record on a NON-listing-platform
  // channel (Regular Buyer / Seller) — exercises
  // ignored_non_listing_channel_record_count.
  await ensure('nonListingChannelRecord', async () => {
    const { itemId } = await acquireItem(
      admin, 'nonListingChannelRecord', { userId: userAId, brandId: brand.ibanez, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Ibanez AW (non-listing-channel record)' },
      'purchase', daysAgo(70), channel.regular, 400,
    );
    await insertListing(admin, userAId, itemId, channel.regular, daysAgo(60));
    return itemId;
  });

  // draftListingNoDate — "draft" listing (listed_at NULL) — exercises
  // missing_listing_channel_record_count.
  await ensure('draftListingNoDate', async () => {
    const itemId = await insertItem(admin, 'draftListingNoDate', { userId: userAId, brandId: brand.prs, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'PRS S2 (draft listing)', status: 'owned' });
    const dealId = await insertDeal(admin, userAId, 'purchase', daysAgo(60), channel.regular);
    await insertDealItem(admin, userAId, dealId, itemId, 'in', 600);
    await insertListing(admin, userAId, itemId, channel.reverb, null);
    return itemId;
  });

  // reverbOpenSoleSample — the ONLY open+Reverb-listed item across this
  // entire fixture set (both users) — Reverb open-inventory DOM sampling
  // requires sample_size === 1. ALSO doubles as the low-confidence-cohort
  // target item.
  //
  // ── WHY EXACTLY 5 COMPARABLES, NOT 3 ────────────────────────────────
  // The comparable-cohort selection algorithm (analytics/sql/10_open_
  // inventory_decision_support.sql) sorts ALL 7 candidate levels by
  // (reaches >=5?, reaches >=3?, specificity) and takes the first — i.e.
  // ANY level reaching >=5 always outranks a MORE SPECIFIC level that
  // stays below 5, no matter how small the gap. The broadest level,
  // all_business (unrestricted by brand/category/band), pools literally
  // every realized Business item in the fixture set (~27+) and therefore
  // ALWAYS reaches >=5 in any non-trivial dataset — isolating the target
  // item's brand/category/band (as two earlier versions of this scenario
  // tried) only prevents OTHER broad levels from contaminating the count;
  // it can never make all_business itself lose. The only way for a MORE
  // SPECIFIC level to win is for IT to also reach >=5, so the tie is
  // broken by specificity — and since this analytics layer's confidence
  // tiers are `<=2 insufficient / <=5 low / <=9 moderate / >=10 stronger`,
  // a count of EXACTLY 5 is the unique value that both wins the
  // selection (ties all_business on the ">=5" tier, then wins on
  // specificity) AND still reports confidence = 'low' (not 'moderate').
  //
  // Brand (Takamine), category+subtype (Amps/Pedal), and acquisition
  // value band ($3,000-3,999) are all otherwise unused elsewhere in this
  // fixture set, so brand_type_band/brand_band/brand/category_band/
  // category/acquisition_value_band all resolve to exactly these 5
  // realized comparables — no broader level between brand_type_band and
  // all_business can accidentally out-rank it on specificity, and none
  // of them reach >=5 except brand_type_band itself (at count=5) and
  // all_business.
  await ensure('reverbOpenSoleSample', async () => {
    const { itemId } = await acquireItem(
      admin, 'reverbOpenSoleSample', { userId: userAId, brandId: brand.takamine, subtypeId: subtype.ampsPedal, purposeId: purpose.business, model: 'Takamine pedal (Reverb open, low-confidence cohort)' },
      'purchase', daysAgo(50), channel.regular, 3200,
    );
    await insertListing(admin, userAId, itemId, channel.reverb, daysAgo(40));
    return itemId;
  });

  // lowConfidenceCohortComparableOne..Five — exactly 5 realized Takamine/
  // Amps-Pedal/$3,000-3,999-band comparables (see the detailed rationale
  // above reverbOpenSoleSample) so its brand_type_band cohort
  // realized_item_count === 5 exactly -> wins cohort selection over
  // all_business on the specificity tie-break, with confidence = 'low'.
  for (const key of [
    'lowConfidenceCohortComparableOne', 'lowConfidenceCohortComparableTwo', 'lowConfidenceCohortComparableThree',
    'lowConfidenceCohortComparableFour', 'lowConfidenceCohortComparableFive',
  ] as const) {
    await ensure(key, async () => {
      const { itemId } = await acquireItem(
        admin, key, { userId: userAId, brandId: brand.takamine, subtypeId: subtype.ampsPedal, purposeId: purpose.business, model: `Takamine pedal (comparable ${key})` },
        'purchase', daysAgo(260), channel.regular, 3300,
      );
      await realizeItem(admin, userAId, itemId, 'sale', daysAgo(240), channel.marketplace, 3500);
      return itemId;
    });
  }

  // historicalTradedNoExitChannel — Historical Import acquisition (always
  // channel-less by definition), realized via a TRADE exit with NO
  // recorded channel either — exercises deal_out_channel_missing_item_
  // count for a historical item specifically.
  await ensure('historicalTradedNoExitChannel', async () => {
    const itemId = await insertItem(admin, 'historicalTradedNoExitChannel', { userId: userAId, brandId: brand.gibson, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Gibson (historical, channel-less trade-out)', status: 'owned' });
    const dealId = await insertDeal(admin, userAId, 'Historical Import', daysAgo(700), null, 'Historical inventory import');
    await insertDealItem(admin, userAId, dealId, itemId, 'in', 850);
    await realizeItem(admin, userAId, itemId, 'trade', daysAgo(50), null, 950);
    return itemId;
  });

  // tradedViaReverb — normal (non-historical) purchase, later realized via
  // a TRADE through Reverb — exercises "an outgoing trade item maps to its
  // own trade deal channel."
  await ensure('tradedViaReverb', async () => {
    const { itemId } = await acquireItem(
      admin, 'tradedViaReverb', { userId: userAId, brandId: brand.ibanez, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Ibanez (traded via Reverb)' },
      'purchase', daysAgo(160), channel.regular, 350,
    );
    await realizeItem(admin, userAId, itemId, 'trade', daysAgo(140), channel.reverb, 400);
    return itemId;
  });

  // historicalPurchaseViaRegular — 'Historical Purchase' (acquisition
  // METHOD known, unlike plain 'Historical Import'), acquired with a
  // RECORDED channel (Regular Buyer / Seller), later sold via Marketplace.
  // Exercises: a historical item CAN carry a Deal In channel when the
  // historical deal itself recorded one, appearing in the Regular Buyer/
  // Seller -> Marketplace Channel Journey row with historical_item_count
  // >= 1 while still being excluded from that row's holding_sample_size.
  await ensure('historicalPurchaseViaRegular', async () => {
    const itemId = await insertItem(admin, 'historicalPurchaseViaRegular', { userId: userAId, brandId: brand.gibson, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Gibson (Historical Purchase, known channel)', status: 'owned' });
    const dealId = await insertDeal(admin, userAId, 'Historical Purchase', daysAgo(750), channel.regular, 'Historical Purchase — corrected from Historical Import');
    await insertDealItem(admin, userAId, dealId, itemId, 'in', 950);
    await realizeItem(admin, userAId, itemId, 'sale', daysAgo(60), channel.marketplace, 1300);
    return itemId;
  });

  // ampsPedalItem/pedalsPedalItem — same Type name ("Pedal") under two
  // different Categories.
  await ensure('ampsPedalItem', async () => {
    const { itemId } = await acquireItem(
      admin, 'ampsPedalItem', { userId: userAId, brandId: brand.ibanez, subtypeId: subtype.ampsPedal, purposeId: purpose.business, model: 'Ibanez Tube Screamer clone (Amps/Pedal)' },
      'purchase', daysAgo(200), channel.marketplace, 100,
    );
    await realizeItem(admin, userAId, itemId, 'sale', daysAgo(180), channel.marketplace, 130);
    return itemId;
  });
  await ensure('pedalsPedalItem', async () => {
    const { itemId } = await acquireItem(
      admin, 'pedalsPedalItem', { userId: userAId, brandId: brand.ibanez, subtypeId: subtype.pedalsPedal, purposeId: purpose.business, model: 'Boss DS-1 (Pedals/Pedal)' },
      'purchase', daysAgo(190), channel.marketplace, 80,
    );
    await realizeItem(admin, userAId, itemId, 'sale', daysAgo(170), channel.marketplace, 110);
    return itemId;
  });

  // acousticPairA/B — Guitars/Acoustic Guitar pair, shared acquisition
  // deal, separate exit deals. This is the ONLY pair of Business items
  // using the Acoustic Guitar subtype in the whole fixture set (see
  // openMarketplaceListing/nonListingChannelRecord below, which were moved
  // to Electric Guitar specifically to keep this isolated).
  await ensurePair('acousticPairA', 'acousticPairB', async () => {
    const item1 = await insertItem(admin, 'acousticPairA', { userId: userAId, brandId: brand.fender, subtypeId: subtype.acousticGuitar, purposeId: purpose.business, model: 'Fender CD-60 (acoustic pair A)', status: 'owned' });
    const item2 = await insertItem(admin, 'acousticPairB', { userId: userAId, brandId: brand.gibson, subtypeId: subtype.acousticGuitar, purposeId: purpose.business, model: 'Gibson J-15 (acoustic pair B)', status: 'owned' });
    const dealId = await insertDeal(admin, userAId, 'purchase', daysAgo(140), channel.regular);
    await insertDealItem(admin, userAId, dealId, item1, 'in', 300);
    await insertDealItem(admin, userAId, dealId, item2, 'in', 900);
    await realizeItem(admin, userAId, item1, 'sale', daysAgo(100), channel.marketplace, 400);
    await realizeItem(admin, userAId, item2, 'sale', daysAgo(95), channel.marketplace, 1200);
    return [item1, item2];
  });

  // uncategorizedItem — no item_subtype_id at all (category/type "missing"
  // coverage).
  await ensure('uncategorizedItem', async () => {
    const { itemId } = await acquireItem(
      admin, 'uncategorizedItem', { userId: userAId, brandId: brand.danelectro, subtypeId: null, purposeId: purpose.business, model: 'Danelectro (uncategorized)' },
      'purchase', daysAgo(90), channel.marketplace, 250,
    );
    await realizeItem(admin, userAId, itemId, 'sale', daysAgo(70), channel.marketplace, 300);
    return itemId;
  });

  // profitBandItemA/B — the ONLY two realized items anywhere in this
  // fixture set with a positive acquisition value in the $4,000-4,999
  // band (verified against every other scenario's values) — isolates the
  // band's profit-per-30-holding-days / aggregate-vs-median-ROI evidence
  // to exactly these two items. See PROFIT_BAND_ITEM_A/B and
  // computeExpected() above for the independently-derived expected
  // numbers.
  await ensure('profitBandItemA', async () => {
    const a = PROFIT_BAND_ITEM_A;
    const { itemId } = await acquireItem(
      admin, 'profitBandItemA', { userId: userAId, brandId: brand.gibson, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Gibson Custom Shop Les Paul' },
      'purchase', daysAgo(a.acquireDaysAgo), channel.regular, a.acquisitionValue,
    );
    await realizeItem(admin, userAId, itemId, 'sale', daysAgo(a.exitDaysAgo), channel.marketplace, a.exitValue);
    return itemId;
  });
  await ensure('profitBandItemB', async () => {
    const b = PROFIT_BAND_ITEM_B;
    const { itemId } = await acquireItem(
      admin, 'profitBandItemB', { userId: userAId, brandId: brand.prs, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'PRS Private Stock' },
      'purchase', daysAgo(b.acquireDaysAgo), channel.regular, b.acquisitionValue,
    );
    await realizeItem(admin, userAId, itemId, 'sale', daysAgo(b.exitDaysAgo), channel.marketplace, b.exitValue);
    return itemId;
  });

  // allBusinessFallbackItem — dedicated brand (Yamaha) + dedicated
  // category (Parts) + a $2,000-2,999 band value that no other realized
  // item anywhere shares — every specific cohort level (brand_type_band,
  // brand_band, brand, category_band, category, acquisition_value_band)
  // has realized_item_count === 0 for this item, so comparable-cohort
  // selection falls all the way back to all_business.
  await ensure('allBusinessFallbackItem', async () => {
    const { itemId } = await acquireItem(
      admin, 'allBusinessFallbackItem', { userId: userAId, brandId: brand.yamaha, subtypeId: subtype.parts, purposeId: purpose.business, model: 'Yamaha (isolated brand/category/band)' },
      'purchase', daysAgo(30), channel.marketplace, 2500,
    );
    return itemId;
  });

  // highCapitalExposureOpen — highest acquisition value among userA's own
  // open items (rank 1) -> HIGH_CAPITAL_EXPOSURE.
  await ensure('highCapitalExposureOpen', async () => {
    const { itemId } = await acquireItem(
      admin, 'highCapitalExposureOpen', { userId: userAId, brandId: brand.gibson, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Gibson Custom Murphy Lab (high value, open)' },
      'purchase', daysAgo(20), channel.regular, HIGH_CAPITAL_ITEM.acquisitionValue,
    );
    return itemId;
  });

  // lowEstimatedUpsideOpen — modest (10%) estimated upside relative to
  // acquisition value -> LOW_ESTIMATED_UPSIDE_RELATIVE_TO_CAPITAL.
  await ensure('lowEstimatedUpsideOpen', async () => {
    const { itemId } = await acquireItem(
      admin, 'lowEstimatedUpsideOpen', { userId: userAId, brandId: brand.fender, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Fender American Pro II (low estimated upside)' },
      'purchase', daysAgo(45), channel.regular, LOW_UPSIDE_ITEM.acquisitionValue,
    );
    const { error } = await admin.from('inventory_items').update({ estimated_sold_value: LOW_UPSIDE_ITEM.estimatedSoldValue }).eq('id', itemId);
    if (error) throw new Error(`Failed to set estimated_sold_value for lowEstimatedUpsideOpen: ${error.message}`);
    return itemId;
  });

  // missingPurposeItem — purpose_id = NULL (missing_purpose coverage).
  await ensure('missingPurposeItem', async () => {
    const { itemId } = await acquireItem(
      admin, 'missingPurposeItem', { userId: userAId, brandId: brand.ibanez, subtypeId: subtype.electricGuitar, purposeId: null, model: 'Ibanez (no purpose assigned)' },
      'purchase', daysAgo(60), channel.marketplace, 400,
    );
    return itemId;
  });

  // missingPolicyItem — purpose = 'Loaner' (unmapped in
  // analytics_purpose_policy — missing_policy coverage).
  await ensure('missingPolicyItem', async () => {
    const { itemId } = await acquireItem(
      admin, 'missingPolicyItem', { userId: userAId, brandId: brand.squier, subtypeId: subtype.electricGuitar, purposeId: purpose.loaner, model: 'Squier (loaner gear)' },
      'purchase', daysAgo(40), channel.marketplace, 150,
    );
    return itemId;
  });

  // hybridRecentOpen — Hybrid purpose, ownership_age_days = 10 (<30,
  // reliable) -> HYBRID_RECENT_ITEM (v2.2 correction) /
  // HYBRID_RECENT_INSUFFICIENT_HISTORY (raw v2.1 code). Never realized —
  // together with hybridHistoricalOpen, keeps every Hybrid item in this
  // fixture set open, so the Hybrid liquidity "purpose" cohort level
  // always has realized_item_count = 0 and every open Hybrid item
  // reliably resolves liquidity_cohort_match = 'cross_purpose_fallback'.
  await ensure('hybridRecentOpen', async () => {
    const { itemId } = await acquireItem(
      admin, 'hybridRecentOpen', { userId: userAId, brandId: brand.prs, subtypeId: subtype.electricGuitar, purposeId: purpose.hybrid, model: 'PRS CE 24 (recent Hybrid)' },
      'purchase', daysAgo(10), channel.regular, 1500,
    );
    return itemId;
  });

  // hybridHistoricalOpen — Hybrid purpose, Historical Import (ownership_
  // age_days === NULL, unreliable) -> HYBRID_INSUFFICIENT_OWNERSHIP_
  // HISTORY (v2.2 correction), never HYBRID_RECENT_ITEM. Also listed long
  // ago (large current_dom_days) so "historical + large DOM is still never
  // labelled recent" is exercised with a real, non-null DOM value.
  await ensure('hybridHistoricalOpen', async () => {
    const itemId = await insertItem(admin, 'hybridHistoricalOpen', { userId: userAId, brandId: brand.gibson, subtypeId: subtype.electricGuitar, purposeId: purpose.hybrid, model: 'Gibson (historical Hybrid, open)', status: 'owned' });
    const dealId = await insertDeal(admin, userAId, 'Historical Import', daysAgo(600), null, 'Historical inventory import');
    await insertDealItem(admin, userAId, dealId, itemId, 'in', 800);
    await insertListing(admin, userAId, itemId, channel.kijiji, daysAgo(150));
    return itemId;
  });

  // personalOpenItem — Personal purpose, open.
  await ensure('personalOpenItem', async () => {
    const { itemId } = await acquireItem(
      admin, 'personalOpenItem', { userId: userAId, brandId: brand.fender, subtypeId: subtype.acousticGuitar, purposeId: purpose.personal, model: 'Fender (personal collection)' },
      'purchase', daysAgo(300), channel.regular, 700,
    );
    return itemId;
  });

  // businessLongDomOpen — open, listed a long time ago (~200 days) on
  // Marketplace (kept off Reverb — see reverbOpenSoleSample). Same
  // brand+type+band+purpose (Fender/Electric Guitar/$1-999/Business) as
  // businessFastSale, which is listed+realized with a 20-day DOM — gives
  // this item's liquidity cohort a real, short comparable DOM to exceed.
  await ensure('businessLongDomOpen', async () => {
    const { itemId } = await acquireItem(
      admin, 'businessLongDomOpen', { userId: userAId, brandId: brand.fender, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Fender Jaguar (long-listed, high DOM)' },
      'purchase', daysAgo(220), channel.regular, 550,
    );
    await insertListing(admin, userAId, itemId, channel.marketplace, daysAgo(200));
    return itemId;
  });

  console.log('[fixtures] Ensuring inventory/deal/listing fixture scenarios for userB...');

  await ensure('userBZeroAssignedOpenOne', async () => {
    const { itemId } = await acquireItem(
      admin, 'userBZeroAssignedOpenOne', { userId: userBId, brandId: brand.gibson, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Gibson (zero-assigned, open)' },
      'trade', daysAgo(200), channel.kijiji, 0,
    );
    return itemId;
  });
  await ensure('userBZeroAssignedOpenTwo', async () => {
    const { itemId } = await acquireItem(
      admin, 'userBZeroAssignedOpenTwo', { userId: userBId, brandId: brand.fender, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Fender (zero-assigned, open)' },
      'trade', daysAgo(200), channel.kijiji, 0,
    );
    return itemId;
  });

  await ensure('userBRealizedMarketplace', async () => {
    const { itemId } = await acquireItem(
      admin, 'userBRealizedMarketplace', { userId: userBId, brandId: brand.ibanez, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Ibanez (userB realized)' },
      'purchase', daysAgo(300), channel.marketplace, 400,
    );
    await realizeItem(admin, userBId, itemId, 'sale', daysAgo(270), channel.marketplace, 600);
    return itemId;
  });

  await ensure('userBOpenFender', async () => {
    const { itemId } = await acquireItem(
      admin, 'userBOpenFender', { userId: userBId, brandId: brand.fender, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Fender (userB open)' },
      'purchase', daysAgo(60), channel.regular, 350,
    );
    return itemId;
  });

  await ensure('userBRealizedReverb', async () => {
    const { itemId } = await acquireItem(
      admin, 'userBRealizedReverb', { userId: userBId, brandId: brand.prs, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'PRS (userB, Reverb exit)' },
      'purchase', daysAgo(150), channel.regular, 600,
    );
    await realizeItem(admin, userBId, itemId, 'sale', daysAgo(120), channel.reverb, 900);
    return itemId;
  });

  await ensure('userBHybridOpenOne', async () => {
    const { itemId } = await acquireItem(
      admin, 'userBHybridOpenOne', { userId: userBId, brandId: brand.squier, subtypeId: subtype.electricGuitar, purposeId: purpose.hybrid, model: 'Squier (userB Hybrid)' },
      'purchase', daysAgo(20), channel.regular, 300,
    );
    return itemId;
  });
  await ensure('userBHybridOpenTwo', async () => {
    const { itemId } = await acquireItem(
      admin, 'userBHybridOpenTwo', { userId: userBId, brandId: brand.ibanez, subtypeId: subtype.electricGuitar, purposeId: purpose.hybrid, model: 'Ibanez (userB Hybrid)' },
      'purchase', daysAgo(20), channel.regular, 300,
    );
    return itemId;
  });

  await ensure('userBPersonalOpen', async () => {
    const { itemId } = await acquireItem(
      admin, 'userBPersonalOpen', { userId: userBId, brandId: brand.gibson, subtypeId: subtype.acousticGuitar, purposeId: purpose.personal, model: 'Gibson (userB personal)' },
      'purchase', daysAgo(400), channel.regular, 900,
    );
    return itemId;
  });

  await ensure('userBHistoricalImportOpen', async () => {
    const itemId = await insertItem(admin, 'userBHistoricalImportOpen', { userId: userBId, brandId: brand.gibson, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Gibson (userB historical import, open)', status: 'owned' });
    const dealId = await insertDeal(admin, userBId, 'Historical Import', daysAgo(700), null, 'Historical inventory import');
    await insertDealItem(admin, userBId, dealId, itemId, 'in', 650);
    return itemId;
  });

  // sameDayListingAndExit — Marketplace listing and sale exit on the SAME
  // calendar day. Analytics v2.11's channel_listing_to_exit_days must be
  // exactly 0 for this item (a same-day listing-to-exit span is valid, not
  // excluded), never null and never negative.
  await ensure('sameDayListingAndExit', async () => {
    const { itemId } = await acquireItem(
      admin, 'sameDayListingAndExit', { userId: userAId, brandId: brand.squier, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Squier (same-day listing and exit)' },
      'purchase', daysAgo(50), channel.regular, 200,
    );
    await insertListing(admin, userAId, itemId, channel.marketplace, daysAgo(5));
    await realizeItem(admin, userAId, itemId, 'sale', daysAgo(5), channel.marketplace, 350);
    return itemId;
  });

  // listingAfterExitInvalidOrder — a contrived data-entry-error scenario:
  // the Marketplace listing record's listed_at (daysAgo(10)) is
  // chronologically AFTER the item's own exit_date (daysAgo(40)). Analytics
  // v2.11 must exclude this from channel_listing_to_exit_days (never a
  // negative duration) and count it under
  // invalid_channel_listing_after_exit_count instead.
  await ensure('listingAfterExitInvalidOrder', async () => {
    const { itemId } = await acquireItem(
      admin, 'listingAfterExitInvalidOrder', { userId: userAId, brandId: brand.danelectro, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Danelectro (listing recorded after exit)' },
      'purchase', daysAgo(60), channel.regular, 250,
    );
    await realizeItem(admin, userAId, itemId, 'sale', daysAgo(40), channel.marketplace, 400);
    await insertListing(admin, userAId, itemId, channel.marketplace, daysAgo(10));
    return itemId;
  });

  // historicalTradeRealized — a 'Historical Trade' acquisition (distinct
  // from plain 'Historical Import'/'Historical Purchase'). Analytics
  // v2.13's ACQUISITION_METHOD family must map this to acquisition_method
  // = 'trade' (via analytics_item_lifecycle's own historical-deal-type
  // relabeling, 20260724000000_historical_deal_type_labels.sql), never
  // 'unknown', while is_historical_import remains true.
  await ensure('historicalTradeRealized', async () => {
    const { itemId } = await acquireItem(
      admin, 'historicalTradeRealized', { userId: userAId, brandId: brand.gibson, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Gibson (Historical Trade)' },
      'Historical Trade', daysAgo(500), null, 700,
    );
    await realizeItem(admin, userAId, itemId, 'sale', daysAgo(30), channel.marketplace, 900);
    return itemId;
  });

  // realizedItemWithExpenses — a normal realized item carrying a real
  // inventory_expenses row, so Analytics v2.13's net_profit (exit_value -
  // acquisition_value - item_expenses_total) can be verified to actually
  // subtract expenses, not just acquisition value.
  await ensure('realizedItemWithExpenses', async () => {
    const { itemId } = await acquireItem(
      admin, 'realizedItemWithExpenses', { userId: userAId, brandId: brand.fender, subtypeId: subtype.electricGuitar, purposeId: purpose.business, model: 'Fender (realized, with expenses)' },
      'purchase', daysAgo(90), channel.regular, 400,
    );
    await realizeItem(admin, userAId, itemId, 'sale', daysAgo(20), channel.marketplace, 700);
    const { error: expenseError } = await admin
      .from('inventory_expenses')
      .insert({ user_id: userAId, item_id: itemId, expense_date: daysAgo(50), amount: 50, notes: 'Fixture: setup cost' });
    if (expenseError) throw new Error(`Failed to insert expense for realizedItemWithExpenses: ${expenseError.message}`);
    return itemId;
  });

  console.log('[fixtures] Fixture scenarios ensured.');
  return {
    userAId,
    userBId,
    userAEmail: TEST_USER_A_EMAIL,
    userBEmail: TEST_USER_B_EMAIL,
    password: TEST_USER_PASSWORD,
    items: items as FixtureItemManifest,
    expected: computeExpected(),
  };
}

// ── Standalone execution ─────────────────────────────────────────────────

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
// Windows path separators mean the strict file:// comparison above can
// miss — fall back to a basename check, matching how this repo's other
// standalone scripts are invoked (`npx tsx scripts/<name>.ts`).
const isMainModuleFallback = process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/setup-analytics-test-fixtures.ts');

async function main() {
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const result = await setupAnalyticsTestFixtures(admin);
  console.log('[fixtures] Done:', result);
}

if (isMainModule || isMainModuleFallback) {
  main().catch((err) => {
    console.error('[fixtures] Fixture setup failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
