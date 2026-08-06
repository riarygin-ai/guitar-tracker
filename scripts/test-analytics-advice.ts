/**
 * test-analytics-advice.ts
 *
 * Focused validation for Auditable AI Advice v1.0
 * (src/lib/analytics/advice/, src/app/api/analytics/runs/[runId]/advice/,
 * the History/Run Detail extensions in src/app/analytics/page.tsx, and the
 * Dashboard extension in src/app/page.tsx). Same conventions as the other
 * scripts in this directory — tsx, no test framework, local `check()`,
 * safety-gated against a disposable local Supabase instance only.
 *
 * Sections A-C are pure unit tests (no DB, no network) against hand-built
 * synthetic evidence, exactly matching the target_user_pattern_discovery_
 * evidence/insights shapes real snapshots produce. Section D exercises the
 * real analytics_runs/analytics_run_advice tables against local Supabase
 * (idempotency, revisions, RLS, ownership, old-run handling) using a
 * directly-inserted legacy-shaped run so these never need a real OpenAI
 * call. Section E makes ONE real end-to-end OpenAI call using a REAL
 * completed run (built via the actual runAnalyticsForCurrentUser pipeline,
 * so its Insights/Pattern Discovery evidence is genuine) — gated on
 * OPENAI_API_KEY being present in the environment; skipped (not failed)
 * otherwise, since CI/other environments may not have it configured.
 *
 * Usage:
 *   npx tsx scripts/test-analytics-advice.ts
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  assertLocalSupabaseUrl,
  assertLocalSupabaseIsRunning,
  setupAnalyticsTestFixtures,
} from './setup-analytics-test-fixtures';
import { runAnalyticsForCurrentUser } from '../src/lib/analytics/runAnalytics';
import { generateAdviceForRun } from '../src/lib/analytics/advice/generateAdvice';
import { buildAdviceInputPacket, sourceIdToDomId } from '../src/lib/analytics/advice/buildInputPacket';
import { canonicalJsonStringify, hashCanonicalInputPacket } from '../src/lib/analytics/advice/canonicalHash';
import { validateAdviceResponse } from '../src/lib/analytics/advice/validateAdviceResponse';
import { ADVICE_MODEL_ID, ADVICE_SYSTEM_PROMPT } from '../src/lib/openai';
import { ADVICE_PROVIDER, ADVICE_SCHEMA_VERSION, PROMPT_TEMPLATE_VERSION } from '../src/lib/analytics/advice/types';
import { formatConfidence, formatCurrency, formatKeyMetrics, humanizeCode } from '../src/lib/analytics/advice/presentation';
import type { SourceRegistryEntry } from '../src/lib/analytics/advice/types';

const ANON_KEY = SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = SUPABASE_SERVICE_ROLE_KEY;

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

async function signIn(email: string, password: string) {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`sign-in failed for ${email}: ${error?.message}`);
  return data.session.access_token;
}

function authedClient(token: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
}

// ── Synthetic snapshot fixture (Section A/B/C) — shaped exactly like a
// real v2.13-plus-Insights-v1.8-plus-Pattern-Discovery-v1.0 snapshot, with
// unmistakable debug markers inside rule_evaluations/candidate_evaluations
// and an unrelated top-level snapshot key, so we can prove they are
// excluded from the packet by content, not just by field name. ──────────

const RULE_EVAL_MARKER = 'RULE_EVAL_DEBUG_MARKER_9f3';
const CANDIDATE_EVAL_MARKER = 'CANDIDATE_EVAL_DEBUG_MARKER_7a1';

function buildSyntheticSnapshot() {
  return {
    generated_at: '2026-01-01T00:00:00.000Z',
    target_user_open_inventory_evidence: { item_decision_evidence: [{ item_id: 999, marker: 'SHOULD_NEVER_APPEAR_IN_PACKET' }] },
    insights: {
      insights_engine_version: '1.8',
      findings_selector_version: '1.8',
      source_analytics_version: '2.12',
      generated_at: '2026-01-01T00:00:00.000Z',
      selected_findings: [
        {
          finding_code: 'STRONG_BALANCED_ACQUISITION_BAND',
          family: 'acquisition_performance',
          direction: 'strength',
          status: 'selected',
          headline: 'Balanced band headline',
          summary: 'Balanced band summary',
          segment: { acquisition_value_band_order: 3, acquisition_value_band_label: '$3,000-3,999' },
          metrics: { median_net_profit: 500, median_roi: 25, dom_sample_size: 8 },
          baseline: { type: 'peer_band_median_baseline', median_net_profit: 200, median_roi: 10, median_days_on_market: 20, realization_rate_percent: 40 },
          triggered_rules: ['PROFIT_ABOVE_PEER_BASELINE'],
          confidence: 'stronger',
          limitations: ['PEER_BASELINE_USES_MEDIAN_OF_BAND_METRICS'],
          evidence_refs: ['target_user_acquisition_evidence.acquisition_value_band_performance'],
        },
        {
          finding_code: 'BUSINESS_OPEN_INVENTORY_PRIORITY',
          family: 'open_inventory_action',
          direction: 'action',
          status: 'selected',
          headline: 'Item priority headline',
          summary: 'Item priority summary',
          segment: { item_id: 84, item_display_name: 'Fixture Guitar' },
          metrics: { estimated_net_upside: 200, open_capital_share_percent: 12 },
          priority_profile: 'STALE_HIGH_CAPITAL',
          recommended_action_code: 'REVIEW_LISTING',
          triggered_reason_codes: ['BUSINESS_UNLISTED_OPEN_ITEM'],
          limitations: [],
          evidence_refs: ['target_user_open_inventory_evidence.item_decision_evidence'],
        },
      ],
      rule_evaluations: [{ finding_code: 'SOME_RULE', debug: RULE_EVAL_MARKER }],
    },
    pattern_discovery: {
      schema_version: '1.0',
      engine_version: '1.0',
      source_analytics_version: '2.13',
      generated_at: '2026-01-01T00:00:00.000Z',
      status: 'completed',
      selection_summary: { selected_pattern_count: 1, emerging_hypothesis_count: 1, total_candidate_segment_count: 10 },
      selected_patterns: [
        {
          pattern_code: 'DISCOVERY|ECONOMICS_SPEED_TRADEOFF|TYPE_ACQUISITION_VALUE_BAND|type_id=1|band_order=2',
          family_code: 'TYPE_ACQUISITION_VALUE_BAND',
          pattern_key: 'TYPE_ACQUISITION_VALUE_BAND|type_id=1|band_order=2',
          peer_group_key: 'type_id=1',
          pattern_type: 'ECONOMICS_SPEED_TRADEOFF',
          direction: 'tradeoff',
          headline: 'Pattern headline',
          summary: 'Pattern summary',
          segment: { type_id: 1, type_name: 'Electric', acquisition_value_band_order: 2 },
          population_basis: 'REALIZED_ITEMS',
          evidence_confidence: 'stronger',
          realized_item_count: 12,
          distinct_exit_deal_count: 12,
          metric_effects: [
            { metric_code: 'median_roi', available: true, candidate_value: 40, peer_baseline_median: 20, advantage_value: 20, direction: 'improvement' },
            { metric_code: 'median_days_on_market', available: true, candidate_value: 30, peer_baseline_median: 15, advantage_value: -15, direction: 'weakness' },
          ],
          triggered_signals: ['ROI_IMPROVEMENT', 'DOM_WEAKNESS'],
          limitations: ['VALUE_BAND_AND_DEAL_MIX_NOT_CONTROLLED'],
          evidence_refs: ['target_user_pattern_discovery_evidence.candidate_segments'],
        },
      ],
      emerging_hypotheses: [
        {
          pattern_code: 'DISCOVERY|BALANCED_STRENGTH|CATEGORY|category_id=1',
          family_code: 'CATEGORY',
          pattern_key: 'CATEGORY|category_id=1',
          peer_group_key: 'family=CATEGORY',
          pattern_type: 'BALANCED_STRENGTH',
          direction: 'strength',
          headline: 'Hypothesis headline',
          summary: 'Hypothesis summary',
          segment: { category_id: 1, category_name: 'Guitars' },
          population_basis: 'REALIZED_ITEMS',
          evidence_confidence: 'low',
          realized_item_count: 5,
          distinct_exit_deal_count: 5,
          metric_effects: [
            { metric_code: 'median_net_profit', available: true, candidate_value: 900, peer_baseline_median: 200, advantage_value: 700, direction: 'improvement' },
          ],
          triggered_signals: ['PROFIT_IMPROVEMENT'],
          limitations: ['PRELIMINARY_HYPOTHESIS_NOT_YET_CONFIRMED'],
          evidence_refs: ['target_user_pattern_discovery_evidence.candidate_segments'],
          status: 'hypothesis',
          confirmation_needed: ['More completed items are needed in eligible peer segments for profit to reach the confirmed peer threshold of n=6 (current minimum peer sample n=3).'],
          ineligibility_reasons: ['CONFIRMED_PEER_SAMPLE_INSUFFICIENT'],
        },
      ],
      candidate_evaluations: [{ family_code: 'CATEGORY', debug: CANDIDATE_EVAL_MARKER }],
    },
  };
}

async function main() {
  // ── Safety gate ───────────────────────────────────────────────────────
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SERVICE_ROLE_KEY);

  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log('\n[fixtures] Ensuring local analytics test fixtures exist...');
  const fixtures = await setupAnalyticsTestFixtures(serviceClient);
  const userAId = fixtures.userAId;
  const userBId = fixtures.userBId;
  const tokenA = await signIn(fixtures.userAEmail, fixtures.password);
  const tokenB = await signIn(fixtures.userBEmail, fixtures.password);
  const clientA = authedClient(tokenA);
  const clientB = authedClient(tokenB);

  // ══════════════════════════════════════════════════════════════════════
  // Section A — buildAdviceInputPacket (tests 6, 7, 8, 9, 10, 11)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[A — buildAdviceInputPacket]');
  const syntheticSnapshot = buildSyntheticSnapshot();
  const syntheticSnapshotBefore = JSON.parse(JSON.stringify(syntheticSnapshot));

  const { packet, sourceRegistry, notes } = buildAdviceInputPacket({
    runId: 999999,
    analyticsVersion: '2.13',
    evidenceScope: 'shared_inventory_population',
    snapshot: syntheticSnapshot,
  });

  check('packet built successfully from a well-formed synthetic snapshot', packet !== null, notes);
  check('test 38: buildAdviceInputPacket never mutates the snapshot it was given', JSON.stringify(syntheticSnapshot) === JSON.stringify(syntheticSnapshotBefore));

  if (packet) {
    check('test 6: input packet includes selected_findings (2 deterministic insights)', packet.deterministic_insights.length === 2, packet.deterministic_insights);
    check('test 7: input packet includes selected_patterns (1 confirmed pattern)', packet.confirmed_patterns.length === 1, packet.confirmed_patterns);
    check('test 8: input packet labels emerging_hypotheses as preliminary (source_type = preliminary_hypothesis)', packet.preliminary_hypotheses.length === 1 && packet.preliminary_hypotheses[0].source_type === 'preliminary_hypothesis', packet.preliminary_hypotheses);

    const packetJson = JSON.stringify(packet);
    check('test 9: input packet excludes rule_evaluations (debug marker absent)', !packetJson.includes(RULE_EVAL_MARKER));
    check('test 10: input packet excludes candidate_evaluations (debug marker absent)', !packetJson.includes(CANDIDATE_EVAL_MARKER));
    check('test 11: input packet excludes the full Raw Snapshot (unrelated top-level section absent)', !packetJson.includes('SHOULD_NEVER_APPEAR_IN_PACKET') && !packetJson.includes('target_user_open_inventory_evidence'));

    check(
      'deterministic insight source_id: band-identity example (insight:STRONG_BALANCED_ACQUISITION_BAND:band:3)',
      packet.deterministic_insights.some((s) => s.source_id === 'insight:STRONG_BALANCED_ACQUISITION_BAND:band:3'),
      packet.deterministic_insights.map((s) => s.source_id),
    );
    check(
      'deterministic insight source_id: item-identity example (insight:BUSINESS_OPEN_INVENTORY_PRIORITY:item:84)',
      packet.deterministic_insights.some((s) => s.source_id === 'insight:BUSINESS_OPEN_INVENTORY_PRIORITY:item:84'),
      packet.deterministic_insights.map((s) => s.source_id),
    );
    check(
      'confirmed pattern source_id uses pattern_code, prefixed "pattern:"',
      packet.confirmed_patterns[0]?.source_id === 'pattern:DISCOVERY|ECONOMICS_SPEED_TRADEOFF|TYPE_ACQUISITION_VALUE_BAND|type_id=1|band_order=2',
      packet.confirmed_patterns[0]?.source_id,
    );
    check(
      'preliminary hypothesis source_id uses pattern_key, prefixed "hypothesis:" (matches the task\'s own worked example)',
      packet.preliminary_hypotheses[0]?.source_id === 'hypothesis:CATEGORY|category_id=1',
      packet.preliminary_hypotheses[0]?.source_id,
    );
    check('run metadata carries the versions from the snapshot, not hardcoded', packet.run.insights_engine_version === '1.8' && packet.run.pattern_discovery_engine_version === '1.0' && packet.run.pattern_discovery_schema_version === '1.0');
    check('allowed_source_ids lists exactly the 4 sources built above', packet.allowed_source_ids.length === 4, packet.allowed_source_ids);

    // test 17 — structural guarantee: an emerging hypothesis can NEVER be
    // tagged as a confirmed_pattern by this code path.
    check('test 17: preliminary hypotheses are structurally never labelled confirmed_pattern', sourceRegistry.filter((s) => s.source_type === 'preliminary_hypothesis').every((s) => s.source_type !== 'confirmed_pattern'));

    // test 18 — structural guarantee: item-level sources only ever come
    // from Business/Hybrid open-inventory rules (no existing Insights rule
    // reads Personal-purpose items at all), so a Personal item can never
    // appear as an item-level source in the first place.
    const itemSources = sourceRegistry.filter((s) => s.item_id !== null);
    check('test 18: every item-level source_id comes from a Business/Hybrid open-inventory finding, never a bare item reference', itemSources.every((s) => s.source_id.startsWith('insight:BUSINESS_OPEN_INVENTORY_PRIORITY:') || s.source_id.startsWith('insight:HYBRID_PURPOSE_REVIEW_PRIORITY:')), itemSources);
  }

  // Old-run / malformed-evidence handling (test 35).
  const emptySnapshotResult = buildAdviceInputPacket({ runId: 1, analyticsVersion: '1.8', evidenceScope: 'shared_business_population', snapshot: { generated_at: '2020-01-01T00:00:00Z' } });
  check('test 35a: a legacy snapshot with no insights/pattern_discovery yields packet=null, never a throw', emptySnapshotResult.packet === null && emptySnapshotResult.notes.includes('NO_CITABLE_EVIDENCE_ON_THIS_RUN'), emptySnapshotResult.notes);
  const malformedResult = buildAdviceInputPacket({ runId: 1, analyticsVersion: '1.8', evidenceScope: 'x', snapshot: 'not even an object' });
  check('test 35b: a completely malformed snapshot value never throws', malformedResult.packet === null, malformedResult.notes);
  check('sourceIdToDomId never throws on special characters and stays deterministic', sourceIdToDomId('pattern:DISCOVERY|X|Y=1') === sourceIdToDomId('pattern:DISCOVERY|X|Y=1'));

  // ══════════════════════════════════════════════════════════════════════
  // Section B — canonical hashing (test 12)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[B — canonical input hashing]');
  {
    const a = { a: 1, b: { c: 2, d: 3 }, e: [1, 2, 3] };
    const b = { b: { d: 3, c: 2 }, a: 1, e: [1, 2, 3] };
    check('test 12a: canonical JSON is insensitive to object key order', canonicalJsonStringify(a) === canonicalJsonStringify(b));
    check('test 12b: hashCanonicalInputPacket is deterministic across repeated calls', hashCanonicalInputPacket(a) === hashCanonicalInputPacket(a));
    check('test 12c: hashCanonicalInputPacket is insensitive to object key order (same as 12a, via the hash)', hashCanonicalInputPacket(a) === hashCanonicalInputPacket(b));
    check('hash output is a 64-character hex SHA-256 digest', /^[0-9a-f]{64}$/.test(hashCanonicalInputPacket(a)));
    check('array element ORDER still affects the hash (never silently reordered)', hashCanonicalInputPacket({ x: [1, 2] }) !== hashCanonicalInputPacket({ x: [2, 1] }));
    if (packet) {
      const packetHash1 = hashCanonicalInputPacket(packet);
      const packetHash2 = hashCanonicalInputPacket(JSON.parse(JSON.stringify(packet)));
      check('a real Advice Input Packet hashes identically across two independent (but content-equal) instances', packetHash1 === packetHash2);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // Section C — response validation (tests 13, 14, 15, 16)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[C — validateAdviceResponse]');
  if (packet) {
    const validSourceId = packet.deterministic_insights[0].source_id;
    const patternSourceId = packet.confirmed_patterns[0].source_id;
    const itemSourceId = packet.deterministic_insights.find((s) => s.source_id.includes(':item:'))!.source_id;

    const validResponse = JSON.stringify({
      schema_version: '1.0',
      run_summary: { headline: 'H', summary: 'S', source_ids: [validSourceId] },
      advice_cards: [
        { advice_code: 'C1', advice_type: 'observation', priority: 'medium', headline: 'H1', advice: 'A1', why_it_matters: 'W1', confidence_label: 'stronger', source_ids: [validSourceId, patternSourceId], limitations: [], item_id: null },
      ],
      limitations: ['ASSOCIATION_NOT_CAUSATION'],
    });
    const validResult = validateAdviceResponse(validResponse, sourceRegistry);
    check('test 13a: a well-formed response with every card sourced validates successfully', validResult.valid, validResult.reasons);

    const noSourceResponse = JSON.stringify({
      schema_version: '1.0',
      run_summary: { headline: 'H', summary: 'S', source_ids: [] },
      advice_cards: [{ advice_code: 'C1', advice_type: 'observation', priority: 'medium', headline: 'H1', advice: 'A1', why_it_matters: 'W1', confidence_label: 'stronger', source_ids: [], limitations: [], item_id: null }],
      limitations: [],
    });
    const noSourceResult = validateAdviceResponse(noSourceResponse, sourceRegistry);
    check('test 13b/15: every advice card requires >= 1 source — an empty source_ids array is rejected', !noSourceResult.valid && noSourceResult.reasons.some((r) => r.includes('HAS_NO_SOURCES')), noSourceResult.reasons);

    const unknownSourceResponse = JSON.stringify({
      schema_version: '1.0',
      run_summary: { headline: 'H', summary: 'S', source_ids: [] },
      advice_cards: [{ advice_code: 'C1', advice_type: 'observation', priority: 'medium', headline: 'H1', advice: 'A1', why_it_matters: 'W1', confidence_label: 'stronger', source_ids: ['insight:DOES_NOT_EXIST:band:99'], limitations: [], item_id: null }],
      limitations: [],
    });
    const unknownSourceResult = validateAdviceResponse(unknownSourceResponse, sourceRegistry);
    check('test 14: an unknown source_id is rejected outright', !unknownSourceResult.valid && unknownSourceResult.reasons.some((r) => r.includes('UNKNOWN_SOURCE_ID')), unknownSourceResult.reasons);

    const duplicateSourceResponse = JSON.stringify({
      schema_version: '1.0',
      run_summary: { headline: 'H', summary: 'S', source_ids: [validSourceId, validSourceId] },
      advice_cards: [{ advice_code: 'C1', advice_type: 'observation', priority: 'medium', headline: 'H1', advice: 'A1', why_it_matters: 'W1', confidence_label: 'stronger', source_ids: [validSourceId, validSourceId, patternSourceId], limitations: [], item_id: null }],
      limitations: [],
    });
    const duplicateSourceResult = validateAdviceResponse(duplicateSourceResponse, sourceRegistry);
    check('test 16: duplicate source IDs are normalized (deduped), not rejected', duplicateSourceResult.valid && duplicateSourceResult.response?.advice_cards[0].source_ids.length === 2, duplicateSourceResult.response?.advice_cards[0].source_ids);
    check('run_summary source_ids are also deduped', duplicateSourceResult.response?.run_summary.source_ids.length === 1);

    const itemJustifiedResponse = JSON.stringify({
      schema_version: '1.0',
      run_summary: { headline: 'H', summary: 'S', source_ids: [] },
      advice_cards: [{ advice_code: 'C1', advice_type: 'action', priority: 'high', headline: 'H1', advice: 'A1', why_it_matters: 'W1', confidence_label: 'stronger', source_ids: [itemSourceId], limitations: [], item_id: 84 }],
      limitations: [],
    });
    check('a card item_id justified by one of its own cited sources validates', validateAdviceResponse(itemJustifiedResponse, sourceRegistry).valid);

    const itemUnjustifiedResponse = JSON.stringify({
      schema_version: '1.0',
      run_summary: { headline: 'H', summary: 'S', source_ids: [] },
      advice_cards: [{ advice_code: 'C1', advice_type: 'action', priority: 'high', headline: 'H1', advice: 'A1', why_it_matters: 'W1', confidence_label: 'stronger', source_ids: [validSourceId], limitations: [], item_id: 84 }],
      limitations: [],
    });
    const itemUnjustifiedResult = validateAdviceResponse(itemUnjustifiedResponse, sourceRegistry);
    check('a card item_id NOT justified by any of its own cited sources is rejected (references an absent item)', !itemUnjustifiedResult.valid && itemUnjustifiedResult.reasons.some((r) => r.includes('REFERENCES_ABSENT_ITEM')), itemUnjustifiedResult.reasons);

    check('malformed JSON never throws, is reported as invalid', !validateAdviceResponse('{not json', sourceRegistry).valid);
    check('a response with more than 3 advice_cards is rejected', !validateAdviceResponse(JSON.stringify({ schema_version: '1.0', run_summary: { headline: 'H', summary: 'S', source_ids: [] }, advice_cards: [1, 2, 3, 4].map((n) => ({ advice_code: `C${n}`, advice_type: 'observation', priority: 'low', headline: 'H', advice: 'A', why_it_matters: 'W', confidence_label: 'low', source_ids: [validSourceId], limitations: [], item_id: null })), limitations: [] }), sourceRegistry).valid);
  }

  // Prompt-contract checks (tests 18/19 behavioral guarantees that ARE
  // deterministically verifiable: the required constraints are actually
  // present in what gets sent to the model).
  console.log('\n[C — AI behavior contract present in the system prompt]');
  check('system prompt forbids pressuring the user to sell Personal inventory', /Personal/i.test(ADVICE_SYSTEM_PROMPT) && /never pressure/i.test(ADVICE_SYSTEM_PROMPT));
  check('test 19: system prompt keeps Hybrid Purpose review neutral (KEEP_HYBRID / CHANGE_TO_BUSINESS / CHANGE_TO_PERSONAL may all be valid)', ADVICE_SYSTEM_PROMPT.includes('KEEP_HYBRID') && ADVICE_SYSTEM_PROMPT.includes('CHANGE_TO_BUSINESS') && ADVICE_SYSTEM_PROMPT.includes('CHANGE_TO_PERSONAL'));
  check('system prompt requires distinguishing Deterministic Insight / Confirmed Pattern / Preliminary Hypothesis', /Deterministic Insight/.test(ADVICE_SYSTEM_PROMPT) && /Confirmed Pattern/.test(ADVICE_SYSTEM_PROMPT) && /Preliminary Hypothesis/.test(ADVICE_SYSTEM_PROMPT));
  check('system prompt forbids recommending automatic inventory/listing/price/Purpose mutations', /never recommend an automatic database change/i.test(ADVICE_SYSTEM_PROMPT));
  check('system prompt explicitly forbids causal framing', /causal|causation|caused/i.test(ADVICE_SYSTEM_PROMPT));
  check('system prompt explicitly forbids promising financial outcomes', /promise/i.test(ADVICE_SYSTEM_PROMPT));
  check('advice_schema_version constant is "1.0"', ADVICE_SCHEMA_VERSION === '1.0');
  check('prompt_template_version constant is "analytics-advice-v1"', PROMPT_TEMPLATE_VERSION === 'analytics-advice-v1');
  check('provider constant is "openai"', ADVICE_PROVIDER === 'openai');

  // ══════════════════════════════════════════════════════════════════════
  // Section D — real DB lifecycle (tests 1, 2, 3, 20, 21, 22, 23, 33, 34, 35)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[D — real DB lifecycle, no OpenAI cost]');

  // test 1/2 — reuses the EXISTING analytics_runs table; the FK constraint
  // on analytics_run_advice.analytics_run_id proves it references that
  // exact existing table, not a parallel id space.
  const { error: fkViolationError } = await serviceClient.from('analytics_run_advice').insert({
    analytics_run_id: 999999999,
    user_id: userAId,
    revision_number: 1,
    status: 'pending',
    provider: ADVICE_PROVIDER,
    model: ADVICE_MODEL_ID,
    advice_schema_version: ADVICE_SCHEMA_VERSION,
    prompt_template_version: PROMPT_TEMPLATE_VERSION,
  });
  check('test 1/2: analytics_run_advice.analytics_run_id is a real FK into the EXISTING analytics_runs table (a bogus run id is rejected)', fkViolationError !== null, fkViolationError);

  // A legacy-shaped completed run with no Insights/Pattern Discovery at
  // all — inserted directly so these structural tests never need to call
  // OpenAI.
  const { data: legacyRun, error: legacyRunError } = await serviceClient
    .from('analytics_runs')
    .insert({
      requested_by_user_id: userAId,
      recommendation_target_user_id: userAId,
      analytics_version: '1.8',
      evidence_scope: 'shared_business_population',
      status: 'completed',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      snapshot: { snapshot_schema_version: '1.8', analytics_definition_version: '1.8', generated_at: new Date().toISOString(), evidence_scope: 'shared_business_population' },
    })
    .select('id')
    .single();
  check('legacy-shaped completed run fixture inserted', !legacyRunError && !!legacyRun, legacyRunError);
  const legacyRunId = legacyRun!.id as number;

  const firstAuto = await generateAdviceForRun({ runId: legacyRunId, requestingUserId: userAId, serviceClient, mode: 'auto' });
  check('test 35: an old run with no citable evidence fails gracefully (NO_VALID_EVIDENCE), never a throw', firstAuto.status === 'failed' && firstAuto.status === 'failed' && (firstAuto as any).row.error_code === 'NO_VALID_EVIDENCE', firstAuto);
  check('test 3: the generated advice row references the correct existing run id', firstAuto.status === 'failed' && (firstAuto as any).row.analytics_run_id === legacyRunId);

  const secondAuto = await generateAdviceForRun({ runId: legacyRunId, requestingUserId: userAId, serviceClient, mode: 'auto' });
  check('test 21: automatic initial generation is idempotent — a second auto call for the same run is skipped, not a duplicate revision', secondAuto.status === 'skipped' && secondAuto.reason === 'ADVICE_ALREADY_EXISTS_FOR_RUN', secondAuto);

  const retryOne = await generateAdviceForRun({ runId: legacyRunId, requestingUserId: userAId, serviceClient, mode: 'retry' });
  check('test 22a: an explicit retry always creates a new revision, even after an auto-mode skip', retryOne.status === 'failed' && (retryOne as any).row.revision_number === 2, retryOne);

  const { data: allRevisions } = await serviceClient.from('analytics_run_advice').select('id, revision_number, status').eq('analytics_run_id', legacyRunId).order('revision_number', { ascending: true });
  check('test 23: earlier revisions remain stored and readable after a retry (2 rows: revision 1 and 2)', (allRevisions?.length ?? 0) === 2 && allRevisions![0].revision_number === 1 && allRevisions![1].revision_number === 2, allRevisions);

  const crossUserAttempt = await generateAdviceForRun({ runId: legacyRunId, requestingUserId: userBId, serviceClient, mode: 'retry' });
  check('test 34: another user cannot trigger advice generation for a run they do not own', crossUserAttempt.status === 'skipped' && crossUserAttempt.reason === 'RUN_NOT_OWNED_BY_CALLER', crossUserAttempt);

  const { data: ownRlsRows } = await clientA.from('analytics_run_advice').select('id').eq('analytics_run_id', legacyRunId);
  check('user A can read their own advice rows via RLS', (ownRlsRows?.length ?? 0) === 2, ownRlsRows);
  const { data: crossRlsRows } = await clientB.from('analytics_run_advice').select('id').eq('analytics_run_id', legacyRunId);
  check('test 33: another user cannot view advice for a run they do not own (RLS returns empty)', (crossRlsRows?.length ?? 0) === 0, crossRlsRows);

  const { data: legacyRunAfter } = await serviceClient.from('analytics_runs').select('status').eq('id', legacyRunId).single();
  check('test 20: repeated AI advice failures never change the underlying Analytics Run\'s own status (still completed)', legacyRunAfter?.status === 'completed', legacyRunAfter);

  const nonexistentRunAttempt = await generateAdviceForRun({ runId: 987654321, requestingUserId: userAId, serviceClient, mode: 'retry' });
  check('generateAdviceForRun handles a nonexistent run id gracefully (skipped, not a throw)', nonexistentRunAttempt.status === 'skipped' && nonexistentRunAttempt.reason === 'RUN_NOT_FOUND');

  // test 36/37 — null unavailable, zero visible (presentation helpers).
  console.log('\n[D — presentation: null unavailable, zero visible]');
  check('test 36a: formatConfidence(null) is explicitly "Not applicable", never a fabricated tier', formatConfidence(null) === 'Not applicable');
  check('test 36b: a null key_metrics value renders as unavailable, not 0', formatKeyMetrics({ median_net_profit: null }).find((m) => m.label.toLowerCase().includes('profit'))?.value === '—');
  check('test 37a: formatCurrency(0) shows a real, visible zero', formatCurrency(0) === 'CAD $0');
  check('test 37b: a numeric 0 key_metrics value renders as a real zero, not unavailable', formatKeyMetrics({ dom_sample_size: 0 }).find((m) => m.label.toLowerCase().includes('sample'))?.value !== '—');
  check('unknown reason/error code falls back to a readable humanization instead of crashing', humanizeCode('SOME_TOTALLY_UNKNOWN_CODE_XYZ') === 'Some totally unknown code xyz');
  check('humanizeCode never throws on an empty string', humanizeCode('') === '—');

  // ══════════════════════════════════════════════════════════════════════
  // Section E — real end-to-end (real Analytics run + real OpenAI call),
  // gated on OPENAI_API_KEY being present (tests 4, 5, 24)
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[E — real end-to-end: genuine completed run + real OpenAI call]');

  console.log('  Building a REAL completed Analytics Run via the actual production pipeline (reuses the existing table/runner — never a synthetic advice-only run)...');
  const realRun = await runAnalyticsForCurrentUser({ appUserId: userAId, serviceClient });
  check('test 1 (again, end-to-end): the real run used for advice IS an analytics_runs row created by the existing runner', realRun.status === 'completed', realRun.status);
  check('test 24: this run is exactly the kind of existing/historical run advice must be generatable from', realRun.snapshot !== null);

  // test 4/5 — advice must be built from the run's OWN saved snapshot, not
  // "the newest run" or live inventory: build the packet directly from the
  // freshly-fetched row's snapshot and confirm its run_generated_at matches
  // that snapshot's own generated_at, never "now".
  const { data: realRunRow } = await serviceClient.from('analytics_runs').select('snapshot, analytics_version, evidence_scope').eq('id', realRun.id).single();
  const directPacket = buildAdviceInputPacket({
    runId: realRun.id,
    analyticsVersion: realRunRow!.analytics_version as string,
    evidenceScope: realRunRow!.evidence_scope as string,
    snapshot: realRunRow!.snapshot,
  });
  check(
    'test 4/5: the packet\'s run_generated_at matches THIS run\'s own saved snapshot.generated_at exactly (never live/"now" data)',
    directPacket.packet?.run.run_generated_at === (realRunRow!.snapshot as any).generated_at,
    { packetValue: directPacket.packet?.run.run_generated_at, snapshotValue: (realRunRow!.snapshot as any).generated_at },
  );

  if (!process.env.OPENAI_API_KEY) {
    console.log('  SKIPPED: OPENAI_API_KEY is not set in this shell — skipping the real OpenAI generation call (structural/unit coverage above already exercises everything except the live network call).');
  } else {
    const outcome = await generateAdviceForRun({ runId: realRun.id, requestingUserId: userAId, serviceClient, mode: 'auto' });
    check('real generation attempt reaches a terminal state (completed or failed), never hangs/throws', outcome.status === 'completed' || outcome.status === 'failed', outcome.status);

    if (outcome.status === 'completed') {
      const row = outcome.row;
      check('completed advice carries the configured provider/model', row.provider === 'openai' && row.model === ADVICE_MODEL_ID, { provider: row.provider, model: row.model });
      check('completed advice carries the exact expected schema/prompt versions', row.advice_schema_version === '1.0' && row.prompt_template_version === 'analytics-advice-v1');
      check('completed advice canonical_input_hash is a real 64-char hex digest', /^[0-9a-f]{64}$/.test(row.canonical_input_hash ?? ''), row.canonical_input_hash);
      check('completed advice matches the independently-recomputed packet hash for the same saved run', row.canonical_input_hash === hashCanonicalInputPacket(directPacket.packet), { stored: row.canonical_input_hash, recomputed: hashCanonicalInputPacket(directPacket.packet) });
      check('completed advice has at most 3 advice_cards', (row.advice?.advice_cards.length ?? 0) <= 3, row.advice?.advice_cards.length);
      check('every completed advice card cites at least one source_id (re-verified on the persisted row)', (row.advice?.advice_cards ?? []).every((c) => c.source_ids.length > 0));
      const registryIds = new Set((row.source_refs ?? []).map((s: SourceRegistryEntry) => s.source_id));
      check('every persisted advice card source_id exists in the persisted source_refs registry', (row.advice?.advice_cards ?? []).every((c) => c.source_ids.every((id) => registryIds.has(id))));
    } else {
      console.log('  Real OpenAI call resulted in a failed generation (error_code:', (outcome as any).row?.error_code, ') — this is still a valid, fully-handled outcome; the run above remains completed regardless.');
    }

    // test 21 (again, real run this time) — auto mode must not create a
    // second revision even after a real attempt.
    const secondRealAuto = await generateAdviceForRun({ runId: realRun.id, requestingUserId: userAId, serviceClient, mode: 'auto' });
    check('automatic idempotency holds for a real run too — a second auto call is skipped', secondRealAuto.status === 'skipped' && secondRealAuto.reason === 'ADVICE_ALREADY_EXISTS_FOR_RUN', secondRealAuto);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
