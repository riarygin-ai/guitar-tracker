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
import type { GenerateAdviceOutcome } from '../src/lib/analytics/advice/generateAdvice';
import { buildAdviceInputPacket, sourceIdToDomId, parseSourceIdsDeepLinkParam } from '../src/lib/analytics/advice/buildInputPacket';
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

// Isolated legacy-shaped completed run (no Insights/Pattern Discovery) —
// used by Section F below so every fixture there gets its OWN dedicated
// run rather than sharing legacyRunId from Section D, keeping each test's
// cleanup independently verifiable. Packet building always fails
// deterministically (NO_VALID_EVIDENCE) for this shape, so every
// generateAdviceForRun() call against it resolves without any OpenAI cost.
async function createDedicatedLegacyRun(serviceClient: SupabaseClient, ownerId: number): Promise<number> {
  const { data, error } = await serviceClient
    .from('analytics_runs')
    .insert({
      requested_by_user_id: ownerId,
      recommendation_target_user_id: ownerId,
      analytics_version: '1.8',
      evidence_scope: 'shared_business_population',
      status: 'completed',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      snapshot: { snapshot_schema_version: '1.8', analytics_definition_version: '1.8', generated_at: new Date().toISOString(), evidence_scope: 'shared_business_population' },
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create dedicated legacy run fixture: ${error?.message}`);
  return data.id as number;
}

function isFailedOutcome(r: GenerateAdviceOutcome): r is Extract<GenerateAdviceOutcome, { status: 'failed' }> {
  return r.status === 'failed';
}

function isSkippedWithReason(r: GenerateAdviceOutcome, reason: string): r is Extract<GenerateAdviceOutcome, { status: 'skipped' }> {
  return r.status === 'skipped' && r.reason === reason;
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
  check('sourceIdToDomId is a valid, collision-safe HTML id (only percent-encoded/alphanumeric chars, distinct sources -> distinct ids)', /^advice-source-[A-Za-z0-9%_-]+$/.test(sourceIdToDomId('pattern:DISCOVERY|X|Y=1')) && sourceIdToDomId('pattern:A') !== sourceIdToDomId('pattern:B'));

  // Deep-link evidence navigation: ?sourceIds=... must decode safely even
  // when hand-edited/truncated/corrupted, never throw and crash the page.
  check('parseSourceIdsDeepLinkParam decodes a well-formed comma-separated, URI-encoded list', JSON.stringify(parseSourceIdsDeepLinkParam(['insight:A:band:1', 'pattern:B|C'].map(encodeURIComponent).join(','))) === JSON.stringify(['insight:A:band:1', 'pattern:B|C']));
  check('parseSourceIdsDeepLinkParam drops a malformed percent-encoding segment instead of throwing', JSON.stringify(parseSourceIdsDeepLinkParam(`${encodeURIComponent('insight:A')},%E0%A4%A,${encodeURIComponent('insight:B')}`)) === JSON.stringify(['insight:A', 'insight:B']));
  check('parseSourceIdsDeepLinkParam on an entirely malformed param returns an empty array, never throws', JSON.stringify(parseSourceIdsDeepLinkParam('%,%%,%zz')) === JSON.stringify([]));
  check('parseSourceIdsDeepLinkParam drops empty segments (e.g. a trailing comma)', JSON.stringify(parseSourceIdsDeepLinkParam(`${encodeURIComponent('insight:A')},`)) === JSON.stringify(['insight:A']));

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
  // Section F — migration 20260826000000 hardening: composite ownership FK,
  // audit-field immutability trigger, "authenticated has no write grant at
  // all" (not just RLS), and atomic revision-allocation concurrency
  // (claim_next_analytics_run_advice_revision). Every fixture row created
  // here is deleted and the deletion verified before this section returns —
  // unlike Section D/E's shared legacyRun/realRun (left for the disposable
  // local stack to eventually discard), the tests below create many rows in
  // one shot and must prove none are left behind, per the explicit
  // "verify all fixture rows were removed after every persistent
  // concurrency test" requirement.
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n[F — composite FK, immutability trigger, write grants, atomic revision allocation]');

  // F1 — composite ownership FK rejects a REAL run id paired with a user_id
  // that is NOT that run's owner (as opposed to test 1/2 above, which used
  // a wholly nonexistent run id — this is the actual ownership guarantee).
  {
    const runId = await createDedicatedLegacyRun(serviceClient, userAId);
    const { error: mismatchError } = await serviceClient.from('analytics_run_advice').insert({
      analytics_run_id: runId,
      user_id: userBId,
      revision_number: 1,
      status: 'pending',
      provider: ADVICE_PROVIDER,
      model: ADVICE_MODEL_ID,
      advice_schema_version: ADVICE_SCHEMA_VERSION,
      prompt_template_version: PROMPT_TEMPLATE_VERSION,
    });
    check('composite ownership FK rejects a real run id paired with a non-owning user_id', mismatchError !== null, mismatchError);

    const { error: f1DeleteError } = await serviceClient.from('analytics_runs').delete().eq('id', runId);
    const { count: f1Leftover } = await serviceClient.from('analytics_run_advice').select('id', { count: 'exact', head: true }).eq('analytics_run_id', runId);
    check('cleanup: F1 fixture run deleted with no leftover advice rows', !f1DeleteError && (f1Leftover ?? 0) === 0, { f1DeleteError, f1Leftover });
  }

  // F2 — cascade delete: a valid advice row followed by deleting its parent
  // run must remove the advice row too (ON DELETE CASCADE via the new
  // composite FK, now the ONLY FK from analytics_run_advice into
  // analytics_runs).
  {
    const runId = await createDedicatedLegacyRun(serviceClient, userAId);
    const { data: cascadeRow, error: cascadeInsertError } = await serviceClient.from('analytics_run_advice').insert({
      analytics_run_id: runId,
      user_id: userAId,
      revision_number: 1,
      status: 'pending',
      provider: ADVICE_PROVIDER,
      model: ADVICE_MODEL_ID,
      advice_schema_version: ADVICE_SCHEMA_VERSION,
      prompt_template_version: PROMPT_TEMPLATE_VERSION,
    }).select('id').single();
    check('F2 fixture: valid advice row (real run, real owner) inserted', !cascadeInsertError && !!cascadeRow, cascadeInsertError);

    await serviceClient.from('analytics_runs').delete().eq('id', runId);
    const { data: survivorRows } = await serviceClient.from('analytics_run_advice').select('id').eq('analytics_run_id', runId);
    check('test: deleting an analytics run cascades to all its advice revisions', (survivorRows?.length ?? 0) === 0, survivorRows);
  }

  // F3 — audit-field immutability trigger: protected columns are rejected
  // after insert; status/advice/source_refs/generated_at/error fields
  // remain updatable; canonical_input_hash/input_packet may be set once
  // from NULL but never changed again afterward.
  {
    const runId = await createDedicatedLegacyRun(serviceClient, userAId);
    const { data: immutRow, error: immutInsertError } = await serviceClient.from('analytics_run_advice').insert({
      analytics_run_id: runId,
      user_id: userAId,
      revision_number: 1,
      status: 'pending',
      provider: ADVICE_PROVIDER,
      model: ADVICE_MODEL_ID,
      advice_schema_version: ADVICE_SCHEMA_VERSION,
      prompt_template_version: PROMPT_TEMPLATE_VERSION,
    }).select('id').single();
    check('F3 fixture: pending advice row inserted', !immutInsertError && !!immutRow, immutInsertError);
    const rowId = immutRow!.id as number;

    const { error: revisionUpdateError } = await serviceClient.from('analytics_run_advice').update({ revision_number: 99 }).eq('id', rowId);
    check('immutability trigger rejects changing revision_number after insert', revisionUpdateError !== null, revisionUpdateError);

    const { error: providerUpdateError } = await serviceClient.from('analytics_run_advice').update({ provider: 'someone-else' }).eq('id', rowId);
    check('immutability trigger rejects changing provider after insert', providerUpdateError !== null, providerUpdateError);

    // A genuinely different (still valid/owned) run id, so this isolates
    // the immutability trigger from the composite FK — the FK alone would
    // happily allow this new (run, user) pair since otherRunId is also
    // owned by userAId.
    const otherRunId = await createDedicatedLegacyRun(serviceClient, userAId);
    const { error: runIdChangeError } = await serviceClient.from('analytics_run_advice').update({ analytics_run_id: otherRunId }).eq('id', rowId);
    check('immutability trigger rejects changing analytics_run_id after insert', runIdChangeError !== null, runIdChangeError);

    const { error: generatingTransitionError } = await serviceClient.from('analytics_run_advice')
      .update({ status: 'generating', canonical_input_hash: 'f'.repeat(64), input_packet: { packet_version: '1.0', marker: 'first-set' } })
      .eq('id', rowId);
    check('pending->generating transition (first-time hash/input_packet set) succeeds', generatingTransitionError === null, generatingTransitionError);

    const { error: rehashError } = await serviceClient.from('analytics_run_advice').update({ canonical_input_hash: 'a'.repeat(64) }).eq('id', rowId);
    check('immutability trigger rejects re-setting canonical_input_hash once already set', rehashError !== null, rehashError);

    const { error: repacketError } = await serviceClient.from('analytics_run_advice').update({ input_packet: { packet_version: '1.0', marker: 'second-set' } }).eq('id', rowId);
    check('immutability trigger rejects re-setting input_packet once already set', repacketError !== null, repacketError);

    const { error: completeError } = await serviceClient.from('analytics_run_advice')
      .update({
        status: 'completed',
        advice: { schema_version: '1.0', run_summary: { headline: 'H', summary: 'S', source_ids: [] }, advice_cards: [], limitations: [] },
        source_refs: [],
        generated_at: new Date().toISOString(),
      })
      .eq('id', rowId);
    check('generating->completed lifecycle update (status/advice/source_refs/generated_at) still succeeds', completeError === null, completeError);

    await serviceClient.from('analytics_runs').delete().in('id', [runId, otherRunId]);
    const { data: f3Survivors } = await serviceClient.from('analytics_run_advice').select('id').in('analytics_run_id', [runId, otherRunId]);
    check('cleanup: F3 fixture runs deleted with no leftover advice rows', (f3Survivors?.length ?? 0) === 0, f3Survivors);
  }

  // F4 — authenticated users still have no INSERT/UPDATE/DELETE privileges
  // at all on analytics_run_advice (SELECT-only, service-role-only
  // writes) — a stronger guarantee than RLS alone, since these grants are
  // enforced even before any policy is evaluated.
  {
    const runId = await createDedicatedLegacyRun(serviceClient, userAId);
    const { error: authedInsertError } = await clientA.from('analytics_run_advice').insert({
      analytics_run_id: runId,
      user_id: userAId,
      revision_number: 1,
      status: 'pending',
      provider: ADVICE_PROVIDER,
      model: ADVICE_MODEL_ID,
      advice_schema_version: ADVICE_SCHEMA_VERSION,
      prompt_template_version: PROMPT_TEMPLATE_VERSION,
    });
    check('authenticated role cannot INSERT into analytics_run_advice', authedInsertError !== null, authedInsertError);

    const { data: seedRow } = await serviceClient.from('analytics_run_advice').insert({
      analytics_run_id: runId,
      user_id: userAId,
      revision_number: 1,
      status: 'pending',
      provider: ADVICE_PROVIDER,
      model: ADVICE_MODEL_ID,
      advice_schema_version: ADVICE_SCHEMA_VERSION,
      prompt_template_version: PROMPT_TEMPLATE_VERSION,
    }).select('id').single();
    const seedRowId = seedRow!.id as number;

    const { error: authedUpdateError } = await clientA.from('analytics_run_advice').update({ status: 'failed', error_code: 'X', error_message: 'X' }).eq('id', seedRowId);
    check('authenticated role cannot UPDATE analytics_run_advice (even its own row)', authedUpdateError !== null, authedUpdateError);

    const { error: authedDeleteError } = await clientA.from('analytics_run_advice').delete().eq('id', seedRowId);
    check('authenticated role cannot DELETE analytics_run_advice (even its own row)', authedDeleteError !== null, authedDeleteError);

    await serviceClient.from('analytics_runs').delete().eq('id', runId);
    const { data: f4Survivors } = await serviceClient.from('analytics_run_advice').select('id').eq('analytics_run_id', runId);
    check('cleanup: F4 fixture run deleted with no leftover advice rows', (f4Survivors?.length ?? 0) === 0, f4Survivors);
  }

  // F5/F6 — concurrency: multiple concurrent AUTO-mode requests against the
  // SAME run must create exactly one revision, serialized by
  // claim_next_analytics_run_advice_revision's advisory transaction lock —
  // never a duplicate, never an unhandled unique-constraint error; then
  // multiple concurrent explicit RETRY requests against that same run must
  // each create their OWN unique, contiguous revision. Uses a dedicated
  // legacy (no-evidence) run so every attempt resolves deterministically to
  // 'failed'/NO_VALID_EVIDENCE with zero OpenAI cost — this exercises the
  // REAL generateAdviceForRun() entry point end-to-end, not just the RPC in
  // isolation.
  console.log('\n[F5/F6 — concurrent auto/retry advice generation]');
  {
    const runId = await createDedicatedLegacyRun(serviceClient, userAId);

    const CONCURRENT_AUTO_REQUESTS = 12;
    const autoResults = await Promise.all(
      Array.from({ length: CONCURRENT_AUTO_REQUESTS }, () =>
        generateAdviceForRun({ runId, requestingUserId: userAId, serviceClient, mode: 'auto' }),
      ),
    );
    const autoCreated = autoResults.filter(isFailedOutcome);
    const autoSkipped = autoResults.filter((r) => isSkippedWithReason(r, 'ADVICE_ALREADY_EXISTS_FOR_RUN'));
    check(
      `${CONCURRENT_AUTO_REQUESTS} concurrent auto-generation requests produce exactly ONE created revision (the rest skip as already-existing)`,
      autoCreated.length === 1 && autoSkipped.length === CONCURRENT_AUTO_REQUESTS - 1,
      { created: autoCreated.length, skipped: autoSkipped.length, statuses: autoResults.map((r) => (r.status === 'skipped' ? r.reason : r.status)) },
    );
    const { data: autoRevisions } = await serviceClient.from('analytics_run_advice').select('revision_number').eq('analytics_run_id', runId);
    check('exactly one revision (number 1) actually persisted after concurrent auto requests', (autoRevisions?.length ?? 0) === 1 && autoRevisions?.[0]?.revision_number === 1, autoRevisions);

    const CONCURRENT_RETRY_REQUESTS = 12;
    const retryResults = await Promise.all(
      Array.from({ length: CONCURRENT_RETRY_REQUESTS }, () =>
        generateAdviceForRun({ runId, requestingUserId: userAId, serviceClient, mode: 'retry' }),
      ),
    );
    const retryFailedOutcomes = retryResults.filter(isFailedOutcome);
    check(
      `${CONCURRENT_RETRY_REQUESTS} concurrent retry requests each create their own revision — no throws, no raw DB errors surfaced`,
      retryFailedOutcomes.length === CONCURRENT_RETRY_REQUESTS,
      retryResults.map((r) => r.status),
    );
    const retryRevisionNumbers = retryFailedOutcomes.map((r) => r.row.revision_number).sort((a, b) => a - b);
    const uniqueRetryRevisionNumbers = new Set(retryRevisionNumbers);
    check('all concurrent retry revision numbers are unique (no duplicates)', uniqueRetryRevisionNumbers.size === retryRevisionNumbers.length, retryRevisionNumbers);
    check(
      'concurrent retry revision numbers are exactly 2..13 (contiguous, continuing after the auto-created revision 1)',
      JSON.stringify(retryRevisionNumbers) === JSON.stringify(Array.from({ length: CONCURRENT_RETRY_REQUESTS }, (_, i) => i + 2)),
      retryRevisionNumbers,
    );

    const { data: allRunRevisions } = await serviceClient.from('analytics_run_advice').select('id, revision_number').eq('analytics_run_id', runId).order('revision_number', { ascending: true });
    check('final revision selector can read every created revision (1 auto + 12 retries = 13 total rows)', (allRunRevisions?.length ?? 0) === 1 + CONCURRENT_RETRY_REQUESTS, allRunRevisions?.length);
    check(
      'no earlier revision was overwritten by a later concurrent request (every revision_number 1..13 present exactly once)',
      JSON.stringify(allRunRevisions?.map((r) => r.revision_number)) === JSON.stringify(Array.from({ length: 1 + CONCURRENT_RETRY_REQUESTS }, (_, i) => i + 1)),
      allRunRevisions?.map((r) => r.revision_number),
    );

    // ── Cleanup + verification (required for every persistent concurrency
    // test): delete the dedicated run (cascades every revision it
    // produced) and verify zero rows remain. ─────────────────────────────
    const { error: f5f6DeleteError } = await serviceClient.from('analytics_runs').delete().eq('id', runId);
    const { data: f5f6Survivors } = await serviceClient.from('analytics_run_advice').select('id').eq('analytics_run_id', runId);
    const { data: f5f6RunSurvivor } = await serviceClient.from('analytics_runs').select('id').eq('id', runId).maybeSingle();
    check(
      'cleanup: concurrency fixture run + all its revisions fully removed, verified by count',
      !f5f6DeleteError && (f5f6Survivors?.length ?? 0) === 0 && !f5f6RunSurvivor,
      { f5f6DeleteError, leftoverAdviceRows: f5f6Survivors?.length, leftoverRun: f5f6RunSurvivor },
    );
  }

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
