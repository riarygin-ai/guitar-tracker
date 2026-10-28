/**
 * test-negotiation-analytics.ts
 *
 * Negotiation Intelligence v1: the shared engine (src/lib/analytics/
 * negotiationAnalytics.ts) — population, funnel, outcomes, offer type,
 * channel, rounds, counters, counter size, historical ask context, coverage,
 * periods/comparison, and the bulk loader (fixed query count); and the
 * Business Coach consumer (advice/negotiationContext.ts + packet, prompt and
 * validation wiring).
 *
 * Pure fixtures + a fake Supabase client — no database.
 * Usage: npx tsx scripts/test-negotiation-analytics.ts
 */

import fs from 'fs';
import path from 'path';
import {
  buildNegotiationAnalytics, buyerImproved, evidenceStrength, listingTermsAtTime, loadNegotiationAnalyticsInputs,
  type NegotiationAnalyticsInputs, type NegotiationEventInput, type NegotiationLeadInput, type NegotiationListingInput,
  type NegotiationPriceHistoryInput,
} from '../src/lib/analytics/negotiationAnalytics';
import {
  buildNegotiationCoachContext, buildNegotiationSources, monthPeriods, negotiationCoachContextFromInputs,
} from '../src/lib/analytics/advice/negotiationContext';
import { buildAdviceInputPacket } from '../src/lib/analytics/advice/buildInputPacket';
import { validateAdviceResponse } from '../src/lib/analytics/advice/validateAdviceResponse';
import { hasPredictiveClaim, NEGOTIATION_SEMANTICS } from '../src/lib/analytics/advice/sharedSemantics';
import { ADVICE_SYSTEM_PROMPT, LISTING_ADVICE_SYSTEM_PROMPT } from '../src/lib/openai';
import { resolveCoachEvidence } from '../src/lib/coachAdviceView';
import type { SupabaseClient } from '@supabase/supabase-js';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}
const root = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');

// ── Fixtures ────────────────────────────────────────────────────────────────

let nextLead = 1;
let nextEvent = 1;
function lead(over: Partial<NegotiationLeadInput> = {}): NegotiationLeadInput {
  return {
    id: nextLead++, inventory_item_id: 10, deal_channel_id: 1, first_contact_at: '2026-10-05', peak_stage: 'NEGOTIATING',
    peak_stage_source: 'DERIVED', status: 'OPEN', outcome_reason: null, offer_type: 'CASH', origin: 'DIRECT', ...over,
  };
}
function ev(leadId: number, at: string, type: string, direction: NegotiationEventInput['direction'], payload: Record<string, unknown> = {}): NegotiationEventInput {
  return { id: nextEvent++, item_lead_id: leadId, event_type: type, direction, occurred_at: at, message_count: 1, expects_reply: false, payload };
}
const cash = (amount: number) => ({ offer: { cash_terms: 'AMOUNT', cash_amount: amount, items: [] } });
const mixed = (items: string[], amount: number | null) => ({ offer: { cash_terms: amount == null ? 'OPEN' : 'AMOUNT', cash_amount: amount, items: items.map((d) => ({ description: d })) } });
const straight = (items: string[]) => ({ offer: { cash_terms: 'STRAIGHT', cash_amount: null, items: items.map((d) => ({ description: d })) } });
const status = (to: string) => ({ to });
const channels = new Map([[1, 'Marketplace'], [2, 'Kijiji'], [3, 'Reverb'], [4, 'Regular Buyer / Seller']]);
function inputs(leads: NegotiationLeadInput[], events: NegotiationEventInput[] = [], listings: NegotiationListingInput[] = [], priceHistory: NegotiationPriceHistoryInput[] = []): NegotiationAnalyticsInputs {
  return { leads, events, listings, priceHistory, channelNameById: channels };
}
const T = (d: string, h = 12) => `2026-10-${d}T${String(h).padStart(2, '0')}:00:00Z`;

