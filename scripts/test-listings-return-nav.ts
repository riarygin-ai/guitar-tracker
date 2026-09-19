/**
 * test-listings-return-nav.ts
 *
 * No-DB validation for contextual Back navigation Listings <-> Leads:
 * return_to safety/round-trip, exact Listings state (trend_weeks and any
 * other current query param) preserved, the Inventory-style back arrow,
 * no custom history stack, and that Leads stays out of the primary nav.
 *
 * Usage:  npx tsx scripts/test-listings-return-nav.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { currentListingsReturnTo, resolveBackHref, safeReturnTo } from '../src/lib/listingsReturn';
import {
  channelAttributedLeadsUrl, channelSeriousPlusUrl, itemAttributedLeadsUrl, itemOffersUrl, itemSeriousPlusUrl, marketWeekLeadsUrl, marketWeekSeriousPlusUrl,
} from '../src/lib/leads/leadDrilldownUrls';
import { EMPTY_LEAD_FILTERS, leadsUrl, parseLeadFilters, patchLeadFilters } from '../src/lib/leads/leadFilters';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}

const root = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const strip = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const parse = (url: string) => parseLeadFilters((k) => new URL(url, 'http://x').searchParams.get(k));

const week = { startDate: '2026-09-11', endDate: '2026-09-17', leadsStarted: 9, seriousPlusLeads: 4 };
const period = { startDate: '2026-09-11', endDate: '2026-09-17' };
const chan = { dealChannelId: 2, attributedLeads: 5, seriousPlusLeads: 3 };
const win = { from: '2026-07-24', to: '2026-09-17' };
const item = { itemId: 55, leads: 4, seriousPlus: 2, offers: 1 };

console.log('\n[A — return_to safety]');
{
  for (const ok of ['/listings', '/listings?trend_weeks=8', '/listings?trend_weeks=12', '/listings?trend_weeks=8&future=1']) check(`accepts ${ok}`, safeReturnTo(ok) === ok);
  const bad = [
    'https://example.com', 'http://example.com/listings', '//example.com', '//example.com/listings', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)',
    'data:text/html,x', '\\\\example.com', '/\\example.com', '/listings\\evil', '/listings#frag', '/listings?x=1#frag', '/listings evil', '/listings\n', '/listings?a=\r\nb',
    '/leads', '/inventory', '/listingsx', '/listings/../inventory', '/listings/extra', 'listings', '', ' /listings', '/listings?x=é', '/' + 'a'.repeat(600),
  ];
  for (const b of bad) check(`rejects ${JSON.stringify(b.length > 40 ? b.slice(0, 37) + '...' : b)}`, safeReturnTo(b) === null);
  check('null / undefined -> null', safeReturnTo(null) === null && safeReturnTo(undefined) === null);
  check('missing return_to falls back to /listings', resolveBackHref(null) === '/listings' && resolveBackHref(undefined) === '/listings');
  check('unsafe return_to falls back to /listings (no open redirect)', resolveBackHref('https://evil.example') === '/listings' && resolveBackHref('//evil.example') === '/listings' && resolveBackHref('javascript:1') === '/listings');
  check('safe return_to is used as-is', resolveBackHref('/listings?trend_weeks=8') === '/listings?trend_weeks=8');
}

console.log('\n[B — current Listings URL -> return context (4W / 8W / 12W / extra params)]');
{
  check('4W (default, no query) -> /listings', currentListingsReturnTo('') === '/listings');
  check('8W -> /listings?trend_weeks=8', currentListingsReturnTo('trend_weeks=8') === '/listings?trend_weeks=8');
  check('12W -> /listings?trend_weeks=12', currentListingsReturnTo('trend_weeks=12') === '/listings?trend_weeks=12');
  check('a leading "?" is tolerated', currentListingsReturnTo('?trend_weeks=8') === '/listings?trend_weeks=8');
  check('additional current params are preserved verbatim', currentListingsReturnTo('trend_weeks=12&view=compact&x=a%20b') === '/listings?trend_weeks=12&view=compact&x=a%20b');
  check('an unsafe query degrades to /listings instead of embedding it', currentListingsReturnTo('a=1#evil') === '/listings' && currentListingsReturnTo('a=b c') === '/listings');
}

console.log('\n[C — every Listings drill-down carries return_to]');
{
  const builders: [string, (rt: string) => string | null][] = [
    ['market week Leads', (rt) => marketWeekLeadsUrl(week, rt)],
    ['market week Serious+', (rt) => marketWeekSeriousPlusUrl(week, rt)],
    ['channel Attributed Leads', (rt) => channelAttributedLeadsUrl(period, chan, rt)],
    ['channel Serious+', (rt) => channelSeriousPlusUrl(period, chan, rt)],
    ['item Leads', (rt) => itemAttributedLeadsUrl(win, item, rt)],
    ['item Serious+', (rt) => itemSeriousPlusUrl(win, item, rt)],
    ['item Offers', (rt) => itemOffersUrl(win, item, rt)],
  ];
  for (const [name, build] of builders) {
    const u4 = build('/listings')!;
    const u8 = build('/listings?trend_weeks=8')!;
    const u12 = build('/listings?trend_weeks=12&view=compact')!;
    check(`${name}: 4W return_to=/listings (URL-encoded)`, u4.includes('return_to=%2Flistings') && !u4.includes('return_to=%2Flistings%3F') && parse(u4).returnTo === '/listings', u4);
    check(`${name}: 8W preserves trend_weeks=8`, u8.includes('return_to=%2Flistings%3Ftrend_weeks%3D8') && parse(u8).returnTo === '/listings?trend_weeks=8', u8);
    check(`${name}: 12W + extra params round-trip exactly`, parse(u12).returnTo === '/listings?trend_weeks=12&view=compact', u12);
    check(`${name}: drill-down filters are unchanged by return_to`, JSON.stringify({ ...parse(u8), returnTo: null }) === JSON.stringify({ ...parse(build('/listings')!.replace(/&return_to=[^&]*/, '')), returnTo: null }));
  }
  check('zero counts still produce no link even with a return_to', marketWeekLeadsUrl({ ...week, leadsStarted: 0 }, '/listings?trend_weeks=8') === null && itemOffersUrl(win, { ...item, offers: 0 }, '/listings') === null);
  check('return_to is optional: omitted -> no return_to param', !marketWeekLeadsUrl(week)!.includes('return_to') && !itemAttributedLeadsUrl(win, item)!.includes('return_to'));
  check('unsafe return_to in the URL is dropped on parse (never honored)', parse('/leads?return_to=https%3A%2F%2Fevil.example').returnTo === null && parse('/leads?return_to=%2F%2Fevil.example').returnTo === null);
  check('the existing dates/cohort params are untouched (exact from/to, attributed flags)', marketWeekLeadsUrl(week, '/listings?trend_weeks=8')!.startsWith('/leads?from=2026-09-11&to=2026-09-17&expected=9') && channelAttributedLeadsUrl(period, chan, '/listings')!.includes('attributed=1'));
}

