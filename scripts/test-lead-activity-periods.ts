/**
 * test-lead-activity-periods.ts
 *
 * Pure (no database) coverage for the MCP get_lead_activity redesign:
 *   - src/lib/analytics/leadActivityPeriods.ts — calendar week/month
 *     bucketing, partial flags, year boundaries, explicit-range precedence
 *   - buildLeadActivity (src/lib/analytics/leadActivityService.ts) — the
 *     three-layer builder (current details / period buckets / lifetime)
 *     over synthetic leads, including the "Explorer" regression shape
 *   - a synthetic realistic-scale response-size measurement
 *
 * Usage:  npx tsx scripts/test-lead-activity-periods.ts
 */

import {
  resolveLeadActivityPeriods, calendarPeriodOf, LeadActivityPeriodError, type ResolvedPeriods,
} from '../src/lib/analytics/leadActivityPeriods';
import { buildLeadActivity, type LoadedLead, type OpenItemRef } from '../src/lib/analytics/leadActivityService';
import { torontoLocalDate } from '../src/lib/analytics/automation/torontoSchedule';

import { LEAD_SNAPSHOT_DEFAULTS } from '../src/lib/leads/leadTypes';
let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}
function throws(fn: () => unknown): boolean {
  try { fn(); return false; } catch (e) { return e instanceof LeadActivityPeriodError; }
}
const span = (r: ResolvedPeriods) => r.periods.map((p) => `${p.start_date}..${p.end_date}${p.is_partial ? '*' : ''}`);

let nextId = 1;
function lead(itemId: number, o: Partial<LoadedLead>): LoadedLead {
  return {
    id: nextId++, lead_id: `uuid-${nextId}`, inventory_item_id: itemId,
    first_contact_at: null, last_contact_at: null, source_channel: null, deal_channel_id: null, channel_name: null,
    buyer_message_count: null, our_message_count: null, lead_quality: 'LOW', offer_type: 'NONE',
    initial_cash_offer: null, best_cash_offer: null, trade_item: null, cash_component: null, trade_est_value: null,
    status: 'OPEN', outcome_reason: null, notes: null, deal_id: null, contact_name: null, source_updated_at: '2026-10-01T00:00:00Z', last_imported_at: null, ...LEAD_SNAPSHOT_DEFAULTS,
    ...o,
  };
}

