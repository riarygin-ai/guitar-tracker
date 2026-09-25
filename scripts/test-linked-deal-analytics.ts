/**
 * test-linked-deal-analytics.ts
 *
 * Deterministic Lead -> Deal linkage analytics (linkedDealAnalytics.ts): the
 * pure metrics/context builders, the citable-source builder, its integration
 * into buildAdviceInputPacket, the conditional conversion-claim guard in
 * validateAdviceResponse.ts (conversion allowed ONLY when citing a
 * linked_deal:* source; the old raw leads-vs-realized-deals comparison and
 * Listing Advice both still always reject it), and (real local DB) the
 * server loader against real item_leads/deals/deal_channels fixtures.
 *
 * Usage:  npx tsx scripts/test-linked-deal-analytics.ts
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import {
  LINKED_DEAL_ANALYTICS_LIMITATIONS, LINKED_DEAL_ANALYTICS_VERSION,
  buildLinkedDealAnalyticsContext, buildLinkedDealAnalyticsSources, computeLinkedDealMetrics,
  loadLinkedDealAnalyticsContext, type LinkedDealLeadInput,
} from '../src/lib/analytics/advice/linkedDealAnalytics';
import { buildAdviceInputPacket } from '../src/lib/analytics/advice/buildInputPacket';
import { validateAdviceResponse } from '../src/lib/analytics/advice/validateAdviceResponse';
import { PROMPT_TEMPLATE_VERSION, type SourceRegistryEntry } from '../src/lib/analytics/advice/types';
import { LEAD_DEAL_RULES } from '../src/lib/analytics/advice/sharedSemantics';
import { ADVICE_SYSTEM_PROMPT, LISTING_ADVICE_SYSTEM_PROMPT } from '../src/lib/openai';
import { validateListingAdviceResponse } from '../src/lib/analytics/listingAdvice/listingAdvice';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}

// ── Fixtures (pure) ─────────────────────────────────────────────────────────

function lead(over: Partial<LinkedDealLeadInput>): LinkedDealLeadInput {
  return {
    status: 'OPEN', lead_quality: 'LOW', offer_type: 'NONE', deal_id: null, deal_channel_id: null, first_contact_at: null,
    ...over,
  };
}

async function main() {
  console.log('\n[A — computeLinkedDealMetrics: coverage, rates, distinct-deal counting, median days]');
  {
    const leads: LinkedDealLeadInput[] = [
      // 4 COMPLETED leads: 3 linked (2 distinct deals — one deal realizes 2 leads' items), 1 unlinked (historical, not yet backfilled).
      lead({ status: 'COMPLETED', deal_id: 100, lead_quality: 'HIGH_INTENT', offer_type: 'CASH', first_contact_at: '2026-01-01' }),
      lead({ status: 'COMPLETED', deal_id: 100, lead_quality: 'SERIOUS', offer_type: 'TRADE', first_contact_at: '2026-01-05' }),
      lead({ status: 'COMPLETED', deal_id: 200, lead_quality: 'ENGAGED', offer_type: 'MIXED', first_contact_at: '2026-01-10' }),
      lead({ status: 'COMPLETED', deal_id: null, lead_quality: 'LOW', offer_type: 'NONE' }), // historical, unlinked
      // 2 still-OPEN leads, unlinked (as OPEN leads always are — deal_id requires COMPLETED).
      lead({ status: 'OPEN', deal_id: null, lead_quality: 'ENGAGED', offer_type: 'NONE' }),
      lead({ status: 'GHOSTED', deal_id: null, lead_quality: 'LOW', offer_type: 'NONE' }),
    ];
    const dealDates = new Map([[100, '2026-01-08'], [200, '2026-01-20']]);
    const m = computeLinkedDealMetrics(leads, dealDates);

    check('total_leads counts every lead', m.total_leads === 6);
    check('linked_leads counts only leads with deal_id set', m.linked_leads === 3);
    check('distinct_linked_deals uses COUNT(DISTINCT deal_id) — deal 100 realizes 2 leads but counts once', m.distinct_linked_deals === 2);
    check('completed_leads counts every COMPLETED lead regardless of linkage', m.completed_leads === 4);
    check('completed_leads_with_deal_id excludes the unlinked historical COMPLETED lead', m.completed_leads_with_deal_id === 3);
    check('completed_link_coverage_pct = 3/4 = 75.0', m.completed_link_coverage_pct === 75);
    check('linked_deal_rate_to_date_pct = 3/6 = 50.0 (observed linked deal rate to date)', m.linked_deal_rate_to_date_pct === 50);
    check('serious_plus_lead_count = HIGH_INTENT + SERIOUS = 2', m.serious_plus_lead_count === 2);
    check('serious_plus_leads_with_deal_id = both are linked = 2', m.serious_plus_leads_with_deal_id === 2);
    check('serious_plus_linked_deal_rate_to_date_pct = 2/2 = 100.0', m.serious_plus_linked_deal_rate_to_date_pct === 100);
    check('offer_lead_count = CASH + TRADE + MIXED = 3', m.offer_lead_count === 3);
    check('offer_leads_with_deal_id = all 3 offer leads are linked = 3', m.offer_leads_with_deal_id === 3);
    check('offer_linked_deal_rate_to_date_pct = 3/3 = 100.0', m.offer_linked_deal_rate_to_date_pct === 100);
    // days: (2026-01-08 - 2026-01-01)=7, (2026-01-08 - 2026-01-05)=3, (2026-01-20 - 2026-01-10)=10 -> sorted [3,7,10] -> median 7
    check('median_days_first_contact_to_deal_date is the median of the 3 linked leads\' day-diffs (3, 7, 10 -> 7)', m.median_days_first_contact_to_deal_date === 7, m.median_days_first_contact_to_deal_date);

    const empty = computeLinkedDealMetrics([], new Map());
    check('an empty cohort never divides by zero: every rate is null, counts are 0', empty.total_leads === 0 && empty.completed_link_coverage_pct === null && empty.linked_deal_rate_to_date_pct === null && empty.serious_plus_linked_deal_rate_to_date_pct === null && empty.offer_linked_deal_rate_to_date_pct === null && empty.median_days_first_contact_to_deal_date === null);

    const noneLinked = computeLinkedDealMetrics([lead({ status: 'OPEN' }), lead({ status: 'COMPLETED', deal_id: null })], new Map());
    check('historical COMPLETED without deal_id lowers coverage to 0% but is never treated as a "failed conversion" value (still a plain 0/1, not a special flag)', noneLinked.completed_link_coverage_pct === 0 && noneLinked.linked_leads === 0);

    const evenCount = computeLinkedDealMetrics([
      lead({ status: 'COMPLETED', deal_id: 1, first_contact_at: '2026-01-01' }),
      lead({ status: 'COMPLETED', deal_id: 2, first_contact_at: '2026-01-01' }),
    ], new Map([[1, '2026-01-05'], [2, '2026-01-11']]));
    check('median of an even count averages the two middle values ((4+10)/2 = 7)', evenCount.median_days_first_contact_to_deal_date === 7, evenCount.median_days_first_contact_to_deal_date);

    const missingDealDate = computeLinkedDealMetrics([lead({ status: 'COMPLETED', deal_id: 999, first_contact_at: '2026-01-01' })], new Map());
    check('a linked lead whose deal_id has no resolvable deal_date contributes nothing to the median (never guessed)', missingDealDate.median_days_first_contact_to_deal_date === null);
  }

  console.log('\n[B — buildLinkedDealAnalyticsContext: channel breakdown]');
  {
    const leads: LinkedDealLeadInput[] = [
      lead({ status: 'COMPLETED', deal_id: 1, deal_channel_id: 10, first_contact_at: '2026-01-01' }),
      lead({ status: 'COMPLETED', deal_id: null, deal_channel_id: 10 }),
      lead({ status: 'OPEN', deal_channel_id: 20 }),
      lead({ status: 'COMPLETED', deal_id: 2, deal_channel_id: null, first_contact_at: '2026-01-01' }), // no normalized channel -> "Other"
    ];
    const dealDates = new Map([[1, '2026-01-05'], [2, '2026-01-05']]);
    const channelNames = new Map([[10, 'Marketplace'], [20, 'Kijiji']]);
    const ctx = buildLinkedDealAnalyticsContext(leads, dealDates, channelNames);

    check('context_version is set', ctx.context_version === LINKED_DEAL_ANALYTICS_VERSION);
    check('overall aggregates every lead regardless of channel', ctx.overall.total_leads === 4 && ctx.overall.linked_leads === 2);
    check('by_channel has one row per canonical channel PLUS an "Other" bucket for no normalized channel', ctx.by_channel.length === 3);
    const marketplace = ctx.by_channel.find((c) => c.channel_id === 10)!;
    check('Marketplace channel breakdown: 2 leads, 1 linked', marketplace.total_leads === 2 && marketplace.linked_leads === 1);
    const kijiji = ctx.by_channel.find((c) => c.channel_id === 20)!;
    check('Kijiji channel breakdown: 1 lead, 0 linked', kijiji.total_leads === 1 && kijiji.linked_leads === 0);
    const other = ctx.by_channel.find((c) => c.channel_id === null)!;
    check('"Other" bucket collects leads with no normalized channel', other.total_leads === 1 && other.linked_leads === 1 && other.channel_name.length > 0);
    check('channel rows are ordered deterministically (most leads first)', ctx.by_channel[0].total_leads >= ctx.by_channel[1].total_leads && ctx.by_channel[1].total_leads >= ctx.by_channel[2].total_leads);
    check('the fixed limitations are always present, including the exact required sentence', ctx.limitations.length === LINKED_DEAL_ANALYTICS_LIMITATIONS.length && ctx.limitations.some((l) => l.includes('Historical completed leads may not yet have deal_id backfilled')));
    check('the required "to date" / "observed conversion to date" framing exists in the fixed limitations', ctx.limitations.some((l) => /to date/i.test(l)));
    check('no profit/value attribution field exists anywhere in the context (out of scope)', !JSON.stringify(ctx).match(/["_]profit|realized_gain|["_]roi["_]/i), JSON.stringify(ctx));
  }

  console.log('\n[C — buildLinkedDealAnalyticsSources: citable ids, key_metrics, limitations only on overall]');
  {
    const leads: LinkedDealLeadInput[] = [lead({ status: 'COMPLETED', deal_id: 1, deal_channel_id: 10, first_contact_at: '2026-01-01' })];
    const ctx = buildLinkedDealAnalyticsContext(leads, new Map([[1, '2026-01-05']]), new Map([[10, 'Marketplace']]));
    const sources = buildLinkedDealAnalyticsSources(ctx);

    check('exactly one overall source + one per channel row', sources.length === 1 + ctx.by_channel.length);
    check('overall source id is "linked_deal:overall"', sources[0].source_id === 'linked_deal:overall');
    check('every source id is prefixed "linked_deal:" (distinguishable from demand:* and insight:*)', sources.every((s) => s.source_id.startsWith('linked_deal:')));
    check('every source has item_id null (cohort/channel aggregate, never a single item)', sources.every((s) => s.item_id === null));
    check('overall carries the module\'s limitations; channel rows carry none of their own (no duplication)', sources[0].limitations.length > 0 && sources.slice(1).every((s) => s.limitations.length === 0));
    check('key_metrics never includes the source_id/channel_name/channel_id redundantly as a metric on the overall row', !('source_id' in sources[0].key_metrics));
    const channelSource = sources.find((s) => s.source_id.includes('channel'))!;
    check('a channel source carries channel_id in key_metrics for traceability', 'channel_id' in channelSource.key_metrics);
  }

  console.log('\n[D — buildAdviceInputPacket integration]');
  {
    const snapshot = {
      generated_at: '2026-09-25T00:00:00Z',
      insights: { insights_engine_version: 'x', findings_selector_version: 'y', selected_findings: [{ finding_code: 'OPEN_INVENTORY_PRIORITY', headline: 'H', summary: 'S', confidence: null, metrics: {}, limitations: [], segment: { item_id: 7 } }] },
    };
    const linkedCtx = buildLinkedDealAnalyticsContext(
      [lead({ status: 'COMPLETED', deal_id: 1, deal_channel_id: 10, first_contact_at: '2026-01-01' })],
      new Map([[1, '2026-01-05']]),
      new Map([[10, 'Marketplace']]),
    );
    const withLinked = buildAdviceInputPacket({ runId: 1, analyticsVersion: '2.13', evidenceScope: 'scope', snapshot, linkedDealAnalytics: linkedCtx });
    const without = buildAdviceInputPacket({ runId: 1, analyticsVersion: '2.13', evidenceScope: 'scope', snapshot });

    check('packet carries linked_deal_analytics only when supplied', 'linked_deal_analytics' in withLinked.packet! && !('linked_deal_analytics' in without.packet!));
    check('allowed_source_ids includes every linked_deal:* source id', buildLinkedDealAnalyticsSources(linkedCtx).every((s) => withLinked.packet!.allowed_source_ids.includes(s.source_id)));
    check('the source registry carries linked_deal_analytics-typed entries', withLinked.sourceRegistry.some((s) => s.source_type === 'linked_deal_analytics'));
    check('registry entries for linked_deal sources carry item_id null', withLinked.sourceRegistry.filter((s) => s.source_type === 'linked_deal_analytics').every((s) => s.item_id === null));
    check('omitting linked_deal_analytics never makes an otherwise evidence-less run generatable (existing behavior preserved)', buildAdviceInputPacket({ runId: 1, analyticsVersion: '2.13', evidenceScope: 'scope', snapshot: { generated_at: 'x' }, linkedDealAnalytics: linkedCtx }).packet === null);
    check('linked_deal_analytics participates in the packet (present in JSON) so it is part of the canonical hash', JSON.stringify(withLinked.packet).includes('linked_deal_analytics') && !JSON.stringify(without.packet).includes('linked_deal_analytics'));
  }

  console.log('\n[E — validateAdviceResponse: conversion claims allowed ONLY from cited linked_deal:* evidence]');
  {
    const linkedSourceId = 'linked_deal:overall';
    const unrelatedSourceId = 'insight:X:item:1';
    const registry: SourceRegistryEntry[] = [
      { source_id: linkedSourceId, source_type: 'linked_deal_analytics', item_id: null, headline: 'H', summary: 'S', confidence: null, key_metrics: {}, limitations: [] },
      { source_id: unrelatedSourceId, source_type: 'deterministic_insight', item_id: 1, headline: 'H', summary: 'S', confidence: null, key_metrics: {}, limitations: [] },
    ];
    const card = (over: Record<string, unknown>) => ({
      advice_code: 'C1', advice_type: 'observation', priority: 'medium', headline: 'H', advice: 'A',
      why_it_matters: 'W', confidence_label: 'moderate', source_ids: [unrelatedSourceId], limitations: [], item_id: null,
      ...over,
    });
    const respond = (c: Record<string, unknown>, runSummarySourceIds: string[] = []) => JSON.stringify({
      schema_version: '1.0',
      run_summary: { headline: 'H', summary: 'S', source_ids: runSummarySourceIds },
      advice_cards: [c],
      limitations: [],
    });

    const noEvidence = validateAdviceResponse(respond(card({ advice: 'This item has a 40% conversion rate.' })), registry);
    check('E1: a conversion claim with NO linked_deal:* citation is rejected — same as before', !noEvidence.valid && noEvidence.reasons.includes('LEAD_DEAL_CONVERSION_CLAIM'), noEvidence.reasons);

    const rawComparisonClaim = validateAdviceResponse(respond(card({ advice: 'Leads are converting poorly this month based on realized deal counts.' })), registry);
    check('E2: the OLD raw leads-vs-realized-deals framing still cannot be called conversion (no linked_deal citation exists to excuse it)', !rawComparisonClaim.valid && rawComparisonClaim.reasons.includes('LEAD_DEAL_CONVERSION_CLAIM'));

    const withEvidence = validateAdviceResponse(respond(card({ advice: 'The linked deal rate to date is 40% based on explicitly linked leads.', source_ids: [unrelatedSourceId, linkedSourceId] })), registry);
    check('E3: the SAME conversion claim is accepted when the card cites a linked_deal:* source', withEvidence.valid, withEvidence.reasons);

    const runSummaryEvidence = validateAdviceResponse(
      JSON.stringify({ schema_version: '1.0', run_summary: { headline: 'Conversion to date improved.', summary: 'Observed conversion to date rose this quarter.', source_ids: [linkedSourceId] }, advice_cards: [card({})], limitations: [] }),
      registry,
    );
    check('E4: a conversion claim in run_summary is likewise excused by its OWN source_ids citing linked_deal:*', runSummaryEvidence.valid, runSummaryEvidence.reasons);

    const runSummaryNoEvidence = validateAdviceResponse(
      JSON.stringify({ schema_version: '1.0', run_summary: { headline: 'Conversion rate is low.', summary: 'S', source_ids: [] }, advice_cards: [card({})], limitations: [] }),
      registry,
    );
    check('E5: a conversion claim in run_summary is rejected without its own linked_deal:* citation (a card citing it does not excuse the summary)', !runSummaryNoEvidence.valid && runSummaryNoEvidence.reasons.includes('LEAD_DEAL_CONVERSION_CLAIM'));

    const gapExplained = validateAdviceResponse(respond(card({ advice: 'Leads were high while deals were low, and the gap indicates poor follow-up.', source_ids: [unrelatedSourceId, linkedSourceId] })), registry);
    check('E6: LEAD_DEAL_GAP_EXPLAINED stays unconditionally rejected even WITH a linked_deal citation — linkage never licenses inventing a cause', !gapExplained.valid && gapExplained.reasons.includes('LEAD_DEAL_LEAD_DEAL_GAP_EXPLAINED'));

    const disclaimerOnly = validateAdviceResponse(respond(card({ advice: 'No lead-to-deal conversion can be calculated from this evidence alone.' })), registry);
    check('E7: a bare disclaimer (no positive conversion claim) still passes with no citation needed, exactly as before', disclaimerOnly.valid, disclaimerOnly.reasons);

    const limitationConversionClaim = validateAdviceResponse(
      JSON.stringify({ schema_version: '1.0', run_summary: { headline: 'H', summary: 'S', source_ids: [linkedSourceId] }, advice_cards: [card({ source_ids: [unrelatedSourceId, linkedSourceId] })], limitations: ['Conversion rate is strong across the board.'] }),
      registry,
    );
    check('E8: top-level response.limitations gets no citation credit from any card/run_summary — a conversion claim there is always rejected', !limitationConversionClaim.valid && limitationConversionClaim.reasons.includes('LEAD_DEAL_CONVERSION_CLAIM'));
  }

  console.log('\n[F — prompt text: Coach can cite linked evidence; Listing Advice never can]');
  {
    check('LEAD_DEAL_RULES states canonical linkage exists only where item_leads.deal_id is populated', /Canonical Lead -> Deal linkage exists ONLY where item_leads\.deal_id is populated/.test(LEAD_DEAL_RULES));
    check('LEAD_DEAL_RULES: a conversion claim may ONLY be made by citing linked_deal_analytics evidence', /A conversion,.*may ONLY be made by explicitly citing linked_deal_analytics evidence/.test(LEAD_DEAL_RULES));
    check('LEAD_DEAL_RULES: linkage coverage must be considered before any rate is stated', /completed_link_coverage_pct/.test(LEAD_DEAL_RULES) && /INCOMPLETE LINKAGE, never a failed conversion/.test(LEAD_DEAL_RULES));
    check('LEAD_DEAL_RULES: recent/open cohorts must say "to date", never final', /linked deal rate to date.*observed conversion to date/.test(LEAD_DEAL_RULES) || (/linked deal rate to date/.test(LEAD_DEAL_RULES) && /observed conversion to date/.test(LEAD_DEAL_RULES)));
    check('LEAD_DEAL_RULES: the OLD raw-leads-vs-realized-deals rule is preserved verbatim (still forbids computing realized_deals / leads)', /Do not calculate realized_deals \/ leads/.test(LEAD_DEAL_RULES));
    check('LEAD_DEAL_RULES: never state a lead "did not convert" merely because it has no deal_id', /Never claim a lead "did not convert" merely because it has no deal_id/.test(LEAD_DEAL_RULES));
    check('the general Coach system prompt includes the updated LEAD_DEAL_RULES verbatim', ADVICE_SYSTEM_PROMPT.includes(LEAD_DEAL_RULES));
    check('the Listing Advice system prompt ALSO includes the updated LEAD_DEAL_RULES verbatim (one shared copy)', LISTING_ADVICE_SYSTEM_PROMPT.includes(LEAD_DEAL_RULES));
    check('prompt template version was bumped for this change (v3)', PROMPT_TEMPLATE_VERSION === 'analytics-advice-v3');

    // Listing Advice's OWN packet/validator never has linked_deal evidence to cite, so its guard must stay unconditional.
    const laRegistry = ['demand:market_trend'];
    const laCard = (over: Record<string, unknown>) => ({
      advice_code: 'L1', advice_type: 'observation', priority: 'medium', confidence_label: 'moderate', title: 'T', summary: 'The conversion rate is strong across the board.',
      why_it_matters: 'W', next_steps: [], source_ids: ['demand:market_trend'], limitations: [],
      ...over,
    });
    const laResult = validateListingAdviceResponse(JSON.stringify({ schema_version: '1.0', cards: [laCard({})] }), laRegistry);
    check('Listing Advice still rejects ANY conversion claim outright — it has no linked_deal:* source to ever cite', !laResult.valid, laResult.reasons);
  }

  // ── Real DB: server loader ────────────────────────────────────────────────
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const PASSWORD = 'Linked-Deal-Analytics-Fixture-Local-1!';
  async function ensureAuthUser(email: string): Promise<string> {
    const { data: created, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    if (!error && created.user) return created.user.id;
    const { data: listed } = await admin.auth.admin.listUsers({ perPage: 200 });
    const match = listed?.users.find((u) => u.email === email);
    if (match) return match.id;
    throw new Error(`Could not create or find auth user ${email}: ${error?.message}`);
  }
  async function resolveAppUserId(authUserId: string): Promise<number> {
    for (let i = 0; i < 10; i++) {
      const { data } = await admin.from('app_users').select('id').eq('auth_user_id', authUserId).maybeSingle();
      if (data) return data.id as number;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('app_users row never appeared');
  }
  async function ensureBrand(name: string): Promise<number> {
    const { data: existing } = await admin.from('brands').select('id').eq('name', name).maybeSingle();
    if (existing) return existing.id as number;
    const { data, error } = await admin.from('brands').insert({ name }).select('id').single();
    if (error) throw error;
    return data.id as number;
  }
  async function ensureItem(userId: number, brandId: number, tag: string): Promise<number> {
    const { data: existing } = await admin.from('inventory_items').select('id').eq('serial_number', tag).maybeSingle();
    if (existing) return existing.id as number;
    const { data, error } = await admin.from('inventory_items').insert({ user_id: userId, brand_id: brandId, model: tag, serial_number: tag, status: 'owned' }).select('id').single();
    if (error) throw error;
    return data.id as number;
  }
  async function ensureSource(userId: number, spreadsheetId: string): Promise<number> {
    const { data, error } = await admin.from('lead_import_sources')
      .upsert({ user_id: userId, source_code: 'GT_LEAD_LOG', provider: 'GOOGLE_SHEETS', source_name: 'fixture', spreadsheet_id: spreadsheetId, sheet_name: 'Leads', is_enabled: true }, { onConflict: 'user_id,source_code' })
      .select('id').single();
    if (error) throw error;
    return data.id as number;
  }
  async function ensureDeal(userId: number, dealType: string, dealDate: string, tag: string): Promise<number> {
    const { data: existing } = await admin.from('deals').select('id').eq('notes', tag).maybeSingle();
    if (existing) return existing.id as number;
    const { data, error } = await admin.from('deals').insert({ user_id: userId, deal_type: dealType, deal_date: dealDate, notes: tag }).select('id').single();
    if (error) throw error;
    return data.id as number;
  }
  async function ensureDealItem(userId: number, dealId: number, itemId: number, direction: 'in' | 'out'): Promise<void> {
    const { data: existing } = await admin.from('deal_items').select('id').eq('deal_id', dealId).eq('item_id', itemId).eq('direction', direction).maybeSingle();
    if (existing) return;
    const { error } = await admin.from('deal_items').insert({ user_id: userId, deal_id: dealId, item_id: itemId, direction });
    if (error) throw error;
  }
  let randomUuidCounter = 0;
  function randomUuid(): string {
    randomUuidCounter++;
    return `aaaaaaaa-bbbb-4ccc-8ddd-${String(randomUuidCounter).padStart(12, '0')}`;
  }

  const createdItemLeadIds: number[] = [];
  async function insertLead(row: Record<string, unknown>): Promise<number> {
    const { data, error } = await admin.from('item_leads').insert(row).select('id').single();
    if (error) throw new Error(`insertLead failed: ${error.message}`);
    createdItemLeadIds.push(data.id as number);
    return data.id as number;
  }

  try {
    console.log('\n[G — server loader (real local DB)]');
    const emailA = 'linked-deal-analytics-fixture-a@example.test';
    const emailB = 'linked-deal-analytics-fixture-b@example.test';
    const userA = await resolveAppUserId(await ensureAuthUser(emailA));
    const userB = await resolveAppUserId(await ensureAuthUser(emailB));
    const brandId = await ensureBrand('LinkedDealAnalyticsTestBrand');
    const itemA1 = await ensureItem(userA, brandId, 'LDA:userA:item1');
    const itemA2 = await ensureItem(userA, brandId, 'LDA:userA:item2');
    const itemB1 = await ensureItem(userB, brandId, 'LDA:userB:item1');
    const sourceA = await ensureSource(userA, 'lda-fixture-a');
    const sourceB = await ensureSource(userB, 'lda-fixture-b');

    const { data: marketplace } = await admin.from('deal_channels').select('id').eq('name', 'Marketplace').single();
    const { data: kijiji } = await admin.from('deal_channels').select('id').eq('name', 'Kijiji').single();
    const marketplaceId = marketplace!.id as number;
    const kijijiId = kijiji!.id as number;

    const dealMultiItem = await ensureDeal(userA, 'sale', '2026-02-10', 'LDA:dealMultiItem');
    await ensureDealItem(userA, dealMultiItem, itemA1, 'out');
    await ensureDealItem(userA, dealMultiItem, itemA2, 'out');
    const dealB = await ensureDeal(userB, 'sale', '2026-02-15', 'LDA:dealB');
    await ensureDealItem(userB, dealB, itemB1, 'out');

    await insertLead({ user_id: userA, source_id: sourceA, inventory_item_id: itemA1, lead_id: randomUuid(), first_contact_at: '2026-02-01', deal_channel_id: marketplaceId, lead_quality: 'HIGH_INTENT', offer_type: 'CASH', status: 'COMPLETED', deal_id: dealMultiItem, source_updated_at: '2026-02-10T00:00:00Z' });
    await insertLead({ user_id: userA, source_id: sourceA, inventory_item_id: itemA2, lead_id: randomUuid(), first_contact_at: '2026-02-03', deal_channel_id: marketplaceId, lead_quality: 'SERIOUS', offer_type: 'TRADE', cash_component: 0, status: 'COMPLETED', deal_id: dealMultiItem, source_updated_at: '2026-02-10T00:00:00Z' });
    await insertLead({ user_id: userA, source_id: sourceA, inventory_item_id: itemA1, lead_id: randomUuid(), first_contact_at: '2026-01-01', deal_channel_id: kijijiId, lead_quality: 'ENGAGED', offer_type: 'NONE', status: 'COMPLETED', deal_id: null, source_updated_at: '2026-01-01T00:00:00Z' });
    await insertLead({ user_id: userA, source_id: sourceA, inventory_item_id: itemA1, lead_id: randomUuid(), first_contact_at: '2026-02-20', deal_channel_id: null, lead_quality: 'LOW', offer_type: 'NONE', status: 'OPEN', deal_id: null, source_updated_at: '2026-02-20T00:00:00Z' });
    await insertLead({ user_id: userB, source_id: sourceB, inventory_item_id: itemB1, lead_id: randomUuid(), first_contact_at: '2026-02-01', deal_channel_id: marketplaceId, lead_quality: 'HIGH_INTENT', offer_type: 'CASH', status: 'COMPLETED', deal_id: dealB, source_updated_at: '2026-02-15T00:00:00Z' });

    const ctxA = await loadLinkedDealAnalyticsContext({ appUserId: userA, serviceClient: admin });
    check('G1: user A sees exactly their own 4 leads', ctxA.overall.total_leads === 4, ctxA.overall);
    check('G2: 2 linked leads (the two COMPLETED rows on the multi-item deal)', ctxA.overall.linked_leads === 2);
    check('G3: distinct_linked_deals = 1 — the SAME deal_id realizing two different items counts once (COUNT DISTINCT)', ctxA.overall.distinct_linked_deals === 1);
    check('G4: completed_leads = 3 (2 linked + 1 historical unlinked), coverage = 2/3 = 66.7%', ctxA.overall.completed_leads === 3 && ctxA.overall.completed_link_coverage_pct === Math.round((2 / 3) * 1000) / 10);
    check('G5: linked_deal_rate_to_date_pct = 2/4 = 50.0', ctxA.overall.linked_deal_rate_to_date_pct === 50);
    check('G6: Serious+ = HIGH_INTENT + SERIOUS = 2, both linked -> 100%', ctxA.overall.serious_plus_lead_count === 2 && ctxA.overall.serious_plus_linked_deal_rate_to_date_pct === 100);
    check('G7: offer leads = CASH + TRADE = 2, both linked -> 100%', ctxA.overall.offer_lead_count === 2 && ctxA.overall.offer_linked_deal_rate_to_date_pct === 100);
    // days: (2026-02-10 - 2026-02-01)=9, (2026-02-10 - 2026-02-03)=7 -> median (9+7)/2=8
    check('G8: median days first_contact -> deal_date over the 2 linked leads', ctxA.overall.median_days_first_contact_to_deal_date === 8, ctxA.overall.median_days_first_contact_to_deal_date);
    const mp = ctxA.by_channel.find((c) => c.channel_id === marketplaceId)!;
    check('G9: channel breakdown resolves canonical channel names (Marketplace)', mp.channel_name === 'Marketplace' && mp.total_leads === 2 && mp.linked_leads === 2);
    const kj = ctxA.by_channel.find((c) => c.channel_id === kijijiId)!;
    check('G10: Kijiji channel breakdown: 1 unlinked historical COMPLETED lead — reduces coverage there, not counted as a failed conversion (0/1, not negative/error)', kj.total_leads === 1 && kj.linked_leads === 0 && kj.completed_link_coverage_pct === 0);
    const otherB = ctxA.by_channel.find((c) => c.channel_id === null)!;
    check('G11: the no-channel OPEN lead lands in "Other", contributes 0 to every linked rate (never counted as converted or failed)', otherB.total_leads === 1 && otherB.completed_leads === 0);

    const ctxB = await loadLinkedDealAnalyticsContext({ appUserId: userB, serviceClient: admin });
    check('G12: user isolation — user B sees only their own 1 lead, never user A\'s', ctxB.overall.total_leads === 1 && ctxB.overall.linked_leads === 1);
    check('G13: user A\'s deals/items never leak into user B\'s median/coverage', ctxB.overall.distinct_linked_deals === 1 && ctxB.overall.median_days_first_contact_to_deal_date !== ctxA.overall.median_days_first_contact_to_deal_date);
  } finally {
    console.log('\n=== Cleanup ===');
    if (createdItemLeadIds.length > 0) {
      const { error } = await admin.from('item_leads').delete().in('id', createdItemLeadIds);
      check('cleanup: created item_leads rows deleted', !error, error);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