(async () => {
  console.log('\n[A — population + funnel]');
  {
    const leads = [
      lead({ peak_stage: 'INQUIRY' }), lead({ peak_stage: 'ENGAGED' }),
      lead({ peak_stage: 'NEGOTIATING' }), lead({ peak_stage: 'NEGOTIATING', status: 'DECLINED_BY_ME' }),
      lead({ peak_stage: 'HIGH_INTENT', status: 'AGREED' }), lead({ peak_stage: 'HIGH_INTENT', status: 'FAILED_AFTER_AGREEMENT' }),
      lead({ peak_stage: 'CONVERTED', status: 'COMPLETED', peak_stage_source: 'LEGACY_AUDIT', origin: 'SHEET' }),
    ];
    const r = buildNegotiationAnalytics(inputs(leads));
    check('population = peak_stage NEGOTIATING/HIGH_INTENT/CONVERTED only (INQUIRY/ENGAGED excluded)', r.funnel.negotiating_count === 5 && r.coverage.total_leads === 7);
    check('High Intent counts HIGH_INTENT + CONVERTED (stage order respected)', r.funnel.high_intent_count === 3);
    check('Converted counts CONVERTED only', r.funnel.converted_count === 1);
    check('rates carry count + sample_size: N→HI 3/5, HI→C 1/3, N→C 1/5', r.funnel.negotiating_to_high_intent.count === 3 && r.funnel.negotiating_to_high_intent.sample_size === 5 && r.funnel.negotiating_to_high_intent.rate_pct === 60
      && r.funnel.high_intent_to_converted.sample_size === 3 && r.funnel.negotiating_to_converted.rate_pct === 20);
    check('excluding our own declines: 1/4', r.funnel.negotiating_to_converted_excluding_declined_by_me.count === 1 && r.funnel.negotiating_to_converted_excluding_declined_by_me.sample_size === 4);
    check('resolved-only: OPEN/AGREED leave the denominator (1/3)', r.funnel.negotiating_to_converted_resolved_only.sample_size === 3 && r.funnel.still_open_count === 2);
    check('legacy lead (LEGACY_AUDIT, SHEET, no events) is in the funnel', r.coverage.negotiating_plus_by_stage_source.LEGACY_AUDIT === 1);
    check('legacy lead_quality is never read (not selected by the loader)', !/select\('[^']*lead_quality/.test(read('src', 'lib', 'analytics', 'negotiationAnalytics.ts')));
    check('evidence strength: 5 → insufficient; thresholds 10/30/100', r.funnel.negotiating_to_converted.evidence_strength === 'insufficient' && evidenceStrength(10) === 'low' && evidenceStrength(30) === 'moderate' && evidenceStrength(100) === 'stronger' && evidenceStrength(9) === 'insufficient');
    const empty = buildNegotiationAnalytics(inputs([]));
    check('empty input: zero counts, null rates, never NaN', empty.funnel.negotiating_count === 0 && empty.funnel.negotiating_to_converted.rate_pct === null && !JSON.stringify(empty).includes('NaN'));
    const items = buildNegotiationAnalytics(inputs([lead({ inventory_item_id: 1, peak_stage: 'CONVERTED', status: 'COMPLETED' }), lead({ inventory_item_id: 1, status: 'CLOSED', outcome_reason: 'ITEM_UNAVAILABLE' }), lead({ inventory_item_id: 2 })]));
    check('item level: 2 items with negotiation, 1 realized via a negotiating lead', items.funnel.items_with_negotiating_leads === 2 && items.funnel.items_realized_via_negotiating_lead.count === 1);
  }

  console.log('\n[B — outcomes kept separate]');
  {
    const leads = [
      lead({ status: 'DECLINED_BY_ME', outcome_reason: 'TRADE_NOT_INTERESTING' }), lead({ status: 'DECLINED_BY_ME', outcome_reason: 'PRICE' }),
      lead({ status: 'DECLINED_BY_THEM', outcome_reason: 'PRICE' }), lead({ status: 'GHOSTED' }),
      lead({ status: 'FAILED_AFTER_AGREEMENT', peak_stage: 'HIGH_INTENT' }), lead({ status: 'CLOSED', outcome_reason: 'ITEM_UNAVAILABLE' }),
    ];
    const o = buildNegotiationAnalytics(inputs(leads)).outcomes;
    check('DECLINED_BY_ME, DECLINED_BY_THEM, GHOSTED each have their own count (never merged)', o.by_status.DECLINED_BY_ME.count === 2 && o.by_status.DECLINED_BY_THEM.count === 1 && o.by_status.GHOSTED.count === 1);
    check('FAILED_AFTER_AGREEMENT and CLOSED separate', o.by_status.FAILED_AFTER_AGREEMENT.count === 1 && o.by_status.CLOSED.count === 1);
    check('no generic "lost" metric exists in the contract', !/\blost\b/i.test(JSON.stringify(o)) && !/lost_/.test(read('src', 'lib', 'analytics', 'negotiationAnalytics.ts')));
    check('reasons tallied per side', o.declined_by_me_reasons.TRADE_NOT_INTERESTING === 1 && o.declined_by_me_reasons.PRICE === 1 && o.declined_by_them_reasons.PRICE === 1 && o.closed_reasons.ITEM_UNAVAILABLE === 1);
    check('share_of_resolved uses resolved leads as denominator (6)', o.share_of_resolved.DECLINED_BY_ME.sample_size === 6 && o.share_of_resolved.DECLINED_BY_ME.count === 2);
  }

  console.log('\n[C — offer type + channel]');
  {
    const leads = [
      lead({ offer_type: 'CASH', peak_stage: 'CONVERTED', status: 'COMPLETED' }), lead({ offer_type: 'CASH' }),
      lead({ offer_type: 'TRADE' }), lead({ offer_type: 'TRADE', status: 'DECLINED_BY_ME' }),
      lead({ offer_type: 'MIXED', status: 'GHOSTED' }), lead({ offer_type: 'NONE' }),
      lead({ deal_channel_id: 2 }), lead({ deal_channel_id: 4 }), lead({ deal_channel_id: null }),
    ];
    const r = buildNegotiationAnalytics(inputs(leads));
    const t = Object.fromEntries(r.by_offer_type.map((s) => [s.offer_type, s]));
    check('CASH / TRADE / MIXED from structured item_leads.offer_type', t.CASH.lead_count === 5 && t.TRADE.lead_count === 2 && t.MIXED.lead_count === 1);
    check('offer_type NONE on a Negotiating+ lead → UNKNOWN (never guessed from text)', t.UNKNOWN.lead_count === 1);
    check('per type: converted + conversion rate with denominator', t.CASH.converted_count === 1 && t.CASH.negotiating_to_converted.sample_size === 5);
    check('per type outcome splits', t.TRADE.declined_by_me === 1 && t.MIXED.ghosted === 1);
    const c = Object.fromEntries(r.by_channel.map((s) => [s.channel, s]));
    check('channels normalized: Marketplace / Kijiji / Reverb / Regular Buyer/Seller / Other', Object.keys(c).join() === 'Marketplace,Kijiji,Reverb,Regular Buyer/Seller,Other');
    check('"Regular Buyer / Seller" DB row → Regular Buyer/Seller; null channel → Other', c['Regular Buyer/Seller'].lead_count === 1 && c.Other.lead_count === 1 && c.Kijiji.lead_count === 1 && c.Marketplace.lead_count === 6);
  }

  console.log('\n[D — rounds]');
  {
    const a = lead(), b = lead(), legacy = lead({ origin: 'SHEET', peak_stage_source: 'LEGACY_AUDIT' }), late = lead({ origin: 'SHEET' });
    const events = [
      ev(a.id, T('01', 10), 'OFFER', 'INBOUND', cash(2800)), ev(a.id, T('01', 11), 'MESSAGE', 'OUTBOUND'), ev(a.id, T('01', 12), 'OFFER', 'OUTBOUND', cash(3100)),
      ev(a.id, T('01', 13), 'MESSAGE', 'INBOUND'), ev(a.id, T('01', 14), 'OFFER', 'INBOUND', cash(2950)), ev(a.id, T('01', 15), 'OFFER', 'INBOUND', cash(2950)),
      ev(b.id, T('02'), 'MESSAGE', 'INBOUND'), ev(b.id, T('02', 13), 'MESSAGE', 'INBOUND'),
      ev(legacy.id, T('01', 1), 'LEGACY_SNAPSHOT', 'INTERNAL', { legacy: { peak_stage: 'NEGOTIATING' } }), ev(legacy.id, T('03'), 'OFFER', 'INBOUND', cash(1000)),
      ev(late.id, T('01', 1), 'LEGACY_SNAPSHOT', 'INTERNAL', { legacy: { peak_stage: 'ENGAGED' } }), ev(late.id, T('03'), 'OFFER', 'INBOUND', cash(1000)),
    ];
    const r = buildNegotiationAnalytics(inputs([a, b, legacy, late], events)).rounds;
    check('3 distinct concrete offers = 3 rounds; messages never count; a repeated identical offer is not a new round', r.distribution.find((d) => d.bucket === '2-3')!.lead_count === 1);
    check('a negotiating lead with only messages = zero rounds (not a fake round)', r.zero_round_count === 1);
    check('legacy lead whose snapshot already reached NEGOTIATING → rounds unknown (excluded, nothing manufactured)', r.rounds_unknown_count === 1 && r.rounds_known_count === 3);
    check('legacy lead whose snapshot was below NEGOTIATING → its later offers are complete → eligible (1 round)', r.distribution.find((d) => d.bucket === '1')!.lead_count === 1);
    check('median/average over leads with ≥1 round', r.median_rounds === 2 && r.average_rounds === 2);
  }

  console.log('\n[E — our counters: what happened next]');
  {
    const L = (s: string, extra: Partial<NegotiationLeadInput> = {}) => lead({ status: s, ...extra });
    const replied = L('OPEN'), improved = L('OPEN'), declined = L('DECLINED_BY_THEM'), ghosted = L('GHOSTED'), unresolved = L('OPEN'),
      weDeclined = L('DECLINED_BY_ME'), agreed = L('AGREED', { peak_stage: 'HIGH_INTENT' }), opening = L('OPEN'), mixedSame = L('OPEN'), mixedDiff = L('OPEN');
    const events = [
      ev(replied.id, T('05', 9), 'OFFER', 'INBOUND', cash(1000)), ev(replied.id, T('05', 10), 'OFFER', 'OUTBOUND', cash(1200)), ev(replied.id, T('05', 11), 'MESSAGE', 'INBOUND'),
      ev(improved.id, T('05', 9), 'OFFER', 'INBOUND', cash(1000)), ev(improved.id, T('05', 10), 'OFFER', 'OUTBOUND', cash(1200)), ev(improved.id, T('05', 11), 'OFFER', 'INBOUND', cash(1100)),
      ev(declined.id, T('05', 9), 'OFFER', 'INBOUND', cash(1000)), ev(declined.id, T('05', 10), 'OFFER', 'OUTBOUND', cash(1500)), ev(declined.id, T('05', 11), 'MESSAGE', 'INBOUND'), ev(declined.id, T('05', 12), 'STATUS_CHANGE', 'INTERNAL', status('DECLINED_BY_THEM')),
      ev(ghosted.id, T('05', 9), 'OFFER', 'INBOUND', cash(1000)), ev(ghosted.id, T('05', 10), 'OFFER', 'OUTBOUND', cash(1500)), ev(ghosted.id, T('09'), 'STATUS_CHANGE', 'INTERNAL', status('GHOSTED')),
      ev(unresolved.id, T('05', 9), 'OFFER', 'INBOUND', cash(1000)), ev(unresolved.id, T('05', 10), 'OFFER', 'OUTBOUND', cash(1500)),
      ev(weDeclined.id, T('05', 9), 'OFFER', 'INBOUND', cash(1000)), ev(weDeclined.id, T('05', 10), 'OFFER', 'OUTBOUND', cash(1500)), ev(weDeclined.id, T('05', 11), 'OFFER', 'INBOUND', cash(900)), ev(weDeclined.id, T('05', 12), 'STATUS_CHANGE', 'INTERNAL', status('DECLINED_BY_ME')),
      ev(agreed.id, T('05', 9), 'OFFER', 'INBOUND', cash(1000)), ev(agreed.id, T('05', 10), 'OFFER', 'OUTBOUND', cash(1100)), ev(agreed.id, T('05', 11), 'AGREEMENT', 'INBOUND'), ev(agreed.id, T('05', 12), 'STATUS_CHANGE', 'INTERNAL', status('AGREED')),
      ev(opening.id, T('05', 9), 'OFFER', 'OUTBOUND', cash(1500)), ev(opening.id, T('05', 10), 'MESSAGE', 'INBOUND'),
      ev(mixedSame.id, T('05', 9), 'OFFER', 'INBOUND', mixed(['Fender Strat'], 200)), ev(mixedSame.id, T('05', 10), 'OFFER', 'OUTBOUND', mixed(['Fender Strat'], 600)), ev(mixedSame.id, T('05', 11), 'OFFER', 'INBOUND', mixed(['fender  strat'], 300)),
      ev(mixedDiff.id, T('05', 9), 'OFFER', 'INBOUND', mixed(['Fender Strat'], 200)), ev(mixedDiff.id, T('05', 10), 'OFFER', 'OUTBOUND', mixed(['Fender Strat'], 600)), ev(mixedDiff.id, T('05', 11), 'OFFER', 'INBOUND', mixed(['Gibson LP'], 900)),
    ];
    const all = [replied, improved, declined, ghosted, unresolved, weDeclined, agreed, opening, mixedSame, mixedDiff];
    const r = buildNegotiationAnalytics(inputs(all, events));
    const by = new Map(r.drilldown.counters.map((c) => [c.lead_id, c]));
    const cb = r.counter_behavior;
    check('an outbound offer with no earlier buyer offer is an opening ask, not a counter', cb.our_opening_offer_count === 1 && !by.has(opening.id));
    check('9 counters on 9 leads', cb.our_counter_count === 9 && cb.leads_with_our_counter === 9);
    check('buyer replied after our counter (message counts as a reply)', by.get(replied.id)!.buyer_replied && by.get(unresolved.id)!.buyer_replied === false);
    check('buyer improved: cash 1000 → 1100 after our 1200', by.get(improved.id)!.buyer_improved && by.get(improved.id)!.buyer_revised_offer);
    check('a lower revised offer is a revision, not an improvement', by.get(weDeclined.id)!.buyer_revised_offer && !by.get(weDeclined.id)!.buyer_improved);
    check('mixed with the SAME items (normalized) and more cash is an improvement', by.get(mixedSame.id)!.buyer_improved && by.get(mixedSame.id)!.buyer_improvement_comparable);
    check('mixed with DIFFERENT items is not comparable (no trade valuation guessed)', !by.get(mixedDiff.id)!.buyer_improved && !by.get(mixedDiff.id)!.buyer_improvement_comparable && by.get(mixedDiff.id)!.buyer_revised_offer);
    check('buyer declined → BUYER_DECLINED', by.get(declined.id)!.resolution === 'BUYER_DECLINED');
    check('buyer ghosted → BUYER_GHOSTED (separate from declined)', by.get(ghosted.id)!.resolution === 'BUYER_GHOSTED');
    check('we declined after the counter → WE_DECLINED (not a buyer loss)', by.get(weDeclined.id)!.resolution === 'WE_DECLINED');
    check('still open with no outcome → UNRESOLVED', by.get(unresolved.id)!.resolution === 'UNRESOLVED' && cb.unresolved_count >= 1);
    check('accepted → AGREED_OR_COMPLETED and reached high intent', by.get(agreed.id)!.resolution === 'AGREED_OR_COMPLETED' && by.get(agreed.id)!.reached_high_intent_or_accepted);
    check('a counter that did not convert is not called "rejected" — BUYER_DECLINED needs an explicit DECLINED_BY_THEM', by.get(unresolved.id)!.resolution !== 'BUYER_DECLINED');
    check('resolution is exclusive: sums to the counter count', Object.values(cb.resolution).reduce((s, n) => s + n, 0) === cb.our_counter_count);
    check('rates use our_counter_count as denominator', cb.buyer_declined.count === 1 && cb.buyer_declined.sample_size === 9 && cb.buyer_ghosted.count === 1 && cb.we_declined.count === 1);
    // Two counters on one lead: the first is COUNTERED_AGAIN, outcomes read only inside its window.
    const two = lead();
    const twoEv = [ev(two.id, T('06', 9), 'OFFER', 'INBOUND', cash(1000)), ev(two.id, T('06', 10), 'OFFER', 'OUTBOUND', cash(1400)), ev(two.id, T('06', 11), 'OFFER', 'OUTBOUND', cash(1300)), ev(two.id, T('06', 12), 'MESSAGE', 'INBOUND')];
    const rt = buildNegotiationAnalytics(inputs([two], twoEv)).drilldown.counters;
    check('two counters in a row: first COUNTERED_AGAIN with no reply in its window; second sees the reply', rt.length === 2 && rt[0].resolution === 'COUNTERED_AGAIN' && !rt[0].buyer_replied && rt[1].buyer_replied);
    check('voided events never reach the engine (loader filters voided_at)', /\.is\('voided_at', null\)/.test(read('src', 'lib', 'analytics', 'negotiationAnalytics.ts')));
  }

  console.log('\n[F — counter size]');
  {
    const a = lead(), b = lead(), c = lead(), d = lead();
    const events = [
      ev(a.id, T('07', 9), 'OFFER', 'INBOUND', cash(2800)), ev(a.id, T('07', 10), 'OFFER', 'OUTBOUND', cash(3100)),
      ev(b.id, T('07', 9), 'OFFER', 'INBOUND', mixed(['Strat'], 200)), ev(b.id, T('07', 10), 'OFFER', 'OUTBOUND', mixed(['Strat'], 600)),
      ev(c.id, T('07', 9), 'OFFER', 'INBOUND', cash(2000)), ev(c.id, T('07', 10), 'OFFER', 'OUTBOUND', cash(1900)),
      ev(d.id, T('07', 9), 'OFFER', 'INBOUND', cash(0)), ev(d.id, T('07', 10), 'OFFER', 'OUTBOUND', cash(1900)),
    ];
    const r = buildNegotiationAnalytics(inputs([a, b, c, d], events));
    const ca = r.drilldown.counters.find((x) => x.lead_id === a.id)!;
    check('(3100 − 2800) / 2800 = +10.7% → bucket >10-15', ca.counter_increase_vs_buyer_offer_pct === 10.7 && ca.counter_size_bucket === '>10-15');
    check('mixed/trade terms excluded from % (NON_CASH_TERMS), still a counter', r.drilldown.counters.find((x) => x.lead_id === b.id)!.numeric_missing_reason === 'NON_CASH_TERMS');
    check('counter not above the buyer offer is excluded (COUNTER_NOT_ABOVE_BUYER_OFFER)', r.drilldown.counters.find((x) => x.lead_id === c.id)!.numeric_missing_reason === 'COUNTER_NOT_ABOVE_BUYER_OFFER');
    check('a zero cash "offer" is not a valid buyer offer → no denominator, no counter', !r.drilldown.counters.some((x) => x.lead_id === d.id));
    check('coverage: 1 numeric eligible, 2 missing', r.counter_size_buckets.numeric_counter_analysis_eligible === 1 && r.counter_size_buckets.numeric_counter_analysis_missing === 2 && r.coverage.numeric_counter_analysis_eligible === 1);
    check('bucket rows carry sample_size and descriptive rates; 1 sample → insufficient', r.counter_size_buckets.buckets.find((x) => x.bucket === '>10-15')!.sample_size === 1 && r.counter_size_buckets.buckets.every((x) => x.evidence_strength === 'insufficient'));
    check('no probability-style metric anywhere in the contract (field names)', !/probab|likelihood|chance/i.test(JSON.stringify(Object.keys(r.counter_size_buckets.buckets[0])) + JSON.stringify(Object.keys(r.counter_behavior)) + JSON.stringify(Object.keys(r.funnel))));
    check('buyerImproved: different trade items → null (incomparable)', buyerImproved(mixed(['A'], 100).offer as never, mixed(['B'], 500).offer as never) === null && buyerImproved(straight(['A']).offer as never, mixed(['a'], 100).offer as never) === true);
  }

  console.log('\n[G — historical ask price + Trade state]');
  {
    const listing: NegotiationListingInput = { id: 50, inventory_item_id: 10, deal_channel_id: 1, status: 'active', asking_price: 2999, trade_enabled: true, listed_at: '2026-09-01', ended_at: null, created_at: '2026-09-01T12:00:00Z' };
    const hist: NegotiationPriceHistoryInput[] = [
      { item_listing_id: 50, old_asking_price: null, new_asking_price: 3450, old_trade_enabled: null, new_trade_enabled: null, changed_at: '2026-09-01T12:00:00Z' },
      { item_listing_id: 50, old_asking_price: 3450, new_asking_price: 2999, old_trade_enabled: false, new_trade_enabled: true, changed_at: '2026-10-20T12:00:00Z' },
    ];
    const byListing = new Map([[50, hist]]);
    const tracking = { priceFrom: '2026-09-01T12:00:00Z', tradeFrom: '2026-10-20T12:00:00Z' };
    const old = listingTermsAtTime(10, 1, '2026-10-10T12:00:00Z', [listing], byListing, tracking);
    check('old negotiation uses the price in effect then (3450), not today\'s 2999', old.price === 3450 && old.unavailable_reason === null);
    check('Trade state before Trade tracking → unknown (null), not today\'s true', old.trade_enabled === null);
    const recent = listingTermsAtTime(10, 1, '2026-10-25T12:00:00Z', [listing], byListing, tracking);
    check('after the last change → current terms (2999, Trade on)', recent.price === 2999 && recent.trade_enabled === true);
    const toggledBack: NegotiationPriceHistoryInput[] = [...hist, { item_listing_id: 50, old_asking_price: 2999, new_asking_price: 2999, old_trade_enabled: true, new_trade_enabled: false, changed_at: '2026-10-26T12:00:00Z' }];
    check('Trade read from history when a later toggle exists', listingTermsAtTime(10, 1, '2026-10-25T12:00:00Z', [{ ...listing, trade_enabled: false }], new Map([[50, toggledBack]]), tracking).trade_enabled === true);
    check('before any price history → unavailable (BEFORE_PRICE_HISTORY), never guessed', listingTermsAtTime(10, 1, '2026-10-10T12:00:00Z', [listing], byListing, { priceFrom: '2026-10-15T00:00:00Z', tradeFrom: null }).unavailable_reason === 'BEFORE_PRICE_HISTORY');
    check('no listing on that channel at that date → NO_LISTING_AT_TIME', listingTermsAtTime(10, 2, '2026-10-10T12:00:00Z', [listing], byListing, tracking).unavailable_reason === 'NO_LISTING_AT_TIME'
      && listingTermsAtTime(10, 1, '2026-08-10T12:00:00Z', [listing], byListing, tracking).unavailable_reason === 'NO_LISTING_AT_TIME');
    check('lead without a channel → NO_CHANNEL', listingTermsAtTime(10, null, '2026-10-10T12:00:00Z', [listing], byListing, tracking).unavailable_reason === 'NO_CHANNEL');
    check('two overlapping listings → AMBIGUOUS_LISTING', listingTermsAtTime(10, 1, '2026-10-10T12:00:00Z', [listing, { ...listing, id: 51 }], byListing, tracking).unavailable_reason === 'AMBIGUOUS_LISTING');
    check('cancelled listings are never a source of ask', listingTermsAtTime(10, 1, '2026-10-10T12:00:00Z', [{ ...listing, status: 'cancelled' }], byListing, tracking).unavailable_reason === 'NO_LISTING_AT_TIME');

    const l = lead();
    const events = [ev(l.id, '2026-10-10T10:00:00Z', 'OFFER', 'INBOUND', cash(2800)), ev(l.id, '2026-10-10T12:00:00Z', 'OFFER', 'OUTBOUND', cash(3100))];
    const r = buildNegotiationAnalytics(inputs([l], events, [listing], hist));
    const c = r.drilldown.counters[0];
    check('example: ask 3450, buyer 2800, counter 3100 → −18.8% / −10.1% / +10.7%', c.listing_price_at_time === 3450 && c.buyer_offer_gap_vs_ask_pct === -18.8 && c.our_counter_gap_vs_ask_pct === -10.1 && c.counter_increase_vs_buyer_offer_pct === 10.7);
    check('ask context aggregates carry their own counts', r.ask_context.counters_with_ask_known === 1 && r.ask_context.buyer_cash_offers_with_ask_known === 1 && r.ask_context.median_buyer_cash_offer_gap_vs_ask_pct === -18.8);
    check('listing_trade_enabled_at_time preserved per counter (null here: before Trade tracking)', c.listing_trade_enabled_at_time === null && r.ask_context.counters_with_trade_state_known === 0);
  }

  console.log('\n[H — coverage: legacy vs event-sequence leads]');
  {
    const legacy = Array.from({ length: 12 }, () => lead({ origin: 'SHEET', peak_stage_source: 'LEGACY_AUDIT', offer_type: 'TRADE' }));
    const direct = lead();
    const events = [
      ...legacy.map((l) => ev(l.id, T('01', 1), 'LEGACY_SNAPSHOT', 'INTERNAL', { legacy: { peak_stage: 'NEGOTIATING' } })),
      ev(direct.id, T('02', 9), 'OFFER', 'INBOUND', cash(1000)), ev(direct.id, T('02', 10), 'OFFER', 'OUTBOUND', cash(1200)),
    ];
    const r = buildNegotiationAnalytics(inputs([...legacy, direct], events));
    check('legacy leads count in the funnel and offer-type metrics', r.funnel.negotiating_count === 13 && r.by_offer_type.find((s) => s.offer_type === 'TRADE')!.lead_count === 12);
    check('but are excluded from event detail: 1 eligible / 12 ineligible', r.coverage.event_sequence_eligible_leads === 1 && r.coverage.event_sequence_ineligible_leads === 12 && r.counter_behavior.eligible_leads === 1 && r.counter_behavior.total_negotiating_leads === 13);
    check('every module exposes its own sample/coverage', r.rounds.rounds_known_count === 1 && r.rounds.rounds_unknown_count === 12 && r.coverage.our_counter_count === 1);
  }

  console.log('\n[I — periods + comparison]');
  {
    const mk = (date: string, s: string, stage = 'NEGOTIATING') => lead({ first_contact_at: date, status: s, peak_stage: stage });
    const leads = [
      ...Array.from({ length: 12 }, (_, i) => mk('2026-10-03', i < 2 ? 'DECLINED_BY_ME' : i < 6 ? 'CLOSED' : 'OPEN')),
      ...Array.from({ length: 20 }, (_, i) => mk('2026-09-10', i < 10 ? 'DECLINED_BY_ME' : 'CLOSED')),
      mk('2026-08-01', 'OPEN'), lead({ first_contact_at: null }),
    ];
    const { current, previous } = monthPeriods('2026-10-28');
    check('calendar months: current month to date + previous full month', current.start_date === '2026-10-01' && current.end_date === '2026-10-28' && previous.start_date === '2026-09-01' && previous.end_date === '2026-09-30' && monthPeriods('2026-01-15').previous.start_date === '2025-12-01');
    const r = buildNegotiationAnalytics(inputs(leads), { period: current, comparisonPeriod: previous });
    check('cohort by first_contact_at in the period', r.funnel.negotiating_count === 12 && r.period.start_date === '2026-10-01');
    const life = buildNegotiationAnalytics(inputs(leads));
    check('lifetime includes undated leads and reports them', life.funnel.negotiating_count === 34 && life.coverage.leads_without_first_contact_date === 1);
    const m = Object.fromEntries(r.comparison!.metrics.map((x) => [x.metric, x]));
    const dm = m.declined_by_me_share_of_resolved;
    check('outcome shares compared over RESOLVED leads (2/6 vs 10/20)', dm.current.count === 2 && dm.current.sample_size === 6 && dm.comparison.sample_size === 20);
    check('comparison with a side below 10 → not material (insufficient)', dm.evidence_strength === 'insufficient' && dm.material === false);
    check('comparison periods carry negotiating + still-open counts', r.comparison!.current_period.still_open_count === 6 && r.comparison!.comparison_period.negotiating_count === 20);
    const big = [...Array.from({ length: 30 }, (_, i) => mk('2026-10-03', i < 3 ? 'DECLINED_BY_ME' : 'CLOSED')), ...Array.from({ length: 30 }, (_, i) => mk('2026-09-10', i < 15 ? 'DECLINED_BY_ME' : 'CLOSED'))];
    const rb = buildNegotiationAnalytics(inputs(big), { period: current, comparisonPeriod: previous }).comparison!.metrics.find((x) => x.metric === 'declined_by_me_share_of_resolved')!;
    check('material: both ≥ low and |Δ| ≥ 10pp (10% vs 50% = −40pp)', rb.material && rb.difference_pp === -40 && rb.evidence_strength === 'moderate');
  }

  console.log('\n[J — loader: fixed queries, no N+1]');
  {
    const calls: { table: string; filters: string[] }[] = [];
    const fake = {
      from(table: string) {
        const rec = { table, filters: [] as string[] };
        calls.push(rec);
        const rows: Record<string, unknown[]> = {
          item_leads: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, inventory_item_id: 1, deal_channel_id: 1, first_contact_at: '2026-10-01', peak_stage: 'NEGOTIATING', peak_stage_source: 'DERIVED', status: 'OPEN', outcome_reason: null, offer_type: 'CASH', origin: 'DIRECT' })),
          lead_events: [], item_listings: [], item_listing_price_history: [], deal_channels: [{ id: 1, name: 'Marketplace' }],
        };
        const q = {
          select() { return q; }, order() { return q; },
          eq(c: string, v: unknown) { rec.filters.push(`${c}=${v}`); return q; },
          is(c: string, v: unknown) { rec.filters.push(`${c} is ${v}`); return q; },
          range() { return Promise.resolve({ data: rows[table], error: null }); },
        };
        return q;
      },
    } as unknown as SupabaseClient;
    const loaded = await loadNegotiationAnalyticsInputs({ client: fake, appUserId: 7 });
    check('exactly 5 bulk reads for 50 leads (no per-lead query)', calls.length === 5 && loaded.leads.length === 50);
    check('every user table filtered by user_id; events exclude voided', calls.filter((c) => c.table !== 'deal_channels').every((c) => c.filters.includes('user_id=7')) && calls.find((c) => c.table === 'lead_events')!.filters.includes('voided_at is null'));
  }

  console.log('\n[K — Business Coach consumer]');
  {
    // 40 legacy negotiating leads (trade-heavy) + 3 direct counters: counters stay suppressed.
    const leads: NegotiationLeadInput[] = [
      ...Array.from({ length: 25 }, (_, i) => lead({ origin: 'SHEET', peak_stage_source: 'LEGACY_AUDIT', offer_type: 'TRADE', status: i < 8 ? 'DECLINED_BY_ME' : i < 10 ? 'COMPLETED' : 'CLOSED', peak_stage: i >= 8 && i < 10 ? 'CONVERTED' : 'NEGOTIATING', first_contact_at: '2026-09-05' })),
      ...Array.from({ length: 15 }, (_, i) => lead({ origin: 'SHEET', peak_stage_source: 'LEGACY_AUDIT', offer_type: 'CASH', status: i < 4 ? 'COMPLETED' : 'DECLINED_BY_THEM', peak_stage: i < 4 ? 'CONVERTED' : 'NEGOTIATING', first_contact_at: '2026-10-05' })),
      ...Array.from({ length: 3 }, () => lead({ offer_type: 'MIXED', deal_channel_id: 2 })),
    ];
    const direct = leads.slice(-3);
    const events = direct.flatMap((l) => [ev(l.id, T('10', 9), 'OFFER', 'INBOUND', cash(1000)), ev(l.id, T('10', 10), 'OFFER', 'OUTBOUND', cash(1300))]);
    const inp = inputs(leads, events);
    const ctx = negotiationCoachContextFromInputs(inp, '2026-10-28');
    check('Coach context is built FROM the shared engine (same numbers as buildNegotiationAnalytics)', ctx.funnel!.negotiating_to_converted.count === buildNegotiationAnalytics(inp).funnel.negotiating_to_converted.count && ctx.engine_version === '1.0');
    check('weak modules suppressed with sample size: counters (3), counter size (3), rounds (3), MIXED (3)',
      ['counter_behavior', 'counter_size', 'rounds', 'by_offer_type:MIXED'].every((m) => ctx.suppressed.some((s) => s.module === m && s.sample_size === 3 && s.min_required === 10))
      && ctx.counter_behavior === null && ctx.counter_size === null && ctx.rounds === null);
    check('citable segments only ≥ 10 leads (TRADE 25, CASH 15)', ctx.by_offer_type!.segments.map((s) => s.offer_type).join() === 'CASH,TRADE');
    check('no lead ids, drilldown or per-counter records in the Coach block', !('drilldown' in ctx) && !/"lead_id"|counter_event_id|"counters":\[/.test(JSON.stringify(ctx)));
    const sources = buildNegotiationSources(ctx);
    check('sources: coverage always; funnel/outcomes/offer type/channel/material month comparison when citable; none for suppressed modules',
      sources.map((s) => s.source_id).join() === 'negotiation:coverage,negotiation:funnel,negotiation:outcomes,negotiation:offer_type,negotiation:channel,negotiation:comparison:month', sources.map((s) => s.source_id));
    check('every cited rate carries count/sample_size', Object.values(sources.find((s) => s.source_id === 'negotiation:funnel')!.key_metrics).every((v) => /^\d+\/\d+ \(.*%\), (insufficient|low|moderate|stronger)$/.test(String(v))));
    check('coverage source states the legacy limitation and suppressed modules', /complete event history/.test(sources[0].summary) && /counter_behavior \(n=3\)/.test(String(sources[0].key_metrics.suppressed_modules)));
    check('outcomes source keeps DECLINED_BY_ME separate from DECLINED_BY_THEM/GHOSTED', ['declined_by_me', 'declined_by_them', 'ghosted'].every((k) => k in sources.find((s) => s.source_id === 'negotiation:outcomes')!.key_metrics));
    check('month comparison suppressed when no metric is material', ctx.month_comparison === null || ctx.month_comparison.metrics.every((m) => m.material));
    const coachSrc = read('src', 'lib', 'analytics', 'advice', 'negotiationContext.ts');
    check('the Coach adapter computes no metric (no rate(), no ×100, no division of counts)', !/\brate\(/.test(coachSrc) && !/\* ?100/.test(coachSrc) && !/count \//.test(coachSrc));

    const { packet, sourceRegistry } = buildAdviceInputPacket({
      runId: 1, analyticsVersion: '2.13', evidenceScope: 'x', negotiation: ctx,
      snapshot: { generated_at: '2026-10-28T00:00:00Z', insights: { selected_findings: [{ finding_code: 'F', headline: 'h', summary: 's', metrics: {} }] } },
    });
    check('packet carries negotiation_analytics and its negotiation:* ids are allowed', !!packet!.negotiation_analytics && packet!.allowed_source_ids.includes('negotiation:funnel'));
    check('registry types them negotiation_analytics, never item-level', sourceRegistry.filter((s) => s.source_type === 'negotiation_analytics').every((s) => s.item_id === null) && sourceRegistry.some((s) => s.source_id === 'negotiation:coverage'));
    const without = buildAdviceInputPacket({ runId: 1, analyticsVersion: '2.13', evidenceScope: 'x', snapshot: { generated_at: 'g', insights: { selected_findings: [{ finding_code: 'F', headline: 'h', summary: 's', metrics: {} }] } } });
    check('absent negotiation context → packet exactly as before (additive)', !('negotiation_analytics' in without.packet!) && !without.packet!.allowed_source_ids.some((id) => id.startsWith('negotiation:')));
    check('drawer resolves a cited negotiation source from the persisted packet', resolveCoachEvidence('negotiation:funnel', packet!, sourceRegistry)?.kind === 'negotiation');

    const card = (advice: string, ids: string[]) => JSON.stringify({
      schema_version: '1.0', run_summary: { headline: 'h', summary: 's', source_ids: ['insight:F'] }, limitations: [],
      advice_cards: [{ advice_code: 'NEG', advice_type: 'observation', priority: 'medium', headline: 'Negotiation', advice, why_it_matters: 'w', confidence_label: 'moderate', source_ids: ids, limitations: [], item_id: null }],
    });
    const v1 = validateAdviceResponse(card('Historically, cash negotiations converted 4 of 15 (26.7%) versus 2 of 25 for trade; in this sample conversion was higher for cash.', ['negotiation:offer_type']), sourceRegistry);
    check('a descriptive, sourced conversion statement citing negotiation:* is accepted', v1.valid, v1.reasons);
    const v2 = validateAdviceResponse(card('Cash negotiations convert at 26.7%.', ['insight:F']), sourceRegistry);
    check('the same conversion claim WITHOUT a negotiation/linked-deal source is still rejected', !v2.valid && v2.reasons.includes('LEAD_DEAL_CONVERSION_CLAIM'));
    const v3 = validateAdviceResponse(card('This counter has a 70% chance of rejection.', ['negotiation:offer_type']), sourceRegistry);
    check('predictive claim rejected even with a negotiation source (PREDICTIVE_CLAIM)', !v3.valid && v3.reasons.includes('PREDICTIVE_CLAIM'));
    check('predictive detector: forecasts flagged, descriptive history passes',
      ['Buyers will reject counters above 20%.', 'a 70% chance of acceptance', 'close probability is low', 'the probability of a deal is high', 'Вероятность отказа 70%', '70% вероятность сделки'].every(hasPredictiveClaim)
      && !['Historically, 29% of buyers replied after a counter above 20% (n=17).', 'In this sample 6 of 21 replied.', 'Compared with your other negotiations, reply rates were lower.'].some(hasPredictiveClaim));

    check('prompt: negotiation semantics included in the General Coach prompt only', ADVICE_SYSTEM_PROMPT.includes(NEGOTIATION_SEMANTICS) && !LISTING_ADVICE_SYSTEM_PROMPT.includes('Negotiation semantics'));
    check('prompt: descriptive history, no probability, sample sizes required', /DESCRIPTIVE HISTORY, never prediction/.test(NEGOTIATION_SEMANTICS) && /give its count and sample size/.test(NEGOTIATION_SEMANTICS));
    check('prompt: DECLINED_BY_ME is our own filtering, never a buyer loss; CLOSED neutral', /DECLINED_BY_ME is our own decision/.test(NEGOTIATION_SEMANTICS) && /never a buyer loss/.test(NEGOTIATION_SEMANTICS) && /CLOSED \(ITEM_UNAVAILABLE\) is neutral/.test(NEGOTIATION_SEMANTICS));
    check('prompt: suppressed/weak evidence never a finding; fact → pattern → interpretation → recommendation', /never build a finding on anything listed in suppressed/.test(NEGOTIATION_SEMANTICS) && /Fact, pattern, interpretation, recommendation/.test(NEGOTIATION_SEMANTICS));
    check('prompt: no exact counter price; trade not "bad"; at most one card, never crowding out inventory', /Never prescribe an exact counter price/.test(NEGOTIATION_SEMANTICS) && /not by itself evidence that trade is bad/.test(NEGOTIATION_SEMANTICS) && /at most one card/.test(NEGOTIATION_SEMANTICS));
    check('generateAdvice enriches with negotiation but never blocks on it', /let negotiation: NegotiationCoachContext \| null = null;\s*try \{\s*negotiation = await loadNegotiationCoachContext\(/.test(read('src', 'lib', 'analytics', 'advice', 'generateAdvice.ts')));
    check('no MCP negotiation tool was added', !/registerTool\(\s*'[a-z_]*negotiat/i.test(read('src', 'app', 'api', 'mcp', '[[...path]]', 'route.ts')));
    const ctxEmpty = buildNegotiationCoachContext(buildNegotiationAnalytics(inputs([])), null, '2026-10-28');
    check('no data → only the coverage source (nothing to cite)', buildNegotiationSources(ctxEmpty).map((s) => s.source_id).join() === 'negotiation:coverage' && ctxEmpty.funnel === null);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch((e) => { console.error('Test script crashed:', e); process.exit(1); });