function main() {
  // 2026-10-14 is a Wednesday.
  const TODAY = '2026-10-14';

  console.log('\n[A — calendar week: Monday -> Sunday]');
  {
    check('Wednesday maps to Mon..Sun', JSON.stringify(calendarPeriodOf('2026-10-14', 'week')) === JSON.stringify({ start: '2026-10-12', end: '2026-10-18' }));
    check('Monday is its own week start', calendarPeriodOf('2026-10-12', 'week').start === '2026-10-12');
    check('Sunday belongs to the week that started the previous Monday', calendarPeriodOf('2026-10-18', 'week').start === '2026-10-12');

    const r = resolveLeadActivityPeriods({}, TODAY);
    check('default = week bucket, rolling mode', r.bucket === 'week' && r.mode === 'rolling');
    check('default = current week + 4 complete prior weeks (5 buckets)', r.periods.length === 5, span(r));
    check('buckets are exactly the Mon-Sun weeks, oldest -> newest', JSON.stringify(span(r)) === JSON.stringify([
      '2026-09-14..2026-09-20', '2026-09-21..2026-09-27', '2026-09-28..2026-10-04', '2026-10-05..2026-10-11', '2026-10-12..2026-10-14*',
    ]), span(r));
    check('current partial week has is_partial=true', r.periods[4].is_partial === true);
    check('complete previous weeks have is_partial=false', r.periods.slice(0, 4).every((p) => !p.is_partial));
    check('range start/end reported', r.start_date === '2026-09-14' && r.end_date === TODAY);

    const sunday = resolveLeadActivityPeriods({ periods: 0 }, '2026-10-18');
    check('on Sunday the current week is complete (is_partial=false)', sunday.periods.length === 1 && !sunday.periods[0].is_partial, span(sunday));

    const yb = resolveLeadActivityPeriods({ periods: 2 }, '2027-01-02');
    check('year boundary: a week spanning Dec/Jan stays one Monday-Sunday bucket', JSON.stringify(span(yb)) === JSON.stringify([
      '2026-12-14..2026-12-20', '2026-12-21..2026-12-27', '2026-12-28..2027-01-02*',
    ]), span(yb));
    const yb2 = resolveLeadActivityPeriods({ periods: 1 }, '2027-01-05');
    check('year boundary: first week of the new year preceded by the Dec 28 - Jan 3 week', JSON.stringify(span(yb2)) === JSON.stringify(['2026-12-28..2027-01-03', '2027-01-04..2027-01-05*']), span(yb2));
  }

  console.log('\n[B — calendar month]');
  {
    const r = resolveLeadActivityPeriods({ bucket: 'month' }, TODAY);
    check('month default = current month + 4 complete prior months', JSON.stringify(span(r)) === JSON.stringify([
      '2026-06-01..2026-06-30', '2026-07-01..2026-07-31', '2026-08-01..2026-08-31', '2026-09-01..2026-09-30', '2026-10-01..2026-10-14*',
    ]), span(r));
    check('current partial month is_partial=true, prior months false', r.periods[4].is_partial && r.periods.slice(0, 4).every((p) => !p.is_partial));
    const yb = resolveLeadActivityPeriods({ bucket: 'month', periods: 2 }, '2027-01-15');
    check('month/year boundary', JSON.stringify(span(yb)) === JSON.stringify(['2026-11-01..2026-11-30', '2026-12-01..2026-12-31', '2027-01-01..2027-01-15*']), span(yb));
    const feb = resolveLeadActivityPeriods({ bucket: 'month', periods: 1 }, '2028-03-01');
    check('leap-year February ends on the 29th', span(feb)[0] === '2028-02-01..2028-02-29', span(feb));
    const lastDay = resolveLeadActivityPeriods({ bucket: 'month', periods: 0 }, '2026-10-31');
    check('on the last day of the month the current month is complete', !lastDay.periods[0].is_partial);
    const custom = resolveLeadActivityPeriods({ bucket: 'month', periods: 12 }, TODAY);
    check('periods=12 -> 13 monthly buckets', custom.periods.length === 13 && custom.start_date === '2025-10-01');
  }

  console.log('\n[C — explicit from_date/to_date precedence]');
  {
    const r = resolveLeadActivityPeriods({ bucket: 'month', from_date: '2026-06-01', to_date: '2026-08-31' }, TODAY);
    check('explicit mode', r.mode === 'explicit');
    check('June 1 - Aug 31 by month = 3 complete months', JSON.stringify(span(r)) === JSON.stringify(['2026-06-01..2026-06-30', '2026-07-01..2026-07-31', '2026-08-01..2026-08-31']), span(r));
    const w = resolveLeadActivityPeriods({ from_date: '2026-06-03', to_date: '2026-06-20' }, TODAY);
    check('weekly buckets are clipped to the range and clipped edges are partial', JSON.stringify(span(w)) === JSON.stringify([
      '2026-06-03..2026-06-07*', '2026-06-08..2026-06-14', '2026-06-15..2026-06-20*',
    ]), span(w));
    const open = resolveLeadActivityPeriods({ from_date: '2026-10-01' }, TODAY);
    check('to_date defaults to today', open.end_date === TODAY);
    const future = resolveLeadActivityPeriods({ from_date: '2026-10-01', to_date: '2026-12-31' }, TODAY);
    check('a future to_date is capped to today', future.end_date === TODAY && future.periods[future.periods.length - 1].end_date === TODAY);
    check('periods + from_date is rejected (never silently ignored)', throws(() => resolveLeadActivityPeriods({ from_date: '2026-06-01', periods: 3 }, TODAY)));
    check('to_date without from_date is rejected', throws(() => resolveLeadActivityPeriods({ to_date: '2026-06-01' }, TODAY)));
    check('from_date after to_date is rejected', throws(() => resolveLeadActivityPeriods({ from_date: '2026-07-01', to_date: '2026-06-01' }, TODAY)));
    check('from_date after today is rejected', throws(() => resolveLeadActivityPeriods({ from_date: '2026-11-01' }, TODAY)));
    check('impossible calendar date is rejected', throws(() => resolveLeadActivityPeriods({ from_date: '2026-02-30' }, TODAY)));
    check('too many buckets is rejected', throws(() => resolveLeadActivityPeriods({ from_date: '2020-01-01' }, TODAY)));
    check('the same 6-year range is fine by month', resolveLeadActivityPeriods({ bucket: 'month', from_date: '2022-01-01' }, TODAY).periods.length === 58);
    check('periods out of range is rejected', throws(() => resolveLeadActivityPeriods({ periods: 53 }, TODAY)) && throws(() => resolveLeadActivityPeriods({ periods: -1 }, TODAY)) && throws(() => resolveLeadActivityPeriods({ periods: 1.5 }, TODAY)));
    check('invalid bucket is rejected', throws(() => resolveLeadActivityPeriods({ bucket: 'day' as 'week' }, TODAY)));
  }

  console.log('\n[D — today is the America/Toronto calendar date, not the server clock]');
  {
    check('02:30 UTC Oct 15 is still Oct 14 in Toronto (EDT)', torontoLocalDate(new Date('2026-10-15T02:30:00Z')) === '2026-10-14');
    check('04:30 UTC Oct 15 is Oct 15 in Toronto', torontoLocalDate(new Date('2026-10-15T04:30:00Z')) === '2026-10-15');
    check('04:30 UTC Jan 1 is still Dec 31 in Toronto (EST)', torontoLocalDate(new Date('2027-01-01T04:30:00Z')) === '2026-12-31');
  }

  console.log('\n[E — builder: three layers over synthetic leads]');
  {
    const items: OpenItemRef[] = [
      { item_id: 10, item_display_name: '2019 Gibson Explorer' },
      { item_id: 20, item_display_name: '2021 Fender Stratocaster' },
      { item_id: 30, item_display_name: 'Quiet Item' },
    ];
    const leads: LoadedLead[] = [];
    // Explorer: 19 historical leads (Jun-Aug), 16 offers, 13 Serious, 3 High Intent, none recent.
    for (let i = 0; i < 19; i++) {
      leads.push(lead(10, {
        first_contact_at: `2026-0${6 + Math.floor(i / 7)}-${String(2 + (i % 7) * 4).padStart(2, '0')}`,
        lead_quality: i < 3 ? 'HIGH_INTENT' : i < 16 ? 'SERIOUS' : i < 18 ? 'ENGAGED' : 'LOW',
        offer_type: i < 16 ? 'CASH' : 'NONE', best_cash_offer: i < 16 ? 1500 + i * 10 : null,
        channel_name: i % 3 === 0 ? 'Kijiji' : 'Marketplace', deal_channel_id: i % 3 === 0 ? 2 : 1,
      }));
    }
    // Strat: recent activity
    leads.push(lead(20, { first_contact_at: '2026-10-13', last_contact_at: '2026-10-14', channel_name: 'Marketplace', lead_quality: 'SERIOUS', offer_type: 'MIXED', trade_item: 'Fender Jazzmaster', cash_component: 300, notes: 'Jazzmaster + $300' }));
    leads.push(lead(20, { first_contact_at: '2026-10-14', last_contact_at: '2026-10-14', channel_name: 'Reverb', lead_quality: 'ENGAGED' }));
    leads.push(lead(20, { first_contact_at: '2026-10-01', last_contact_at: '2026-10-13', channel_name: 'Kijiji', lead_quality: 'HIGH_INTENT', offer_type: 'CASH', best_cash_offer: 1500 }));
    leads.push(lead(20, { first_contact_at: '2026-10-06', last_contact_at: '2026-10-06', channel_name: 'Marketplace', status: 'GHOSTED' }));
    leads.push(lead(20, { first_contact_at: null, source_channel: 'FB Group' }));
    // A lead on an item outside the open set must never appear.
    leads.push(lead(99, { first_contact_at: '2026-10-13', notes: 'NOT-IN-SCOPE' }));

    const resolved = resolveLeadActivityPeriods({}, TODAY);
    const before = JSON.stringify(leads);
    const r = buildLeadActivity({ items, leads, resolved, filters: {}, today: TODAY, generatedAt: 'fixed' });
    check('builder never mutates its input leads', JSON.stringify(leads) === before);
    check('item with no leads goes to items_without_leads, not items', r.items_without_leads.length === 1 && r.items_without_leads[0].item_id === 30 && r.items.every((i) => i.item_id !== 30));
    check('out-of-scope item leads are never included', !JSON.stringify(r).includes('NOT-IN-SCOPE'));
    check('per-item periods align 1:1 with top-level periods', r.items.every((i) => i.periods.length === r.periods.length && i.periods.every((p, k) => p.start_date === r.periods[k].start_date && p.is_partial === r.periods[k].is_partial)));

    const exp = r.items.find((i) => i.item_id === 10)!;
    check('Explorer: zero current-period leads', exp.current_period.new_leads.length === 0 && exp.current_period.continuing_leads.length === 0);
    check('Explorer: every recent weekly bucket is zero', exp.periods.every((p) => p.lead_count === 0));
    check('Explorer: lifetime 19 leads / 16 offers / 13 Serious / 3 High Intent / 16 Serious+',
      exp.lifetime.lead_count === 19 && exp.lifetime.offer_count === 16 && exp.lifetime.serious_count === 13 && exp.lifetime.high_intent_count === 3 && exp.lifetime.serious_plus_count === 16, exp.lifetime);
    check('Explorer: lifetime channel breakdown Marketplace 12 / Kijiji 7', exp.lifetime.by_channel.Marketplace === 12 && exp.lifetime.by_channel.Kijiji === 7, exp.lifetime.by_channel);
    check('Explorer: first/last lead dates', exp.lifetime.first_lead_date === '2026-06-02' && exp.lifetime.last_lead_date === '2026-08-18', exp.lifetime);

    const strat = r.items.find((i) => i.item_id === 20)!;
    check('Strat: current week new leads = the two Oct 13/14 leads, as individual records', JSON.stringify(strat.current_period.new_leads.map((l) => l.first_contact_at)) === JSON.stringify(['2026-10-13', '2026-10-14']));
    check('Strat: detail carries offer/trade/notes fields', strat.current_period.new_leads[0].offer_summary === 'Fender Jazzmaster + $300 to us' && strat.current_period.new_leads[0].notes === 'Jazzmaster + $300' && strat.current_period.new_leads[0].channel === 'Marketplace');
    check('Strat: Oct 1 lead still active Oct 13 is a continuing lead', strat.current_period.continuing_leads.length === 1 && strat.current_period.continuing_leads[0].first_contact_at === '2026-10-01');
    check('Strat: weekly buckets [0,0,1,1,2]', JSON.stringify(strat.periods.map((p) => p.lead_count)) === JSON.stringify([0, 0, 1, 1, 2]));
    check('Strat: current bucket channel breakdown', JSON.stringify(strat.periods[4].by_channel) === JSON.stringify({ Marketplace: 1, Reverb: 1 }));
    check('Strat: undated lead counted only in lifetime', strat.lifetime.lead_count === 5 && strat.lifetime.undated_lead_count === 1 && strat.periods.reduce((s, p) => s + p.lead_count, 0) === 4);
    check('Strat: raw source channel used when no canonical channel', strat.lifetime.by_channel['FB Group'] === 1);
    check('Strat: last Serious+ date', strat.lifetime.last_serious_plus_lead_date === '2026-10-13');
    check('Strat: by_status', strat.lifetime.by_status.OPEN === 4 && strat.lifetime.by_status.GHOSTED === 1);
    check('totals.lifetime = sum of items', r.totals.lifetime.lead_count === 24 && r.totals.lifetime.offer_count === 18);
    check('totals.periods = sum of item buckets', r.totals.periods.every((p, k) => p.lead_count === r.items.reduce((s, i) => s + i.periods[k].lead_count, 0)));

    const monthly = buildLeadActivity({ items, leads, resolved: resolveLeadActivityPeriods({ bucket: 'month' }, TODAY), filters: { bucket: 'month' }, today: TODAY });
    const expM = monthly.items.find((i) => i.item_id === 10)!;
    check('monthly: Explorer Jun/Jul/Aug = 7/7/5, Sep/Oct = 0', JSON.stringify(expM.periods.map((p) => p.lead_count)) === JSON.stringify([7, 7, 5, 0, 0]), expM.periods.map((p) => p.lead_count));
    const stratM = monthly.items.find((i) => i.item_id === 20)!;
    check('monthly: current-month details include all October leads', stratM.current_period.new_leads.length === 4 && stratM.current_period.continuing_leads.length === 0);

    const mkt = buildLeadActivity({ items, leads, resolved, filters: { channel: ['marketplace'] }, today: TODAY });
    check('channel filter (case-insensitive) applies to lifetime too', mkt.items.find((i) => i.item_id === 10)!.lifetime.lead_count === 12 && mkt.items.find((i) => i.item_id === 20)!.lifetime.lead_count === 2);
    check('channel filter applies to current details', mkt.items.find((i) => i.item_id === 20)!.current_period.new_leads.every((l) => l.channel === 'Marketplace'));
    const reverb = buildLeadActivity({ items, leads, resolved, filters: { channel: ['Reverb'] }, today: TODAY });
    check('channel filter: items with no matching leads move to items_without_leads', reverb.items.length === 1 && reverb.items_without_leads.map((i) => i.item_id).sort().join() === '10,30');
    const ids = buildLeadActivity({ items, leads, resolved, filters: { item_ids: [10] }, today: TODAY });
    check('item_ids filter', ids.items.length === 1 && ids.items[0].item_id === 10 && ids.items_without_leads.length === 0);
    const combo = buildLeadActivity({ items, leads, resolved, filters: { item_ids: [20], channel: ['Kijiji'] }, today: TODAY });
    check('combined item_ids + channel', combo.items.length === 1 && combo.items[0].lifetime.lead_count === 1 && combo.items[0].current_period.continuing_leads.length === 1);

    const range = buildLeadActivity({ items, leads, resolved: resolveLeadActivityPeriods({ bucket: 'month', from_date: '2026-06-01', to_date: '2026-08-31' }, TODAY), filters: {}, today: TODAY });
    const expR = range.items.find((i) => i.item_id === 10)!;
    check('explicit range: current_period is the last bucket (August)', range.current_period.start_date === '2026-08-01' && expR.current_period.new_leads.length === 5);
    check('explicit range: lifetime still independent of the range', expR.lifetime.lead_count === 19 && range.items.find((i) => i.item_id === 20)!.lifetime.lead_count === 5);
  }

  console.log('\n[F — synthetic realistic-scale size measurement (informational)]');
  {
    const items: OpenItemRef[] = Array.from({ length: 50 }, (_, i) => ({ item_id: 1000 + i, item_display_name: `2020 Brand Model ${i}` }));
    const leads: LoadedLead[] = [];
    const note = 'Asked about neck profile and frets; offered cash, countered; said would think about it over the weekend. '.repeat(2);
    for (const it of items) {
      for (let k = 0; k < 15; k++) {
        const d = new Date(Date.UTC(2026, 0, 5) + k * 19 * 86400000).toISOString().slice(0, 10);
        leads.push(lead(it.item_id, { first_contact_at: d, last_contact_at: d, channel_name: ['Marketplace', 'Kijiji', 'Reverb'][k % 3], lead_quality: 'SERIOUS', offer_type: 'CASH', best_cash_offer: 1200, notes: note }));
      }
      leads.push(lead(it.item_id, { first_contact_at: '2026-10-13', last_contact_at: '2026-10-14', channel_name: 'Marketplace', lead_quality: 'ENGAGED', notes: note }));
    }
    const weekly = JSON.stringify(buildLeadActivity({ items, leads, resolved: resolveLeadActivityPeriods({}, TODAY), filters: {}, today: TODAY }));
    const monthly = JSON.stringify(buildLeadActivity({ items, leads, resolved: resolveLeadActivityPeriods({ bucket: 'month' }, TODAY), filters: {}, today: TODAY }));
    console.log(`  50 items x 16 leads (800 leads, ~220-char notes): weekly default = ${(weekly.length / 1024).toFixed(1)} KB, monthly = ${(monthly.length / 1024).toFixed(1)} KB`);
    check('synthetic weekly response is well under 200 KB (no pagination needed at this scale)', weekly.length < 200 * 1024, weekly.length);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
