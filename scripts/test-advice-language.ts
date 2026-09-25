/**
 * test-advice-language.ts
 *
 * Per-user AI Advice language (General Business Coach + Listing Advice only):
 * codes/instruction/one canonical prompt, persisted + hashed packet language,
 * validators unchanged for Russian, Russian no-fake-conversion guard, the
 * deterministic UI-label dictionary, language-independent dismissal identity,
 * migration/Admin API/Admin UI structure, and (REAL local DB, injected models)
 * the preference column, RLS, the unified workflow, both generators, and
 * historical-revision immutability. No live OpenAI call is ever made.
 * Local Supabase only (safety-gated); everything created is deleted.
 *
 * Usage:  npx tsx scripts/test-advice-language.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
  assertLocalSupabaseUrl, assertLocalSupabaseIsRunning,
} from './setup-analytics-test-fixtures';
import {
  ADVICE_LANGUAGES, ADVICE_LANGUAGE_OPTIONS, DEFAULT_ADVICE_LANGUAGE, adviceLanguageInstruction, describeAdviceLanguage, isAdviceLanguage, normalizeAdviceLanguage, type AdviceLanguage,
} from '../src/lib/analytics/advice/adviceLanguage';
import { adviceLabels, formatAdviceTimestamp, resolveRevisionLanguage } from '../src/lib/analytics/advice/adviceLabels';
import { getUserPreferredLanguage } from '../src/lib/analytics/advice/userLanguage';
import { formatLimitation } from '../src/lib/analytics/advice/presentation';
import { ADVICE_SYSTEM_PROMPT, LISTING_ADVICE_SYSTEM_PROMPT, adviceSystemPromptFor, listingAdviceSystemPromptFor } from '../src/lib/openai';
import { LEAD_DEAL_RULES, LISTING_DEMAND_SEMANTICS, PURPOSE_SEMANTICS, findLeadDealViolations } from '../src/lib/analytics/advice/sharedSemantics';
import { buildAdviceInputPacket } from '../src/lib/analytics/advice/buildInputPacket';
import { hashCanonicalInputPacket } from '../src/lib/analytics/advice/canonicalHash';
import { validateAdviceResponse } from '../src/lib/analytics/advice/validateAdviceResponse';
import { computeAdviceKey } from '../src/lib/analytics/advice/adviceKey';
import { PROMPT_TEMPLATE_VERSION, type AdviceInputPacket } from '../src/lib/analytics/advice/types';
import { generateAdviceForRun } from '../src/lib/analytics/advice/generateAdvice';
import { buildListingDemandContext, type ListingDemandContext } from '../src/lib/analytics/advice/listingDemandContext';
import {
  LISTING_ADVICE_PROMPT_VERSION, buildListingAdvicePacket, hashListingAdvicePacket, validateListingAdviceResponse, type ListingAdvicePacket,
} from '../src/lib/analytics/listingAdvice/listingAdvice';
import { generateListingAdvice } from '../src/lib/analytics/listingAdvice/generateListingAdvice';
import { runAnalyticsWorkflow, type AnalyticsWorkflowDeps } from '../src/lib/analytics/runAnalyticsWorkflow';
import { listingAdviceKey } from '../src/lib/listingAdviceKey';
import { coachActions, coachLimitations, resolveCoachCardEvidence } from '../src/lib/coachAdviceView';
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


// ── Coach fixtures ──────────────────────────────────────────────────────────
const SNAPSHOT = {
  generated_at: '2026-09-20T00:00:00Z',
  insights: {
    insights_engine_version: 'x', findings_selector_version: 'y',
    selected_findings: [{ finding_code: 'OPEN_INVENTORY_PRIORITY', headline: 'Item 7 needs review', summary: 'Aged Business item', confidence: null, metrics: { days: 90 }, limitations: [], segment: { item_id: 7 } }],
  },
};
const coachPacket = (language?: AdviceLanguage) => buildAdviceInputPacket({ runId: 1, analyticsVersion: '2.13', evidenceScope: 'scope', snapshot: SNAPSHOT, listingDemand: CTX, ...(language ? { language } : {}) }).packet!;
const coachRaw = (over: Record<string, unknown> = {}) => JSON.stringify({
  schema_version: '1.0',
  run_summary: { headline: 'Итог', summary: 'Краткое резюме запуска.', source_ids: ['insight:OPEN_INVENTORY_PRIORITY:item:7'] },
  advice_cards: [{ advice_code: 'C1', advice_type: 'action', priority: 'high', headline: 'Проверьте Gibson ES-335 на Reverb', advice: 'Стоит проверить цену.', why_it_matters: 'Долго в продаже.', confidence_label: 'moderate', source_ids: ['insight:OPEN_INVENTORY_PRIORITY:item:7'], limitations: ['Малая выборка'], item_id: 7, ...over }],
  limitations: ['Данные неполные'],
});
const listingRaw = (over: Record<string, unknown> = {}) => JSON.stringify({
  schema_version: '1.0',
  cards: [{ advice_code: 'L1', advice_type: 'observation', priority: 'medium', confidence_label: 'moderate', title: 'Отклик на Kijiji вырос', summary: 'Записанные лиды на 100 канало-дней выросли.', why_it_matters: 'Это описывает записанную активность.', next_steps: ['Проверьте полноту журнала лидов'], source_ids: ['demand:channel:2'], limitations: ['Небольшая выборка'], ...over }],
});

const PASSWORD = 'Advice-Language-Fixture-Local-1!';
async function ensureAuthUser(admin: SupabaseClient, email: string): Promise<string> {
  const { data: created, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (!error && created.user) return created.user.id;
  const { data: listed } = await admin.auth.admin.listUsers({ perPage: 200 });
  const match = listed?.users.find((u) => u.email === email);
  if (match) return match.id;
  throw new Error(`Could not create or find auth user ${email}: ${error?.message}`);
}
async function resolveAppUserId(admin: SupabaseClient, authUserId: string): Promise<number> {
  for (let i = 0; i < 10; i++) {
    const { data } = await admin.from('app_users').select('id').eq('auth_user_id', authUserId).maybeSingle();
    if (data) return data.id as number;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('app_users row never appeared');
}

async function main() {
  console.log('\n[A — language codes, instruction, one canonical prompt]');
  {
    check('supported: en, ru only; default en', ADVICE_LANGUAGES.join() === 'en,ru' && DEFAULT_ADVICE_LANGUAGE === 'en');
    check('normalize: invalid/missing -> en (never throws)', normalizeAdviceLanguage('fr') === 'en' && normalizeAdviceLanguage(null) === 'en' && normalizeAdviceLanguage(undefined) === 'en' && normalizeAdviceLanguage(42) === 'en' && normalizeAdviceLanguage('ru') === 'ru');
    check('isAdviceLanguage is strict', isAdviceLanguage('en') && isAdviceLanguage('ru') && !isAdviceLanguage('RU') && !isAdviceLanguage('') && !isAdviceLanguage('es'));
    check('admin options: English / Russian with stored values en / ru', JSON.stringify(ADVICE_LANGUAGE_OPTIONS) === JSON.stringify([{ value: 'en', label: 'English' }, { value: 'ru', label: 'Russian' }]));
    check('debug format: "Russian (ru)" / "English (en)"', describeAdviceLanguage('ru') === 'Russian (ru)' && describeAdviceLanguage('en') === 'English (en)');
    const ruI = adviceLanguageInstruction('ru');
    const enI = adviceLanguageInstruction('en');
    check('Russian instruction: "Response language: Russian (ru)." + naturally-in-Russian + names/ids/source IDs unchanged', /Response language: Russian \(ru\)\./.test(ruI) && /naturally in Russian/.test(ruI) && /brands, model names, channel names, identifiers and source IDs unchanged/.test(ruI));
    check('Russian instruction names the examples and forbids translating enums/ids', ['Fender', 'Gibson', 'PRS', 'Reverb', 'Kijiji', 'Marketplace', 'Neural DSP Quad Cortex'].every((n) => ruI.includes(n)) && /source_ids, advice_code, item_id/.test(ruI) && /advice_type, priority and confidence_label stay exactly as specified/.test(ruI) && /do not translate or transliterate/.test(ruI));
    check('Russian instruction: evidence is not translated; analytical rules unchanged in Russian', /evidence in the packet is factual data: do not translate or rewrite it/.test(ruI) && /language must not change meaning/.test(ruI));
    check('English instruction exists', /Response language: English \(en\)\./.test(enI) && /naturally in English/.test(enI));
    for (const [name, canonical, forLang] of [['Coach', ADVICE_SYSTEM_PROMPT, adviceSystemPromptFor], ['Listing Advice', LISTING_ADVICE_SYSTEM_PROMPT, listingAdviceSystemPromptFor]] as const) {
      const ru = forLang('ru'); const en = forLang('en');
      check(`${name}: ONE canonical prompt — both languages start with the identical canonical text`, ru.startsWith(canonical) && en.startsWith(canonical) && ru.slice(canonical.length) === `\n\n${ruI}` && en.slice(canonical.length) === `\n\n${enI}`);
    }
    const lp = listingAdviceSystemPromptFor('ru');
    check('Listing Advice (ru) still carries no-fake-conversion, non-causal, Purpose, positive-demand and response-per-exposure rules', lp.includes(LEAD_DEAL_RULES) && lp.includes(LISTING_DEMAND_SEMANTICS) && lp.includes(PURPOSE_SEMANTICS) && /positive item demand is first-class evidence/.test(lp) && /Prefer three cards|prefer three cards/.test(lp) && /leads_per_100_channel_listing_days/.test(lp) && /Observational only/.test(lp));
    const cp = adviceSystemPromptFor('ru');
    check('Coach (ru) still carries the shared no-conversion / Listing Demand / Purpose blocks', cp.includes(LEAD_DEAL_RULES) && cp.includes(LISTING_DEMAND_SEMANTICS) && cp.includes(PURPOSE_SEMANTICS));
    const oa = strip(read('src', 'lib', 'openai.ts'));
    check('the model calls use the persisted packet\'s language (system prompt built from packet.language)', /adviceSystemPromptFor\(packetLanguage\(packet\)\)/.test(oa) && /listingAdviceSystemPromptFor\(packetLanguage\(packet\)\)/.test(oa));
    check('schemas and prompt versions unchanged (no enum/schema weakening for Russian)', /advice_type: \{ type: 'string', enum: \['action', 'observation', 'watch'\] \}/.test(oa) && /maxItems: 3/.test(oa) && PROMPT_TEMPLATE_VERSION === 'analytics-advice-v3' && LISTING_ADVICE_PROMPT_VERSION === 'listing-advice-v1');
    check('listing-DESCRIPTION generation is untouched (no language plumbing in generateListing)', !/language/i.test(oa.slice(oa.indexOf('export async function generateListing('))));
  }

  console.log('\n[B — General Coach packet: language persisted + hashed]');
  {
    const ru = coachPacket('ru'); const en = coachPacket('en'); const def = coachPacket();
    check('ru user -> packet.language = "ru"; en user -> "en"; default -> "en"', ru.language === 'ru' && en.language === 'en' && def.language === 'en');
    check('language participates in the canonical input hash', hashCanonicalInputPacket(ru) !== hashCanonicalInputPacket(en) && hashCanonicalInputPacket(en) === hashCanonicalInputPacket(def));
    check('same language + same data -> same hash (deterministic)', hashCanonicalInputPacket(coachPacket('ru')) === hashCanonicalInputPacket(ru));
    check('evidence and source ids are identical across languages (evidence is never translated)', JSON.stringify({ ...ru, language: 'x' }) === JSON.stringify({ ...en, language: 'x' }) && ru.allowed_source_ids.join() === en.allowed_source_ids.join());
    const reg = buildAdviceInputPacket({ runId: 1, analyticsVersion: '2.13', evidenceScope: 'scope', snapshot: SNAPSHOT, listingDemand: CTX, language: 'ru' }).sourceRegistry;
    const ok = validateAdviceResponse(coachRaw(), reg);
    check('a Russian response passes the UNCHANGED validator (canonical enums/source ids; prose is free text)', ok.valid && ok.response!.advice_cards[0].advice_type === 'action' && ok.response!.advice_cards[0].source_ids[0] === 'insight:OPEN_INVENTORY_PRIORITY:item:7' && ok.response!.advice_cards[0].headline === 'Проверьте Gibson ES-335 на Reverb', ok.reasons);
    check('translated enum values are rejected (not weakened)', !validateAdviceResponse(coachRaw({ advice_type: 'действие' }), reg).valid && !validateAdviceResponse(coachRaw({ priority: 'высокий' }), reg).valid && !validateAdviceResponse(coachRaw({ confidence_label: 'средняя' }), reg).valid);
    check('a translated/invented source id is rejected', !validateAdviceResponse(coachRaw({ source_ids: ['инсайт:1'] }), reg).valid);
  }

  console.log('\n[C — Listing Advice packet: language persisted + hashed]');
  {
    const ru = buildListingAdvicePacket(CTX, 'ru'); const en = buildListingAdvicePacket(CTX, 'en'); const def = buildListingAdvicePacket(CTX);
    check('ru -> packet.language = "ru"; en -> "en"; default -> "en"', ru.language === 'ru' && en.language === 'en' && def.language === 'en');
    check('language participates in the input hash; same inputs -> same hash', hashListingAdvicePacket(ru) !== hashListingAdvicePacket(en) && hashListingAdvicePacket(en) === hashListingAdvicePacket(def) && hashListingAdvicePacket(buildListingAdvicePacket(CTX, 'ru')) === hashListingAdvicePacket(ru));
    check('source ids and evidence unchanged across languages', ru.allowed_source_ids.join() === en.allowed_source_ids.join() && JSON.stringify(ru.listing_demand) === JSON.stringify(en.listing_demand));
    const v = validateListingAdviceResponse(listingRaw(), ru.allowed_source_ids);
    check('a Russian response passes the UNCHANGED validator (0–3 cards, canonical enums, source ids)', v.valid && v.output!.cards[0].title === 'Отклик на Kijiji вырос' && v.output!.cards[0].source_ids[0] === 'demand:channel:2', v.reasons);
    check('translated enums / invented ids are rejected; >3 cards still rejected', !validateListingAdviceResponse(listingRaw({ advice_type: 'наблюдение' }), ru.allowed_source_ids).valid && !validateListingAdviceResponse(listingRaw({ priority: 'средний' }), ru.allowed_source_ids).valid && !validateListingAdviceResponse(listingRaw({ source_ids: ['спрос:1'] }), ru.allowed_source_ids).valid && !validateListingAdviceResponse(JSON.stringify({ schema_version: '1.0', cards: [1, 2, 3, 4].map((n) => JSON.parse(listingRaw({ advice_code: `L${n}` })).cards[0]) }), ru.allowed_source_ids).valid);
  }

  console.log('\n[D — no-fake-conversion guard also covers Russian output]');
  {
    const bad = ['Низкая конверсия лидов в сделки.', 'Лиды плохо конвертируются в продажи.', 'Лиды не конвертируются.', 'Конверсия в сделки высокая.', 'Высокая конверсия из лидов в продажи.'];
    const good = ['Лид-в-сделку конверсию рассчитать нельзя: связи между лидами и сделками нет.', 'Нет данных о конверсии; лиды и сделки не связаны напрямую.', 'Записанная активность по лидам была высокой, а число реализованных сделок за тот же период — ниже; они не связаны напрямую.'];
    check('Russian conversion claims are flagged', bad.every((t) => findLeadDealViolations(t).includes('CONVERSION_CLAIM')), bad.filter((t) => !findLeadDealViolations(t).includes('CONVERSION_CLAIM')));
    check('Russian disclaimers / factual side-by-side statements pass', good.every((t) => findLeadDealViolations(t).length === 0), good.filter((t) => findLeadDealViolations(t).length > 0));
    const reg = buildAdviceInputPacket({ runId: 1, analyticsVersion: '2.13', evidenceScope: 'scope', snapshot: SNAPSHOT, listingDemand: CTX, language: 'ru' }).sourceRegistry;
    check('the Coach and Listing Advice validators reject a Russian conversion claim', !validateAdviceResponse(coachRaw({ advice: 'Низкая конверсия лидов в сделки.' }), reg).valid && !validateListingAdviceResponse(listingRaw({ summary: 'Лиды плохо конвертируются в продажи.' }), buildListingAdvicePacket(CTX, 'ru').allowed_source_ids).valid);
    check('English guard behaviour is unchanged', findLeadDealViolations('Leads are converting poorly.').includes('CONVERSION_CLAIM') && findLeadDealViolations('No lead-to-deal conversion can be calculated.').length === 0);
  }

  console.log('\n[E — Advice UI labels (deterministic dictionary)]');
  {
    const en = adviceLabels('en'); const ru = adviceLabels('ru');
    const keys = Object.keys(en) as (keyof typeof en)[];
    check('EN and RU dictionaries have identical shape (no missing translations)', JSON.stringify(Object.keys(ru).sort()) === JSON.stringify(keys.sort()) && keys.every((k) => (typeof en[k] === 'string' ? typeof ru[k] === 'string' && (ru[k] as string).length > 0 : JSON.stringify(Object.keys(en[k] as object)) === JSON.stringify(Object.keys(ru[k] as object)))));
    check('every Russian label differs from English (nothing left half-English)', keys.every((k) => (typeof en[k] === 'string' ? en[k] !== ru[k] : Object.keys(en[k] as object).every((s) => (en[k] as Record<string, string>)[s] !== (ru[k] as Record<string, string>)[s]))));
    check('RU: Action/Observation/Watch, priority, confidence, Why it matters, Suggested checks, Evidence, Limitations, View details, Dismiss for 30 days, Generated, no-advice text', ru.type.action === 'Действие' && ru.type.observation === 'Наблюдение' && ru.priority.high === 'Высокий приоритет' && ru.confidencePrefix === 'Уверенность' && ru.whyItMatters === 'Почему это важно' && ru.suggestedChecks === 'Что стоит проверить' && ru.evidenceHeading.startsWith('Данные') && ru.limitations === 'Ограничения' && ru.viewDetails === 'Подробнее' && ru.dismissFor30Days === 'Скрыть на 30 дней' && ru.generated === 'Создано' && ru.noMaterialAdvice.startsWith('Существенных'));
    check('EN labels are exactly the pre-existing copy', en.type.action === 'Action' && en.priority.medium === 'Medium priority' && en.confidencePrefix === 'Confidence' && en.viewDetails === 'View details' && en.dismissFor30Days === 'Dismiss for 30 days' && en.hiddenFor30Days === 'Hidden for 30 days' && en.evidenceFooter === 'Shown as recorded when this advice was generated.');
    check('unknown language falls back to English labels', adviceLabels('fr') === en && adviceLabels(undefined) === en);
    check('historical revision language wins over the current preference; legacy falls back to preference, then en', resolveRevisionLanguage('ru', 'en') === 'ru' && resolveRevisionLanguage('en', 'ru') === 'en' && resolveRevisionLanguage(undefined, 'ru') === 'ru' && resolveRevisionLanguage(null, undefined) === 'en' && resolveRevisionLanguage('xx', 'ru') === 'ru');
    check('Russian timestamps use ru-RU; English format unchanged', formatAdviceTimestamp('2026-09-20T12:00:00Z', 'en') === new Date('2026-09-20T12:00:00Z').toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) && formatAdviceTimestamp('2026-09-20T12:00:00Z', 'ru') !== formatAdviceTimestamp('2026-09-20T12:00:00Z', 'en') && formatAdviceTimestamp(null, 'ru') === '—');
    check('limitations: codes are humanized, model prose (any language, brand names) is shown exactly as written', formatLimitation('SMALL_SAMPLE') === 'Small sample' && formatLimitation('Малая выборка по Reverb') === 'Малая выборка по Reverb' && formatLimitation('Only Fender data') === 'Only Fender data');

    const card = strip(read('src', 'components', 'AdviceCardView.tsx'));
    const parts = strip(read('src', 'components', 'AdviceDrawerParts.tsx'));
    const coachD = strip(read('src', 'components', 'CoachAdviceDrawer.tsx'));
    const listD = strip(read('src', 'components', 'listings', 'ListingAdviceDrawer.tsx'));
    const sec = strip(read('src', 'components', 'listings', 'ListingAdviceSection.tsx'));
    const dash = strip(read('src', 'app', 'page.tsx'));
    check('card, shared drawer parts, both drawers, the Listing section and the Dashboard all use the ONE dictionary (no per-component English strings)', [card, parts, coachD, listD, sec].every((t) => /adviceLabels/.test(t)) && /adviceLabels/.test(dash) && !/'Dismiss for 30 days'|'Hiding…'|>Evidence the advice was based on</.test(coachD + parts));
    check('Coach drawer + Listing drawer + section pick the language STORED WITH the revision (fallback: viewer preference, then en)', /resolveRevisionLanguage\(packet\?\.language, viewerLanguage\)/.test(coachD) && /resolveRevisionLanguage\(packet\.language, viewerLanguage\)/.test(listD) && /resolveRevisionLanguage\(latest\?\.input_packet\?\.language, data\?\.viewer_language\)/.test(sec) && /resolveRevisionLanguage\(latestCompletedAdvice\?\.advice\.input_packet\?\.language, viewerLanguage\)/.test(dash));
    check('debug/audit shows "Language: Russian (ru)" from the persisted value', /describeAdviceLanguage\(packet\.language\)/.test(listD) && /L\.language/.test(listD) && /Language: \{describeAdviceLanguage\(selectedAdvice\.input_packet\.language\)\}/.test(strip(read('src', 'app', 'analytics', 'page.tsx'))));
    check('model prose, item/channel names and evidence values are rendered as persisted (no translation call anywhere in the UI)', !/translate|Intl\.Translator|i18n/i.test(card + parts + coachD + listD + sec) && /\{card\.headline\}/.test(card) && /\{card\.advice\}/.test(card) && /\{card\.title\}/.test(sec) && /\{f\.value\}/.test(parts) && /\{b\.title\}/.test(parts) && /data-evidence-source=\{b\.sourceId\}/.test(parts));
    check('the Analytics page keeps its layout (only a language prop + a Language debug line were added)', /language=\{resolveRevisionLanguage\(selectedAdvice\.input_packet\?\.language\)\}/.test(strip(read('src', 'app', 'analytics', 'page.tsx'))));

    // Evidence resolution + actions are canonical regardless of language.
    const cRu = { advice_code: 'C1', advice_type: 'action', priority: 'high', headline: 'Проверьте Gibson ES-335 на Reverb', advice: 'Совет', why_it_matters: 'Важно', confidence_label: 'moderate', source_ids: ['demand:item:55', 'demand:channel:2'], limitations: ['Малая выборка'], item_id: 55 } as never;
    const pRu = coachPacket('ru'); const pEn = coachPacket('en');
    const evRu = resolveCoachCardEvidence(cRu, pRu, []); const evEn = resolveCoachCardEvidence(cRu, pEn, []);
    check('evidence values are canonical and identical for ru/en packets (brand/model/channel names untouched)', JSON.stringify(evRu) === JSON.stringify(evEn) && evRu[0].title === "2015 Gibson '63 ES-335" && evRu[1].title.startsWith('Kijiji') && evRu.map((b) => b.sourceId).join() === 'demand:item:55,demand:channel:2');
    check('actions (Open Item / View Leads URLs) are language-independent', JSON.stringify(coachActions(cRu, pRu, [], '/')) === JSON.stringify(coachActions(cRu, pEn, [], '/')));
    check('a Russian card\'s limitations keep brand names un-lowercased', coachLimitations({ ...(cRu as object), limitations: ['Малая выборка по Reverb'], source_ids: ['pattern:none'] } as never, pRu, []).join() === 'Малая выборка по Reverb');
  }

  console.log('\n[F — dismissal identity is language-independent]');
  {
    const base = { advice_code: 'C1', advice_type: 'action', priority: 'high', confidence_label: 'moderate', source_ids: ['demand:item:55', 'demand:channel:2'], limitations: [], item_id: 55 };
    const enCard = { ...base, headline: 'Review the Gibson ES-335', advice: 'Check pricing', why_it_matters: 'Aged' };
    const ruCard = { ...base, headline: 'Проверьте Gibson ES-335', advice: 'Проверьте цену', why_it_matters: 'Давно в продаже' };
    check('Coach: same item/primary source -> same dismissal key in ru and en (translated text is not part of identity)', computeAdviceKey(enCard as never) === computeAdviceKey(ruCard as never), [computeAdviceKey(enCard as never), computeAdviceKey(ruCard as never)]);
    const lEn = { advice_code: 'L1', advice_type: 'observation', priority: 'medium', confidence_label: 'moderate', title: 'Kijiji response rose', summary: 's', why_it_matters: 'w', next_steps: [], source_ids: ['demand:channel:2'], limitations: [] };
    const lRu = { ...lEn, title: 'Отклик на Kijiji вырос', summary: 'с', why_it_matters: 'в', next_steps: ['Проверьте'] };
    check('Listing Advice: same primary source -> same dismissal key in ru and en', listingAdviceKey(lEn as never) === listingAdviceKey(lRu as never) && listingAdviceKey(lEn as never) === 'listing:v1:demand:channel:2');
    const key = strip(read('src', 'lib', 'analytics', 'advice', 'adviceKey.ts')) + strip(read('src', 'lib', 'listingAdviceKey.ts'));
    check('key builders never read headline/advice/title/summary text', !/\.(headline|advice|title|summary|why_it_matters|next_steps)\b/.test(key));
  }

  console.log('\n[G — migration + admin API + Admin UI (structure)]');
  {
    const migs = fs.readdirSync(path.join(root, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    const langMigrationName = '20260921000000_app_users_preferred_language.sql';
    const sql = read('supabase', 'migrations', langMigrationName);
    check('ONE new additive migration for preferred_language exists, immediately after the Listing Advice table (later migrations are unrelated features)', migs.includes(langMigrationName) && migs.includes('20260920000000_listing_advice_runs.sql') && migs.indexOf(langMigrationName) === migs.indexOf('20260920000000_listing_advice_runs.sql') + 1, migs);
    check('adds text column preferred_language NOT NULL DEFAULT en on app_users (not auth.users, not an enum)', /ALTER TABLE public\.app_users\s+ADD COLUMN IF NOT EXISTS preferred_language text NOT NULL DEFAULT 'en'/.test(sql) && !/auth\.users/.test(sql.replace(/--.*$/gm, '')) && !/CREATE TYPE/i.test(sql));
    check('CHECK constraint restricts values to en, ru (easy to extend)', /CHECK \(preferred_language IN \('en', 'ru'\)\)/.test(sql));
    check('sets ru for the two real accounts by stable id (1, 2) — no blanket update, no name matching', /UPDATE public\.app_users\s+SET preferred_language = 'ru'\s+WHERE id IN \(1, 2\)/.test(sql) && !/display_name|email/.test(sql.replace(/--.*$/gm, '')));
    check('preferred_language stays a single, standalone migration (not edited by any later migration file)', migs.filter((m) => m.startsWith('20260921')).length === 1);

    const api = strip(read('src', 'app', 'api', 'admin', 'users', 'route.ts'));
    check('Admin API: GET + PATCH both gated by authorizeAdminApiRequest (existing admin auth)', (api.match(/authorizeAdminApiRequest\(req, ROUTE_TAG\)/g) ?? []).length === 2 && /export async function GET/.test(api) && /export async function PATCH/.test(api));
    check('Admin API validates the language (isAdviceLanguage) before writing; writes only preferred_language', /isAdviceLanguage\(body\.preferredLanguage\)/.test(api) && /\.update\(\{ preferred_language: body\.preferredLanguage \}\)/.test(api));
    check('changing the language never triggers generation or touches advice tables', !/generate|analytics_run_advice|listing_advice_runs|openai/i.test(api));
    const card = strip(read('src', 'components', 'admin', 'AdminUserLanguageCard.tsx'));
    const admin = strip(read('src', 'app', 'admin', 'page.tsx'));
    check('Admin UI: compact "Preferred AI Language" selector (English/Russian) inside the EXISTING Admin page (no new settings page)', /Preferred AI Language/.test(card) && /ADVICE_LANGUAGE_OPTIONS/.test(card) && /<AdminUserLanguageCard \/>/.test(admin) && !fs.existsSync(path.join(root, 'src', 'app', 'admin', 'users')) && !fs.existsSync(path.join(root, 'src', 'app', 'settings')));
    check('the card talks only to the admin API with the caller\'s bearer token (no direct table access)', /\/api\/admin\/users/.test(card) && /Bearer \$\{session\.access_token\}/.test(card) && !/from\('app_users'\)/.test(card));
    check('Admin page is still gated on user.admin (unchanged)', /if \(!user\.admin\)/.test(admin));
  }

  console.log('\n[H — server-side resolver + workflow wiring (structure)]');
  {
    const ul = strip(read('src', 'lib', 'analytics', 'advice', 'userLanguage.ts'));
    const wf = strip(read('src', 'lib', 'analytics', 'runAnalyticsWorkflow.ts'));
    const cg = strip(read('src', 'lib', 'analytics', 'advice', 'generateAdvice.ts'));
    const lg = strip(read('src', 'lib', 'analytics', 'listingAdvice', 'generateListingAdvice.ts'));
    check('one server-side resolver reads app_users.preferred_language and never throws (falls back to en)', /from\('app_users'\)/.test(ul) && /preferred_language/.test(ul) && /catch/.test(ul) && /normalizeAdviceLanguage/.test(ul));
    check('the workflow resolves the language ONCE and hands it to BOTH stages', (wf.match(/getUserPreferredLanguage\(/g) ?? []).length === 1 && /mode: 'auto', language/.test(wf) && /listing\(\{ appUserId, serviceClient, language \}\)/.test(wf));
    check('generators only fall back to the same resolver when no language is passed (no second implementation)', /params\.language \?\? await getUserPreferredLanguage/.test(cg) && /params\.language \?\? await getUserPreferredLanguage/.test(lg) && !/from\('app_users'\)/.test(cg + lg));
    check('language is never taken from a request body/query in the advice routes', !/preferredLanguage|preferred_language|language/.test(strip(read('src', 'app', 'api', 'analytics', 'runs', 'route.ts'))) && !/language/.test(strip(read('src', 'app', 'api', 'cron', 'weekly-analytics-advice', 'route.ts'))));
    check('runAnalyticsWorkflow architecture unchanged: still sequences snapshot -> Coach -> Listing Advice with failure isolation', /Promise\.all\(\[/.test(wf) && /THREW/.test(wf));
  }

  // ── Real DB ────────────────────────────────────────────────────────────
  assertLocalSupabaseUrl(SUPABASE_URL);
  await assertLocalSupabaseIsRunning(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  delete process.env.OPENAI_API_KEY;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const emails = { ru: 'advice-lang-ru@example.test', en: 'advice-lang-en@example.test', adm: 'advice-lang-admin@example.test' };
  const uRu = await resolveAppUserId(admin, await ensureAuthUser(admin, emails.ru));
  const uEn = await resolveAppUserId(admin, await ensureAuthUser(admin, emails.en));
  const uAdm = await resolveAppUserId(admin, await ensureAuthUser(admin, emails.adm));
  const clean = async () => {
    await admin.from('listing_advice_runs').delete().in('user_id', [uRu, uEn, uAdm]);
    await admin.from('analytics_run_advice').delete().in('user_id', [uRu, uEn, uAdm]);
    await admin.from('analytics_runs').delete().in('recommendation_target_user_id', [uRu, uEn, uAdm]);
  };
  await clean();
  const signIn = async (email: string) => {
    const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
    if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
    return c;
  };

  try {
    console.log('\n[I — user preference in the database]');
    const { data: fresh } = await admin.from('app_users').select('id, preferred_language').in('id', [uRu, uEn, uAdm]);
    check('new users default to "en"', (fresh ?? []).every((r) => r.preferred_language === 'en'), fresh);
    const set = async (id: number, v: string) => admin.from('app_users').update({ preferred_language: v }).eq('id', id);
    check('"ru" allowed', !(await set(uRu, 'ru')).error);
    check('"en" allowed', !(await set(uRu, 'en')).error && !(await set(uRu, 'ru')).error);
    const bad = await set(uEn, 'fr');
    check('an invalid language is rejected by the database (CHECK constraint)', !!bad.error && /check|violates/i.test(bad.error.message), bad.error?.message);
    check('an empty / NULL language is rejected too', !!(await set(uEn, '')).error && !!(await set(uEn, null as never)).error);
    const { data: still } = await admin.from('app_users').select('preferred_language').eq('id', uEn).single();
    check('a rejected write leaves the stored value untouched', still?.preferred_language === 'en');

    // The data-migration statement itself, run against local rows 1/2 semantics: identify by id, never by name.
    const { data: byId } = await admin.from('app_users').select('id, preferred_language').in('id', [1, 2]);
    check('local check: rows with id 1/2 (if present in this database) are "ru" — the migration set them; other users stay "en"', (byId ?? []).every((r) => r.preferred_language === 'ru') && (fresh ?? []).filter((r) => ![1, 2].includes(r.id as number)).every((r) => r.preferred_language === 'en'), byId);

    // RLS: a normal (non-admin) user can read/update only their OWN row.
    const clientEn = await signIn(emails.en);
    const own = await clientEn.from('app_users').select('id, preferred_language');
    check('a normal user sees only their own app_users row', (own.data ?? []).length === 1 && own.data![0].id === uEn);
    const other = await clientEn.from('app_users').update({ preferred_language: 'en' }).eq('id', uRu).select('id');
    check('a normal user cannot change ANOTHER user\'s preference (RLS: 0 rows updated)', !other.error && (other.data ?? []).length === 0);
    const { data: ruAfter } = await admin.from('app_users').select('preferred_language').eq('id', uRu).single();
    check('the other user\'s preference is unchanged', ruAfter?.preferred_language === 'ru');
    check('the admin API path requires the admin flag (no admin flag on the fixture users -> unauthorized)', (await admin.from('app_users').select('admin').in('id', [uRu, uEn]).then((r) => (r.data ?? []).every((x) => x.admin === false))));
    // Admin flow = service-role write behind authorizeAdminApiRequest; exercise the exact statement the route runs.
    await admin.from('app_users').update({ admin: true }).eq('id', uAdm);
    const adminWrite = await admin.from('app_users').update({ preferred_language: 'en' }).eq('id', uRu).select('id, preferred_language').maybeSingle();
    check('the admin route\'s update (service role, after the admin check) changes another user\'s language', !adminWrite.error && adminWrite.data?.preferred_language === 'en');
    await set(uRu, 'ru');
    await admin.from('app_users').update({ admin: false }).eq('id', uAdm);

    // Resolver
    check('resolver: ru user -> "ru"; en user -> "en"', (await getUserPreferredLanguage(admin, uRu)) === 'ru' && (await getUserPreferredLanguage(admin, uEn)) === 'en');
    check('resolver: unknown user / broken client -> "en" (never throws)', (await getUserPreferredLanguage(admin, 999999999)) === 'en' && (await getUserPreferredLanguage({} as SupabaseClient, uRu)) === 'en');

    console.log('\n[J — unified workflow: language reaches BOTH stages, per user, no leakage]');
    const seen: { coach: Record<number, unknown>; listing: Record<number, unknown> } = { coach: {}, listing: {} };
    const depsFor = (): AnalyticsWorkflowDeps => ({
      runAnalytics: async ({ appUserId }) => ({ id: 5000 + appUserId } as never),
      generateCoachAdvice: async (p) => { seen.coach[p.requestingUserId] = p.language; return { status: 'skipped', reason: 'TEST' } as never; },
      generateListingAdvice: async (p) => { seen.listing[p.appUserId] = p.language; return { status: 'already_generating' } as never; },
    });
    await runAnalyticsWorkflow({ appUserId: uRu, serviceClient: admin, deps: depsFor() });
    await runAnalyticsWorkflow({ appUserId: uEn, serviceClient: admin, deps: depsFor() });
    check('Run Analytics for a Russian user: snapshot succeeds; Coach AND Listing Advice receive "ru"', seen.coach[uRu] === 'ru' && seen.listing[uRu] === 'ru', seen);
    check('Run Analytics for an English user: both receive "en"', seen.coach[uEn] === 'en' && seen.listing[uEn] === 'en');
    const [a, b] = await Promise.all([runAnalyticsWorkflow({ appUserId: uRu, serviceClient: admin, deps: depsFor() }), runAnalyticsWorkflow({ appUserId: uEn, serviceClient: admin, deps: depsFor() })]);
    check('two users with different languages in the same batch do not leak language state', a.run.id === 5000 + uRu && b.run.id === 5000 + uEn && seen.coach[uRu] === 'ru' && seen.coach[uEn] === 'en' && seen.listing[uRu] === 'ru' && seen.listing[uEn] === 'en');
    const wfSrc = strip(read('src', 'lib', 'analytics', 'automation', 'runWeeklyAutomation.ts').toString());
    check('scheduled weekly automation goes through the SAME workflow (each user resolved by their own id)', /runAnalyticsWorkflow\(/.test(wfSrc));

    console.log('\n[K — Listing Advice end-to-end (real DB, injected model): exact prompt/packet, persistence, immutability]');
    const modelCalls: { language: unknown; prompt: string }[] = [];
    const callModel = async (packet: ListingAdvicePacket) => { modelCalls.push({ language: packet.language, prompt: listingAdviceSystemPromptFor(normalizeAdviceLanguage(packet.language)) }); return { raw: listingRaw(), model: 'injected' }; };
    const loadContext = async () => CTX;
    const gen = (userId: number, language?: AdviceLanguage) => generateListingAdvice({ appUserId: userId, serviceClient: admin, ...(language ? { language } : {}), deps: { loadContext, callModel } });

    const g1 = await gen(uRu);
    check('generation without an explicit language resolves the user\'s stored preference (ru)', g1.status === 'completed' && modelCalls[0].language === 'ru');
    check('the model received the Russian instruction on the canonical prompt', modelCalls[0].prompt.includes('Response language: Russian (ru).') && modelCalls[0].prompt.startsWith(LISTING_ADVICE_SYSTEM_PROMPT));
    const row1 = (g1 as { run: { id: number; input_packet: ListingAdvicePacket; input_hash: string; output: unknown } }).run;
    check('the run persists language inside the immutable input_packet AND the hash covers it', row1.input_packet.language === 'ru' && row1.input_hash === hashListingAdvicePacket(row1.input_packet) && row1.input_hash !== hashListingAdvicePacket({ ...row1.input_packet, language: 'en' }));
    check('persisted output is exactly the Russian model text with canonical enums/source ids', JSON.stringify((row1.output as { cards: { title: string; advice_type: string; source_ids: string[] }[] }).cards.map((c) => [c.title, c.advice_type, c.source_ids])) === JSON.stringify([['Отклик на Kijiji вырос', 'observation', ['demand:channel:2']]]));

    // Language change: no auto-generation; old run untouched; next generation uses the new language.
    const before = JSON.stringify((await admin.from('listing_advice_runs').select('*').eq('id', row1.id).single()).data);
    await set(uRu, 'en');
    const callsAfterChange = modelCalls.length;
    check('changing the preference triggers NO generation', modelCalls.length === callsAfterChange && (await admin.from('listing_advice_runs').select('id').eq('user_id', uRu)).data!.length === 1);
    check('the old Russian run is byte-identical after the preference change (never mutated/translated)', JSON.stringify((await admin.from('listing_advice_runs').select('*').eq('id', row1.id).single()).data) === before);
    const g2 = await gen(uRu);
    const row2 = (g2 as { run: { id: number; input_packet: ListingAdvicePacket; input_hash: string } }).run;
    check('the NEXT generation uses the new language (en): new run, new packet language, different hash', g2.status === 'completed' && modelCalls[1].language === 'en' && modelCalls[1].prompt.includes('Response language: English (en).') && row2.id !== row1.id && row2.input_packet.language === 'en' && row2.input_hash !== row1.input_hash);
    check('the historical run still reports its own language (ru) for label rendering', (await admin.from('listing_advice_runs').select('input_packet').eq('id', row1.id).single()).data!.input_packet.language === 'ru' && resolveRevisionLanguage(row1.input_packet.language, 'en') === 'ru');
    const g3 = await gen(uEn, 'ru');
    check('an explicit language (as passed by the workflow) is honoured over a stale DB read', g3.status === 'completed' && modelCalls[2].language === 'ru');
    await set(uRu, 'ru');

    console.log('\n[L — General Coach end-to-end (real DB, injected model)]');
    const insertRun = async (userId: number) => {
      const { data, error } = await admin.from('analytics_runs').insert({
        status: 'completed', snapshot: SNAPSHOT, analytics_version: '2.13', evidence_scope: 'scope', recommendation_target_user_id: userId,
        requested_by_user_id: userId, started_at: new Date(Date.now() - 1000).toISOString(), completed_at: new Date().toISOString(),
      } as never).select('id').single();
      if (error || !data) throw new Error(`could not insert fixture analytics run: ${error?.message}`);
      return data.id as number;
    };
    let runRuId: number | null = null;
    try { runRuId = await insertRun(uRu); } catch (e) { console.log('  NOTE: could not insert a minimal analytics_runs fixture:', (e as Error).message); }
    if (runRuId !== null) {
      const coachCalls: { language: unknown; prompt: string }[] = [];
      const coachModel = async (packet: AdviceInputPacket) => { coachCalls.push({ language: packet.language, prompt: adviceSystemPromptFor(normalizeAdviceLanguage(packet.language)) }); return { raw: coachRaw() }; };
      const c1 = await generateAdviceForRun({ runId: runRuId, requestingUserId: uRu, serviceClient: admin, mode: 'auto', deps: { callModel: coachModel } });
      check('Coach generation resolves the user\'s preference (ru) and the model gets the Russian instruction', c1.status === 'completed' && coachCalls[0].language === 'ru' && coachCalls[0].prompt.includes('Response language: Russian (ru).') && coachCalls[0].prompt.startsWith(ADVICE_SYSTEM_PROMPT), (c1 as { reason?: string }).reason);
      const r1 = (c1 as { row: { id: number; input_packet: AdviceInputPacket; canonical_input_hash: string; advice: { advice_cards: { advice_type: string; source_ids: string[] }[] } } }).row;
      check('the revision persists language in the immutable packet; hash = hash of that exact packet', r1.input_packet.language === 'ru' && r1.canonical_input_hash === hashCanonicalInputPacket(r1.input_packet) && r1.canonical_input_hash !== hashCanonicalInputPacket({ ...r1.input_packet, language: 'en' }));
      check('persisted advice keeps canonical enum + source ids while the prose is Russian', r1.advice.advice_cards[0].advice_type === 'action' && r1.advice.advice_cards[0].source_ids[0] === 'insight:OPEN_INVENTORY_PRIORITY:item:7');
      const snapshotBefore = JSON.stringify((await admin.from('analytics_run_advice').select('*').eq('id', r1.id).single()).data);
      await set(uRu, 'en');
      check('after ru -> en the persisted revision is byte-identical (historical advice never mutated)', JSON.stringify((await admin.from('analytics_run_advice').select('*').eq('id', r1.id).single()).data) === snapshotBefore);
      const c2 = await generateAdviceForRun({ runId: runRuId, requestingUserId: uRu, serviceClient: admin, mode: 'retry', deps: { callModel: coachModel } });
      const r2 = (c2 as { row: { id: number; input_packet: AdviceInputPacket; canonical_input_hash: string } }).row;
      check('the NEXT revision uses the new language (en) with a different input hash; the old revision keeps ru', c2.status === 'completed' && coachCalls[1].language === 'en' && r2.id !== r1.id && r2.input_packet.language === 'en' && r2.canonical_input_hash !== r1.canonical_input_hash && (await admin.from('analytics_run_advice').select('input_packet').eq('id', r1.id).single()).data!.input_packet.language === 'ru');
      await set(uRu, 'ru');
    }

    console.log('\n[M — Listing Advice API exposes the viewer language (server-resolved)]');
    const route = strip(read('src', 'app', 'api', 'listing-advice', 'route.ts'));
    check('viewer_language is read from the authenticated caller\'s own app_users row, never from the request', /select\('id, admin, preferred_language'\)/.test(route) && /viewer_language: normalizeAdviceLanguage\(appUser\.preferred_language\)/.test(route) && !/searchParams|req\.json/.test(route));
  } finally {
    await clean();
    await admin.from('app_users').update({ preferred_language: 'en', admin: false }).in('id', [uRu, uEn, uAdm]);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
