/**
 * test-item-activity-ui.ts
 *
 * No-DB validation for the /listings "Lead Activity by Item" section, its
 * item -> /leads drill-down URLs, the /leads item_attributed semantics,
 * the Back-to-Listings link, and the Listing/Demand Evidence error
 * isolation fix. (DB-backed reconciliation: test-listing-item-activity.ts.)
 *
 * Usage:  npx tsx scripts/test-item-activity-ui.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { itemActivityWindow, itemActiveChannelsLabel, sortItemActivity, type ItemActivityEntry } from '../src/lib/listingItemActivityHelpers';
import { itemAttributedLeadsUrl, itemOffersUrl, itemSeriousPlusUrl } from '../src/lib/leads/leadDrilldownUrls';
import {
  EMPTY_LEAD_FILTERS, applyLeadFilters, itemAttributionRequest, leadsUrl, parseLeadFilters, patchLeadFilters,
} from '../src/lib/leads/leadFilters';
import { LEAD_HELP } from '../src/lib/leads/leadHelpText';
import { LISTING_HELP } from '../src/lib/listingHelpText';
import type { ListingDemandEvidence } from '../src/lib/analytics/listingDemandEvidence';
import type { LeadRow } from '../src/lib/leads/leadTypes';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}

const root = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const strip = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const params = (qs: string) => { const sp = new URLSearchParams(qs); return (k: string) => sp.get(k); };

function entry(over: Partial<ItemActivityEntry>): ItemActivityEntry {
  return {
    item_id: 1, item_display_name: 'Item', active_channels: [], item_attributed_leads: 0, serious_plus_attributed_leads: 0,
    offer_attributed_leads: 0, item_listing_days: 0, channel_listing_days: 0, last_attributed_lead_date: null, ...over,
  };
}
function weekly(n: number): ListingDemandEvidence {
  const weeks = Array.from({ length: n }, (_, i) => {
    const startEpoch = Date.UTC(2020, 0, 30) / 86400000 - (n - i) * 7 + 1;
    const f = (e: number) => new Date(e * 86400000).toISOString().slice(0, 10);
    return { start_date: f(startEpoch), end_date: f(startEpoch + 6) };
  });
  return { weekly_trend: weeks, trend_window_weeks: n } as unknown as ListingDemandEvidence;
}

console.log('\n[A — exact Trend Window from weekly_trend boundaries]');
{
  for (const n of [4, 8, 12]) {
    const ev = weekly(n);
    const w = itemActivityWindow(ev)!;
    check(`${n}W: from = weekly_trend[0].start_date, to = weekly_trend[last].end_date`, w.from === ev.weekly_trend[0].start_date && w.to === ev.weekly_trend[n - 1].end_date && w.to === '2020-01-30', w);
  }
  check('4W spans 28 days, 8W 56, 12W 84', [4, 8, 12].every((n) => { const w = itemActivityWindow(weekly(n))!; return (Date.parse(w.to) - Date.parse(w.from)) / 86400000 + 1 === n * 7; }));
  check('no weekly buckets / no evidence -> no window', itemActivityWindow(null) === null && itemActivityWindow({ weekly_trend: [] } as unknown as ListingDemandEvidence) === null);
}

console.log('\n[B — default sorting]');
{
  const rows = [
    entry({ item_id: 1, item_display_name: 'Zed', item_attributed_leads: 0 }),
    entry({ item_id: 2, item_display_name: 'Beta', item_attributed_leads: 5, serious_plus_attributed_leads: 1, offer_attributed_leads: 1, last_attributed_lead_date: '2020-01-10' }),
    entry({ item_id: 3, item_display_name: 'Alpha', item_attributed_leads: 5, serious_plus_attributed_leads: 3, offer_attributed_leads: 0 }),
    entry({ item_id: 4, item_display_name: 'Gamma', item_attributed_leads: 5, serious_plus_attributed_leads: 1, offer_attributed_leads: 2 }),
    entry({ item_id: 5, item_display_name: 'Delta', item_attributed_leads: 5, serious_plus_attributed_leads: 1, offer_attributed_leads: 1, last_attributed_lead_date: '2020-01-20' }),
    entry({ item_id: 6, item_display_name: 'Aardvark', item_attributed_leads: 5, serious_plus_attributed_leads: 1, offer_attributed_leads: 1, last_attributed_lead_date: '2020-01-20' }),
    entry({ item_id: 7, item_display_name: 'Abe', item_attributed_leads: 0 }),
  ];
  const order = sortItemActivity(rows).map((r) => r.item_id).join(',');
  check('leads DESC -> Serious+ DESC -> Offers DESC -> last lead DESC -> name ASC; zero-lead kept (name ASC)', order === '3,4,6,5,2,7,1', order);
  check('undated last-lead sorts after dated', sortItemActivity([entry({ item_id: 1, item_display_name: 'A' }), entry({ item_id: 2, item_display_name: 'B', last_attributed_lead_date: '2020-01-01' })])[0].item_id === 2);
  check('sorting is non-mutating and never drops zero-activity items', rows[0].item_id === 1 && sortItemActivity(rows).length === rows.length);
  check('active channel names joined with " · " and de-duplicated', itemActiveChannelsLabel({ active_channels: [{ channel_id: 1, channel_name: 'A' }, { channel_id: 2, channel_name: 'B' }, { channel_id: 3, channel_name: 'A' }] }) === 'A · B' && itemActiveChannelsLabel({ active_channels: [] }) === '');
}

console.log('\n[C — item drill-down URLs]');
{
  const win = { from: '2020-01-03', to: '2020-01-30' };
  const src = { itemId: 55, leads: 12, seriousPlus: 9, offers: 7 };
  check('Leads -> item_id + exact from/to + item_attributed=1', itemAttributedLeadsUrl(win, src) === '/leads?item_id=55&from=2020-01-03&to=2020-01-30&item_attributed=1&expected=12', itemAttributedLeadsUrl(win, src));
  check('Serious+ adds serious_plus=1', itemSeriousPlusUrl(win, src) === '/leads?item_id=55&from=2020-01-03&to=2020-01-30&item_attributed=1&serious_plus=1&expected=9', itemSeriousPlusUrl(win, src));
  check('Offers adds offers=1', itemOffersUrl(win, src) === '/leads?item_id=55&from=2020-01-03&to=2020-01-30&item_attributed=1&offers=1&expected=7', itemOffersUrl(win, src));
  check('zero values are not links', itemAttributedLeadsUrl(win, { ...src, leads: 0 }) === null && itemSeriousPlusUrl(win, { ...src, seriousPlus: 0 }) === null && itemOffersUrl(win, { ...src, offers: 0 }) === null);
  check('URLs carry no lead ids / no channel params', ![itemAttributedLeadsUrl(win, src), itemSeriousPlusUrl(win, src), itemOffersUrl(win, src)].some((u) => /channel_id|attributed=1&channel|lead_id/.test(u!)));
  const f = parseLeadFilters((k) => new URL(itemOffersUrl(win, src)!, 'http://x').searchParams.get(k));
  check('URLs round-trip through parseLeadFilters', f.itemId === 55 && f.from === win.from && f.to === win.to && f.itemAttributed && f.offers && !f.seriousPlus && f.expected === 7);
}

console.log('\n[D — /leads item_attributed semantics]');
{
  const raw = parseLeadFilters(params('item_id=55&from=2020-01-03&to=2020-01-30'));
  const attr = parseLeadFilters(params('item_id=55&from=2020-01-03&to=2020-01-30&item_attributed=1'));
  check('plain item_id + from/to is a raw filter (not attributed)', !raw.itemAttributed && itemAttributionRequest(raw) === null);
  check('item_attributed=1 with item_id + from + to enables the cohort', attr.itemAttributed && itemAttributionRequest(attr)?.itemId === 55 && itemAttributionRequest(attr)?.from === '2020-01-03');
  check('item_attributed ignored without item_id', !parseLeadFilters(params('from=2020-01-03&to=2020-01-30&item_attributed=1')).itemAttributed);
  check('item_attributed ignored without from/to', !parseLeadFilters(params('item_id=55&item_attributed=1')).itemAttributed && !parseLeadFilters(params('item_id=55&from=2020-01-03&item_attributed=1')).itemAttributed);
  check('invalid dates / ids never enable it', !parseLeadFilters(params('item_id=abc&from=2020-01-03&to=2020-01-30&item_attributed=1')).itemAttributed && !parseLeadFilters(params('item_id=5&from=2020-13-03&to=2020-01-30&item_attributed=1')).itemAttributed);
  check('item_attributed is independent of channel `attributed` (both can coexist)', (() => { const b = parseLeadFilters(params('channel_id=1&item_id=5&from=2020-01-03&to=2020-01-30&attributed=1&item_attributed=1')); return b.attributed && b.itemAttributed; })());
  check('leadsUrl round-trips item_attributed', JSON.stringify(parseLeadFilters(params(leadsUrl(attr).split('?')[1]))) === JSON.stringify(attr) && leadsUrl(attr).includes('item_attributed=1') && !leadsUrl(raw).includes('item_attributed'));
  check('editing item/dates drops item_attributed; other filters keep it', !patchLeadFilters(attr, { itemId: 9 }).itemAttributed && !patchLeadFilters(attr, { from: '2020-01-01' }).itemAttributed && !patchLeadFilters(attr, { to: '2020-02-01' }).itemAttributed && patchLeadFilters(attr, { status: 'OPEN' }).itemAttributed);
  check('editing only the channel does NOT drop item_attributed', patchLeadFilters(attr, { channel: 2 }).itemAttributed);

  const mk = (id: number, first: string): LeadRow => ({
    id, lead_id: `u-${id}`, inventory_item_id: 55, item_name: 'X', first_contact_at: first, last_contact_at: first, source_channel: null, deal_channel_id: null, channel_name: null,
    buyer_message_count: 1, our_message_count: 1, lead_quality: 'LOW', offer_type: 'NONE', initial_cash_offer: null, best_cash_offer: null, trade_item: null, cash_component: null,
    trade_est_value: null, status: 'OPEN', outcome_reason: null, notes: null, source_updated_at: '2020-01-30T00:00:00Z', last_imported_at: null,
  });
  const rows = [mk(1, '2020-01-02'), mk(2, '2020-01-10'), mk(3, '2020-01-20')];
  check('raw filter returns every in-window lead of the item', applyLeadFilters(rows, raw, null, null).length === 2);
  check('cohort filter returns ONLY the attributed ids (never plain item/date)', applyLeadFilters(rows, attr, null, new Set([3])).map((r) => r.id).join() === '3');
  check('cohort URL with no cohort set is empty, not silently raw', applyLeadFilters(rows, attr, null, null).length === 0);
  check('EMPTY filters have itemAttributed false', EMPTY_LEAD_FILTERS.itemAttributed === false);

  const page = read('src', 'app', 'leads', 'page.tsx');
  const pageNc = strip(page);
  check('chip "Listing-attributed" rendered when item_attributed is active', /Listing-attributed/.test(pageNc) && /data-chip="item-attributed"/.test(pageNc) && /filters\.itemAttributed/.test(pageNc));
  check('chip has the InfoTip with the specified text', /LEAD_HELP\.itemAttributed/.test(pageNc) && LEAD_HELP.itemAttributed.text === 'Only leads whose first contact occurred while this item had active listing exposure during the selected period.' && LEAD_HELP.itemAttributed.label === 'Listing-attributed');
  check('internal RPC names never appear in the UI', !/lead_drilldown|_v1_0/.test(pageNc));
  check('existing channel-attributed chip untouched', /data-chip="attributed"/.test(pageNc) && /Channel-attributed/.test(pageNc));
  check('cohorts are requested from the server (no client-side attribution)', /itemAttributionRequest\(filters\)/.test(pageNc) && /fetchLeads\(/.test(pageNc) && /itemAttributedSet/.test(pageNc));
  check('URL remains the source of truth (no filter state)', /parseLeadFilters\(\(k\) => searchParams\.get\(k\)\)/.test(pageNc) && !/useState<LeadFilters/.test(pageNc));
  check('contextual back arrow in the /leads header (BackLink -> Back to Listings)', /<BackLink href=\{resolveBackHref\(filters\.returnTo\)\} label="Back to Listings"/.test(pageNc) && /back=\{/.test(pageNc));
  const layout = read('src', 'app', 'layout.tsx');
  const navs = layout.match(/<nav[\s\S]*?<\/nav>/g) ?? [];
  navs.forEach((nav, i) => {
    const labels = (nav.match(/>([^<]+)<\/a>/g) ?? []).map((m) => m.slice(1, -4).trim());
    check(`primary nav ${i + 1} unchanged: Dashboard/Inventory/Listings/Operations (no Leads, no Cash Flow)`, JSON.stringify(labels) === JSON.stringify(['Dashboard', 'Inventory', 'Listings', 'Operations']), labels);
  });
  const route = read('src', 'app', 'api', 'leads', 'route.ts');
  check('/api/leads validates item cohort params (item_id + item_from + item_to together) and stays GET-only', /item_from/.test(route) && /itemAttribution/.test(route) && !/export async function (POST|PUT|PATCH|DELETE)/.test(route));
}

console.log('\n[E — /listings: section placement, window, fetching]');
{
  const src = read('src', 'app', 'listings', 'page.tsx');
  const page = strip(src);
  const idx = (s: string) => page.indexOf(s);
  const order = ['<OverviewSection evidence', '<MarketActivitySection', '<ChannelActivitySection', '<ItemActivitySection', '<UnlistedSection evidence'].map(idx);
  check('section order: Overview, Market, Channel, Lead Activity by Item, Unlisted', order.every((i) => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]), order);
  check('exactly one Trend Window control (no second selector for items)', (page.match(/<TrendWindowControl/g) ?? []).length === 1 && (page.match(/TREND_WEEKS_OPTIONS\.map/g) ?? []).length === 1);
  check('item section takes the page-level trendWeeks', /<ItemActivitySection[^>]*trendWeeks=\{trendWeeks\}/.test(page));
  check('window comes from Listing Demand Evidence weekly_trend via itemActivityWindow(demandEvidence)', /itemActivityWindow\(demandEvidence\)/.test(page) && !/new Date|Date\.UTC|setDate/.test(page));
  check('item data derives from Demand Evidence of the CURRENT trend window (trend_window_weeks === trendWeeks)', /demandRes\.data\.trend_window_weeks === trendWeeks/.test(page) && /itemActivityWindow\(demandEvidence\)/.test(page));
  check('one compact request per window, keyed on weeks + exact from/to (never per item / per row)', /itemActivityKey\(trendWeeks, itemWindow\.from, itemWindow\.to\)/.test(page) && (page.match(/fetchListingItemActivity\(/g) ?? []).length === 1 && !/\/api\/leads/.test(page));
  check('other windows are never shown (data is looked up by the CURRENT window key)', /useSwrResource<ItemActivityEntry\[\]>\(listingsCache, itemKey/.test(page));
  check('no fixed 7-day item table', !/resolveDayCountPreset\(7\)[\s\S]{0,200}fetchListingItemActivity/.test(page));
  check('no duplicate/local trend state', !/useState<TrendWeeks>/.test(page) && /parseTrendWeeksParam\(searchParams\.get\('trend_weeks'\)\)/.test(page));
  check('Overview and Unlisted stay snapshot-only (no trendWeeks/itemWindow)', !/function OverviewSection[\s\S]*?\n}\n/.exec(page)?.[0].match(/trendWeeks|itemWindow/) && !/function UnlistedSection[\s\S]*?\n}\n/.exec(page)?.[0].match(/trendWeeks|itemWindow/));
}

console.log('\n[F — Lead Activity by Item UI]');
{
  const src = read('src', 'app', 'listings', 'page.tsx');
  const page = strip(src);
  const sec = page.slice(page.indexOf('function ItemActivitySection'), page.indexOf('function UnlistedSection'));
  const heads = (sec.match(/<th [^>]*>([\s\S]*?)<\/th>/g) ?? []).map((h) => h.replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim());
  check('desktop columns: Item / Leads / Serious+ / Offers / Channel Days / Last Lead', heads.length === 6 && heads[0] === 'Item' && heads[5] === 'Last Lead', heads);
  check('desktop table exists and is hidden below md; mobile cards are md:hidden', /hidden overflow-x-auto[^"]*md:block/.test(sec) && /md:hidden/.test(sec) && /data-item-card/.test(sec) && /data-item-row/.test(sec));
  check('uses sortItemActivity (default order) and keeps zero-lead items', /sortItemActivity\(items\)/.test(sec) && !/filter\(\(?i(tem)?\)? =>[^)]*item_attributed_leads/.test(sec));
  check('active channel names under the item name', /itemActiveChannelsLabel\(item\)/.test(sec));
  check('item name links to Inventory item detail (both layouts)', (sec.match(/href=\{`\/inventory\/\$\{item\.item_id\}`\}/g) ?? []).length === 2);
  check('Leads / Serious+ / Offers drill-downs use the URL builders (desktop + mobile)', ['itemAttributedLeadsUrl', 'itemSeriousPlusUrl', 'itemOffersUrl'].every((b) => (sec.match(new RegExp(`${b}\\(win`, 'g')) ?? []).length === 2));
  check('Channel Days and Last Lead are NOT links', !/DrillValue[^>]*>\{item\.channel_listing_days|DrillValue[^>]*>\{item\.last_attributed_lead_date/.test(sec) && !/<Link[^>]*>\s*\{item\.(channel_listing_days|last_attributed_lead_date)/.test(sec));
  check('rows are not whole-row clickable (item nav vs lead drill-down stay distinct)', !/<tr[^>]*onClick/.test(sec) && !/onClick/.test(sec));
  check('no scores / hot-cold / recommendations / message or money columns', !/\b(hot|cold|score|recommend)/i.test(sec) && !/message|best_cash|trade_est|cash_component|roi|profit|purpose|notes|lead_id/i.test(sec.replace(/MetricLabel|md:hidden|icon="message"/g, '')));
  check('empty state keeps the section (no items)', /No currently listed items\./.test(sec));
  check('InfoTips: section title, Offers, Channel Days', /titleHelp="leadActivityByItem"/.test(sec) && /help="offersAttributed"/.test(sec) && /help="channelDays"/.test(sec));
  check('help copy matches spec', LISTING_HELP.leadActivityByItem.text === 'Buyer lead activity attributed to currently listed items during the selected Trend Window.'
    && LISTING_HELP.channelDays.text === 'Total item-channel listing exposure during the selected Trend Window. One item listed on one channel for one day equals one Channel Day.'
    && LISTING_HELP.offersAttributed.text === 'Attributed leads with a recorded CASH, TRADE, or MIXED offer.');
  check('semantic colors: Leads cyan pill, Serious+ violet, Offers restrained slate, exposure subdued', /TONE\.cyan\.pill/.test(sec) && /TONE\.violet\.text/.test(sec) && /text-slate-700 dark:text-slate-200/.test(sec) && /text-slate-500 dark:text-slate-400">\{item\.channel_listing_days/.test(sec));
  check('no hardcoded channel names', !/['"`>](Reverb|Marketplace|Kijiji)['"`<]/.test(sec));
  check('mobile card is compact: 4-up stat grid + one Last Lead line', /grid grid-cols-4 gap-2/.test(sec) && /Last Lead/.test(sec));
}

console.log('\n[G — error isolation (Listing Evidence vs Demand Evidence)]');
{
  const src = read('src', 'app', 'listings', 'page.tsx');
  const gates = Array.from(src.matchAll(/\{evidence && \(([\s\S]*?)\n {6}\)\}/g)).map((m) => m[1]).join('\n');
  check('Overview and Unlisted are each gated on Listing Evidence only', /<OverviewSection/.test(gates) && /<UnlistedSection/.test(gates) && !/demandEvidence|demandError/.test(gates));
  check('Market / Channel / Item Activity render OUTSIDE any Listing Evidence gate', !/<MarketActivitySection|<ChannelActivitySection|<ItemActivitySection/.test(gates) && /<MarketActivitySection/.test(src));
  check('Trend Window control is in the Market Activity header, independent of evidence', /action=\{<TrendWindowControl/.test(src));
  check('Listing Evidence failure only shows its own banner', /\{error && \(/.test(src) && /Loading listing evidence/.test(src));
  check('Demand failure is shown inside the demand sections (own error prop), not page-wide', /error=\{demandError\}/.test(src) && !/\{demandError && \(\s*<div className="rounded-3xl/.test(src));
  check('item section is independent of Listing Evidence (never reads `evidence`)', !/<ItemActivitySection[^>]*evidence=\{evidence\}/.test(src));
}

console.log('\n[H — migration & API wiring]');
{
  const migs = fs.readdirSync(path.join(root, 'supabase', 'migrations')).sort();
  const mine = migs.find((m) => m.startsWith('20260919000000_'));
  const prev = migs.find((m) => m.startsWith('20260918000000_'));
  check('new migration exists and sorts after the channel-attribution migration', !!mine && !!prev && mine > prev, { mine, prev });
  const sql = mine ? read('supabase', 'migrations', mine) : '';
  check('migration is additive: only CREATE FUNCTION / REVOKE / GRANT / COMMENT (no DROP/ALTER/DELETE/UPDATE/INSERT)', !/\bDROP\b|\bALTER\b|\bDELETE\b|\bINSERT\b|\bUPDATE\b|\bTRUNCATE\b|CREATE TABLE/i.test(strip(sql.replace(/^--.*$/gm, ''))));
  check('service_role only (REVOKE from authenticated, GRANT to service_role)', /REVOKE ALL ON FUNCTION public\.listing_demand_item_activity_v1_0[\s\S]*authenticated/.test(sql) && /GRANT EXECUTE ON FUNCTION public\.listing_demand_item_activity_v1_0\(int, date, date\) TO service_role/.test(sql));
  check('reuses canonical exposure + item evidence (no duplicated formulas)', /listing_exposure_days_v1_0/.test(sql) && /_listing_demand_item_evidence_v1_0/.test(sql));
  const route = read('src', 'app', 'api', 'listing-item-activity', 'route.ts');
  check('/api/listing-item-activity is GET-only, bearer-authenticated, own-user only', /export async function GET/.test(route) && !/export async function (POST|PUT|PATCH|DELETE)/.test(route) && /Missing authorization token/.test(route) && /auth_user_id/.test(route));
  check('route validates dates and caps window size', /isValidDateParam/.test(route) && /MAX_WINDOW_DAYS/.test(route));
  check('no /api/leads or per-item request from the item client', !/\/api\/leads/.test(read('src', 'lib', 'analytics', 'listingItemActivityClient.ts')));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
