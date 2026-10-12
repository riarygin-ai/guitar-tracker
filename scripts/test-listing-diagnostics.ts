/**
 * test-listing-diagnostics.ts
 *
 * Pure unit coverage for src/lib/analytics/listingDiagnostics.ts — the
 * structured failure/slow-success logging added while investigating
 * intermittent /listings 500s. No database, no network.
 *
 * Usage:  npx tsx scripts/test-listing-diagnostics.ts
 */

import {
  classifyListingFailure, logListingFailure, logListingSuccess,
} from '../src/lib/analytics/listingDiagnostics';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}

function captureConsole<T>(level: 'error' | 'warn', fn: () => T): { result: T; lines: string[] } {
  const original = console[level];
  const lines: string[] = [];
  console[level] = ((...args: unknown[]) => { lines.push(args.map(String).join(' ')); }) as typeof console.error;
  try {
    return { result: fn(), lines };
  } finally {
    console[level] = original;
  }
}

async function main() {
  console.log('\n[A — classifyListingFailure]');
  {
    check('Postgres 57014 (query_canceled) -> statement_timeout', classifyListingFailure({ code: '57014', message: 'canceling statement due to statement timeout' }) === 'statement_timeout');
    check('message mentioning "statement timeout" (no code) -> statement_timeout', classifyListingFailure({ message: 'canceling statement due to statement timeout' }) === 'statement_timeout');
    check('a generic "timeout" message -> function_timeout', classifyListingFailure({ message: 'listing demand context timed out after 20000ms' }) === 'function_timeout');
    check('a connection-class code (08xxx) -> connection_issue', classifyListingFailure({ code: '08006', message: 'connection failure' }) === 'connection_issue');
    check('a fetch-failure message -> connection_issue', classifyListingFailure({ message: 'fetch failed' }) === 'connection_issue');
    check('a PGRST-prefixed code -> postgrest_error', classifyListingFailure({ code: 'PGRST202', message: 'function not found' }) === 'postgrest_error');
    check('any other populated code -> sql_error', classifyListingFailure({ code: '23505', message: 'duplicate key value' }) === 'sql_error');
    check('a plain thrown Error with no code -> unexpected_exception', classifyListingFailure(new Error('boom')) === 'unexpected_exception');
    check('a non-object/null value -> unexpected_exception (never throws)', classifyListingFailure(null) === 'unexpected_exception' && classifyListingFailure('boom') === 'unexpected_exception' && classifyListingFailure(undefined) === 'unexpected_exception');
  }

  console.log('\n[B — logListingFailure: structured, bounded, no sensitive content]');
  {
    const { result: category, lines } = captureConsole('error', () =>
      logListingFailure(
        { endpoint: 'listing-demand-evidence:build_listing_demand_evidence_v1_1', appUserId: 42, params: { startDate: '2026-09-01', endDate: '2026-09-07', trendWeeks: 8 } },
        1234,
        { code: '57014', message: 'canceling statement due to statement timeout', hint: 'increase statement_timeout' },
      ));
    check('returns the classified category', category === 'statement_timeout');
    check('logs exactly one line', lines.length === 1);
    const parsed = JSON.parse(lines[0].replace(/^\[listings:[^\]]+\]\s*FAILED\s*/, ''));
    check('includes endpoint, appUserId, rounded durationMs, category', parsed.endpoint === 'listing-demand-evidence:build_listing_demand_evidence_v1_1' && parsed.appUserId === 42 && parsed.durationMs === 1234 && parsed.category === 'statement_timeout');
    check('includes the DB error code/message/hint', parsed.dbErrorCode === '57014' && parsed.dbErrorMessage.includes('statement timeout') && parsed.dbErrorHint === 'increase statement_timeout');
    check('includes the caller-supplied request params (dates/trend_weeks)', parsed.startDate === '2026-09-01' && parsed.endDate === '2026-09-07' && parsed.trendWeeks === 8);
    check('never logs raw lead/listing row content (no "notes"/"buyer" keys anywhere in the line)', !/notes|buyer_message|our_message/i.test(lines[0]));

    const longMessage = 'X'.repeat(1000);
    const { lines: longLines } = captureConsole('error', () => logListingFailure({ endpoint: 'e', appUserId: 1 }, 0, { message: longMessage }));
    const longParsed = JSON.parse(longLines[0].replace(/^\[listings:[^\]]+\]\s*FAILED\s*/, ''));
    check('a very long DB error message is truncated, never logged in full', longParsed.dbErrorMessage.length < longMessage.length && longParsed.dbErrorMessage.endsWith('…'));

    const { lines: noMsgLines } = captureConsole('error', () => logListingFailure({ endpoint: 'e', appUserId: 1 }, 5, undefined));
    check('a value with no code/message at all still produces exactly one safe log line', noMsgLines.length === 1 && JSON.parse(noMsgLines[0].replace(/^\[listings:[^\]]+\]\s*FAILED\s*/, '')).category === 'unexpected_exception');
  }

  console.log('\n[C — logListingSuccess: quiet unless genuinely slow]');
  {
    const { lines: fastLines } = captureConsole('warn', () => logListingSuccess({ endpoint: 'e', appUserId: 1 }, 50));
    check('a fast (normal) success logs nothing at all', fastLines.length === 0);

    const { lines: borderlineLines } = captureConsole('warn', () => logListingSuccess({ endpoint: 'e', appUserId: 1 }, 2999));
    check('just under the slow threshold logs nothing', borderlineLines.length === 0);

    const { lines: slowLines } = captureConsole('warn', () => logListingSuccess({ endpoint: 'listing-evidence:build_listing_evidence_v1_0', appUserId: 7, params: { trendWeeks: 12 } }, 4200));
    check('a genuinely slow success logs exactly one line', slowLines.length === 1);
    const parsed = JSON.parse(slowLines[0].replace(/^\[listings:[^\]]+\]\s*slow \(succeeded\)\s*/, ''));
    check('the slow-success line carries endpoint/appUserId/durationMs/params, no error fields', parsed.endpoint === 'listing-evidence:build_listing_evidence_v1_0' && parsed.appUserId === 7 && parsed.durationMs === 4200 && parsed.trendWeeks === 12 && !('dbErrorCode' in parsed));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
