/**
 * test-leads-table-history.ts
 *
 * No-DB checks for the /leads working view: column sorting (semantic
 * orders, null handling, the 3-state header cycle), exact-name and item
 * filters, Stage / Negotiating+ replacing legacy Quality, URL state
 * round-trips, row/name/item click wiring, and the drawer's history
 * section (event timeline vs. legacy-notes fallback) rendered for real
 * with react-dom/server. (DB-backed loader checks: test-lead-direct-writes W12b.)
 *
 * Usage:  npx tsx scripts/test-leads-table-history.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as React from 'react';
import {
  EMPTY_LEAD_FILTERS, activeQuickFilter, applyLeadFilters, leadsUrl, nextSort, parseLeadFilters, patchLeadFilters, quickFilterPatch,
  sortLeads, LEAD_SORT_KEYS, type LeadFilters,
} from '../src/lib/leads/leadFilters';
import { buildLeadHistory, isHiddenEvent, type LeadEventRecord } from '../src/lib/leads/leadEventHistory';
import { LEAD_SNAPSHOT_DEFAULTS, type LeadRow } from '../src/lib/leads/leadTypes';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}
// The repo compiles JSX as "preserve" (Next does the transform); tsx falls back to the classic
// runtime, so the component module needs a global React before it is (dynamically) imported.
(globalThis as { React?: typeof React }).React = React;
// No @types/react-dom in this repo: the one function used, typed locally.
const { renderToStaticMarkup } = require('react-dom/server') as { renderToStaticMarkup: (el: React.ReactElement) => string };
const root = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');

let nextId = 1;
function mk(over: Partial<LeadRow> = {}): LeadRow {
  const id = over.id ?? nextId++;
  return {
    id, lead_id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, inventory_item_id: 100, item_name: 'Item', first_contact_at: '2026-09-10', last_contact_at: '2026-09-12',
    source_channel: 'Marketplace', deal_channel_id: 1, channel_name: 'Marketplace', buyer_message_count: 1, our_message_count: 1, lead_quality: null, offer_type: 'NONE',
    initial_cash_offer: null, best_cash_offer: null, trade_item: null, cash_component: null, trade_est_value: null, status: 'OPEN', outcome_reason: null, notes: null, deal_id: null,
    contact_name: null, source_updated_at: '2026-09-12T10:00:00Z', last_imported_at: null, ...LEAD_SNAPSHOT_DEFAULTS, ...over,
  };
}
const ids = (rows: LeadRow[]) => rows.map((r) => r.id).join(',');
const params = (qs: string) => { const sp = new URLSearchParams(qs); return (k: string) => sp.get(k); };

console.log('\n[S — sorting]');
{
  const rows = [
    mk({ id: 1, first_contact_at: '2026-09-05', last_contact_at: '2026-09-20', contact_name: 'bob', item_name: '2019 Fender Telecaster', channel_name: 'Reverb', peak_stage: 'NEGOTIATING', status: 'GHOSTED', buyer_message_count: 4, our_message_count: 3, offer_type: 'CASH', best_cash_offer: 900 }),
    mk({ id: 2, first_contact_at: '2026-09-01', last_contact_at: '2026-09-02', contact_name: 'Alice', item_name: '2010 Gibson Les Paul', channel_name: 'kijiji', peak_stage: 'CONVERTED', status: 'COMPLETED', buyer_message_count: 1, our_message_count: null, offer_type: 'TRADE', trade_est_value: 1500 }),
    mk({ id: 3, first_contact_at: null, last_contact_at: null, contact_name: null, item_name: 'Boss DS-1', channel_name: null, source_channel: null, peak_stage: null, status: 'CLOSED', buyer_message_count: null, our_message_count: null, offer_type: 'NONE' }),
    mk({ id: 4, first_contact_at: '2026-09-09', last_contact_at: '2026-09-10', contact_name: 'Carol', item_name: '2021 Ibanez AZ', channel_name: 'Marketplace', peak_stage: 'INQUIRY', status: 'OPEN', buyer_message_count: 10, our_message_count: 0, offer_type: 'CASH', best_cash_offer: null, initial_cash_offer: 300 }),
    mk({ id: 5, first_contact_at: '2026-09-07', last_contact_at: '2026-09-08', contact_name: 'dave', item_name: '1983 Gibson Explorer', channel_name: 'Facebook', peak_stage: 'ENGAGED', status: 'AGREED', buyer_message_count: 2, our_message_count: 2, offer_type: 'MIXED', cash_component: 500 }),
  ];
  const s = (k: (typeof LEAD_SORT_KEYS)[number], d: 'asc' | 'desc') => ids(sortLeads(rows, k, d));
  check('date asc / desc on first_contact_at, undated last both ways', s('date', 'asc') === '2,1,5,4,3' && s('date', 'desc') === '4,5,1,2,3', [s('date', 'asc'), s('date', 'desc')]);
  check('last contact asc / desc, undated last', s('last_contact', 'asc') === '2,5,4,1,3' && s('last_contact', 'desc') === '1,4,5,2,3', [s('last_contact', 'asc'), s('last_contact', 'desc')]);
  check('name: case-insensitive, no name last both ways', s('name', 'asc') === '2,1,4,5,3' && s('name', 'desc') === '5,4,1,2,3', [s('name', 'asc'), s('name', 'desc')]);
  check('item: displayed item name, case-insensitive', s('item', 'asc') === '5,2,1,4,3' && s('item', 'desc') === '3,4,1,2,5', [s('item', 'asc'), s('item', 'desc')]);
  check('channel: case-insensitive label (Unknown for none)', s('channel', 'asc') === '5,2,4,1,3' && s('channel', 'desc') === '3,1,4,2,5', [s('channel', 'asc'), s('channel', 'desc')]);
  check('stage: semantic order INQUIRY..CONVERTED, unset last both ways', s('stage', 'asc') === '4,5,1,2,3' && s('stage', 'desc') === '2,1,5,4,3', [s('stage', 'asc'), s('stage', 'desc')]);
  check('status: lifecycle order OPEN, AGREED, COMPLETED, ..., GHOSTED, CLOSED', s('status', 'asc') === '4,5,2,1,3' && s('status', 'desc') === '3,1,2,5,4', [s('status', 'asc'), s('status', 'desc')]);
  check('messages: buyer + ours (one missing adds 0), both missing last', s('messages', 'asc') === '2,5,1,4,3' && s('messages', 'desc') === '4,1,5,2,3', [s('messages', 'asc'), s('messages', 'desc')]);
  check('offer: CASH < MIXED < TRADE then stored amount; No offer last both ways', s('offer', 'asc') === '4,1,5,2,3' && s('offer', 'desc') === '2,5,1,4,3', [s('offer', 'asc'), s('offer', 'desc')]);
  const cashNoAmount = [mk({ id: 10, offer_type: 'CASH' }), mk({ id: 11, offer_type: 'CASH', best_cash_offer: 50 }), mk({ id: 12, offer_type: 'NONE' })];
  check('offer: a missing amount sorts last within its type, never invented', ids(sortLeads(cashNoAmount, 'offer', 'asc')) === '11,10,12' && ids(sortLeads(cashNoAmount, 'offer', 'desc')) === '11,10,12');
  check('ties fall back to the default recent-first order', ids(sortLeads([mk({ id: 20, peak_stage: 'ENGAGED', first_contact_at: '2026-09-01' }), mk({ id: 21, peak_stage: 'ENGAGED', first_contact_at: '2026-09-03' })], 'stage', 'asc')) === '21,20');
  check('no sort column = default recent-first order', ids(sortLeads(rows, null)) === '4,5,1,2,3');
  check('sorting never changes the count', LEAD_SORT_KEYS.every((k) => sortLeads(rows, k, 'desc').length === rows.length));
  let st: Pick<LeadFilters, 'sort' | 'dir'> = { sort: null, dir: 'asc' };
  const seq: string[] = [];
  for (let i = 0; i < 3; i++) { st = nextSort(st, 'stage'); seq.push(`${st.sort}:${st.dir}`); }
  check('header cycle: asc -> desc -> default; another column starts at asc', seq.join(' ') === 'stage:asc stage:desc null:asc' && nextSort({ sort: 'name', dir: 'desc' }, 'stage').dir === 'asc', seq);
}

console.log('\n[F — name / item / stage filters]');
{
  const rows = [
    mk({ id: 31, contact_name: 'Matt Maccallum', inventory_item_id: 7, item_name: '2019 Fender Telecaster' }),
    mk({ id: 32, contact_name: 'Matt Maccallum', inventory_item_id: 8, item_name: '2010 Gibson Les Paul' }),
    mk({ id: 33, contact_name: 'matt maccallum', inventory_item_id: 7 }),
    mk({ id: 34, contact_name: 'KijijiUser', inventory_item_id: 9, source_channel: 'Kijiji', channel_name: 'Kijiji' }),
    mk({ id: 35, contact_name: 'KijijiUser', inventory_item_id: 10, source_channel: 'Kijiji', channel_name: 'Kijiji' }),
    mk({ id: 36, contact_name: 'KijijiUser', inventory_item_id: 9, source_channel: 'Kijiji', channel_name: 'Kijiji' }),
    mk({ id: 37, contact_name: 'Matt', inventory_item_id: 7, peak_stage: 'NEGOTIATING', lead_quality: 'LOW' }),
    mk({ id: 38, contact_name: null, inventory_item_id: 7, peak_stage: 'ENGAGED', lead_quality: 'SERIOUS' }),
    mk({ id: 39, contact_name: null, inventory_item_id: 8, peak_stage: null, lead_quality: 'HIGH_INTENT' }),
  ];
  const f = (patch: Partial<LeadFilters>) => ids(sortLeads(applyLeadFilters(rows, { ...EMPTY_LEAD_FILTERS, ...patch }, null), 'date', 'asc').sort((a, b) => a.id - b.id));
  check('name click filters the EXACT displayed name (not fuzzy, not case-folded, not a prefix)', f({ name: 'Matt Maccallum' }) === '31,32', f({ name: 'Matt Maccallum' }));
  check('same-name leads on different items all stay visible', f({ name: 'Matt Maccallum' }).split(',').length === 2);
  check('KijijiUser returns every row with that displayed name (no identity merge)', f({ name: 'KijijiUser' }) === '34,35,36');
  check('item click filters by item_id', f({ itemId: 7 }) === '31,33,37,38');
  check('clearing the item filter restores the list', ids(applyLeadFilters(rows, patchLeadFilters({ ...EMPTY_LEAD_FILTERS, itemId: 7 }, { itemId: null }), null)) === ids(rows));
  check('name + item combine (AND)', f({ name: 'Matt Maccallum', itemId: 7 }) === '31');
  check('stage filter matches peak_stage only', f({ stage: 'ENGAGED' }) === '38' && f({ stage: 'NEGOTIATING' }) === '37');
  check('Negotiating+ = peak NEGOTIATING/HIGH_INTENT/CONVERTED; legacy quality only while peak_stage unset', f({ negotiatingPlus: true }) === '37,39', f({ negotiatingPlus: true }));
  check('Negotiating+ quick filter round-trips', activeQuickFilter(patchLeadFilters(EMPTY_LEAD_FILTERS, quickFilterPatch('negotiating'))) === 'negotiating');
}

console.log('\n[U — URL state]');
{
  const state = parseLeadFilters(params('search=strat&name=Matt%20Maccallum&item_id=7&channel_id=2&stage=HIGH_INTENT&offer_type=CASH&status=OPEN&from=2026-09-01&to=2026-09-30&negotiating_plus=1&sort=last_contact&dir=desc'));
  const url = leadsUrl(state);
  check('every filter + sort serializes', ['search=strat', 'name=Matt+Maccallum', 'item_id=7', 'channel_id=2', 'stage=HIGH_INTENT', 'offer_type=CASH', 'status=OPEN', 'from=2026-09-01', 'to=2026-09-30', 'negotiating_plus=1', 'sort=last_contact', 'dir=desc'].every((p) => url.includes(p)), url);
  check('and restores identically', JSON.stringify(parseLeadFilters(params(url.split('?')[1]))) === JSON.stringify(state));
  check('example /leads?name=Matt%20Maccallum&sort=last_contact&dir=desc parses', (() => { const f = parseLeadFilters(params('name=Matt%20Maccallum&sort=last_contact&dir=desc')); return f.name === 'Matt Maccallum' && f.sort === 'last_contact' && f.dir === 'desc'; })());
  check('dir without sort is ignored; unknown sort ignored; blank name ignored', JSON.stringify(parseLeadFilters(params('dir=desc&sort=nope&name=%20'))) === JSON.stringify(EMPTY_LEAD_FILTERS));
  check('no sort = no sort params (default order keeps the bare URL)', leadsUrl({ ...EMPTY_LEAD_FILTERS, dir: 'desc' }) === '/leads');
}

console.log('\n[I — interaction wiring (page source)]');
{
  const src = read('src', 'app', 'leads', 'page.tsx');
  const nameBtn = src.slice(src.indexOf('data-filter-name'), src.indexOf('data-filter-name') + 260);
  const itemBtn = src.slice(src.indexOf('data-filter-item'), src.indexOf('data-filter-item') + 260);
  check('name click stops propagation and filters (does not open the drawer)', /e\.stopPropagation\(\); filterByName\(/.test(nameBtn) && !/setSelectedId/.test(nameBtn), nameBtn);
  check('item click stops propagation and filters by item_id (does not open the drawer)', /e\.stopPropagation\(\); filterByItem\(lead\.inventory_item_id\)/.test(itemBtn) && !/setSelectedId/.test(itemBtn), itemBtn);
  check('row click (and Enter/Space on the focused row) opens the drawer', /data-lead-row[\s\S]{0,200}onClick=\{\(\) => setSelectedId\(lead\.id\)\}/.test(src) && /e\.key === 'Enter' \|\| e\.key === ' '/.test(src));
  check('mobile card: tap opens, explicit Details button for keyboard', /data-lead-card\s+onClick=\{\(\) => setSelectedId\(lead\.id\)\}/.test(src) && /data-open-lead/.test(src));
  check('every header is a sort button with aria-sort', /aria-sort=/.test(src) && /onClick=\{\(\) => update\(nextSort\(filters, c\.key\), 'replace'\)\}/.test(src));
  check('name and item filters show as removable chips; Clear filters resets them', /data-chip="name"/.test(src) && /Remove name filter/.test(src) && /data-chip="item"/.test(src) && /leadsUrl\(\{ returnTo: filters\.returnTo, sort: filters\.sort, dir: filters\.dir \}\)/.test(src));
  check('list never loads events (no N+1): only the drawer fetches one lead\'s history', !/fetchLeadEvents|lead_events/.test(src) && /fetchLeadEvents\(lead\.id\)/.test(read('src', 'components', 'leads', 'LeadDetailPanel.tsx')));
  check('search placeholder still matches what search covers (name, item, trade item, notes)', src.includes('placeholder="Name, item, trade item, or notes"') && /lead\.notes/.test(read('src', 'lib', 'leads', 'leadFilters.ts')));
}

console.log('\n[H — drawer history]');
void (async () => {
  const { default: LeadHistorySection } = await import('../src/components/leads/LeadHistorySection');
  let eid = 1;
  const ev = (o: Partial<LeadEventRecord>): LeadEventRecord => ({
    id: eid++, event_type: 'MESSAGE', direction: 'INBOUND', occurred_at: '2026-10-03T14:00:00Z', occurred_at_precision: 'DATE', summary: 'msg', message_count: 1, payload: {}, source: 'MCP', actor: 'AI', voided_at: null, ...o,
  });
  const events = [
    ev({ event_type: 'LEGACY_SNAPSHOT', direction: 'INTERNAL', occurred_at: '2026-10-01T12:00:00Z', summary: 'Legacy baseline', source: 'SYSTEM' }),
    ev({ event_type: 'STATUS_CHANGE', direction: 'INTERNAL', occurred_at: '2026-10-20T12:00:00Z', summary: 'Backfill: closed', source: 'BACKFILL', payload: { from: 'OPEN', to: 'CLOSED' } }),
    ev({ event_type: 'MESSAGE', direction: 'OUTBOUND', occurred_at: '2026-10-03T16:00:00Z', summary: 'Asked about condition and case' }),
    ev({ event_type: 'OFFER', occurred_at: '2026-10-03T13:00:00Z', summary: 'Offered 2011 Fender American Standard Stratocaster', payload: { offer: { cash_terms: 'STRAIGHT', cash_amount: null, items: [{ description: '2011 Fender American Standard Stratocaster', est_value: 1300 }] } } }),
    ev({ event_type: 'MESSAGE', occurred_at: '2026-10-03T15:00:00Z', summary: 'Sent photos', voided_at: '2026-10-05T00:00:00Z' }),
    ev({ event_type: 'LOGISTICS', direction: 'OUTBOUND', occurred_at: '2026-10-04T12:00:00Z', summary: 'Shipping confirmed', payload: { kind: 'SHIPPING', state: 'CONFIRMED', reference: '1Z999' } }),
    ev({ event_type: 'STATUS_CHANGE', direction: 'INTERNAL', occurred_at: '2026-10-04T13:00:00Z', summary: 'Item sold — open lead closed as ITEM_UNAVAILABLE', source: 'SYSTEM', payload: { from: 'OPEN', to: 'CLOSED', outcome_reason: 'ITEM_UNAVAILABLE' } }),
    ev({ event_type: 'DEAL_LINKED', direction: 'INTERNAL', occurred_at: '2026-10-04T14:00:00Z', summary: 'Deal completed', payload: { deal_id: 232 } }),
  ];
  const h = buildLeadHistory(events);
  check('hidden: LEGACY_SNAPSHOT, BACKFILL bookkeeping, voided', isHiddenEvent(events[0]) && isHiddenEvent(events[1]) && isHiddenEvent(events[4]) && !isHiddenEvent(events[6]) && h.entries.length === 5, h.entries.map((e) => e.summary));
  check('oldest -> newest regardless of input order', JSON.stringify(h.entries.map((e) => e.summary)) === JSON.stringify(['Offered 2011 Fender American Standard Stratocaster', 'Asked about condition and case', 'Shipping confirmed', 'Item sold — open lead closed as ITEM_UNAVAILABLE', 'Deal completed']));
  check('who + type labels (Buyer · Offer, Us · Message, Us · Shipping · Confirmed, Internal · Status, Internal · Deal linked)', JSON.stringify(h.entries.map((e) => `${e.whoLabel} · ${e.typeLabel}`)) === JSON.stringify(['Buyer · Offer', 'Us · Message', 'Us · Shipping · Confirmed', 'Internal · Status', 'Internal · Deal linked']));
  check('structured offer details', JSON.stringify(h.entries[0].details.map((d) => d.text)) === JSON.stringify(['2011 Fender American Standard Stratocaster — est. value $1,300', 'Straight trade — no cash']));
  check('status change + reason, logistics reference, deal link', h.entries[3].details.map((d) => d.text).join('|') === 'Open → Closed|Reason: Item unavailable' && h.entries[2].details[0].text === 'Reference: 1Z999' && h.entries[4].details[0].href === '/operations/232' && h.entries[4].details[0].text === 'Deal #232');
  check('date-only events show no time', h.entries[0].date === 'Oct 3, 2026' && h.entries[0].time === null);
  const renameOnly = buildLeadHistory([ev({ event_type: 'NOTE', direction: 'INTERNAL', summary: 'Contact name changed from "A" to "B"', source: 'UI', payload: { topic: 'OTHER', change: 'CONTACT_NAME', from: 'A', to: 'B' } })]);
  check('a contact-name audit is shown ("Name change") but is not substantive history', renameOnly.entries.length === 1 && renameOnly.entries[0].typeLabel === 'Name change' && !renameOnly.hasSubstantive);

  const render = (history: ReturnType<typeof buildLeadHistory> | null, notes: string | null, error: string | null = null) => renderToStaticMarkup(React.createElement(LeadHistorySection, { history, notes, error }));
  const modern = render(h, 'Old legacy narrative about the Strat.');
  check('modern lead: Event history timeline rendered', /data-event-timeline/.test(modern) && (modern.match(/data-event-row/g) ?? []).length === 5 && modern.includes('Event history'));
  check('modern lead: legacy notes present but COLLAPSED by default', /<details[^>]*data-legacy-notes[^>]*>/.test(modern) && !/<details[^>]*\sopen/.test(modern) && modern.includes('Legacy notes') && !/data-historical-summary/.test(modern));
  check('modern lead: event order preserved in the DOM', modern.indexOf('Offered 2011 Fender') < modern.indexOf('Asked about condition') && modern.indexOf('Asked about condition') < modern.indexOf('Deal completed'));
  check('modern lead without notes: no legacy section at all', !/data-legacy-notes/.test(render(h, null)) && !/data-legacy-notes/.test(render(h, '   ')));
  const legacy = render(buildLeadHistory([events[0], events[1]]), 'Legacy-only narrative survives.');
  check('legacy lead (only hidden events): Historical summary shown automatically, not collapsed', /data-historical-summary/.test(legacy) && legacy.includes('Detailed events were not recorded for this legacy lead.') && legacy.includes('Legacy-only narrative survives.') && !/<details/.test(legacy) && !/data-event-timeline/.test(legacy));
  const renamed = render(renameOnly, 'Legacy narrative.');
  check('legacy lead with only a rename: notes stay primary, rename listed below', /data-historical-summary/.test(renamed) && /data-event-timeline/.test(renamed) && renamed.indexOf('data-historical-summary') < renamed.indexOf('data-event-timeline') && !/<details/.test(renamed));
  check('neither events nor notes: small empty state', /data-history-empty/.test(render(buildLeadHistory([]), null)) && render(buildLeadHistory([]), null).includes('No history recorded for this lead.'));
  check('loading and error states', /data-history-loading/.test(render(null, null)) && /data-history-error/.test(render(null, 'n', 'Could not load')) && /data-historical-summary/.test(render(null, 'n', 'Could not load')));
  check('notes rendered as escaped text (no HTML injection)', !render(buildLeadHistory([]), '<img src=x onerror=alert(1)>').includes('<img'));
  const detail = read('src', 'components', 'leads', 'LeadDetailPanel.tsx');
  const historySrc = read('src', 'components', 'leads', 'LeadHistorySection.tsx');
  check('drawer: snapshot sections stay above the history; peak stage first-class; legacy quality only in Data QA', detail.indexOf('<Section title="Offer">') < detail.indexOf('<LeadHistorySection') && /label="Peak stage"><StageBadge/.test(detail) && /label="Legacy quality"/.test(detail) && !/QualityBadge/.test(detail));
  check('drawer: history rows wrap (no horizontal overflow), drawer width unchanged', /break-words/.test(historySrc.slice(historySrc.indexOf('function Timeline'))) && /md:w-\[30rem\]/.test(detail) && /overflow-y-auto/.test(detail));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
