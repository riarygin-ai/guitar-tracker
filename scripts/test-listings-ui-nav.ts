/**
 * test-listings-ui-nav.ts
 *
 * Validation for the /listings UI/UX redesign and the navigation cleanup
 * (Cash Flow removed from primary nav; Dashboard Cash Balance card is the
 * drill-down to /cash-flow). Pure source-structure + pure-helper checks —
 * this project has no component-rendering framework (see the other
 * scripts/test-*.ts), and nothing here touches a database.
 *
 * Usage:
 *   npx tsx scripts/test-listings-ui-nav.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { LISTING_HELP } from '../src/lib/listingHelpText';
import { parseTrendWeeksParam, trendWeeksUrl, TREND_WEEKS_OPTIONS } from '../src/lib/listingDemandDashboardHelpers';

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

const root = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const stripComments = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const page = read('src', 'app', 'listings', 'page.tsx');
const pageNoComments = stripComments(page);
const layout = read('src', 'app', 'layout.tsx');
const home = read('src', 'app', 'page.tsx');
const infoTip = read('src', 'components', 'InfoTip.tsx');

function fn(source: string, name: string): string {
  const m = source.match(new RegExp(`function ${name}[\\s\\S]*?\\n}\\n`));
  return m ? m[0] : '';
}

console.log('\n[A — Trend Window: moved into Market Activity header, behavior unchanged]');
{
  check('exactly one <TrendWindowControl usage', (page.match(/<TrendWindowControl/g) ?? []).length === 1);
  const market = fn(page, 'MarketActivitySection');
  check('the single TrendWindowControl is rendered by MarketActivitySection', /<TrendWindowControl/.test(market));
  check('ListingsPage itself no longer renders a standalone TrendWindowControl panel', !/<TrendWindowControl/.test(fn(page, 'ListingsPage')));
  check('TrendWindowControl has no standalone bordered card wrapper', !/rounded-3xl/.test(fn(page, 'TrendWindowControl')));
  check('control is a labeled group', /role="group" aria-label="Trend Window"/.test(page));
  check('buttons expose selected state via aria-pressed', /aria-pressed=\{trendWeeks === w\}/.test(page));
  check('options rendered from TREND_WEEKS_OPTIONS exactly once', (page.match(/TREND_WEEKS_OPTIONS\.map/g) ?? []).length === 1);
  check('supports 4W / 8W / 12W', JSON.stringify([...TREND_WEEKS_OPTIONS]) === JSON.stringify([4, 8, 12]));
  check('URL-driven: router.replace(trendWeeksUrl(...))', /router\.replace\(trendWeeksUrl\(/.test(page));
  check('trendWeeks derived from searchParams (no synced local state)', /parseTrendWeeksParam\(searchParams\.get\('trend_weeks'\)\)/.test(page) && !/useState<TrendWeeks>/.test(page));
  check('default 4 omitted from URL', trendWeeksUrl(4) === '/listings');
  check('8W / 12W persisted in URL', trendWeeksUrl(8) === '/listings?trend_weeks=8' && trendWeeksUrl(12) === '/listings?trend_weeks=12');
  check('invalid param falls back to 4', parseTrendWeeksParam('7') === 4);
}

console.log('\n[B — Overview: exactly four KPIs, snapshot-only]');
{
  const overview = fn(page, 'OverviewSection');
  check('OverviewSection found', overview.length > 0);
  check('exactly 4 StatTile', (overview.match(/<StatTile/g) ?? []).length === 4);
  for (const l of ['Listed Items', 'Listed Cost Basis', 'Estimated Listed Value', 'Estimated Equity']) check(`KPI "${l}"`, overview.includes(`label="${l}"`));
  check('every KPI has an icon and tone', (overview.match(/icon="/g) ?? []).length === 4 && (overview.match(/tone=/g) ?? []).length >= 4);
  check('Overview never reads demandEvidence/trendWeeks', !/demandEvidence|trendWeeks/.test(overview));
}

console.log('\n[C — ⓘ help definitions]');
{
  const expected: Record<string, string> = {
    leadsPer100ChannelDays: 'Attributed leads per 100 days of listing exposure across channels. This normalizes lead activity so periods with different listing exposure can be compared.',
    channelListingDays: 'One item listed on one channel for one calendar day equals one Channel Listing Day. Example: 10 items listed for 7 days equals 70 Channel Listing Days.',
    avgChannelExposure: 'Average number of active item-channel listings per day during the week.',
    seriousPlus: 'Leads that reached Serious or High Intent. Lead quality reflects the highest level the lead has reached, not necessarily its initial state.',
    realizedDeals: 'Completed Sell/Trade activity during the week. Deals are shown alongside leads but are not treated as lead conversions.',
  };
  for (const [k, text] of Object.entries(expected)) {
    check(`help text for ${k} matches spec`, (LISTING_HELP as Record<string, { text: string }>)[k]?.text === text);
  }
  check('page renders help via MetricLabel/InfoTip', /<InfoTip/.test(page) && /LISTING_HELP\[help\]/.test(page));
  for (const k of Object.keys(expected)) check(`page wires help="${k}"`, page.includes(`help="${k}"`));
  check('InfoTip: focusable native button', /<button[\s\S]*type="button"/.test(infoTip));
  check('InfoTip: aria-label', /aria-label=\{`About \$\{label\}`\}/.test(infoTip));
  check('InfoTip: aria-expanded + tooltip role', /aria-expanded=\{open\}/.test(infoTip) && /role="tooltip"/.test(infoTip));
  check('InfoTip: hover + focus + click(tap) handlers (not hover-only)', /onMouseEnter/.test(infoTip) && /onFocus/.test(infoTip) && /onClick/.test(infoTip));
  check('InfoTip: Escape and outside-tap dismiss', /Escape/.test(infoTip) && /pointerdown/.test(infoTip));
  check('InfoTip: visible focus ring', /focus-visible:ring-2/.test(infoTip));
}

console.log('\n[D — Market Activity: metrics preserved, desktop table + mobile cards]');
{
  const market = fn(page, 'MarketActivitySection');
  for (const f of ['leadsStarted', 'seriousPlusLeads', 'realizedDeals', 'avgListedItems', 'avgChannelExposure', 'leadsPer100ChannelDays']) check(`renders row.${f}`, market.includes(`row.${f}`));
  check('Leads / 100 Channel-Days column present', /help="leadsPer100ChannelDays"/.test(market));
  check('Avg Listed label present', /text="Avg Listed"/.test(market));
  check('desktop table hidden below md', /hidden overflow-x-auto[^"]*md:block/.test(market));
  check('mobile weekly cards hidden at md+', /md:hidden/.test(market) && /data-week-card/.test(market));
  check('week rows carry data-week-row', /data-week-row/.test(market));
  check('side-by-side / not a funnel wording retained', /side-by-side, not as a funnel/.test(market));
}

console.log('\n[E — Channel Activity: metrics preserved, dynamic, desktop table + mobile cards + trend]');
{
  const ch = fn(page, 'ChannelActivitySection');
  for (const f of ['channelListingDays', 'attributedLeads', 'seriousPlusLeads', 'realizedDeals', 'leadsPer100ChannelDays', 'weeklyTrend']) check(`renders row.${f}`, ch.includes(`row.${f}`));
  check('channels come from buildChannelActivityRows (dynamic)', /buildChannelActivityRows\(evidence\)/.test(ch) && /rows\.map/.test(ch));
  check('no hardcoded channel names in page', !/['"`>](Reverb|Marketplace|Kijiji)['"`<]/.test(pageNoComments));
  check('desktop table has Channel + Trend columns', />Channel<\/th>/.test(ch) && /W Trend<\/th>/.test(ch));
  check('mobile channel cards exist (data-channel-card, md:hidden)', /data-channel-card/.test(ch) && /md:hidden/.test(ch));
  check('channel rows carry data-channel-row', /data-channel-row/.test(ch));
  check('trend rendered as an arrow sequence', /join\(' → '\)/.test(page));
  check('trend uses inline Sparkline component (no new dependency)', /<Sparkline/.test(page) && !/from 'recharts'|from 'chart\.js'|from 'd3/.test(page));
  const pkg = JSON.parse(read('package.json'));
  check('no charting dependency added to package.json', !Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((d) => /chart|d3|recharts|visx/i.test(d)));
  check('mobile channel card has no long explanatory paragraph', !/Attributed Leads and Realized Deals are shown side-by-side/.test(page));
}

console.log('\n[F — no interpretive / good-bad language, no red/green channel judgments]');
{
  const forbidden = [/is better/i, /is bad/i, /is worse/i, /strong week/i, /weak/i, /demand (?:is )?(?:rising|increasing|decreasing|falling)/i, /caused/i, /conversion rate/i, /underperform/i, /best channel/i, /worst channel/i];
  for (const re of forbidden) check(`page copy has nothing matching ${re}`, !re.test(pageNoComments));
  const ch = fn(page, 'ChannelActivitySection');
  check('Channel Activity never uses rose/red/emerald/green classes directly', !/rose-|red-|green-/.test(ch.replace(/TONE\.\w+/g, '')));
}

console.log('\n[G — no Leads page / nav, no backend changes]');
{
  check('no /leads link anywhere on the listings page', !/['"`]\/leads/.test(page));
  check('no /leads link in layout nav', !/href="\/leads/.test(layout));
  check('/leads exists as a contextual (non-nav) route — reached only via drill-downs', fs.existsSync(path.join(root, 'src', 'app', 'leads', 'page.tsx')) && !/\/leads/.test(layout));
  check('DrillValue links only come from the drill-down URL builders (no hand-written hrefs, no dead links)', (page.match(/<DrillValue[^>]*href=\{[^}]*\}/g) ?? []).every((m) => /(marketWeek(Leads|SeriousPlus)Url|channel(AttributedLeads|SeriousPlus)Url|item(AttributedLeads|SeriousPlus|Offers)Url)\(/.test(m)) && /\?\? undefined/.test(page));
}

console.log('\n[H — primary navigation]');
{
  const navs = layout.match(/<nav[\s\S]*?<\/nav>/g) ?? [];
  check('layout has two nav blocks (desktop + mobile)', navs.length === 2, navs.length);
  navs.forEach((nav, i) => {
    const labels = (nav.match(/>([^<]+)<\/a>/g) ?? []).map((m) => m.slice(1, -4).trim());
    check(`nav ${i + 1} is exactly Dashboard/Inventory/Listings/Operations`, JSON.stringify(labels) === JSON.stringify(['Dashboard', 'Inventory', 'Listings', 'Operations']), labels);
    check(`nav ${i + 1} has no Cash Flow link`, !/cash-flow|Cash Flow/.test(nav));
    check(`nav ${i + 1} has no Leads item`, !/Leads/i.test(nav));
  });
  check('layout no longer links to /cash-flow at all', !/\/cash-flow/.test(layout));
  check('/cash-flow route still exists', fs.existsSync(path.join(root, 'src', 'app', 'cash-flow', 'page.tsx')));
}

console.log('\n[I — Dashboard Cash Balance card → /cash-flow]');
{
  const start = home.indexOf('{/* Cash Balance');
  const end = home.indexOf('</Link>', start);
  const card = start >= 0 && end > start ? home.slice(start, end) : '';
  check('Cash Balance card block found', card.length > 0);
  check('card is a Link to /cash-flow (entire card is the target)', /<Link\s+href="\/cash-flow"/.test(card));
  check('descriptive aria-label', /aria-label=\{`Cash Balance/.test(card));
  check('visible keyboard focus state', /focus-visible:ring-2/.test(card));
  check('hover state', /hover:border-sky-300/.test(card));
  check('chevron affordance', /<polyline points="9 18 15 12 9 6"/.test(card));
  check('Cash Balance value unchanged: formatMoney(currentCash)', card.includes('{formatMoney(currentCash)}'));
  check('currentCash calculation unchanged', /const currentCash = latestCashFlow \? Number\(latestCashFlow\.closing_balance \?\? 0\) : 0/.test(home));
  check('label/caption unchanged', card.includes('>Cash Balance</p>') && card.includes('available business cash'));
  check('next/link imported in dashboard page', /import Link from 'next\/link'/.test(home));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
