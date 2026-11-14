/**
 * test-dashboard-coach-advice.ts
 *
 * Regression coverage for the "General Business Coach has not shown new
 * advice" investigation (2026-10). Root cause: runAnalyticsWorkflow ->
 * generateAdviceForRun -> analytics_run_advice was working correctly every
 * week (a completed revision with cards was persisted every run, for both
 * real users) — the bug was in the Dashboard's OWN rendering (src/app/
 * page.tsx): when a completed revision's cards were ALL currently dismissed
 * (Advice Dismissal / Resurface v1 — the Coach deterministically re-raising
 * the same still-unresolved finding every week, already dismissed weeks
 * earlier), the Dashboard hid the ENTIRE section — header, timestamp, the
 * lot — exactly as if the Coach had generated nothing at all. This is a
 * pure source-level/structural check (no browser DOM renderer available in
 * this environment — same convention as test-analytics-advice.ts's own
 * Section H), plus a behavioral replay of the exact production scenario
 * found during investigation (both real users' latest run, Oct 8, had every
 * card dismissed).
 *
 * Control: src/components/listings/ListingAdviceSection.tsx already handled
 * this correctly (data-advice-all-dismissed / L.allDismissed) — see
 * test-listing-advice.ts's own "0 cards -> calm" assertions. This script
 * confirms the Dashboard's Coach section now matches that established
 * pattern via its own label (AL.allCoachAdviceDismissed), not the Listing
 * Advice one (the two surfaces have independent copy).
 *
 * 2026-11-13 (Weekly Coach Refresh): the section is now ONE Business Coach
 * (General Coach + compact Listing Actions) driven by the pure state model in
 * src/lib/analytics/coachState.ts. Covered here: visible / no material /
 * all dismissed (count + next resurface + View hidden) / none yet, a failed
 * latest refresh shown next to the previous successful advice, freshness and
 * staleness, resurface, and a replay of the 2026-11-13 production state
 * (user 1: revision #30 all dismissed, run #59 failed, Listing Advice from
 * Oct 22).
 *
 * No DB, no network. Usage:  npx tsx scripts/test-dashboard-coach-advice.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { adviceLabels, hiddenCountLabel } from '../src/lib/analytics/advice/adviceLabels';
import { COACH_STALE_AFTER_DAYS, deriveCoachModuleView, weeklyModuleFailureAt, type WeeklyCoachStatusPayload } from '../src/lib/analytics/coachState';
import { computeAdviceKey } from '../src/lib/analytics/advice/adviceKey';
import type { AdviceCard } from '../src/lib/analytics/advice/types';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const strip = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

function card(overrides: Partial<AdviceCard>): AdviceCard {
  return {
    advice_code: 'C1', advice_type: 'review', priority: 'medium',
    headline: 'Review item', advice: 'Consider reviewing this item.', why_it_matters: 'It matters.',
    confidence_label: 'moderate', source_ids: ['insight:SOME_FINDING:item:1'], limitations: [], item_id: 1,
    ...overrides,
  };
}

async function main() {
  console.log('\n[A — adviceLabels: new allCoachAdviceDismissed entry]');
  {
    const en = adviceLabels('en');
    const ru = adviceLabels('ru');
    check('EN label exists, non-empty, and is Coach-specific (not the Listing Advice copy)', typeof en.allCoachAdviceDismissed === 'string' && en.allCoachAdviceDismissed.length > 0 && en.allCoachAdviceDismissed !== en.allDismissed && /Business Coach/.test(en.allCoachAdviceDismissed));
    check('RU label exists, non-empty, and differs from EN', typeof ru.allCoachAdviceDismissed === 'string' && ru.allCoachAdviceDismissed.length > 0 && ru.allCoachAdviceDismissed !== en.allCoachAdviceDismissed);
    check('RU label is Coach-specific (not the Listing Advice RU copy)', ru.allCoachAdviceDismissed !== ru.allDismissed);
  }

  console.log('\n[B — Dashboard (src/app/page.tsx): one Business Coach section that never goes blank]');
  {
    const dash = strip(read('src', 'app', 'page.tsx'));
    check('the OLD bug stays gone: the section is not gated on (0 cards) || (something visible)', !/advice_cards\.length \?\? 0\) === 0 \|\| visibleAdviceCards\.length > 0/.test(dash));
    check('the section renders once loading finishes — even with NO completed revision (explicit "none yet")', /\{!adviceLoading && !dismissalsLoading && \(\s*<section[^>]*data-business-coach/.test(dash) && /generalView\.content === 'none_yet'[\s\S]*?AL\.coachNoneYet/.test(dash));
    check('0 cards generated -> "No material new advice this week." (distinct branch)', /generalView\.content === 'no_material'[\s\S]*?data-coach-no-material[\s\S]*?AL\.noMaterialThisWeek/.test(dash) && adviceLabels('en').noMaterialThisWeek === 'No material new advice this week.');
    check('all cards dismissed -> hidden summary (No new visible advice, count, next resurface, View hidden) — not blank', /visibleAdviceCards\.length === 0 \? \(\s*<HiddenAdviceList hidden=\{generalView\.hidden\} allHidden/.test(dash));
    check('cards visible -> compact AdviceCardView grid (+ a concise hidden count when some are dismissed)', /visibleAdviceCards\.map\(\(card\) =>/.test(dash) && /<AdviceCardView/.test(dash) && /<HiddenAdviceList hidden=\{generalView\.hidden\} allHidden=\{false\}/.test(dash));
    check('Resurface is wired for hidden General cards', /onResurface=\{handleResurface\}/.test(dash) && /resurfaceAdvice\(key\)/.test(dash));
    check('freshness: "Generated <date>" for the shown advice', /data-coach-generated[\s\S]*?AL\.generated/.test(dash));
    check('a failed latest refresh is stated next to the previous advice ("Latest refresh failed … Using advice generated …")', /generalView\.refreshFailedAt &&[\s\S]*?data-coach-refresh-failed[\s\S]*?AL\.latestRefreshFailed/.test(dash));
    check('weekly refresh status line (subtle): Weekly refresh: <state> <date> · Last successful: <date>', /data-coach-weekly-status[\s\S]*?AL\.weeklyRefresh[\s\S]*?AL\.weeklyState\[weeklyStatus\.state\][\s\S]*?AL\.lastSuccessful/.test(dash));
    check('"Refresh Coach" runs the same orchestration as the weekly refresh (POST /api/analytics/runs)', /data-refresh-coach/.test(dash) && /refreshCoach\(\)/.test(dash) && /'\/api\/analytics\/runs'/.test(strip(read('src', 'lib', 'analytics', 'listingAdvice', 'listingAdviceClient.ts'))));
    check('compact Listing Actions subsection is part of the Coach section', /<DashboardListingActions key=\{coachReloadToken\} weekly=\{weeklyStatus\}/.test(dash));
    check('no raw error detail is rendered on the Dashboard (only safe labels)', !/error_message|\.message\b/.test(dash.slice(dash.indexOf('data-business-coach'), dash.indexOf('<DashboardListingActions'))));
  }

  console.log('\n[C — Dashboard "Listing Actions" (src/components/DashboardListingActions.tsx)]');
  {
    const la = strip(read('src', 'components', 'DashboardListingActions.tsx'));
    check('reads the SAME latest completed Listing Advice as /listings (same SWR key), never generates', /useSwrResource\(listingsCache, LISTING_ADVICE_KEY, fetchLatestListingAdvice\)/.test(la) && !/refreshListingAdvice|generateListingAdvice|method: 'POST'/.test(la));
    check('Generated <date> · 4-week demand window', /data-listing-actions-freshness[\s\S]*?L\.generated[\s\S]*?L\.demandWindow/.test(la));
    check('stale / failed / none / no material / all hidden are each explicit (never omitted)', /data-listing-actions-stale/.test(la) && /data-listing-actions-failed/.test(la) && /data-listing-actions-none/.test(la) && /data-listing-actions-no-material[\s\S]*?L\.noMaterialListingActions/.test(la) && /view\.content === 'all_dismissed'/.test(la));
    check('compact: at most 3 cards and a "View all in Listings" link (detailed drawer stays on /listings)', /MAX_DASHBOARD_LISTING_CARDS = 3/.test(la) && /data-listing-actions-view-all/.test(la) && !/ListingAdviceDrawer/.test(la));
    check('Listing failures come from the run history AND this week\'s weekly Listing module', /data\?\.last_failure\?\.created_at/.test(la) && /weeklyModuleFailureAt\(weekly, 'listings'\)/.test(la));
  }

  const NOW = new Date('2026-11-13T15:00:00Z');
  const G = (cards: AdviceCard[], dismissals: [string, string][], generatedAt: string | null, failureTimes: (string | null)[] = [], hasOutput = true) =>
    deriveCoachModuleView({ hasOutput, cards, keyOf: computeAdviceKey, dismissals: new Map(dismissals), generatedAt, failureTimes, now: NOW });

  console.log('\n[D — state model: General Coach]');
  {
    const c1 = card({ advice_code: 'A1', item_id: 70, source_ids: ['insight:X:item:70'] });
    const c2 = card({ advice_code: 'A2', item_id: null, source_ids: ['demand:channel:1'] });
    const c3 = card({ advice_code: 'A3', item_id: 61, source_ids: ['insight:Y:item:61'] });
    const gen = '2026-11-12T02:02:06Z';

    const visible = G([c1, c2], [], gen);
    check('completed run + visible cards -> visible, counts 2/2/0', visible.content === 'visible' && visible.generatedCount === 2 && visible.visibleCount === 2 && visible.dismissedCount === 0);
    const none = G([], [], gen);
    check('completed run + 0 cards -> no_material (NOT all_dismissed, NOT failed)', none.content === 'no_material' && none.generatedCount === 0 && none.refreshFailedAt === null);
    const noneYet = G([], [], null, [], false);
    check('no completed revision at all -> none_yet', noneYet.content === 'none_yet' && noneYet.generatedAt === null);

    // Production replay (2026-11-13, user 1): revision #30 (Nov 5) has 3 cards, all dismissed; run #59 (Nov 12) failed.
    const prodGen = '2026-11-05T02:02:06.11Z';
    const prod = G([c1, c2, c3], [[computeAdviceKey(c1), '2026-11-18T00:00:00Z'], [computeAdviceKey(c2), '2026-12-07T00:00:00Z'], [computeAdviceKey(c3), '2026-12-07T00:00:00Z']], prodGen, ['2026-11-12T02:01:46.655Z']);
    check('PROD replay: 3 generated / 0 visible / 3 dismissed -> all_dismissed (section shown, never blank)', prod.content === 'all_dismissed' && prod.generatedCount === 3 && prod.visibleCount === 0 && prod.dismissedCount === 3);
    check('PROD replay: next suggestion may resurface Nov 18 (earliest of the three)', prod.nextResurfaceAt === '2026-11-18T00:00:00Z' && prod.hidden[0].card.advice_code === 'A1');
    check('PROD replay: the Nov 12 failure is reported next to the Nov 5 advice', prod.refreshFailedAt === '2026-11-12T02:01:46.655Z' && prod.generatedAt === prodGen);
    check('PROD replay: the last successful advice is still the one shown (a failure never hides it)', prod.hidden.length === 3 && prod.generatedAt === prodGen);
    check('"hidden" label: plural and singular forms', hiddenCountLabel(adviceLabels('en'), 3) === '3 current suggestions are hidden.' && hiddenCountLabel(adviceLabels('en'), 1) === '1 current suggestion is hidden.' && hiddenCountLabel(adviceLabels('ru'), 3).includes('3'));

    const olderFailure = G([c1], [], gen, ['2026-11-01T00:00:00Z']);
    check('a failure OLDER than the shown advice is not reported (that advice superseded it)', olderFailure.refreshFailedAt === null);
    const resurfaced = G([c1, c3], [[computeAdviceKey(c1), '2026-11-13T14:59:59Z'], [computeAdviceKey(c3), '2026-12-07T00:00:00Z']], gen);
    check('dismissed cards resurface correctly once resurface_after has passed', resurfaced.content === 'visible' && resurfaced.visible.map((c) => c.advice_code).join() === 'A1' && resurfaced.dismissedCount === 1);
    const partial = G([c1, c2, c3], [[computeAdviceKey(c1), '2026-11-18T00:00:00Z']], gen);
    check('partial dismissal stays "visible" with a hidden count (a new finding is never swallowed)', partial.content === 'visible' && partial.visibleCount === 2 && partial.dismissedCount === 1);
    check('freshness: Nov 12 advice is current on Nov 13; the Nov 5 advice (refresh failed since) is past the weekly cadence', !visible.stale && visible.ageDays === 1 && prod.stale && prod.ageDays === 8);
  }

  console.log('\n[E — state model: Listing Advice freshness + weekly module failures]');
  {
    const L = (generatedAt: string, failureTimes: (string | null)[] = []) =>
      deriveCoachModuleView({ hasOutput: true, cards: [{ k: 'a' }], keyOf: (c: { k: string }) => c.k, dismissals: new Map(), generatedAt, failureTimes, now: NOW });
    const oct22 = L('2026-10-22T01:15:24.785Z');
    check('PROD replay (user 1): Oct 22 Listing Advice is stale on Nov 13 (22 days = 3 weeks)', oct22.stale && oct22.ageDays === 22 && Math.floor(oct22.ageDays! / 7) === 3);
    check('stale threshold is the weekly cadence + 1 day', COACH_STALE_AFTER_DAYS === 8 && !L('2026-11-06T00:00:00Z').stale && L('2026-11-05T14:00:00Z').stale);
    const weeklyPartial: WeeklyCoachStatusPayload = { state: 'partial', periodKey: '2026-11-11', completedAt: '2026-11-12T02:01:46Z', modules: { general: 'failed', listings: 'completed' } };
    check('weekly partial (General failed) marks ONLY General as failed', weeklyModuleFailureAt(weeklyPartial, 'general') === '2026-11-12T02:01:46Z' && weeklyModuleFailureAt(weeklyPartial, 'listings') === null);
    const weeklyLegacyFailed: WeeklyCoachStatusPayload = { state: 'failed', periodKey: '2026-11-11', completedAt: '2026-11-12T02:01:46Z', modules: { general: 'failed', listings: null } };
    check('legacy failed execution (pre per-module tracking) counts as a General failure only', weeklyModuleFailureAt(weeklyLegacyFailed, 'general') !== null && weeklyModuleFailureAt(weeklyLegacyFailed, 'listings') === null);
    const weeklyListingFailed: WeeklyCoachStatusPayload = { state: 'partial', periodKey: '2026-11-18', completedAt: '2026-11-19T02:01:00Z', modules: { general: 'completed', listings: 'failed' } };
    const lf = L('2026-10-22T01:15:24.785Z', [weeklyModuleFailureAt(weeklyListingFailed, 'listings')]);
    check('a failed weekly Listing module is reported next to the previous completed Listing Advice', lf.refreshFailedAt === '2026-11-19T02:01:00Z' && lf.generatedAt === '2026-10-22T01:15:24.785Z');
    check('completed / running / scheduled weekly states never report a failure', (['completed', 'running', 'next_scheduled', 'did_not_run'] as const).every((state) => weeklyModuleFailureAt({ state, modules: { general: 'failed', listings: 'failed' } }, 'general') === null));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
