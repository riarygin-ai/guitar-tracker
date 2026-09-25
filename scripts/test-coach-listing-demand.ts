/**
 * test-coach-listing-demand.ts
 *
 * Deterministic (no DB, no network, no LLM) validation of the Business
 * Coach's compact Listing Demand context:
 *   src/lib/analytics/advice/listingDemandContext.ts
 * plus its integration into the Advice Input Packet / source registry /
 * response validation, the extended Coach system prompt, failure
 * isolation, and the debug view wiring. Also measures context size.
 *
 * Usage:  npx tsx scripts/test-coach-listing-demand.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  COACH_DEMAND_LIMITATIONS, MAX_COACH_ITEMS, buildListingDemandContext, buildListingDemandSources, coachDemandEndDate, loadListingDemandContext, selectCoachItems,
  type ListingDemandContext,
} from '../src/lib/analytics/advice/listingDemandContext';
import { buildAdviceInputPacket } from '../src/lib/analytics/advice/buildInputPacket';
import { hashCanonicalInputPacket } from '../src/lib/analytics/advice/canonicalHash';
import { validateAdviceResponse } from '../src/lib/analytics/advice/validateAdviceResponse';
import { computeAdviceKey } from '../src/lib/analytics/advice/adviceKey';
import { formatSourceType } from '../src/lib/analytics/advice/presentation';
import { PROMPT_TEMPLATE_VERSION } from '../src/lib/analytics/advice/types';
import { ADVICE_SYSTEM_PROMPT } from '../src/lib/openai';
import type { ListingDemandEvidence, DemandWeeklyTrendEntry } from '../src/lib/analytics/listingDemandEvidence';
import type { ItemActivityEntry } from '../src/lib/analytics/listingItemActivity';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}

const root = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const strip = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ── Fixtures ─────────────────────────────────────────────────────────────

const CHANNELS = [
  { id: 1, name: 'Marketplace' },
  { id: 2, name: 'Kijiji' },
  { id: 3, name: 'Reverb' },
  { id: 9, name: 'Facebook Groups' }, // a future dynamic channel — must render without code changes
];

function week(i: number): { start: string; end: string } {
  const startEpoch = Date.UTC(2026, 8, 20) / 86400000 - (4 - i) * 7 + 1;
  const f = (e: number) => new Date(e * 86400000).toISOString().slice(0, 10);
  return { start: f(startEpoch), end: f(startEpoch + 6) };
}

function makeEvidence(): ListingDemandEvidence {
  const weeks: DemandWeeklyTrendEntry[] = [0, 1, 2, 3].map((i) => {
    const w = week(i);
    return {
      start_date: w.start, end_date: w.end, days: 7,
      item_listing_days: 200 + i, channel_listing_days: 300 + i * 10,
      avg_listed_items: 28.5 + i, avg_channel_exposure: 42.9 + i * 1.5, exposure_multiplier: 1.5,
      leads_started: 20 + i * 5, item_attributed_leads: 18 + i, channel_attributed_leads: 15 + i,
      serious_plus_leads_from_cohort: 6 + i, high_intent_leads_from_cohort: 2, realized_deal_count: i, realized_item_count: i,
      leads_per_100_item_listing_days: 9 + i, leads_per_100_channel_listing_days: 5 + i * 0.5,
      channels: CHANNELS.map((c) => ({
        deal_channel_id: c.id, channel_name: c.name, channel_listing_days: 40 + c.id * 3 + i, distinct_listed_items: 10,
        channel_attributed_leads: c.id * 2 + i, serious_plus_attributed_leads_from_cohort: c.id + i, high_intent_attributed_leads_from_cohort: 1,
        realized_deal_count_by_recorded_channel: c.id === 3 ? 1 : 0, leads_per_100_channel_listing_days: 10 + c.id + i / 10,
        last_lead_date: w.end,
      })),
    } as unknown as DemandWeeklyTrendEntry;
  });
  return {
    schema_version: '1.1', generated_at: '2026-09-20T12:00:00Z', target_user_id: 1, trend_window_weeks: 4,
    period: { start_date: '2026-09-14', end_date: '2026-09-20', days: 7 },
    comparison_period: { start_date: '2026-09-07', end_date: '2026-09-13', days: 7 },
    analysis_context: { lead_quality_semantics: 'x', deal_linkage_semantics: 'y' },
    summary: { current: {}, previous: {}, change: {} },
    channels: CHANNELS.map((c) => ({ deal_channel_id: c.id, channel_name: c.name, sort_order: c.id, current: {}, previous: {} })),
    items: [], weekly_trend: weeks,
    data_quality: {
      current_period: { leads_started: 30, item_attributed_leads: 27, channel_attributed_leads: 21, item_attribution_pct: 90, channel_attribution_pct: 70, leads_with_normalized_channel: 28, leads_without_normalized_channel: 2 },
      undated_lead_count: 3, earliest_dated_lead: '2026-01-05', earliest_listing_exposure_date: '2025-11-01',
    },
    limitations: ['very long verbose evidence limitation text that must NOT be copied into the Coach context'.repeat(3)],
  } as unknown as ListingDemandEvidence;
}

function item(id: number, over: Partial<ItemActivityEntry> = {}): ItemActivityEntry {
  return {
    item_id: id, item_display_name: `Item ${String(id).padStart(2, '0')}`, active_channels: [{ channel_id: 1, channel_name: 'Marketplace' }],
    item_attributed_leads: 0, serious_plus_attributed_leads: 0, offer_attributed_leads: 0, item_listing_days: 0, channel_listing_days: 0, last_attributed_lead_date: null, ...over,
  };
}

// 25 currently listed items: 13 with leads, 12 without (exposure varies)
function makeItems(): ItemActivityEntry[] {
  const out: ItemActivityEntry[] = [];
  for (let i = 1; i <= 13; i++) {
    out.push(item(i, { item_attributed_leads: 14 - i, serious_plus_attributed_leads: i % 3, offer_attributed_leads: i % 2, channel_listing_days: 20 + i, item_listing_days: 14 + i, last_attributed_lead_date: `2026-09-${String(10 + (i % 9)).padStart(2, '0')}` }));
  }
  for (let i = 14; i <= 25; i++) {
    out.push(item(i, { channel_listing_days: i === 20 ? 84 : i === 21 ? 84 : i * 2, item_listing_days: i === 21 ? 40 : 28 - (i % 5), active_channels: [{ channel_id: 1, channel_name: 'Marketplace' }, { channel_id: 3, channel_name: 'Reverb' }] }));
  }
  // one zero-lead item with NO exposure at all — must never be selected as "high exposure"
  out.push(item(26, { channel_listing_days: 0, item_listing_days: 0 }));
  return out;
}

const SNAPSHOT_WITH_INSIGHT = {
  generated_at: '2026-09-20T00:00:00Z',
  insights: {
    insights_engine_version: 'x', findings_selector_version: 'y',
    selected_findings: [{ finding_code: 'OPEN_INVENTORY_PRIORITY', headline: 'Item 7 needs review', summary: 'Aged Business item', confidence: null, metrics: { days: 90 }, limitations: [], segment: { item_id: 7 } }],
  },
};

async function main() {
  const evidence = makeEvidence();
  const items = makeItems();
  const ctx = buildListingDemandContext(evidence, items);
  const json = JSON.stringify(ctx);

  console.log('\n[A — market: exactly 4 chronological weekly rows with canonical fields only]');
  {
    const weeks = ctx.market_trend.weeks;
    check('exactly four weekly rows', weeks.length === 4 && ctx.window_weeks === 4);
    check('chronological (oldest -> newest), contiguous 7-day buckets', weeks.every((w, i) => i === 0 || w.start_date > weeks[i - 1].start_date) && weeks.every((w) => (Date.parse(w.end_date) - Date.parse(w.start_date)) / 86400000 === 6));
    check('window spans first bucket start .. last bucket end', ctx.start_date === weeks[0].start_date && ctx.end_date === weeks[3].end_date && ctx.end_date === '2026-09-20');
    const expectedKeys = ['avg_channel_exposure', 'avg_listed_items', 'end_date', 'leads_per_100_channel_listing_days', 'leads_started', 'realized_deal_count', 'serious_plus_leads_from_cohort', 'start_date'];
    check('each row has exactly the specified eight fields (no extra Evidence fields)', weeks.every((w) => JSON.stringify(Object.keys(w).sort()) === JSON.stringify(expectedKeys)), Object.keys(weeks[0]));
    check('values are passed through exactly (no recomputation)', weeks.every((w, i) => {
      const e = evidence.weekly_trend[i];
      return w.avg_listed_items === e.avg_listed_items && w.avg_channel_exposure === e.avg_channel_exposure && w.leads_started === e.leads_started
        && w.serious_plus_leads_from_cohort === e.serious_plus_leads_from_cohort && w.realized_deal_count === e.realized_deal_count && w.leads_per_100_channel_listing_days === e.leads_per_100_channel_listing_days;
    }));
    check('both raw leads AND exposure AND the normalized rate are present per week', weeks.every((w) => w.leads_started != null && w.avg_channel_exposure != null && w.leads_per_100_channel_listing_days != null));
    let threw = false;
    try { buildListingDemandContext({ ...evidence, weekly_trend: evidence.weekly_trend.slice(0, 3) }, items); } catch { threw = true; }
    check('an evidence payload that does not have 4 buckets is rejected (never padded/guessed)', threw);
  }

  console.log('\n[B — channels: dynamic, same four weeks, canonical fields]');
  {
    check('every canonical channel from Evidence is included, incl. a channel unknown to the code ("Facebook Groups")', ctx.channels.length === 4 && ctx.channels.some((c) => c.channel_name === 'Facebook Groups'));
    check('each channel has exactly the same four weekly buckets as the market rows', ctx.channels.every((c) => c.weeks.map((w) => w.start_date).join() === ctx.market_trend.weeks.map((w) => w.start_date).join()));
    const mk = ctx.channels.find((c) => c.channel_id === 1)!;
    const raw = evidence.weekly_trend[2].channels.find((c) => c.deal_channel_id === 1)!;
    check('channel week fields: exposure / attributed leads / Serious+ / deals by recorded channel / rate', mk.weeks[2].channel_listing_days === raw.channel_listing_days && mk.weeks[2].channel_attributed_leads === raw.channel_attributed_leads
      && mk.weeks[2].serious_plus_attributed_leads_from_cohort === raw.serious_plus_attributed_leads_from_cohort && mk.weeks[2].realized_deal_count_by_recorded_channel === raw.realized_deal_count_by_recorded_channel
      && mk.weeks[2].leads_per_100_channel_listing_days === raw.leads_per_100_channel_listing_days);
    check('channel rows carry exactly six fields', ctx.channels.every((c) => c.weeks.every((w) => Object.keys(w).length === 6)));
    check('a channel absent from a week is zero-filled (never dropped, never null-guessed)', (() => {
      const e2 = makeEvidence();
      e2.weekly_trend[1].channels = e2.weekly_trend[1].channels.filter((c) => c.deal_channel_id !== 2);
      const c2 = buildListingDemandContext(e2, items);
      const kij = c2.channels.find((c) => c.channel_id === 2)!;
      return kij.weeks.length === 4 && kij.weeks[1].channel_listing_days === 0 && kij.weeks[1].channel_attributed_leads === 0 && kij.weeks[1].leads_per_100_channel_listing_days === null;
    })());
    const src = strip(read('src', 'lib', 'analytics', 'advice', 'listingDemandContext.ts'));
    check('no hardcoded channel names in the builder', !/['"`>](Reverb|Marketplace|Kijiji)['"`<]/.test(src));
  }

  console.log('\n[C — items: deterministic compact selection]');
  {
    const { highest, zeroActivity } = selectCoachItems(items);
    check('at most 10 highest-activity items, all with attributed leads', highest.length === 10 && highest.every((i) => i.item_attributed_leads > 0), highest.map((i) => i.item_id));
    check('highest-activity order follows the Item Activity order (leads DESC ... name ASC)', highest.map((i) => i.item_id).join() === '1,2,3,4,5,6,7,8,9,10', highest.map((i) => i.item_id));
    check('at most 5 zero-lead items, all with zero attributed leads and real exposure', zeroActivity.length === 5 && zeroActivity.every((i) => i.item_attributed_leads === 0 && i.channel_listing_days > 0));
    check('zero-activity items chosen by channel_listing_days DESC (84, 84, then 50, 48, 46)', zeroActivity.map((i) => i.channel_listing_days).join() === '84,84,50,48,46', zeroActivity.map((i) => i.channel_listing_days));
    check('tie on channel days broken by item_listing_days DESC then name (item 21 before item 20)', zeroActivity[0].item_id === 21 && zeroActivity[1].item_id === 20, zeroActivity.map((i) => i.item_id));
    check('a zero-lead item with NO exposure is never selected', !zeroActivity.some((i) => i.item_id === 26));
    check('no duplicates across the two selections and total <= 15', new Set([...highest, ...zeroActivity].map((i) => i.item_id)).size === highest.length + zeroActivity.length && highest.length + zeroActivity.length <= MAX_COACH_ITEMS);
    check('selection is deterministic (shuffled input -> identical output)', JSON.stringify(selectCoachItems([...items].reverse())) === JSON.stringify({ highest, zeroActivity }));
    const few = selectCoachItems([item(1, { item_attributed_leads: 2, channel_listing_days: 5 }), item(2, { channel_listing_days: 9 })]);
    check('with few items nothing is padded: zero-activity items never appear as "highest activity"', few.highest.length === 1 && few.zeroActivity.length === 1 && few.highest[0].item_id === 1);
    check('an empty listing set produces empty selections', selectCoachItems([]).highest.length === 0 && selectCoachItems([]).zeroActivity.length === 0);
    const counts = ctx.items;
    check('totals tell the Coach how many items exist (26 listed, 13 with / 13 without leads)', counts.currently_listed_count === 26 && counts.with_attributed_leads_count === 13 && counts.without_attributed_leads_count === 13, counts);
    const it = ctx.items.highest_activity[0];
    check('item fields: id, name, active channels, leads, Serious+, Offers, channel days, item days, last lead', JSON.stringify(Object.keys(it).sort()) === JSON.stringify(['channel_listing_days', 'current_active_channels', 'item_attributed_leads', 'item_display_name', 'item_id', 'item_listing_days', 'last_attributed_lead_date', 'offer_attributed_leads', 'serious_plus_attributed_leads', 'source_id']), Object.keys(it));
    check('Offers and period-scoped Last Lead pass through unchanged', it.offer_attributed_leads === items[0].offer_attributed_leads && it.last_attributed_lead_date === items[0].last_attributed_lead_date);
    check('active channels are names (deduplicated), not ids/objects', ctx.items.zero_activity_high_exposure[0].current_active_channels.join() === 'Marketplace,Reverb');
    check('no Hot/Cold/score/rank fields on items', !/hot|cold|score|rank|winner|loser/i.test(JSON.stringify(it)));
  }

  console.log('\n[D — semantics encoded in the context]');
  {
    check('no conversion-rate / funnel / lead->deal field anywhere in the context', !/conversion|funnel|lead_to_deal|converted|conversion_rate/i.test(json.replace(/No canonical lead-to-deal link exists[^"]*/g, '').replace(/must not be treated as lead conversions/g, '')), json.match(/conversion[^"]{0,40}/i));
    check('realized deals are present only as factual counts (realized_deal_count*, never joined to leads)', json.includes('realized_deal_count') && !/deal_id|lead_id/.test(json));
    const dq = ctx.data_quality;
    check('data quality: item/channel attribution %, undated leads, earliest dated lead', dq.most_recent_7_day_period.item_attribution_pct === 90 && dq.most_recent_7_day_period.channel_attribution_pct === 70 && dq.undated_lead_count === 3 && dq.earliest_dated_lead === '2026-01-05');
    const text = dq.limitations.join(' ');
    check('historical-completeness limitation represented', /historical completeness varies/i.test(text));
    check('highest-ever lead-quality semantics represented', /highest intent level a lead has ever reached/i.test(text) && /Serious\+/.test(text));
    check('no-lead->deal-linkage limitation represented', /No canonical lead-to-deal link/i.test(text));
    check('attribution semantics: NULL-channel leads can still be item-attributed', /without a normalized channel can still be item-attributed/i.test(text));
    check('compact limitation text used instead of the verbose evidence limitations[]', !json.includes('very long verbose evidence limitation') && dq.limitations.length === COACH_DEMAND_LIMITATIONS.length && dq.limitations.every((l) => l.length < 260));
    check('Purpose does not filter demand: builder never reads purpose fields', !/purpose/i.test(strip(read('src', 'lib', 'analytics', 'advice', 'listingDemandContext.ts'))) && !/purpose/i.test(json));
    const withPurpose = items.map((i) => ({ ...i, purpose_name: 'Personal' }) as ItemActivityEntry);
    check('items keep being included regardless of any Purpose metadata attached to them', JSON.stringify(buildListingDemandContext(evidence, withPurpose)) === json);
    check('the context needs no UI state: identical for identical evidence, independent of any trend selection', JSON.stringify(buildListingDemandContext(makeEvidence(), makeItems())) === json);
  }

  console.log('\n[E — privacy: no raw lead data]');
  {
    check('no lead_id / UUIDs', !/lead_id|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(json));
    // Scan every key and value EXCEPT the fixed limitation prose (which legitimately says "buyer interest").
    const withoutProse = JSON.stringify(ctx, (k, v) => (k === 'limitations' ? undefined : v));
    check('no notes / messages / buyer / cash / trade fields', !/notes|message|buyer|cash_component|best_cash_offer|initial_cash_offer|trade_item|trade_est|our_message|outcome_reason|source_updated_at|last_imported_at/i.test(withoutProse), withoutProse.match(/notes|message|buyer|cash_component/i));
    const src = strip(read('src', 'lib', 'analytics', 'advice', 'listingDemandContext.ts'));
    check('builder never touches item_leads directly (canonical helpers only)', !/item_leads|\.from\(/.test(src));
    check('only the canonical helpers are used (no HTTP to the app\'s own endpoints, no UI/client cache)', /getListingDemandEvidence/.test(src) && /getListingItemActivity/.test(src) && !/fetch\(|listingsCache|useSwr|\/api\//.test(src));
    check('no full-evidence / limitations[] dump', !json.includes('"summary"') && !json.includes('"items":[{') && !json.includes('comparison_period'));
  }

  console.log('\n[F — packet / registry / validation integration]');
  {
    const base = buildAdviceInputPacket({ runId: 1, analyticsVersion: '2.13', evidenceScope: 'scope', snapshot: SNAPSHOT_WITH_INSIGHT });
    const withDemand = buildAdviceInputPacket({ runId: 1, analyticsVersion: '2.13', evidenceScope: 'scope', snapshot: SNAPSHOT_WITH_INSIGHT, listingDemand: ctx });
    check('without a demand block the packet is exactly what it always was (no listing_demand key)', base.packet !== null && !('listing_demand' in base.packet!) && base.packet!.allowed_source_ids.join() === 'insight:OPEN_INVENTORY_PRIORITY:item:7');
    check('with a demand block the packet carries listing_demand', withDemand.packet !== null && JSON.stringify(withDemand.packet!.listing_demand) === json);
    const demandIds = withDemand.packet!.allowed_source_ids.filter((id) => id.startsWith('demand:'));
    check('citable ids: market_trend, one per channel, one per selected item (15), data_quality', demandIds.length === 1 + 4 + 15 + 1 && demandIds.includes('demand:market_trend') && demandIds.includes('demand:channel:9') && demandIds.includes('demand:item:21') && demandIds.includes('demand:data_quality'), demandIds);
    check('existing insight sources and ids are untouched', withDemand.packet!.deterministic_insights.length === 1 && withDemand.packet!.allowed_source_ids[0] === 'insight:OPEN_INVENTORY_PRIORITY:item:7');
    const reg = withDemand.sourceRegistry.filter((s) => s.source_type === 'listing_demand');
    check('registry entries typed listing_demand; item entries carry item_id; no confidence invented', reg.length === demandIds.length && reg.find((s) => s.source_id === 'demand:item:3')!.item_id === 3 && reg.find((s) => s.source_id === 'demand:market_trend')!.item_id === null && reg.every((s) => s.confidence === null));
    check('registry key_metrics reuse the same sub-blocks (no extra fields)', JSON.stringify(reg.find((s) => s.source_id === 'demand:item:3')!.key_metrics).includes('"item_attributed_leads"') && !JSON.stringify(reg.map((s) => s.key_metrics)).includes('source_id'));
    check('the hash is deterministic and differs when demand data differs', hashCanonicalInputPacket(withDemand.packet) === hashCanonicalInputPacket(buildAdviceInputPacket({ runId: 1, analyticsVersion: '2.13', evidenceScope: 'scope', snapshot: SNAPSHOT_WITH_INSIGHT, listingDemand: ctx }).packet)
      && hashCanonicalInputPacket(withDemand.packet) !== hashCanonicalInputPacket(base.packet));
    const noEvidenceRun = buildAdviceInputPacket({ runId: 1, analyticsVersion: '2.13', evidenceScope: 'scope', snapshot: { generated_at: 'x' }, listingDemand: ctx });
    check('demand alone never makes an evidence-less run generatable (existing behavior preserved)', noEvidenceRun.packet === null);

    const cardBase = { advice_code: 'C1', advice_type: 'observation', priority: 'medium', headline: 'h', advice: 'a', why_it_matters: 'w', confidence_label: 'moderate', limitations: [] as string[] };
    const respond = (card: Record<string, unknown>) => JSON.stringify({ schema_version: '1.0', run_summary: { headline: 'h', summary: 's', source_ids: ['demand:market_trend'] }, advice_cards: [{ ...cardBase, ...card }], limitations: [] });
    const okMarket = validateAdviceResponse(respond({ source_ids: ['demand:market_trend', 'demand:channel:1'], item_id: null }), withDemand.sourceRegistry);
    check('a card may cite demand:* sources', okMarket.valid, okMarket.reasons);
    const okItem = validateAdviceResponse(respond({ source_ids: ['demand:item:21'], item_id: 21 }), withDemand.sourceRegistry);
    check('an item-level card is justified by its demand:item:<id> source', okItem.valid, okItem.reasons);
    const badItem = validateAdviceResponse(respond({ source_ids: ['demand:market_trend'], item_id: 21 }), withDemand.sourceRegistry);
    check('an item_id without an item-justifying source is still rejected', !badItem.valid && badItem.reasons.includes('ADVICE_CARD_0_REFERENCES_ABSENT_ITEM'));
    const badId = validateAdviceResponse(respond({ source_ids: ['demand:item:9999'], item_id: null }), withDemand.sourceRegistry);
    check('an invented demand id is rejected', !badId.valid);
    check('without a demand block a demand id is unknown (rejected)', !validateAdviceResponse(respond({ source_ids: ['demand:market_trend'], item_id: null }), base.sourceRegistry).valid);
    check('advice key handles demand-only cards deterministically (ranked after insight/pattern/hypothesis)', computeAdviceKey({ item_id: 21, source_ids: ['demand:item:21', 'demand:market_trend'] }).startsWith('v2:21:') && computeAdviceKey({ item_id: null, source_ids: ['demand:market_trend', 'insight:X'] }) === 'v2:-:insight:X');
    check('listing_demand sources have a readable label', formatSourceType('listing_demand') === 'Listing Demand');
  }

  console.log('\n[G — Coach instructions]');
  {
    const p = ADVICE_SYSTEM_PROMPT;
    check('prompt template version bumped for the new semantics', PROMPT_TEMPLATE_VERSION === 'analytics-advice-v3');
    check('describes the listing_demand block and demand:* sources', /listing_demand/.test(p) && /demand:/.test(p));
    check('normalize by exposure: leads_per_100_channel_listing_days preferred, compare leads with exposure', /leads_per_100_channel_listing_days is the preferred normalized channel-response metric/.test(p) && /Compare lead volume TOGETHER WITH exposure/.test(p));
    check('channel_listing_days vs item_listing_days defined', /channel_listing_days measures item x channel x calendar-day exposure/.test(p) && /item_listing_days measures item x calendar-day exposure/.test(p));
    check('highest-ever lead_quality + Serious+ definition', /highest intent level a lead has reached/.test(p) && /Serious\+ means SERIOUS or HIGH_INTENT/.test(p));
    check('Offers definition', /Offers \(offer_attributed_leads\) counts leads with a recorded CASH, TRADE, or MIXED offer/.test(p));
    check('item vs channel attribution + NULL-channel case', /Item-attributed means/.test(p) && /Channel-attributed additionally requires matching item\/channel listing exposure/.test(p) && /no normalized channel can still be item-attributed/.test(p));
    check('no lead->deal conversion assumption from unlinked evidence', /Canonical Lead -> Deal linkage exists ONLY where item_leads\.deal_id is populated/.test(p) && /never state or imply a lead-to-deal conversion rate or funnel/i.test(p) && /cannot currently be determined/.test(p));
    check('observational, non-causal wording rule', /never claim that listing on a channel, cross-listing, or any action caused demand/.test(p) && /associated with/.test(p) && /coincided with/.test(p));
    check('channel interpretation: experiments allowed, never remove a channel just for a low rate', /Never recommend removing or abandoning a channel merely because its lead rate is low/.test(p) && /realized deals are a separate fact/.test(p));
    check('sample size / logging-completeness caveat', /small counts are weak evidence/.test(p) && /incomplete logging/.test(p));
    check('no permanent item labels', /Do NOT create labels such as HOT, COLD, WINNER, or LOSER/.test(p));
    check('Demand Evidence is Purpose-agnostic', /completely Purpose-agnostic/.test(p) && /no Purpose filtering was applied/.test(p));
    check('existing Purpose-aware action policy intact (rules 8/9 + Purpose semantics)', /8\. Never pressure the user to sell Personal-purpose inventory/.test(p) && /9\. Treat Hybrid Purpose neutrally/.test(p) && /Personal: held primarily for enjoyment, collection, or appreciation/.test(p) && /Hybrid: selective, never assume it should sell quickly/.test(p));
    check('existing hard rules preserved verbatim (sourcing, no causation, no auto changes, max 3 cards)', ['Use ONLY the supplied packet', 'Treat every source as a statistical ASSOCIATION, never as proof of causation', 'Never recommend an automatic database change', 'Every advice card must cite at least one source_id', 'Generate at most 3 advice_cards'].every((s) => p.includes(s)));
    check('rule 2 still forbids new ROI/profit/realization rates, and now also new conversion figures', /Do not calculate new ROI, profit, days-on-market, realization rates, or peer baselines/.test(p) && /do not compute new rates, conversion figures/.test(p));
    check('item_id rule extended to demand:item sources without loosening it', /cited deterministic_insights source or a cited demand:item:<id> source — never invent or guess an item_id/.test(p));
    check('the old and new sections both exist exactly once', (p.match(/Purpose semantics \(apply consistently\)/g) ?? []).length === 1 && (p.match(/\nListing Demand semantics \(apply/g) ?? []).length === 1);
  }

  console.log('\n[H — context-level question scenarios (evidence sufficiency, no LLM)]');
  {
    const w = ctx.market_trend.weeks;
    check('Q1 "what changed in buyer activity recently?" — weekly leads / Serious+ across 4 weeks are present and vary', w.map((x) => x.leads_started).join() !== [w[0].leads_started, w[0].leads_started, w[0].leads_started, w[0].leads_started].join() && w.every((x) => typeof x.serious_plus_leads_from_cohort === 'number'));
    check('Q2 "which channels respond most relative to exposure?" — every channel has exposure + leads + per-100 rate for every week', ctx.channels.every((c) => c.weeks.every((x) => x.channel_listing_days >= 0 && x.channel_attributed_leads >= 0 && 'leads_per_100_channel_listing_days' in x)));
    check('Q3 "which listings generate the most interest?" — ranked highest_activity with leads/Serious+/Offers', ctx.items.highest_activity.length > 0 && ctx.items.highest_activity[0].item_attributed_leads >= ctx.items.highest_activity[1].item_attributed_leads);
    check('Q4 "substantial exposure but little interest?" — zero_activity_high_exposure with channel days', ctx.items.zero_activity_high_exposure.every((i) => i.item_attributed_leads === 0 && i.channel_listing_days > 0));
    check('Q5 "more leads only because more listings?" — avg listed items + avg channel exposure sit beside leads and the normalized rate', w.every((x) => x.avg_listed_items != null && x.avg_channel_exposure != null && x.leads_per_100_channel_listing_days != null) && /prefer it \(and exposure alongside it\) over raw lead counts/.test(ADVICE_SYSTEM_PROMPT));
    const q6 = JSON.stringify(ctx.data_quality.limitations) + ADVICE_SYSTEM_PROMPT;
    check('Q6 "are leads turning into deals?" — no conversion figure exists; the context and instructions say it cannot be determined', !/conversion_rate|lead_to_deal_rate/.test(json) && /No canonical lead-to-deal link exists/.test(q6) && /cannot currently be determined/.test(q6));
  }

  console.log('\n[I — failure isolation & freshness]');
  {
    const gen = strip(read('src', 'lib', 'analytics', 'advice', 'generateAdvice.ts'));
    check('generateAdviceForRun wraps the enrichment in try/catch and continues without it', /let listingDemand: ListingDemandContext \| null = null;\s*try \{\s*listingDemand = await loadListingDemandContext\(/.test(gen) && /catch \(demandError\)/.test(gen));
    check('the failure is logged, and no fallback metrics are fabricated', /console\.error\('\[generateAdvice\] listing demand enrichment unavailable/.test(gen) && /listingDemand,\s*linkedDealAnalytics,\s*language,\s*\}\)/.test(gen));
    check('the demand context is fetched server-side, at generation time (not from the /listings client cache)', /loadListingDemandContext\(\{ appUserId: requestingUserId, serviceClient \}\)/.test(gen) && !/listingsCache|swrCache/.test(gen + strip(read('src', 'lib', 'analytics', 'advice', 'listingDemandContext.ts'))));
    let rejected = false;
    const failing = { rpc: async () => ({ data: null, error: { message: 'boom' } }) } as never;
    try { await loadListingDemandContext({ appUserId: 1, serviceClient: failing, now: new Date('2026-09-20T15:00:00Z') }); } catch { rejected = true; }
    check('a failing evidence call rejects (caller omits the block)', rejected);
    let timedOut = false;
    const hanging = { rpc: () => new Promise(() => {}) } as never;
    try { await loadListingDemandContext({ appUserId: 1, serviceClient: hanging, timeoutMs: 25 }); } catch (e) { timedOut = /timed out/.test(String(e)); }
    check('a hanging evidence call times out instead of blocking the Coach', timedOut);
    check('end date is the Toronto-local calendar date (the automation\'s convention)', coachDemandEndDate(new Date('2026-09-21T02:30:00Z')) === '2026-09-20' && coachDemandEndDate(new Date('2026-09-20T15:00:00Z')) === '2026-09-20');
  }

  console.log('\n[J — debug / audit view]');
  {
    const page = read('src', 'app', 'analytics', 'page.tsx');
    check('existing Analytics debug pattern extended (CollapsibleSection with Copy) — no new page', /Debug: Listing Demand context sent to the Coach/.test(page) && /data=\{selectedAdvice\.input_packet\.listing_demand\}/.test(page));
    check('shows the exact persisted block (from the immutable input_packet), collapsed by default', /selectedAdvice\.input_packet\.listing_demand/.test(page) && !/CollapsibleSection title="Debug: Listing Demand[^>]*defaultOpen/.test(page));
    check('explains when a revision has no demand block', /No Listing Demand block was included/.test(page));
    check('no new admin page / Coach UI card was added', !fs.existsSync(path.join(root, 'src', 'app', 'coach')) && !fs.existsSync(path.join(root, 'src', 'app', 'admin', 'coach')));
    const layout = read('src', 'app', 'layout.tsx');
    check('no Leads / Coach entry added to the primary nav', !/Leads|Coach/i.test((layout.match(/<nav[\s\S]*?<\/nav>/g) ?? []).join('')));
  }

  console.log('\n[K — size]');
  {
    const chars = json.length;
    console.log(`  INFO: listing_demand block: ${chars.toLocaleString()} chars (~${Math.round(chars / 4).toLocaleString()} tokens) for 4 weeks x 4 channels + ${ctx.items.highest_activity.length + ctx.items.zero_activity_high_exposure.length} items`);
    const sources = buildListingDemandSources(ctx);
    console.log(`  INFO: registry copies (source_refs): ${JSON.stringify(sources).length.toLocaleString()} chars`);
    check('demand block stays comfortably small (< 12,000 chars ≈ 3k tokens for a full 4-channel / 15-item selection)', chars < 12000, chars);
    check('no thousands of zero-value fields: only selected items appear (15 of 26)', ctx.items.highest_activity.length + ctx.items.zero_activity_high_exposure.length === 15);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