console.log('\n[D — return_to survives /leads interactions]');
{
  const f = parse(itemAttributedLeadsUrl(win, item, '/listings?trend_weeks=8')!);
  check('patching a filter keeps return_to', patchLeadFilters(f, { status: 'OPEN' }).returnTo === '/listings?trend_weeks=8');
  check('removing the cohort / editing dates keeps return_to', patchLeadFilters(f, { itemAttributed: false }).returnTo === f.returnTo && patchLeadFilters(f, { from: '2026-01-01' }).returnTo === f.returnTo);
  check('leadsUrl re-emits return_to and round-trips', parse(leadsUrl(patchLeadFilters(f, { quality: 'SERIOUS' }))).returnTo === '/listings?trend_weeks=8');
  check('EMPTY filters have no return_to', EMPTY_LEAD_FILTERS.returnTo === null && leadsUrl(EMPTY_LEAD_FILTERS) === '/leads');
  const page = strip(read('src', 'app', 'leads', 'page.tsx'));
  check('"Clear filters" keeps return_to', /router\.push\(leadsUrl\(\{ returnTo: filters\.returnTo \}\)/.test(page));
  check('"Clear filters" does not appear just because return_to exists', /leadsUrl\(\{ \.\.\.filters, expected: null, returnTo: null \}\) !== '\/leads'/.test(page));
}

console.log('\n[E — Inventory-style back arrow on /leads]');
{
  const back = read('src', 'components', 'BackLink.tsx');
  const inv = read('src', 'components', 'InventoryForm.tsx');
  const invLink = inv.slice(inv.indexOf('Back to Inventory') - 900, inv.indexOf('Back to Inventory') + 20);
  check('same arrow icon path as Inventory ("Back to Inventory")', back.includes('M19 12H5M12 19l-7-7 7-7') && invLink.includes('M19 12H5M12 19l-7-7 7-7'));
  check('same icon size (14px) and stroke width (2.5)', /width="14" height="14"/.test(back) && /strokeWidth="2.5"/.test(back) && /width="14" height="14"/.test(invLink) && /strokeWidth="2.5"/.test(invLink));
  check('same text style/spacing/hover as Inventory (gap-1.5, text-sm font-medium, slate-500 -> slate-900/white)', ['gap-1.5', 'text-sm', 'font-medium', 'text-slate-500', 'hover:text-slate-900', 'dark:text-slate-400', 'dark:hover:text-white'].every((c) => back.includes(c) && invLink.includes(c)));
  check('adds a visible keyboard focus ring', /focus-visible:ring-2/.test(back));
  check('renders a real link (keyboard: Tab/Enter) with aria-label', /<Link[\s\S]*href=\{href\}/.test(back) && /aria-label=\{label\}/.test(back));
  check('tap target grows via padding, icon stays small', /-my-2/.test(back) && /py-2/.test(back));
  const page = read('src', 'app', 'leads', 'page.tsx');
  const pageNc = strip(page);
  check('/leads uses BackLink with label "Back to Listings" and the validated return target', /<BackLink href=\{resolveBackHref\(filters\.returnTo\)\} label="Back to Listings" \/>/.test(pageNc));
  check('the old "← Listings" text link is gone', !/← Listings|←<\/span> Listings/.test(page) && !/href="\/listings"/.test(pageNc));
  const header = strip(read('src', 'components', 'CompactPageHeader.tsx'));
  check('CompactPageHeader renders the back control above the overline', /back != null/.test(header) && header.indexOf('back != null') < header.indexOf('page-overline'));
  check('back control is part of the header card (visible on mobile and desktop, no responsive hiding)', !/hidden/.test(header.slice(header.indexOf('back != null'), header.indexOf('page-overline'))));
}

console.log('\n[F — browser history is not replaced]');
{
  const files = [read('src', 'components', 'BackLink.tsx'), read('src', 'app', 'leads', 'page.tsx'), read('src', 'app', 'listings', 'page.tsx'), read('src', 'lib', 'listingsReturn.ts')].map(strip).join('\n');
  check('no custom history stack (no history.pushState/replaceState/back, no popstate handlers)', !/history\.(pushState|replaceState|back|go)|popstate/.test(files));
  check('no scroll-position persistence (no sessionStorage / manual scrollTo)', !/sessionStorage|localStorage|scrollTo\(|scrollRestoration/.test(files));
  check('back arrow is a plain client-side Link to the validated return path (deterministic even in a new tab)', /href=\{resolveBackHref\(filters\.returnTo\)\}/.test(files));
  const listings = strip(read('src', 'app', 'listings', 'page.tsx'));
  check('Listings derives return_to from the real current search params (not rebuilt from trend_weeks only)', /currentListingsReturnTo\(searchParams\.toString\(\)\)/.test(listings) && !/trend_weeks=\$\{/.test(listings.replace(/trendWeeksUrl[^\n]*/g, '')));
  check('return_to reaches all three drill-down sections', ['<MarketActivitySection', '<ChannelActivitySection', '<ItemActivitySection'].every((t) => new RegExp(`${t}[^>]*returnTo=\\{returnTo\\}`).test(listings)));
  check('every drill-down builder call in Listings passes returnTo', (listings.match(/(marketWeekLeadsUrl|marketWeekSeriousPlusUrl|channelAttributedLeadsUrl|channelSeriousPlusUrl|itemAttributedLeadsUrl|itemSeriousPlusUrl|itemOffersUrl)\((?:[^()]|\([^()]*\))*\)/g) ?? []).every((c) => /returnTo\)/.test(c)));
}

console.log('\n[G — navigation]');
{
  const layout = read('src', 'app', 'layout.tsx');
  const navs = layout.match(/<nav[\s\S]*?<\/nav>/g) ?? [];
  check('two nav blocks', navs.length === 2);
  navs.forEach((nav, i) => {
    const labels = (nav.match(/>([^<]+)<\/a>/g) ?? []).map((m) => m.slice(1, -4).trim());
    check(`primary nav ${i + 1}: Dashboard/Inventory/Listings/Operations only (no Leads, no Cash Flow)`, JSON.stringify(labels) === JSON.stringify(['Dashboard', 'Inventory', 'Listings', 'Operations']), labels);
  });
  check('/leads route exists but is not linked from layout', fs.existsSync(path.join(root, 'src', 'app', 'leads', 'page.tsx')) && !/\/leads/.test(layout));
  check('/cash-flow remains reachable via the Cash Balance card', /<Link\s+href="\/cash-flow"/.test(read('src', 'app', 'page.tsx')));
  check('Inventory item detail back link is untouched', /Back to Inventory/.test(read('src', 'components', 'InventoryForm.tsx')) && /href=\{backHref \?\? '\/inventory'\}/.test(read('src', 'components', 'InventoryForm.tsx')));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
