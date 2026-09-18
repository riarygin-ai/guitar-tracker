/**
 * test-leads-ui.ts
 *
 * No-DB validation for the read-only /leads screen: offer formatter,
 * filters, URL (single source of truth), main-list/mobile/detail
 * structure, the /listings drill-down wiring, and navigation.
 * (DB-backed reconciliation lives in test-lead-drilldown.ts.)
 *
 * Usage:  npx tsx scripts/test-leads-ui.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  fmtCad, fmtLeadDate, fmtMessages, formatOfferSummary, describeCashComponent, leadChannelLabel, leadItemName,
} from '../src/lib/leads/leadFormat';
import {
  EMPTY_LEAD_FILTERS, NO_CHANNEL, applyLeadFilters, activeQuickFilter, attributionRequest, isValidDateParam, leadsUrl,
  parseLeadFilters, patchLeadFilters, quickFilterPatch, sortLeadsRecentFirst,
} from '../src/lib/leads/leadFilters';
import { channelAttributedLeadsUrl, channelSeriousPlusUrl, marketWeekLeadsUrl, marketWeekSeriousPlusUrl } from '../src/lib/leads/leadDrilldownUrls';
import { LEAD_HELP } from '../src/lib/leads/leadHelpText';
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

let nextId = 1;
function mk(over: Partial<LeadRow> = {}): LeadRow {
  const id = nextId++;
  return {
    id, lead_id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, inventory_item_id: 100 + id, item_name: `Item ${id}`,
    first_contact_at: '2026-09-10', last_contact_at: '2026-09-12', source_channel: 'Marketplace', deal_channel_id: 1, channel_name: 'Marketplace',
    buyer_message_count: 5, our_message_count: 2, lead_quality: 'LOW', offer_type: 'NONE', initial_cash_offer: null, best_cash_offer: null,
    trade_item: null, cash_component: null, trade_est_value: null, status: 'OPEN', outcome_reason: null, notes: null,
    source_updated_at: '2026-09-12T10:00:00Z', last_imported_at: null, ...over,
  };
}
const params = (qs: string) => { const sp = new URLSearchParams(qs); return (k: string) => sp.get(k); };

console.log('\n[A — offer formatter]');
{
  check('NONE -> "No offer"', formatOfferSummary(mk({ offer_type: 'NONE' })) === 'No offer');
  check('CASH uses best_cash_offer', formatOfferSummary(mk({ offer_type: 'CASH', best_cash_offer: 1650, initial_cash_offer: 1200 })) === '$1,650 cash');
  check('CASH falls back to initial_cash_offer', formatOfferSummary(mk({ offer_type: 'CASH', best_cash_offer: null, initial_cash_offer: 1200 })) === '$1,200 cash');
  check('CASH with no amounts invents nothing', formatOfferSummary(mk({ offer_type: 'CASH' })) === 'Cash offer (amount not recorded)');
  check('CASH keeps cents when present', formatOfferSummary(mk({ offer_type: 'CASH', best_cash_offer: 1650.5 })) === '$1,650.50 cash');
  check('TRADE with cash_component 0', formatOfferSummary(mk({ offer_type: 'TRADE', trade_item: 'Bogner Ecstasy 3534', cash_component: 0 })) === 'Trade: Bogner Ecstasy 3534');
  check('TRADE bundle text shown as recorded', formatOfferSummary(mk({ offer_type: 'TRADE', trade_item: 'Strat + Twin Reverb bundle', cash_component: 0 })) === 'Trade: Strat + Twin Reverb bundle');
  check('TRADE without trade_item invents nothing', formatOfferSummary(mk({ offer_type: 'TRADE', cash_component: 0 })) === 'Trade (item not recorded)');
  check('MIXED positive cash -> to us', formatOfferSummary(mk({ offer_type: 'MIXED', trade_item: 'Rickenbacker 330', cash_component: 500 })) === 'Rickenbacker 330 + $500 to us');
  check('MIXED negative cash -> from us', formatOfferSummary(mk({ offer_type: 'MIXED', trade_item: 'Rickenbacker 330', cash_component: -500 })) === 'Rickenbacker 330 + $500 from us');
  check('MIXED NULL cash -> amount unknown (never $0)', formatOfferSummary(mk({ offer_type: 'MIXED', trade_item: 'Rickenbacker 330', cash_component: null })) === 'Rickenbacker 330 + cash amount unknown');
  check('trade_est_value never appears in the summary', !/\b9999\b/.test(formatOfferSummary(mk({ offer_type: 'TRADE', trade_item: 'X', cash_component: 0, trade_est_value: 9999 }))));
  check('money uses CAD-style $ with thousands separator', fmtCad(12345) === '$12,345' && fmtCad(null) === '—');
  check('cash-component meanings (QA)', describeCashComponent(mk({ offer_type: 'TRADE', cash_component: 0 })).includes('straight trade')
    && describeCashComponent(mk({ offer_type: 'MIXED', cash_component: 500 })).includes('cash to us')
    && describeCashComponent(mk({ offer_type: 'MIXED', cash_component: -500 })).includes('cash from us')
    && describeCashComponent(mk({ offer_type: 'MIXED', cash_component: null })).includes('amount unknown'));
  check('messages "5 / 2", missing is an em-dash not 0', fmtMessages(mk()) === '5 / 2' && fmtMessages(mk({ buyer_message_count: null, our_message_count: 0 })) === '— / 0');
  check('channel label: canonical > source_channel > Unknown', leadChannelLabel({ channel_name: 'Reverb', source_channel: 'x' }) === 'Reverb' && leadChannelLabel({ channel_name: null, source_channel: 'Other' }) === 'Other' && leadChannelLabel({ channel_name: null, source_channel: null }) === 'Unknown');
  check('date labels are timezone-free', fmtLeadDate('2026-09-18', 2026) === 'Sep 18' && fmtLeadDate('2025-12-01', 2026) === 'Dec 1, 2025' && fmtLeadDate(null) === '—');
  check('item name falls back to Item #id', leadItemName(2015, 'Gibson', "'63 ES-335", 1) === "2015 Gibson '63 ES-335" && leadItemName(null, null, null, 7) === 'Item #7');
}

console.log('\n[B — filters]');
{
  const rows = [
    mk({ item_name: '2015 Gibson ES-335', deal_channel_id: 1, channel_name: 'Marketplace', lead_quality: 'SERIOUS', offer_type: 'TRADE', trade_item: 'Fender Stratocaster', cash_component: 0, status: 'OPEN', first_contact_at: '2026-09-11', notes: 'wants to swap' }),
    mk({ item_name: 'Marshall JCM800', deal_channel_id: 2, channel_name: 'Kijiji', lead_quality: 'HIGH_INTENT', offer_type: 'CASH', best_cash_offer: 900, status: 'COMPLETED', first_contact_at: '2026-09-15' }),
    mk({ item_name: 'Boss DS-1', deal_channel_id: null, channel_name: null, source_channel: 'Other', lead_quality: 'LOW', offer_type: 'NONE', status: 'GHOSTED', first_contact_at: '2026-08-01' }),
    mk({ item_name: 'Fender Twin', deal_channel_id: 3, channel_name: 'Reverb', lead_quality: 'ENGAGED', offer_type: 'MIXED', trade_item: 'Vox AC30', cash_component: -200, status: 'AGREED', first_contact_at: null }),
  ];
  const f = (patch: Partial<typeof EMPTY_LEAD_FILTERS>) => applyLeadFilters(rows, { ...EMPTY_LEAD_FILTERS, ...patch }, null).map((r) => r.item_name);
  check('no filters -> everything (incl. undated)', f({}).length === 4);
  check('channel', JSON.stringify(f({ channel: 2 })) === JSON.stringify(['Marshall JCM800']));
  check('channel "none" -> no normalized channel', JSON.stringify(f({ channel: NO_CHANNEL })) === JSON.stringify(['Boss DS-1']));
  check('quality', JSON.stringify(f({ quality: 'ENGAGED' })) === JSON.stringify(['Fender Twin']));
  check('Serious+ = SERIOUS + HIGH_INTENT', JSON.stringify(f({ seriousPlus: true })) === JSON.stringify(['2015 Gibson ES-335', 'Marshall JCM800']));
  check('offer type', JSON.stringify(f({ offerType: 'MIXED' })) === JSON.stringify(['Fender Twin']));
  check('Offers quick = offer_type != NONE', f({ offers: true }).length === 3 && !f({ offers: true }).includes('Boss DS-1'));
  check('status', JSON.stringify(f({ status: 'COMPLETED' })) === JSON.stringify(['Marshall JCM800']));
  check('date range inclusive on both ends, undated excluded', JSON.stringify(f({ from: '2026-09-11', to: '2026-09-15' })) === JSON.stringify(['2015 Gibson ES-335', 'Marshall JCM800']));
  check('search: item name (case-insensitive)', JSON.stringify(f({ search: 'marshall' })) === JSON.stringify(['Marshall JCM800']));
  check('search: trade_item', JSON.stringify(f({ search: 'stratocaster' })) === JSON.stringify(['2015 Gibson ES-335']));
  check('search: notes', JSON.stringify(f({ search: 'swap' })) === JSON.stringify(['2015 Gibson ES-335']));
  check('search: multiple tokens AND', f({ search: 'gibson swap' }).length === 1 && f({ search: 'gibson marshall' }).length === 0);
  check('item_id filter', f({ itemId: rows[1].inventory_item_id }).length === 1);
  check('attributed without a cohort set -> empty (never silently un-attributed)', applyLeadFilters(rows, { ...EMPTY_LEAD_FILTERS, attributed: true }, null).length === 0);
  check('attributed with cohort set restricts to it', applyLeadFilters(rows, { ...EMPTY_LEAD_FILTERS, attributed: true }, new Set([rows[0].id])).length === 1);
  const sorted = sortLeadsRecentFirst([mk({ id: 1, first_contact_at: '2026-09-01', last_contact_at: '2026-09-02' }), mk({ id: 2, first_contact_at: null }), mk({ id: 3, first_contact_at: '2026-09-01', last_contact_at: '2026-09-05' }), mk({ id: 4, first_contact_at: '2026-09-01', last_contact_at: '2026-09-05' }), mk({ id: 5, first_contact_at: '2026-09-09' })]);
  check('sort: first_contact DESC, then last_contact DESC, then id DESC, undated last', sorted.map((r) => r.id).join(',') === '5,4,3,1,2', sorted.map((r) => r.id));
}

console.log('\n[C — URL is the source of truth; invalid values fail safely]');
{
  const full = parseLeadFilters(params('search=gibson&channel_id=2&quality=SERIOUS&serious_plus=1&offer_type=TRADE&status=OPEN&from=2026-09-01&to=2026-09-30&item_id=42&offers=1'));
  check('every documented param parses', full.search === 'gibson' && full.channel === 2 && full.quality === 'SERIOUS' && full.seriousPlus && full.offerType === 'TRADE' && full.status === 'OPEN' && full.from === '2026-09-01' && full.to === '2026-09-30' && full.itemId === 42 && full.offers);
  check('no params -> no filters', JSON.stringify(parseLeadFilters(params(''))) === JSON.stringify(EMPTY_LEAD_FILTERS));
  const bad = parseLeadFilters(params('channel_id=abc&quality=BOGUS&offer_type=x&status=nope&from=2026-13-40&to=yesterday&item_id=-3&serious_plus=yes&expected=abc'));
  check('invalid values are ignored, not thrown', JSON.stringify(bad) === JSON.stringify(EMPTY_LEAD_FILTERS), bad);
  check('impossible calendar date rejected', !isValidDateParam('2026-02-30') && isValidDateParam('2026-02-28') && !isValidDateParam('2026-2-3'));
  check('attributed needs channel + both dates, else ignored', !parseLeadFilters(params('attributed=1&channel_id=1')).attributed && !parseLeadFilters(params('attributed=1&from=2026-09-01&to=2026-09-07')).attributed && parseLeadFilters(params('attributed=1&channel_id=1&from=2026-09-01&to=2026-09-07')).attributed);
  check('search is trimmed and length-capped', parseLeadFilters(params(`search=${'a'.repeat(500)}`)).search.length === 200);
  const f = parseLeadFilters(params('channel_id=2&status=OPEN&search=a b'));
  check('leadsUrl round-trips through parseLeadFilters', JSON.stringify(parseLeadFilters(params(leadsUrl(f).split('?')[1]))) === JSON.stringify(f));
  check('leadsUrl omits defaults and is a bare /leads when empty', leadsUrl({}) === '/leads' && leadsUrl(EMPTY_LEAD_FILTERS) === '/leads');
  check('leadsUrl output is a browser-safe query (URLSearchParams-encoded)', leadsUrl({ search: 'a&b=c' }) === '/leads?search=a%26b%3Dc');
  const attributed = parseLeadFilters(params('channel_id=1&from=2026-09-11&to=2026-09-17&attributed=1'));
  check('editing channel or dates drops the attributed cohort', !patchLeadFilters(attributed, { channel: 2 }).attributed && !patchLeadFilters(attributed, { from: '2026-09-01' }).attributed && patchLeadFilters(attributed, { status: 'OPEN' }).attributed);
  check('any patch clears the diagnostic expected count', patchLeadFilters({ ...attributed, expected: 16 }, { status: 'OPEN' }).expected === null);
  check('attributionRequest only for a complete cohort', attributionRequest(attributed)?.channelId === 1 && attributionRequest(EMPTY_LEAD_FILTERS) === null);
  check('quick filters map to real params', activeQuickFilter(EMPTY_LEAD_FILTERS) === 'all' && activeQuickFilter(patchLeadFilters(EMPTY_LEAD_FILTERS, quickFilterPatch('open'))) === 'open'
    && activeQuickFilter(patchLeadFilters(EMPTY_LEAD_FILTERS, quickFilterPatch('serious'))) === 'serious' && activeQuickFilter(patchLeadFilters(EMPTY_LEAD_FILTERS, quickFilterPatch('offers'))) === 'offers'
    && activeQuickFilter(patchLeadFilters(EMPTY_LEAD_FILTERS, quickFilterPatch('completed'))) === 'completed');
  check('exactly five quick filters', (read('src', 'lib', 'leads', 'leadFilters.ts').match(/\{ key: '/g) ?? []).length === 5);

  const page = strip(read('src', 'app', 'leads', 'page.tsx'));
  check('page derives filters from searchParams every render', /parseLeadFilters\(\(k\) => searchParams\.get\(k\)\)/.test(page));
  check('page has NO filter useState (no synced duplicate)', !/useState<LeadFilters/.test(page) && !/const \[(filters|search|channel|quality|status|offerType|from|to)\b/.test(page));
  check('changes are written to the URL via router.push/replace', /router\[mode\]\(leadsUrl\(/.test(page) && /router\.push\('\/leads'/.test(page));
}

console.log('\n[D — main list, mobile cards, detail]');
{
  const src = read('src', 'app', 'leads', 'page.tsx');
  const page = strip(src);
  const table = strip(src.slice(src.indexOf('{/* Desktop table */}'), src.indexOf('{/* Mobile cards */}')));
  const cards = strip(src.slice(src.indexOf('{/* Mobile cards */}')));
  const headers = (table.match(/<th [^>]*>([\s\S]*?)<\/th>/g) ?? []).map((h) => h.replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim());
  check('desktop columns are exactly the important eight', JSON.stringify(headers) === JSON.stringify(['Date', 'Item', 'Channel', 'Quality', 'Offer', 'Status', 'Messages', 'Last Contact']), headers);
  check('main list never renders lead_id / UUIDs', !/lead_id|\.lead\.id/.test(table) && !/lead_id/.test(cards));
  check('main list omits detail-only fields', !/initial_cash_offer|best_cash_offer|trade_est_value|cash_component|outcome_reason|source_updated_at|last_imported_at|\.notes/.test(table + cards));
  check('offer via formatOfferSummary; messages via fmtMessages; channel via leadChannelLabel', /formatOfferSummary\(lead\)/.test(table) && /fmtMessages\(lead\)/.test(table) && /leadChannelLabel\(lead\)/.test(table));
  check('channels come from the payload (no hardcoded names)', !/['"`>](Reverb|Marketplace|Kijiji)['"`<]/.test(page) && /payload\?\.channels/.test(page));
  check('Messages header has the ⓘ help', /LEAD_HELP\.messages/.test(table));
  check('mobile cards exist (md:hidden) and desktop table is hidden on mobile', /md:hidden/.test(cards) && /hidden overflow-x-auto[^"]*md:block/.test(table));
  check('mobile card: item name dominant, badges, offer, messages, last contact', /text-base font-semibold/.test(cards) && /QualityBadge/.test(cards) && /StatusBadge/.test(cards) && /formatOfferSummary/.test(cards) && /Last contact:/.test(cards));
  check('filter controls are full-width/min-w-0 and the grid wraps', /min-w-0/.test(page) && /grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6/.test(page));
  check('page size 50 with a Show more control', /PAGE_SIZE = 50/.test(page) && /Show more/.test(page));
  check('concise count ("N leads")', /\{filtered\.length\} \{filtered\.length === 1 \? 'lead' : 'leads'\}/.test(page) && !/Showing \d/.test(page));
  check('calm empty state copy', page.includes('No leads match these filters.'));
  check('title "Leads" and concise subtitle; not called Lead Explorer', page.includes('overline="Leads"') && page.includes('Buyer conversations and recorded offers from your listing activity.') && !/Lead Explorer/i.test(page));
  check('reconciliation diagnostic logs on mismatch', /drill-down count mismatch/.test(page));
  check('failures are local (error banner on /leads only)', /role="alert"/.test(page));

  const detail = strip(read('src', 'components', 'leads', 'LeadDetailPanel.tsx'));
  for (const label of ['First contact', 'Last contact', 'Channel', 'Quality', 'Status', 'Outcome reason', 'Buyer messages', 'Our messages', 'Offer type', 'Initial cash offer', 'Best cash offer', 'Trade item', 'Cash component', 'Trade est. value', 'Lead ID', 'Source channel', 'Source updated', 'Last imported']) {
    check(`detail shows "${label}"`, detail.includes(`label="${label}`));
  }
  check('detail shows notes safely (React-escaped, wrapped)', /whitespace-pre-wrap break-words/.test(detail) && !/dangerouslySetInnerHTML/.test(detail));
  check('source_updated_at is visible', /lead\.source_updated_at/.test(detail) && /data-source-updated-at/.test(detail));
  check('cash sign semantics visible via describeCashComponent + ⓘ', /describeCashComponent\(lead\)/.test(detail) && /help="cashComponent"/.test(detail));
  check('Trade est. value has ⓘ help', /help="tradeEstValue"/.test(detail));
  check('Open Item action links to the existing item route', /href=\{`\/inventory\/\$\{lead\.inventory_item_id\}`\}/.test(detail) && /Open Item/.test(detail));
  check('source/QA section is collapsible', /<details/.test(detail) && /<summary/.test(detail));
  check('dialog is accessible (role, aria-modal, Escape, focus return)', /role="dialog"/.test(detail) && /aria-modal="true"/.test(detail) && /Escape/.test(detail) && /previouslyFocused/.test(detail));
  check('mobile sheet + desktop drawer classes', /rounded-t-3xl/.test(detail) && /md:w-\[30rem\]/.test(detail));
  check('no edit controls (no inputs/forms/mutations) in detail or page', !/<form|<textarea|\.update\(|\.insert\(|\.upsert\(|method: 'P/.test(detail + page));
  check('help definitions exist (Serious+, Messages, Trade Estimated Value, Cash Component)',
    LEAD_HELP.seriousPlus.text === 'Leads that reached Serious or High Intent. Quality reflects the highest level the lead has reached.'
    && LEAD_HELP.messages.text === 'Buyer messages / our messages. Counts are the current lifetime totals stored for this lead.'
    && LEAD_HELP.tradeEstValue.text.startsWith('Working estimated value recorded for the offered trade item.')
    && LEAD_HELP.cashComponent.text === 'Positive means cash to us. Negative means cash from us.');
  const badges = read('src', 'components', 'leads', 'LeadBadges.tsx');
  check('badges always render a text label', /QUALITY_LABEL\[quality\]/.test(badges) && /STATUS_LABEL\[status\]/.test(badges));
  check('no alarming red in badges', !/red-|rose-/.test(badges));
}

console.log('\n[E — /listings drill-down wiring & URL builders]');
{
  const period = { startDate: '2026-09-11', endDate: '2026-09-17' };
  check('market week Leads -> exact from/to (+expected)', marketWeekLeadsUrl({ startDate: '2026-09-11', endDate: '2026-09-17', leadsStarted: 9, seriousPlusLeads: 4 }) === '/leads?from=2026-09-11&to=2026-09-17&expected=9');
  check('market week Serious+ adds serious_plus', marketWeekSeriousPlusUrl({ startDate: '2026-09-11', endDate: '2026-09-17', leadsStarted: 9, seriousPlusLeads: 4 }) === '/leads?from=2026-09-11&to=2026-09-17&serious_plus=1&expected=4');
  check('channel Attributed Leads -> channel + exact period + attributed cohort', channelAttributedLeadsUrl(period, { dealChannelId: 1, attributedLeads: 16, seriousPlusLeads: 9 }) === '/leads?channel_id=1&from=2026-09-11&to=2026-09-17&attributed=1&expected=16');
  check('channel Serious+ adds serious_plus on the same cohort', channelSeriousPlusUrl(period, { dealChannelId: 1, attributedLeads: 16, seriousPlusLeads: 9 }) === '/leads?channel_id=1&from=2026-09-11&to=2026-09-17&attributed=1&serious_plus=1&expected=9');
  check('zero counts produce no link', marketWeekLeadsUrl({ startDate: 'a', endDate: 'b', leadsStarted: 0, seriousPlusLeads: 0 }) === null && channelAttributedLeadsUrl(period, { dealChannelId: 1, attributedLeads: 0, seriousPlusLeads: 0 }) === null);

  const listings = strip(read('src', 'app', 'listings', 'page.tsx'));
  check('channel period comes from evidence.period (no independent date math)', /evidence\.period\.start_date/.test(listings) && /evidence\.period\.end_date/.test(listings) && !/new Date|Date\.UTC|setDate/.test(listings));
  check('Market Activity Leads + Serious+ are drill-down links', /marketWeekLeadsUrl\(row\)/.test(listings) && /marketWeekSeriousPlusUrl\(row\)/.test(listings));
  check('Channel Attributed Leads + Serious+ are drill-down links', /channelAttributedLeadsUrl\(period, row\)/.test(listings) && /channelSeriousPlusUrl\(period, row\)/.test(listings));
  const market = listings.slice(listings.indexOf('function MarketActivitySection'), listings.indexOf('function TrendSequence'));
  const dealsCell = market.match(/\{row\.realizedDeals\}/g) ?? [];
  check('Realized Deals / Avg Listed / Avg Exposure / Leads-per-100 are NOT links', dealsCell.length > 0 && !/href=\{[^}]*\}[^<]*>\{row\.(realizedDeals|avgListedItems|avgChannelExposure)/.test(market) && !/DrillValue[^>]*>\{fmtRate/.test(market));
  check('no lead-count link uses a hardcoded /leads path (builders only)', !/['"`]\/leads/.test(listings));
}

console.log('\n[F — navigation]');
{
  const layout = read('src', 'app', 'layout.tsx');
  const navs = layout.match(/<nav[\s\S]*?<\/nav>/g) ?? [];
  check('two nav blocks', navs.length === 2);
  navs.forEach((nav, i) => {
    const labels = (nav.match(/>([^<]+)<\/a>/g) ?? []).map((m) => m.slice(1, -4).trim());
    check(`nav ${i + 1} is exactly Dashboard/Inventory/Listings/Operations`, JSON.stringify(labels) === JSON.stringify(['Dashboard', 'Inventory', 'Listings', 'Operations']), labels);
    check(`nav ${i + 1} has no Leads and no Cash Flow`, !/Leads|leads|Cash Flow|cash-flow/.test(nav));
  });
  check('no /leads or Cash Flow link anywhere in layout', !/\/leads|cash-flow/.test(layout));
  check('/leads route exists', fs.existsSync(path.join(root, 'src', 'app', 'leads', 'page.tsx')));
  check('/api/leads route exists and is read-only (GET only)', /export async function GET/.test(read('src', 'app', 'api', 'leads', 'route.ts')) && !/export async function (POST|PUT|PATCH|DELETE)/.test(read('src', 'app', 'api', 'leads', 'route.ts')));
  check('/cash-flow route still exists', fs.existsSync(path.join(root, 'src', 'app', 'cash-flow', 'page.tsx')));
  const home = read('src', 'app', 'page.tsx');
  check('Cash Balance card still links to /cash-flow', /<Link\s+href="\/cash-flow"/.test(home) && home.includes('{formatMoney(currentCash)}'));
  const ui = fs.readdirSync(path.join(root, 'src', 'components')).filter((f) => /nav/i.test(f) && f !== 'AdminNavButton.tsx');
  check('no other nav component links to /leads', ui.every((f) => !/\/leads/.test(read('src', 'components', f))));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
