/**
 * test-copy-analysis-data.ts
 *
 * Focused validation for the "Copy Analysis Data" / "Preview JSON" utility
 * (src/lib/analysisPacketClipboard.ts, src/components/
 * CopyAnalysisDataControl.tsx, src/components/CopyAnalysisScopeButton.tsx)
 * — a follow-up to Listing Evidence v1.0 (commit aa884b2) and the Copy
 * Listing Evidence JSON utility (commit 2a8cf87). Pure logic/unit
 * coverage — getAccessToken, fetch, and clipboard.writeText are all
 * injected dependencies, so none of this needs a DOM, a browser, or a
 * running Next.js server. Same "no test framework, local check()"
 * convention as every other script here.
 *
 * Usage:
 *   npx tsx scripts/test-copy-analysis-data.ts
 */

import {
  fetchAnalysisPacket,
  copyAnalysisPacketToClipboard,
  createAnalysisPacketCopier,
  type AnalysisPacketDeps,
} from '../src/lib/analysisPacketClipboard';
import { formatPacketConfirmationMessage, type ListingAnalysisPacket } from '../src/lib/analytics/listingAnalysisPacket';

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

function fakeResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const SAMPLE_PACKET: ListingAnalysisPacket = {
  schema_version: '1.0',
  generated_at: '2026-08-21T00:00:00.000Z',
  scope: { type: 'channel', channel_id: 3, channel_name: 'Reverb' },
  analysis_context: {
    purpose_semantics: {
      business: { disposition_mode: 'active_realization', description: 'x', realization_priority_order: 1, active_realization_flag: true, expected_holding_policy: 'x' },
      hybrid: { disposition_mode: 'selective_realization', description: 'x', realization_priority_order: 2, active_realization_flag: true, expected_holding_policy: 'x' },
      personal: { disposition_mode: 'opportunistic_realization', description: 'x', realization_priority_order: 3, active_realization_flag: false, expected_holding_policy: 'x' },
    },
    listing_age_semantics: { definition: 'x', timezone_convention: 'x', buckets: [] },
    guardrails: ['Do not assume Hybrid inventory should be listed.'],
  },
  summary: {
    open_item_count: 10, distinct_listed_item_count: 3, distinct_unlisted_open_item_count: 7,
    active_channel_listing_count: 4, cross_listed_item_count: 1, total_active_asking_value: null,
    listed_cost_basis: 1000, listed_estimated_sold_value: 1500, listed_estimated_equity: 500,
    listing_age_coverage: { age_available_count: 4, age_missing_count: 0, age_invalid_count: 0 },
    stale_active_listings_excluded_count: 0,
    open_item_count_by_purpose: [], listed_item_count_by_purpose: [], unlisted_item_count_by_purpose: [],
  },
  channel_summary: [],
  category_channel_matrix: { rows: [], category_totals: [] },
  cross_listing: { by_active_channel_count: [], max_active_channel_count: 1, combinations: [] },
  listed_items: [{} as never, {} as never, {} as never],
  listed_elsewhere_not_in_scope: [],
  unlisted_business_items: [{} as never, {} as never],
  unlisted_hybrid_items: [],
  personal_summary: { personal_open_item_count: 1, personal_listed_item_count: 0, personal_unlisted_item_count: 1, excluded_from_listing_candidate_analysis: true },
  limitations: [],
};

