/**
 * test-listing-advice.ts
 *
 * Deterministic (no DB, no network, no live model) validation of the
 * /listings "Listing Advice" layer and the shared lead/deal hardening:
 *   context/packet, response validation, shared semantics in BOTH prompts,
 *   the observed live-Coach conversion bug (regression), the view helpers
 *   (persisted-evidence resolution, exact View Leads/Open Item actions),
 *   UI structure/placement, cache independence, failure isolation.
 * (DB persistence + concurrency: test-listing-advice-db.ts.)
 *
 * Usage:  npx tsx scripts/test-listing-advice.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildListingDemandContext, type ListingDemandContext } from '../src/lib/analytics/advice/listingDemandContext';
import {
  LISTING_ADVICE_PROMPT_VERSION, LISTING_ADVICE_SCHEMA_VERSION, buildListingAdvicePacket, hashListingAdvicePacket, validateListingAdviceResponse,
  type ListingAdviceCard,
} from '../src/lib/analytics/listingAdvice/listingAdvice';
import { LEAD_DEAL_RULES, LISTING_DEMAND_SEMANTICS, PURPOSE_SEMANTICS, findLeadDealViolations } from '../src/lib/analytics/advice/sharedSemantics';
import { validateAdviceResponse } from '../src/lib/analytics/advice/validateAdviceResponse';
import { PROMPT_TEMPLATE_VERSION } from '../src/lib/analytics/advice/types';
import { ADVICE_SYSTEM_PROMPT, LISTING_ADVICE_SYSTEM_PROMPT } from '../src/lib/openai';
import { adviceActions, relevantLimitations, resolveCardEvidence, resolveEvidence } from '../src/lib/listingAdviceView';
import { coachActions, coachLimitations, resolveCoachCardEvidence, resolveCoachEvidence } from '../src/lib/coachAdviceView';
import { parseLeadFilters } from '../src/lib/leads/leadFilters';
import { LISTING_ADVICE_KEY, LISTING_EVIDENCE_KEY, createListingsInvalidators, listingDemandKey } from '../src/lib/listingsCacheKeys';
import { createSwrCache } from '../src/lib/swrCache';
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

// ── Fixtures (same shape as the general Coach's demand-context tests) ────────
const CHANNELS = [{ id: 1, name: 'Marketplace' }, { id: 2, name: 'Kijiji' }, { id: 3, name: 'Reverb' }];

function makeEvidence(): ListingDemandEvidence {
  const f = (e: number) => new Date(e * 86400000).toISOString().slice(0, 10);
  const weeks: DemandWeeklyTrendEntry[] = [0, 1, 2, 3].map((i) => {
    const startEpoch = Date.UTC(2026, 8, 20) / 86400000 - (4 - i) * 7 + 1;
    return {
      start_date: f(startEpoch), end_date: f(startEpoch + 6), days: 7, item_listing_days: 200 + i, channel_listing_days: 300 + i * 10,
      avg_listed_items: 28.5 + i, avg_channel_exposure: 42.9 + i * 1.5, exposure_multiplier: 1.5, leads_started: 20 + i * 5, item_attributed_leads: 18 + i,
      channel_attributed_leads: 15 + i, serious_plus_leads_from_cohort: 6 + i, high_intent_leads_from_cohort: 2, realized_deal_count: i, realized_item_count: i,
      leads_per_100_item_listing_days: 9 + i, leads_per_100_channel_listing_days: 5 + i * 0.5,
      channels: CHANNELS.map((c) => ({
        deal_channel_id: c.id, channel_name: c.name, channel_listing_days: 40 + c.id * 3 + i, distinct_listed_items: 10, channel_attributed_leads: c.id * 2 + i,
        serious_plus_attributed_leads_from_cohort: c.id + i, high_intent_attributed_leads_from_cohort: 1, realized_deal_count_by_recorded_channel: c.id === 3 ? 1 : 0,
        leads_per_100_channel_listing_days: 10 + c.id + i / 10, last_lead_date: f(startEpoch + 6),
      })),
    } as unknown as DemandWeeklyTrendEntry;
  });
  return {
    schema_version: '1.1', generated_at: '2026-09-20T12:00:00Z', target_user_id: 1, trend_window_weeks: 4,
    period: { start_date: '2026-09-14', end_date: '2026-09-20', days: 7 }, comparison_period: { start_date: '2026-09-07', end_date: '2026-09-13', days: 7 },
    analysis_context: { lead_quality_semantics: 'x', deal_linkage_semantics: 'y' }, summary: { current: {}, previous: {}, change: {} },
    channels: CHANNELS.map((c) => ({ deal_channel_id: c.id, channel_name: c.name, sort_order: c.id, current: {}, previous: {} })), items: [], weekly_trend: weeks,
    data_quality: { current_period: { leads_started: 30, item_attributed_leads: 27, channel_attributed_leads: 21, item_attribution_pct: 90, channel_attribution_pct: 70, leads_with_normalized_channel: 28, leads_without_normalized_channel: 2 }, undated_lead_count: 3, earliest_dated_lead: '2026-01-05', earliest_listing_exposure_date: '2025-11-01' },
    limitations: ['verbose'],
  } as unknown as ListingDemandEvidence;
}
function item(id: number, over: Partial<ItemActivityEntry> = {}): ItemActivityEntry {
  return { item_id: id, item_display_name: `Item ${id}`, active_channels: [{ channel_id: 1, channel_name: 'Marketplace' }], item_attributed_leads: 0, serious_plus_attributed_leads: 0, offer_attributed_leads: 0, item_listing_days: 0, channel_listing_days: 0, last_attributed_lead_date: null, ...over };
}
const ITEMS: ItemActivityEntry[] = [
  item(55, { item_display_name: "2015 Gibson '63 ES-335", item_attributed_leads: 21, serious_plus_attributed_leads: 12, offer_attributed_leads: 12, channel_listing_days: 48, item_listing_days: 28, last_attributed_lead_date: '2026-09-19' }),
  item(56, { item_attributed_leads: 3, channel_listing_days: 20, item_listing_days: 14 }),
  item(70, { item_display_name: 'Silent Stratocaster', channel_listing_days: 84, item_listing_days: 28 }),
];
const CTX: ListingDemandContext = buildListingDemandContext(makeEvidence(), ITEMS);
const PACKET = buildListingAdvicePacket(CTX);

function card(over: Partial<ListingAdviceCard> = {}): Record<string, unknown> {
  return { advice_code: 'L1', advice_type: 'observation', priority: 'medium', confidence_label: 'moderate', title: 'Kijiji response per exposure strengthened', summary: 'Recorded leads per 100 channel-days rose over the four weeks while exposure changed less.', why_it_matters: 'Response per exposure is the fairer comparison.', next_steps: ['Check whether the listings on Kijiji changed'], source_ids: ['demand:channel:2'], limitations: [], ...over };
}
const respond = (cards: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ schema_version: '1.0', cards, ...extra });
const ids = PACKET.allowed_source_ids;

async function main() {
  console.log('\n[A — context & packet: shared canonical builder, 4 weeks, closed sources, privacy]');
  {
    const src = strip(read('src', 'lib', 'analytics', 'listingAdvice', 'listingAdvice.ts'));
    check('packet is built from the shared listingDemandContext (no second aggregation implementation)', /from '\.\.\/advice\/listingDemandContext'/.test(src) && /buildListingDemandSources/.test(src) && !/item_leads|supabase|rpc\(/.test(src));
    check('exactly 4 weekly buckets and a 4-week window', PACKET.listing_demand.market_trend.weeks.length === 4 && PACKET.window.weeks === 4 && PACKET.window.start_date === '2026-08-24' && PACKET.window.end_date === '2026-09-20');
    check('market / channels / items / data_quality all present', !!PACKET.listing_demand.market_trend && PACKET.listing_demand.channels.length === 3 && PACKET.listing_demand.items.highest_activity.length > 0 && !!PACKET.listing_demand.data_quality);
    check('closed source registry: market, each channel, each selected item, data_quality', ids.join() === ['demand:market_trend', 'demand:channel:1', 'demand:channel:2', 'demand:channel:3', 'demand:item:55', 'demand:item:56', 'demand:item:70', 'demand:data_quality'].join(), ids);
    check('independent of any /listings trend selection: the builder takes no UI/trend input', buildListingAdvicePacket.length === 1 && !/trend_weeks|searchParams|useSearchParams/.test(src));
    const json = JSON.stringify(PACKET);
    check('no raw lead data: no lead_id/UUID, notes, messages, buyer, cash/trade/offer details', !/lead_id|notes|message|buyer_|cash_component|best_cash_offer|initial_cash_offer|trade_item|trade_est|source_updated_at/i.test(JSON.stringify(PACKET, (k, v) => (k === 'limitations' || k === 'semantics' ? undefined : v))) && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(json));
    check('packet states the no lead->deal linkage and Purpose-agnostic evidence', /No canonical lead_id -> deal_id linkage/.test(PACKET.semantics.lead_deal_linkage) && PACKET.semantics.demand_evidence_purpose_agnostic === true);
    check('deterministic: same context -> identical bytes and hash', JSON.stringify(buildListingAdvicePacket(buildListingDemandContext(makeEvidence(), ITEMS))) === json && hashListingAdvicePacket(PACKET) === hashListingAdvicePacket(buildListingAdvicePacket(CTX)) && /^[0-9a-f]{64}$/.test(hashListingAdvicePacket(PACKET)));
    check('hash changes when the evidence changes', hashListingAdvicePacket(PACKET) !== hashListingAdvicePacket(buildListingAdvicePacket(buildListingDemandContext(makeEvidence(), [...ITEMS, item(99, { item_attributed_leads: 1, channel_listing_days: 3 })]))));
    check('no unrelated evidence in the packet (no acquisition/pattern/cash/purpose-review data)', !/acquisition_value|pattern_|cash_balance|purpose_id|deterministic_insights|confirmed_patterns/i.test(json));
  }

  console.log('\n[B — response validation]');
  {
    const v = (raw: string) => validateListingAdviceResponse(raw, ids);
    check('0 cards accepted (a valid "nothing material" outcome)', v(respond([])).valid && v(respond([])).output!.cards.length === 0);
    check('1 and 3 cards accepted', v(respond([card()])).valid && v(respond([card({ advice_code: 'a' }), card({ advice_code: 'b', source_ids: ['demand:market_trend'] }), card({ advice_code: 'c', source_ids: ['demand:item:55'] })])).valid);
    check('more than 3 cards rejected', v(respond([card(), card(), card(), card()])).reasons.includes('CARDS_EXCEEDS_MAXIMUM'));
    for (const t of ['action', 'observation', 'watch']) check(`type ${t} accepted`, v(respond([card({ advice_type: t as never })])).valid);
    check('unknown type ("review") rejected', !v(respond([card({ advice_type: 'review' as never })])).valid);
    check('invalid priority / confidence rejected', !v(respond([card({ priority: 'urgent' as never })])).valid && !v(respond([card({ confidence_label: 'certain' as never })])).valid);
    check('unknown source id rejected', v(respond([card({ source_ids: ['demand:item:9999'] })])).reasons.includes('CARD_0_CITES_UNKNOWN_SOURCE_ID'));
    check('an invented non-demand id (e.g. insight:*) rejected', !v(respond([card({ source_ids: ['insight:X'] })])).valid);
    check('a card with NO sources (unsupported evidence) rejected', v(respond([card({ source_ids: [] })])).reasons.includes('CARD_0_HAS_NO_SOURCES'));
    check('duplicate source ids are de-duplicated safely', JSON.stringify(v(respond([card({ source_ids: ['demand:channel:2', 'demand:channel:2', 'demand:market_trend'] })])).output!.cards[0].source_ids) === JSON.stringify(['demand:channel:2', 'demand:market_trend']));
    check('missing/blank required text rejected', !v(respond([card({ title: '  ' })])).valid && !v(respond([card({ summary: '' })])).valid && !v(respond([card({ why_it_matters: '' })])).valid);
    check('more than 3 next_steps rejected', v(respond([card({ next_steps: ['a', 'b', 'c', 'd'] })])).reasons.includes('CARD_0_TOO_MANY_NEXT_STEPS'));
    check('wrong schema_version / not JSON / not an object rejected', !v(JSON.stringify({ schema_version: '2.0', cards: [] })).valid && v('not json').reasons.includes('RESPONSE_NOT_VALID_JSON') && !v('[]').valid);
    check('extra/unknown top-level shape (cards missing) rejected', !v(JSON.stringify({ schema_version: '1.0' })).valid);
    check('the validator never edits: output equals the input cards (minus de-dup)', JSON.stringify(v(respond([card()])).output!.cards[0]) === JSON.stringify(card()));
    check('the constants persisted with each run: prompt version listing-advice-v1, schema 1.0', LISTING_ADVICE_PROMPT_VERSION === 'listing-advice-v1' && LISTING_ADVICE_SCHEMA_VERSION === '1.0' && String(LISTING_ADVICE_PROMPT_VERSION) !== String(PROMPT_TEMPLATE_VERSION));
  }

  console.log('\n[C — shared no-fake-conversion hardening (both prompts, one copy)]');
  {
    for (const [name, p] of [['general Business Coach', ADVICE_SYSTEM_PROMPT], ['Listing Advice', LISTING_ADVICE_SYSTEM_PROMPT]] as const) {
      check(`${name}: contains the ONE shared lead/deal rules block verbatim`, p.includes(LEAD_DEAL_RULES));
      check(`${name}: contains the shared Listing Demand semantics + Purpose semantics verbatim`, p.includes(LISTING_DEMAND_SEMANTICS) && p.includes(PURPOSE_SEMANTICS));
      check(`${name}: states there is NO canonical lead_id -> deal_id linkage`, /NO canonical lead_id -> deal_id linkage/.test(p));
      for (const term of ['conversion rate', 'low conversion', 'high conversion', 'lead-to-sale conversion', 'leads turning into deals', 'close rate', 'closing rate']) {
        check(`${name}: forbids "${term}"`, p.includes(term));
      }
      check(`${name}: forbids computing realized_deals / leads`, /Do not calculate realized_deals \/ leads/.test(p));
      check(`${name}: does not let a deal appear to originate from the period's leads`, /do not imply that deals observed in a period originated from that period's leads/.test(p));
      check(`${name}: allows side-by-side factual comparison but not "converted poorly"`, /Recorded lead activity was high while realized deal activity in the same period was lower/.test(p) && /Never turn such a statement into "converted poorly"/.test(p));
      check(`${name}: bans asserting follow-up/presentation/pricing/negotiation/lead-quality/process as the explanation`, /poor follow-up, bad listing presentation, bad pricing, negotiation failure, low-quality leads, or a poor sales process/.test(p) && /Do not assert any of these as the explanation/.test(p));
      check(`${name}: separates FACT from HYPOTHESIS/CHECK`, /Keep FACT separate from HYPOTHESIS\/CHECK/.test(p) && /worth CHECKING/.test(p));
      check(`${name}: observational, non-causal wording (associated with / coincided with; avoid caused/drove/resulted in/proves)`, /associated with/.test(p) && /coincided with/.test(p) && /Avoid "caused", "drove", "resulted in", and "proves"/.test(p));
      check(`${name}: normalize by exposure (leads_per_100_channel_listing_days preferred; +80%/+10% and +50%/+50% examples)`, /leads_per_100_channel_listing_days is the preferred normalized channel-response metric/.test(p) && /leads \+80% with exposure \+10%/.test(p) && /leads \+50% with exposure \+50%/.test(p));
      check(`${name}: item-level guidance without automatic price cuts or labels`, /Do not automatically recommend price cuts for zero-lead items/.test(p) && /Do NOT create labels such as HOT, COLD, WINNER, or LOSER/.test(p));
      check(`${name}: Purpose-aware action policy intact`, /Personal: held primarily for enjoyment/.test(p) && /Hybrid: selective, never assume it should sell quickly/.test(p));
    }
    const oa = read('src', 'lib', 'openai.ts');
    check('openai.ts imports the shared blocks and holds NO private copy of them', /import \{ LEAD_DEAL_RULES, LISTING_DEMAND_SEMANTICS, PURPOSE_SEMANTICS \} from/.test(oa) && !/NO canonical lead_id/.test(oa) && !/Listing Demand semantics \(apply/.test(oa) && (oa.match(/\$\{LEAD_DEAL_RULES\}/g) ?? []).length === 2);
    check('existing general-Coach hard rules are unchanged (sourcing, causation, no auto changes, max 3, purpose rules)', ['Use ONLY the supplied packet', 'Treat every source as a statistical ASSOCIATION, never as proof of causation', 'Never recommend an automatic database change', 'Every advice card must cite at least one source_id', 'Generate at most 3 advice_cards', '8. Never pressure the user to sell Personal-purpose inventory', '9. Treat Hybrid Purpose neutrally'].every((s) => ADVICE_SYSTEM_PROMPT.includes(s)));
    check('the general Coach is NOT forced to include a Listing Demand card', /do not force it when the evidence is thin/.test(ADVICE_SYSTEM_PROMPT) && /at most 3/.test(ADVICE_SYSTEM_PROMPT) && !/must include (a|one) (listing|demand)/i.test(ADVICE_SYSTEM_PROMPT));
  }

  console.log('\n[D — regression: the observed live Coach failure]');
  {
    const live = 'Low deal conversion may indicate issues with lead management or listing presentation.';
    check('the exact live sentence is flagged (conversion claim + unsupported gap explanation)', findLeadDealViolations(live).includes('CONVERSION_CLAIM') && findLeadDealViolations(live).includes('LEAD_DEAL_GAP_EXPLAINED'), findLeadDealViolations(live));
    for (const bad of [
      'Leads are not converting into sales at Marketplace.', 'High lead volume but a poor conversion rate.', 'The close rate is weak this month.', 'Leads are turning into deals at a low rate.',
      'Lead-to-sale conversion is low on Kijiji.', 'The gap between leads and deals indicates lead management problems.', 'Fewer deals from these leads is explained by poor follow-up.',
      'Listing presentation issues explain why leads did not become deals.',
    ]) check(`flagged: ${JSON.stringify(bad)}`, findLeadDealViolations(bad).length > 0, bad);
    for (const ok of [
      'Lead activity is high while realized deal activity is lower, but these are not directly linked.',
      'Reviewing offer history or follow-up may help determine whether there is an actionable issue.',
      'Marketplace recorded 23 attributed leads and 0 realized deals by recorded channel in the latest week.',
      'There is no canonical lead-to-deal linkage, so conversion cannot be calculated.',
      'Because leads and deals are not directly linked, this does not establish a conversion problem.',
      'Recorded response per exposure increased on Kijiji.',
    ]) check(`allowed: ${JSON.stringify(ok.slice(0, 70))}`, findLeadDealViolations(ok).length === 0, findLeadDealViolations(ok));

    const registry = [{ source_id: 'insight:X', source_type: 'deterministic_insight' as const, item_id: null, headline: 'h', summary: 's', confidence: null, key_metrics: {}, limitations: [] as string[] }];
    const coach = (advice: string, why = 'Because it matters.') => JSON.stringify({ schema_version: '1.0', run_summary: { headline: 'Summary', summary: 'Neutral summary.', source_ids: ['insight:X'] }, advice_cards: [{ advice_code: 'C1', advice_type: 'observation', priority: 'medium', headline: 'Listing demand', advice, why_it_matters: why, confidence_label: 'moderate', source_ids: ['insight:X'], limitations: [], item_id: null }], limitations: [] });
    const badCoach = validateAdviceResponse(coach(live), registry);
    check('the GENERAL Coach validator now rejects the live-failure response', !badCoach.valid && badCoach.reasons.some((r) => r.startsWith('LEAD_DEAL_')), badCoach.reasons);
    check('the general Coach validator accepts the correct side-by-side wording + a labelled check', validateAdviceResponse(coach('Lead activity is high while realized deal activity is lower, but these are not directly linked.', 'Reviewing offer history or follow-up may help determine whether there is an actionable issue.'), registry).valid);
    check('unrelated general-Coach advice is unaffected (no false positives)', validateAdviceResponse(coach('Consider reviewing the aged Business item before the next listing refresh.'), registry).valid);
    const badListing = validateListingAdviceResponse(respond([card({ summary: live })]), ids);
    check('Listing Advice validator rejects the same response', !badListing.valid && badListing.reasons.some((r) => r.startsWith('LEAD_DEAL_')), badListing.reasons);
    check('Listing Advice accepts factual side-by-side + a check', validateListingAdviceResponse(respond([card({ summary: 'Marketplace recorded 23 attributed leads and 0 realized deals by recorded channel in the latest week; these are not directly linked.', next_steps: ['If the gap persists, review offer history, pricing, and follow-up'], source_ids: ['demand:channel:1', 'demand:market_trend'] })]), ids).valid);
    check('Listing Advice rejects a conversion claim hidden in next_steps / limitations too', !validateListingAdviceResponse(respond([card({ next_steps: ['Improve the low conversion rate'] })]), ids).valid && !validateListingAdviceResponse(respond([card({ limitations: ['Leads are converting poorly'] })]), ids).valid);
  }

  console.log('\n[E — Listing Advice prompt]');
  {
    const p = LISTING_ADVICE_SYSTEM_PROMPT;
    check('scope: listing/demand evidence only — no acquisition/pattern/cash evidence mentioned', /ONLY their current listing and buyer-demand evidence/.test(p) && !/acquisition|pattern discovery|cash balance|Purpose review/i.test(p));
    check('0–3 cards, no padding, materially distinct, materiality by magnitude/persistence/exposure/data quality', /0 to 3 cards/.test(p) && /Do NOT pad/.test(p) && /materially distinct/.test(p) && /magnitude, persistence across the four weeks, exposure\/sample size, and data quality/.test(p));
    check('no scores / hot-cold / grades', /Do NOT invent scores or labels \(no hot\/cold, winner\/loser, grades\)/.test(p));
    check('cites only allowed source ids and never invents them', /Never invent a source id/.test(p) && /allowed_source_ids/.test(p));
    check('short cards with at most 3 next_steps', /at most 3 short next_steps/.test(p));
    check('type/priority/confidence vocabulary defined (action/observation/watch, high/medium/low, stronger..preliminary)', /"action"/.test(p) && /"observation"/.test(p) && /"watch"/.test(p) && /stronger\/moderate\/low\/preliminary/.test(p));
    check('no calculation of new metrics; comparisons of provided values allowed', /Do not calculate new metrics/.test(p) && /you may COMPARE provided values/.test(p));
    check('states Purpose is not in the packet (never infer, never pressure a sale)', /never infer or assume an item's Purpose/.test(p) && /never pressure the user to sell/.test(p));
    const oa = strip(read('src', 'lib', 'openai.ts'));
    check('reuses the existing OpenAI client (no second SDK/client) with a strict JSON schema of max 3 cards', (oa.match(/new OpenAI\(/g) ?? []).length === 1 && /name: 'listing_advice_v1'/.test(oa) && /strict: true/.test(oa) && /maxItems: 3/.test(oa));
    check('its own schema enums: type action|observation|watch; priority; confidence', /advice_type: \{ type: 'string', enum: \['action', 'observation', 'watch'\] \}/.test(oa) && /confidence_label: \{ type: 'string', enum: \['stronger', 'moderate', 'low', 'preliminary'\] \}/.test(oa));
    check('uses the existing configured model constant', /LISTING_ADVICE_MODEL_ID = MODEL_ID/.test(oa));

    check('selection: positive item demand is first-class evidence, strong item signals weighed with weak/zero-response ones', /positive item demand is first-class evidence/.test(p) && /materially strong item signals/.test(p) && /ALONGSIDE weak or zero-response signals/.test(p));
    check('selection: do not omit a clearly material positive item signal just because channel/market observations exist', /Do not omit a clearly material positive item signal merely because channel or market observations also exist/.test(p));
    check('selection: prefer 3 cards when 3 distinct useful signals exist; never filler; never force exactly 3', /prefer three cards/.test(p) && /Never add filler to reach three and never force exactly three/.test(p) && /return one or two/.test(p));
    check('wording: "buyer/lead response" instead of broad "channel performance"', /"buyer\/lead response"/.test(p) && /not as broad "channel performance"/.test(p));
    check('wording: high exposure + zero leads "warrants review"; must not assert a listing problem', /warrants review/.test(p) && /do NOT assert that the listing has a problem/.test(p));
    check('no-fake-conversion rules still composed in (shared blocks) and prompt version unchanged', p.includes(LEAD_DEAL_RULES) && p.includes(LISTING_DEMAND_SEMANTICS) && p.includes(PURPOSE_SEMANTICS) && LISTING_ADVICE_PROMPT_VERSION === 'listing-advice-v1');
  }

  console.log('\n[G — General Business Coach detail drawer (persisted evidence)]');
  {
    const src = (id: string, type: string) => ({ source_id: id, source_type: type, headline: `H ${id}`, summary: `S ${id}`, confidence: 'moderate', key_metrics: { count: 3, nested: { a: 1 } }, limitations: ['SRC_LIMIT'] });
    const insight = src('insight:x:item:77', 'deterministic_insight');
    const pattern = src('pattern:p1', 'confirmed_pattern');
    const hyp = src('hyp:h1', 'preliminary_hypothesis');
    const CP: any = {
      packet_version: '1.0', run: {}, deterministic_insights: [insight], confirmed_patterns: [pattern], preliminary_hypotheses: [hyp],
      pattern_selection_summary: null, listing_demand: PACKET.listing_demand,
      allowed_source_ids: ['insight:x:item:77', 'pattern:p1', 'hyp:h1', 'demand:item:55', 'demand:market_trend', 'demand:data_quality'],
    };
    const REG: any = [{ ...insight, item_id: 77 }, { ...pattern, item_id: null }, { ...hyp, item_id: null }];
    const cc = (o: Record<string, unknown> = {}): any => ({ advice_code: 'c', advice_type: 'action', priority: 'high', headline: 'Head', advice: 'Adv', why_it_matters: 'Why', confidence_label: 'moderate', source_ids: ['insight:x:item:77'], limitations: ['SMALL_SAMPLE'], item_id: null, ...o });

    const ev = resolveCoachCardEvidence(cc({ source_ids: ['insight:x:item:77', 'pattern:p1', 'hyp:h1', 'demand:item:55', 'demand:market_trend', 'gone:1'] }), CP, REG);
    check('resolves insight / pattern / hypothesis / demand sources from the persisted packet; unknown ids are dropped', ev.map((b) => b.kind).join() === 'insight,pattern,hypothesis,item,market', ev.map((b) => b.kind));
    check('insight evidence shows persisted headline/summary and scalar metrics only', ev[0].title === 'H insight:x:item:77' && ev[0].text === 'S insight:x:item:77' && ev[0].facts.length === 1 && ev[0].facts[0].value === '3');
    const tampered = JSON.parse(JSON.stringify(CP));
    tampered.listing_demand.items.highest_activity[0].item_attributed_leads = 999;
    tampered.deterministic_insights[0].headline = 'CHANGED';
    check('evidence follows the persisted packet it is given (demand + insight), never live data', resolveCoachEvidence('demand:item:55', tampered, REG)!.facts.find((f) => f.label === 'Attributed leads')!.value === '999' && resolveCoachEvidence('insight:x:item:77', tampered, REG)!.title === 'CHANGED');
    check('legacy revision without a packet falls back to the source_refs registry (demand sources unresolvable, not invented)', resolveCoachEvidence('pattern:p1', null, REG)!.title === 'H pattern:p1' && resolveCoachEvidence('demand:item:55', null, REG) === null);
    const lims = coachLimitations(cc({ source_ids: ['insight:x:item:77', 'demand:data_quality'], limitations: ['SMALL_SAMPLE', 'SMALL_SAMPLE'] }), CP, REG);
    check('limitations = card + cited-source limitations (humanized, deduped) + data-quality limitations when cited', lims.length === new Set(lims).size && lims.includes('Small sample') && lims.includes('Src limit') && lims.length >= 2 + new Set(PACKET.listing_demand.data_quality.limitations).size - 1, lims);
    check('uncited sources contribute no limitations', !coachLimitations(cc({ source_ids: ['pattern:p1'], limitations: [] }), CP, REG).some((l) => l === 'Small sample') && coachLimitations(cc({ source_ids: [], limitations: [] }), CP, REG).length === 0);
    const acts = coachActions(cc({ source_ids: ['insight:x:item:77', 'demand:item:55'] }), CP, REG, '/listings');
    check('actions: Open Item for cited items + View Leads from the cited demand source (deduped by href)', acts.filter((a) => a.kind === 'open_item').length === 2 && acts.some((a) => a.href === '/inventory/77') && acts.some((a) => a.href === '/inventory/55') && acts.some((a) => a.kind === 'view_leads' && /^\/leads\?/.test(a.href)) && new Set(acts.map((a) => a.href)).size === acts.length, acts);
    check('actions: nothing invented when sources are unsupported; card item_id still gives Open Item', coachActions(cc({ source_ids: ['pattern:p1'] }), CP, REG, '/listings').length === 0 && coachActions(cc({ item_id: 9, source_ids: ['pattern:p1'] }), null, REG, '/listings').map((a) => a.href).join() === '/inventory/9');
    const view = strip(read('src', 'lib', 'coachAdviceView.ts'));
    check('resolver is pure: no fetch/supabase/live-analytics access', !/fetch\(|supabase|rpc\(|loadListingDemandContext|getLatest/.test(view));

    const cardSrc = strip(read('src', 'components', 'AdviceCardView.tsx'));
    const drawer = strip(read('src', 'components', 'CoachAdviceDrawer.tsx'));
    const parts = strip(read('src', 'components', 'AdviceDrawerParts.tsx'));
    const lDrawer = strip(read('src', 'components', 'listings', 'ListingAdviceDrawer.tsx'));
    const dash = strip(read('src', 'app', 'page.tsx'));
    const ana = read('src', 'app', 'analytics', 'page.tsx');
    check('compact card gets a "View details" control (only when onViewDetails is passed)', /onViewDetails/.test(cardSrc) && /View details ›/.test(cardSrc));
    check('drawer: Advice, Why it matters, evidence, limitations, actions; reads the persisted revision', />Advice<\/h3>/.test(drawer) && /Why it matters/.test(drawer) && /EvidenceSection/.test(drawer) && /LimitationsSection/.test(drawer) && /ActionsSection/.test(drawer) && /input_packet: packet, source_refs: registry/.test(drawer));
    check('shell: right-side drawer on desktop, bottom sheet on mobile, dialog semantics, Escape, focus trap', /md:w-\[32rem\]/.test(parts) && /rounded-t-3xl/.test(parts) && /role="dialog"/.test(parts) && /aria-modal="true"/.test(parts) && /'Escape'/.test(parts) && /shiftKey/.test(parts));
    check('Listing Advice drawer reuses the shared shell (no duplicated dialog markup)', /AdviceDrawerShell/.test(lDrawer) && !/role="dialog"/.test(lDrawer));
    check('Dashboard: same dismiss handler + dismissedKeys drive the drawer (dismissal stays synchronized)', /onViewDetails=\{\(\) => setOpenAdviceCode/.test(dash) && /onDismiss=\{\(\) => handleDismissAdvice\(openAdviceCard\)\}/.test(dash) && /visibleAdviceCards\.find\(\(c\) => c\.advice_code === openAdviceCode\)/.test(dash) && /revision=\{latestCompletedAdvice\.advice\}/.test(dash));
    check('Analytics page not redesigned (does not use the drawer)', !/CoachAdviceDrawer|AdviceDrawerShell/.test(ana));
    check('drawer never fetches live data', !/fetch\(|supabase|useSwrResource/.test(drawer));
  }

  console.log('\n[F — persisted evidence + deterministic actions]');
  {
    const c55 = card({ advice_type: 'action', title: 'Review ES-335 offers', source_ids: ['demand:item:55'] }) as unknown as ListingAdviceCard;
    const ev = resolveCardEvidence(c55, PACKET);
    check('item evidence resolves from the PERSISTED packet with the packet\'s numbers', ev.length === 1 && ev[0].kind === 'item' && ev[0].facts.find((f) => f.label === 'Attributed leads')!.value === '21' && ev[0].facts.find((f) => f.label === 'Serious+')!.value === '12' && ev[0].facts.find((f) => f.label === 'Offers')!.value === '12' && ev[0].facts.find((f) => f.label === 'Channel-days')!.value === '48');
    const tampered = JSON.parse(JSON.stringify(PACKET));
    tampered.listing_demand.items.highest_activity[0].item_attributed_leads = 999;
    check('evidence follows the packet it is given (never a live re-query)', resolveEvidence(tampered, 'demand:item:55')!.facts.find((f) => f.label === 'Attributed leads')!.value === '999' && !/fetch|supabase|rpc|listingsCache/.test(strip(read('src', 'lib', 'listingAdviceView.ts'))));
    const chan = resolveEvidence(PACKET, 'demand:channel:2')!;
    check('channel evidence lists all 4 weeks (channel-days, leads, Serious+, rate, deals by recorded channel)', chan.weeks.length === 4 && /channel-days/.test(chan.weeks[0]) && /leads\/100 channel-days/.test(chan.weeks[0]) && /realized deals \(recorded channel\)/.test(chan.weeks[0]));
    check('market evidence lists 4 weeks; data-quality evidence lists attribution %', resolveEvidence(PACKET, 'demand:market_trend')!.weeks.length === 4 && resolveEvidence(PACKET, 'demand:data_quality')!.facts.some((f) => f.value === '90%'));
    check('unknown ids resolve to nothing', resolveEvidence(PACKET, 'demand:item:1') === null);
    check('data-quality limitations are added only when the card cites data quality', relevantLimitations(card({ limitations: ['x'], source_ids: ['demand:channel:1'] }) as unknown as ListingAdviceCard, PACKET).join() === 'x' && relevantLimitations(card({ source_ids: ['demand:data_quality'] }) as unknown as ListingAdviceCard, PACKET).length === PACKET.listing_demand.data_quality.limitations.length);

    const RT = '/listings?trend_weeks=8';
    const itemActions = adviceActions(c55, PACKET, RT);
    check('item card -> Open Item + View Leads', itemActions.map((a) => a.label).join() === 'Open Item,View Leads');
    check('Open Item goes to the existing inventory detail route', itemActions[0].href === '/inventory/55');
    check('item View Leads is EXACT: item_id + persisted 4-week from/to + item_attributed=1 + expected + safe return_to', itemActions[1].href === '/leads?item_id=55&from=2026-08-24&to=2026-09-20&item_attributed=1&expected=21&return_to=%2Flistings%3Ftrend_weeks%3D8', itemActions[1].href);
    const chanActions = adviceActions(card({ source_ids: ['demand:channel:2'] }) as unknown as ListingAdviceCard, PACKET, '/listings');
    const chanLeads = CTX.channels.find((c) => c.channel_id === 2)!.weeks.reduce((s, w) => s + w.channel_attributed_leads, 0);
    check('channel View Leads is EXACT: channel_id + persisted window + attributed=1 + return_to', chanActions.length === 1 && chanActions[0].href === `/leads?channel_id=2&from=2026-08-24&to=2026-09-20&attributed=1&expected=${chanLeads}&return_to=%2Flistings`, chanActions[0]?.href);
    const marketActions = adviceActions(card({ source_ids: ['demand:market_trend'] }) as unknown as ListingAdviceCard, PACKET, '/listings');
    check('market View Leads covers the whole persisted window', marketActions.length === 1 && marketActions[0].href.startsWith('/leads?from=2026-08-24&to=2026-09-20&expected='), marketActions[0]?.href);
    check('zero-lead item: Open Item only, no View Leads link', adviceActions(card({ source_ids: ['demand:item:70'] }) as unknown as ListingAdviceCard, PACKET, '/listings').map((a) => a.label).join() === 'Open Item');
    check('no action is ever a Deals drill-down; all hrefs are internal', [...itemActions, ...chanActions, ...marketActions].every((a) => a.href.startsWith('/') && !/deal/i.test(a.href)));
    check('actions carry no model-written URL (built only from source metadata + helpers)', /itemAttributedLeadsUrl|channelAttributedLeadsUrl|marketWeekLeadsUrl/.test(read('src', 'lib', 'listingAdviceView.ts')) && !/card\.(url|href|link)/.test(read('src', 'lib', 'listingAdviceView.ts')));
    const parsed = parseLeadFilters((k) => new URL(itemActions[1].href, 'http://x').searchParams.get(k));
    check('the URL parses back into the exact cohort filter with a safe return_to', parsed.itemId === 55 && parsed.itemAttributed && parsed.from === '2026-08-24' && parsed.to === '2026-09-20' && parsed.returnTo === RT);
    check('an unsafe return_to would be dropped on /leads (no open redirect)', parseLeadFilters((k) => new URL('/leads?return_to=https%3A%2F%2Fevil.example', 'http://x').searchParams.get(k)).returnTo === null);
    check('multi-source cards de-duplicate actions', adviceActions(card({ source_ids: ['demand:item:55', 'demand:item:55', 'demand:channel:2'] }) as unknown as ListingAdviceCard, PACKET, '/listings').length === 3);
  }

  console.log('\n[G — /listings UI: placement, states, layout, drawer]');
  {
    const page = strip(read('src', 'app', 'listings', 'page.tsx'));
    const at = (s: string) => page.indexOf(s);
    check('Listing Advice sits immediately after Overview and before Market Activity', at('<OverviewSection evidence') > 0 && at('<OverviewSection evidence') < at('<ListingAdviceSection') && at('<ListingAdviceSection') < at('<MarketActivitySection') && at('<MarketActivitySection') < at('<ChannelActivitySection') && at('<ChannelActivitySection') < at('<ItemActivitySection') && at('<ItemActivitySection') < at('<UnlistedSection evidence'));
    const gates = Array.from(read('src', 'app', 'listings', 'page.tsx').matchAll(/\{evidence && \(([\s\S]*?)\n {6}\)\}/g)).map((m) => m[1]).join('\n');
    check('Listing Advice is NOT inside a Listing Evidence gate (own state, never gates other sections)', !/ListingAdviceSection/.test(gates) && /<ListingAdviceSection returnTo=\{returnTo\}/.test(page));
    check('the page itself never generates advice (no generation call on load / import / listing change)', !/requestListingAdviceGeneration|generateListingAdvice/.test(page));
    const sec = strip(read('src', 'components', 'listings', 'ListingAdviceSection.tsx'));
    check('/listings is display-only for generation: no generation call, no Generate / Refresh controls anywhere in the section', !/requestListingAdviceGeneration|generateListingAdvice/.test(sec) && !/Generate Listing Advice|Refresh Advice/.test(sec) && !/data-advice-generate/.test(sec) && !/useEffect/.test(sec));
    check('no advice -> calm empty state (with an admin-only "Run Analytics" link to /analytics), never a generate button', sec.includes('No Listing Advice has been generated yet.') && /viewer_is_admin && \(\s*<Link href="\/analytics"[^>]*>Run Analytics<\/Link>/.test(sec));
    check('0 cards -> calm "No material listing advice for this window."', sec.includes('No material listing advice for this window.'));
    check('header shows Generated <date> and the 4-week demand window', /Generated \{formatGeneratedAt\(latest\.generated_at\)\}/.test(sec) && /4-week demand window: \{formatWindowLabel\(latest\.window_start, latest\.window_end\)\}/.test(sec));
    check('the latest completed persisted advice is what is shown (from the cached fetch); a new Analytics run is picked up on the next load', /const latest = data\?\.latest \?\? null/.test(sec) && /useSwrResource\(listingsCache, LISTING_ADVICE_KEY, fetchLatestListingAdvice\)/.test(sec) && !/setInterval|setTimeout|polling/i.test(sec));
    check('an admin sees a small note when the latest update failed, while the previous advice stays displayed', /data\?\.viewer_is_admin && data\.last_failure/.test(sec) && /the previous advice is shown/.test(sec));
    check('cards can be dismissed (Dismiss button per card; optimistic hide, persisted, rolled back on failure)', /data-advice-dismiss/.test(sec) && /dismissListingAdvice\(latest\.id, card\.advice_code\)/.test(sec) && /setHiddenKeys\(\(prev\) => prev\.filter/.test(sec) && /listingAdviceKey\(c\)/.test(sec));
    check('cards: desktop up to 3 columns, mobile stacked', /grid grid-cols-1 gap-3 lg:grid-cols-3/.test(sec) && (sec.match(/data-advice-card/g) ?? []).length === 1);
    check('each card shows type, title, short summary, priority + confidence badges (reused AdviceCardView badges)', /ADVICE_TYPE_LABEL\[card\.advice_type\]/.test(sec) && /card\.title/.test(sec) && /line-clamp-4/.test(sec) && /<PriorityBadge/.test(sec) && /<ConfidencePill/.test(sec));
    check('a card is a real button that opens the detail drawer', /<button[\s\S]{0,80}type="button"[\s\S]{0,60}data-advice-card[\s\S]{0,60}onClick=\{\(\) => setOpenCard\(card\)\}/.test(sec) && /<ListingAdviceDrawer/.test(sec));
    check('load failure is local: "Listing Advice is unavailable right now." + Retry; nothing else is affected', /Listing Advice is unavailable right now\./.test(sec) && /Retry/.test(sec));
    check('uses the shared SWR cache with key listing-advice:latest', /useSwrResource\(listingsCache, LISTING_ADVICE_KEY/.test(sec) && LISTING_ADVICE_KEY === 'listing-advice:latest');

    const dr = strip(read('src', 'components', 'listings', 'ListingAdviceDrawer.tsx')) + strip(read('src', 'components', 'AdviceDrawerParts.tsx'));
    check('drawer: right-side on desktop, bottom sheet on mobile, accessible dialog', /md:w-\[32rem\]/.test(dr) && /rounded-t-3xl/.test(dr) && /role="dialog"/.test(dr) && /aria-modal="true"/.test(dr) && /Escape/.test(dr));
    check('drawer sections: Advice (summary/why it matters/suggested checks), Evidence, Limitations, Actions', /Why it matters/.test(dr) && /Suggested checks/.test(dr) && /Evidence the advice was based on/.test(dr) && /Limitations/.test(dr) && /Actions/.test(dr));
    check('drawer evidence comes from the persisted packet (run.input_packet) via resolveCardEvidence', /const packet = run\.input_packet/.test(dr) && /resolveCardEvidence\(card, packet\)/.test(dr) && !/fetch\(|supabase/.test(dr));
    check('drawer actions come from adviceActions (View Leads / Open Item), no Deals action', /adviceActions\(card, packet, returnTo\)/.test(dr) && !/Deals/.test(dr));
    check('debug/audit (model, prompt version, input hash, cited ids, copy packet) only for admins and collapsed', /showDebug &&/.test(dr) && /<details/.test(dr) && /Copy input packet/.test(dr) && /run\.input_hash/.test(dr) && /run\.prompt_version/.test(dr) && /card\.source_ids\.join/.test(dr) && /showDebug=\{!!data\?\.viewer_is_admin\}/.test(sec));
    const layout = read('src', 'app', 'layout.tsx');
    check('no new navigation item (nav still Dashboard/Inventory/Listings/Operations)', (layout.match(/<nav[\s\S]*?<\/nav>/g) ?? []).every((nav) => JSON.stringify((nav.match(/>([^<]+)<\/a>/g) ?? []).map((m) => m.slice(1, -4).trim())) === JSON.stringify(['Dashboard', 'Inventory', 'Listings', 'Operations'])));
  }

  console.log('\n[H — cache independence & failure isolation]');
  {
    const cache = createSwrCache();
    const inv = createListingsInvalidators(cache);
    await cache.load(LISTING_ADVICE_KEY, async () => 'advice');
    await cache.load(LISTING_EVIDENCE_KEY, async () => 'evidence');
    await cache.load(listingDemandKey(4, '2026-09-14', '2026-09-20'), async () => 'demand');
    inv.invalidateListingsCache();
    check('invalidating the Listings evidence caches never touches the advice cache', cache.status(LISTING_ADVICE_KEY) === 'fresh' && cache.status(LISTING_EVIDENCE_KEY) === 'stale');
    inv.invalidateListingAdviceCache();
    check('advice cache can be invalidated independently', cache.status(LISTING_ADVICE_KEY) === 'stale' && cache.peek(LISTING_ADVICE_KEY)?.data === 'advice');
    const route = strip(read('src', 'app', 'api', 'listing-advice', 'route.ts'));
    check('the API is read-only: GET through the caller\'s own RLS client, NO POST/generation handler', /getLatestListingAdvice\(db, appUser\.id as number\)/.test(route) && !/export async function POST/.test(route) && !/serviceClient|SERVICE_ROLE/.test(route) && !/generateListingAdvice\(/.test(route));
    check('the browser never calls the model (client only hits /api/listing-advice)', !/openai/i.test(read('src', 'lib', 'analytics', 'listingAdvice', 'listingAdviceClient.ts')));
    const gen = strip(read('src', 'lib', 'analytics', 'listingAdvice', 'generateListingAdvice.ts'));
    check('a failed generation never replaces the latest completed advice (latest = newest COMPLETED only)', /\.eq\('status', 'completed'\)[\s\S]*?\.order\('generated_at'/.test(gen));
    check('/listings sections other than advice never import the advice modules', !/listingAdvice/.test(strip(read('src', 'app', 'listings', 'page.tsx')).replace(/ListingAdviceSection/g, '')));
    check('per-user language is NOT implemented (text persisted exactly as returned; no locale plumbing)', !/locale|language|translate/i.test(gen + strip(read('src', 'components', 'listings', 'ListingAdviceSection.tsx'))));
    check('no lead->deal linkage added anywhere in this change', !/lead_deal|deal_leads|item_lead_deals/i.test(read('supabase', 'migrations', '20260920000000_listing_advice_runs.sql')));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
