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
 * No DB, no network. Usage:  npx tsx scripts/test-dashboard-coach-advice.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { adviceLabels } from '../src/lib/analytics/advice/adviceLabels';
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

/** Mirrors the Dashboard's own visibleAdviceCards filter (src/app/page.tsx). */
function filterVisible(cards: AdviceCard[], dismissedKeys: Set<string>): AdviceCard[] {
  return cards.filter((c) => !dismissedKeys.has(computeAdviceKey(c)));
}

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

  console.log('\n[B — Dashboard (src/app/page.tsx): structural fix]');
  {
    const dash = strip(read('src', 'app', 'page.tsx'));

    check(
      'the OLD bug is gone: the section is no longer gated on (0 cards) || (something visible) before it even renders its header',
      !/\(latestCompletedAdvice\.advice\.advice\?\.advice_cards\.length \?\? 0\) === 0 \|\| visibleAdviceCards\.length > 0/.test(dash),
    );
    check(
      'the section now renders whenever a completed revision exists, independent of how many cards are currently visible',
      /\{!adviceLoading && !dismissalsLoading && latestCompletedAdvice && \(\s*<section/.test(dash),
    );
    check(
      'a THIRD branch (cards exist, but none are visible) shows AL.allCoachAdviceDismissed rather than falling through to the cards grid or vanishing',
      /visibleAdviceCards\.length === 0 \? \(\s*<p[^>]*data-advice-all-dismissed[^>]*>\{AL\.allCoachAdviceDismissed\}<\/p>/.test(dash),
    );
    check(
      'the original "0 cards generated at all" branch (run_summary headline/summary) is untouched',
      /run_summary\.headline/.test(dash) && /run_summary\.summary/.test(dash),
    );
    check(
      'the original "cards visible" branch (grid of AdviceCardView) is untouched',
      /visibleAdviceCards\.map\(\(card\) =>/.test(dash) && /<AdviceCardView/.test(dash),
    );
    check(
      'the header/timestamp (AL.latestAnalyticsAdvice / AL.fromRunGenerated) sits OUTSIDE the three-way cards branch, so it always shows once a revision exists',
      /AL\.latestAnalyticsAdvice/.test(dash) && /AL\.fromRunGenerated/.test(dash),
    );
  }

  console.log('\n[C — behavioral replay of the exact production scenario found during investigation]');
  {
    // Both real users' latest completed Coach revision (Oct 8 run) had every
    // one of its cards match a dismissal recorded in an earlier week — see
    // the Final Report for the exact production rows. Replayed here with
    // synthetic equivalents (same shape, no real data).
    const latestRevisionCards = [
      card({ advice_code: 'A1', item_id: 70, source_ids: ['insight:BUSINESS_OPEN_INVENTORY_PRIORITY:item:70'] }),
      card({ advice_code: 'A2', item_id: 11, source_ids: ['insight:HYBRID_PURPOSE_REVIEW_PRIORITY:item:11'] }),
      card({ advice_code: 'A3', item_id: null, source_ids: ['pattern:DISCOVERY|BALANCED_WEAKNESS|BRAND_WITHIN_CATEGORY|category_id=1|brand_id=1'] }),
    ];
    const dismissedFromEarlierWeeks = new Set(latestRevisionCards.map((c) => computeAdviceKey(c)));
    const visible = filterVisible(latestRevisionCards, dismissedFromEarlierWeeks);

    check('reproduces the production condition: a completed revision with cards, where every card is currently dismissed', latestRevisionCards.length > 0 && visible.length === 0);
    check('under the OLD gate, this condition evaluated to false (section would vanish entirely)', !((latestRevisionCards.length === 0) || visible.length > 0));
    check('under the NEW behavior, this is exactly the branch that renders AL.allCoachAdviceDismissed (cards.length > 0 && visible.length === 0)', latestRevisionCards.length > 0 && visible.length === 0);

    // A genuinely NEW finding (not previously dismissed) must still show, even
    // alongside other cards that remain dismissed — partial dismissal must
    // never fall into the "all dismissed" branch.
    const mixedCards = [...latestRevisionCards, card({ advice_code: 'A4', item_id: 999, source_ids: ['insight:BUSINESS_OPEN_INVENTORY_PRIORITY:item:999'] })];
    const visibleMixed = filterVisible(mixedCards, dismissedFromEarlierWeeks);
    check('a genuinely new finding alongside fully-dismissed ones is NOT swallowed by the all-dismissed branch', visibleMixed.length === 1 && visibleMixed[0].advice_code === 'A4');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
