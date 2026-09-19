/**
 * test-swr-cache.ts
 *
 * Deterministic tests (injected clock, hand-controlled promises — no
 * sleeping, no database) for the Listings stale-while-revalidate cache:
 * src/lib/swrCache.ts, listingsCacheKeys.ts, listingsCacheStore.ts,
 * useSwrResource.ts and their wiring into /listings and supabase.ts.
 *
 * Usage:  npx tsx scripts/test-swr-cache.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { CacheClearedError, DEFAULT_FRESH_TTL_MS, createSwrCache, createUserScopeGuard } from '../src/lib/swrCache';
import {
  ITEM_ACTIVITY_PREFIX, LISTING_DEMAND_PREFIX, LISTING_EVIDENCE_KEY, createListingsInvalidators, itemActivityKey, listingDemandKey,
} from '../src/lib/listingsCacheKeys';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}

const root = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const strip = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const MIN = 60 * 1000;

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; }, set: (v: number) => { t = v; } };
}

/** A fetcher whose promise the test resolves/rejects by hand; counts calls. */
function deferred<T>() {
  const calls = { n: 0 };
  const pending: { resolve: (v: T) => void; reject: (e: unknown) => void }[] = [];
  const fetcher = () => {
    calls.n++;
    return new Promise<T>((resolve, reject) => { pending.push({ resolve, reject }); });
  };
  return { fetcher, calls, resolveLast: (v: T) => pending[pending.length - 1].resolve(v), rejectLast: (e: unknown) => pending[pending.length - 1].reject(e) };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

async function main() {
  console.log('\n[A — TTL & freshness]');
  {
    check('default TTL is exactly 5 minutes', DEFAULT_FRESH_TTL_MS === 5 * MIN);
    const c = clock();
    const cache = createSwrCache({ now: c.now });
    await cache.load('k', async () => 'v1');
    c.advance(5 * MIN - 1);
    check('age 4:59.999 is fresh', cache.status('k') === 'fresh');
    c.advance(1);
    check('age exactly 5:00 is stale (>= TTL)', cache.status('k') === 'stale');
    check('stale data is still returned by peek (stale != invalid)', cache.peek<string>('k')?.data === 'v1');
  }

  console.log('\n[B — NO CACHE: initial request, blocking loading allowed]');
  {
    const cache = createSwrCache({ now: clock().now });
    const d = deferred<string>();
    check('status none, peek undefined before any load', cache.status('k') === 'none' && cache.peek('k') === undefined);
    const p = cache.load('k', d.fetcher);
    await flush();
    check('initial request occurs (1 fetch)', d.calls.n === 1 && cache.isInFlight('k'));
    check('while loading there is nothing to render (=> caller shows blocking loading)', cache.peek('k') === undefined);
    d.resolveLast('v');
    const e = await p;
    check('result stored and returned', e.data === 'v' && cache.peek<string>('k')?.data === 'v' && !cache.isInFlight('k'));
  }

  console.log('\n[C — FRESH CACHE: immediate render, no duplicate request]');
  {
    const c = clock();
    const cache = createSwrCache({ now: c.now });
    const d = deferred<string>();
    const p = cache.load('k', d.fetcher); await flush(); d.resolveLast('v1'); await p;
    c.advance(2 * MIN);
    check('cached data available synchronously (peek) — no blocking state', cache.peek<string>('k')?.data === 'v1' && cache.status('k') === 'fresh');
    const again = await cache.load('k', d.fetcher);
    check('load() on fresh data issues NO request', d.calls.n === 1 && again.data === 'v1');
    check('fetchedAt unchanged by a fresh hit', again.fetchedAt === 1_000_000);
  }

  console.log('\n[D — STALE CACHE: render immediately + background revalidation]');
  {
    const c = clock();
    const cache = createSwrCache({ now: c.now });
    const d = deferred<string>();
    let p = cache.load('k', d.fetcher); await flush(); d.resolveLast('old'); await p;
    c.advance(6 * MIN);
    check('stale entry still renders immediately', cache.status('k') === 'stale' && cache.peek<string>('k')?.data === 'old');
    let notified = 0;
    cache.subscribe('k', () => { notified++; });
    p = cache.load('k', d.fetcher); await flush();
    check('background revalidation starts', d.calls.n === 2 && cache.isInFlight('k'));
    check('while revalidating, the stale data is still what peek returns (no blanking)', cache.peek<string>('k')?.data === 'old');
    d.resolveLast('new');
    const e = await p;
    check('SUCCESS: cache updated with new data', cache.peek<string>('k')?.data === 'new' && e.data === 'new');
    check('SUCCESS: fetchedAt updated to the new fetch time', cache.peek('k')?.fetchedAt === c.now() && cache.status('k') === 'fresh');
    check('SUCCESS: subscribers were notified once', notified === 1);
    check('in-flight state cleared', !cache.isInFlight('k'));
  }

  console.log('\n[E — FAILED revalidation keeps stale data]');
  {
    const c = clock();
    const cache = createSwrCache({ now: c.now });
    const d = deferred<string>();
    let p = cache.load('k', d.fetcher); await flush(); d.resolveLast('good'); await p;
    const originalFetchedAt = cache.peek('k')!.fetchedAt;
    c.advance(10 * MIN);
    let notified = 0;
    cache.subscribe('k', () => { notified++; });
    p = cache.load('k', d.fetcher); await flush();
    d.rejectLast(new Error('network down'));
    let rejected = false;
    try { await p; } catch (e) { rejected = e instanceof Error && e.message === 'network down'; }
    check('the failure is reported to the caller', rejected);
    check('stale data is NOT deleted', cache.peek<string>('k')?.data === 'good');
    check('fetchedAt does not falsely become fresh', cache.peek('k')!.fetchedAt === originalFetchedAt && cache.status('k') === 'stale');
    check('in-flight slot cleared (not stuck on the rejected promise)', !cache.isInFlight('k'));
    check('subscribers are not notified on failure', notified === 0);
    p = cache.load('k', d.fetcher); await flush();
    check('a later load retries (new request)', d.calls.n === 3);
    d.resolveLast('recovered'); await p;
    check('recovery replaces data and refreshes fetchedAt', cache.peek<string>('k')?.data === 'recovered' && cache.status('k') === 'fresh');
    // synchronously-throwing fetcher must not wedge the slot
    let threw = false;
    try { await cache.load('boom', () => { throw new Error('sync'); }, { force: true }); } catch { threw = true; }
    check('a synchronously-throwing fetcher rejects cleanly and leaves no in-flight slot', threw && !cache.isInFlight('boom') && cache.peek('boom') === undefined);
  }

  console.log('\n[F — DEDUPLICATION]');
  {
    const cache = createSwrCache({ now: clock().now });
    const d = deferred<string>();
    const p1 = cache.load('shared', d.fetcher);
    const p2 = cache.load('shared', d.fetcher);
    await flush();
    check('two concurrent callers for one key share ONE request', d.calls.n === 1);
    d.resolveLast('x');
    const [a, b] = await Promise.all([p1, p2]);
    check('both callers receive the same entry', a === b && a.data === 'x');
    const d2 = deferred<string>();
    cache.load('other', d2.fetcher); cache.load('shared2', d2.fetcher); await flush();
    check('different keys are NOT merged', d2.calls.n === 2);
    check('force bypasses freshness but still dedupes with an in-flight request', (() => { const p = cache.load('shared', d.fetcher, { force: true }); const q = cache.load('shared', d.fetcher, { force: true }); return p === q; })());
  }

  console.log('\n[G — WINDOW ISOLATION (keys)]');
  {
    const end = '2026-09-17';
    const k4 = listingDemandKey(4, '2026-09-11', end);
    const k8 = listingDemandKey(8, '2026-09-11', end);
    const k12 = listingDemandKey(12, '2026-09-11', end);
    check('4W / 8W / 12W demand keys are distinct', new Set([k4, k8, k12]).size === 3, [k4, k8, k12]);
    check('demand key carries the exact period dates (a new day is a different key)', listingDemandKey(8, '2026-09-12', '2026-09-18') !== k8);
    check('demand keys start with the demand prefix; evidence key is separate', k8.startsWith(LISTING_DEMAND_PREFIX) && !LISTING_EVIDENCE_KEY.startsWith(LISTING_DEMAND_PREFIX));
    const i1 = itemActivityKey(8, '2026-07-24', '2026-09-17');
    check('item-activity key carries weeks + exact from + exact to', i1 === `${ITEM_ACTIVITY_PREFIX}8:2026-07-24:2026-09-17`, i1);
    check('item-activity keys differ by weeks, from, or to', new Set([i1, itemActivityKey(4, '2026-07-24', '2026-09-17'), itemActivityKey(8, '2026-07-25', '2026-09-17'), itemActivityKey(8, '2026-07-24', '2026-09-16')]).size === 4);

    const cache = createSwrCache({ now: clock().now });
    await cache.load(k4, async () => ({ weeks: 4 }));
    check('after caching 4W, the 8W key has NO entry (4W can never render under an 8W label)', cache.peek(k8) === undefined && cache.status(k8) === 'none');
    await cache.load(k8, async () => ({ weeks: 8 }));
    check('switching back and forth keeps BOTH entries (nothing deleted on selection change)', (cache.peek<{ weeks: number }>(k4)?.data.weeks === 4) && (cache.peek<{ weeks: number }>(k8)?.data.weeks === 8));
    check('12W still empty', cache.peek(k12) === undefined);
    await cache.load(i1, async () => ['a']);
    check('an item-activity window never resolves to another window\'s entry', cache.peek(itemActivityKey(8, '2026-07-24', '2026-09-16')) === undefined && cache.peek(i1)?.data !== undefined);
  }

  console.log('\n[H — RETURN FLOW: cached 8W survives navigate away/back]');
  {
    const c = clock();
    const cache = createSwrCache({ now: c.now });
    const k8 = listingDemandKey(8, '2026-09-11', '2026-09-17');
    const evKey = LISTING_EVIDENCE_KEY;
    const itemKey = itemActivityKey(8, '2026-07-24', '2026-09-17');
    await cache.load(evKey, async () => 'snapshot');
    await cache.load(k8, async () => 'demand8');
    await cache.load(itemKey, async () => 'items8');
    // user leaves /listings for /leads (component unmounts; module cache persists), returns ~1 minute later
    c.advance(1 * MIN);
    let calls = 0;
    const counting = (v: string) => async () => { calls++; return v; };
    check('on return, all three sources render from cache on the first paint', cache.peek(evKey)?.data === 'snapshot' && cache.peek(k8)?.data === 'demand8' && cache.peek(itemKey)?.data === 'items8');
    await Promise.all([cache.load(evKey, counting('x')), cache.load(k8, counting('x')), cache.load(itemKey, counting('x'))]);
    check('fresh return triggers NO refetch at all', calls === 0);
    c.advance(10 * MIN);
    check('returning after 11 minutes still renders cached data immediately (stale)', [evKey, k8, itemKey].every((k) => cache.status(k) === 'stale' && cache.peek(k) !== undefined));
    await Promise.all([cache.load(evKey, counting('snapshot2')), cache.load(k8, counting('demand8b')), cache.load(itemKey, counting('items8b'))]);
    check('stale return revalidates each source exactly once, independently', calls === 3 && cache.peek(k8)?.data === 'demand8b');
  }

  console.log('\n[I — independent failure boundaries]');
  {
    const cache = createSwrCache({ now: clock().now });
    await cache.load('a', async () => 'A');
    let bFailed = false;
    try { await cache.load('b', async () => { throw new Error('b down'); }); } catch { bFailed = true; }
    check('one source failing never affects another source\'s cached data', bFailed && cache.peek('a')?.data === 'A' && cache.peek('b') === undefined);
  }

  console.log('\n[J — invalidation]');
  {
    const c = clock();
    const cache = createSwrCache({ now: c.now });
    const inv = createListingsInvalidators(cache);
    const demand = listingDemandKey(4, '2026-09-11', '2026-09-17');
    const item = itemActivityKey(4, '2026-08-21', '2026-09-17');
    await cache.load(LISTING_EVIDENCE_KEY, async () => 'e');
    await cache.load(demand, async () => 'd');
    await cache.load(item, async () => 'i');
    inv.invalidateListingDemandCache();
    check('scoped: invalidateListingDemandCache marks only demand stale', cache.status(demand) === 'stale' && cache.status(LISTING_EVIDENCE_KEY) === 'fresh' && cache.status(item) === 'fresh');
    check('invalidated data is kept renderable (revalidated on next visit)', cache.peek(demand)?.data === 'd');
    inv.invalidateItemActivityCache();
    check('scoped: invalidateItemActivityCache', cache.status(item) === 'stale' && cache.status(LISTING_EVIDENCE_KEY) === 'fresh');
    inv.invalidateListingEvidenceCache();
    check('scoped: invalidateListingEvidenceCache', cache.status(LISTING_EVIDENCE_KEY) === 'stale');
    await cache.load(LISTING_EVIDENCE_KEY, async () => 'e2'); await cache.load(demand, async () => 'd2'); await cache.load(item, async () => 'i2');
    inv.invalidateListingsCache();
    check('invalidateListingsCache marks everything stale', [LISTING_EVIDENCE_KEY, demand, item].every((k) => cache.status(k) === 'stale'));
    // a request already in flight when a mutation lands must not pose as fresh
    const d = deferred<string>();
    await cache.load(demand, async () => 'd3');
    const p = cache.load(demand, d.fetcher, { force: true }); await flush();
    inv.invalidateListingDemandCache();
    d.resolveLast('pre-mutation'); await p;
    check('a fetch that started BEFORE the invalidation lands as stale, not fresh', cache.peek(demand)?.data === 'pre-mutation' && cache.status(demand) === 'stale');
  }

  console.log('\n[K — AUTH / user isolation]');
  {
    const c = clock();
    const cache = createSwrCache({ now: c.now });
    const guard = createUserScopeGuard(cache);
    guard('INITIAL_SESSION', 'user-A');
    await cache.load('k', async () => 'A-data');
    guard('TOKEN_REFRESHED', 'user-A');
    guard('USER_UPDATED', 'user-A');
    check('token refresh / same user keeps the cache', cache.peek('k')?.data === 'A-data');
    guard('SIGNED_OUT', null);
    check('SIGNED_OUT clears everything', cache.peek('k') === undefined && cache.status('k') === 'none');
    guard('SIGNED_IN', 'user-B');
    check('after user B signs in, user A\'s data is gone', cache.peek('k') === undefined);

    // user switch without an explicit sign-out event
    await cache.load('k', async () => 'B-data');
    guard('SIGNED_IN', 'user-C');
    check('a different signed-in user id clears the cache even without SIGNED_OUT', cache.peek('k') === undefined);

    // an in-flight request from user A must never be stored for user B
    const g2cache = createSwrCache({ now: c.now });
    const g2 = createUserScopeGuard(g2cache);
    g2('INITIAL_SESSION', 'user-A');
    const d = deferred<string>();
    const p = g2cache.load('k', d.fetcher); await flush();
    g2('SIGNED_OUT', null); g2('SIGNED_IN', 'user-B');
    d.resolveLast('A-late-response');
    let discarded = false;
    try { await p; } catch (e) { discarded = e instanceof CacheClearedError; }
    check('a response that lands after a user change is discarded (CacheClearedError), not stored', discarded && g2cache.peek('k') === undefined);
    check('the in-flight slot is not left blocking user B', !g2cache.isInFlight('k'));
    const d3 = deferred<string>();
    const pB = g2cache.load('k', d3.fetcher); await flush(); d3.resolveLast('B-data'); await pB;
    check('user B then fetches and caches its own data', g2cache.peek('k')?.data === 'B-data' && d3.calls.n === 1);

    const store = strip(read('src', 'lib', 'listingsCacheStore.ts'));
    const supa = read('src', 'lib', 'supabase.ts');
    check('supabase.ts forwards every auth event to the Listings user guard', /onAuthStateChange\(\(event, session\) =>/.test(supa) && /listingsUserGuard\(event, session\?\.user\?\.id \?\? null\)/.test(supa));
    check('cache is module-level in-memory only (no server/global/persistent store)', !/localStorage|sessionStorage|indexedDB|serviceWorker|caches\.open|redis/i.test(store + strip(read('src', 'lib', 'swrCache.ts')) + strip(read('src', 'lib', 'useSwrResource.ts'))));
    check('no server-side cache of user data was added (API routes untouched)', !/swrCache|listingsCache/.test(read('src', 'app', 'api', 'listing-demand-evidence', 'route.ts') + read('src', 'app', 'api', 'listing-item-activity', 'route.ts') + read('src', 'app', 'api', 'leads', 'route.ts')));
  }

  console.log('\n[L — hook & page wiring]');
  {
    const hook = strip(read('src', 'lib', 'useSwrResource.ts'));
    check('hook reads cache.peek(key) synchronously during render (first paint has cached data)', /const entry = key !== null \? cache\.peek<T>\(key\)/.test(hook));
    check('hook only starts a request when not fresh', /if \(cache\.status\(key\) !== 'fresh'\) start\(\)/.test(hook));
    check('hook never sets state after unmount / on a stale key (cancelled flag)', /let cancelled = false/.test(hook) && /if \(cancelled/.test(hook) && /cancelled = true/.test(hook));
    check('loading only when there is no entry; error only when there is no entry', /isLoading: key !== null && !entry/.test(hook) && /error: !entry && mine/.test(hook) && /refreshError: entry && mine/.test(hook));
    check('a CacheClearedError is not surfaced as a page error', /CacheClearedError/.test(hook));

    const page = strip(read('src', 'app', 'listings', 'page.tsx'));
    check('all three sources use the shared cache hook', (page.match(/useSwrResource</g) ?? []).length === 3 && /LISTING_EVIDENCE_KEY/.test(page) && /listingDemandKey\(trendWeeks, demandStart, demandEnd\)/.test(page) && /itemActivityKey\(trendWeeks, itemWindow\.from, itemWindow\.to\)/.test(page));
    check('Market + Channel Activity share ONE demand resource (single fetch site)', (page.match(/fetchListingDemandEvidenceForCurrentUser\(/g) ?? []).length === 1);
    check('no ad-hoc fetch effects remain in the page', !/useEffect/.test(page) && !/\.then\(\(result\)/.test(page));
    check('background refresh never dims or hides content (no opacity mask, subtle "Updating…" only)', !/opacity-60/.test(page) && /Updating…/.test(page) && /role="status"/.test(page));
    check('stale demand data is validated against the selected trend window', /demandRes\.data\.trend_window_weeks === trendWeeks/.test(page));
    check('Listing Evidence failure still does not hide demand sections (independence preserved)', !/<MarketActivitySection|<ChannelActivitySection|<ItemActivitySection/.test(Array.from(page.matchAll(/\{evidence && \(([\s\S]*?)\n {6}\)\}/g)).map((m) => m[1]).join('\n')));
    check('the Trend Window is still URL-driven (no local trend state)', /parseTrendWeeksParam\(searchParams\.get\('trend_weeks'\)\)/.test(page) && !/useState/.test(page));
  }

  console.log('\n[M — invalidation wiring (existing mutations)]');
  {
    const supa = read('src', 'lib', 'supabase.ts');
    check('helper only invalidates on success', /function invalidateListingsOnSuccess[\s\S]*?if \(!result\.error\) invalidateListingsCache\(\)/.test(supa));
    for (const fn of ['create_buy_operation', 'create_sell_operation', 'create_trade_operation', 'edit_buy_operation', 'edit_sell_operation', 'edit_trade_operation']) {
      check(`rpc ${fn} invalidates on success`, new RegExp(`supabase\\.rpc\\('${fn}', \\{[\\s\\S]*?\\}\\)\\.then\\(invalidateListingsOnSuccess\\)`).test(supa));
    }
    for (const fn of ['startListing', 'updateListingPrice', 'endListing', 'cancelListing']) {
      const i = supa.indexOf(`export async function ${fn}(`);
      const body = supa.slice(i, supa.indexOf('\n}\n', i));
      check(`${fn} invalidates on success`, /invalidateListingsOnSuccess/.test(body));
    }
    const src = strip(read('src', 'lib', 'listingsCacheStore.ts'));
    check('invalidation API exported: evidence / demand / item activity / all', /invalidateListingEvidenceCache/.test(src) && /invalidateListingDemandCache/.test(src) && /invalidateItemActivityCache/.test(src) && /invalidateListingsCache/.test(src));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