async function main() {
  console.log('\n[A — authenticated request includes the Bearer token and scope params]');
  {
    let capturedInput: string | null = null;
    let capturedInit: RequestInit | undefined;
    const deps: AnalysisPacketDeps = {
      getAccessToken: async () => 'test-access-token-123',
      fetchImpl: async (input, init) => {
        capturedInput = input;
        capturedInit = init;
        return fakeResponse(200, { target_user_listing_analysis_packet: SAMPLE_PACKET });
      },
      writeText: async () => {},
    };
    const result = await fetchAnalysisPacket(deps, { scope: 'channel', channelId: 3 });
    check('result is success', result.status === 'success', result);
    check('called the packet endpoint with scope=channel&channel_id=3', capturedInput === '/api/listing-analysis-packet?scope=channel&channel_id=3', capturedInput);
    check('method is GET', capturedInit?.method === 'GET');
    const headers = capturedInit?.headers as Record<string, string> | undefined;
    check('Authorization header carries the Bearer token', headers?.Authorization === 'Bearer test-access-token-123', headers);
  }

  console.log('\n[A2 — scope=all never sends a channel_id param]');
  {
    let capturedInput: string | null = null;
    const deps: AnalysisPacketDeps = {
      getAccessToken: async () => 'tok',
      fetchImpl: async (input) => { capturedInput = input; return fakeResponse(200, { target_user_listing_analysis_packet: SAMPLE_PACKET }); },
      writeText: async () => {},
    };
    await fetchAnalysisPacket(deps, { scope: 'all' });
    check('URL is exactly scope=all with no channel_id', capturedInput === '/api/listing-analysis-packet?scope=all', capturedInput);
  }

  console.log('\n[B — no target user ID is ever sent by the client]');
  {
    let capturedInput: string | null = null;
    const deps: AnalysisPacketDeps = {
      getAccessToken: async () => 'tok',
      fetchImpl: async (input) => { capturedInput = input; return fakeResponse(200, { target_user_listing_analysis_packet: SAMPLE_PACKET }); },
      writeText: async () => {},
    };
    await fetchAnalysisPacket(deps, { scope: 'unlisted' });
    check('request URL never contains user_id/target_user/uid', !/user_id|target_user|uid=/i.test(capturedInput ?? ''), capturedInput);
  }

  console.log('\n[C — unauthenticated session: no request, safe error]');
  {
    let fetchCalled = false;
    const deps: AnalysisPacketDeps = {
      getAccessToken: async () => null,
      fetchImpl: async () => { fetchCalled = true; return fakeResponse(200, {}); },
      writeText: async () => {},
    };
    const result = await fetchAnalysisPacket(deps, { scope: 'all' });
    check('fetch was never called', !fetchCalled);
    check('result status is unauthenticated', result.status === 'unauthenticated', result);
  }

  console.log('\n[D — exact packet copied on success]');
  {
    const captured: { text: string | null } = { text: null };
    const deps: AnalysisPacketDeps = {
      getAccessToken: async () => 'tok',
      fetchImpl: async () => fakeResponse(200, { target_user_listing_analysis_packet: SAMPLE_PACKET }),
      writeText: async (text) => { captured.text = text; },
    };
    const result = await copyAnalysisPacketToClipboard(deps, { scope: 'channel', channelId: 3 });
    check('result is success', result.status === 'success', result);
    const copiedText = captured.text;
    check('copied JSON round-trips to exactly the packet the server returned', copiedText != null && JSON.stringify(JSON.parse(copiedText)) === JSON.stringify(SAMPLE_PACKET), copiedText);
    check('copied JSON is pretty-printed', copiedText != null && copiedText.includes('\n  '));
  }

  console.log('\n[E — failed endpoint response copies nothing]');
  {
    let writeTextCalled = false;
    const deps: AnalysisPacketDeps = {
      getAccessToken: async () => 'tok',
      fetchImpl: async () => fakeResponse(500, { error: 'Unexpected server error' }),
      writeText: async () => { writeTextCalled = true; },
    };
    const result = await copyAnalysisPacketToClipboard(deps, { scope: 'all' });
    check('writeText was never called', !writeTextCalled);
    check('result status is request_failed', result.status === 'request_failed', result);
    if (result.status === 'request_failed') {
      check('message never echoes the raw server error body', !result.message.includes('Unexpected server error'), result.message);
    }
  }

  console.log('\n[E2 — network error copies nothing, no crash]');
  {
    let writeTextCalled = false;
    const deps: AnalysisPacketDeps = {
      getAccessToken: async () => 'tok',
      fetchImpl: async () => { throw new Error('ECONNREFUSED internal detail'); },
      writeText: async () => { writeTextCalled = true; },
    };
    const result = await copyAnalysisPacketToClipboard(deps, { scope: 'all' });
    check('writeText was never called', !writeTextCalled);
    check('result status is request_failed', result.status === 'request_failed', result);
    if (result.status === 'request_failed') check('message never leaks the raw error', !result.message.includes('ECONNREFUSED'), result.message);
  }

  console.log('\n[E3 — clipboard write denied: safe failure, no crash]');
  {
    const deps: AnalysisPacketDeps = {
      getAccessToken: async () => 'tok',
      fetchImpl: async () => fakeResponse(200, { target_user_listing_analysis_packet: SAMPLE_PACKET }),
      writeText: async () => { throw new Error('NotAllowedError: permission denied'); },
    };
    const result = await copyAnalysisPacketToClipboard(deps, { scope: 'all' });
    check('result status is clipboard_failed (not a thrown exception)', result.status === 'clipboard_failed', result);
    if (result.status === 'clipboard_failed') check('message never leaks the raw clipboard error', !result.message.includes('NotAllowedError'), result.message);
  }

  console.log('\n[F — concurrent copy prevented (only one request in flight)]');
  {
    let fetchCallCount = 0;
    let resolveFirst: (() => void) | null = null;
    const deps: AnalysisPacketDeps = {
      getAccessToken: async () => 'tok',
      fetchImpl: async () => {
        fetchCallCount++;
        if (fetchCallCount === 1) await new Promise<void>((resolve) => { resolveFirst = resolve; });
        return fakeResponse(200, { target_user_listing_analysis_packet: SAMPLE_PACKET });
      },
      writeText: async () => {},
    };
    const copier = createAnalysisPacketCopier(deps);

    const firstCall = copier.copy({ scope: 'all' });
    const secondResult = await copier.copy({ scope: 'unlisted' });
    check('second concurrent call is rejected as already_in_progress, even with a different scope', secondResult.status === 'already_in_progress', secondResult);
    check('fetch was only ever called once so far', fetchCallCount === 1, fetchCallCount);

    resolveFirst!();
    const firstResult = await firstCall;
    check('first call still completes successfully', firstResult.status === 'success', firstResult);

    const thirdResult = await copier.copy({ scope: 'all' });
    check('a new call after completion is allowed through', thirdResult.status === 'success', thirdResult);
    check('fetch was called exactly twice total', fetchCallCount === 2, fetchCallCount);
  }

  console.log('\n[G — no token is rendered or logged]');
  {
    const SECRET_TOKEN = 'super-secret-packet-token-should-never-leak';
    const originalConsole = { log: console.log, error: console.error, warn: console.warn };
    const consoleCalls: unknown[][] = [];
    console.log = (...args: unknown[]) => { consoleCalls.push(args); };
    console.error = (...args: unknown[]) => { consoleCalls.push(args); };
    console.warn = (...args: unknown[]) => { consoleCalls.push(args); };
    try {
      await copyAnalysisPacketToClipboard({ getAccessToken: async () => SECRET_TOKEN, fetchImpl: async () => fakeResponse(500, { error: 'boom' }), writeText: async () => {} }, { scope: 'all' });
      await copyAnalysisPacketToClipboard({ getAccessToken: async () => SECRET_TOKEN, fetchImpl: async () => fakeResponse(200, { target_user_listing_analysis_packet: SAMPLE_PACKET }), writeText: async () => {} }, { scope: 'all' });
    } finally {
      console.log = originalConsole.log; console.error = originalConsole.error; console.warn = originalConsole.warn;
    }
    check('nothing was ever logged to the console', consoleCalls.length === 0, consoleCalls);
    check('the secret token never appears in console output', !JSON.stringify(consoleCalls).includes(SECRET_TOKEN));
  }

  console.log('\n[H — success message uses the actual returned packet counts]');
  {
    const deps: AnalysisPacketDeps = {
      getAccessToken: async () => 'tok',
      fetchImpl: async () => fakeResponse(200, { target_user_listing_analysis_packet: SAMPLE_PACKET }),
      writeText: async () => {},
    };
    const result = await copyAnalysisPacketToClipboard(deps, { scope: 'channel', channelId: 3 });
    check('result is success', result.status === 'success', result);
    if (result.status === 'success') {
      const message = formatPacketConfirmationMessage(result.packet);
      check('message names the channel from the packet, not a hardcoded name', message.includes('Reverb'), message);
      check('message uses the actual listed_items.length (3)', message.includes('3 current listing'), message);
      check('message uses the actual unlisted_business_items.length (2)', message.includes('2 unlisted Business item'), message);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
